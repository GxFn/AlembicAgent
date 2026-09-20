/** 场景动作约束：Evolution、record repair、Analyst VERIFY 与 Producer；不拥有路由与记账。 */
import { getToolAction, getToolParams, isDirectNoteFindingCall } from './callNormalization.js';
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

const PRODUCER_CODE_ACTIONS = new Set(['read']);

const PRODUCER_KNOWLEDGE_ACTIONS = new Set(['submit']);

const PRODUCER_MEMORY_ACTIONS = new Set(['recall']);

const PRODUCER_META_ACTIONS = new Set(['review']);

/**
 * RecordRepairOnlyGate — QualityGate record_repair 阶段的动作级守卫。
 *
 * record_repair 只能把既有分析证据补写进 memory，不允许继续探索、
 * 运行终端、提交知识或写入普通 memory.save。
 */
export const recordRepairOnlyGate = {
  name: 'recordRepairOnlyGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    if (ctx.loopCtx.sharedState?._recordRepairOnly !== true) {
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

    return {
      blocked: true,
      result: {
        error:
          'Record repair is note_finding-only (plus read-only evidence.get/search). Use note_finding({ finding, evidenceRefs, importance }) to record verified findings; code/graph/terminal/knowledge and memory.save are disabled.',
      },
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
      const hasFocusedEntity = Boolean(
        params.entity || params.symbol || params.name || params.path || call.args?.entity
      );
      if (ANALYST_VERIFY_GRAPH_QUERY_TYPES.has(queryType) && hasFocusedEntity) {
        return undefined;
      }
    }

    return {
      blocked: true,
      result: {
        error:
          'Analyst VERIFY is evidence-only. Use code.read/code.outline, focused graph.query(class|protocol|hierarchy|callers|callees|overrides|extensions|impact with entity/path), or note_finding / memory.recall / memory.get_previous_evidence; broad search, terminal, knowledge, and unrelated writes are disabled.',
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
    if (call.name === 'code' && PRODUCER_CODE_ACTIONS.has(action)) {
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
          'Producer phase is submit-first. Allowed actions: knowledge.submit, code.read for missing short snippets, memory.recall, and meta.review. Do not call knowledge.detail, meta.tools, meta.plan, search, graph, terminal, or broad exploration; continue submitting remaining structured findings.',
      },
    };
  },
};
