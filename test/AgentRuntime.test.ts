import { createCanonicalSourceIdentity } from '@alembic/core';
import { describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { DiagnosticsCollector, type ProgressEvent } from '../src/agent/runtime/index.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';

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
  it('rejects oversized LLM input before calling the provider', async () => {
    const { runtime, chatWithTools } = createRuntimeForReactLoop();

    const result = await runtime.reactLoop('input too large', {
      source: 'user',
      budgetOverride: { maxIterations: 1, timeoutMs: 1000, maxProviderInputTokens: 1 },
    });

    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.reply).toContain('输入过长');
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({ code: 'LLM_INPUT_TOO_LARGE' })
    );
  });

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

  it('normalizes PCV note_finding refs with ProjectScope identities and drops ambiguous refs', async () => {
    const progress: ProgressEvent[] = [];
    const sourceIdentities = [
      createCanonicalSourceIdentity({
        folderDisplayName: 'Alembic',
        projectScopeId: 'workspace',
        sourcePath: 'bin/api-server.ts',
      }),
      createCanonicalSourceIdentity({
        folderDisplayName: 'AlembicCore',
        projectScopeId: 'workspace',
        sourcePath: 'index.ts',
      }),
      createCanonicalSourceIdentity({
        folderDisplayName: 'AlembicPlugin',
        projectScopeId: 'workspace',
        sourcePath: 'index.ts',
      }),
    ];
    const chatWithTools = vi
      .fn()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [
          {
            id: 'finding-call-1',
            name: 'note_finding',
            args: {
              evidence:
                'api-server.ts:10 is verified; index.ts:3 is ambiguous; AlembicCore/src/core/database.ts is missing.',
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
        createToolEnvelope(
          'memory',
          'recorded api-server.ts:10, index.ts:3, and AlembicCore/src/core/database.ts',
          {
            importance: 8,
            message: 'recorded',
            recorded: true,
            target: 'activeContext',
          }
        )
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
      context: {
        dimensionId: 'architecture',
        pipelinePhase: 'analyze',
        sourceIdentities,
      },
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });
    const toolEnd = progress
      .map((event) => event.processEvent)
      .find((event) => event?.title === 'Tool call completed: note_finding');
    const pcvEvidence = result.pcvNodeEvidence as {
      findingRefs: { accepted: Array<{ sourceRefs: string[] }> };
      missingLinkReasons: string[];
      sourceRefDiagnostics: Array<{ input: string; status: string }>;
      sourceRefs: string[];
    };

    expect(pcvEvidence.sourceRefs).toEqual(['Alembic/bin/api-server.ts:10']);
    expect(pcvEvidence.findingRefs.accepted[0]?.sourceRefs).toEqual([
      'Alembic/bin/api-server.ts:10',
    ]);
    expect(pcvEvidence.sourceRefDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ input: 'index.ts:3', status: 'ambiguous' }),
        expect.objectContaining({
          input: 'AlembicCore/src/core/database.ts',
          status: 'missing',
        }),
      ])
    );
    expect(pcvEvidence.missingLinkReasons).toContain('ambiguous-source-ref:index.ts:3');
    expect(pcvEvidence.missingLinkReasons).toContain(
      'missing-source-ref:AlembicCore/src/core/database.ts'
    );
    expect(toolEnd?.metadata?.pcvNodeEvidence).toMatchObject({
      sourceRefs: ['Alembic/bin/api-server.ts:10'],
      sourceRefDiagnostics: expect.arrayContaining([
        expect.objectContaining({ input: 'index.ts:3', status: 'ambiguous' }),
        expect.objectContaining({
          input: 'AlembicCore/src/core/database.ts',
          status: 'missing',
        }),
      ]),
    });
  });

  it('blocks DeepSeek V4 analyze text-only first burn without evidence grounding', async () => {
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
        evidenceStarters: {
          entry: { hint: 'src/known.ts:10 is a deterministic starter.' },
        },
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
    expect(tracker.endRound).toHaveBeenCalledTimes(1);
    expect(ledger.map((entry) => entry.classification)).toEqual([
      'invalid-no-evidence',
      'planning-only',
    ]);
    expect(ledger[1]?.consumedEvidenceRefs).toEqual(['src/known.ts:10']);
    expect(nudge?.content?.text).toContain('不能推进阶段');
  });

  it('keeps DeepSeek V4 analyze evidence tools visible without forcing required', async () => {
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
      toolRouter: {
        execute: vi.fn(async () =>
          createToolEnvelope('code', 'src/known.ts:10 contains verified code', {
            path: 'src/known.ts',
            sourceRefs: ['src/known.ts:10'],
          })
        ),
      } as never,
      container: {
        get: (name: string) => {
          if (name !== 'capabilityCatalog') {
            return undefined;
          }
          return {
            toToolSchemas: () => [
              {
                name: 'code',
                description: 'Code evidence tool',
                parameters: { type: 'object' },
              },
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
    const firstCall = captures[0] || {};
    const firstSchemas = firstCall.toolSchemas as Array<Record<string, unknown>> | undefined;
    const firstBurn = result.pcvNodeEvidence.groundingLedger[0];

    expect(firstSchemas?.map((schema) => schema.name)).toContain('code');
    expect(firstCall.toolChoice).toBe('auto');
    expect(firstCall.toolChoice).not.toBe('required');
    expect(firstBurn).toMatchObject({
      classification: 'evidence-produced',
      deepseekV4ToolChoiceMode: 'tools-visible-no-forced-tool-choice',
      effectiveToolChoice: 'auto',
      requestedToolChoice: 'none',
      toolChoiceSent: false,
      toolChoiceSupported: false,
      toolSchemasVisible: true,
    });
    expect(firstBurn).not.toHaveProperty('sourceRefDelta');
    expect(firstBurn?.outputSourceRefs).toEqual([]);
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
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({ code: 'ABORT_RECOVERY_RECORDED' })
    );
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
