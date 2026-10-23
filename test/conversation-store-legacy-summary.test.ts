import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore } from '../src/agent/context/ConversationStore.js';
import { estimateTokens } from '../src/shared/tokenUtils.js';

// W2a-09（审阅包 L6-P25；C48 的 summarize 修复随方法一并删除）：ConversationStore.summarize 与摘要窗口
// 辅助已删除，本类不再生成摘要。但旧版本 summarize 写入的 `[对话摘要]`（role=system）消息仍留在用户磁盘上的
// 历史文件里，读取侧必须保持兼容，这里锁住：
//   - load 超预算时，首条旧摘要在放得下时保留，且不挤掉最新消息；
//   - 索引丢失后经 append 自动登记时，按文件内容把 hasSummary 置为 true（旧摘要不一定是首条）；
//   - 旧索引中 hasSummary=true 的条目照常通过校验，追加消息后标志不变。

interface StoredMessage {
  role: string;
  content: string;
}

interface IndexEntry {
  id: string;
  messageCount: number;
  hasSummary: boolean;
}

const tempRoots: string[] = [];

function makeTempRoot(label: string) {
  const root = join(tmpdir(), `alembic-agent-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function conversationsDir(root: string) {
  return join(root, '.asd', 'conversations');
}

/** 按旧版本落盘格式（每行 {role, content, ts}）直接写一份历史文件，模拟升级前留下的数据。 */
function writeLegacyHistory(root: string, id: string, messages: StoredMessage[]) {
  mkdirSync(conversationsDir(root), { recursive: true });
  writeFileSync(
    join(conversationsDir(root), `${id}.jsonl`),
    `${messages
      .map((message) => JSON.stringify({ ...message, ts: '2026-01-01T00:00:00.000Z' }))
      .join('\n')}\n`,
    'utf8'
  );
}

function readIndex(root: string): IndexEntry[] {
  return JSON.parse(
    readFileSync(join(conversationsDir(root), 'index.json'), 'utf8')
  ) as IndexEntry[];
}

function silenceLogs() {
  const logger = Logger.getInstance();
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return { info: () => info.mock.calls.map((call) => String(call[0])) };
}

const LEGACY_SUMMARY: StoredMessage = {
  role: 'system',
  content: '[对话摘要] 用户偏好 TypeScript，已确认宿主边界与回放约束。',
};

function olderTurns(count: number): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `older turn ${index} ${'填充'.repeat(40)}`,
  }));
}

describe('ConversationStore legacy summary compatibility (W2a-09)', () => {
  it('keeps a leading legacy summary and the newest message when load exceeds the token budget', () => {
    const root = makeTempRoot('legacy-summary-load');
    const middle = olderTurns(6);
    const latest: StoredMessage = { role: 'user', content: 'latest question' };
    writeLegacyHistory(root, 'legacy', [LEGACY_SUMMARY, ...middle, latest]);
    const store = new ConversationStore(root);
    const logs = silenceLogs();
    // 预算放得下“旧摘要 + 最新消息 + 截断标记”，但放不下任何一条中间消息（前提断言防止夹具漂移）。
    const budget = estimateTokens(LEGACY_SUMMARY.content) + estimateTokens(latest.content) + 30;
    expect(Math.min(...middle.map((message) => estimateTokens(message.content)))).toBeGreaterThan(
      30
    );

    const loaded = store.load('legacy', { tokenBudget: budget });

    expect(loaded[0]).toEqual(LEGACY_SUMMARY);
    expect(loaded.at(-1)).toEqual(latest);
    expect(loaded).toHaveLength(3);
    expect(loaded[1]).toMatchObject({ role: 'system' });
    expect(loaded[1]?.content).toContain('[上下文截断]');
    expect(
      loaded.reduce((sum, message) => sum + estimateTokens(message.content), 0)
    ).toBeLessThanOrEqual(budget);
    // 截断路径留痕：预算、省略条数与保留条数写进 info。
    expect(
      logs
        .info()
        .some(
          (message) => message.includes(`history budget=${budget}`) && message.includes('omitted=6')
        )
    ).toBe(true);
    // 读取不改写历史文件：旧摘要原样留在磁盘上。
    expect(readFileSync(join(conversationsDir(root), 'legacy.jsonl'), 'utf8')).toContain(
      '[对话摘要]'
    );
  });

  it('lets the newest message win when the legacy summary and it do not both fit', () => {
    const root = makeTempRoot('legacy-summary-tight');
    const latest: StoredMessage = { role: 'assistant', content: `LATEST ${'新回复'.repeat(30)}` };
    writeLegacyHistory(root, 'tight', [LEGACY_SUMMARY, ...olderTurns(2), latest]);
    const store = new ConversationStore(root);
    silenceLogs();
    // 预算只够最新消息本身：旧摘要不能挤掉最近内容（截断标记占去预留后，最新消息按剩余预算截断）。
    const budget = estimateTokens(latest.content) + 1;

    const loaded = store.load('tight', { tokenBudget: budget });

    expect(loaded.some((message) => message.content.startsWith('[对话摘要]'))).toBe(false);
    expect(loaded.at(-1)).toMatchObject({ role: 'assistant' });
    expect(loaded.at(-1)?.content.startsWith('LATEST')).toBe(true);
    expect(
      loaded.reduce((sum, message) => sum + estimateTokens(message.content), 0)
    ).toBeLessThanOrEqual(budget);
  });

  it('reports hasSummary when a history holding a legacy summary is re-registered on append', () => {
    const root = makeTempRoot('legacy-summary-register');
    // 旧 summarize 在提示预算放不下时把较早消息原样留在摘要之前，所以摘要既可能是首条，也可能不是。
    writeLegacyHistory(root, 'leading', [
      LEGACY_SUMMARY,
      { role: 'user', content: 'leading question' },
    ]);
    writeLegacyHistory(root, 'retained', [
      ...olderTurns(2),
      LEGACY_SUMMARY,
      { role: 'user', content: 'retained question' },
    ]);
    writeLegacyHistory(root, 'plain', [{ role: 'user', content: 'plain question' }]);
    const store = new ConversationStore(root);
    silenceLogs();

    for (const id of ['leading', 'retained', 'plain']) {
      store.append(id, { role: 'user', content: 'follow-up' });
    }

    const byId = new Map(readIndex(root).map((entry) => [entry.id, entry]));
    expect(byId.get('leading')).toMatchObject({ messageCount: 3, hasSummary: true });
    expect(byId.get('retained')).toMatchObject({ messageCount: 5, hasSummary: true });
    // 对照：没有旧摘要的历史不会被误标。
    expect(byId.get('plain')).toMatchObject({ messageCount: 2, hasSummary: false });
    // 自动登记后照常读取，首条旧摘要原样返回。
    expect(store.load('leading')[0]).toEqual(LEGACY_SUMMARY);
  });

  it('accepts legacy index entries flagged hasSummary and keeps the flag across appends', () => {
    const root = makeTempRoot('legacy-summary-index');
    writeLegacyHistory(root, 'flagged', [LEGACY_SUMMARY, { role: 'user', content: 'question' }]);
    writeFileSync(
      join(conversationsDir(root), 'index.json'),
      JSON.stringify([
        {
          id: 'flagged',
          category: 'user',
          title: 'question',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          messageCount: 2,
          hasSummary: true,
        },
      ]),
      'utf8'
    );
    const store = new ConversationStore(root);
    silenceLogs();

    store.append('flagged', { role: 'assistant', content: 'answer' });

    expect(readIndex(root)).toMatchObject([{ id: 'flagged', messageCount: 3, hasSummary: true }]);
    expect(store.load('flagged')).toEqual([
      LEGACY_SUMMARY,
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ]);
  });
});
