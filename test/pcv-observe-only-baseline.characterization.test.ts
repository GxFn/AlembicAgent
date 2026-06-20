/**
 * PCV observe-only 边界收敛 — 四控制点 characterization 测试（AP-3 切默认后＝两模式）。
 *
 * AP-0 锁定 grounding-on 现行行为；AP-1 抽 `ProviderToolChoicePolicy`；AP-2 抽 `AnalyzeGroundingGuard`
 * （行为对等）。AP-3 引入 `groundingEnforcement`（全局默认 `'off'` + per-run 覆盖），把 grounding
 * enforcement 默认关闭 —— 这些断言因此改为**两模式**：
 *   - 默认 off：主循环行为 ==「无 PCV 控制」（observe-only）—— analyze 不注入 grounding-policy 文本、
 *     analyze 文本轮不被阻断；PCV 仍纯观察记录 classification。
 *   - guard 开启（per-run override='guard'）：恢复 CP1 注入 + CP4 阻断+nudge+rollback（= AP-0 旧行为）。
 *   - CP2/CP3（DeepSeek V4 provider）：**不随开关**（PD1）—— 两模式 provider tool-choice 行为一致、不回归。
 *
 * 断言落在「可观察的集成 seam」——assembled LLM input 的内容 / provider 实际收到的 toolChoice 与
 * schema / 工具调用是否被抑制 / analyze 阻断+nudge+rollback——而非内部私有 helper。
 *
 * 控制点：
 *   CP1 grounding-policy 指令文本注入       LLMInputAssembly.buildGroundingContext（guard 时 analyze always-on，按 modelRef/refCount 参数化）
 *   CP2 DeepSeek V4 toolChoice 改写         AgentRuntime + ProviderToolChoicePolicy（首轮 none→auto、schema 可见；provider 不受 grounding 开关）
 *   CP3 工具调用抑制的 DeepSeek V4 例外      AgentRuntime（读 deepseekV4ToolChoiceMode；provider 不受 grounding 开关）
 *   CP4 analyze invalid-no-evidence 阻断     AgentRuntime 调用点（guard 时阻断+nudge+rollback；off 时短路）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRuntime,
  buildLlmInputAssembly,
  createMessageAdapter,
  LoopContext,
  type ProgressEvent,
} from '../src/agent/runtime/index.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';

// analyze-stage LoopContext 的 tracker stub（复刻 llm-input-layering.test.ts 模式）。
function createStageTracker(phase: string, pipelineType: string) {
  return {
    phase,
    pipelineType,
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
}

// CP1 用：装配一次 LLM 输入，返回 assembly（不触发任何 provider 调用）。
// groundingEnforcement 默认 'off'（AP-3 切默认）；传 'guard' 复现旧 grounding-on 注入行为。
function assembleLlmInput(
  modelRef: string,
  stage: { phase: string; pipelineType: string; pipelinePhase: string },
  deterministicRefs: string[],
  groundingEnforcement: 'off' | 'guard' = 'off'
) {
  const messages = createMessageAdapter(null);
  messages.appendUserMessage('Analyze the architecture for the design-patterns dimension.');
  const ctx = new LoopContext({
    allowedToolIds: ['code'],
    baseSystemPrompt: 'Analyst identity prompt',
    budget: { maxIterations: 1 },
    capabilities: [],
    context: {
      deterministicEvidenceRefs: deterministicRefs,
      dimensionId: 'design-patterns',
      pipelinePhase: stage.pipelinePhase,
      targetName: 'Demo',
    },
    groundingEnforcement,
    messages,
    prompt: 'Use the cited source to verify the finding.',
    source: 'system',
    toolSchemas: [{ name: 'code', description: 'Read source files' }],
    tracker: createStageTracker(stage.phase, stage.pipelineType) as never,
  });
  return buildLlmInputAssembly({
    ctx,
    dynamicContext: null,
    effectiveToolChoice: 'auto',
    messages: messages.toMessages(),
    modelRef,
    requestedToolChoice: 'none',
    systemPrompt: 'Analyst identity prompt',
    tools: [{ name: 'code', description: 'Read source files' }],
  });
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

// CP2/CP3 共享：DeepSeek V4 analyze 首轮（SCAN→EXPLORE）返回 code 工具调用并执行其证据。
// groundingEnforcement 不影响 provider tool-choice（PD1）；参数仅用于证明两模式一致。
async function runDeepSeekAnalyzeFirstBurnWithToolEvidence(
  groundingEnforcement: 'off' | 'guard' = 'off'
) {
  const captures: Array<Record<string, unknown> | undefined> = [];
  const chatWithTools = vi
    .fn()
    .mockImplementationOnce(async (_prompt: string, opts?: Record<string, unknown>) => {
      captures.push(opts);
      return {
        text: null,
        functionCalls: [
          {
            id: 'call_code_1',
            name: 'code',
            args: { action: 'read', params: { filePaths: ['src/known.ts'] } },
          },
        ],
        usage: { inputTokens: 2, outputTokens: 1 },
      };
    })
    .mockImplementationOnce(async (_prompt: string, opts?: Record<string, unknown>) => {
      captures.push(opts);
      return {
        text: 'final after tool evidence',
        functionCalls: [],
        usage: { inputTokens: 2, outputTokens: 1 },
      };
    });
  const executeSpy = vi.fn(async () =>
    createToolEnvelope('code', 'src/known.ts:10 contains verified code', {
      path: 'src/known.ts',
      sourceRefs: ['src/known.ts:10'],
    })
  );
  let evidenceToolCalls = 0;
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
    endRound: vi.fn(() => {
      tracker.phase = 'EXPLORE';
      return null;
    }),
    onTextResponse: vi.fn(() => ({
      isFinalAnswer: true,
      needsDigestNudge: false,
      shouldContinue: false,
      nudge: null,
    })),
  };
  const runtime = new AgentRuntime({
    aiProvider: { name: 'deepseek', model: 'deepseek-v4-flash', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: executeSpy } as never,
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
    modelRef: 'deepseek:deepseek-v4-flash',
  });
  const result = await runtime.reactLoop('analyze with tools visible', {
    source: 'system',
    context: { pipelinePhase: 'analyze' },
    groundingEnforcement,
    tracker: tracker as never,
    budgetOverride: { maxIterations: 3, timeoutMs: 1000 },
  });
  return { result, captures, executeSpy };
}

// CP4 共享：DeepSeek V4 analyze 首轮文本无证据 grounding（首轮无证据结论文本，次轮 planning-only）。
// groundingEnforcement='guard' → 阻断+nudge+rollback（两轮）；'off' → 不阻断、首轮即终结。
async function runDeepSeekAnalyzeNoEvidence(groundingEnforcement: 'off' | 'guard' = 'off') {
  const progress: ProgressEvent[] = [];
  const chatWithTools = vi
    .fn()
    .mockResolvedValueOnce({
      text: 'I can already conclude the architecture shape from general context.',
      functionCalls: [],
      usage: { inputTokens: 2, outputTokens: 1 },
    })
    .mockResolvedValueOnce({
      text: 'Planning-only: use deterministic evidence src/known.ts:10 to decide the next read before asserting facts.',
      functionCalls: [],
      usage: { inputTokens: 2, outputTokens: 1 },
    });
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
    getMetrics: vi.fn(() => ({
      evidenceToolCallCount: 0,
      memoryFindingCount: 0,
      uniqueFiles: 0,
      uniquePatterns: 0,
    })),
    endRound: vi.fn(() => null),
    onTextResponse: vi.fn(() => ({
      isFinalAnswer: true,
      needsDigestNudge: false,
      shouldContinue: false,
      nudge: null,
    })),
  };
  const runtime = new AgentRuntime({
    aiProvider: { name: 'deepseek', model: 'deepseek-v4-flash', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    capabilities: [],
    strategy: { name: 'unused', execute: vi.fn() } as never,
    modelRef: 'deepseek:deepseek-v4-flash',
    onProgress: (event) => progress.push(event),
  });
  const result = await runtime.reactLoop('analyze first burn', {
    source: 'system',
    context: {
      evidenceStarters: { entry: { hint: 'src/known.ts:10 is a deterministic starter.' } },
      pipelinePhase: 'analyze',
    },
    groundingEnforcement,
    tracker: tracker as never,
    budgetOverride: { maxIterations: 3, timeoutMs: 1000 },
  });
  return { result, progress, chatWithTools, tracker };
}

describe('PCV observe-only characterization — AP-3 两模式（默认 off / guard 开启）', () => {
  describe('CP1 grounding-policy 指令文本注入 (LLMInputAssembly)', () => {
    describe('默认 off：analyze 不注入 grounding policy（PCV observe-only）', () => {
      it('analyze 阶段默认不注入 evidenceGroundingPolicy（groundingPolicy=null）', () => {
        const assembly = assembleLlmInput(
          'unit-model',
          { phase: 'SCAN', pipelineType: 'analyst', pipelinePhase: 'analyze' },
          ['Sources/App/Feature.swift:12']
        );
        expect(assembly.stageProfile).toBe('analyze');
        expect(assembly.metadata.groundingPolicy).toBeNull();
        const evidenceSection = assembly.sections.find(
          (section) => section.id === 'evidenceContext'
        );
        expect(evidenceSection?.content ?? '').not.toContain('evidenceGroundingPolicy:');
      });

      it('PD5：默认 off 下证据 ref 列表仍注入（deterministicEvidenceRefs 不随开关）', () => {
        const assembly = assembleLlmInput(
          'unit-model',
          { phase: 'SCAN', pipelineType: 'analyst', pipelinePhase: 'analyze' },
          ['Sources/App/Feature.swift:12']
        );
        const evidenceSection = assembly.sections.find(
          (section) => section.id === 'evidenceContext'
        );
        expect(evidenceSection?.content).toContain('deterministicEvidenceRefs:');
        expect(evidenceSection?.content).toContain('Sources/App/Feature.swift:12');
      });
    });

    describe('guard 开启（per-run override）：恢复 grounding policy 注入（= AP-0 旧行为）', () => {
      it('analyze + guard 注入 evidenceGroundingPolicy 文本（与具体 model 无关、按 refCount 参数化）', () => {
        const assembly = assembleLlmInput(
          'unit-model',
          { phase: 'SCAN', pipelineType: 'analyst', pipelinePhase: 'analyze' },
          ['Sources/App/Feature.swift:12'],
          'guard'
        );
        expect(assembly.stageProfile).toBe('analyze');
        const policy = assembly.metadata.groundingPolicy as string | null;
        expect(typeof policy).toBe('string');
        expect(policy).toContain(
          'Every analyze burn that advances a conclusion must consume cited deterministic evidence refs'
        );
        // refCount>0 → 追加 deterministicEvidenceRefs 引用提示（参数化）。
        expect(policy).toContain('Cite the relevant deterministicEvidenceRefs');
        // 非 DeepSeek 模型不含 provider 子句。
        expect(policy).not.toContain('DeepSeek V4 cannot rely');
        const evidenceSection = assembly.sections.find(
          (section) => section.id === 'evidenceContext'
        );
        expect(evidenceSection?.content).toContain('evidenceGroundingPolicy:');
      });

      it('guard + DeepSeek V4 modelRef 追加 provider 专属子句（按 modelRef 参数化）', () => {
        const assembly = assembleLlmInput(
          'deepseek-v4-flash',
          { phase: 'SCAN', pipelineType: 'analyst', pipelinePhase: 'analyze' },
          ['Sources/App/Feature.swift:12'],
          'guard'
        );
        const policy = assembly.metadata.groundingPolicy as string | null;
        expect(policy).toContain('DeepSeek V4 cannot rely on forced tool_choice');
      });
    });

    it('非 analyze 阶段（produce）任何模式都不注入 grounding policy', () => {
      const off = assembleLlmInput(
        'unit-model',
        { phase: 'PRODUCE', pipelineType: 'producer', pipelinePhase: 'produce' },
        ['Sources/App/Feature.swift:12']
      );
      expect(off.stageProfile).toBe('produce');
      expect(off.metadata.groundingPolicy).toBeNull();
      // produce 阶段永不注入，即便显式 guard。
      const guard = assembleLlmInput(
        'unit-model',
        { phase: 'PRODUCE', pipelineType: 'producer', pipelinePhase: 'produce' },
        ['Sources/App/Feature.swift:12'],
        'guard'
      );
      expect(guard.metadata.groundingPolicy).toBeNull();
      const evidenceSection = guard.sections.find((section) => section.id === 'evidenceContext');
      expect(evidenceSection?.content ?? '').not.toContain('evidenceGroundingPolicy:');
    });
  });

  describe('CP2 DeepSeek V4 analyze toolChoice 改写 (AgentRuntime, provider 不随 grounding 开关)', () => {
    it('默认 off：首轮把 requestedToolChoice=none 改写为 auto 且保留 tool schema 可见（provider 不受 observe-only 影响）', async () => {
      const { result, captures } = await runDeepSeekAnalyzeFirstBurnWithToolEvidence();
      const firstCall = captures[0] || {};
      const firstSchemas = firstCall.toolSchemas as Array<Record<string, unknown>> | undefined;
      expect(firstSchemas?.map((schema) => schema.name)).toContain('code');
      expect(firstCall.toolChoice).toBe('auto');
      expect(firstCall.toolChoice).not.toBe('required');
      const firstBurn = result.pcvNodeEvidence.groundingLedger[0];
      expect(firstBurn).toMatchObject({
        deepseekV4ToolChoiceMode: 'tools-visible-no-forced-tool-choice',
        effectiveToolChoice: 'auto',
        requestedToolChoice: 'none',
        toolSchemasVisible: true,
      });
    });

    it('guard 开启：provider toolChoice 行为与 off 完全一致（PD1 — provider 与 grounding 解耦）', async () => {
      const { result, captures } = await runDeepSeekAnalyzeFirstBurnWithToolEvidence('guard');
      const firstCall = captures[0] || {};
      const firstSchemas = firstCall.toolSchemas as Array<Record<string, unknown>> | undefined;
      expect(firstSchemas?.map((schema) => schema.name)).toContain('code');
      expect(firstCall.toolChoice).toBe('auto');
      const firstBurn = result.pcvNodeEvidence.groundingLedger[0];
      expect(firstBurn).toMatchObject({
        deepseekV4ToolChoiceMode: 'tools-visible-no-forced-tool-choice',
        effectiveToolChoice: 'auto',
        requestedToolChoice: 'none',
        toolSchemasVisible: true,
      });
    });
  });

  describe('CP3 工具调用抑制的 DeepSeek V4 例外 (AgentRuntime, provider 不随 grounding 开关)', () => {
    it('deepseekV4ToolChoiceMode=tools-visible-no-forced-tool-choice 时不抑制工具调用（实际执行；默认 off 下 provider 不受影响）', async () => {
      const { result, executeSpy } = await runDeepSeekAnalyzeFirstBurnWithToolEvidence();
      // 首轮在 requestedToolChoice=none 下返回的工具调用未被 graceful-exit/none 抑制分支吞掉 → 实际执行。
      expect(executeSpy).toHaveBeenCalled();
      const firstBurn = result.pcvNodeEvidence.groundingLedger[0];
      expect(firstBurn?.deepseekV4ToolChoiceMode).toBe('tools-visible-no-forced-tool-choice');
      expect(firstBurn?.classification).toBe('evidence-produced');
    });

    it('对照：无 DeepSeek V4 例外时 graceful-exit 下的工具调用被抑制（不执行 + tool_choice_violation 诊断）', async () => {
      const executeSpy = vi.fn(async () => createToolEnvelope('code', 'should not run'));
      const chatWithTools = vi.fn(async () => ({
        text: 'final answer text after graceful exit',
        functionCalls: [{ id: 'c1', name: 'code', args: { action: 'read' } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      }));
      const tracker = {
        phase: 'SUMMARIZE',
        pipelineType: 'analyst',
        isGracefulExit: true,
        isHardExit: false,
        iteration: 1,
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
        endRound: vi.fn(() => null),
        onTextResponse: vi.fn(() => ({
          isFinalAnswer: true,
          needsDigestNudge: false,
          shouldContinue: false,
          nudge: null,
        })),
      };
      const runtime = new AgentRuntime({
        aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
        toolRegistry: { getManifest: () => null } as never,
        toolRouter: { execute: executeSpy } as never,
        capabilities: [],
        strategy: { name: 'unused', execute: vi.fn() } as never,
        modelRef: 'unit:unit',
      });
      const result = await runtime.reactLoop('graceful exit ignores tool calls', {
        source: 'system',
        context: { pipelinePhase: 'analyze' },
        tracker: tracker as never,
        budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
      });
      expect(executeSpy).not.toHaveBeenCalled();
      expect(result.diagnostics?.warnings).toContainEqual(
        expect.objectContaining({ code: 'tool_choice_violation' })
      );
    });
  });

  describe('CP4 analyze invalid-no-evidence 阻断 + nudge + rollback (AgentRuntime)', () => {
    it('默认 off：DeepSeek V4 analyze 首轮无证据文本 NOT 阻断（observe-only — 分类仍被观察记录、不推进控制）', async () => {
      const { result, progress, chatWithTools, tracker } = await runDeepSeekAnalyzeNoEvidence();
      const ledger = result.pcvNodeEvidence.groundingLedger;
      const nudge = progress
        .map((event) => event.processEvent)
        .find((event) => event?.metadata?.semanticKind === 'evidence-grounding-nudge');
      // 未阻断 → 首轮文本即被当作最终答复，循环结束（不进入第二轮）。
      expect(chatWithTools).toHaveBeenCalledTimes(1);
      expect(tracker.rollbackTick).not.toHaveBeenCalled();
      // PCV 仍纯观察：首轮 classification 照常记录为 invalid-no-evidence，但不触发阻断。
      expect(ledger.map((entry) => entry.classification)).toEqual(['invalid-no-evidence']);
      expect(nudge).toBeUndefined();
    });

    it('guard 开启（per-run override）：恢复阻断 + 追加 nudge + rollbackTick（= AP-0 旧行为）', async () => {
      const { result, progress, chatWithTools, tracker } =
        await runDeepSeekAnalyzeNoEvidence('guard');
      const ledger = result.pcvNodeEvidence.groundingLedger;
      const nudge = progress
        .map((event) => event.processEvent)
        .find((event) => event?.metadata?.semanticKind === 'evidence-grounding-nudge');
      expect(chatWithTools).toHaveBeenCalledTimes(2);
      expect(tracker.rollbackTick).toHaveBeenCalledTimes(1);
      expect(ledger.map((entry) => entry.classification)).toEqual([
        'invalid-no-evidence',
        'planning-only',
      ]);
      expect(nudge?.content?.text).toContain('不能推进阶段');
    });
  });

  describe('AP-4 enforcement-mode 标记 + 证据纯化 (PcvNodeEvidenceSummary, 生产者侧)', () => {
    it('默认 off：summary.groundingEnforcement 标记为 off（observe-only）；additive 不破既有字段/schemaVersion', async () => {
      const { result } = await runDeepSeekAnalyzeNoEvidence();
      const summary = result.pcvNodeEvidence;
      expect(summary.groundingEnforcement).toBe('off');
      // 纯 additive：既有跨仓消费字段与 schemaVersion 不变（老消费者不受影响）。
      expect(summary.schemaVersion).toBe(1);
      expect(Array.isArray(summary.groundingLedger)).toBe(true);
      expect(summary.correlation).toBeDefined();
    });

    it('guard override：summary.groundingEnforcement 标记为 guard（区分两模式语义，供 AP-6 审计判读）', async () => {
      const { result } = await runDeepSeekAnalyzeNoEvidence('guard');
      expect(result.pcvNodeEvidence.groundingEnforcement).toBe('guard');
    });

    it('纯观察 / 关 metadata 主流程不变：off 下 invalid-no-evidence 分类仍被记录为审计材料，但不驱动控流（loop 照常终结、不阻断/不回退）', async () => {
      const { result, chatWithTools, tracker } = await runDeepSeekAnalyzeNoEvidence();
      const ledger = result.pcvNodeEvidence.groundingLedger;
      // 证据层照常观察 classification（审计材料）——R6：consumer 据 groundingEnforcement='off' 判读为审计而非回归。
      expect(ledger.map((entry) => entry.classification)).toEqual(['invalid-no-evidence']);
      expect(result.pcvNodeEvidence.groundingEnforcement).toBe('off');
      // 主循环控制（终结/阻断/回退）完全不受该 metadata 影响 —— PCV 纯观察、无残留控流耦合。
      expect(chatWithTools).toHaveBeenCalledTimes(1);
      expect(tracker.rollbackTick).not.toHaveBeenCalled();
    });
  });
});
