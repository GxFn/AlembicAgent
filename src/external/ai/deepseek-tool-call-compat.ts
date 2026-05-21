import type { FunctionCallResult } from './AiProvider.js';

const INVOKE_RE = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
const PARAM_RE = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;

/**
 * DeepSeek V4 在极少数 tool_choice 场景会把工具调用写成文本。
 * 这里只在调用方已经声明 allowed tools 时，把明确的 `<function_calls>` 文本
 * 转回真实 tool call；未知工具名一律丢弃，避免执行普通分析文本。
 */
export function parseDeepSeekTextToolCalls(
  text: string | null | undefined,
  allowedToolNames: string[] | undefined
): FunctionCallResult[] {
  if (!text || !text.includes('<function_calls') || !allowedToolNames?.length) {
    return [];
  }

  const allowed = new Set(allowedToolNames);
  const calls: FunctionCallResult[] = [];
  for (const match of text.matchAll(INVOKE_RE)) {
    const name = match[1]?.trim();
    if (!name || !allowed.has(name)) {
      continue;
    }

    calls.push({
      id: `call_deepseek_compat_${calls.length + 1}`,
      name,
      args: parseParams(match[2] || ''),
    });
  }
  return calls;
}

function parseParams(block: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const match of block.matchAll(PARAM_RE)) {
    const key = match[1]?.trim();
    if (!key) {
      continue;
    }
    args[key] = parseValue(unescapeXml((match[2] || '').trim()));
  }
  return args;
}

function parseValue(value: string): unknown {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value === 'null') {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
