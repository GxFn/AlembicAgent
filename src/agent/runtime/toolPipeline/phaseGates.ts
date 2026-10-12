/** 场景动作约束：Evolution、record-only（record repair 与 Analyst RECORD）、Analyst VERIFY 与 Producer；不拥有路由与记账。 */
import {
  getToolAction,
  getToolParams,
  isDirectNoteFindingCall,
  type RecordOnlyStageTrigger,
  resolveRecordOnlyStageTrigger,
} from './callNormalization.js';
import type {
  BeforeVerdict,
  ToolCall,
  ToolPipelineContext as ToolExecContext,
} from './contracts.js';

/**
 * EvolutionDecisionGate — Evolution retry 决策补写阶段的动作级守卫。
 *
 * allowlist 只能限制到工具名（knowledge），但 retry 阶段需要更硬的约束：
 * 只允许 knowledge.manage(evolve/deprecate/skip_evolution)，禁止继续 search/detail/read。
 */
export const evolutionDecisionGate = {
  name: 'evolutionDecisionGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    if (ctx.loopCtx.sharedState?._evolutionDecisionOnly !== true) {
      return undefined;
    }

    const params = (call.args?.params as Record<string, unknown> | undefined) ?? call.args ?? {};
    const action = String(call.args?.action || '');
    const operation = String(params.operation || '');
    const allowedOperation =
      operation === 'evolve' || operation === 'deprecate' || operation === 'skip_evolution';

    if (call.name === 'knowledge' && action === 'manage' && allowedOperation && params.id) {
      return undefined;
    }

    return {
      blocked: true,
      result: {
        error:
          'Evolution retry is decision-only. Call knowledge({ action: "manage", params: { operation: "evolve|deprecate|skip_evolution", id, reason, data? } }) for each pending Recipe; search/detail/code/graph are disabled.',
      },
    };
  },
};

const RECORD_REPAIR_MEMORY_ACTIONS = new Set(['note_finding', 'recall', 'get_previous_evidence']);

const ANALYST_VERIFY_CODE_ACTIONS = new Set(['read', 'outline']);

const ANALYST_VERIFY_MEMORY_ACTIONS = new Set(['note_finding', 'recall', 'get_previous_evidence']);

/** E4：证据台账只读 action——查已采证据不是探索，RECORD/VERIFY 相放行 */
const EVIDENCE_READ_ACTIONS = new Set(['get', 'search']);

const ANALYST_VERIFY_GRAPH_QUERY_TYPES = new Set([
  'class',
  'protocol',
  'hierarchy',
  'callers',
  'callees',
  'overrides',
  'extensions',
  'impact',
]);

/**
 * 聚焦实体判定与 graph handler 对齐：handler 只从 params.entity 读取非空字符串，
 * symbol/name/path 不是 graph.query 的入参，门放行它们只会让 handler 返回 requires entity。
 * getToolParams 在没有嵌套 params 时返回扁平 args，所以扁平 call.args.entity 也由这里覆盖；
 * 嵌套 params 之外另挂的 entity 到不了 handler，不算聚焦实体。
 */
function hasFocusedGraphEntity(params: Record<string, unknown>): boolean {
  return typeof params.entity === 'string' && params.entity.trim().length > 0;
}

// Producer 不开放 code：GenerateProduce 能力白名单不含 code，阶段提示也禁止读取源文件；
// 若在这里放行或推荐 code.read，模型照做后只会被 allowlistGate 再拦一次、白耗一轮。
const PRODUCER_KNOWLEDGE_ACTIONS = new Set(['submit']);

const PRODUCER_MEMORY_ACTIONS = new Set(['recall']);

const PRODUCER_META_ACTIONS = new Set(['review']);

const RECORD_ONLY_ALLOWED_SURFACE =
  'is note_finding-only (plus read-only evidence.get/search). Use note_finding({ finding, evidenceRefs, importance }) to record verified findings; code/graph/terminal/knowledge and memory.save are disabled.';

/**
 * 阻断文案同时进入模型可见结果与 diagnostics.blockedTools（engine 以 error 作为 reason），
 * 因此在末尾写明命中的 record-only 触发谓词，宿主能区分 record_repair 微阶段与 analyst RECORD 相。
 */
function recordOnlyBlockedError(trigger: RecordOnlyStageTrigger): string {
  const subject = trigger === 'analyst RECORD phase' ? 'Analyst RECORD' : 'Record repair';
  return `${subject} ${RECORD_ONLY_ALLOWED_SURFACE} (record-only stage trigger: ${trigger})`;
}

