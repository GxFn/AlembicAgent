import { describe, expect, it, vi } from 'vitest';
import { ContextWindow, limitToolResult } from '../src/agent/context/index.js';

describe('ContextWindow L4 compaction transcript safety', () => {
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
