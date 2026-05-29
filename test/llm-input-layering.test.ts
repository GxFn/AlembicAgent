import { describe, expect, it, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/ExplorationTracker.js';
import { STRATEGY_PRODUCER } from '../src/agent/context/exploration/ExplorationStrategies.js';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import {
  buildProducerPromptV2,
  PRODUCER_SYSTEM_PROMPT,
} from '../src/agent/prompts/insight-producer.js';
import {
  AgentRuntime,
  type ProgressEvent,
  SystemPromptBuilder,
} from '../src/agent/runtime/index.js';

function createRuntime({
  chatWithTools,
  onProgress,
  toolSchemas = [],
}: {
  chatWithTools: ReturnType<typeof vi.fn>;
  onProgress?: (event: ProgressEvent) => void;
  toolSchemas?: Array<Record<string, unknown>>;
}) {
  return new AgentRuntime({
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
            toolSchemas.filter((schema) => ids?.includes(String(schema.name))),
        };
      },
    } as never,
    capabilities: [],
    strategy: { name: 'unused', execute: vi.fn() } as never,
    onProgress,
  });
}

function createTracker({
  phase,
  pipelineType = 'analyst',
  toolChoice = 'none',
  phaseContext = null,
}: {
  phase: string;
  pipelineType?: string;
  toolChoice?: string;
  phaseContext?: string | null;
}) {
  return {
    phase,
    pipelineType,
    isGracefulExit: false,
    isHardExit: false,
    iteration: 0,
    totalSubmits: 0,
    tick: vi.fn(),
    shouldExit: vi.fn(() => false),
    getNudge: vi.fn(() => null),
    getPhaseContext: vi.fn(() => phaseContext),
    getToolChoice: vi.fn(() => toolChoice),
    getMetrics: vi.fn(() => ({
      evidenceToolCallCount: 0,
      iteration: 0,
      memoryFindingCount: 0,
      phase,
      phaseRounds: 0,
      submitCount: 0,
      totalToolCalls: 0,
    })),
    getPlanProgress: vi.fn(() => ({ coveredSteps: 0, totalSteps: 0 })),
    recordToolCall: vi.fn(() => ({ isNew: true })),
    endRound: vi.fn(() => null),
    onTextResponse: vi.fn(() => ({
      isFinalAnswer: true,
      needsDigestNudge: false,
      shouldContinue: false,
      nudge: null,
    })),
  };
}

function getLlmInput(progress: ProgressEvent[]) {
  return progress.map((event) => event.processEvent).find((event) => event?.kind === 'llm.input');
}

