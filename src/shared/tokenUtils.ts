export function estimateTokens(text: string) {
  if (!text) {
    return 0;
  }
  let tokens = 0;
  for (const ch of text) {
    tokens += ch.charCodeAt(0) > 0x2e80 ? 0.5 : 0.25;
  }
  return Math.ceil(tokens);
}

export function estimateTokensFast(text: string) {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 3.5);
}

/** 按共同 token 估算口径裁剪，保留 Unicode 字符并把说明本身计入预算。 */
export function truncateToTokenBudget(
  text: string,
  tokenBudget: number,
  suffix = '\n…(truncated due to budget)'
): string {
  if (tokenBudget === Infinity || estimateTokens(text) <= tokenBudget) {
    return text;
  }
  const budget = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : 0;
  const footer = estimateTokens(suffix) <= budget ? suffix : '';
  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(chars.slice(0, mid).join('') + footer) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return chars.slice(0, low).join('') + footer;
}
