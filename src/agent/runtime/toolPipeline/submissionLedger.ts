/** 只记录真实持久化提交及覆盖信息；不执行提交、内容修复或权限决策。 */
import { isPersistedSubmission, readToolObservation } from '../../utils/toolOutcomes.js';
import type {
  ToolCall,
  ToolPipelineContext as ToolExecContext,
  ToolLoopPort,
  ToolMetadata,
} from './contracts.js';

interface ProducerSubmitLedgerEntry {
  codeEvidence?: {
    accepted: boolean;
    provenanceRef?: string;
    reason: string;
  };
  id?: string;
  lifecycle?: string;
  payloadStored: boolean;
  production?: { capability?: string; source?: string };
  readiness?: {
    ready: boolean;
    violationCodes: string[];
    warningCodes: string[];
  };
  retrievalProfilePresent: boolean;
  requiredFieldsComplete: boolean;
  sourceCount: number;
  status: string;
  title: string;
  trigger?: string;
}

interface ProducerSubmitLedger {
  createdCount: number;
  entries: ProducerSubmitLedgerEntry[];
  targetSubmits?: number;
}
interface ProducerSharedState {
  _producerSubmitLedger?: ProducerSubmitLedger;
}
/**
 * SubmitTracker — 提交状态登记
 *
 * 不在 Runtime 层提前拦截 knowledge.submit。所有字段校验、唯一性检查、
 * 相似度检测和融合决策都必须进入 RecipeProductionGateway 统一处理。
 *
 * after: 仅在提交真正创建后登记标题/trigger/指纹，供后续 Gateway 校验使用。
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

    // 提交成功 — 注册标题/trigger/指纹以防后续重复
    sharedState.submittedTitles.add(normalizedTitle);

    const trigger = String(params.trigger || '')
      .toLowerCase()
      .trim();
    if (trigger && sharedState.submittedTriggers) {
      sharedState.submittedTriggers.add(trigger);
    }

    const contentObj = params.content as Record<string, unknown> | undefined;
    const pattern = String(contentObj?.pattern || '');
    if (pattern.length >= 30 && sharedState.submittedPatterns) {
      const fp = pattern
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/[\s]+/g, '')
        .toLowerCase()
        .slice(0, 200);
      if (fp.length >= 20) {
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
  const readiness =
    result.readiness && typeof result.readiness === 'object'
      ? (result.readiness as Record<string, unknown>)
      : null;
  const violations = Array.isArray(readiness?.violations) ? readiness.violations : [];
  const warnings = Array.isArray(readiness?.warnings) ? readiness.warnings : [];
  const production =
    result.production && typeof result.production === 'object'
      ? (result.production as Record<string, unknown>)
      : null;
  const codeEvidence =
    result.codeEvidence && typeof result.codeEvidence === 'object'
      ? (result.codeEvidence as Record<string, unknown>)
      : null;
  const codeEvidenceProvenanceRef = stringValue(codeEvidence?.provenanceRef);
  const title = String(result.title || params.title || params.category || '').trim();
  if (!title) {
    return;
  }
  const entry: ProducerSubmitLedgerEntry = {
    ...(typeof result.id === 'string' ? { id: result.id } : {}),
    ...(typeof result.lifecycle === 'string' ? { lifecycle: result.lifecycle } : {}),
    payloadStored: true,
    ...(codeEvidence
      ? {
          codeEvidence: {
            accepted: codeEvidence.accepted === true,
            reason: stringValue(codeEvidence.reason) || 'unknown',
            ...(codeEvidenceProvenanceRef ? { provenanceRef: codeEvidenceProvenanceRef } : {}),
          },
        }
      : {}),
    ...(production
      ? {
          production: {
            capability: stringValue(production.capability) || undefined,
            source: stringValue(production.source) || undefined,
          },
        }
      : {}),
    ...(readiness
      ? {
          readiness: {
            ready: readiness.ready === true,
            violationCodes: violations
              .map((entry) => stringValue((entry as Record<string, unknown>)?.code))
              .filter(Boolean),
            warningCodes: warnings
              .map((entry) => stringValue((entry as Record<string, unknown>)?.code))
              .filter(Boolean),
          },
        }
      : {}),
    retrievalProfilePresent:
      !!params.retrievalProfile && typeof params.retrievalProfile === 'object',
    requiredFieldsComplete: hasCompleteSubmitPayload(params),
    sourceCount: submitSourceCount(params),
    status: String(result.status || 'created'),
    title,
    ...(typeof params.trigger === 'string' && params.trigger.trim()
      ? { trigger: params.trigger.trim() }
      : {}),
  };
  const existingIndex = ledger.entries.findIndex(
    (item) => item.title.toLowerCase().trim() === title.toLowerCase()
  );
  if (existingIndex >= 0) {
    ledger.entries[existingIndex] = entry;
  } else {
    ledger.entries.push(entry);
  }
  ledger.createdCount = ledger.entries.filter((entry) => entry.status === 'created').length;
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
