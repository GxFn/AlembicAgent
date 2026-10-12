/**
 * evidence 子区间错误归类与坐标说明（L4-P18 / I21）。
 *
 * 覆盖：
 * - evidence.get：id 存在但子区间越界（range 条目误用条目内相对行号）、子区间落在台账截断尾部、
 *   id 不存在三种失败文案各不相同；前两种写明可用区间与坐标系，第三种保持“无法解析”。
 * - evidence.get 超行数预算时按条目坐标系给出可直接使用的下一段子区间示例；剩余全在截断尾部时
 *   明确说明不可再取。
 * - note_finding（memory.ts）与 knowledge.submit 展开（submitEvidenceExpansion.ts）的同类拒绝文案
 *   使用同一归类。
 * - registry 参数说明写明“range 条目用文件行号，无 range 条目用条目内 1 起行号”。
 * - 归类路径输出诊断日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EVIDENCE_ENTRY_MAX_CHARS } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  EVIDENCE_TRUNCATION_MARKER,
  EvidenceLedgerStore,
} from '../src/agent/evidence/EvidenceLedgerStore.js';
import { handle as handleEvidence } from '../src/tools/runtime/handlers/evidence.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';
import { expandEvidenceRefsForSubmit } from '../src/tools/runtime/handlers/submitEvidenceExpansion.js';
import { TOOL_REGISTRY } from '../src/tools/runtime/registry.js';
import { createTempProject } from './helpers/tempProject.js';

type EvidenceHandlerCtx = Parameters<typeof handleEvidence>[2];
type MemoryHandlerCtx = Parameters<typeof handleMemory>[2];

afterEach(() => {
  vi.restoreAllMocks();
});

function makeLedger(): EvidenceLedgerStore {
  const dataRoot = createTempProject('evidence-subrange-');
  return new EvidenceLedgerStore({
    dataRoot,
    jobId: 'job_1',
    sessionId: 'sess_1',
    dimensionId: 'ts-js-module',
  });
}

function evidenceCtx(ledger: EvidenceLedgerStore): EvidenceHandlerCtx {
  // handler 仅消费 runtime.evidenceLedger——最小运行时形态经 unknown 收窄
  return { runtime: { evidenceLedger: ledger } } as unknown as EvidenceHandlerCtx;
}

function memoryCtx(ledger: EvidenceLedgerStore): MemoryHandlerCtx {
  const coordinator = {
    noteFinding(_finding: string, _evidence: string, importance: number) {
      return {
        recorded: true,
        target: 'activeContext' as const,
        importance,
        message: `📌 已记录发现 [${importance}/10]`,
        scratchpadSize: 1,
      };
    },
  };
  // handler 仅消费 memoryCoordinator 与 runtime.evidenceLedger——最小运行时形态经 unknown 收窄
  return {
    memoryCoordinator: coordinator,
    runtime: { evidenceLedger: ledger, dimensionScopeId: 'ts-js-module:analyst' },
  } as unknown as MemoryHandlerCtx;
}

function fileLines(start: number, end: number): string {
  return Array.from({ length: end - start + 1 }, (_, i) => `L${start + i}`).join('\n');
}

/** 超过单条上限的内容：台账保头截断并附标记，尾部行不可再按子区间取回 */
function oversizedContent(lineCount = 300): string {
  return Array.from({ length: lineCount }, (_, i) => `row-${i + 1}`.padEnd(39, '.')).join('\n');
}

/** 台账真实保留下来的完整行数（截断标记前最后一行可能只剩半行，不计入） */
function capturedLineCount(ledger: EvidenceLedgerStore, id: string): number {
  const entry = ledger.get(id);
  if (!entry) {
    throw new Error(`fixture entry ${id} missing`);
  }
  expect(entry.content.endsWith(`\n${EVIDENCE_TRUNCATION_MARKER}`)).toBe(true);
  return entry.content.split('\n').length - 2;
}

/**
 * 场景台账：
 * E-1 = terminal 输出（无 range，3 行）
 * E-2 = lib/a.ts:200-450（range 条目，251 行，未截断）
 * E-3 = lib/big.ts:1-300（range 条目，超上限被截断）
 * E-4 = search 分组（无 range，超上限被截断）
 */
function seedLedger(): EvidenceLedgerStore {
  const ledger = makeLedger();
  ledger.append({ tool: 'terminal.exec', callId: 'c1', content: 'out-1\nout-2\nout-3' });
  ledger.append({
    tool: 'code.read',
    callId: 'c2',
    file: 'lib/a.ts',
    range: { start: 200, end: 450 },
    content: fileLines(200, 450),
  });
  ledger.append({
    tool: 'code.read',
    callId: 'c3',
    file: 'lib/big.ts',
    range: { start: 1, end: 300 },
    content: oversizedContent(),
  });
  ledger.append({ tool: 'code.search', callId: 'c4', content: oversizedContent() });
  return ledger;
}

