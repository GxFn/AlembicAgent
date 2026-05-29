/**
 * structured-output — LLM 结构化输出（JSON）提取与截断修复（纯函数）
 *
 * 背景：Provider 层（AiProvider）与 Gateway 层（LLMGateway）都需要从模型自由文本里
 * 稳健地抠出 JSON；历史上这套逻辑只存在于 AiProvider 内部，Gateway 的
 * chatStructured() 只做 chat() + JSON.parse()，模型多输出一句解释就解析失败。
 *
 * 本模块把这套「去 markdown 围栏 → 定位边界 → 容错解析 → 截断修复」逻辑抽成
 * 厂商无关的纯函数，供 Provider 与 Gateway 共用，避免两套实现继续漂移。
 *
 * 设计约束：
 *   - 纯函数：不依赖任何实例状态；唯一副作用通过可选 onLog 回调外抛，便于测试。
 *   - 行为等价：从 AiProvider.extractJSON / _repairTruncatedArray 系列逐字迁移，
 *     不改变任何解析策略，保证既有调用方行为不变。
 */

/** 结构化提取的日志回调；level 与现有 logger 对齐（info/warn/error）。 */
export type StructuredLogFn = (level: string, message: string) => void;

/**
 * 从 LLM 响应文本提取 JSON。
 * 支持截断修复：当 AI 输出被 token 限制截断时，尝试关闭未完成的 JSON 结构。
 *
 * @param text   模型原始输出文本
 * @param openChar  JSON 边界起始符（对象用 '{'，数组用 '['）
 * @param closeChar JSON 边界终止符（对象用 '}'，数组用 ']'）
 * @param onLog   可选日志回调（截断修复成功时打印 warn）
 * @returns 解析后的 JSON 值；失败返回 null
 */
export function extractJSON(
  text: string,
  openChar = '{',
  closeChar = '}',
  onLog?: StructuredLogFn
): unknown {
  if (!text) {
    return null;
  }
  // 去除 markdown 代码块围栏
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf(openChar);
  if (start === -1) {
    return null;
  }
  const end = cleaned.lastIndexOf(closeChar);

  // 1. 常规路径：找到完整的 JSON 边界
  if (end > start) {
    try {
      let jsonStr = cleaned.slice(start, end + 1);
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(jsonStr);
    } catch {
      // 常规解析失败，尝试截断修复
    }
  }

  // 2. 截断修复：AI 输出被 token 限制截断，尝试回收已完成的条目（仅数组）
  if (openChar === '[') {
    return repairTruncatedArray(cleaned.slice(start), onLog);
  }
  return null;
}

/**
 * 修复被截断的 JSON 数组 — 回收已完成的对象。
 * 策略 1（主路径）：字符级深度追踪，找到最后一个完整的顶层 {...} 对象。
 * 策略 2（回退路径）：正则 + 渐进 JSON.parse（应对代码段中未转义引号导致 inString 追踪失效）。
 */
export function repairTruncatedArray(text: string, onLog?: StructuredLogFn): unknown[] | null {
  // ── 策略 1：字符级深度追踪 ──
  const charResult = repairByCharTracking(text, onLog);
  if (charResult) {
    return charResult;
  }

  // ── 策略 2：正则回退 ──
  const regexResult = repairByRegexFallback(text, onLog);
  if (regexResult) {
    return regexResult;
  }

  return null;
}

/** 字符级深度追踪修复（处理标准 JSON）。 */
function repairByCharTracking(text: string, onLog?: StructuredLogFn): unknown[] | null {
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

  if (lastCompleteObjEnd === -1) {
    return null;
  }
  return tryRepairAt(text, lastCompleteObjEnd, onLog);
}

/**
 * 正则回退修复 — 不依赖 inString 追踪。
 * 寻找所有可能的对象边界，从后往前尝试 JSON.parse。
 */
function repairByRegexFallback(text: string, onLog?: StructuredLogFn): unknown[] | null {
  // 收集所有 "}" 后跟 "," 或空白的位置（可能是对象边界）
  const candidates: number[] = [];
  const re = /\}[\s,]*(?=\s*[[{]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    candidates.push(m.index); // "}" 的位置
  }

  // 从后往前尝试
  for (let i = candidates.length - 1; i >= 0; i--) {
    const result = tryRepairAt(text, candidates[i], onLog);
    if (result) {
      return result;
    }
  }
  return null;
}

/** 在指定位置截断并尝试闭合 JSON 数组。 */
function tryRepairAt(text: string, endPos: number, onLog?: StructuredLogFn): unknown[] | null {
  let repaired = text.slice(0, endPos + 1);
  // 去掉尾逗号
  repaired = repaired.replace(/,\s*$/, '');
  repaired += ']';
  // 修复尾逗号（对象/数组末尾多余逗号）
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  try {
    const result = JSON.parse(repaired);
    if (Array.isArray(result) && result.length > 0) {
      onLog?.(
        'warn',
        `[extractJSON] Repaired truncated JSON array: recovered ${result.length} items from truncated response`
      );
      return result;
    }
  } catch {
    /* this position didn't work, try next */
  }
  return null;
}
