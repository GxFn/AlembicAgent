import { describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { DiagnosticsCollector, type ProgressEvent } from '../src/agent/runtime/index.js';
import type { ToolResultEnvelope } from '../src/tools/core/ToolResultEnvelope.js';

function createRuntimeForReactLoop() {
  const chatWithTools = vi.fn(async () => ({
    text: 'forced summary should not be called',
    functionCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const runtime = new AgentRuntime({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    capabilities: [],
    strategy: { name: 'unused', execute: vi.fn() } as never,
  });
  return { runtime, chatWithTools };
}

function createExitingTracker() {
  return {
    phase: 'SUMMARIZE',
    pipelineType: 'analyst',
    isGracefulExit: false,
    isHardExit: true,
    iteration: 1,
    totalSubmits: 0,
    tick: vi.fn(),
    shouldExit: vi.fn(() => true),
  };
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

describe('agent runtime forced summary suppression', () => {
  it('emits developer-safe LLM input and output process payloads', async () => {
    const progress: ProgressEvent[] = [];
    const visibleText = `${'Visible model output '.repeat(350)}token=visibleOutputSecret12345`;
    const reasoningContent = 'hidden chain of thought must not appear';
    const chatWithTools = vi.fn(async () => ({
      text: visibleText,
      functionCalls: [],
      reasoningContent,
      finishReason: 'length',
      usage: { inputTokens: 11, outputTokens: 7, reasoningTokens: 3 },
    }));
    const runtime = new AgentRuntime({
      aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute: vi.fn() } as never,
      capabilities: [],
      strategy: { name: 'unused', execute: vi.fn() } as never,
      onProgress: (event) => progress.push(event),
    });

    await runtime.reactLoop('analyze with apiKey=visibleInputSecret12345', {
      source: 'system',
      context: {
        pipelinePhase: 'analyze',
        dimensionId: 'architecture',
        targetName: 'Architecture',
      },
      budgetOverride: { maxIterations: 1, timeoutMs: 1000 },
    });

    const processEvents = progress
      .map((event) => event.processEvent)
      .filter((event): event is NonNullable<ProgressEvent['processEvent']> => !!event);
    const llmInput = processEvents.find((event) => event.kind === 'llm.input');
    const llmOutput = processEvents.find((event) => event.kind === 'llm.output');

    expect(llmInput).toMatchObject({
      kind: 'llm.input',
      sourceClass: 'developer-facing',
      displayPolicy: 'full',
      retention: 'job-retained',
      phase: 'analyze',
      dimensionId: 'architecture',
      targetName: 'Architecture',
    });
    expect(llmInput?.content?.text).toContain('analyze with apiKey=');
    expect(llmInput?.content?.text).not.toContain('visibleInputSecret12345');
    expect(llmOutput?.content?.text).toContain('Visible model output');
    expect(llmOutput?.content?.text?.length).toBeGreaterThan(6000);
    expect(llmOutput?.content?.text).not.toContain('visibleOutputSecret12345');
    expect(llmOutput?.content?.text).not.toContain('hidden chain of thought');
    expect(llmOutput?.summary).toContain('provider stopped with finishReason=length');
    expect(llmOutput?.metadata).toMatchObject({
      agentOutputTruncated: false,
      finishReason: 'length',
      hasHiddenReasoningContent: true,
      outputCompleteness: 'provider_truncated',
      providerOutputTruncated: true,
      reasoningContentChars: reasoningContent.length,
      reasoningContentOmitted: true,
      reasoningTokens: 3,
      textChars: visibleText.length,
      visibleTextChars: visibleText.length,
    });
  });

  it('emits developer-safe reflection and tool process payloads', async () => {
    const progress: ProgressEvent[] = [];
    const chatWithTools = vi
      .fn()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [
          {
            id: 'call_1',
            name: 'demo_tool',
            args: { query: 'hello', apiKey: 'visibleToolArgSecret12345' },
          },
        ],
        usage: { inputTokens: 3, outputTokens: 2 },
      })
      .mockResolvedValueOnce({
        text: 'done',
        functionCalls: [],
        usage: { inputTokens: 2, outputTokens: 1 },
      });
    const toolRouter = {
      execute: vi.fn(async () =>
        createToolEnvelope('demo_tool', 'tool result token=visibleToolResultSecret12345', {
          ok: true,
        })
      ),
    };
    const endRound = vi.fn(() =>
      endRound.mock.calls.length === 1
        ? {
            type: 'transition',
            text: '阶段切换: EXPLORE → SUMMARIZE',
          }
        : null
    );
    const tracker = {
      phase: 'EXPLORE',
      pipelineType: 'analyst',
      isGracefulExit: false,
      isHardExit: false,
      iteration: 0,
      totalSubmits: 0,
      tick: vi.fn(),
      shouldExit: vi.fn(() => false),
      getNudge: vi.fn(() => ({
        type: 'reflection',
        text: 'Reflect on current evidence with token=visibleNudgeSecret12345',
      })),
      getPhaseContext: vi.fn(() => null),
      getToolChoice: vi.fn(() => 'auto'),
      recordToolCall: vi.fn(() => ({ isNew: true })),
      getMetrics: vi.fn(() => ({ uniqueFiles: 0, uniquePatterns: 0 })),
      endRound,
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
      toolRouter: toolRouter as never,
      container: {
        get: (name: string) => {
          if (name !== 'capabilityCatalog') {
            return undefined;
          }
          return {
            toToolSchemas: () => [
              { name: 'demo_tool', description: 'Demo', parameters: { type: 'object' } },
            ],
          };
        },
      } as never,
      capabilities: [],
      additionalTools: ['demo_tool'],
      strategy: { name: 'unused', execute: vi.fn() } as never,
      onProgress: (event) => progress.push(event),
    });

    await runtime.reactLoop('call demo tool', {
      source: 'system',
      tracker: tracker as never,
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    const processEvents = progress
      .map((event) => event.processEvent)
      .filter((event): event is NonNullable<ProgressEvent['processEvent']> => !!event);
    const reflection = processEvents.find((event) => event.kind === 'llm.reflection');
    const transition = processEvents.find(
      (event) => event.metadata?.semanticKind === 'transition-nudge'
    );
    const toolEvents = processEvents.filter((event) => event.kind === 'tool');

    expect(reflection?.content?.text).toContain('Reflect on current evidence');
    expect(reflection?.content?.text).not.toContain('visibleNudgeSecret12345');
    expect(reflection?.metadata).toMatchObject({
      nudgeType: 'reflection',
      pipelineType: 'analyst',
      semanticKind: 'reflection-nudge',
    });
    expect(transition?.title).toContain('阶段转换');
    expect(transition?.content?.text).toContain('阶段切换');
    expect(transition?.metadata).toMatchObject({
      nudgeType: 'transition',
      phase: 'EXPLORE',
      pipelineType: 'analyst',
      semanticKind: 'transition-nudge',
    });
    expect(toolEvents.map((event) => event.title)).toEqual(
      expect.arrayContaining(['Tool call started: demo_tool', 'Tool call completed: demo_tool'])
    );
    expect(toolEvents[0]?.content?.text).not.toContain('visibleToolArgSecret12345');
    expect(toolEvents[1]?.content?.text).not.toContain('visibleToolResultSecret12345');
    expect(toolEvents[1]?.severity).toBe('success');
    expect(toolEvents[1]?.metadata?.pcvNodeEvidence).toMatchObject({
      inputAssemblyRef: expect.stringMatching(/^llm-input:/),
      nodeId: expect.any(String),
      sourceRefs: [],
    });
    expect(JSON.stringify(toolEvents[1]?.metadata?.pcvNodeEvidence)).not.toContain(
      'visibleToolResultSecret12345'
    );
  });

  it('emits semantic digest and continue nudge process payloads', async () => {
    const progress: ProgressEvent[] = [];
    const chatWithTools = vi
      .fn()
      .mockResolvedValueOnce({
        text: 'partial answer',
        functionCalls: [],
        usage: { inputTokens: 2, outputTokens: 1 },
      })
      .mockResolvedValueOnce({
        text: 'needs one more pass',
        functionCalls: [],
        usage: { inputTokens: 2, outputTokens: 1 },
      })
      .mockResolvedValueOnce({
        text: 'final answer',
        functionCalls: [],
        usage: { inputTokens: 2, outputTokens: 1 },
      });
    let textResponseCount = 0;
    const tracker = {
      phase: 'SUMMARIZE',
      pipelineType: 'bootstrap',
      isGracefulExit: false,
      isHardExit: false,
      iteration: 0,
      totalSubmits: 0,
      tick: vi.fn(),
      shouldExit: vi.fn(() => false),
      getNudge: vi.fn(() => null),
      getPhaseContext: vi.fn(() => null),
      getToolChoice: vi.fn(() => 'none'),
      getMetrics: vi.fn(() => ({ uniqueFiles: 0, uniquePatterns: 0 })),
      endRound: vi.fn(() => null),
      onTextResponse: vi.fn(() => {
        textResponseCount += 1;
        if (textResponseCount === 1) {
          return {
            isFinalAnswer: false,
            needsDigestNudge: true,
            shouldContinue: false,
            nudge:
              '请输出 dimensionDigest JSON，包含 keyFindings，并忽略 apiKey=visibleDigestSecret12345',
          };
        }
        if (textResponseCount === 2) {
          return {
            isFinalAnswer: false,
            needsDigestNudge: false,
            shouldContinue: true,
            nudge: '继续验证剩余信号 token=visibleContinueSecret12345',
          };
        }
        return {
          isFinalAnswer: true,
          needsDigestNudge: false,
          shouldContinue: false,
          nudge: null,
        };
      }),
    };
    const runtime = new AgentRuntime({
      aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute: vi.fn() } as never,
      capabilities: [],
      strategy: { name: 'unused', execute: vi.fn() } as never,
      onProgress: (event) => progress.push(event),
    });

    await runtime.reactLoop('summarize semantic nudges', {
      source: 'system',
      context: {
        dimensionId: 'domain',
        targetName: 'Domain',
      },
      tracker: tracker as never,
      budgetOverride: { maxIterations: 3, timeoutMs: 1000 },
    });

    const processEvents = progress
      .map((event) => event.processEvent)
      .filter((event): event is NonNullable<ProgressEvent['processEvent']> => !!event);
    const digest = processEvents.find((event) => event.metadata?.semanticKind === 'digest-nudge');
    const continueNudge = processEvents.find(
      (event) => event.metadata?.semanticKind === 'continue-nudge'
    );

    expect(digest).toMatchObject({
      kind: 'llm.reflection',
      title: 'Agent 总结 Nudge',
      dimensionId: 'domain',
      targetName: 'Domain',
    });
    expect(digest?.content?.text).toContain('dimensionDigest');
    expect(digest?.content?.text).not.toContain('visibleDigestSecret12345');
    expect(digest?.metadata).toMatchObject({
      nudgeType: 'digest',
      pipelineType: 'bootstrap',
      semanticKind: 'digest-nudge',
    });
    expect(continueNudge?.title).toBe('Agent 继续执行 Nudge');
    expect(continueNudge?.content?.text).toContain('继续验证剩余信号');
    expect(continueNudge?.content?.text).not.toContain('visibleContinueSecret12345');
    expect(continueNudge?.metadata).toMatchObject({
      nudgeType: 'continue',
      pipelineType: 'bootstrap',
      semanticKind: 'continue-nudge',
    });
  });

  it('exposes a direct note_finding tool schema when memory is available', async () => {
    const capture: { toolSchemas?: Array<Record<string, unknown>> } = {};
    const chatWithTools = vi.fn(async (_prompt: string, opts?: Record<string, unknown>) => {
      capture.toolSchemas = opts?.toolSchemas as Array<Record<string, unknown>> | undefined;
      return {
        text: 'done',
        functionCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const runtime = new AgentRuntime({
      aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute: vi.fn() } as never,
      container: {
        get: (name: string) => {
          if (name !== 'capabilityCatalog') {
            return undefined;
          }
          return {
            toToolSchemas: (ids?: readonly string[] | null) =>
              ids?.includes('memory')
                ? [{ name: 'memory', description: 'Memory', parameters: { type: 'object' } }]
                : [],
          };
        },
      } as never,
      capabilities: [],
      additionalTools: ['memory'],
      strategy: { name: 'unused', execute: vi.fn() } as never,
    });

    await runtime.reactLoop('capture schemas', {
      source: 'user',
      budgetOverride: { maxIterations: 1, timeoutMs: 1000 },
    });

    const directSchema = capture.toolSchemas?.find((schema) => schema.name === 'note_finding');
    expect(capture.toolSchemas?.some((schema) => schema.name === 'memory')).toBe(true);
    expect(directSchema).toBeDefined();
    expect((directSchema?.parameters as { required?: string[] }).required).toEqual(
      expect.arrayContaining(['finding', 'evidence', 'importance'])
    );
  });

  it('records accepted note_finding refs in PCVM node evidence', async () => {
    const progress: ProgressEvent[] = [];
    const chatWithTools = vi
      .fn()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [
          {
            id: 'finding-call-1',
            name: 'note_finding',
            args: {
              evidence: 'src/foo.ts:10',
              finding: 'Runtime evidence was verified',
              importance: 8,
            },
          },
        ],
        usage: { inputTokens: 2, outputTokens: 1 },
      })
      .mockResolvedValueOnce({
        text: 'done',
        functionCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    const toolRouter = {
      execute: vi.fn(async () =>
        createToolEnvelope('memory', 'recorded', {
          importance: 8,
          message: 'recorded',
          recorded: true,
          target: 'activeContext',
        })
      ),
    };
    const runtime = new AgentRuntime({
      aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: toolRouter as never,
      container: {
        get: (name: string) => {
          if (name !== 'capabilityCatalog') {
            return undefined;
          }
          return {
            toToolSchemas: (ids?: readonly string[] | null) =>
              ids?.includes('memory')
                ? [{ name: 'memory', description: 'Memory', parameters: { type: 'object' } }]
                : [],
          };
        },
      } as never,
      capabilities: [],
      additionalTools: ['memory'],
      strategy: { name: 'unused', execute: vi.fn() } as never,
      onProgress: (event) => progress.push(event),
    });

    const result = await runtime.reactLoop('record one verified finding', {
      source: 'system',
      context: { pipelinePhase: 'analyze', dimensionId: 'architecture' },
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });
    const toolEnd = progress
      .map((event) => event.processEvent)
      .find((event) => event?.title === 'Tool call completed: note_finding');
    const pcvEvidence = result.pcvNodeEvidence as {
      findingRefs: { accepted: Array<{ ref: string; sourceRefs: string[] }> };
    };
    const accepted = pcvEvidence.findingRefs.accepted[0];

    expect(toolRouter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          action: 'note_finding',
        }),
        toolId: 'memory',
      })
    );
    expect(accepted).toMatchObject({
      sourceRefs: ['src/foo.ts:10'],
    });
    expect(toolEnd?.metadata?.pcvNodeEvidence).toMatchObject({
      acceptedFindingRefs: [accepted.ref],
      sourceRefs: ['src/foo.ts:10'],
    });
  });

  it('does not force summary after abort exits', async () => {
    const { runtime, chatWithTools } = createRuntimeForReactLoop();
    const abortController = new AbortController();
    abortController.abort();

    const result = await runtime.reactLoop('analyze', {
      source: 'system',
      abortSignal: abortController.signal,
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.reply).toContain('abort_signal');
    expect(result.diagnostics?.efficiency?.forcedSummary).toBe(false);
    expect(result.diagnostics?.efficiency?.cancelReason).toBe('abort_signal');
  });

  it('does not force summary after stage timeout exits', async () => {
    const { runtime, chatWithTools } = createRuntimeForReactLoop();
    const diagnostics = new DiagnosticsCollector();
    diagnostics.recordTimedOutStage('analyze');
    diagnostics.recordCancelReason('stage_timeout');

    const result = await runtime.reactLoop('analyze', {
      source: 'system',
      tracker: createExitingTracker() as never,
      diagnostics,
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.reply).toContain('stage_timeout');
    expect(result.diagnostics?.efficiency?.forcedSummary).toBe(false);
    expect(result.diagnostics?.efficiency?.cancelReason).toBe('stage_timeout');
  });

  it('does not promote degraded_no_findings into a normal summary completion', async () => {
    const { runtime, chatWithTools } = createRuntimeForReactLoop();
    const diagnostics = new DiagnosticsCollector();
    diagnostics.recordGateFailure(
      'quality_gate',
      'degraded_no_findings',
      'Record repair did not produce enough validated note_finding records'
    );

    const result = await runtime.reactLoop('analyze', {
      source: 'system',
      tracker: createExitingTracker() as never,
      diagnostics,
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.reply).toContain('degraded_no_findings');
    expect(result.diagnostics?.degraded).toBe(true);
    expect(result.diagnostics?.efficiency?.forcedSummary).toBe(false);
  });

  it('hard-stops a system run when L4 compaction fails under runaway budget pressure', async () => {
    const originalEnableL4 = process.env.ALEMBIC_AGENT_ENABLE_L4_COMPACTION;
    process.env.ALEMBIC_AGENT_ENABLE_L4_COMPACTION = '1';
    const chatWithTools = vi.fn(async () => {
      throw new Error('l4 failed');
    });
    try {
      const runtime = new AgentRuntime({
        aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
        toolRegistry: { getManifest: () => null } as never,
        toolRouter: { execute: vi.fn() } as never,
        capabilities: [],
        strategy: { name: 'unused', execute: vi.fn() } as never,
      });
      const contextWindow = new ContextWindow(1, { thresholds: [0, 0, 0, 0, 0] });
      contextWindow.appendUserMessage('initial prompt');
      contextWindow.appendUserMessage('oversized context');

      const result = await runtime.reactLoop('analyze', {
        source: 'system',
        contextWindow,
        budgetOverride: {
          maxIterations: 2,
          timeoutMs: 1000,
          maxSessionInputTokens: 10,
        },
      });

      expect(chatWithTools).toHaveBeenCalledTimes(1);
      expect(result.reply).toContain('l4_compaction_failed_budget_exhausted');
      expect(result.diagnostics?.degraded).toBe(true);
      expect(result.diagnostics?.efficiency?.forcedSummary).toBe(false);
    } finally {
      if (originalEnableL4 === undefined) {
        delete process.env.ALEMBIC_AGENT_ENABLE_L4_COMPACTION;
      } else {
        process.env.ALEMBIC_AGENT_ENABLE_L4_COMPACTION = originalEnableL4;
      }
    }
  });
});
