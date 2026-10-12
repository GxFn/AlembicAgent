/** 只记录真实持久化提交及覆盖信息；不执行提交、内容修复或权限决策。 */
import { isPersistedSubmission, readToolObservation } from '../../utils/toolOutcomes.js';
import type {
  ToolCall,
  ToolPipelineContext as ToolExecContext,
  ToolLoopPort,
  ToolMetadata,
} from './contracts.js';

/**
 * Producer 台账条目只保留有读取者的字段：LLMInputAssembly 的 projectProducerSubmitLedger /
 * formatProducerLedgerEntry 只读 status/title/requiredFieldsComplete/payloadStored/sourceCount。
 * readiness 的事实来源是会话盒里的 recipeReadinessReports，不在这里重复写第二份；
 * 后续若新增读取者，先在读取侧落地再补字段，不预留无人消费的副本。
 */
interface ProducerSubmitLedgerEntry {
  payloadStored: true;
  requiredFieldsComplete: boolean;
  sourceCount: number;
  /** 只在 isPersistedSubmission 之后写入，Core 已确认 created，因此恒为 created。 */
  status: 'created';
  title: string;
}

interface ProducerSubmitLedger {
  /** 台账只登记已创建条目（同名替换），创建数就是条目数。 */
  createdCount: number;
  entries: ProducerSubmitLedgerEntry[];
  targetSubmits?: number;
}
interface ProducerSharedState {
  _producerSubmitLedger?: ProducerSubmitLedger;
}

/*
 * 代码指纹与 AlembicCore src/domain/knowledge/recipe-authoring-spec/gateRules.ts 的
 * codeFingerprint、PATTERN_FLOOR(30)、CODE_FINGERPRINT_FLOOR(20) 同源（UnifiedValidator 的
 * recordSubmission / #checkUniqueness 使用同一函数与阈值）。submitDedup 登记的指纹必须与 Core
 * 判重时计算的指纹逐字相等，否则跨提交的代码重复检测会静默失效。
 * Core 稳定门面 @alembic/core/knowledge 目前只导出阈值（getStage3FieldPolicy），未导出
 * codeFingerprint，本层 layer-contract 也不允许直接依赖 Core；因此暂用同源副本，并由
 * test/EvidenceCapture.test.ts 的固定样例向量与 Core 公开 UnifiedValidator 对拍锁定。
 * 清理条件：Core 在稳定门面导出 codeFingerprint 后改为导入，阈值改取 getStage3FieldPolicy()。
 */
const PATTERN_FLOOR = 30;
const CODE_FINGERPRINT_FLOOR = 20;

/** 去行注释、块注释与全部空白，转小写后取前 200 字符（与 Core codeFingerprint 逐字一致）。 */
function codeFingerprint(code: string): string {
  return (code || '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/[\s]+/g, '')
    .toLowerCase()
    .slice(0, 200);
}

/**
 * SubmitTracker — 提交状态登记
 *
 * 不在 Runtime 层提前拦截 knowledge.submit。所有字段校验、唯一性检查、
 * 相似度检测和融合决策都必须进入 RecipeProductionGateway 统一处理。
 *
 * after: 宿主共享的 submittedTitles/Triggers/Patterns 的唯一登记者（I25）。只在 Core 确认
 * 创建（isPersistedSubmission）后登记标题/trigger/指纹，供后续 Gateway 校验使用；
 * knowledge.submit 交给 Core 的是这些 Set 的副本，Core 校验器的批内登记不会回写这里，
 * 所以 rejected/blocked/merged/duplicates 等未落库去向不会占用标题、trigger 或指纹。
 */
export const submitDedup = {
  name: 'submitDedup',

  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    if (meta.blocked || call.name !== 'knowledge') {
      return;
    }
    const action = String(call.args?.action || '');
    if (action !== 'submit') {
      return;
    }

    const observed = { ...call, result, envelope: meta.envelope };
    if (!isPersistedSubmission(observed)) {
      return;
    }
    const resultObj = readToolObservation(observed).result;

    // V2 args structure: { action: "submit", params: { title, ... } }
    const params = (call.args?.params as Record<string, unknown>) ?? call.args ?? {};
    const title = String(params.title || params.category || '');
    const normalizedTitle = title.toLowerCase().trim();
    if (!normalizedTitle) {
      return;
    }
    recordProducerSubmitLedger(call, resultObj || {}, ctx);
    const { sharedState } = ctx.loopCtx;
    if (!sharedState?.submittedTitles) {
      meta.isSubmit = true;
      return;
    }

    // 提交成功 — 注册标题/trigger/指纹以防后续重复（与 Core recordSubmission 同口径：小写 + trim）。
    sharedState.submittedTitles.add(normalizedTitle);
    // Core 判重比较的是写入前的 effectiveItem 标题；风格修复（STAGE3_TITLE_TOO_GENERIC）可能已改名，
    // 改名本身由 knowledge.submit 记日志。Core 不再回写共享 Set 后，这里同时登记 Core 回执里的
    // 落库标题，保持修复前「模型原标题 + 实际落库标题」都被占用的去重覆盖。
    const persistedTitle =
      typeof resultObj.title === 'string' ? resultObj.title.toLowerCase().trim() : '';
    if (persistedTitle && persistedTitle !== normalizedTitle) {
      sharedState.submittedTitles.add(persistedTitle);
    }

    // trigger 与 content.pattern 在 Agent 侧准备阶段不被改写，模型参数即 Core 实际判重的值。
    const trigger = String(params.trigger || '')
      .toLowerCase()
      .trim();
    if (trigger && sharedState.submittedTriggers) {
      sharedState.submittedTriggers.add(trigger);
    }

    const contentObj = params.content as Record<string, unknown> | undefined;
    const pattern = String(contentObj?.pattern || '');
    if (pattern.length >= PATTERN_FLOOR && sharedState.submittedPatterns) {
      const fp = codeFingerprint(pattern);
      if (fp.length >= CODE_FINGERPRINT_FLOOR) {
        sharedState.submittedPatterns.add(fp);
      }
    }
    meta.isSubmit = true;
  },
};

