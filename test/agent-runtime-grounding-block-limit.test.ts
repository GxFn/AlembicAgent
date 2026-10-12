/**
 * analyze grounding guard 连续阻断上限（I38 / L5-P10）。
 *
 * 背景：groundingEnforcement='guard' 且模型属 DeepSeek V4 家族时，analyze 文本轮的 invalid-no-evidence
 * 分类会被阻断 + nudge + rollbackTick。阻断本身没有上限时，一个持续只输出无证据文本的模型会让 tracker
 * 轮次永远停在原地（每次阻断都回滚 tick），循环只能靠 stage 超时 / token 预算 / 外部 abort 结束，
 * 期间每轮都是一次完整 LLM 调用。
 *
 * 本文件锁定修复后的行为：
 * - 连续阻断上限为 2：第 1、2 次 invalid-no-evidence 文本轮照旧阻断；
 * - 第 3 次（同一连续段内）不再 rollbackTick，记 warn 诊断 grounding_block_limit_reached 后按普通文本轮放行；
 * - 非阻断轮（合规文本轮、工具轮）把连续计数清零；
 * - 默认 off 不受影响。
 */
import { describe, expect, it, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/index.js';
import { AgentRuntime } from '../src/agent/runtime/index.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';

const MODEL_REF = 'deepseek:deepseek-v4-flash';
const BLOCK_LIMIT = 2;
// 安全阀：修复前 guard 路径没有上限，靠外部 abort 才能结束；测试用它把 RED 变成有限失败而不是挂起。
const ABORT_AFTER_CALLS = 30;

const NO_EVIDENCE_TEXT = 'I can already conclude the architecture shape from general context.';
const PLANNING_TEXT =
  'Planning-only: use deterministic evidence src/known.ts:10 to decide the next read before asserting facts.';

type ScriptedReply = { kind: 'no-evidence' } | { kind: 'planning' } | { kind: 'tool' };

interface WarningLike {
  code: string;
  message: string;
  stage?: string;
}

function textReply(text: string) {
  return { text, functionCalls: [], usage: { inputTokens: 2, outputTokens: 1 } };
}

function toolReply(callIndex: number) {
  return {
    text: null,
    functionCalls: [
      {
        id: `call_code_${callIndex}`,
        name: 'code',
        args: { action: 'read', params: { filePaths: ['src/known.ts'] } },
      },
    ],
    usage: { inputTokens: 2, outputTokens: 1 },
  };
}

function createToolEnvelope(text: string): ToolResultEnvelope {
  return {
    ok: true,
    toolId: 'code',
    callId: 'tool-call-1',
    startedAt: new Date().toISOString(),
    durationMs: 3,
    status: 'success',
    text,
    structuredContent: { path: 'src/known.ts', sourceRefs: ['src/known.ts:10'] },
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

/**
 * 按脚本回复的 provider；脚本用尽后重复最后一条（模拟持续不合作的模型）。
 * 达到 ABORT_AFTER_CALLS 时触发 abort，保证修复前的无上限循环也能有限结束。
 */
function createScriptedProvider(script: ScriptedReply[], abortController: AbortController) {
  let calls = 0;
  const chatWithTools = vi.fn(async () => {
    calls++;
    if (calls >= ABORT_AFTER_CALLS) {
      abortController.abort();
    }
    const step = script[Math.min(calls, script.length) - 1] ?? { kind: 'no-evidence' };
    if (step.kind === 'tool') {
      return toolReply(calls);
    }
    return textReply(step.kind === 'planning' ? PLANNING_TEXT : NO_EVIDENCE_TEXT);
  });
  return chatWithTools;
}

/** 停留在 SCAN 的 stub tracker：guard 始终适格；文本轮 onTextResponse 视为最终答复。 */
function createScanTracker() {
  const tracker = {
    phase: 'SCAN',
    pipelineType: 'analyst',
    isGracefulExit: false,
    isHardExit: false,
    iteration: 0,
    totalSubmits: 0,
    tick: vi.fn(),
    rollbackTick: vi.fn(),
    shouldExit: vi.fn(() => false),
    getNudge: vi.fn(() => null),
    getPhaseContext: vi.fn(() => null),
    getToolChoice: vi.fn(() => 'none'),
    recordToolCall: vi.fn(() => ({ isNew: true })),
    getMetrics: vi.fn(() => ({
      evidenceToolCallCount: 0,
      memoryFindingCount: 0,
      uniqueFiles: 0,
      uniquePatterns: 0,
    })),
    getPlanProgress: vi.fn(() => ({ coveredSteps: 0, totalSteps: 0 })),
    endRound: vi.fn(() => null),
    onTextResponse: vi.fn(() => ({
      isFinalAnswer: true,
      needsDigestNudge: false,
      shouldContinue: false,
      nudge: null,
    })),
  };
  return tracker;
}

function createRuntime(chatWithTools: ReturnType<typeof vi.fn>) {
  return new AgentRuntime({
    aiProvider: { name: 'deepseek', model: 'deepseek-v4-flash', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: {
      execute: vi.fn(async () => createToolEnvelope('src/known.ts:10 contains verified code')),
    } as never,
    container: {
      get: (name: string) => {
        if (name !== 'capabilityCatalog') {
          return undefined;
        }
        return {
          toToolSchemas: () => [
            { name: 'code', description: 'Code evidence tool', parameters: { type: 'object' } },
          ],
        };
      },
    } as never,
    capabilities: [],
    additionalTools: ['code'],
    strategy: { name: 'unused', execute: vi.fn() } as never,
    modelRef: MODEL_REF,
  });
}

function warningsOf(result: unknown): WarningLike[] {
  const diagnostics = (result as { diagnostics?: { warnings?: WarningLike[] } }).diagnostics;
  return diagnostics?.warnings ?? [];
}

function countCode(warnings: WarningLike[], code: string) {
  return warnings.filter((warning) => warning.code === code).length;
}

async function runWithStubTracker(
  script: ScriptedReply[],
  mode: 'off' | 'guard' = 'guard'
): Promise<{
  result: Awaited<ReturnType<AgentRuntime['reactLoop']>>;
  chatWithTools: ReturnType<typeof vi.fn>;
  tracker: ReturnType<typeof createScanTracker>;
  aborted: boolean;
}> {
  const abortController = new AbortController();
  const chatWithTools = createScriptedProvider(script, abortController);
  const tracker = createScanTracker();
  const runtime = createRuntime(chatWithTools);
  const result = await runtime.reactLoop('analyze first burn', {
    source: 'system',
    context: {
      evidenceStarters: { entry: { hint: 'src/known.ts:10 is a deterministic starter.' } },
      pipelinePhase: 'analyze',
    },
    groundingEnforcement: mode,
    tracker: tracker as never,
    abortSignal: abortController.signal,
    budgetOverride: { maxIterations: 3, timeoutMs: 60_000 },
  });
  return { result, chatWithTools, tracker, aborted: abortController.signal.aborted };
}

describe('analyze grounding guard 连续阻断上限（I38）', () => {
  it('guard + V4 + 真实 analyst ExplorationTracker：持续无证据文本时 LLM 调用次数有界，并记录 grounding_block_limit_reached', async () => {
    const maxIterations = 3;
    const abortController = new AbortController();
    const chatWithTools = createScriptedProvider([{ kind: 'no-evidence' }], abortController);
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations }
    );
    const runtime = createRuntime(chatWithTools);

    const result = await runtime.reactLoop('analyze', {
      source: 'system',
      context: { pipelinePhase: 'analyze' },
      groundingEnforcement: 'guard',
      tracker: tracker as never,
      abortSignal: abortController.signal,
      budgetOverride: { maxIterations, timeoutMs: 600_000 },
    });

    const warnings = warningsOf(result);
    // 不能靠外部 abort 才结束；调用次数 ≤ 阻断上限 + 迭代预算 + 少量收尾轮。
    expect(abortController.signal.aborted).toBe(false);
    expect(chatWithTools.mock.calls.length).toBeLessThanOrEqual(BLOCK_LIMIT + maxIterations + 3);
    // 只有前 BLOCK_LIMIT 次真正阻断；之后放行，tracker 轮次得以推进并正常终结。
    expect(countCode(warnings, 'invalid_no_evidence_burn')).toBe(BLOCK_LIMIT);
    const limitWarning = warnings.find(
      (warning) => warning.code === 'grounding_block_limit_reached'
    );
    expect(limitWarning).toBeDefined();
    expect(limitWarning?.message).toContain(`consecutiveBlocks=${BLOCK_LIMIT}`);
    expect(limitWarning?.message).toContain(`limit=${BLOCK_LIMIT}`);
    expect(limitWarning?.message).toContain('phase=');
    expect(limitWarning?.message).toContain(`modelRef=${MODEL_REF}`);
    expect(limitWarning?.stage).toBe('analyze');
    expect(tracker.iteration).toBeGreaterThan(1);
  });

  it('同一连续段第 3 次无证据文本：不再 rollbackTick，按普通文本轮走 endRound/onTextResponse 并放行', async () => {
    const { result, chatWithTools, tracker, aborted } = await runWithStubTracker([
      { kind: 'no-evidence' },
    ]);
    const warnings = warningsOf(result);

    expect(aborted).toBe(false);
    expect(chatWithTools).toHaveBeenCalledTimes(BLOCK_LIMIT + 1);
    expect(tracker.rollbackTick).toHaveBeenCalledTimes(BLOCK_LIMIT);
    expect(tracker.endRound).toHaveBeenCalledTimes(1);
    expect(tracker.onTextResponse).toHaveBeenCalledTimes(1);
    expect(countCode(warnings, 'invalid_no_evidence_burn')).toBe(BLOCK_LIMIT);
    expect(countCode(warnings, 'grounding_block_limit_reached')).toBe(1);
    expect(result.reply).toContain('architecture shape');
  });

  it('阻断次数恰好等于上限后模型合规：不触发上限诊断（上限边界）', async () => {
    const { result, chatWithTools, tracker } = await runWithStubTracker([
      { kind: 'no-evidence' },
      { kind: 'no-evidence' },
      { kind: 'planning' },
    ]);
    const warnings = warningsOf(result);

    expect(chatWithTools).toHaveBeenCalledTimes(3);
    expect(tracker.rollbackTick).toHaveBeenCalledTimes(BLOCK_LIMIT);
    expect(countCode(warnings, 'invalid_no_evidence_burn')).toBe(BLOCK_LIMIT);
    expect(countCode(warnings, 'grounding_block_limit_reached')).toBe(0);
    expect(result.pcvNodeEvidence.groundingLedger.map((entry) => entry.classification)).toEqual([
      'invalid-no-evidence',
      'invalid-no-evidence',
      'planning-only',
    ]);
  });

  it('工具轮把连续阻断计数清零：之后的无证据文本轮重新获得完整的阻断额度', async () => {
    const { result, chatWithTools, tracker, aborted } = await runWithStubTracker([
      { kind: 'no-evidence' },
      { kind: 'no-evidence' },
      { kind: 'tool' },
      { kind: 'no-evidence' },
    ]);
    const warnings = warningsOf(result);

    expect(aborted).toBe(false);
    // 2 次阻断 + 1 次工具轮 + 2 次阻断（新连续段）+ 1 次放行。
    expect(chatWithTools).toHaveBeenCalledTimes(BLOCK_LIMIT * 2 + 2);
    expect(tracker.rollbackTick).toHaveBeenCalledTimes(BLOCK_LIMIT * 2);
    expect(countCode(warnings, 'invalid_no_evidence_burn')).toBe(BLOCK_LIMIT * 2);
    expect(countCode(warnings, 'grounding_block_limit_reached')).toBe(1);
  });

  it('默认 off：不阻断、不计数、不产生上限诊断（observe-only 行为不变）', async () => {
    const { result, chatWithTools, tracker } = await runWithStubTracker(
      [{ kind: 'no-evidence' }],
      'off'
    );
    const warnings = warningsOf(result);

    expect(chatWithTools).toHaveBeenCalledTimes(1);
    expect(tracker.rollbackTick).not.toHaveBeenCalled();
    expect(countCode(warnings, 'invalid_no_evidence_burn')).toBe(0);
    expect(countCode(warnings, 'grounding_block_limit_reached')).toBe(0);
  });
});
