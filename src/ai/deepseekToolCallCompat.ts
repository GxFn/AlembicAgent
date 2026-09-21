import type { FunctionCallResult } from './contracts.js';

const INVOKE_RE = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
const PARAM_RE = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
const DECLARATION_BOUNDARY_RE =
  /^[ \t]*(`{3,}|~{3,})|<function_calls(?:\s+[^>]*)?>|<\/function_calls\s*>/gm;

/** 声明之外的代码围栏是样例；声明内部的围栏则属于参数正文，不能删改。 */
function* declaredCallBlocks(text: string): Generator<string> {
  let fence: string | null = null;
  let depth = 0;
  let start = 0;
  let nested = false;
  for (const boundary of text.matchAll(DECLARATION_BOUNDARY_RE)) {
    const marker = boundary[1];
    if (marker) {
      if (depth > 0) {
        continue;
      }
      if (!fence) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        const lineEnd = text.indexOf('\n', boundary.index);
        const suffix = text.slice(
          boundary.index + boundary[0].length,
          lineEnd < 0 ? text.length : lineEnd
        );
        if (!suffix.trim()) {
          fence = null;
        }
      }
      continue;
    }
    if (fence) {
      continue;
    }
    if (boundary[0].startsWith('</')) {
      if (depth > 0) {
        depth--;
        if (depth === 0 && !nested) {
          yield text.slice(start, boundary.index);
        }
      }
    } else {
      if (depth === 0) {
        start = boundary.index + boundary[0].length;
        nested = false;
      } else {
        nested = true;
      }
      depth++;
    }
  }
}

/**
 * DeepSeek V4 有时会把工具调用写成 `<function_calls>` 文本，而不是
 * Chat Completions 原生 tool_calls。这里是兼容桥，不代表 native tool call
 * 闭环已经成立；调用方必须通过 call id / 日志把 compat 路径和 native 路径
 * 区分开，避免再用 memoryFindings 反推真实产出方式。
 *
 * 只有调用方已经声明 allowed tools 时才转译；未知工具名一律丢弃，
 * 避免执行普通分析文本。
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
  for (const block of declaredCallBlocks(text)) {
    for (const match of block.matchAll(INVOKE_RE)) {
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
