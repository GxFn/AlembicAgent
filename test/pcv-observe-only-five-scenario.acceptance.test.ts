/**
 * AP-5 — AlembicAgent PCV observe-only 边界「五场景」端到端验收。
 *
 * 与 pcv-observe-only-baseline.characterization.test.ts（按四控制点 CP1-CP4 + AP-4 标记组织的
 * behavior-equivalence 锚点）互补：本套件**按场景组织**，每个场景跑一次完整 reactLoop，断言整条
 * 链路的可观察 end-to-end 结果——验收 AP-1~4 收敛后的对外行为正确。
 *
 * 五场景（需求设计完成定义 ⑦）：
 *   ① observe-only 默认（off）   —— analyze 不阻断 / grounding-policy 不注入 provider / provider toolChoice 不受影响 / classification 仍审计 / summary 标记 off
 *   ② guard opt-in（per-run）     —— 恢复 grounding-policy 注入(到达 provider) + invalid-no-evidence 阻断+nudge+rollbackTick / summary 标记 guard
 *   ③ DeepSeek V4               —— analyze 首轮 toolChoice none→auto + schema 可见；provider 正确性两模式一致、不被 grounding 门控（PD1）
 *   ④ graceful exit            —— 抑制例外路径：工具调用不执行 + tool_choice_violation 诊断
 *   ⑤ 无证据 analyze            —— 同一无证据输入：off 首轮终结 / guard 阻断（enforcement 开关决定）
 *
 * 断言落在可观察 seam：summary.groundingEnforcement 标记 / provider 收到的 messages·toolChoice·toolSchemas /
 * 工具调用是否执行 / analyze 阻断+nudge+rollback / groundingLedger classification。不依赖内部私有 helper。
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime, type ProgressEvent } from '../src/agent/runtime/index.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';

interface BurnResponse {
  text: string | null;
  functionCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

function createToolEnvelope(
  toolId: string,
  text: string,
  structuredContent?: Record<string, unknown>
): ToolResultEnvelope {
  return {
    ok: true,
    toolId,
    callId: 'tool-call-1',
    startedAt: new Date().toISOString(),
    durationMs: 3,
    status: 'success',
    text,
    structuredContent,
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

// analyst tracker stub —— onTextResponse 默认 final（首轮文本即终结，除非被 grounding gate 阻断而续轮）。
function createAnalystTracker(overrides: Record<string, unknown> = {}) {
  let evidenceToolCalls = 0;
  const tracker: Record<string, unknown> = {
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
    recordToolCall: vi.fn(() => {
      evidenceToolCalls += 1;
      return { isNew: true };
    }),
    getMetrics: vi.fn(() => ({
      evidenceToolCallCount: evidenceToolCalls,
      memoryFindingCount: 0,
      uniqueFiles: evidenceToolCalls,
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
    ...overrides,
  };
  return tracker;
}

interface ScenarioInput {
  modelRef: string;
  groundingEnforcement?: 'off' | 'guard';
  burns: BurnResponse[];
  tracker: Record<string, unknown>;
  toolRouterExecute?: ReturnType<typeof vi.fn>;
  toolVisible?: boolean;
}

// 跑一次完整 reactLoop，捕获 provider 调用 opts、progress 与最终 result。
async function runScenario(input: ScenarioInput) {
  const captures: Array<Record<string, unknown> | undefined> = [];
  const chatWithTools = vi.fn();
  for (const burn of input.burns) {
    chatWithTools.mockImplementationOnce(
      async (_prompt: string, opts?: Record<string, unknown>) => {
        captures.push(opts);
        return { ...burn, usage: { inputTokens: 2, outputTokens: 1 } };
      }
    );
  }
  const executeSpy = input.toolRouterExecute ?? vi.fn();
  const progress: ProgressEvent[] = [];
  const runtime = new AgentRuntime({
    aiProvider: {
      name: input.modelRef.split(':')[0],
      model: input.modelRef.split(':')[1],
      chatWithTools,
    } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: executeSpy } as never,
    capabilities: [],
    ...(input.toolVisible
      ? {
          additionalTools: ['code'],
          container: {
            get: (name: string) =>
              name === 'capabilityCatalog'
                ? {
                    toToolSchemas: () => [
                      {
                        name: 'code',
                        description: 'Code evidence tool',
                        parameters: { type: 'object' },
                      },
                    ],
                  }
                : undefined,
          },
        }
      : {}),
    strategy: { name: 'unused', execute: vi.fn() } as never,
    modelRef: input.modelRef,
    onProgress: (event) => progress.push(event),
  } as never);
  const result = await runtime.reactLoop('five-scenario acceptance', {
    source: 'system',
    context: {
      evidenceStarters: { entry: { hint: 'src/known.ts:10 is a deterministic starter.' } },
      pipelinePhase: 'analyze',
    },
    ...(input.groundingEnforcement ? { groundingEnforcement: input.groundingEnforcement } : {}),
    tracker: input.tracker as never,
    budgetOverride: { maxIterations: 3, timeoutMs: 1000 },
  });
  const groundingNudge = progress
    .map((event) => event.processEvent)
    .find((event) => event?.metadata?.semanticKind === 'evidence-grounding-nudge');
  const providerSawPolicy = captures.some((opts) =>
    JSON.stringify(opts?.messages ?? []).includes('evidenceGroundingPolicy')
  );
  return {
    result,
    captures,
    chatWithTools,
    executeSpy,
    tracker: input.tracker,
    groundingNudge,
    providerSawPolicy,
  };
}

// 无证据 analyze 两轮输入（首轮无证据结论文本，次轮 planning-only）。
const NO_EVIDENCE_BURNS: BurnResponse[] = [
  {
    text: 'I can already conclude the architecture shape from general context.',
    functionCalls: [],
  },
  {
    text: 'Planning-only: use deterministic evidence src/known.ts:10 to decide the next read before asserting facts.',
    functionCalls: [],
  },
];

// DeepSeek V4 首轮返回 code 工具调用 + 次轮终结（用于 provider toolChoice / 工具可见性）。
// 次轮文本引用 deterministic ref（src/known.ts:10）→ 分类非 invalid-no-evidence，故 guard 模式下不被阻断、
// 两模式都在 2 轮内终结（本场景验收的是 provider 首轮 toolChoice，非 grounding gate）。
function deepSeekToolEvidenceBurns(): BurnResponse[] {
  return [
    {
      text: null,
      functionCalls: [
        {
          id: 'call_code_1',
          name: 'code',
          args: { action: 'read', params: { filePaths: ['src/known.ts'] } },
        },
      ],
    },
    {
      text: 'Final: src/known.ts:10 confirms the verified architecture boundary.',
      functionCalls: [],
    },
  ];
}

describe('AP-5 PCV observe-only 五场景端到端验收', () => {
  it('场景① observe-only 默认（off）：不阻断 + grounding-policy 不到达 provider + classification 仍审计 + 标记 off', async () => {
    const { result, chatWithTools, tracker, groundingNudge, providerSawPolicy } = await runScenario(
      {
        modelRef: 'deepseek:deepseek-v4-flash',
        burns: NO_EVIDENCE_BURNS,
        tracker: createAnalystTracker(),
      }
    );
    expect(result.pcvNodeEvidence.groundingEnforcement).toBe('off');
    expect(chatWithTools).toHaveBeenCalledTimes(1); // 未阻断 → 首轮即终结
    expect(tracker.rollbackTick).not.toHaveBeenCalled();
    expect(groundingNudge).toBeUndefined();
    expect(providerSawPolicy).toBe(false); // grounding-policy 未注入 provider 调用
    // PCV 纯观察：classification 仍被记录为审计材料。
    expect(result.pcvNodeEvidence.groundingLedger.map((entry) => entry.classification)).toEqual([
      'invalid-no-evidence',
    ]);
  });

  it('场景② guard opt-in（per-run guard）：grounding-policy 到达 provider + 阻断+nudge+rollbackTick + 标记 guard', async () => {
    const { result, chatWithTools, tracker, groundingNudge, providerSawPolicy } = await runScenario(
      {
        modelRef: 'deepseek:deepseek-v4-flash',
        groundingEnforcement: 'guard',
        burns: NO_EVIDENCE_BURNS,
        tracker: createAnalystTracker(),
      }
    );
    expect(result.pcvNodeEvidence.groundingEnforcement).toBe('guard');
    expect(providerSawPolicy).toBe(true); // CP1 grounding-policy 注入到达 provider messages
    expect(chatWithTools).toHaveBeenCalledTimes(2); // 首轮阻断 → 续轮
    expect(tracker.rollbackTick).toHaveBeenCalledTimes(1);
    expect(groundingNudge?.content?.text).toContain('不能推进阶段');
    expect(result.pcvNodeEvidence.groundingLedger.map((entry) => entry.classification)).toEqual([
      'invalid-no-evidence',
      'planning-only',
    ]);
  });

  it('场景③ DeepSeek V4：analyze 首轮 toolChoice none→auto + schema 可见，两模式一致（PD1 provider 不受 grounding 门控）', async () => {
    for (const groundingEnforcement of ['off', 'guard'] as const) {
      const { result, captures, executeSpy } = await runScenario({
        modelRef: 'deepseek:deepseek-v4-flash',
        groundingEnforcement,
        burns: deepSeekToolEvidenceBurns(),
        tracker: createAnalystTracker(),
        toolVisible: true,
        toolRouterExecute: vi.fn(async () =>
          createToolEnvelope('code', 'src/known.ts:10 contains verified code', {
            path: 'src/known.ts',
            sourceRefs: ['src/known.ts:10'],
          })
        ),
      });
      const firstCall = captures[0] || {};
      const firstSchemas = firstCall.toolSchemas as Array<Record<string, unknown>> | undefined;
      expect(firstSchemas?.map((schema) => schema.name)).toContain('code');
      expect(firstCall.toolChoice).toBe('auto');
      expect(firstCall.toolChoice).not.toBe('required');
      expect(executeSpy).toHaveBeenCalled(); // 工具调用实际执行（未被抑制）
      expect(result.pcvNodeEvidence.groundingLedger[0]).toMatchObject({
        deepseekV4ToolChoiceMode: 'tools-visible-no-forced-tool-choice',
        effectiveToolChoice: 'auto',
        requestedToolChoice: 'none',
        toolSchemasVisible: true,
      });
    }
  });

  it('场景④ graceful exit：抑制例外路径正确（工具调用不执行 + tool_choice_violation 诊断）', async () => {
    const executeSpy = vi.fn(async () => createToolEnvelope('code', 'should not run'));
    const { result } = await runScenario({
      modelRef: 'unit:unit',
      burns: [
        {
          text: 'final answer text after graceful exit',
          functionCalls: [{ id: 'c1', name: 'code', args: { action: 'read' } }],
        },
      ],
      tracker: createAnalystTracker({ phase: 'SUMMARIZE', isGracefulExit: true, iteration: 1 }),
      toolRouterExecute: executeSpy,
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({ code: 'tool_choice_violation' })
    );
  });

  it('场景⑤ 无证据 analyze：同一输入下 off 首轮终结 / guard 阻断（enforcement 开关决定主流程）', async () => {
    const off = await runScenario({
      modelRef: 'deepseek:deepseek-v4-flash',
      burns: NO_EVIDENCE_BURNS,
      tracker: createAnalystTracker(),
    });
    const guard = await runScenario({
      modelRef: 'deepseek:deepseek-v4-flash',
      groundingEnforcement: 'guard',
      burns: NO_EVIDENCE_BURNS,
      tracker: createAnalystTracker(),
    });
    // off：不阻断、首轮终结、标记 off。
    expect(off.chatWithTools).toHaveBeenCalledTimes(1);
    expect(off.tracker.rollbackTick).not.toHaveBeenCalled();
    expect(off.result.pcvNodeEvidence.groundingEnforcement).toBe('off');
    // guard：阻断、续轮、rollback、标记 guard。
    expect(guard.chatWithTools).toHaveBeenCalledTimes(2);
    expect(guard.tracker.rollbackTick).toHaveBeenCalledTimes(1);
    expect(guard.result.pcvNodeEvidence.groundingEnforcement).toBe('guard');
  });
});
