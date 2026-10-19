import { readFileSync } from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildL4MemoryPackage,
  ContextWindow,
  limitToolResult,
  renderL4MemoryPackage,
  validateL4Summary,
} from '../src/agent/context/index.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { toSdkPrompt } from '../src/ai/transport/sdkProtocol.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';

/**
 * 直接调用 compactL4 的用例需要打开 L4 开关：开关关闭时 compactL4 短路返回 l4_disabled（L6-P15 C05）。
 * 运行时开关由 BudgetController 同步，这里按直接调用方的方式用构造参数打开。
 */
const L4_ON = { enableL4LLM: true } as const;

describe('ContextWindow L4 compaction transcript safety', () => {
  it.each([
    'append',
    'reset',
    'overlap',
  ])('does not overwrite newer context after L4 %s', async (change) => {
    const window = new ContextWindow(24_000, L4_ON);
    window.appendUserMessage('initial goal');
    window.appendUserMessage('old observation');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<{ text: string; usage: { inputTokens: number } }>();
    const pending = window.compactL4({
      chatWithTools: async () => {
        entered.resolve();
        return release.promise;
      },
    });
    await entered.promise;
    if (change === 'reset') {
      window.resetForNewStage();
      window.appendUserMessage('new stage goal');
    } else if (change === 'append') {
      window.appendUserMessage('new confirmed observation');
    } else {
      await window.compactL4({ chatWithTools: async () => ({ text: 'newer completed summary' }) });
    }
    const expected = structuredClone(window.toMessages());
    release.resolve({ text: 'obsolete summary', usage: { inputTokens: 7 } });
    expect(await pending).toMatchObject({ failed: true, removed: 0, usage: { inputTokens: 7 } });
    expect(window.toMessages()).toEqual(expected);
  });

  it('preserves user facts next to an ephemeral nudge through L2 and nudge replacement', () => {
    const window = new ContextWindow(48_000, { thresholds: [0, 0, 0, 100, 100] });
    window.appendUserMessage('initial goal');
    window.appendAssistantText('context');
    window.appendUserNudge('old phase instruction');
    window.appendUserMessage('USER_FACT_TO_KEEP');
    window.appendAssistantText('acknowledged');
    window.compactIfNeeded();
    window.appendUserNudge('new phase instruction');
    expect(JSON.stringify(window.toMessages())).toContain('USER_FACT_TO_KEEP');
    expect(JSON.stringify(window.toMessages())).not.toContain('old phase instruction');
  });

  it('carries only confirmed submitted titles across stage reset', () => {
    const window = new ContextWindow();
    window.appendUserMessage('inspect');
    for (const [id, action, result] of [
      ['query', 'search', { found: true }],
      ['denied', 'submit', { error: 'not permitted' }],
      ['saved', 'submit', { status: 'created', id: 'candidate', lifecycle: 'pending' }],
    ] as const) {
      window.appendAssistantWithToolCalls(null, [
        { id, name: 'knowledge', args: { action, params: { title: id } } },
      ]);
      window.appendToolResult(id, 'knowledge', JSON.stringify(result));
    }
    window.resetForNewStage();
    expect([...window.getCompactedSubmits()]).toEqual(['saved']);
  });
  it('keeps repeated tool calls paired with their results during L2 compression', () => {
    const window = new ContextWindow(48_000, { thresholds: [0, 0, 0, 100, 100] });
    window.appendUserMessage('produce');
    for (let round = 0; round < 4; round++) {
      window.appendAssistantWithToolCalls(null, [
        {
          id: `submit-${round}`,
          name: 'knowledge',
          args: { action: 'submit', params: { title: 'same candidate' } },
        },
        { id: `read-${round}`, name: 'code', args: { action: 'read' } },
      ]);
      window.appendToolResult(`submit-${round}`, 'knowledge', 'submission result');
      window.appendToolResult(`read-${round}`, 'code', 'source');
    }
    window.compactIfNeeded();
    const messages = window.toMessages();
    const calls = messages.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []);
    const results = messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId);
    expect(calls.sort()).toEqual(results.sort());
    expect(calls).toHaveLength(8);
  });

  it.each([
    'resetToPromptOnly',
    'resetForNewStage',
  ] as const)('clears stale compression projections on %s', (reset) => {
    const window = new ContextWindow(48_000, { thresholds: [0, 0, 0, 0, 100] });
    window.appendUserMessage('old prompt');
    for (let round = 0; round < 4; round++) {
      window.appendAssistantWithToolCalls(null, [{ id: `old-${round}`, name: 'code', args: {} }]);
      window.appendToolResult(`old-${round}`, 'code', `old ${round}`);
    }
    window.compactIfNeeded();
    window[reset]();
    if (reset === 'resetForNewStage') {
      window.appendUserMessage('new prompt');
    }
    for (let round = 0; round < 4; round++) {
      window.appendAssistantWithToolCalls(null, [{ id: `new-${round}`, name: 'code', args: {} }]);
      window.appendToolResult(`new-${round}`, 'code', `new ${round}`);
    }
    expect(window.toProjectedMessages()).toEqual(window.toMessages());
  });

  it('keeps runtime nudges ephemeral instead of accumulating repeated user messages', () => {
    const contextWindow = new ContextWindow(48_000);
    contextWindow.appendUserMessage('initial analyze prompt');
    contextWindow.appendUserNudge('first progress nudge');
    contextWindow.appendAssistantText('assistant response after first nudge');
    contextWindow.appendUserNudge('second progress nudge');

    const messages = contextWindow.toMessages();
    const rendered = JSON.stringify(messages);

    expect(messages).toHaveLength(3);
    expect(rendered).not.toContain('first progress nudge');
    expect(rendered).toContain('second progress nudge');
    expect(messages.at(-1)?.metadata).toMatchObject({ kind: 'runtime_nudge' });
  });

  it('applies a provider-input budget before the global model-context budget is high', () => {
    const contextWindow = new ContextWindow(48_000);
    contextWindow.appendUserMessage('initial analyze prompt');
    for (let index = 0; index < 8; index++) {
      contextWindow.appendAssistantWithToolCalls(null, [
        { id: `call-${index}`, name: 'code', args: { action: 'read', index } },
      ]);
      contextWindow.appendToolResult(
        `call-${index}`,
        'code',
        `Sources/App/Feature${index}.swift:1\n${'verified evidence line '.repeat(220)}`
      );
    }

    const beforeMessages = contextWindow.toProjectedMessages().length;
    const beforeTokens = contextWindow.estimateProjectedTokens();
    const result = contextWindow.compactForProviderInputBudget({
      maxProjectedMessages: 12,
      maxProjectedTokens: 2_000,
      stageProfile: 'analyze',
    });
    const projected = contextWindow.toProjectedMessages();

    expect(beforeMessages).toBeGreaterThan(12);
    expect(beforeTokens).toBeGreaterThan(2_000);
    expect(result.level).toBe(3);
    expect(result.beforeMessageCount).toBe(beforeMessages);
    expect(result.afterMessageCount).toBeLessThan(beforeMessages);
    expect(result.afterProjectedTokens).toBeLessThan(result.beforeProjectedTokens);
    expect(String(projected[1]?.content)).toContain('[Collapsed:');
    expect(JSON.stringify(projected)).toContain('Feature7.swift');
  });

  it('compacts knowledge.submit tool-call args before they enter provider history', () => {
    const contextWindow = new ContextWindow(48_000);
    contextWindow.appendUserMessage('produce candidates');
    contextWindow.appendAssistantWithToolCalls(null, [
      {
        id: 'submit-1',
        name: 'knowledge',
        args: {
          action: 'submit',
          params: {
            category: 'architecture',
            content: {
              markdown: 'large candidate body '.repeat(200),
            },
            coreCode: 'final class FeatureCoordinator {}'.repeat(80),
            dimensionId: 'design-patterns',
            kind: 'pattern',
            knowledgeType: 'recipe',
            reasoning: {
              sources: ['Sources/App/Feature.swift'],
              detail: 'large reasoning body '.repeat(200),
            },
            title: 'Feature coordinator ownership',
            trigger: 'FeatureCoordinator',
          },
        },
      },
    ]);

    const storedArgs = contextWindow.toMessages()[1]?.toolCalls?.[0]?.args;

    expect(storedArgs).toEqual({
      action: 'submit',
      params: {
        category: 'architecture',
        dimensionId: 'design-patterns',
        kind: 'pattern',
        knowledgeType: 'recipe',
        title: 'Feature coordinator ownership',
        trigger: 'FeatureCoordinator',
      },
      payloadSummary: {
        contentOmittedForProviderHistory: true,
        omittedFields: [
          'description',
          'content',
          'whenClause',
          'doClause',
          'dontClause',
          'coreCode',
          'reasoning',
        ],
        requiredFieldsComplete: false,
        sourceCount: 1,
      },
      providerHistoryCompacted: true,
    });
    expect(JSON.stringify(storedArgs)).not.toContain('large candidate body');
    expect(JSON.stringify(storedArgs)).not.toContain('final class FeatureCoordinator');
    expect(JSON.stringify(storedArgs)).not.toContain('large reasoning body');
  });

  it('builds L4 summary input from a structured memory package, not raw tool messages', async () => {
    const contextWindow = new ContextWindow(10_000, L4_ON);
    contextWindow.appendUserMessage('initial prompt');
    contextWindow.appendAssistantWithToolCalls(null, [
      { id: 'old-call', name: 'code', args: { action: 'read' } },
    ]);
    contextWindow.appendToolResult('old-call', 'code', 'old tool result');
    for (const index of [1, 2, 3, 4, 5]) {
      contextWindow.appendUserMessage(`recent user message ${index}`);
    }

    let sentMessages: Array<Record<string, unknown>> = [];
    const aiProvider = {
      chatWithTools: vi.fn(async (_prompt: string, opts: Record<string, unknown>) => {
        sentMessages = opts.messages as Array<Record<string, unknown>>;
        return { text: 'compacted summary', usage: { inputTokens: 3, outputTokens: 2 } };
      }),
    };

    const result = await contextWindow.compactL4(aiProvider);

    expect(result).toMatchObject({ level: 4, removed: 6 });
    expect(aiProvider.chatWithTools).toHaveBeenCalledTimes(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toContain('L4 Memory Package v1');
    expect(sentMessages[0].content).toContain('请将下面的 L4 Memory Package 压缩');
    expect(sentMessages[0].role).not.toBe('tool');
    expect(sentMessages.some((message) => message.role === 'tool')).toBe(false);
    expect(contextWindow.toMessages().some((message) => message.role === 'tool')).toBe(false);
    expect(contextWindow.toMessages()[1].content).toContain('[[L4 Memory Summary]]');
    expect(contextWindow.toMessages()[1].metadata).toMatchObject({ kind: 'l4_memory_summary' });
  });

  it('projects assistant tool calls as package text before summary', async () => {
    const contextWindow = new ContextWindow(10_000, L4_ON);
    contextWindow.appendUserMessage('initial prompt');
    contextWindow.appendUserMessage('older context to compact');
    contextWindow.appendAssistantWithToolCalls(null, [
      { id: 'missing-result', name: 'graph', args: { type: 'callers' } },
    ]);
    for (const index of [1, 2, 3, 4, 5]) {
      contextWindow.appendUserMessage(`recent message ${index}`);
    }

    let sentMessages: Array<Record<string, unknown>> = [];
    const aiProvider = {
      chatWithTools: vi.fn(async (_prompt: string, opts: Record<string, unknown>) => {
        sentMessages = opts.messages as Array<Record<string, unknown>>;
        return { text: 'summary' };
      }),
    };

    await contextWindow.compactL4(aiProvider);

    expect(aiProvider.chatWithTools).toHaveBeenCalledTimes(1);
    expect(sentMessages.some((message) => Array.isArray(message.toolCalls))).toBe(false);
    expect(sentMessages.some((message) => Array.isArray(message.tool_calls))).toBe(false);
    expect(sentMessages.map((message) => message.role)).not.toContain('tool');
    expect(String(sentMessages[0].content)).toContain('tool_calls=graph');
  });

  it('rejects L4 summaries that drop phase or evidence refs', async () => {
    const contextWindow = new ContextWindow(10_000, L4_ON);
    contextWindow.appendUserMessage('initial prompt');
    contextWindow.appendUserMessage('older context to compact');
    const aiProvider = {
      chatWithTools: vi.fn(async () => ({ text: '只有笼统摘要，没有关键引用。' })),
    };

    const result = await contextWindow.compactL4(aiProvider, {
      memoryPackage: {
        goal: 'analyze architecture',
        phase: 'VERIFY',
        activeContext: {
          distill: () => ({
            keyFindings: [
              {
                finding: 'Host adapter owns platform wiring',
                evidence: 'src/host.ts:12',
                importance: 8,
              },
            ],
            toolCallSummary: ['code.read src/host.ts'],
          }),
        },
      },
    });

    expect(result.failed).toBe(true);
    expect(result.validationMissing).toEqual(
      expect.arrayContaining(['phase:VERIFY', 'key_findings', 'evidence_refs'])
    );
    expect(contextWindow.toMessages()).toHaveLength(2);
    expect(String(contextWindow.toMessages()[1].content)).not.toContain('[[L4 Memory Summary]]');
  });

  it('discards in-flight L4 compaction results after abort', async () => {
    const contextWindow = new ContextWindow(10_000, L4_ON);
    contextWindow.appendUserMessage('initial prompt');
    contextWindow.appendUserMessage('older context to compact');
    const abortController = new AbortController();
    const aiProvider = {
      chatWithTools: vi.fn(async () => {
        abortController.abort();
        return { text: 'VERIFY Host src/host.ts summary' };
      }),
    };

    const result = await contextWindow.compactL4(aiProvider, {
      abortSignal: abortController.signal,
      memoryPackage: {
        phase: 'VERIFY',
        activeContext: {
          distill: () => ({
            keyFindings: [
              {
                finding: 'Host adapter owns platform wiring',
                evidence: 'src/host.ts:12',
                importance: 8,
              },
            ],
          }),
        },
      },
    });

    expect(result).toMatchObject({ failed: true, cancelled: true, removed: 0 });
    expect(contextWindow.toMessages()).toHaveLength(2);
    expect(String(contextWindow.toMessages()[1].content)).not.toContain('[[L4 Memory Summary]]');
  });
});

