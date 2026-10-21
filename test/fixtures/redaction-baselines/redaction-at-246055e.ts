/**
 * 开发者可见文本脱敏 — 单源工具（Wave A E1 自 AgentRuntime 私有函数迁出，行为字节不变）。
 *
 * 消费方：LLM 工件留痕（AgentRuntime）、证据台账落盘（EvidenceLedgerStore 注入）。
 * 规则集中在此一处：API key / Google key / Bearer token / 键值对形态的
 * api_key|token|secret|password|authorization。新增规则时全部消费方同步生效。
 */
export function redactDeveloperText(text: string): string {
  return text
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-google-api-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted-token]')
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
      '$1[redacted]'
    );
}
