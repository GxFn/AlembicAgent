/**
 * structuredOutput — LLM 结构化输出（JSON）提取与截断修复（纯函数）
 *
 * 背景：Provider 层（AiProvider）与 Gateway 层（LLMGateway）都需要从模型自由文本里
 * 稳健地抠出 JSON；历史上这套逻辑只存在于 AiProvider 内部，Gateway 的
 * chatStructured() 只做 chat() + JSON.parse()，模型多输出一句解释就解析失败。
 *
 * 当前策略：定位首个起始符与最后一个终止符之间的外层边界（不全局删除 markdown 围栏，
 * 避免破坏字符串字段里的原文）→ 字符串感知的尾逗号修复 → 解析失败时（仅数组模式）
 * 回收最后一个完整顶层条目之前的内容。厂商无关，供 Provider 与 Gateway 共用。
 *
 * 设计约束：
 *   - 不依赖实例状态；可选 onLog 只作观察，同步/异步失败不能改变恢复结果或递归报告。
 *   - 每个 null 出口和每次部分回收都打 warn，日志只含原因、起始符、长度、回收条数和
 *     丢弃字符数，绝不包含模型原文（原文可能含用户代码或敏感内容）。
 */

import { observeSafely } from '#shared/observers.js';

/** 结构化提取的日志回调；level 与现有 logger 对齐（info/warn/error）。 */
export type StructuredLogFn = (level: string, message: string) => void;

/**
 * 内部失败 / 回收原因（只进入日志，不进入返回值）：
 *   - empty：空文本
 *   - no_open_char：文本里没有起始符
 *   - boundary_invalid：首尾边界完整但无法解析（数组模式下回收也失败）
 *   - malformed_complete：数组结构已闭合但某个条目格式错误，只回收到坏条目之前
 *   - truncated：没有闭合边界（被 token 上限截断）；对象模式不做修复，直接失败
 *   - repair_failed：截断数组里找不到可回收的完整条目
 */
type ExtractReason =
  | 'empty'
  | 'no_open_char'
  | 'boundary_invalid'
  | 'malformed_complete'
  | 'truncated'
  | 'repair_failed';

/** 数组回收的内部上下文：调用方给出边界判断，回收过程累积诊断信息。 */
interface ArrayRepairContext {
  /** 是否存在 end > start 的闭合边界（extractJSON 常规路径已经尝试并失败）。 */
  readonly boundaryClosed: boolean;
  /** tryRepairAt 的 JSON.parse 尝试次数。 */
  attempts: number;
  /** 最近一次解析失败的错误类别（只记录错误名，V8 的 message 会带输入片段）。 */
  lastError?: string;
}

/**
 * 从 LLM 响应文本提取 JSON。
 * 支持截断修复：当 AI 输出被 token 限制截断时，回收已完成的数组条目。
 *
 * @param text   模型原始输出文本
 * @param openChar  JSON 边界起始符（对象用 '{'，数组用 '['）
 * @param closeChar JSON 边界终止符（对象用 '}'，数组用 ']'）
 * @param onLog   可选日志回调；尾逗号修复、数组部分回收与每个失败出口都会打 warn
 * @returns 解析后的 JSON 值；失败返回 null
 */
export function extractJSON(
  text: string,
  openChar = '{',
  closeChar = '}',
  onLog?: StructuredLogFn
): unknown {
  if (!text) {
    reportFailure(onLog, 'empty', openChar, 0);
    return null;
  }
  // 只截取 JSON 外层边界；全局删除围栏会破坏 markdown 等字符串字段中的原始内容。
  const start = text.indexOf(openChar);
  if (start === -1) {
    reportFailure(onLog, 'no_open_char', openChar, text.length);
    return null;
  }
  const end = text.lastIndexOf(closeChar);
  const boundaryClosed = end > start;
  let parseError: string | undefined;

  // 1. 常规路径：找到完整的 JSON 边界
  if (boundaryClosed) {
    try {
      const jsonStr = text.slice(start, end + 1);
      const repaired = stripTrailingCommas(jsonStr);
      const result: unknown = JSON.parse(repaired);
      if (repaired !== jsonStr) {
        observeSafely(
          () => onLog?.('warn', '[extractJSON] Repaired trailing commas outside JSON strings'),
          () => undefined
        );
      }
      return result;
    } catch (err: unknown) {
      // 常规解析失败：记录错误类别，交给下面的数组回收或失败诊断。
      parseError = describeParseError(err);
    }
  }

  // 2. 数组回收：截断或某个条目损坏时，尝试回收已完成的条目（仅数组）
  if (openChar === '[') {
    const context: ArrayRepairContext = { boundaryClosed, attempts: 0 };
    const recovered = repairArray(text.slice(start), context, onLog);
    if (recovered) {
      return recovered;
    }
    // 有闭合边界却连回收都失败，说明边界本身不是 JSON（例如前置说明里的方括号）。
    reportFailure(
      onLog,
      boundaryClosed ? 'boundary_invalid' : 'repair_failed',
      openChar,
      text.length,
      parseError ?? context.lastError,
      context.attempts
    );
    return null;
  }
  // 对象模式不做截断修复：有边界则是边界无效，无边界则是被截断。
  reportFailure(
    onLog,
    boundaryClosed ? 'boundary_invalid' : 'truncated',
    openChar,
    text.length,
    parseError
  );
  return null;
}