// ─── A-1 #compactL1 首+尾保留（独立验收，§8 Phase 1）──────────────────────────
// 设计硬规则：「L1 done」不得计为「limit done」—— A-1 与下方 A-1b 各自独立断言。
describe('A-1 #compactL1 head+tail retention', () => {
  function buildWindow(): { cw: ContextWindow; tailMark: string; headMark: string } {
    const cw = new ContextWindow(48_000);
    cw.appendUserMessage('analyze prompt');
    const headMark = 'HEAD_SIGNAL_TOKEN';
    // 对抗修正#3（FOLD）：tailMark 收到 ≤24 字，覆盖最坏 safeTail（~45），固化用例。
    const tailMark = 'TAIL_errs=3_total=42'; // 20 字
    const body = 'x'.repeat(4000);
    cw.appendAssistantWithToolCalls(null, [{ id: 'old', name: 'code', args: {} }]);
    cw.appendToolResult('old', 'code', `${headMark}\n${body}\n${tailMark}`);
    cw.appendAssistantWithToolCalls(null, [{ id: 'new', name: 'code', args: {} }]);
    cw.appendToolResult('new', 'code', 'short recent result');
    return { cw, tailMark, headMark };
  }

  it('keeps head AND tail of an old oversized tool result', () => {
    const { cw, tailMark, headMark } = buildWindow();
    cw.compactForProviderInputBudget({ maxProjectedMessages: 1, maxProjectedTokens: 1 });
    const out = cw.toMessages().find((m) => m.toolCallId === 'old')?.content ?? '';
    expect(out).toContain(headMark);
    expect(out).toContain(tailMark); // 旧实现会丢
  });

  it('uses a marker distinct from the read-entry (clampReadResult) marker', () => {
    const { cw } = buildWindow();
    cw.compactForProviderInputBudget({ maxProjectedMessages: 1, maxProjectedTokens: 1 });
    const out = cw.toMessages().find((m) => m.toolCallId === 'old')?.content ?? '';
    expect(out).toContain('compaction snip');
    expect(out).not.toContain('batch read budget');
  });

  it('is idempotent across >=3 compaction cycles (tail survives, no re-truncation)', () => {
    const { cw, tailMark } = buildWindow();
    cw.compactForProviderInputBudget({ maxProjectedMessages: 1, maxProjectedTokens: 1 });
    const afterFirst = cw.toMessages().find((m) => m.toolCallId === 'old')?.content ?? '';
    expect(afterFirst.length).toBeLessThanOrEqual(500);
    for (let cycle = 0; cycle < 2; cycle++) {
      cw.compactForProviderInputBudget({ maxProjectedMessages: 1, maxProjectedTokens: 1 });
    }
    const afterThird = cw.toMessages().find((m) => m.toolCallId === 'old')?.content ?? '';
    expect(afterThird).toBe(afterFirst);
    expect(afterThird).toContain(tailMark.slice(-10));
  });

  it('does not add or remove messages (atomic pairing / messages[0] pin intact)', () => {
    const { cw } = buildWindow();
    const before = cw.toMessages().length;
    cw.compactForProviderInputBudget({ maxProjectedMessages: 1, maxProjectedTokens: 1 });
    expect(cw.toMessages().length).toBe(before);
    expect(cw.toMessages()[0]?.content).toBe('analyze prompt');
  });
});

// ─── A-1b limit* 系列首+尾保留（独立验收，§8 Phase 1b）────────────────────────
// 独立于 A-1：直接对导出符号 limitToolResult 断言，marker=tool-result snip 且 ≠ 另两层。
describe('A-1b limitToolResult/limitFileContent head+tail', () => {
  it('limits batch search results without changing the original tool result', () => {
    const input = {
      batchResults: {
        query: {
          matches: Array.from({ length: 8 }, (_, line) => ({ file: 'a.ts', line, code: 'source' })),
        },
      },
    };
    const before = structuredClone(input);
    const output = JSON.parse(limitToolResult('code', input, { maxMatches: 2, maxChars: 4000 }));
    expect(output.batchResults.query.matches).toHaveLength(2);
    expect(input).toEqual(before);
  });
  it('keeps tail of a generic oversized string result', () => {
    const big = `START_HEAD${'y'.repeat(5000)}END_TAIL_match_count=17`;
    const out = limitToolResult('shell', big, { maxChars: 500 });
    expect(out).toContain('START_HEAD');
    expect(out).toContain('END_TAIL_match_count=17');
    expect(out).toContain('tool-result snip');
    expect(out).not.toContain('compaction snip');
    expect(out).not.toContain('batch read budget');
  });

  it('keeps tail of a code batch-truncated result', () => {
    // 对抗修正#1（FOLD）：原规格断言 toContain('k49') 为假阳——尾窗只剩值片段，键 token
    // 落在省略区。改断尾部值片段（c49）+ marker，不断键名。
    const padded = {
      batchResults: Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`k${i}`, { content: `c${i}`.repeat(40) }])
      ),
    };
    const out = limitToolResult('code', padded, { maxChars: 400, maxMatches: 3 });
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain('tool-result snip');
    expect(out).toContain('c49'); // 尾部值片段存活（旧纯头实现会丢）
  });

  it('keeps tail of file content (last lines survive)', () => {
    const content = [
      'IMPORTS_HEADER',
      ...Array.from({ length: 400 }, (_, i) => `line${i}`),
      'EXPORTS_FOOTER',
    ].join('\n');
    const out = limitToolResult('code', { content }, { maxChars: 600 });
    expect(out).toContain('IMPORTS_HEADER');
    expect(out).toContain('EXPORTS_FOOTER'); // 尾整行存活
    expect(out).toContain('tool-result snip');
  });
});

