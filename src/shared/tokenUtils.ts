import { observeSafely } from '#shared/observers.js';

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

/** 截断诊断回调；与 shared/structuredOutput 的 StructuredLogFn 同形（level 对齐 logger）。 */
export type TokenBudgetLogFn = (level: 'warn', message: string) => void;

/** 完整说明放不下时的最短截断标记，按 estimateTokens 口径只占 1 token。 */
const MINIMAL_TRUNCATION_MARK = '…';

/**
 * 按共同 token 估算口径裁剪，保留 Unicode 字符并把说明本身计入预算。
 *
 * 标记保底：被裁剪的结果一定带截断标记，或者整段为空。无标记的残片会被模型当作
 * 一条完整消息（例如 ConversationStore 在余量只剩几 token 时裁剪最近一条消息），
 * 所以完整 suffix 放不下时退化为 '…'，连 1 token 都放不下时返回空串。
 *
 * 非法预算：NaN / -Infinity 不抛错。SessionStore.buildContextForDimension 是公开入口，
 * 宿主传入的 tokenBudget 未经校验直达这里，抛错会把一次记忆投影变成运行失败；因此按 0
 * 处理（返回空串），并经 onLog 报告 reason=invalid_budget，日志只含预算值与长度，不含正文。
 */
export function truncateToTokenBudget(
  text: string,
  tokenBudget: number,
  suffix = '\n…(truncated due to budget)',
  onLog?: TokenBudgetLogFn
): string {
  if (tokenBudget === Infinity || estimateTokens(text) <= tokenBudget) {
    return text;
  }
  if (!Number.isFinite(tokenBudget)) {
    reportInvalidBudget(onLog, tokenBudget, text.length);
  }
  const budget = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : 0;
  const footer = pickTruncationFooter(suffix, budget);
  if (footer === null) {
    // 连最短标记都放不下：宁可整段省略，也不交出无标记残片。
    return '';
  }
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

/** 优先使用调用方的完整说明；放不下时退化为 '…'；仍放不下返回 null 表示只能输出空串。 */
function pickTruncationFooter(suffix: string, budget: number): string | null {
  if (estimateTokens(suffix) <= budget) {
    return suffix;
  }
  if (estimateTokens(MINIMAL_TRUNCATION_MARK) <= budget) {
    return MINIMAL_TRUNCATION_MARK;
  }
  return null;
}

/** 非法预算诊断：经 observeSafely 隔离日志回调异常，诊断失败不能升级为裁剪失败。 */
function reportInvalidBudget(
  onLog: TokenBudgetLogFn | undefined,
  tokenBudget: number,
  length: number
): void {
  observeSafely(
    () =>
      onLog?.(
        'warn',
        `[truncateToTokenBudget] reason=invalid_budget budget=${String(tokenBudget)} length=${length} fallback=empty`
      ),
    () => undefined
  );
}
