/**
 * Chat Completions tool transcript normalization.
 *
 * OpenAI-compatible APIs require every `tool` message to answer a preceding
 * assistant message with matching `tool_calls`. Context slicing can break that
 * invariant, so callers can normalize incomplete rounds into plain text.
 */

type MessageRecord = Record<string, unknown>;

export interface ToolTranscriptNormalizationResult {
  messages: MessageRecord[];
  normalizedCount: number;
}

function toolCallsOf(message: MessageRecord): MessageRecord[] {
  const raw = message.tool_calls ?? message.toolCalls;
  return Array.isArray(raw) ? (raw as MessageRecord[]) : [];
}

function toolCallIdOf(message: MessageRecord): string {
  return String(message.tool_call_id ?? message.toolCallId ?? '');
}

function toolCallNameOf(call: MessageRecord): string {
  const fn =
    call.function && typeof call.function === 'object' ? (call.function as MessageRecord) : {};
  return String(fn.name ?? call.name ?? 'tool');
}

function toolCallArgsOf(call: MessageRecord): string {
  const fn =
    call.function && typeof call.function === 'object' ? (call.function as MessageRecord) : {};
  const args = fn.arguments ?? call.args ?? {};
  if (typeof args === 'string') {
    return args;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

function cloneWithoutToolCalls(message: MessageRecord): MessageRecord {
  const clone = { ...message };
  delete clone.tool_calls;
  delete clone.toolCalls;
  delete clone.reasoning_content;
  delete clone.reasoningContent;
  return clone;
}

function assistantToolCallsAsText(message: MessageRecord): MessageRecord {
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  const calls = toolCallsOf(message).map((call) => {
    const id = String(call.id ?? '');
    const name = toolCallNameOf(call);
    const args = truncate(toolCallArgsOf(call), 800);
    return `- ${name}${id ? ` (${id})` : ''}: ${args}`;
  });
  return {
    ...cloneWithoutToolCalls(message),
    role: 'assistant',
    content: [content, '[tool calls converted to text]', ...calls].filter(Boolean).join('\n'),
  };
}

function toolResultAsUserMessage(message: MessageRecord): MessageRecord {
  const id = toolCallIdOf(message);
  const name = String(message.name ?? 'tool');
  const content =
    typeof message.content === 'string' ? message.content : String(message.content ?? '');
  return {
    role: 'user',
    content: `[tool result converted to text: ${name}${id ? `/${id}` : ''}]\n${truncate(content, 4000)}`,
  };
}

function isCompleteImmediateToolRound(
  assistant: MessageRecord,
  toolMessages: MessageRecord[]
): boolean {
  const expectedIds = toolCallsOf(assistant)
    .map((call) => String(call.id ?? ''))
    .filter(Boolean);
  if (expectedIds.length === 0 || toolMessages.length === 0) {
    return false;
  }

  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  for (const toolMessage of toolMessages) {
    const id = toolCallIdOf(toolMessage);
    if (!id || !expected.has(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  return seen.size === expected.size;
}

/**
 * Preserve complete assistant(tool_calls)+tool-result rounds. Convert orphan or
 * incomplete tool transcript pieces into plain text so Chat Completions payloads
 * remain valid after context slicing.
 */
export function normalizeToolTranscriptForChatCompletions(
  messages: readonly MessageRecord[],
  opts: { forceToolFree?: boolean } = {}
): ToolTranscriptNormalizationResult {
  const normalized: MessageRecord[] = [];
  let normalizedCount = 0;

  for (let index = 0; index < messages.length; ) {
    const message = messages[index] || {};
    const role = String(message.role || '');
    const calls = toolCallsOf(message);

    if (role === 'assistant' && calls.length > 0) {
      const toolMessages: MessageRecord[] = [];
      let cursor = index + 1;
      while (cursor < messages.length && String(messages[cursor]?.role || '') === 'tool') {
        toolMessages.push(messages[cursor] as MessageRecord);
        cursor++;
      }

      if (!opts.forceToolFree && isCompleteImmediateToolRound(message, toolMessages)) {
        normalized.push({ ...message }, ...toolMessages.map((toolMessage) => ({ ...toolMessage })));
      } else {
        normalized.push(assistantToolCallsAsText(message));
        normalized.push(...toolMessages.map((toolMessage) => toolResultAsUserMessage(toolMessage)));
        normalizedCount += 1 + toolMessages.length;
      }
      index = cursor;
      continue;
    }

    if (role === 'tool') {
      normalized.push(toolResultAsUserMessage(message));
      normalizedCount++;
      index++;
      continue;
    }

    normalized.push({ ...message });
    index++;
  }

  return { messages: normalized, normalizedCount };
}