describe('LLM input layering', () => {
  it('adds producer sourceRef grounding guidance from verified analysis refs', () => {
    const prompt = buildProducerPromptV2(
      {
        analysisText: 'Verified behavior comes from Sources/App/Feature.swift:12.',
        evidenceMap: new Map([
          [
            'Sources/App/Feature.swift',
            {
              codeSnippets: [
                {
                  content: 'struct Feature {}',
                  endLine: 12,
                  startLine: 12,
                },
              ],
              filePath: 'Sources/App/Feature.swift',
              summary: 'Feature source file',
            },
          ],
        ]),
        findings: [{ finding: 'Feature boundary', importance: 8 }],
        negativeSignals: [],
        referencedFiles: ['Sources/App/Feature.swift'],
      },
      { id: 'architecture', label: 'Architecture' },
      { name: 'Demo' }
    );

    expect(prompt).toContain('SourceRef grounding policy');
    expect(prompt).toContain('Sources/App/Feature.swift');
    expect(prompt).toContain('不要只写文件名、模块名、目录别名');
    expect(prompt).toContain('不要在 sourceRefs 中编造路径');
  });

  it('projects explicit input sections into both provider messages and developer-visible llm.input', async () => {
    const progress: ProgressEvent[] = [];
    const capture: { messages?: Array<{ role: string; content?: string }> } = {};
    const chatWithTools = vi.fn(async (_prompt: string, opts?: Record<string, unknown>) => {
      capture.messages = opts?.messages as Array<{ role: string; content?: string }>;
      return { text: 'done', functionCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const runtime = createRuntime({
      chatWithTools,
      onProgress: (event) => progress.push(event),
    });
    const tracker = createTracker({
      phase: 'SCAN',
      phaseContext: 'SCAN briefing: produce a small plan before tools.',
    });

    const result = await runtime.reactLoop('analyze with apiKey=visibleInputSecret12345', {
      source: 'system',
      context: { pipelinePhase: 'analyze', dimensionId: 'architecture' },
      systemPromptOverride: 'Analyst identity prompt',
      tracker: tracker as never,
      budgetOverride: { maxIterations: 1, timeoutMs: 1000 },
    });

    const llmInput = getLlmInput(progress);
    const inputText = llmInput?.content?.text || '';
    const providerLayer = capture.messages?.at(-1)?.content || '';

    expect(providerLayer).toContain('# LLM input runtime layer');
    expect(providerLayer).toContain('## Stage policy');
    expect(providerLayer).toContain('## Tool contract');
    expect(providerLayer).toContain('## Task context');
    expect(providerLayer).toContain('## Evidence context');
    expect(providerLayer).toContain('## Dynamic context');
    expect(inputText).toContain('## Identity (static)');
    expect(inputText).toContain('## Stage policy');
    expect(inputText).toContain('## Tool contract');
    expect(inputText).toContain('## Task context');
    expect(inputText).toContain('## Evidence context');
    expect(inputText).toContain('## Dynamic context');
    expect(inputText).toContain('analyze with apiKey=');
    expect(inputText).not.toContain('visibleInputSecret12345');
    expect(llmInput?.metadata).toMatchObject({
      inputLayerAppended: true,
      inputStageProfile: 'analyze',
      pcvNodeEvidence: {
        inputAssemblyRef: expect.stringMatching(/^llm-input:/),
        stageIdentity: { stageProfile: 'analyze' },
      },
    });
    expect(JSON.stringify(llmInput?.metadata?.pcvNodeEvidence)).not.toContain(
      'visibleInputSecret12345'
    );
    expect(result.pcvNodeEvidence).toMatchObject({
      inputAssembly: {
        ref: expect.stringMatching(/^llm-input:/),
        stageProfile: 'analyze',
      },
      stageIdentity: { pipelinePhase: 'analyze', stageProfile: 'analyze' },
    });
  });

  it('uses canonical stage node identity in llm input process metadata', async () => {
    const progress: ProgressEvent[] = [];
    const chatWithTools = vi.fn(async () => ({
      text: 'done',
      functionCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const runtime = createRuntime({
      chatWithTools,
      onProgress: (event) => progress.push(event),
    });
    const tracker = createTracker({ phase: 'SCAN' });

    const result = await runtime.reactLoop('analyze canonical node identity', {
      source: 'system',
      context: {
        dimensionId: 'architecture',
        pcvStageNodeMap: {
          analyze: {
            chainNodeId: 'pcvm:cold-start:n9',
            pcvNodeId: 'pcvm:n9:analyze',
          },
        },
        pipelinePhase: 'analyze',
      },
      systemPromptOverride: 'Analyst identity prompt',
      tracker: tracker as never,
      budgetOverride: { maxIterations: 1, timeoutMs: 1000 },
    });

    const llmInput = getLlmInput(progress);

    expect(llmInput?.metadata).toMatchObject({
      pcvNodeEvidence: {
        chainNodeId: 'pcvm:cold-start:n9',
        inputAssemblyRef: expect.stringMatching(/^llm-input:/),
        nodeId: 'pcvm:n9:analyze',
      },
    });
    expect(result.pcvNodeEvidence).toMatchObject({
      chainNodeId: 'pcvm:cold-start:n9',
      inputAssembly: { ref: expect.stringMatching(/^llm-input:/) },
      nodeId: 'pcvm:n9:analyze',
      stageIdentity: { pipelinePhase: 'analyze', stageProfile: 'analyze' },
    });
  });

  it('injects observation ledger dynamic context without raw tool envelope fields', async () => {
    const progress: ProgressEvent[] = [];
    const capture: { messages?: Array<{ role: string; content?: string }> } = {};
    const chatWithTools = vi.fn(async (_prompt: string, opts?: Record<string, unknown>) => {
      capture.messages = opts?.messages as Array<{ role: string; content?: string }>;
      return { text: 'done', functionCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const runtime = createRuntime({
      chatWithTools,
      onProgress: (event) => progress.push(event),
    });
    const memoryCoordinator = new MemoryCoordinator();
    const activeContext = memoryCoordinator.createDimensionScope('architecture:analyst', {
      maxRecentRounds: 1,
    });
    activeContext.recordToolCall(
      'code',
      { action: 'read', path: 'src/agent/memory/ActiveContext.ts' },
      {
        ok: true,
        toolId: 'code',
        callId: 'raw-call-id',
        startedAt: '2026-05-25T00:00:00.000Z',
        durationMs: 12,
        status: 'success',
        text: '{"callId":"raw-call-id","startedAt":"2026-05-25","durationMs":12}',
        structuredContent: {
          path: 'src/agent/memory/ActiveContext.ts',
          content: 'class ActiveContext {}',
        },
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
      },
      true
    );
    activeContext.recordToolCall(
      'code',
      { action: 'search', pattern: 'ActiveContext', glob: 'src/**' },
      {
        ok: true,
        toolId: 'code',
        callId: 'raw-search-call-id',
        startedAt: '2026-05-25T00:00:01.000Z',
        durationMs: 8,
        status: 'success',
        text: '1 matches (showing 1)\n\nsrc/agent/memory/ActiveContext.ts:1: ActiveContext',
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
      },
      true
    );
    const tracker = createTracker({ phase: 'SCAN' });

    await runtime.reactLoop('analyze active context ledger', {
      source: 'system',
      context: {
        pipelinePhase: 'analyze',
        dimensionId: 'architecture',
        dimensionScopeId: 'architecture:analyst',
      },
      memoryCoordinator,
      trace: activeContext as never,
      systemPromptOverride: 'Analyst identity prompt',
      tracker: tracker as never,
      budgetOverride: { maxIterations: 1, timeoutMs: 1000 },
    });

    const providerLayer = capture.messages?.at(-1)?.content || '';
    const llmInput = getLlmInput(progress);

    expect(providerLayer).toContain('## Dynamic context');
    expect(providerLayer).toContain('## Observation Ledger');
    expect(providerLayer).toContain('### readSet');
    expect(providerLayer).toContain('src/agent/memory/ActiveContext.ts');
    expect(providerLayer).not.toContain('之前的探索摘要');
    expect(providerLayer).not.toContain('callId');
    expect(providerLayer).not.toContain('startedAt');
    expect(providerLayer).not.toContain('durationMs');
    expect(llmInput?.metadata).toMatchObject({
      inputLayerAppended: true,
      inputStageProfile: 'analyze',
      pcvNodeEvidence: {
        inputAssemblyRef: expect.stringMatching(/^llm-input:/),
        ledgerRefs: ['active-context:architecture:analyst'],
      },
    });
  });

  it('keeps RECORD as a note_finding-only stage without exploration instructions', async () => {
    const progress: ProgressEvent[] = [];
    const capture: {
      toolSchemas?: Array<Record<string, unknown>>;
      messages?: Array<{ content?: string }>;
    } = {};
    const chatWithTools = vi.fn(async (_prompt: string, opts?: Record<string, unknown>) => {
      capture.toolSchemas = opts?.toolSchemas as Array<Record<string, unknown>>;
      capture.messages = opts?.messages as Array<{ content?: string }>;
      return { text: 'done', functionCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const runtime = createRuntime({
      chatWithTools,
      onProgress: (event) => progress.push(event),
      toolSchemas: [
        { name: 'memory', description: 'Memory', parameters: { type: 'object' } },
        { name: 'code', description: 'Code', parameters: { type: 'object' } },
        { name: 'graph', description: 'Graph', parameters: { type: 'object' } },
      ],
    });
    const tracker = createTracker({ phase: 'RECORD', toolChoice: 'required' });

    await runtime.reactLoop('record confirmed findings', {
      source: 'system',
      additionalToolsOverride: ['memory', 'code', 'graph'],
      context: { pipelinePhase: 'analyze' },
      systemPromptOverride: 'Record identity prompt',
      tracker: tracker as never,
      budgetOverride: { maxIterations: 1, timeoutMs: 1000 },
    });

    const providerLayer = capture.messages?.at(-1)?.content || '';
    const llmInput = getLlmInput(progress);
    const inputText = llmInput?.content?.text || '';

    expect(capture.toolSchemas?.map((schema) => schema.name)).toEqual(['note_finding']);
    expect(providerLayer).toContain('stageProfile: record');
    expect(providerLayer).toContain('Record-only phase');
    expect(providerLayer).not.toContain('code({ action');
    expect(providerLayer).not.toContain('graph({ action');
    expect(inputText).toContain('## Stage policy');
    expect(inputText).toContain('Only note_finding is valid');
    expect(llmInput?.metadata).toMatchObject({ inputStageProfile: 'record' });
  });

  it('gives Producer its own profile and budget instead of Analyst exploration policy', async () => {
    const progress: ProgressEvent[] = [];
    const capture: { systemPrompt?: string; messageBatches: Array<Array<{ content?: string }>> } = {
      messageBatches: [],
    };
    const chatWithTools = vi.fn(async (_prompt: string, opts?: Record<string, unknown>) => {
      capture.systemPrompt = opts?.systemPrompt as string;
      capture.messageBatches.push((opts?.messages as Array<{ content?: string }>) || []);
      return { text: 'done', functionCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const runtime = createRuntime({
      chatWithTools,
      onProgress: (event) => progress.push(event),
      toolSchemas: [
        { name: 'code', description: 'Code', parameters: { type: 'object' } },
        { name: 'knowledge', description: 'Knowledge', parameters: { type: 'object' } },
      ],
    });
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { maxIterations: 3, pipelineType: 'producer' }
    );

    await runtime.reactLoop('produce knowledge candidates', {
      source: 'system',
      additionalToolsOverride: ['code', 'knowledge'],
      context: {
        pcvStageNodeMap: {
          produce: {
            chainNodeId: 'pcvm:cold-start:n11',
            pcvNodeId: 'pcvm:n11:produce',
          },
        },
        pipelinePhase: 'produce',
      },
      systemPromptOverride: PRODUCER_SYSTEM_PROMPT,
      tracker: tracker as never,
      budgetOverride: { maxIterations: 3, timeoutMs: 1000 },
    });

    const llmInput = getLlmInput(progress);
    const providerLayer = capture.messageBatches[0]?.at(-1)?.content || '';

    expect(capture.systemPrompt).toContain('## Producer 轮次预算');
    expect(capture.systemPrompt).not.toContain('探索阶段');
    expect(capture.systemPrompt).not.toContain('结构化查询');
    expect(providerLayer).toContain('stageProfile: produce');
    expect(providerLayer).toContain('Producer phase');
    expect(providerLayer).not.toContain('graph({ action');
    expect(llmInput?.metadata).toMatchObject({
      inputStageProfile: 'produce',
      pcvNodeEvidence: {
        chainNodeId: 'pcvm:cold-start:n11',
        nodeId: 'pcvm:n11:produce',
      },
    });
  });

  it('renders producer budget directly from SystemPromptBuilder without Analyst search phases', () => {
    const prompt = SystemPromptBuilder.injectBudget('Producer identity', {
      source: 'system',
      tracker: { phase: 'PRODUCE', pipelineType: 'producer' },
      budget: { maxIterations: 5 },
    });

    expect(prompt).toContain('## Producer 轮次预算');
    expect(prompt).toContain('总轮次: **5 轮**');
    expect(prompt).not.toContain('探索阶段');
    expect(prompt).not.toContain('结构化查询');
  });

  it('resolves producer trackers as producer pipeline type by default', () => {
    const tracker = new ExplorationTracker(STRATEGY_PRODUCER, { maxIterations: 2 });

    expect(tracker.pipelineType).toBe('producer');
    expect(tracker.phase).toBe('PRODUCE');
  });
});