/** 只保留错误类别；JSON.parse 的 message 会引用输入片段，不能进入日志。 */
function describeParseError(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** 失败出口统一诊断：经 observeSafely 隔离观察者异常，日志不含模型原文。 */
function reportFailure(
  onLog: StructuredLogFn | undefined,
  reason: ExtractReason,
  openChar: string,
  length: number,
  error?: string,
  attempts?: number
): void {
  const details = [
    `reason=${reason}`,
    `open=${openChar}`,
    `length=${length}`,
    ...(error ? [`error=${error}`] : []),
    ...(attempts !== undefined ? [`attempts=${attempts}`] : []),
  ].join(' ');
  observeSafely(
    () => onLog?.('warn', `[extractJSON] parse_failed ${details}`),
    () => undefined
  );
}

/** 仅修复结构分隔符；字符串内的逗号、括号、转义引号和代码围栏都是模型原文。 */
function stripTrailingCommas(text: string): string {
  let inString = false;
  let escaped = false;
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === ',') {
      let next = index + 1;
      while (next < text.length && /\s/u.test(text[next])) {
        next++;
      }
      if (text[next] === '}' || text[next] === ']') {
        continue;
      }
    }
    result += char;
  }
  return result;
}

/**
 * 修复被截断的 JSON 数组 — 回收已完成的对象。
 * 策略 1（主路径）：字符级深度追踪，找到最后一个完整的顶层 {...} 对象。
 * 策略 2（回退路径）：正则 + 渐进 JSON.parse（应对代码段中未转义引号导致 inString 追踪失效）。
 *
 * 直接调用时没有外层边界信息，按“截断”归类；回收失败会打 reason=repair_failed 的 warn。
 */
export function repairTruncatedArray(text: string, onLog?: StructuredLogFn): unknown[] | null {
  const context: ArrayRepairContext = { boundaryClosed: false, attempts: 0 };
  const result = repairArray(text, context, onLog);
  if (!result) {
    reportFailure(onLog, 'repair_failed', '[', text.length, context.lastError, context.attempts);
  }
  return result;
}

/** 数组回收内部入口：携带边界上下文，回收成功时按原因打 warn；失败由调用方报告。 */
function repairArray(
  text: string,
  context: ArrayRepairContext,
  onLog?: StructuredLogFn
): unknown[] | null {
  // ── 策略 1：字符级深度追踪 ──
  const scan = scanTopLevelObjects(text);
  // 闭合符可能只出现在字符串里（例如 "literal, ]" 之后被截断）：此时 end > start
  // 但扫描深度没有回到 0，仍按截断归类。未转义引号会让扫描深度失真，这只影响日志原因，
  // 不影响返回值。
  const reason: ExtractReason =
    context.boundaryClosed && scan.finalDepth <= 0 ? 'malformed_complete' : 'truncated';
  if (scan.lastCompleteObjEnd !== -1) {
    const charResult = tryRepairAt(text, scan.lastCompleteObjEnd, reason, context, onLog);
    if (charResult) {
      return charResult;
    }
  }

  // ── 策略 2：正则回退 ──
  return repairByRegexFallback(text, reason, context, onLog);
}

/** 字符级深度追踪（处理标准 JSON）：返回最后一个完整顶层对象的结束位置与扫描结束时的深度。 */
function scanTopLevelObjects(text: string): { lastCompleteObjEnd: number; finalDepth: number } {
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let lastCompleteObjEnd = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      isEscaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      // depth === 1 表示回到数组顶层，刚关闭了一个完整对象
      if (depth === 1 && ch === '}') {
        lastCompleteObjEnd = i;
      }
    }
  }

  return { lastCompleteObjEnd, finalDepth: depth };
}

/**
 * 正则回退修复 — 不依赖 inString 追踪。
 * 寻找所有可能的对象边界，从后往前尝试 JSON.parse。
 */
function repairByRegexFallback(
  text: string,
  reason: ExtractReason,
  context: ArrayRepairContext,
  onLog?: StructuredLogFn
): unknown[] | null {
  // 收集所有 "}" 后跟 "," 或空白的位置（可能是对象边界）
  const candidates: number[] = [];
  const re = /\}[\s,]*(?=\s*[[{]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    candidates.push(m.index); // "}" 的位置
  }

  // 从后往前尝试
  for (let i = candidates.length - 1; i >= 0; i--) {
    const result = tryRepairAt(text, candidates[i], reason, context, onLog);
    if (result) {
      return result;
    }
  }
  return null;
}

/** 在指定位置截断并尝试闭合 JSON 数组；成功时报告原因、回收条数与丢弃字符数。 */
function tryRepairAt(
  text: string,
  endPos: number,
  reason: ExtractReason,
  context: ArrayRepairContext,
  onLog?: StructuredLogFn
): unknown[] | null {
  const repaired = stripTrailingCommas(`${text.slice(0, endPos + 1)}]`);
  context.attempts++;

  try {
    const result: unknown = JSON.parse(repaired);
    if (Array.isArray(result) && result.length > 0) {
      // droppedChars：回收点之后被丢弃的字符数（相对起始符切片，含边界后的说明文字）。
      const droppedChars = text.length - (endPos + 1);
      observeSafely(
        () =>
          onLog?.(
            'warn',
            `[extractJSON] Repaired JSON array: reason=${reason} recoveredItems=${result.length} droppedChars=${droppedChars}`
          ),
        () => undefined
      );
      return result;
    }
  } catch (err: unknown) {
    // 该位置无法闭合成合法数组，继续尝试下一个候选；只记录错误类别供失败诊断使用。
    context.lastError = describeParseError(err);
  }
  return null;
}