async function getError(ledger: EvidenceLedgerStore, ref: string): Promise<string> {
  const result = await handleEvidence('get', { ref }, evidenceCtx(ledger));
  expect(result.ok).toBe(false);
  return String(result.error);
}

describe('evidence.get 子区间失败归类', () => {
  test('range 条目误用条目内相对行号：报子区间越界并写明文件行号可用区间', async () => {
    const ledger = seedLedger();
    const error = await getError(ledger, 'E-2@120-200');
    expect(error).toContain('子区间越界');
    expect(error).toContain('E-2@120-200');
    expect(error).toContain('200-450');
    expect(error).toContain('lib/a.ts');
    expect(error).toContain('文件行号');
    expect(error).not.toContain('无法解析');
  });

  test('无 range 条目越过条目末行：报子区间越界并写明条目内 1 起行号区间', async () => {
    const ledger = seedLedger();
    const error = await getError(ledger, 'E-1@2-9');
    expect(error).toContain('子区间越界');
    expect(error).toContain('1-3');
    expect(error).toContain('条目内 1 起行号');
    expect(error).not.toContain('无法解析');
  });

  test('range 条目子区间落在截断尾部：报截断尾部并写明真实可取区间', async () => {
    const ledger = seedLedger();
    const captured = capturedLineCount(ledger, 'E-3');
    expect(captured).toBeLessThan(250);
    const error = await getError(ledger, `E-3@${captured + 1}-${captured + 5}`);
    expect(error).toContain('截断尾部');
    expect(error).toContain(`1-${captured}`);
    expect(error).toContain('文件行号');
    expect(error).not.toContain('子区间越界');
    expect(error).not.toContain('无法解析');
    // 可取区间本身确实可取
    const okSlice = await handleEvidence('get', { ref: `E-3@1-${captured}` }, evidenceCtx(ledger));
    expect(okSlice.ok).toBe(true);
  });

  test('无 range 条目子区间落在截断尾部：报截断尾部并写明条目内可取区间', async () => {
    const ledger = seedLedger();
    const captured = capturedLineCount(ledger, 'E-4');
    const error = await getError(ledger, `E-4@${captured}-${captured + 1}`);
    expect(error).toContain('截断尾部');
    expect(error).toContain(`1-${captured}`);
    expect(error).toContain('条目内 1 起行号');
    expect(error).not.toContain('无法解析');
  });

  test('越界与截断同时成立：按越界报，并在可用区间里扣除截断尾部', async () => {
    const ledger = seedLedger();
    const captured = capturedLineCount(ledger, 'E-3');
    const error = await getError(ledger, 'E-3@250-400');
    expect(error).toContain('子区间越界');
    expect(error).toContain('1-300');
    expect(error).toContain(`1-${captured}`);
    expect(error).toContain('截断尾部');
  });

  test('id 不存在（含带子区间的未知 id）：仍报无法解析并附近期条目', async () => {
    const ledger = seedLedger();
    for (const ref of ['E-99', 'E-99@1-2', 'lib/a.ts:1-7']) {
      const error = await getError(ledger, ref);
      expect(error).toContain('无法解析');
      expect(error).toContain('E-2=lib/a.ts');
      expect(error).not.toContain('子区间越界');
      expect(error).not.toContain('截断尾部');
    }
  });

  test('三种失败文案各不相同，越界与截断尾部两类都带可用区间', async () => {
    const ledger = seedLedger();
    const captured = capturedLineCount(ledger, 'E-3');
    const outOfRange = await getError(ledger, 'E-2@120-200');
    const tail = await getError(ledger, `E-3@${captured + 1}-${captured + 1}`);
    const unknown = await getError(ledger, 'E-99');
    expect(new Set([outOfRange, tail, unknown]).size).toBe(3);
    expect(outOfRange).toContain('可用区间');
    expect(tail).toContain('可用区间');
    expect(unknown).not.toContain('可用区间');
  });

  test('归类路径输出诊断日志（触发条件、归类结果、关键区间）', async () => {
    const ledger = seedLedger();
    const logger = Logger.getInstance();
    const info = vi.spyOn(logger, 'info');
    await getError(ledger, 'E-2@120-200');
    const messages = info.mock.calls.map((call) => String(call[0]));
    const line = messages.find((message) => message.includes('E-2@120-200'));
    expect(line).toBeDefined();
    expect(line).toContain('surface=evidence.get');
    expect(line).toContain('kind=subrange-out-of-range');
    expect(line).toContain('declared=200-450');
    expect(line).toContain('available=200-450');

    await getError(ledger, 'E-99@1-2');
    const unknownLine = info.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes('E-99@1-2'));
    expect(unknownLine).toContain('kind=unknown-ref');
    expect(unknownLine).toContain('reason=id-not-in-ledger');
  });

  test('截断后不剩完整行：报截断尾部，可用区间为无并引导改用整条 id', async () => {
    const ledger = makeLedger();
    // 单行超上限：截断标记前只剩半行，台账没有任何可按子区间取回的完整行
    ledger.append({ tool: 'terminal.exec', callId: 'c1', content: 'q'.repeat(9000) });
    expect(capturedLineCount(ledger, 'E-1')).toBe(0);
    const error = await getError(ledger, 'E-1@1-1');
    expect(error).toContain('截断尾部');
    expect(error).toContain('可用区间 无');
    expect(error).toContain('整条 "E-1"');
    const whole = await handleEvidence('get', { ref: 'E-1' }, evidenceCtx(ledger));
    expect(whole.ok).toBe(true);
  });

  test('台账拒绝了探测显示可取的区间：不编造原因，降级为无法解析文案并告警', async () => {
    const base = { id: 'E-1', content: 'a\nb\nc' };
    // 非常规台账实现：整条与其它子区间都可取，唯独 E-1@2-2 被拒
    const quirkyLedger = {
      get(ref: string) {
        if (ref === 'E-1' || ref === 'E-1@1-1' || ref === 'E-1@1-3') {
          return base;
        }
        return null;
      },
      search: () => [],
      listRecent: () => [{ id: 'E-1' }],
      stats: () => ({ entries: 1, distinctFiles: 0 }),
      checkFreshness: () => 'unknown' as const,
    };
    const warn = vi.spyOn(Logger.getInstance(), 'warn');
    const ctx = { runtime: { evidenceLedger: quirkyLedger } } as unknown as EvidenceHandlerCtx;
    const result = await handleEvidence('get', { ref: 'E-1@2-2' }, ctx);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('无法解析');
    const warnLine = warn.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes('E-1@2-2'));
    expect(warnLine).toContain('falling back to unknown-ref wording');
    expect(warnLine).toContain('available=1-3');
  });
});

