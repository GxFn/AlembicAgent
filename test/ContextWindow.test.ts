import { describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';

describe('ContextWindow L4 compaction transcript safety', () => {
  it('normalizes a recent slice that starts with an orphan tool message', async () => {
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

    expect(result).toMatchObject({ level: 4, removed: 1 });
    expect(aiProvider.chatWithTools).toHaveBeenCalledTimes(1);
    expect(sentMessages.at(-1)?.content).toContain('请将以下对话历史压缩');
    expect(sentMessages[0].role).not.toBe('tool');
    expect(sentMessages.some((message) => message.role === 'tool')).toBe(false);
    expect(contextWindow.toMessages().some((message) => message.role === 'tool')).toBe(false);
  });

  it('does not preserve assistant tool calls when their tool results were sliced away', async () => {
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
  });
});
