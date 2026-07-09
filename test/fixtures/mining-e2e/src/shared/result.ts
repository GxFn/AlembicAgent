/**
 * mining-e2e fixture — shared Result envelope.
 * 埋点约定：所有 handler 的返回值必须经 wrapResult 包装(统一错误语义)，
 * E2E 期望挖掘 Agent 从三个 handler 文件中发现该约定并产出 rule 候选。
 */
export interface Result<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

export function wrapResult<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, data: fn(), error: null };
  } catch (err: unknown) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}