function recordProducerSubmitLedger(
  call: ToolCall,
  result: Record<string, unknown>,
  ctx: ToolExecContext
) {
  if (!isProducerLoop(ctx.loopCtx)) {
    return;
  }
  const shared = (ctx.loopCtx.sharedState ??= {}) as ProducerSharedState;
  const targetSubmits = numberValue(ctx.loopCtx.budget?.targetSubmits);
  const ledger = (shared._producerSubmitLedger ??= {
    createdCount: 0,
    entries: [] as ProducerSubmitLedgerEntry[],
    ...(targetSubmits != null ? { targetSubmits } : {}),
  });
  const params = (call.args?.params as Record<string, unknown>) ?? call.args ?? {};
  const title = String(result.title || params.title || params.category || '').trim();
  if (!title) {
    return;
  }
  const entry: ProducerSubmitLedgerEntry = {
    payloadStored: true,
    requiredFieldsComplete: hasCompleteSubmitPayload(params),
    sourceCount: submitSourceCount(params),
    status: 'created',
    title,
  };
  const existingIndex = ledger.entries.findIndex(
    (item) => item.title.toLowerCase().trim() === title.toLowerCase()
  );
  if (existingIndex >= 0) {
    ledger.entries[existingIndex] = entry;
  } else {
    ledger.entries.push(entry);
  }
  ledger.createdCount = ledger.entries.length;
}

function isProducerLoop(loopCtx: ToolLoopPort): boolean {
  return (
    loopCtx.tracker?.pipelineType === 'producer' ||
    loopCtx.context?.pipelinePhase === 'produce' ||
    loopCtx.context?.pipelinePhase === 'producer'
  );
}

function hasCompleteSubmitPayload(params: Record<string, unknown>): boolean {
  const content = params.content as Record<string, unknown> | undefined;
  const reasoning = params.reasoning as Record<string, unknown> | undefined;
  const sources = Array.isArray(reasoning?.sources) ? reasoning.sources : [];
  const evidenceRefs = Array.isArray(reasoning?.evidenceRefs) ? reasoning.evidenceRefs : [];
  return Boolean(
    stringValue(params.title) &&
      stringValue(params.description) &&
      stringValue(params.kind) &&
      stringValue(params.trigger) &&
      stringValue(params.whenClause) &&
      stringValue(params.doClause) &&
      stringValue(content?.markdown) &&
      stringValue(content?.rationale) &&
      [...sources, ...evidenceRefs].some((source) => typeof source === 'string' && source.trim())
  );
}

function submitSourceCount(params: Record<string, unknown>): number {
  const reasoning = params.reasoning as Record<string, unknown> | undefined;
  const sources = Array.isArray(reasoning?.sources) ? reasoning.sources : [];
  const evidenceRefs = Array.isArray(reasoning?.evidenceRefs) ? reasoning.evidenceRefs : [];
  const refs = sources.length > 0 ? sources : evidenceRefs;
  return refs.filter((source) => typeof source === 'string' && source.trim()).length;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
