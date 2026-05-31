import { describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';

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
