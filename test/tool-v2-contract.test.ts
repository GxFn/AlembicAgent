import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/tools/v2/index.js';
import {
  DeltaCache,
  OutputCompressor,
  parseGitStatusOutput,
  SearchCache,
  ToolRouterV2,
  V2CapabilityCatalog,
  V2ToolRouterAdapter,
} from '../src/tools/v2/index.js';

function baseToolContext(): ToolContext {
  return {
    projectRoot: '/tmp/alembic-agent-tool-v2-test',
    tokenBudget: 4000,
  };
}

function strictKnowledgeSubmitParams(
  sourceRefs: string[],
  options?: { contentExtras?: Record<string, unknown>; markdown?: string }
) {
  return {
    title: 'Strict SourceRef contract',
    description: 'Records strict sourceRef validation before producer knowledge acceptance.',
    content: {
      markdown:
        options?.markdown ??
        'This candidate documents strict sourceRef producer validation for bootstrap knowledge submissions. '.repeat(
          4
        ),
      rationale:
        'The producer must only submit canonical project-relative source references that can be deterministically validated or safely repaired.',
      ...(options?.contentExtras ?? {}),
    },
    kind: 'pattern',
    trigger: 'Strict SourceRef contract',
    whenClause: 'When bootstrap producer submits knowledge candidates with sourceRefs.',
    doClause: 'Validate sourceRefs against canonical project-relative paths before acceptance.',
    reasoning: {
      sources: sourceRefs,
      confidence: 0.9,
    },
    sourceRefs,
  };
}

function strictProducerRuntime(canonicalRefs: string[]) {
  return {
    dimensionMeta: {
      allowedKnowledgeTypes: ['code-pattern'],
      id: 'design-patterns',
      outputType: 'candidate',
    },
    sharedState: {
      _canonicalSourceRefIndex: canonicalRefs.map((sourcePath, index) => ({
        aliases: [path.posix.basename(sourcePath)],
        basename: path.posix.basename(sourcePath),
        id: `file:${String(index + 1).padStart(3, '0')}`,
        path: sourcePath,
      })),
      _producerReferencedFiles: canonicalRefs,
      _sourceRefPolicy: {
        allowEntityOnlyRefs: false,
        allowGuessedPaths: false,
        mode: 'strict',
        sourceRefsMustComeFrom: 'canonicalSourceRefIndex',
      },
    },
  };
}

function captureRecipeGateway(createRequests: Array<{ items: Record<string, unknown>[] }>) {
  return {
    create: async (request: { items: Record<string, unknown>[] }) => {
      createRequests.push(request);
      return {
        blocked: [],
        created: [{ id: 'candidate-1', title: 'Strict SourceRef contract' }],
        duplicates: [],
        merged: [],
        rejected: [],
      };
    },
  };
}