/**
 * RecordRepairOnlyGate — record-only 阶段（QualityGate record_repair 微阶段与 analyst RECORD 相）的动作级守卫。
 *
 * record-only 阶段只能把既有分析证据补写进 memory，不允许继续探索、运行终端、提交知识或写入普通
 * memory.save。是否处于 record-only 由 resolveRecordOnlyStageTrigger 单源判定（I06），与
 * AgentRuntime 的 schema 广告面（note_finding + evidence）保持一致：广告面收窄的轮次，执行门同样收窄，
 * 不再只依赖上游 provider 的工具名校验兜底。
 */
export const recordRepairOnlyGate = {
  name: 'recordRepairOnlyGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    const trigger = resolveRecordOnlyStageTrigger(ctx.loopCtx);
    if (!trigger) {
      return undefined;
    }

    const action = getToolAction(call);
    if (
      isDirectNoteFindingCall(call) ||
      (call.name === 'memory' && RECORD_REPAIR_MEMORY_ACTIONS.has(action)) ||
      (call.name === 'evidence' && EVIDENCE_READ_ACTIONS.has(action))
    ) {
      return undefined;
    }

    // 阻断原因（含触发谓词）由执行引擎统一写入 diagnostics.blockedTools。
    return {
      blocked: true,
      result: { error: recordOnlyBlockedError(trigger) },
    };
  },
};

/**
 * AnalystVerifyOnlyGate — analyst VERIFY 阶段的动作级守卫。
 *
 * VERIFY 只确认已发现证据的路径/行号/符号/调用关系，不允许重新打开
 * 泛搜索、终端执行或知识提交面。
 */
export const analystVerifyOnlyGate = {
  name: 'analystVerifyOnlyGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    if (
      ctx.loopCtx.tracker?.pipelineType !== 'analyst' ||
      ctx.loopCtx.tracker?.phase !== 'VERIFY'
    ) {
      return undefined;
    }

    const action = getToolAction(call);
    const params = getToolParams(call);

    if (call.name === 'code' && ANALYST_VERIFY_CODE_ACTIONS.has(action)) {
      return undefined;
    }

    if (call.name === 'evidence' && EVIDENCE_READ_ACTIONS.has(action)) {
      return undefined;
    }

    if (
      isDirectNoteFindingCall(call) ||
      (call.name === 'memory' && ANALYST_VERIFY_MEMORY_ACTIONS.has(action))
    ) {
      return undefined;
    }

    if (call.name === 'graph' && action === 'query') {
      const queryType = String(params.type ?? call.args?.type ?? '');
      if (ANALYST_VERIFY_GRAPH_QUERY_TYPES.has(queryType) && hasFocusedGraphEntity(params)) {
        return undefined;
      }
    }

    // 阻断原因（含 graph 缺少 entity）由执行引擎统一写入 diagnostics.blockedTools。
    return {
      blocked: true,
      result: {
        error:
          'Analyst VERIFY is evidence-only. Use code.read/code.outline, focused graph.query(class|protocol|hierarchy|callers|callees|overrides|extensions|impact with entity), or note_finding / memory.recall / memory.get_previous_evidence; broad search, terminal, knowledge, and unrelated writes are disabled.',
      },
    };
  },
};

/**
 * ProducerSubmitOnlyGate — Producer 阶段只允许推进候选覆盖率的动作。
 *
 * Package Q 暴露了一个失败路径：成功提交 1 个候选后，模型继续调用
 * knowledge.detail / meta.tools 消耗轮次，触发 idle 退出并丢失剩余结构化发现。
 */
export const producerSubmitOnlyGate = {
  name: 'producerSubmitOnlyGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    if (ctx.loopCtx.tracker?.pipelineType !== 'producer') {
      return undefined;
    }

    const phase = ctx.loopCtx.tracker?.phase;
    const action = getToolAction(call);

    if (phase === 'SUMMARIZE') {
      return {
        blocked: true,
        result: {
          error:
            'Producer is already in SUMMARIZE. Tool calls are disabled; output the production summary only.',
        },
      };
    }

    if (phase !== 'PRODUCE') {
      return undefined;
    }

    if (call.name === 'evidence' && EVIDENCE_READ_ACTIONS.has(action)) {
      return undefined;
    }

    if (call.name === 'knowledge' && PRODUCER_KNOWLEDGE_ACTIONS.has(action)) {
      return undefined;
    }
    if (call.name === 'memory' && PRODUCER_MEMORY_ACTIONS.has(action)) {
      return undefined;
    }
    if (call.name === 'meta' && PRODUCER_META_ACTIONS.has(action)) {
      return undefined;
    }

    return {
      blocked: true,
      result: {
        error:
          'Producer phase is submit-first. Allowed actions: knowledge.submit, evidence.get/evidence.search for already captured evidence, memory.recall, and meta.review. Do not call knowledge.detail, meta.tools, meta.plan, source reads, search, graph, terminal, or broad exploration; continue submitting remaining structured findings.',
      },
    };
  },
};
