/**
 * AP-0 PCV observe-only 边界收敛 — 四控制点 characterization / baseline 测试。
 *
 * 目的：锁定 grounding-on 默认下的「现行」行为，作为后续阶段的对照锚点：
 *   - AP-1 抽 `ProviderToolChoicePolicy`（DeepSeek V4 toolChoice，行为对等、默认仍生效）；
 *   - AP-2 抽 `AnalyzeGroundingGuard`（analyze 阻断/nudge + grounding-policy 文本注入，行为对等）；
 *   - AP-3 引 `groundingEnforcement` 默认 off（这些断言届时改由显式 guard 运行复现）。
 *
 * 断言落在「可观察的集成 seam」——assembled LLM input 的内容 / provider 实际收到的
 * toolChoice 与 schema / 工具调用是否被抑制 / analyze 阻断+nudge+rollback——而不是将在
 * AP-1/2 被迁走或改名的私有 helper，使锚点在抽取后仍然成立（只需替换实现、不需重写断言）。
 *
 * 控制点（需求设计 Code Facts，基线 HEAD 95b5d6d）：
 *   CP1 grounding-policy 指令文本注入       LLMInputAssembly.ts:440-442 + buildAnalyzeGroundingPolicy:530-535（analyze always-on，按 modelRef/refCount 参数化）
 *   CP2 DeepSeek V4 toolChoice 改写         AgentRuntime.ts:884-905 + helper:2207-2241（首轮 none→auto、schema 可见）
 *   CP3 工具调用抑制的 DeepSeek V4 例外      AgentRuntime.ts:1129-1151（读 groundingBurn.deepseekV4ToolChoiceMode）
 *   CP4 analyze invalid-no-evidence 阻断     AgentRuntime.ts:1576-1605 + gate:1707-1732（阻断 + nudge + rollback tick）
 *
 * 仅 capture 现行行为，不改任何运行时逻辑（抽取=AP-1/2、切默认=AP-3）。
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
function assembleLlmInput(
  modelRef: string,
  stage: { phase: string; pipelineType: string; pipelinePhase: string },
  deterministicRefs: string[]
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
async function runDeepSeekAnalyzeFirstBurnWithToolEvidence() {
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
    tracker: tracker as never,
    budgetOverride: { maxIterations: 3, timeoutMs: 1000 },
  });
  return { result, captures, executeSpy };
}

describe('AP-0 PCV observe-only baseline characterization', () => {
  describe('CP1 grounding-policy 指令文本注入 (LLMInputAssembly, analyze always-on)', () => {
    it('analyze 阶段向 evidenceContext 注入 evidenceGroundingPolicy 文本（与具体 model 无关）', () => {
      const assembly = assembleLlmInput(
        'unit-model',
        { phase: 'SCAN', pipelineType: 'analyst', pipelinePhase: 'analyze' },
        ['Sources/App/Feature.swift:12']
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
      const evidenceSection = assembly.sections.find((section) => section.id === 'evidenceContext');
      expect(evidenceSection?.content).toContain('evidenceGroundingPolicy:');
    });

    it('DeepSeek V4 modelRef 追加 provider 专属子句（按 modelRef 参数化）', () => {
      const assembly = assembleLlmInput(
        'deepseek-v4-flash',
        { phase: 'SCAN', pipelineType: 'analyst', pipelinePhase: 'analyze' },
        ['Sources/App/Feature.swift:12']
      );
      const policy = assembly.metadata.groundingPolicy as string | null;
      expect(policy).toContain('DeepSeek V4 cannot rely on forced tool_choice');
    });

    it('非 analyze 阶段（produce）不注入 grounding policy', () => {
      const assembly = assembleLlmInput(
        'unit-model',
        { phase: 'PRODUCE', pipelineType: 'producer', pipelinePhase: 'produce' },
        ['Sources/App/Feature.swift:12']
      );
      expect(assembly.stageProfile).toBe('produce');
      expect(assembly.metadata.groundingPolicy).toBeNull();
      const evidenceSection = assembly.sections.find((section) => section.id === 'evidenceContext');
      expect(evidenceSection?.content ?? '').not.toContain('evidenceGroundingPolicy:');
    });
  });

  describe('CP2 DeepSeek V4 analyze toolChoice 改写 (AgentRuntime)', () => {
    it('首轮把 requestedToolChoice=none 改写为 auto 且保留 tool schema 可见', async () => {
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
  });

  describe('CP3 工具调用抑制的 DeepSeek V4 例外 (AgentRuntime)', () => {
    it('deepseekV4ToolChoiceMode=tools-visible-no-forced-tool-choice 时不抑制工具调用（实际执行）', async () => {
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
    it('DeepSeek V4 analyze 首轮文本无证据 grounding → 阻断 + 追加 nudge + rollbackTick', async () => {
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
        tracker: tracker as never,
        budgetOverride: { maxIterations: 3, timeoutMs: 1000 },
      });
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
});
