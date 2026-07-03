/**
 * @module tools/runtime/handlers/evidence
 *
 * evidence 工具（Wave A E4）——证据台账只读查询。
 * Actions: get, search
 *
 * 查已采证据不是探索：RECORD/VERIFY/produce 相均可用，为引用修正与 verbatim 取回
 * 提供自救通道（真机事故的结构性缺口之一：producer 被拒后无粮草可修）。
 * 只读、零文件系统访问；台账缺席（非维度运行）时显式失败而非静默空结果。
 */
import { fail, ok, type ToolContext, type ToolResult } from '#tools/kernel/registry.js';

/** 单次 get 取回的行数预算——超限保头截断并提示用子区间缩小范围 */
export const EVIDENCE_GET_MAX_LINES = 120;

const SEARCH_LIMIT_MAX = 8;

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const ledger = ctx.runtime?.evidenceLedger;
  if (!ledger) {
    return fail('evidence 工具仅在维度运行（证据台账在场）时可用');
  }

  if (action === 'get') {
    const ref = typeof params.ref === 'string' ? params.ref.trim() : '';
    if (!ref) {
      return fail('evidence.get requires "ref" param, e.g. "E-3" or "E-3@5-12"');
    }
    const entry = ledger.get(ref);
    if (!entry) {
      const recent = ledger
        .listRecent(3)
        .map((item) => (item.file ? `${item.id}=${item.file}` : item.id))
        .join('; ');
      return fail(
        `evidence.get 无法解析 "${ref}"（只能引用 [evidence] 标注过的条目 id）。近期条目: ${recent || '(台账为空)'}`
      );
    }
    const lines = entry.content.split('\n');
    const capped = lines.length > EVIDENCE_GET_MAX_LINES;
    const content = capped
      ? `${lines.slice(0, EVIDENCE_GET_MAX_LINES - 1).join('\n')}\n…[capped at ${EVIDENCE_GET_MAX_LINES} lines — narrow with "${entry.id}@start-end"]`
      : entry.content;
    return ok({
      id: entry.id,
      ...(entry.file ? { file: entry.file } : {}),
      ...(entry.range ? { range: entry.range } : {}),
      lineCount: lines.length,
      capped,
      content,
    });
  }

  if (action === 'search') {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) {
      return fail('evidence.search requires "query" param (path fragment or content keyword)');
    }
    const rawLimit = typeof params.limit === 'number' ? params.limit : SEARCH_LIMIT_MAX;
    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(rawLimit)));
    const items = ledger.search(query, limit).map((entry) => {
      const firstLine = entry.content.split('\n', 1)[0] ?? '';
      return {
        id: entry.id,
        ...(entry.file ? { file: entry.file } : {}),
        ...(entry.range ? { range: entry.range } : {}),
        preview: firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine,
      };
    });
    return ok({ count: items.length, items });
  }

  return fail(`unknown evidence action: ${action}`);
}
