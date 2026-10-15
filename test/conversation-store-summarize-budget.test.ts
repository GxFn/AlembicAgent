import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore } from '../src/agent/context/ConversationStore.js';

// module-review L6 C48（审阅包 L6-P25）：summarize 曾把待摘要消息拼接后只取前 4000 字符交给模型，
// 却把全部待摘要消息从文件里删掉——超过 4000 字符时，最近的待摘要消息从未进入提示就被丢弃。
// 修复后：从最新往前按整条消息装入 4000 字符预算；放不下的较早消息原样保留在摘要之前并记诊断；
// 最新一条待摘要消息本身就超预算时不调用模型、不改写文件。这里锁住“任何消息要么原样留在文件里，
// 要么完整进入了摘要提示”。

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

function captureLogs() {
  const logger = Logger.getInstance();
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return {
    info: () => info.mock.calls.map((call) => String(call[0])),
    warn: () => warn.mock.calls.map((call) => String(call[0])),
  };
}

/** 直接读 JSONL 文件里的全部消息（不经 load 的预算裁剪）。 */
function readMessages(root: string, id: string): { role: string; content: string }[] {
  const raw = readFileSync(join(root, '.asd', 'conversations', `${id}.jsonl`), 'utf8').trim();
  return raw
    .split('\n')
    .map((line) => JSON.parse(line) as { role: string; content: string })
    .map(({ role, content }) => ({ role, content }));
}

/** 生成可区分的长消息：标记在开头，正文填充到固定长度。 */
function longMessage(tag: string, length: number) {
  return `${tag}:${'x'.repeat(Math.max(0, length - tag.length - 1))}`;
}

describe('ConversationStore.summarize prompt budget (C48)', () => {
  it('summarizes the newest pending messages within 4000 chars and keeps older ones verbatim', async () => {
    const root = makeTempRoot('summary-budget-long');
    const store = new ConversationStore(root);
    const id = store.create();
    const pending = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: longMessage(`P${index}`, 900),
    }));
    const recent = Array.from({ length: 4 }, (_, index) => ({
      role: 'user',
      content: `R${index} recent turn`,
    }));
    for (const message of [...pending, ...recent]) {
      store.append(id, message);
    }
    const logs = captureLogs();
    const prompts: string[] = [];

    const summarized = await store.summarize(id, {
      aiProvider: {
        chat: async (prompt: string) => {
          prompts.push(prompt);
          return 'summary of the newest pending turns';
        },
      },
    });

    expect(summarized).toBe(true);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? '';
    // 每行 `[role] ` + 900 字符：4 条（含换行）放得下，第 5 条超出 4000 字符预算。
    for (const message of pending.slice(6)) {
      expect(prompt).toContain(message.content);
    }
    for (const message of pending.slice(0, 6)) {
      expect(prompt).not.toContain(`${message.content.slice(0, 3)}x`);
    }

    const after = readMessages(root, id);
    // 未进入提示的较早消息原样保留在摘要之前，最近 4 条保持不变。
    expect(after).toEqual([
      ...pending.slice(0, 6),
      { role: 'system', content: '[对话摘要] summary of the newest pending turns' },
      ...recent,
    ]);
    // 不丢消息：每条原始消息要么原样在文件里，要么完整进入了摘要提示。
    for (const message of [...pending, ...recent]) {
      const kept = after.some(
        (entry) => entry.role === message.role && entry.content === message.content
      );
      expect({
        tag: message.content.slice(0, 3),
        covered: kept || prompt.includes(message.content),
      }).toEqual({ tag: message.content.slice(0, 3), covered: true });
    }

    const entry = store.list({ limit: 1 })[0];
    expect(entry).toMatchObject({ id, messageCount: after.length, hasSummary: true });

    const budgetLog = logs.info().find((message) => message.includes('summary prompt budget'));
    expect(budgetLog).toBeDefined();
    expect(budgetLog).toContain(id);
    expect(budgetLog).toContain('4 of 10 pending');
    expect(budgetLog).toContain('6 older message(s) kept verbatim');
  });

  it('still reports hasSummary when an unindexed history with retained messages is re-registered on append', async () => {
    const root = makeTempRoot('summary-budget-reregister');
    const store = new ConversationStore(root);
    const id = store.create();
    for (let index = 0; index < 8; index++) {
      store.append(id, {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: longMessage(`Q${index}`, 1500),
      });
    }
    for (let index = 0; index < 4; index++) {
      store.append(id, { role: 'user', content: `tail ${index}` });
    }
    captureLogs();
    const summarized = await store.summarize(id, {
      aiProvider: { chat: async () => 'summary after retained turns' },
    });
    expect(summarized).toBe(true);
    // 摘要前有原样保留的较早消息，摘要不再是首条。
    const history = readMessages(root, id);
    expect(history[0]?.content.startsWith('Q')).toBe(true);
    expect(history.some((message) => message.content.startsWith('[对话摘要]'))).toBe(true);

    // 索引丢失该条目（如外部清空索引）后，append 走未登记分支，按文件实际内容重建条目。
    writeFileSync(join(root, '.asd', 'conversations', 'index.json'), '[]\n', 'utf8');
    store.append(id, { role: 'user', content: 'follow-up' });

    expect(store.list({ limit: 1 })[0]).toMatchObject({
      id,
      messageCount: history.length + 1,
      hasSummary: true,
    });
  });

  it('summarizes every pending message when they fit the budget (no retained messages, no budget log)', async () => {
    const root = makeTempRoot('summary-budget-short');
    const store = new ConversationStore(root);
    const id = store.create();
    const messages = Array.from({ length: 7 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `short message ${index}`,
    }));
    for (const message of messages) {
      store.append(id, message);
    }
    const logs = captureLogs();
    const chat = vi.fn(async (_prompt: string) => 'short summary');

    expect(await store.summarize(id, { aiProvider: { chat } })).toBe(true);

    const prompt = String(chat.mock.calls[0]?.[0] ?? '');
    for (const message of messages.slice(0, 3)) {
      expect(prompt).toContain(`[${message.role}] ${message.content}`);
    }
    // 提示内保持时间顺序：较早的消息在前。
    expect(prompt.indexOf('short message 0')).toBeLessThan(prompt.indexOf('short message 2'));
    expect(readMessages(root, id)).toEqual([
      { role: 'system', content: '[对话摘要] short summary' },
      ...messages.slice(3),
    ]);
    expect(logs.info().some((message) => message.includes('summary prompt budget'))).toBe(false);
  });

  it('skips summarizing and leaves the history untouched when the newest pending message alone exceeds the budget', async () => {
    const root = makeTempRoot('summary-budget-oversized');
    const store = new ConversationStore(root);
    const id = store.create();
    const messages = [
      { role: 'user', content: 'opening question' },
      { role: 'assistant', content: longMessage('HUGE', 5000) },
      { role: 'user', content: 'k0' },
      { role: 'assistant', content: 'k1' },
      { role: 'user', content: 'k2' },
      { role: 'assistant', content: 'k3' },
    ];
    for (const message of messages) {
      store.append(id, message);
    }
    const logs = captureLogs();
    const chat = vi.fn(async (_prompt: string) => 'should not be used');

    expect(await store.summarize(id, { aiProvider: { chat } })).toBe(false);

    expect(chat).not.toHaveBeenCalled();
    expect(readMessages(root, id)).toEqual(messages);
    const skipLog = logs.warn().find((message) => message.includes('summary skipped'));
    expect(skipLog).toBeDefined();
    expect(skipLog).toContain(id);
    expect(skipLog).toContain('exceeds the 4000-char summary prompt budget');
  });
});