// ─── P1-A F1：证据尾注抗截断(压力档 400 字配额下尾注曾被 head+tail 截断整段吞掉) ───
describe('P1-A F1 limitToolResult 证据尾注抗截断', () => {
  const annotation = '\n\n[evidence] E-1=src/a.ts:1-20; E-2=src/b.ts:5-30; E-3=src/c.ts:2-9';

  it('压力档小配额下尾注完整存活，正文按剩余预算截断', () => {
    const body = 'x'.repeat(5000);
    const out = limitToolResult('code', `${body}${annotation}`, { maxChars: 400 });
    expect(out.endsWith(annotation)).toBe(true);
    // 正文被截(远小于原文)，总长受控(正文预算下限 200 + 尾注)。
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain('x');
  });

  it('无尾注时行为与原实现一致(纯透传原逻辑)', () => {
    const body = 'y'.repeat(5000);
    const out = limitToolResult('code', body, { maxChars: 400 });
    expect(out.includes('[evidence]')).toBe(false);
    expect(out.length).toBeLessThan(1000);
  });

  it('病态超长尾注被封顶(800 字)而非吃光配额', () => {
    const hugeAnnotation = `\n\n[evidence] ${'E-1=src/a.ts:1-2; '.repeat(200)}`.trimEnd();
    const out = limitToolResult('code', `${'z'.repeat(1000)}${hugeAnnotation}`, { maxChars: 400 });
    expect(out).toContain('[evidence]');
    expect(out.length).toBeLessThan(1300);
  });
});

describe('L4 memory package', () => {
  it('uses nested successful receipts for source refs and keeps failed calls as failed observations', () => {
    const pkg = buildL4MemoryPackage({
      toolCalls: [
        {
          tool: 'code',
          args: { action: 'read', params: { path: 'src/read.ts', startLine: 8 } },
          result: 'actual source',
        },
        {
          tool: 'code',
          args: { action: 'read', path: 'src/denied.ts' },
          result: { ok: false, error: 'denied' },
        },
      ],
    });
    expect(pkg.evidenceRefs).toEqual([expect.objectContaining({ path: 'src/read.ts', line: 8 })]);
    expect(
      pkg.toolResultSummary.some((line) => line.includes('failed') && line.includes('denied'))
    ).toBe(true);
  });
  it('builds a structured package from ActiveContext distill, phase state, and recent text', () => {
    const pkg = buildL4MemoryPackage({
      goal: 'Analyze host adapter boundaries',
      phase: 'VERIFY',
      stageStatus: 'running',
      activeContext: {
        distill: () => ({
          keyFindings: [
            {
              finding: 'Host adapter owns platform wiring',
              evidence: 'src/host.ts:12',
              importance: 8,
            },
          ],
          toolCallSummary: ['[code] read src/host.ts'],
          plan: {
            text: 'Check adapters',
            steps: [{ status: 'done', description: 'Read host adapter' }],
          },
          totalObservations: 3,
          compressedCount: 1,
        }),
      },
      recentMessages: [
        {
          role: 'tool',
          name: 'code',
          toolCallId: 'orphan',
          content: 'raw result should become text',
        },
      ],
      diagnostics: {
        degraded: true,
        gateFailures: [{ stage: 'quality', action: 'record_repair', reason: 'missing findings' }],
        timedOutStages: ['analyze'],
      },
    });

    expect(pkg).toMatchObject({
      kind: 'l4_memory_package',
      phase: 'VERIFY',
      stageStatus: 'running',
      stats: { totalObservations: 3, compressedCount: 1 },
    });
    expect(pkg.keyFindings[0]).toMatchObject({
      finding: 'Host adapter owns platform wiring',
      evidence: 'src/host.ts:12',
    });
    expect(pkg.evidenceRefs[0]).toMatchObject({ path: 'src/host.ts', line: 12 });
    expect(pkg.recentConversation[0]).toContain('tool-result-as-text');
    expect(pkg.failureState).toEqual(expect.arrayContaining(['timedOutStage=analyze']));

    const rendered = renderL4MemoryPackage(pkg);
    expect(rendered).toContain('L4 Memory Package v1');
    expect(rendered).toContain('src/host.ts:12');
    expect(rendered).not.toContain('role: tool');
  });

  it('validates that summaries retain phase, findings, evidence, and failure state', () => {
    const pkg = buildL4MemoryPackage({
      phase: 'RECORD',
      activeContext: {
        distill: () => ({
          keyFindings: [
            {
              finding: 'Record repair writes validated findings',
              evidence: 'src/repair.ts:20',
              importance: 9,
            },
          ],
        }),
      },
      diagnostics: { efficiency: { cancelReason: 'stage_timeout' } },
    });

    expect(
      validateL4Summary('RECORD 摘要保留 Record repair、src/repair.ts 和 stage_timeout。', pkg)
    ).toEqual({ ok: true, missing: [] });
    expect(validateL4Summary('笼统摘要', pkg)).toMatchObject({
      ok: false,
      missing: expect.arrayContaining(['phase:RECORD', 'key_findings', 'evidence_refs']),
    });
  });
});

/**
 * L4 记忆包的校验与渲染边界：中文发现按字符二元组判断覆盖，失败状态不再被平凡的布尔末段命中；
 * 未决问题进入渲染文本并随 L4 替换保留；蒸馏摘要不被同一批调用的原始回执挤掉；
 * distill() 抛错时在包内留下 distill_failed，并由 ContextWindow 打 warn。
 */