describe('evidence.get 超行数预算提示按坐标系给出示例', () => {
  test('range 条目：示例用文件行号，紧接已展示部分且可直接取回', async () => {
    const ledger = seedLedger();
    const result = await handleEvidence('get', { ref: 'E-2' }, evidenceCtx(ledger));
    expect(result.ok).toBe(true);
    const data = result.data as { content: string; capped: boolean };
    expect(data.capped).toBe(true);
    expect(data.content).toContain('narrow with');
    expect(data.content).toContain('"E-2@319-438"');
    expect(data.content).toContain('file line numbers');
    const next = await handleEvidence('get', { ref: 'E-2@319-438' }, evidenceCtx(ledger));
    expect(next.ok).toBe(true);
    const nextData = next.data as { content: string; capped: boolean };
    expect(nextData.capped).toBe(false);
    expect(nextData.content.startsWith('L319')).toBe(true);
  });

  test('无 range 条目：示例用条目内 1 起行号；子区间取回时示例接在请求区间之后', async () => {
    const ledger = makeLedger();
    ledger.append({ tool: 'terminal.exec', callId: 'c1', content: fileLines(1, 200) });
    const whole = await handleEvidence('get', { ref: 'E-1' }, evidenceCtx(ledger));
    const wholeContent = (whole.data as { content: string }).content;
    expect(wholeContent).toContain('"E-1@120-200"');
    expect(wholeContent).toContain('1-based line numbers within the entry');

    const sliced = await handleEvidence('get', { ref: 'E-1@50-200' }, evidenceCtx(ledger));
    expect(sliced.ok).toBe(true);
    const slicedData = sliced.data as { content: string; capped: boolean };
    expect(slicedData.capped).toBe(true);
    expect(slicedData.content.startsWith('L50')).toBe(true);
    expect(slicedData.content).toContain('"E-1@169-200"');
  });

  test('截断条目：示例止于真实可取末行，取回成功', async () => {
    const ledger = seedLedger();
    const captured = capturedLineCount(ledger, 'E-4');
    const result = await handleEvidence('get', { ref: 'E-4' }, evidenceCtx(ledger));
    const content = (result.data as { content: string }).content;
    const expectedEnd = Math.min(captured, 239);
    expect(content).toContain(`"E-4@120-${expectedEnd}"`);
    const next = await handleEvidence(
      'get',
      { ref: `E-4@120-${expectedEnd}` },
      evidenceCtx(ledger)
    );
    expect(next.ok).toBe(true);
  });

  test('已展示部分之后全是截断尾部：提示不可再取，不给越界示例', async () => {
    const ledger = makeLedger();
    // 构造恰好 119 个完整行落在截断点之前、第 120 行被截成半行的内容
    const keptChars = EVIDENCE_ENTRY_MAX_CHARS - EVIDENCE_TRUNCATION_MARKER.length - 1;
    const budget = keptChars - 10;
    const width = Math.floor(budget / 119);
    const lines = Array.from({ length: 119 }, () => 'x'.repeat(width - 1));
    lines[0] = 'x'.repeat(width - 1 + (budget - width * 119));
    const content = `${lines.join('\n')}\n${'y'.repeat(400)}\n${'z'.repeat(400)}`;
    ledger.append({ tool: 'terminal.exec', callId: 'c1', content });
    expect(capturedLineCount(ledger, 'E-1')).toBe(119);

    const result = await handleEvidence('get', { ref: 'E-1' }, evidenceCtx(ledger));
    const data = result.data as { content: string; capped: boolean };
    expect(data.capped).toBe(true);
    expect(data.content).toContain('truncated tail');
    expect(data.content).not.toContain('"E-1@120-');
  });
});

