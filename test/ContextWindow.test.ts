import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('ContextWindow L4 compaction transcript safety', () => {
  it.each([
    'append',
    'reset',
    'overlap',
  ])('does not overwrite newer context after L4 %s', async (change) => {
    const window = new ContextWindow();
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
    const contextWindow = new ContextWindow(10_000);
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
    const contextWindow = new ContextWindow(10_000);
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
    const contextWindow = new ContextWindow(10_000);
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
    const contextWindow = new ContextWindow(10_000);
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

afterEach(() => vi.restoreAllMocks());
function deferred<T>() {
  return Promise.withResolvers<T>();
}
function withCreated(history: string) {
  const context = new ContextWindow(48_000, { thresholds: [0, 0, 0, 0, 100] });
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
    const context = new ContextWindow();
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
    const context = new ContextWindow();
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