describe('L4 memory package validation and rendering', () => {
  function cjkFindingPackage() {
    return buildL4MemoryPackage({
      phase: 'RECORD',
      activeContext: {
        distill: () => ({
          keyFindings: [
            {
              finding: '依赖注入通过构造函数完成，避免全局单例',
              evidence: 'src/a.ts:3',
              importance: 8,
            },
          ],
        }),
      },
      diagnostics: { degraded: true },
    });
  }

  it('accepts faithful Chinese paraphrases of a Chinese finding in a degraded run', () => {
    const pkg = cjkFindingPackage();
    expect(
      validateL4Summary(
        'RECORD 阶段：依赖通过构造器注入，不使用全局单例；证据 src/a.ts，已降级',
        pkg
      )
    ).toEqual({ ok: true, missing: [] });
    // 没有任何 4 字原句窗口重合，只靠二元组覆盖率判断。
    expect(
      validateL4Summary('RECORD：构造器注入依赖已完成，规避全局共享单例；src/a.ts；运行已降级', pkg)
    ).toEqual({ ok: true, missing: [] });
    // 只命中个别常见二元组的笼统中文摘要仍然不算覆盖。
    expect(validateL4Summary('RECORD 本阶段完成了分析，证据 src/a.ts，已降级', pkg)).toMatchObject({
      ok: false,
      missing: ['key_findings'],
    });
  });

  it('does not let a trivial boolean word satisfy the failure state check', () => {
    const pkg = buildL4MemoryPackage({
      phase: 'RECORD',
      activeContext: {
        distill: () => ({
          keyFindings: [
            {
              finding: 'Record repair writes validated findings',
              evidence: 'src/repair.ts:20',
              importance: 9,
            },
          ],
        }),
      },
      diagnostics: { degraded: true },
    });

    expect(validateL4Summary('RECORD Record repair src/repair.ts code.read is true', pkg)).toEqual({
      ok: false,
      missing: ['failure_state'],
    });
    expect(validateL4Summary('RECORD Record repair src/repair.ts degraded run', pkg)).toEqual({
      ok: true,
      missing: [],
    });
    expect(validateL4Summary('RECORD Record repair src/repair.ts 已降级', pkg)).toEqual({
      ok: true,
      missing: [],
    });
  });

  it('ignores English stop words when matching key findings', () => {
    const pkg = buildL4MemoryPackage({
      activeContext: {
        distill: () => ({
          keyFindings: [{ finding: 'This should have been wired with the gateway adapter' }],
        }),
      },
    });

    expect(validateL4Summary('Summary: this should have been done with care', pkg)).toEqual({
      ok: false,
      missing: ['key_findings'],
    });
    expect(validateL4Summary('Summary: the gateway adapter is wired', pkg)).toEqual({
      ok: true,
      missing: [],
    });
  });

  it('renders unresolved questions and keeps them through an L4 replacement', async () => {
    const question = 'Q-ZETA-42 是否需要重新扫描 vendor 目录？';
    const pkg = buildL4MemoryPackage({ unresolvedQuestions: [question] });
    const rendered = renderL4MemoryPackage(pkg);
    expect(rendered).toContain('## Unresolved Questions');
    expect(rendered).toContain(question);
    expect(rendered.indexOf('## Unresolved Questions')).toBeLessThan(
      rendered.indexOf('## Failure / Degraded State')
    );
    expect(renderL4MemoryPackage(buildL4MemoryPackage({}))).toContain(
      '## Unresolved Questions\n- none'
    );

    const contextWindow = new ContextWindow(10_000, L4_ON);
    contextWindow.appendUserMessage('initial prompt');
    contextWindow.appendUserMessage('older context to compact');
    let instructions = '';
    let sentContent = '';
    const aiProvider = {
      chatWithTools: vi.fn(async (prompt: string, opts: Record<string, unknown>) => {
        instructions = prompt;
        sentContent = String((opts.messages as Array<Record<string, unknown>>)[0]?.content);
        return { text: 'generic summary' };
      }),
    };

    const result = await contextWindow.compactL4(aiProvider, {
      memoryPackage: { phase: 'unknown', unresolvedQuestions: [question] },
    });

    expect(result.failed).not.toBe(true);
    expect(sentContent).toContain(question);
    expect(instructions).toContain('finding id');
    expect(instructions).toContain('Failure / Degraded State');
    expect(instructions).toContain('Unresolved Questions');
    expect(String(contextWindow.toMessages()[1].content)).toContain(question);
  });

  it('keeps the distilled tool summary next to many successful raw receipts', () => {
    const toolCalls: Array<Record<string, unknown>> = Array.from({ length: 20 }, (_, index) => ({
      tool: 'code',
      args: { action: 'search', query: `query-${index}` },
      result: `raw success body ${index}`,
    }));
    toolCalls.push({
      tool: 'code',
      args: { action: 'read', path: 'src/denied.ts' },
      result: { ok: false, error: 'denied' },
    });

    const pkg = buildL4MemoryPackage({
      activeContext: {
        distill: () => ({
          toolCallSummary: ['[code] distilled read of src/host.ts', '[graph] distilled callers'],
        }),
      },
      toolCalls,
    });

    expect(pkg.toolResultSummary).toEqual(
      expect.arrayContaining(['[code] distilled read of src/host.ts', '[graph] distilled callers'])
    );
    expect(pkg.toolResultSummary.some((line) => line.includes('raw success body'))).toBe(false);
    expect(
      pkg.toolResultSummary.some((line) => line.includes('failed') && line.includes('denied'))
    ).toBe(true);
  });

  it('splits the tool summary budget between distilled entries and failed receipts', () => {
    const distilled = Array.from({ length: 20 }, (_, index) => `[code] distilled-${index}`);
    const toolCalls = Array.from({ length: 10 }, (_, index) => ({
      tool: 'code',
      args: { action: 'read', path: `src/f${index}.ts` },
      result: { ok: false, error: `failure-${index}` },
    }));

    const pkg = buildL4MemoryPackage({
      activeContext: { distill: () => ({ toolCallSummary: distilled }) },
      toolCalls,
    });

    expect(pkg.toolResultSummary).toHaveLength(12);
    expect(pkg.toolResultSummary.slice(0, 8)).toEqual(distilled.slice(-8));
    expect(pkg.toolResultSummary.slice(8).every((line) => line.includes('failed'))).toBe(true);
    expect(pkg.toolResultSummary.at(-1)).toContain('failure-9');
  });

  it('records a throwing distill as distill_failed and warns before the L4 summary', async () => {
    const throwingContext = {
      distill: () => {
        throw new Error('STRICT_CONTEXT_HASH_MISMATCH');
      },
    };
    const pkg = buildL4MemoryPackage({ activeContext: throwingContext });
    expect(pkg.failureState[0]).toBe('distill_failed=STRICT_CONTEXT_HASH_MISMATCH');
    expect(renderL4MemoryPackage(pkg)).toContain('distill_failed=STRICT_CONTEXT_HASH_MISMATCH');
    expect(validateL4Summary('笼统摘要', pkg)).toMatchObject({
      ok: false,
      missing: ['failure_state'],
    });

    const warn = vi.spyOn(Logger.getInstance(), 'warn');
    const contextWindow = new ContextWindow(10_000, L4_ON);
    contextWindow.appendUserMessage('initial prompt');
    contextWindow.appendUserMessage('older context to compact');
    const result = await contextWindow.compactL4(
      { chatWithTools: vi.fn(async () => ({ text: '蒸馏失败，摘要只基于近期消息。' })) },
      { memoryPackage: { phase: 'unknown', activeContext: throwingContext } }
    );

    expect(result.failed).not.toBe(true);
    expect(warn.mock.calls.some(([message]) => String(message).includes('distill_failed'))).toBe(
      true
    );
  });

  // 编码守卫：L4 校验启发式（4 字窗口、二元组覆盖率、平凡末段过滤、键/同义词回退）
  // 只靠注释解释。写入工具曾把这些中文注释落盘成字面 \uXXXX 转义，biome 与 tsc 都不会报。
  // 这里只检查注释行，代码里的正则或字符串若确需 \u 转义不受影响。
  it.each([
    'src/agent/context/l4MemoryPackage.ts',
    'src/agent/context/ContextWindow.ts',
  ])('keeps the comments in %s as readable characters, not \\uXXXX escapes', (rel) => {
    const source = readFileSync(path.join(process.cwd(), rel), 'utf8');
    const escapedCommentLines = source
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter(
        ({ text }) =>
          (text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')) &&
          /\\u[0-9a-fA-F]{4}/.test(text)
      )
      .map(({ line }) => line);
    expect(escapedCommentLines).toEqual([]);
  });
});

afterEach(() => vi.restoreAllMocks());
function deferred<T>() {
  return Promise.withResolvers<T>();
}
function withCreated(history: string) {
  const context = new ContextWindow(48_000, { thresholds: [0, 0, 0, 0, 100], enableL4LLM: true });
  context.appendUserMessage('initial request');
  context.appendAssistantWithToolCalls(null, [
    { id: 'created-call', name: 'knowledge', args: { action: 'submit', title: 'confirmed-title' } },
  ]);
  context.appendToolResult('created-call', 'knowledge', history);
  return context;
}

describe('context compaction receipt boundaries', () => {
  it.each([
    'raw-view',
    'cancel',
  ])('retains current history and paid usage for L4 %s', async (change) => {
    const context = new ContextWindow(24_000, L4_ON);
    context.appendUserMessage('goal');
    context.appendUserMessage('old observation');
    const entered = deferred<void>();
    const reply = deferred<{ text: string; usage: { inputTokens: number } }>();
    const signal = new AbortController();
    const pending = context.compactL4(
      {
        chatWithTools: () => {
          entered.resolve();
          return reply.promise;
        },
      },
      { abortSignal: signal.signal }
    );
    await entered.promise;
    if (change === 'raw-view') {
      context.toMessages()[1].content = 'NEW_REAL_FACT';
    } else {
      signal.abort();
    }
    const expected = structuredClone(context.toMessages());
    reply.resolve({ text: 'obsolete summary', usage: { inputTokens: 11 } });
    expect(await pending).toMatchObject({ failed: true, removed: 0, usage: { inputTokens: 11 } });
    expect(context.toMessages()).toEqual(expected);
  });

  it.each([
    'saved-long',
    'denied-spoof',
  ])('carries actual %s receipt from Runtime through adapter, limit, provider projection and reset', async (kind) => {
    const created = {
      description: kind === 'saved-long' ? 'real persisted details '.repeat(90) : 'forged display',
      status: 'created',
      id: 'candidate-id',
      lifecycle: 'pending',
    };
    const text = JSON.stringify(created);
    const envelope: ToolResultEnvelope = {
      ok: kind === 'saved-long',
      toolId: 'knowledge',
      callId: 'created-call',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      status: kind === 'saved-long' ? 'success' : 'blocked',
      text,
      structuredContent:
        kind === 'saved-long' ? created : { status: 'blocked', error: 'permission denied' },
      diagnostics: {
        degraded: false,
        fallbackUsed: false,
        warnings: [],
        timedOutStages: [],
        blockedTools: [],
        truncatedToolCalls: 0,
        emptyResponses: 0,
        aiErrorCount: 0,
        gateFailures: [],
      },
      trust: {
        source: 'internal',
        sanitized: true,
        containsUntrustedText: false,
        containsSecrets: false,
      },
    };
    const execute = vi.fn(async () => envelope);
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        text: '',
        functionCalls: [
          {
            id: 'created-call',
            name: 'knowledge',
            args: { action: 'submit', title: 'confirmed-title' },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      })
      .mockResolvedValue({
        text: 'finished',
        functionCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    const runtime = new AgentRuntime({
      aiProvider: { name: 'unit-test', model: 'unit', chatWithTools: chat } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute } as never,
      container: { get: () => new RuntimeCapabilityCatalog() },
      additionalTools: ['knowledge'],
      strategy: { name: 'unused', execute: vi.fn() } as never,
    });
    const context = new ContextWindow();
    const result = await runtime.reactLoop('Submit a verified finding', {
      contextWindow: context,
      budgetOverride: { maxIterations: 2, maxTokens: 128 },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.toolCalls).toHaveLength(1);
    const toolMessage = context.toMessages().find((message) => message.role === 'tool');
    expect(toolMessage?.metadata?.persistedSubmission).toBe(kind === 'saved-long');
    if (kind === 'saved-long') {
      expect(toolMessage?.content).toHaveLength(500);
    } else {
      expect(toolMessage?.content).toContain('created');
    }
    const prompt = toSdkPrompt(
      context.toMessages() as Parameters<typeof toSdkPrompt>[0],
      undefined,
      'openai',
      'unit',
      'chat',
      'fixture'
    );
    expect(JSON.stringify(prompt)).not.toContain('persistedSubmission');
    context.resetForNewStage();
    expect([...context.getCompactedSubmits()]).toEqual(
      kind === 'saved-long' ? ['confirmed-title'] : []
    );
  });

  it('keeps the three-argument legacy boundary honest when text no longer contains a complete receipt', () => {
    const history = limitToolResult(
      'knowledge',
      JSON.stringify({
        description: 'real persisted details '.repeat(90),
        status: 'created',
        id: 'candidate-id',
        lifecycle: 'pending',
      }),
      { maxChars: 6000 }
    );
    const context = withCreated(history);
    context.resetForNewStage();
    expect([...context.getCompactedSubmits()]).toEqual([]);
  });

  it('retains already confirmed short submit receipts through successful L4 replacement', async () => {
    const context = withCreated(
      JSON.stringify({ status: 'created', id: 'candidate-id', lifecycle: 'pending' })
    );
    const result = await context.compactL4({
      chatWithTools: async () => ({
        text: 'confirmed runtime summary',
        usage: { inputTokens: 13 },
      }),
    });
    expect(result.failed).not.toBe(true);
    context.resetForNewStage();
    expect([...context.getCompactedSubmits()]).toEqual(['confirmed-title']);
  });

  it('does not turn a completed L4 replacement into zero-usage failure when logging fails', async () => {
    const context = new ContextWindow(24_000, L4_ON);
    context.appendUserMessage('goal');
    context.appendUserMessage('observation');
    context.appendAssistantText('response');
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => {
      throw new Error('log sink failed');
    });
    const result = await context.compactL4({
      chatWithTools: async () => ({
        text: 'confirmed runtime summary',
        usage: { inputTokens: 13 },
      }),
    });
    expect(context.toMessages()[1].metadata?.kind).toBe('l4_memory_summary');
    expect(result).toMatchObject({ removed: 1, usage: { inputTokens: 13 } });
    expect(result.failed).not.toBe(true);
  });
});

/**
 * 折叠后的上下文记账钉子。
 *
 * 背景：L3 collapse 是读时投影——原始消息保留，发给模型的是 toProjectedMessages()。
 * 但用量比例、工具结果配额、压缩触发、L4 判定此前都按原始消息估算：长阶段里原始历史
 * 只增不减，配额被永久压到最低档（400 字符），而模型实际看到的输入只占预算的一小部分；
 * compactIfNeeded 也会在每一轮重复折叠并重复写压缩日志。
 * 现在「用量」只有一个口径：发给模型的投影视图。
 */
describe('context usage follows the provider-visible projection', () => {
  /** 每轮结果不超过 L1 截断阈值，保证原始历史不会被 L1 缩小——只有折叠能让模型输入变小。 */
  function fillRounds(window: ContextWindow, rounds: number, resultChars = 1900) {
    window.appendUserMessage('initial analyze prompt');
    for (let index = 0; index < rounds; index++) {
      window.appendAssistantWithToolCalls(null, [
        { id: `call-${index}`, name: 'code', args: { action: 'read', index } },
      ]);
      window.appendToolResult(`call-${index}`, 'code', `r${index}:${'x'.repeat(resultChars)}`);
    }
  }

  it('restores the tool-result quota once the collapsed projection is small', () => {
    const window = new ContextWindow(24_000);
    fillRounds(window, 60);
    expect(window.getTokenUsageRatio()).toBeGreaterThan(0.95);
    expect(window.getToolResultQuota()).toEqual({ maxChars: 400, maxMatches: 2 });

    const result = window.compactForProviderInputBudget({
      maxProjectedMessages: 12,
      maxProjectedTokens: 4_000,
      stageProfile: 'analyze',
    });
    expect(result.level).toBe(3);

    // 模型只会看到最近两轮；配额按它实际看到的输入恢复，而不是按保留的原始历史。
    expect(window.estimateTokens()).toBe(window.estimateProjectedTokens());
    expect(window.estimateRetainedTokens()).toBeGreaterThan(window.estimateTokens() * 10);
    expect(window.getTokenUsageRatio()).toBeCloseTo(
      window.estimateProjectedTokens() / window.tokenBudget,
      10
    );
    expect(window.getTokenUsageRatio()).toBeLessThan(0.4);
    expect(window.getToolResultQuota()).toEqual({ maxChars: 6000, maxMatches: 15 });
    expect(window.estimateFullContextTokens(3500, 2)).toBe(
      window.estimateProjectedTokens() + 1000 + 200
    );
    expect(window.tokenCount).toBe(window.estimateTokens());
  });

  it('still lowers the quota under session pressure after a collapse', () => {
    const window = new ContextWindow(24_000);
    fillRounds(window, 60);
    window.compactForProviderInputBudget({ maxProjectedMessages: 12, maxProjectedTokens: 4_000 });
    window.setSessionPressure(0.9);
    expect(window.getToolResultQuota()).toEqual({ maxChars: 800, maxMatches: 3 });
  });

  it('does not re-run compaction every turn while the projection stays under the thresholds', () => {
    const window = new ContextWindow(24_000);
    fillRounds(window, 60);
    expect(window.compactIfNeeded().level).toBe(3);
    const revision = window.readViewRevision;
    const logLength = window.getCompactionLog().length;

    for (let turn = 0; turn < 3; turn++) {
      expect(window.compactIfNeeded()).toEqual({ level: 0, removed: 0 });
    }
    expect(window.getCompactionLog()).toHaveLength(logLength);
    expect(window.readViewRevision).toBe(revision);
  });

  it('collapses again only after new rounds push the projection back over the threshold', () => {
    const window = new ContextWindow(24_000);
    fillRounds(window, 60);
    window.compactIfNeeded();
    const firstBoundary = window.toProjectedMessages().length;

    // 再追加足够多的轮次，让投影重新越过 L3 阈值。
    for (let index = 60; index < 110; index++) {
      window.appendAssistantWithToolCalls(null, [
        { id: `call-${index}`, name: 'code', args: { action: 'read', index } },
      ]);
      window.appendToolResult(`call-${index}`, 'code', `r${index}:${'x'.repeat(1900)}`);
    }
    expect(window.getTokenUsageRatio()).toBeGreaterThan(0.82);
    expect(window.compactIfNeeded().level).toBe(3);
    expect(window.toProjectedMessages()).toHaveLength(firstBoundary);
    expect(JSON.stringify(window.toProjectedMessages())).toContain('r109:');
    expect(window.getTokenUsageRatio()).toBeLessThan(0.4);
  });

  it('does not log a repeated collapse at an unchanged boundary', () => {
    // 预算很小：最近两轮本身就超过阈值，折叠后投影仍然偏高，每轮都会再次进入 L3。
    const window = new ContextWindow(1_000);
    fillRounds(window, 4);
    expect(window.compactIfNeeded().level).toBe(3);
    const revision = window.readViewRevision;
    const logLength = window.getCompactionLog().length;
    const projected = structuredClone(window.toProjectedMessages());

    expect(window.getTokenUsageRatio()).toBeGreaterThan(0.82);
    expect(window.compactIfNeeded().level).toBe(3);
    expect(window.compactIfNeeded().level).toBe(3);
    expect(window.getCompactionLog()).toHaveLength(logLength);
    expect(window.readViewRevision).toBe(revision);
    expect(window.toProjectedMessages()).toEqual(projected);
  });

  it('asks for an L4 summary only when the projection itself is near the budget', () => {
    const collapsed = new ContextWindow(24_000, { enableL4LLM: true });
    fillRounds(collapsed, 60);
    collapsed.compactIfNeeded();
    expect(collapsed.needsL4Compaction()).toBe(false);

    const saturated = new ContextWindow(1_000, { enableL4LLM: true });
    fillRounds(saturated, 4);
    saturated.compactIfNeeded();
    expect(saturated.needsL4Compaction()).toBe(true);
  });
});

/**
 * ContextWindow 改写 knowledge submit 参数后，原生续接的投影摘要不可能再匹配；
 * 改写方负责丢弃续接、保留 reasoningContent，并只在追加时留一次诊断。
 */
describe('provider-history compaction and native continuation', () => {
  const continuationFor = (callId: string, provider = 'deepseek', model = 'deepseek-v4-pro') =>
    ({
      provider,
      model,
      connection: 'fixture-connection',
      kind: 'content-replay-v1',
      parts: [
        { type: 'reasoning', text: 'native reasoning '.repeat(400) },
        { type: 'tool-call', id: callId },
      ],
      projectionHash: 'captured-before-compaction',
    }) as const;
  const submitCall = (id: string) => ({
    id,
    name: 'knowledge',
    args: {
      action: 'submit',
      params: { title: 'Feature coordinator ownership', content: { markdown: 'body '.repeat(80) } },
    },
  });

  function infoLines(spy: { mock: { calls: unknown[][] } }): string[] {
    return spy.mock.calls.map(([entry]) => String(entry));
  }

  it('drops the continuation of a compacted submit round while keeping reasoning and one diagnostic', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const window = new ContextWindow(48_000);
    window.appendUserMessage('submit');
    window.appendAssistantWithToolCalls(
      null,
      [{ ...submitCall('submit-1'), thoughtSignature: 'sig_call' } as never],
      'kept reasoning',
      continuationFor('submit-1', 'google', 'gemini-3-flash-preview')
    );
    const stored = window.toMessages()[1];
    expect(stored?.continuation).toBeUndefined();
    expect(stored?.reasoningContent).toBe('kept reasoning');
    expect(stored?.toolCalls?.[0]?.args).toMatchObject({ providerHistoryCompacted: true });
    // 签名绑定改写前的投影；没有续接后不能再随调用回传。
    expect(JSON.stringify(stored?.toolCalls)).not.toContain('sig_call');
    window.toProjectedMessages();
    window.estimateTokens();
    const dropped = [...infoLines(info), ...infoLines(warn)].filter((line) =>
      line.includes('continuation_dropped')
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('reason=compacted_args');
    expect(dropped[0]).toContain('provider=google');
    expect(dropped[0]).toContain('model=gemini-3-flash-preview');
    expect(dropped[0]).toContain('submit-1');
    expect(dropped[0]).not.toContain('kept reasoning');
    expect(dropped[0]).not.toContain('body body');
  });

  it.each([
    { label: 'non-knowledge tool', call: { id: 'lookup-1', name: 'lookup', args: { q: 'x' } } },
    {
      label: 'knowledge read action',
      call: { id: 'read-1', name: 'knowledge', args: { action: 'search', query: 'x' } },
    },
  ])('keeps the continuation when the $label args are not rewritten', ({ call }) => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const window = new ContextWindow(48_000);
    window.appendUserMessage('lookup');
    window.appendAssistantWithToolCalls(
      null,
      [{ ...call, thoughtSignature: 'sig_call' } as never],
      'kept reasoning',
      continuationFor(call.id)
    );
    const stored = window.toMessages()[1];
    expect(stored?.continuation).toMatchObject({ kind: 'content-replay-v1', provider: 'deepseek' });
    expect(JSON.stringify(stored?.toolCalls)).toContain('sig_call');
    expect(infoLines(info).join('\n')).not.toContain('continuation_dropped');
  });

  it('no longer counts a discarded continuation in the provider-visible token estimate', () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const withContinuation = new ContextWindow(48_000);
    const withoutContinuation = new ContextWindow(48_000);
    for (const window of [withContinuation, withoutContinuation]) {
      window.appendUserMessage('submit');
    }
    withContinuation.appendAssistantWithToolCalls(
      null,
      [submitCall('submit-1')],
      'kept reasoning',
      continuationFor('submit-1')
    );
    withoutContinuation.appendAssistantWithToolCalls(
      null,
      [submitCall('submit-1')],
      'kept reasoning'
    );
    expect(withContinuation.estimateTokens()).toBe(withoutContinuation.estimateTokens());
    // 发送面：没有续接时 DeepSeek 回传保留的 reasoningContent，与估算口径一致。
    const prompt = toSdkPrompt(
      withContinuation.toProjectedMessages() as Parameters<typeof toSdkPrompt>[0],
      undefined,
      'deepseek',
      'deepseek-v4-pro',
      'deepseek',
      'fixture-connection'
    );
    const assistant = prompt.find((entry) => entry.role === 'assistant');
    expect(assistant?.content).toContainEqual({ type: 'reasoning', text: 'kept reasoning' });
    expect(JSON.stringify(assistant?.content)).not.toContain('native reasoning');
  });
});