describe('note_finding 与 knowledge.submit 同类文案', () => {
  test('note_finding：越界、截断尾部、未知 id 三种拒绝文案不同，前两者带可用区间', async () => {
    const ledger = seedLedger();
    const captured = capturedLineCount(ledger, 'E-3');
    const reject = async (ref: string) => {
      const result = await handleMemory(
        'note_finding',
        { finding: 'f', evidenceRefs: [ref] },
        memoryCtx(ledger)
      );
      expect(result.ok).toBe(false);
      return String(result.error);
    };
    const outOfRange = await reject('E-2@120-200');
    const tail = await reject(`E-3@${captured + 1}-${captured + 1}`);
    const unknown = await reject('E-99');
    expect(outOfRange).toContain('evidenceRefs');
    expect(outOfRange).toContain('子区间越界');
    expect(outOfRange).toContain('200-450');
    expect(tail).toContain('截断尾部');
    expect(tail).toContain(`1-${captured}`);
    expect(unknown).toContain('无法解析');
    expect(outOfRange).not.toContain('无法解析');
    expect(tail).not.toContain('无法解析');
    expect(new Set([outOfRange, tail, unknown]).size).toBe(3);
  });

  test('note_finding 缺 evidenceRefs 的提示写明子区间坐标系', async () => {
    const ledger = seedLedger();
    const result = await handleMemory('note_finding', { finding: 'f' }, memoryCtx(ledger));
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('range 条目用文件行号，无 range 条目用条目内 1 起行号');
  });

  test('knowledge.submit 展开：越界、截断尾部、未知 id 三种拒绝文案不同', () => {
    const projectRoot = createTempProject('evidence-subrange-proj-');
    fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
    const ledger = seedLedger();
    const captured = capturedLineCount(ledger, 'E-3');
    const reject = (ref: string) => {
      const result = expandEvidenceRefsForSubmit(
        { title: 'T', reasoning: { evidenceRefs: [ref] } },
        { ledger, projectRoot }
      );
      expect(result.ok).toBe(false);
      return result.ok ? '' : result.error;
    };
    const outOfRange = reject('E-2@120-200');
    const tail = reject(`E-3@${captured + 1}-${captured + 1}`);
    const unknown = reject('E-99');
    expect(outOfRange).toContain('reasoning.evidenceRefs');
    expect(outOfRange).toContain('子区间越界');
    expect(outOfRange).toContain('200-450');
    expect(tail).toContain('截断尾部');
    expect(tail).toContain(`1-${captured}`);
    expect(unknown).toContain('无法解析');
    expect(outOfRange).not.toContain('无法解析');
    expect(tail).not.toContain('无法解析');
    expect(new Set([outOfRange, tail, unknown]).size).toBe(3);
  });
});

describe('registry 坐标说明', () => {
  test('evidence.get ref 不再声称统一 1-indexed，写明两类条目的坐标系', () => {
    const getAction = TOOL_REGISTRY.evidence?.actions.get;
    const refProp = (getAction?.params as { properties: Record<string, { description: string }> })
      .properties.ref;
    expect(refProp.description).not.toContain('1-indexed sub-range');
    expect(refProp.description).toContain('file line numbers');
    expect(refProp.description).toContain('1-based line numbers within the entry');
    expect(getAction?.description).toContain('file line numbers');
  });

  test('note_finding 与 submit 的 evidenceRefs 说明同样写明子区间坐标系', () => {
    const noteParams = TOOL_REGISTRY.memory?.actions.note_finding?.params as {
      properties: Record<string, { description: string }>;
    };
    expect(noteParams.properties.evidenceRefs.description).toContain('file line numbers');
    const submitParams = TOOL_REGISTRY.knowledge?.actions.submit?.params as {
      properties: Record<string, { properties?: Record<string, { description?: string }> }>;
    };
    const submitRefs = submitParams.properties.reasoning?.properties?.evidenceRefs;
    expect(submitRefs?.description).toContain('file line numbers');
  });
});
