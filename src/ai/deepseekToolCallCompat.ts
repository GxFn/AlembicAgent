import type { FunctionCallResult } from './contracts.js';
import { TEXT_COMPAT_CALL_ID_PREFIX } from './registry/ModelQuirks.js';

const INVOKE_RE = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
const PARAM_RE = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
const DECLARATION_BOUNDARY_RE =
  /^[ \t]*(`{3,}|~{3,})|<function_calls(?:\s+[^>]*)?>|<\/function_calls\s*>/gm;

/**
 * 兼容桥内部诊断：只描述被有意丢弃或跳过的声明结构，不含参数正文。
 * 丢弃本身是既定行为（未知工具名、未闭合、嵌套、围栏样例、块外 invoke 都不转译），
 * 这里只让调用方能区分“模型没调工具”和“调了但被兼容桥丢弃”。
 */
export interface DeepSeekTextToolCallDiagnostics {
  /** 围栏外、已闭合、未嵌套、实际参与转译的声明块数量。 */
  declaredBlocks: number;
  /** 声明块内工具名不在 allowed 列表而被丢弃的名字（去重、保持首次出现顺序）。 */
  droppedUnknownNames: string[];
  /** 文本结束时仍有未闭合的 `<function_calls>`（常见于输出预算截断，或行内提及打开了外层块）。 */
  unclosedBlock: boolean;
  /** 因内部再次出现 `<function_calls>` 而整体跳过的已闭合外层块数量。 */
  nestedBlocksSkipped: number;
}

export interface DeepSeekTextToolCallInspection {
  calls: FunctionCallResult[];
  diagnostics: DeepSeekTextToolCallDiagnostics;
}

interface DeclarationScan {
  blocks: string[];
  unclosedBlock: boolean;
  nestedBlocksSkipped: number;
}

/**
 * 声明之外的代码围栏是样例；声明内部的围栏则属于参数正文，不能删改。
 * 扫描规则与转译结果保持既有行为，只额外汇总未闭合与嵌套跳过的情况供诊断使用。
 */
function scanDeclaredCallBlocks(text: string): DeclarationScan {
  const blocks: string[] = [];
  let nestedBlocksSkipped = 0;
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
        if (depth === 0) {
          if (nested) {
            // 嵌套声明无法判定哪一层是真实调用，整块不转译（既定行为），只计数供诊断。
            nestedBlocksSkipped++;
          } else {
            blocks.push(text.slice(start, boundary.index));
          }
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
  return { blocks, unclosedBlock: depth > 0, nestedBlocksSkipped };
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
  return inspectDeepSeekTextToolCalls(text, allowedToolNames).calls;
}

/**
 * 与 parseDeepSeekTextToolCalls 同一转译规则，额外返回丢弃诊断（仅内部使用）。
 * 文本不含声明标记或调用方未声明 allowed tools 时不进入兼容桥，诊断为空。
 */
export function inspectDeepSeekTextToolCalls(
  text: string | null | undefined,
  allowedToolNames: string[] | undefined
): DeepSeekTextToolCallInspection {
  const calls: FunctionCallResult[] = [];
  const diagnostics: DeepSeekTextToolCallDiagnostics = {
    declaredBlocks: 0,
    droppedUnknownNames: [],
    unclosedBlock: false,
    nestedBlocksSkipped: 0,
  };
  if (!text || !text.includes('<function_calls') || !allowedToolNames?.length) {
    return { calls, diagnostics };
  }

  const allowed = new Set(allowedToolNames);
  const dropped = new Set<string>();
  const scan = scanDeclaredCallBlocks(text);
  diagnostics.declaredBlocks = scan.blocks.length;
  diagnostics.unclosedBlock = scan.unclosedBlock;
  diagnostics.nestedBlocksSkipped = scan.nestedBlocksSkipped;
  for (const block of scan.blocks) {
    for (const match of block.matchAll(INVOKE_RE)) {
      const name = match[1]?.trim() ?? '';
      if (!name || !allowed.has(name)) {
        // 未知（含空白）工具名不转译，避免执行普通分析文本；只记名字，不记参数正文。
        dropped.add(name);
        continue;
      }

      calls.push({
        // 前缀与 AgentRuntime 的来源判定(isTextCompatToolCallId)同源，兼容转译不会被当成原生 tool_calls。
        id: `${TEXT_COMPAT_CALL_ID_PREFIX}${calls.length + 1}`,
        name,
        args: parseParams(match[2] || ''),
      });
    }
  }
  diagnostics.droppedUnknownNames = [...dropped];
  return { calls, diagnostics };
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