/**
 * L6-P14：压缩保留运行记忆与证据。
 * - C01：L4 记忆摘要位于 index 1，后续 L3 折叠不能把它折进 "[Collapsed: …]"；
 * - C02：L1 截断旧工具结果时保留 `[evidence] E-n=…` 尾注，且跨周期幂等；
 * - C03：provider 因 abort reject 时 compactL4 归为 cancelled，而不是 L4 失败；
 * - C07：snipHeadTail 收缩后 marker 中的省略字数等于实际省略量；
 * - C08：V1 结构化搜索结果末尾截断改为首+尾；单行超长文件内容退化为字符级首+尾截断。
 */
describe('compaction keeps runtime memory and evidence (L6-P14)', () => {
  const EVIDENCE_TAIL = /\n\n\[evidence\] [^\n]*$/;
  const evidenceAnnotation =
    '\n\n[evidence] E-12=src/agent/runtime/AgentRuntime.ts:10-80; E-13=src/agent/context/ContextWindow.ts:1-50';

  async function windowWithL4Summary(): Promise<ContextWindow> {
    const window = new ContextWindow(48_000, L4_ON);
    window.appendUserMessage('produce goal');
    window.appendAssistantWithToolCalls(null, [
      { id: 'early', name: 'code', args: { action: 'read' } },
    ]);
    window.appendToolResult('early', 'code', 'early observation');
    window.appendAssistantText('early reasoning');
    const result = await window.compactL4({
      chatWithTools: async () => ({ text: 'compacted summary' }),
    });
    expect(result.failed).not.toBe(true);
    expect(window.toMessages()[1]?.metadata?.kind).toBe('l4_memory_summary');
    return window;
  }

  function appendRounds(window: ContextWindow, rounds: number, from = 0) {
    for (let index = from; index < from + rounds; index++) {
      window.appendAssistantWithToolCalls(null, [
        { id: `round-${index}`, name: 'code', args: { action: 'read', index } },
      ]);
      window.appendToolResult(`round-${index}`, 'code', `round ${index} ${'y'.repeat(300)}`);
    }
  }

  it('C01 keeps the L4 memory summary in the projection after a provider-budget L3 collapse', async () => {
    const window = await windowWithL4Summary();
    appendRounds(window, 10);
    const info = vi.spyOn(Logger.getInstance(), 'info');

    // produce 阶段真实预算：20 条 / 12000 token；L4 后再追加 10 轮即超出消息数上限。
    const result = window.compactForProviderInputBudget({
      maxProjectedMessages: 20,
      maxProjectedTokens: 12_000,
      stageProfile: 'produce',
    });
    const projected = window.toProjectedMessages();

    expect(result.level).toBe(3);
    expect(projected[0]?.content).toBe('produce goal');
    expect(projected[1]?.metadata?.kind).toBe('l4_memory_summary');
    expect(String(projected[1]?.content)).toContain('[[L4 Memory Summary]]');
    // 折叠摘要只统计真正被折叠的工具轮次，记忆摘要不计入。
    expect(String(projected[2]?.content)).toContain('[Collapsed: 8 tool rounds, 8 results]');
    expect(projected.filter((m) => m.metadata?.kind === 'l4_memory_summary')).toHaveLength(1);
    expect(JSON.stringify(projected)).toContain('round 9');
    expect(result.afterMessageCount).toBe(projected.length);
    expect(
      info.mock.calls.some(([message]) =>
        String(message).includes(
          '1 runtime memory summary message(s) pinned ahead of the collapsed marker'
        )
      )
    ).toBe(true);
    // 正常折叠路径：compactionLog 同样写出 "钉在折叠 marker 之前"，且不会误报 "投影不变"。
    const compactionLog = window.getCompactionLog();
    expect(
      compactionLog.some((entry) =>
        entry.includes('1 runtime memory summary message(s) pinned ahead of the collapsed marker')
      )
    ).toBe(true);
    expect(compactionLog.some((entry) => entry.includes('projection unchanged'))).toBe(false);
  });

  it('C01 keeps the L4 memory summary when it is the only message before the collapse boundary', async () => {
    const window = await windowWithL4Summary();
    appendRounds(window, 2);
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const result = window.compactForProviderInputBudget({
      maxProjectedMessages: 3,
      maxProjectedTokens: 100_000,
    });
    const projected = window.toProjectedMessages();

    expect(result.level).toBe(3);
    expect(projected.some((m) => m.metadata?.kind === 'l4_memory_summary')).toBe(true);
    expect(JSON.stringify(projected)).toContain('round 0');
    expect(JSON.stringify(projected)).toContain('round 1');
    // 边界前只有被钉住的摘要：折叠不能让投影多出一条 "[Collapsed: 0 …]"。
    expect(projected).toHaveLength(window.toMessages().length);
    expect(JSON.stringify(projected)).not.toContain('[Collapsed:');
    // C041：这里实际走的是"投影原样返回"的短路，L3 诊断必须如实区分这条路径，
    // 不能再写"钉在折叠 marker 之前"（根本没有插入折叠 marker）。
    const infoLines = info.mock.calls.map(([message]) => String(message));
    const compactionLog = window.getCompactionLog();
    expect(infoLines.some((line) => line.includes('ahead of the collapsed marker'))).toBe(false);
    expect(compactionLog.some((entry) => entry.includes('ahead of the collapsed marker'))).toBe(
      false
    );
    const unchangedLog = infoLines.filter(
      (line) => line.includes('L3 collapse') && line.includes('projection unchanged')
    );
    expect(unchangedLog).toHaveLength(1);
    expect(unchangedLog[0]).toContain('1 runtime memory summary message(s)');
    expect(unchangedLog[0]).toContain('nothing to fold');
    expect(
      compactionLog.filter(
        (entry) => entry.startsWith('L3-collapse:') && entry.includes('projection unchanged')
      )
    ).toHaveLength(1);
  });

  it('C02 keeps the complete [evidence] tail when L1 snips an old tool result, idempotently', () => {
    const window = new ContextWindow(48_000);
    window.appendUserMessage('analyze prompt');
    // 走真实入口：先经 limitToolResult（正常档 6000 配额）写入，尾注此时完整。
    const raw = limitToolResult('code', `HEAD_SIGNAL\n${'x'.repeat(5000)}${evidenceAnnotation}`, {
      maxChars: 6000,
    });
    expect(raw.endsWith(evidenceAnnotation)).toBe(true);
    window.appendAssistantWithToolCalls(null, [{ id: 'old', name: 'code', args: {} }]);
    window.appendToolResult('old', 'code', raw);
    window.appendAssistantWithToolCalls(null, [{ id: 'new', name: 'code', args: {} }]);
    window.appendToolResult('new', 'code', 'short recent result');

    window.compactForProviderInputBudget({ maxProjectedMessages: 1, maxProjectedTokens: 1 });
    const afterFirst = window.toMessages().find((m) => m.toolCallId === 'old')?.content ?? '';
    expect(afterFirst).toContain('compaction snip');
    expect(afterFirst).toContain('HEAD_SIGNAL');
    expect(afterFirst.endsWith(evidenceAnnotation)).toBe(true);
    expect(EVIDENCE_TAIL.test(afterFirst)).toBe(true);
    expect(afterFirst.length).toBeLessThan(2000);

    for (let cycle = 0; cycle < 3; cycle++) {
      window.compactForProviderInputBudget({ maxProjectedMessages: 1, maxProjectedTokens: 1 });
    }
    const afterFourth = window.toMessages().find((m) => m.toolCallId === 'old')?.content ?? '';
    expect(afterFourth).toBe(afterFirst);
  });

  it('C02 keeps the [evidence] tail of the visible second-to-last round under a provider budget', () => {
    const window = new ContextWindow(48_000);
    window.appendUserMessage('record prompt');
    for (const id of ['r1', 'r2', 'r3']) {
      window.appendAssistantWithToolCalls(null, [{ id, name: 'code', args: { action: 'read' } }]);
      const annotation = id === 'r2' ? evidenceAnnotation : '';
      window.appendToolResult(id, 'code', `${id}:${'z'.repeat(5000)}${annotation}`);
    }

    const result = window.compactForProviderInputBudget({
      maxProjectedMessages: 4,
      maxProjectedTokens: 100_000,
      stageProfile: 'record',
    });
    const projected = window.toProjectedMessages();
    const r2 = projected.find((m) => m.toolCallId === 'r2');

    expect(result.level).toBe(3);
    expect(projected.some((m) => m.toolCallId === 'r1')).toBe(false);
    expect(String(r2?.content)).toContain('compaction snip');
    expect(String(r2?.content).endsWith(evidenceAnnotation)).toBe(true);
  });

  it('C02 caps a pathological evidence tail at 800 chars and stays under the L1 threshold', () => {
    const window = new ContextWindow(48_000);
    window.appendUserMessage('analyze prompt');
    const hugeAnnotation = `\n\n[evidence] ${'E-1=src/a.ts:1-2; '.repeat(200)}`.trimEnd();
    window.appendAssistantWithToolCalls(null, [{ id: 'old', name: 'code', args: {} }]);
    window.appendToolResult('old', 'code', `${'q'.repeat(3000)}${hugeAnnotation}`);
    window.appendAssistantWithToolCalls(null, [{ id: 'new', name: 'code', args: {} }]);
    window.appendToolResult('new', 'code', 'short recent result');

    window.compactForProviderInputBudget({ maxProjectedMessages: 1, maxProjectedTokens: 1 });
    const afterFirst = window.toMessages().find((m) => m.toolCallId === 'old')?.content ?? '';
    expect(afterFirst).toContain('[evidence] E-1=src/a.ts:1-2');
    expect(EVIDENCE_TAIL.test(afterFirst)).toBe(true);
    expect(afterFirst.length).toBeLessThan(2000);
    window.compactForProviderInputBudget({ maxProjectedMessages: 1, maxProjectedTokens: 1 });
    expect(window.toMessages().find((m) => m.toolCallId === 'old')?.content).toBe(afterFirst);
  });

  it('C03 reports cancelled when the provider rejects because the abort signal fired', async () => {
    const window = new ContextWindow(10_000, L4_ON);
    window.appendUserMessage('initial prompt');
    window.appendUserMessage('older context to compact');
    const before = structuredClone(window.toMessages());
    const abortController = new AbortController();
    const warn = vi.spyOn(Logger.getInstance(), 'warn');

    const result = await window.compactL4(
      {
        chatWithTools: vi.fn(async () => {
          abortController.abort();
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }),
      },
      { abortSignal: abortController.signal }
    );

    expect(result).toEqual({ level: 4, removed: 0, failed: true, cancelled: true });
    expect(window.toMessages()).toEqual(before);
    const lines = warn.mock.calls.map(([message]) => String(message));
    expect(lines.some((line) => line.includes('L4 compact cancelled during generation'))).toBe(
      true
    );
    expect(lines.some((line) => line.includes('L4 auto-compact failed'))).toBe(false);
  });

  it('C03 still reports a plain provider failure without cancelled', async () => {
    const window = new ContextWindow(10_000, L4_ON);
    window.appendUserMessage('initial prompt');
    window.appendUserMessage('older context to compact');
    const result = await window.compactL4(
      {
        chatWithTools: vi.fn(async () => {
          throw new Error('provider unavailable');
        }),
      },
      { abortSignal: new AbortController().signal }
    );
    expect(result).toEqual({ level: 4, removed: 0, failed: true });
  });

  function parseSnipMarker(out: string, tag: string) {
    const match = out.match(
      new RegExp(`\\n\\.\\.\\. \\[${tag}: (\\d+) of (\\d+) chars omitted\\] \\.\\.\\.\\n`)
    );
    expect(match).not.toBeNull();
    return {
      omitted: Number(match?.[1]),
      total: Number(match?.[2]),
      markerLength: match?.[0].length ?? 0,
    };
  }

  it.each([
    500, 200, 120, 80,
  ])('C07 marker omitted count equals the actually omitted chars at budget %i', (budget) => {
    const raw = `H${'a'.repeat(5103)}T`;
    const out = limitToolResult('shell', raw, { maxChars: budget });
    const { omitted, total, markerLength } = parseSnipMarker(out, 'tool-result snip');
    expect(total).toBe(raw.length);
    expect(omitted).toBe(raw.length - (out.length - markerLength));
    expect(out.length).toBeLessThanOrEqual(budget);
  });

  it('C07 L1 compaction marker reports the actually omitted chars', () => {
    const window = new ContextWindow(48_000);
    window.appendUserMessage('analyze prompt');
    const raw = `H${'b'.repeat(5103)}T`;
    window.appendAssistantWithToolCalls(null, [{ id: 'old', name: 'code', args: {} }]);
    window.appendToolResult('old', 'code', raw);
    window.appendAssistantWithToolCalls(null, [{ id: 'new', name: 'code', args: {} }]);
    window.appendToolResult('new', 'code', 'short recent result');
    window.compactForProviderInputBudget({ maxProjectedMessages: 1, maxProjectedTokens: 1 });
    const out = window.toMessages().find((m) => m.toolCallId === 'old')?.content ?? '';
    const { omitted, markerLength } = parseSnipMarker(out, 'compaction snip');
    expect(omitted).toBe(raw.length - (out.length - markerLength));
    expect(out.length).toBeLessThanOrEqual(500);
  });

  it('C08 snips an oversized V1 structured search result head+tail instead of head-only', () => {
    const input = {
      matches: Array.from({ length: 3 }, (_, line) => ({
        file: `src/f${line}.ts`,
        line,
        code: 'c'.repeat(400),
      })),
      total: 3,
      searchedFiles: 99,
    };
    const out = limitToolResult('code', input, { maxChars: 600, maxMatches: 15 });
    expect(out).toContain('tool-result snip');
    expect(out).not.toContain('[truncated]');
    expect(out).toContain('"searchedFiles":99}');
    expect(out.length).toBeLessThanOrEqual(600);
  });

  it('C08 degrades single-line oversized file content to char-level head+tail with a diagnostic', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const content = `HEAD_LINE_START${'m'.repeat(5000)}TAIL_LINE_END`;
    const out = limitToolResult('code', { content }, { maxChars: 600 });
    const parsed = JSON.parse(out) as { content: string };
    expect(parsed.content).toContain('HEAD_LINE_START');
    expect(parsed.content).toContain('TAIL_LINE_END');
    expect(parsed.content).toContain('tool-result snip');
    expect(parsed.content.length).toBeLessThanOrEqual(600);
    expect(
      info.mock.calls.some(([message]) =>
        String(message).includes('file content head+tail fell back to char-level snip')
      )
    ).toBe(true);
  });

  // C040：降级不能只看"首行"。空行/短首行之后紧跟一条超长行时，按整行切 head 只收到首行、
  // tail 收不到任何整行，正文与结尾一起丢失——与 C08 报告的症状相同，必须同样退化为字符级首+尾。
  it.each([
    {
      label: 'a blank first line',
      content: `\n${'m'.repeat(5000)}TAIL_LINE_END`,
      bodySnippet: 'mmmmmmmmmm',
      oversizedLine: 'line 2 of 2 (5013 chars)',
    },
    {
      label: 'a license line before one minified line',
      content: `/*! lib v1 | MIT */\n!function(e){${'var a=1;'.repeat(625)}}(TAIL_LINE_END);`,
      bodySnippet: '!function(e){var a=1;',
      oversizedLine: 'line 2 of 2 (5030 chars)',
    },
  ])('C08 degrades an oversized line after $label to char-level head+tail with a diagnostic', ({
    content,
    bodySnippet,
    oversizedLine,
  }) => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const out = limitToolResult('code', { content }, { maxChars: 600 });
    const parsed = JSON.parse(out) as { content: string };
    expect(parsed.content).toContain(bodySnippet);
    expect(parsed.content).toContain('TAIL_LINE_END');
    expect(parsed.content).toContain('tool-result snip');
    expect(parsed.content.length).toBeLessThanOrEqual(600);
    const fallbackLines = info.mock.calls
      .map(([message]) => String(message))
      .filter((line) => line.includes('file content head+tail fell back to char-level snip'));
    expect(fallbackLines).toHaveLength(1);
    expect(fallbackLines[0]).toContain(oversizedLine);
    expect(fallbackLines[0]).toContain('head budget 480');
  });

  it('C08 keeps the whole-line head+tail cut when no single line exceeds the head budget', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index} ${'z'.repeat(20)}`);
    const out = limitToolResult('code', { content: lines.join('\n') }, { maxChars: 600 });
    const parsed = JSON.parse(out) as { content: string };
    // 普通多行内容仍按整行切（A-1b 的刻意设计）：头尾都是完整行，marker 为 file content truncated。
    expect(parsed.content.startsWith('line 0 ')).toBe(true);
    expect(parsed.content).toContain('file content truncated');
    expect(parsed.content.endsWith(`line 59 ${'z'.repeat(20)}\n`)).toBe(true);
    expect(
      info.mock.calls.some(([message]) => String(message).includes('fell back to char-level snip'))
    ).toBe(false);
  });
});

/**
 * L6-P15：压缩信号、L4 开关与预算解析。
 * - C04：session 压力只启动压缩周期（入口融合用量，至少 L1），L2/L3 仍按投影用量升级——锁定该行为；
 * - C05：L4 唯一执行开关由 BudgetController 同步（syncL4CompactionSwitch），开关关闭时 compactL4
 *   短路并留 warn，不调用 provider、不改写历史；
 * - C06：resolveTokenBudget 在 env=auto、registry 命中、正则回退、默认值四条路径上的结果与日志：
 *   注册表命中只有 debug 轨迹，正则回退记 info，保守默认记 warn，均写出 providerHint、模型与路径。
 */
describe('compaction signals, L4 switch and token budget resolution (L6-P15)', () => {
  /** 构造投影接近预算的小窗口：needsL4Compaction 在开关打开时为 true。 */
  function saturatedWindow(compactionConfig?: { enableL4LLM?: boolean }): ContextWindow {
    const window = new ContextWindow(1_000, compactionConfig);
    window.appendUserMessage('initial analyze prompt');
    for (let index = 0; index < 4; index++) {
      window.appendAssistantWithToolCalls(null, [
        { id: `call-${index}`, name: 'code', args: { action: 'read', index } },
      ]);
      window.appendToolResult(`call-${index}`, 'code', `r${index}:${'x'.repeat(1900)}`);
    }
    window.compactIfNeeded();
    return window;
  }

  function loggedLines(spy: ReturnType<typeof vi.spyOn>, needle: string): string[] {
    return spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(needle));
  }

  it('C04 session pressure alone starts a cycle at L1 but does not escalate to L2/L3', () => {
    const window = new ContextWindow(100_000);
    window.appendUserMessage('analyze prompt');
    for (let index = 0; index < 4; index++) {
      window.appendAssistantWithToolCalls(null, [
        { id: `call-${index}`, name: 'code', args: { action: 'read', index } },
      ]);
      window.appendToolResult(`call-${index}`, 'code', `short result ${index}`);
    }
    window.appendAssistantText('first note');
    window.appendAssistantText('second note');
    const messageCount = window.toMessages().length;
    expect(window.getTokenUsageRatio()).toBeLessThan(0.05);

    // 融合用量 = max(投影 <0.05, 1 × 0.8) = 0.8，已越过 t2=0.70；但 L1 之后只看投影用量，
    // 所以 L2 合并（会把两条相邻 assistant 文本合成一条）和 L3 折叠都不会发生。
    window.setSessionPressure(1);
    expect(window.compactIfNeeded()).toEqual({ level: 1, removed: 0 });
    expect(window.toMessages()).toHaveLength(messageCount);
    expect(window.toProjectedMessages()).toHaveLength(messageCount);
  });

  it('C05 compactL4 short-circuits with an l4_disabled marker while the L4 switch is off', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn');
    const window = new ContextWindow(10_000);
    window.appendUserMessage('initial prompt');
    window.appendUserMessage('older context to compact');
    const before = structuredClone(window.toMessages());
    const chatWithTools = vi.fn(async () => ({ text: 'summary' }));

    const result = await window.compactL4({ chatWithTools });

    expect(result).toEqual({
      level: 4,
      removed: 0,
      failed: true,
      validationMissing: ['l4_disabled'],
    });
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(window.toMessages()).toEqual(before);
    expect(loggedLines(warn, 'L4 compact skipped: L4 switch is off')).toHaveLength(1);
  });

  it('C05 syncL4CompactionSwitch overrides CompactionConfig.enableL4LLM and logs only real changes', async () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const configuredOn = saturatedWindow({ enableL4LLM: true });
    expect(configuredOn.needsL4Compaction()).toBe(true);

    configuredOn.syncL4CompactionSwitch(false, 'unit-test');
    expect(configuredOn.needsL4Compaction()).toBe(false);
    configuredOn.syncL4CompactionSwitch(false, 'unit-test');
    const switchLines = loggedLines(info, 'L4 switch synced');
    expect(switchLines).toHaveLength(1);
    expect(switchLines[0]).toContain('enableL4LLM true->false');
    expect(switchLines[0]).toContain('source=unit-test');

    const configuredOff = saturatedWindow();
    expect(configuredOff.needsL4Compaction()).toBe(false);
    configuredOff.syncL4CompactionSwitch(true, 'unit-test');
    expect(configuredOff.needsL4Compaction()).toBe(true);
    const chatWithTools = vi.fn(async () => ({ text: 'compacted summary' }));
    const result = await configuredOff.compactL4({ chatWithTools });
    expect(chatWithTools).toHaveBeenCalledTimes(1);
    expect(result.failed).not.toBe(true);
    expect(result.removed).toBeGreaterThan(0);
  });

  describe('C06 resolveTokenBudget paths', () => {
    let debug: ReturnType<typeof vi.spyOn>;
    let info: ReturnType<typeof vi.spyOn>;
    let warn: ReturnType<typeof vi.spyOn>;

    function fallbackLines(): string[] {
      return [
        ...loggedLines(info, 'token_budget_fallback'),
        ...loggedLines(warn, 'token_budget_fallback'),
      ];
    }

    beforeEach(() => {
      vi.stubEnv('ALEMBIC_AI_PROVIDER', undefined);
      debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
      info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
      warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('env=auto resolves through the registry by apiModelId and only leaves the debug trace', () => {
      vi.stubEnv('ALEMBIC_AI_PROVIDER', 'auto');
      expect(ContextWindow.resolveTokenBudget('gemini-3-flash-preview', { isSystem: true })).toBe(
        48_000
      );
      const [trace] = loggedLines(debug, 'token_budget_source');
      expect(trace).toContain('source=registry');
      expect(trace).toContain('lookup=apiModelId');
      expect(trace).toContain('providerHint=auto');
      expect(fallbackLines()).toEqual([]);
    });

    it('a provider-scoped registry hit only leaves the debug trace', () => {
      expect(
        ContextWindow.resolveTokenBudget('gemini-3-flash-preview', { provider: 'google' })
      ).toBe(36_000);
      const [trace] = loggedLines(debug, 'token_budget_source');
      expect(trace).toContain('source=registry');
      expect(trace).toContain('lookup=provider');
      expect(trace).toContain('providerHint=google');
      expect(fallbackLines()).toEqual([]);
    });

    it('the regex fallback logs info with providerHint, model and the chosen path', () => {
      // gpt-4-0613 未登记：注册表落空 → 正则表 8_192 → 微窗口按 0.75 取整。
      expect(
        ContextWindow.resolveTokenBudget('gpt-4-0613', { isSystem: true, provider: 'openai' })
      ).toBe(6_144);
      const lines = loggedLines(info, 'token_budget_fallback');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('path=regex');
      expect(lines[0]).toContain('providerHint=openai');
      expect(lines[0]).toContain('lookup=provider');
      expect(lines[0]).toContain('model=gpt-4-0613');
      expect(lines[0]).toContain('contextWindow=8192');
      expect(loggedLines(warn, 'token_budget_fallback')).toEqual([]);
    });

    it('the conservative default warns for an unmatched or empty model name', () => {
      expect(ContextWindow.resolveTokenBudget('zzz-unlisted-model', { isSystem: true })).toBe(
        14_000
      );
      expect(ContextWindow.resolveTokenBudget('')).toBe(12_000);
      const lines = loggedLines(warn, 'token_budget_fallback');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('path=default');
      expect(lines[0]).toContain('model=zzz-unlisted-model');
      expect(lines[0]).toContain('providerHint=(none)');
      expect(lines[0]).toContain('contextWindow=32000');
      expect(lines[1]).toContain('path=default');
      expect(lines[1]).toContain('model=(empty)');
      expect(loggedLines(info, 'token_budget_fallback')).toEqual([]);
    });
  });
});