describe('Tool V2 contract exports', () => {
  it('exports capability catalog projections from the V2 registry', () => {
    const catalog = new V2CapabilityCatalog();
    const schemas = catalog.toToolSchemas(['meta']);

    expect(catalog.has('meta')).toBe(true);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.name).toBe('meta');
    expect(schemas[0]?.parameters).toMatchObject({
      type: 'object',
    });

    catalog.markExpanded('meta');
    expect(catalog.expandedCount).toBe(1);
  });

  it('exports generic delta and search cache contracts', () => {
    const deltaCache = new DeltaCache(1);
    const first = deltaCache.check('a.ts', 'one\ntwo');
    const unchanged = deltaCache.check('a.ts', 'one\ntwo');
    const changed = deltaCache.check('a.ts', 'one\nthree');

    expect(first.mode).toBe('full');
    expect(unchanged.mode).toBe('unchanged');
    expect(changed.mode).toBe('delta');

    const searchCache = new SearchCache(1);
    const key = SearchCache.makeKey('AgentRuntime', '*.ts');
    searchCache.set(key, { matches: 1 });

    expect(searchCache.get(key)).toEqual({ matches: 1 });
    expect(searchCache.size).toBe(1);
  });

  it('exports output compressor and parser utilities', async () => {
    const gitStatus = [
      'On branch main',
      'Changes not staged for commit:',
      '  modified:   src/index.ts',
      '',
    ].join('\n');
    const parsed = parseGitStatusOutput(gitStatus);
    const compressed = await new OutputCompressor().compress(gitStatus, {
      command: 'git status',
      tokenBudget: 200,
    });

    expect(parsed).toContain('modified');
    expect(compressed).toContain('modified');
  });

  it('routes V2 calls through generic router and adapter contracts', async () => {
    const router = new ToolRouterV2();
    const parsed = router.parseToolCall('meta', {
      action: 'tools',
      params: { name: 'meta' },
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, baseToolContext());
    expect(result.ok).toBe(true);
    expect(String(result.data)).toContain('[meta]');

    const adapter = new V2ToolRouterAdapter({
      contextFactory: {
        create: () => baseToolContext(),
      },
    });
    const envelope = await adapter.execute({
      toolId: 'meta',
      args: { action: 'tools', params: { name: 'meta' } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime', name: 'vitest' },
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.text).toContain('[meta]');
    expect(envelope.cache?.policy).toBe('none');
  });

  it('writes new knowledge submissions with the Alembic Agent source by default', async () => {
    const router = new ToolRouterV2();
    const createRequests: Array<{
      source: string;
      items: Record<string, unknown>[];
      options?: Record<string, unknown>;
    }> = [];
    const parsed = router.parseToolCall('knowledge', {
      action: 'submit',
      params: {
        title: 'Tool V2 source boundary',
        description: 'Records the Agent runtime as the default source for new knowledge writes.',
        content: {
          markdown:
            'This candidate documents the Tool V2 source boundary for Agent runtime writes. '.repeat(
              4
            ),
          rationale:
            'The source value must distinguish Alembic Agent owned writes from legacy IDE agent compatibility inputs.',
        },
        kind: 'pattern',
        trigger: 'Tool V2 source boundary',
        whenClause: 'When the Agent runtime submits a new knowledge candidate through Tool V2.',
        doClause: 'Persist alembic-agent as the default source for the submitted candidate.',
        reasoning: {
          sources: ['src/tools/v2/handlers/knowledge.ts'],
          confidence: 0.9,
        },
      },
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, {
      ...baseToolContext(),
      recipeGateway: {
        create: async (request: {
          source: string;
          items: Record<string, unknown>[];
          options?: Record<string, unknown>;
        }) => {
          createRequests.push(request);
          return {
            created: [{ id: 'candidate-1', title: 'Tool V2 source boundary' }],
            rejected: [],
            duplicates: [],
            merged: [],
            blocked: [],
          };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(createRequests[0]?.source).toBe('alembic-agent');
    expect(createRequests[0]?.options?.userId).toBe('alembic-agent');
    expect(createRequests[0]?.items[0]?.source).toBe('alembic-agent');
  });

  it('grounds knowledge sourceRefs against project files and trusted analysis refs', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-agent-source-ref-'));
    fs.mkdirSync(path.join(projectRoot, 'src/verified'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src/verified/Existing.ts'), 'export const ok = true;');

    const router = new ToolRouterV2();
    const createRequests: Array<{ items: Record<string, unknown>[] }> = [];
    const parsed = router.parseToolCall('knowledge', {
      action: 'submit',
      params: {
        title: 'SourceRef grounding boundary',
        description: 'Records sourceRef grounding without hiding invalid producer references.',
        content: {
          markdown:
            'This candidate documents sourceRef grounding for producer-owned knowledge submissions. '.repeat(
              4
            ),
          rationale:
            'The handler should normalize references only when project files or trusted analysis refs prove the path.',
        },
        kind: 'pattern',
        trigger: 'SourceRef grounding boundary',
        whenClause: 'When the producer submits sourceRefs collected from analysis evidence.',
        doClause: 'Prefer verified relative paths and preserve unverified refs for N11 scorecard.',
        reasoning: {
          sources: ['Existing.ts:4', 'Invented.swift'],
          confidence: 0.9,
        },
        sourceRefs: ['Existing.ts:4', 'Invented.swift'],
      },
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, {
      ...baseToolContext(),
      projectRoot,
      runtime: {
        sharedState: {
          _producerReferencedFiles: ['src/verified/Existing.ts'],
        },
      },
      recipeGateway: {
        create: async (request: { items: Record<string, unknown>[] }) => {
          createRequests.push(request);
          return {
            created: [{ id: 'candidate-1', title: 'SourceRef grounding boundary' }],
            rejected: [],
            duplicates: [],
            merged: [],
            blocked: [],
          };
        },
      },
    });

    expect(result.ok).toBe(true);
    const item = createRequests[0]?.items[0] as {
      agentNotes?: { sourceRefGrounding?: Record<string, unknown> };
      reasoning?: { sources?: string[] };
      sourceRefs?: string[];
    };
    expect(item.sourceRefs).toEqual(['src/verified/Existing.ts:4', 'Invented.swift']);
    expect(item.reasoning?.sources).toEqual(['src/verified/Existing.ts:4', 'Invented.swift']);
    expect(item.agentNotes?.sourceRefGrounding).toMatchObject({
      sourceRefs: {
        normalized: [
          {
            from: 'Existing.ts:4',
            to: 'src/verified/Existing.ts:4',
            reason: 'missing-prefix-unique-basename',
          },
        ],
        warnings: [
          {
            ref: 'Invented.swift',
            reason:
              'sourceRef was not found in projectRoot or trusted analysis refs; preserved for downstream N11 scorecard',
          },
        ],
      },
    });
  });

  it('repairs strict bootstrap producer sourceRefs before knowledge acceptance', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-agent-strict-repair-'));
    fs.mkdirSync(path.join(projectRoot, 'Sources/Infrastructure/Account'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Demo');
    fs.writeFileSync(
      path.join(projectRoot, 'Sources/Infrastructure/Account/CookieManager.swift'),
      'final class CookieManager {}'
    );

    const router = new ToolRouterV2();
    const createRequests: Array<{ items: Record<string, unknown>[] }> = [];
    const parsed = router.parseToolCall('knowledge', {
      action: 'submit',
      params: strictKnowledgeSubmitParams(['README.m', 'CookieManager.swift']),
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, {
      ...baseToolContext(),
      projectRoot,
      recipeGateway: captureRecipeGateway(createRequests),
      runtime: strictProducerRuntime([
        'README.md',
        'Sources/Infrastructure/Account/CookieManager.swift',
      ]),
    });

    expect(result.ok).toBe(true);
    const item = createRequests[0]?.items[0] as {
      sourceRefValidation?: {
        repairedSourceRefs?: Array<{ from: string; reason: string; to: string }>;
        status?: string;
      };
      sourceRefs?: string[];
    };
    expect(item.sourceRefs).toEqual([
      'README.md',
      'Sources/Infrastructure/Account/CookieManager.swift',
    ]);
    expect(item.sourceRefValidation).toMatchObject({
      repairedSourceRefs: expect.arrayContaining([
        { from: 'README.m', reason: 'wrong-extension-unique-sibling', to: 'README.md' },
        {
          from: 'CookieManager.swift',
          reason: 'missing-prefix-unique-basename',
          to: 'Sources/Infrastructure/Account/CookieManager.swift',
        },
      ]),
      status: 'repaired',
    });
  });

  it('repairs strict bootstrap producer content source citations before knowledge acceptance', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'alembic-agent-strict-content-repair-')
    );
    fs.mkdirSync(path.join(projectRoot, 'Sources/Feature'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'Sources/Feature/Feature.swift'), 'struct Feature {}');

    const router = new ToolRouterV2();
    const createRequests: Array<{ items: Record<string, unknown>[] }> = [];
    const parsed = router.parseToolCall('knowledge', {
      action: 'submit',
      params: strictKnowledgeSubmitParams(['Sources/Feature/Feature.swift'], {
        contentExtras: {
          sourceLabels: ['Feature.swift:12'],
        },
        markdown: `${'This candidate documents strict content citation repair for bootstrap producer knowledge submissions. '.repeat(
          3
        )}(来源: Feature.swift:12)`,
      }),
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, {
      ...baseToolContext(),
      projectRoot,
      recipeGateway: captureRecipeGateway(createRequests),
      runtime: strictProducerRuntime(['Sources/Feature/Feature.swift']),
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      sourceRefValidation: {
        repairedSourceRefs: expect.arrayContaining([
          {
            from: 'Feature.swift:12',
            location: 'content.markdown/source-label',
            reason: 'missing-prefix-unique-basename',
            to: 'Sources/Feature/Feature.swift:12',
          },
          {
            from: 'Feature.swift:12',
            location: 'content.sourceLabels[0]',
            reason: 'missing-prefix-unique-basename',
            to: 'Sources/Feature/Feature.swift:12',
          },
        ]),
        status: 'repaired',
      },
    });
    const item = createRequests[0]?.items[0] as {
      content?: { markdown?: string; sourceLabels?: string[] };
      sourceRefValidation?: { repairedSourceRefs?: Array<{ location?: string }> };
    };
    expect(item.content?.markdown).toContain('(来源: Sources/Feature/Feature.swift:12)');
    expect(item.content?.sourceLabels).toEqual(['Sources/Feature/Feature.swift:12']);
    expect(item.sourceRefValidation?.repairedSourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ location: 'content.markdown/source-label' }),
      ])
    );
  });

  it('accepts canonical strict bootstrap producer content source citations', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'alembic-agent-strict-content-valid-')
    );
    fs.mkdirSync(path.join(projectRoot, 'Sources/Feature'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'Sources/Feature/Feature.swift'), 'struct Feature {}');

    const router = new ToolRouterV2();
    const createRequests: Array<{ items: Record<string, unknown>[] }> = [];
    const parsed = router.parseToolCall('knowledge', {
      action: 'submit',
      params: strictKnowledgeSubmitParams(['Sources/Feature/Feature.swift'], {
        markdown: `${'This candidate documents strict content citation validation for canonical source labels. '.repeat(
          3
        )}(来源: Sources/Feature/Feature.swift:12)`,
      }),
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, {
      ...baseToolContext(),
      projectRoot,
      recipeGateway: captureRecipeGateway(createRequests),
      runtime: strictProducerRuntime(['Sources/Feature/Feature.swift']),
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      sourceRefValidation: {
        rejectedSourceRefs: [],
        repairedSourceRefs: [],
        status: 'valid',
      },
    });
    const item = createRequests[0]?.items[0] as {
      content?: { markdown?: string };
      sourceRefValidation?: { status?: string };
    };
    expect(item.content?.markdown).toContain('(来源: Sources/Feature/Feature.swift:12)');
    expect(item.sourceRefValidation?.status).toBe('valid');
  });

  it('rejects strict bootstrap producer sourceRefs with typed reasons', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-agent-strict-reject-'));
    const canonicalRefs = [
      'Packages/AOXFoundationKit/Sources/AOXFoundationKit/Network/NetworkMonitor.swift',
      'Sources/Feature/Duplicate.swift',
      'Tests/Feature/Duplicate.swift',
    ];
    for (const ref of canonicalRefs) {
      fs.mkdirSync(path.dirname(path.join(projectRoot, ref)), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, ref), `// ${ref}`);
    }
    const outsideFile = path.join(os.tmpdir(), `outside-${Date.now()}.swift`);
    fs.writeFileSync(outsideFile, '// outside project root');

    const cases = [
      {
        ref: 'Sources/Infrastructure/Networking/NetworkMonitor.swift',
        reason: 'package-path-mismatch',
      },
      { ref: 'ClosureCookieProvider.swift', reason: 'entity-not-file' },
      { ref: outsideFile, reason: 'outside-project-root' },
      { ref: 'Duplicate.swift', reason: 'ambiguous-basename' },
    ];

    for (const testCase of cases) {
      const router = new ToolRouterV2();
      const createRequests: Array<{ items: Record<string, unknown>[] }> = [];
      const parsed = router.parseToolCall('knowledge', {
        action: 'submit',
        params: strictKnowledgeSubmitParams([testCase.ref]),
      });

      expect('error' in parsed).toBe(false);
      if ('error' in parsed) {
        throw new Error(parsed.error);
      }

      const result = await router.execute(parsed, {
        ...baseToolContext(),
        projectRoot,
        recipeGateway: captureRecipeGateway(createRequests),
        runtime: strictProducerRuntime(canonicalRefs),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain(testCase.reason);
      expect(createRequests).toHaveLength(0);
      expect(result.data).toMatchObject({
        sourceRefValidation: {
          rejectedSourceRefs: expect.arrayContaining([
            expect.objectContaining({ reason: testCase.reason, ref: testCase.ref }),
          ]),
          status: 'rejected',
        },
      });
    }
  });

  it('rejects strict bootstrap producer invalid content source citations with location', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'alembic-agent-strict-content-reject-')
    );
    fs.mkdirSync(path.join(projectRoot, 'Sources/Feature'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'Sources/Feature/Feature.swift'), 'struct Feature {}');

    const router = new ToolRouterV2();
    const createRequests: Array<{ items: Record<string, unknown>[] }> = [];
    const parsed = router.parseToolCall('knowledge', {
      action: 'submit',
      params: strictKnowledgeSubmitParams(['Sources/Feature/Feature.swift'], {
        markdown: `${'This candidate documents strict content citation rejection before candidate creation. '.repeat(
          3
        )}(来源: AppCoordinator.swift:14)`,
      }),
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, {
      ...baseToolContext(),
      projectRoot,
      recipeGateway: captureRecipeGateway(createRequests),
      runtime: strictProducerRuntime(['Sources/Feature/Feature.swift']),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('content.markdown/source-label AppCoordinator.swift:14');
    expect(result.error).toContain('entity-not-file');
    expect(createRequests).toHaveLength(0);
    expect(result.data).toMatchObject({
      sourceRefValidation: {
        rejectedSourceRefs: expect.arrayContaining([
          {
            location: 'content.markdown/source-label',
            reason: 'entity-not-file',
            ref: 'AppCoordinator.swift:14',
          },
        ]),
        status: 'rejected',
      },
    });
  });

  it('defaults evolution decisions to alembic-agent while preserving legacy and domain sources', async () => {
    const router = new ToolRouterV2();

    async function captureEvolutionSource(source?: string): Promise<unknown> {
      const submitted: Array<{ source: unknown }> = [];
      const result = await router.execute(
        {
          tool: 'knowledge',
          action: 'manage',
          params: { operation: 'evolve', id: 'recipe-1' },
        },
        {
          ...baseToolContext(),
          runtime: source ? { sharedState: { evolutionProposalSource: source } } : {},
          evolutionGateway: {
            submit: async (decision: {
              recipeId: string;
              action: string;
              source: unknown;
              confidence: number;
            }) => {
              submitted.push(decision);
              return {
                recipeId: decision.recipeId,
                action: decision.action,
                outcome: 'proposal-created',
                proposalId: 'proposal-1',
              };
            },
          },
        }
      );

      expect(result.ok).toBe(true);
      return submitted[0]?.source;
    }

    await expect(captureEvolutionSource()).resolves.toBe('alembic-agent');
    await expect(captureEvolutionSource('ide-agent')).resolves.toBe('ide-agent');
    await expect(captureEvolutionSource('file-change')).resolves.toBe('file-change');
    await expect(captureEvolutionSource('rescan-evolution')).resolves.toBe('rescan-evolution');
  });
});
