/**
 * @module tools/runtime/compressor/strip
 *
 * 文本清理工具: ANSI 控制字符去除 + 连续重复行折叠。
 * 用于终端输出的显示清理；需要真实计数的解析器先消费未折叠的行集合。
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require matching control characters
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** 去除 ANSI 控制字符 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * 折叠连续重复行。
 * 例如: 10 行 "." → 第一行 + "(repeated 9 times)"
 */
export function collapseRepeats(text: string, threshold = 3): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let prevLine = '';
  let repeatCount = 0;

  for (const line of lines) {
    if (line === prevLine) {
      repeatCount++;
    } else {
      if (repeatCount >= threshold) {
        result.push(`  (repeated ${repeatCount} times)`);
      } else {
        for (let i = 0; i < repeatCount; i++) {
          result.push(prevLine);
        }
      }
      result.push(line);
      prevLine = line;
      repeatCount = 0;
    }
  }

  if (repeatCount >= threshold) {
    result.push(`  (repeated ${repeatCount} times)`);
  } else {
    for (let i = 0; i < repeatCount; i++) {
      result.push(prevLine);
    }
  }

  return result.join('\n');
}

/**
 * 通用截断：头尾片段和提示共用字符预算。长单行也必须留下有用内容，不能只返回提示。
 */
export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const budget = Number.isNaN(maxChars) ? 0 : Math.max(0, Math.floor(maxChars));
  if (budget === 0) {
    return '';
  }
  const marker = '\n… [output truncated] …\n';
  if (budget <= marker.length) {
    return `${text.slice(0, budget - 1).replace(/[\uD800-\uDBFF]$/u, '')}…`;
  }
  const available = budget - marker.length;
  const headLength = Math.ceil(available * 0.8);
  const tailLength = available - headLength;
  // 不留下截断产生的孤立UTF-16代理半字；字符预算仍以上界约束。
  const head = text.slice(0, headLength).replace(/[\uD800-\uDBFF]$/u, '');
  const tail = tailLength > 0 ? text.slice(-tailLength).replace(/^[\uDC00-\uDFFF]/u, '') : '';
  return `${head}${marker}${tail}`;
}

/** 完整清理流水线: stripAnsi → collapseRepeats */
export function cleanOutput(text: string): string {
  return collapseRepeats(stripAnsi(text));
}
