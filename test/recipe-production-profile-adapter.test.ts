import fs from 'node:fs';
import path from 'node:path';
import {
  computeRecipeSourceContentHash,
  KnowledgeRepositoryImpl,
  type ProducerContext,
  projectRecipeRetrievalDocumentSet,
  type RecipeProductionInput,
  type RetrievalReadinessReport,
} from '@alembic/core';
import { DatabaseConnection } from '@alembic/core/database';
import { pathGuard } from '@alembic/core/io';
import {
  KnowledgeFileWriter,
  KnowledgeService,
  parseKnowledgeMarkdown,
  RecipeProductionGateway,
} from '@alembic/core/knowledge';
import { describe, expect, test, vi } from 'vitest';
import { handle as handleKnowledge } from '../src/tools/runtime/handlers/knowledge.js';
import { prepareRecipeProductionItem } from '../src/tools/runtime/handlers/recipeProductionAdapter.js';
import { createTempProject } from './helpers/tempProject.js';

function makeProject() {
  const projectRoot = createTempProject('agent-recipe-profile-');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'src/a.ts'),
    [
      '// header',
      "import type { User } from './user.js';",
      'export const count = 1;',
      '// footer',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(projectRoot, 'docs/design.md'),
    [
      '# Design',
      'Use import type for type-only dependencies.',
      'Do not emit runtime imports.',
    ].join('\n')
  );
  return projectRoot;
}

function authoredProfile() {
  return {
    primaryLanguage: 'zh',
    summary: {
      primary: '类型专用依赖使用 import type，避免生成运行时导入。',
      technicalEnglish:
        'Use import type for type-only dependencies so compilation emits no runtime import.',
    },
    concepts: [
      {
        term: 'type-only import',
        language: 'en',
        provenanceRefs: ['field:description'],
      },
    ],
    scenarios: [
      {
        text: 'When a module consumes a TypeScript type without a runtime value.',
        language: 'en',
        provenanceRefs: ['field:whenClause'],
      },
    ],
    exclusions: [
      {
        text: 'Do not use a value import for a type-only dependency.',
        language: 'en',
        provenanceRefs: ['field:dontClause'],
      },
    ],
    provenance: {
      sourceFieldRefs: ['field:description', 'field:whenClause', 'field:dontClause'],
    },
  };
}

function documentationGroundedProfile() {
  const profile = authoredProfile();
  profile.concepts[0].provenanceRefs = ['docs/design.md:1-3'];
  profile.provenance.sourceFieldRefs = ['field:whenClause', 'field:dontClause'];
  return profile;
}

function submitParams(overrides: Record<string, unknown> = {}) {
  return {
    title: 'ImportType keeps type-only dependencies out of runtime output',
    description: '类型专用依赖使用 import type，避免生成运行时导入。',
    content: {
      markdown: [
        '## ImportType runtime boundary',
        '',
        'Type-only dependencies use `import type`, so compilation does not emit a runtime import.',
        'This keeps the dependency graph explicit and prevents an accidental runtime edge. '.repeat(
          3
        ),
        '',
        '```ts',
        "import type { User } from './user.js';",
        'export const count = 1;',
        '```',
        '',
        '(Source: src/a.ts:2-3)',
        '✅ Correct: use import type for a type-only dependency.',
        '❌ Wrong: use a value import when no runtime value is consumed.',
      ].join('\n'),
      rationale:
        'The source keeps a type-only dependency out of emitted JavaScript and the runtime graph.',
    },
    kind: 'fact',
    trigger: '@type-only-import',
    whenClause: 'When a module consumes a TypeScript type without a runtime value.',
    doClause: 'Use import type for every type-only dependency.',
    dontClause: 'Do not use a value import for a type-only dependency.',
    coreCode: "import type { User } from './user.js';\nexport const count = 1;",
    reasoning: {
      whyStandard: 'The cited source demonstrates the emitted-runtime boundary.',
      sources: ['src/a.ts:2-3'],
      confidence: 0.95,
    },
    retrievalProfile: authoredProfile(),
    ...overrides,
  };
}

function directProductionParams(overrides: Record<string, unknown> = {}) {
  const base = submitParams();
  const overrideReasoning = (overrides.reasoning ?? {}) as Record<string, unknown>;
  const { reasoning: _reasoning, ...restOverrides } = overrides;
  return {
    ...base,
    category: 'Utility',
    headers: [],
    knowledgeType: 'code-pattern',
    language: 'typescript',
    usageGuide: '### Usage\nApply this rule to type-only TypeScript imports.',
    ...restOverrides,
    reasoning: {
      ...(base.reasoning as Record<string, unknown>),
      ...overrideReasoning,
    },
  };
}

function fakePort(readiness: RetrievalReadinessReport) {
  const calls: Array<{ input: RecipeProductionInput; context: ProducerContext }> = [];
  let publishCalls = 0;
  return {
    calls,
    get publishCalls() {
      return publishCalls;
    },
    port: {
      async createOrStage(input: RecipeProductionInput, context: ProducerContext) {
        calls.push({ input, context });
        return {
          created: [
            {
              index: 0,
              id: `recipe-${calls.length}`,
              title: String(input.items[0]?.title ?? ''),
              lifecycle: readiness.ready ? 'staging' : 'pending',
              raw: input.items[0] as Record<string, unknown>,
            },
          ],
          rejected: [],
          merged: [],
          blocked: [],
          duplicates: [],
          supersedeProposal: null,
          production: { capability: context.capability, source: context.source },
        };
      },
      async evaluateReadiness() {
        return readiness;
      },
      async publish() {
        publishCalls += 1;
        throw new Error('Agent submit must never publish');
      },
    },
  };
}

const readyReport: RetrievalReadinessReport = {
  ready: true,
  schemaVersion: '1',
  profileHash: 'profile-hash',
  documentSetHash: 'document-set-hash',
  violations: [],
  warnings: [],
};

describe('Agent Recipe production profile adapter', () => {
  test.each([
    'submit',
    'publish',
  ])('does not start a pre-aborted %s operation', async (operation) => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakePort(readyReport);
    const evaluateReadiness = vi.fn(async () => readyReport);
    const result = await handleKnowledge(
      operation === 'submit' ? 'submit' : 'manage',
      operation === 'submit' ? submitParams() : { operation, id: 'recipe-existing' },
      {
        projectRoot: makeProject(),
        abortSignal: controller.signal,
        recipeGateway: { ...fake.port, evaluateReadiness },
      } as never
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort/i);
    expect(fake.calls).toHaveLength(0);
    expect(evaluateReadiness).not.toHaveBeenCalled();
    expect(fake.publishCalls).toBe(0);
  });

  test('does not persist a late style repair after cancellation', async () => {
    const controller = new AbortController();
    const fake = fakePort(readyReport);
    let finishRepair!: (value: string) => void;
    let repairStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      repairStarted = resolve;
    });
    const chat = vi.fn((_prompt: string, _options: { abortSignal?: AbortSignal }) => {
      repairStarted();
      return new Promise<string>((resolve) => {
        finishRepair = resolve;
      });
    });
    const pending = handleKnowledge(
      'submit',
      submitParams({ doClause: 'ImportType is needed for type-only dependencies.' }),
      {
        projectRoot: makeProject(),
        abortSignal: controller.signal,
        recipeGateway: fake.port,
        runtime: { sharedState: {}, aiProvider: { chat } },
      } as never
    );
    await started;
    controller.abort();
    finishRepair(JSON.stringify({ doClause: 'Use import type for type-only dependencies.' }));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort/i);
    expect(fake.calls).toHaveLength(0);
    expect(chat.mock.calls[0][1].abortSignal?.aborted).toBe(true);
  });

  test.each([
    'approve',
    'publish',
  ])('does not %s after its readiness wait is cancelled', async (operation) => {
    const controller = new AbortController();
    let finishReadiness!: (value: RetrievalReadinessReport) => void;
    let readinessStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readinessStarted = resolve;
    });
    const publish = vi.fn(async () => ({ id: 'recipe-existing', lifecycle: 'active' }));
    const pending = handleKnowledge('manage', { operation, id: 'recipe-existing' }, {
      projectRoot: makeProject(),
      abortSignal: controller.signal,
      recipeGateway: {
        evaluateReadiness: () => {
          readinessStarted();
          return new Promise<RetrievalReadinessReport>((resolve) => {
            finishReadiness = resolve;
          });
        },
        publish,
      },
    } as never);
    await started;
    controller.abort();
    finishReadiness(readyReport);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort/i);
    expect(publish).not.toHaveBeenCalled();
  });

  test('keeps a Core commit confirmed after cancellation and skips new post-commit work', async () => {
    const controller = new AbortController();
    const fake = fakePort(readyReport);
    const evaluateReadiness = vi.fn(async () => readyReport);
    const save = vi.fn();
    const result = await handleKnowledge('submit', submitParams(), {
      projectRoot: makeProject(),
      abortSignal: controller.signal,
      recipeGateway: {
        ...fake.port,
        createOrStage: async (input: RecipeProductionInput, context: ProducerContext) => {
          const committed = await fake.port.createOrStage(input, context);
          controller.abort();
          return committed;
        },
        evaluateReadiness,
      },
      sessionStore: { save },
    } as never);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'created',
      id: 'recipe-1',
      lifecycle: 'staging',
      readinessStatus: 'unavailable',
    });
    expect(result._meta?.degraded).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(evaluateReadiness).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test.each([
    'title',
    'description',
    'trigger',
    'whenClause',
    'doClause',
    'content.markdown',
    'content.rationale',
  ])('returns validation failure for a non-string direct submit %s', async (field) => {
    const params = submitParams() as Record<string, unknown>;
    if (field.startsWith('content.')) {
      params.content = { ...(params.content as object), [field.slice('content.'.length)]: 42 };
    } else {
      params[field] = 42;
    }
    const fake = fakePort(readyReport);
    const result = await handleKnowledge('submit', params, {
      projectRoot: makeProject(),
      recipeGateway: fake.port,
    } as never);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Validation failed:');
    expect(result.error).toContain(field);
    expect(fake.calls).toHaveLength(0);
  });

  test.each([
    'readiness',
    'session-save',
    'async-session-save',
  ])('keeps the persisted receipt when %s post-processing fails', async (failure) => {
    const projectRoot = makeProject();
    const fake = fakePort(readyReport);
    const error = new Error(`${failure} unavailable`);
    const rejectedSave = Promise.reject(error);
    // 旧 handler 不等待 save 时也保持 probe 无 unhandled rejection；断言仍要求等待并诊断。
    void rejectedSave.catch(() => {});
    const result = await handleKnowledge('submit', submitParams(), {
      projectRoot,
      recipeGateway: {
        ...fake.port,
        evaluateReadiness: async () => {
          if (failure === 'readiness') {
            throw error;
          }
          return readyReport;
        },
      },
      sessionStore: {
        save: () => {
          if (failure === 'session-save') {
            throw error;
          }
          if (failure === 'async-session-save') {
            return rejectedSave;
          }
        },
      },
    } as never);

    expect(fake.calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'created',
      id: 'recipe-1',
      candidateId: 'recipe-1',
      lifecycle: 'staging',
    });
    expect(result._meta).toMatchObject({
      degraded: true,
      diagnosticWarnings: [
        {
          code:
            failure === 'readiness'
              ? 'KNOWLEDGE_READINESS_UNAVAILABLE'
              : 'KNOWLEDGE_SESSION_SAVE_FAILED',
        },
      ],
    });
    if (failure === 'readiness') {
      expect(result.data).toMatchObject({ readinessStatus: 'unavailable' });
      expect(result.data).not.toHaveProperty('readiness');
    } else {
      expect(result.data).toMatchObject({ readiness: readyReport });
    }
  });

  test('refreshes retrieval provenance after a style repair changes authored fields', async () => {
    const projectRoot = makeProject();
    let stored: Record<string, unknown> | undefined;
    const corrected = 'Use import type for type-only dependencies.';
    const provider = { chat: vi.fn(async () => JSON.stringify({ doClause: corrected })) };
    try {
      const result = await handleKnowledge(
        'submit',
        submitParams({ doClause: 'ImportType is needed for type-only dependencies.' }),
        {
          projectRoot,
          runtime: { aiProvider: provider },
          recipeGateway: {
            createOrStage: async ({ items }: { items: Record<string, unknown>[] }) => {
              stored = items[0];
              return {
                created: [
                  { id: 'repaired', title: stored.title, lifecycle: 'pending', raw: stored },
                ],
                rejected: [],
                duplicates: [],
                merged: [],
                blocked: [],
                supersedeProposal: null,
              };
            },
            evaluateReadiness: async () => readyReport,
          },
        } as never
      );
      expect(result.ok).toBe(true);
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(stored?.doClause).toBe(corrected);
      expect(
        (stored?.retrievalProfile as { provenance: { sourceContentHash: string } }).provenance
          .sourceContentHash
      ).toBe(computeRecipeSourceContentHash(stored as never));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
  test('shares the per-title style repair budget across runtime projections and phase copies', async () => {
    const projectRoot = makeProject();
    const sharedState = { _sessionCounters: {} };
    const chat = vi.fn(async () => 'not repair JSON');
    const fake = fakePort(readyReport);
    for (let index = 0; index < 3; index += 1) {
      const result = await handleKnowledge(
        'submit',
        submitParams({ doClause: 'ImportType is needed for type-only dependencies.' }),
        {
          projectRoot,
          recipeGateway: fake.port,
          runtime: {
            sharedState: index === 2 ? { ...sharedState } : sharedState,
            aiProvider: { chat },
          },
        } as never
      );
      expect(result.ok).toBe(true);
    }
    expect(chat).toHaveBeenCalledTimes(2);

    await handleKnowledge(
      'submit',
      submitParams({
        title: 'SeparateImportType uses a separate repair budget',
        doClause: 'ImportType is needed for type-only dependencies.',
      }),
      {
        projectRoot,
        recipeGateway: fake.port,
        runtime: { sharedState, aiProvider: { chat } },
      } as never
    );
    expect(chat).toHaveBeenCalledTimes(3);
  });

  test('stops the fourth title attempt when every call receives a fresh shallow projection', async () => {
    const projectRoot = makeProject();
    const counters: Record<string, unknown> = {};
    const base = { _sessionCounters: counters };
    const chat = vi.fn(async () => 'not repair JSON');
    const fake = fakePort(readyReport);
    const projections: Array<Record<string, unknown>> = [];
    const submit = () => {
      const sharedState = { ...base };
      projections.push(sharedState);
      return handleKnowledge(
        'submit',
        submitParams({ doClause: 'ImportType is needed for type-only dependencies.' }),
        {
          projectRoot,
          recipeGateway: fake.port,
          runtime: { sharedState, aiProvider: { chat } },
        } as never
      );
    };
    for (let index = 0; index < 3; index += 1) {
      expect((await submit()).ok).toBe(true);
    }
    const fourth = await submit();
    expect(fourth.ok).toBe(false);
    expect(fourth.error).toContain('已尝试 3 次');
    expect(fake.calls).toHaveLength(3);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(base).not.toHaveProperty('_submitTitleAttempts');
    for (const projection of projections) {
      expect(projection._sessionCounters).toBe(counters);
      expect(projection._submitTitleAttempts).toBe(counters._submitTitleAttempts);
    }
  });

  test.each([
    'constructor',
    '__proto__',
  ])('counts the prototype-shaped title %s using its own session entries', async (title) => {
    const projectRoot = makeProject();
    // 覆盖旧宿主普通字典；不能只让新建的 null-prototype 字典正确。
    const sharedState = {
      _submitTitleAttempts: {},
      _sessionCounters: { _styleRepairAttempts: {} },
    };
    const legacyAttempts = sharedState._submitTitleAttempts;
    const chat = vi.fn(async () => 'not repair JSON');
    const fake = fakePort(readyReport);
    const submit = () =>
      handleKnowledge(
        'submit',
        submitParams({ title, doClause: 'ImportType is needed for type-only dependencies.' }),
        {
          projectRoot,
          recipeGateway: fake.port,
          runtime: { sharedState, aiProvider: { chat } },
        } as never
      );
    for (let index = 0; index < 3; index += 1) {
      expect((await submit()).ok).toBe(true);
    }
    const fourth = await submit();
    expect(fourth.ok).toBe(false);
    expect(fourth.error).toContain('已尝试 3 次');
    expect(fake.calls).toHaveLength(3);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(Object.hasOwn(sharedState._submitTitleAttempts, title)).toBe(true);
    expect(Object.hasOwn(sharedState._sessionCounters._styleRepairAttempts, title)).toBe(true);
    expect(sharedState._submitTitleAttempts).toBe(legacyAttempts);
    expect((sharedState._sessionCounters as Record<string, unknown>)._submitTitleAttempts).toBe(
      legacyAttempts
    );
  });

  test('uses the same prepared gate for explicit and analyst-injected graph refs', async () => {
    const projectRoot = makeProject();
    const graphRefs = ['sourceGraph:verified-callers'];
    const explicit = fakePort(readyReport);
    const injected = fakePort(readyReport);
    const params = submitParams({
      description:
        'The ImportType caller invokes a module while consuming only its type dependency.',
      coreCode: 'export const invented = missingSource();',
      reasoning: { sources: ['src/a.ts:99-100'] },
    });
    const first = await handleKnowledge(
      'submit',
      { ...params, reasoning: { ...params.reasoning, graphRefs } },
      { projectRoot, recipeGateway: explicit.port } as never
    );
    const second = await handleKnowledge('submit', params, {
      projectRoot,
      recipeGateway: injected.port,
      runtime: { sharedState: { _analystGraphEvidence: graphRefs } },
    } as never);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(explicit.calls).toHaveLength(1);
    expect(injected.calls).toHaveLength(1);
    expect(injected.calls[0].input.items).toEqual(explicit.calls[0].input.items);
    expect(injected.calls[0].input.items[0].coreCode).toBe('');
    expect(second.data).toMatchObject({
      codeEvidence: { accepted: false, reason: 'unbounded-or-unrelated' },
    });
  });

  test.each([
    'approve',
    'publish',
  ])('%s active transition uses Core readiness and publish only', async (operation) => {
    const projectRoot = makeProject();
    const repository = {
      approve: vi.fn(async () => {}),
      publish: vi.fn(async () => {}),
    };
    const port = {
      evaluateReadiness: vi.fn(async () => readyReport),
      publish: vi.fn(async () => ({
        id: 'recipe-active',
        title: 'Active recipe',
        lifecycle: 'active',
      })),
    };

    const result = await handleKnowledge(
      'manage',
      { operation, id: 'recipe-active', reason: 'reviewed' },
      {
        projectRoot,
        knowledgeRepo: repository,
        recipeGateway: port,
      } as never
    );

    expect(result.ok).toBe(true);
    expect(port.evaluateReadiness).toHaveBeenCalledWith('recipe-active');
    expect(port.publish).toHaveBeenCalledWith('recipe-active', { userId: 'alembic-agent' });
    expect(repository.approve).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      operation,
      id: 'recipe-active',
      lifecycle: 'active',
      readiness: { ready: true },
    });
  });

  test('invalid Core readiness blocks publish with structured evidence and no lifecycle mutation', async () => {
    const projectRoot = makeProject();
    const blockedReadiness: RetrievalReadinessReport = {
      ...readyReport,
      ready: false,
      profileHash: null,
      documentSetHash: null,
      violations: [
        {
          code: 'retrieval.profile.fact-ungrounded',
          field: 'retrievalProfile.concepts.0',
          message: 'The fact is not grounded.',
        },
      ],
    };
    const repository = {
      approve: vi.fn(async () => {}),
      publish: vi.fn(async () => {}),
    };
    const port = {
      evaluateReadiness: vi.fn(async () => blockedReadiness),
      publish: vi.fn(async () => ({
        id: 'recipe-pending',
        title: 'Pending recipe',
        lifecycle: 'active',
      })),
    };

    const result = await handleKnowledge('manage', { operation: 'publish', id: 'recipe-pending' }, {
      projectRoot,
      knowledgeRepo: repository,
      recipeGateway: port,
    } as never);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Core readiness');
    expect(result.data).toMatchObject({
      operation: 'publish',
      id: 'recipe-pending',
      status: 'readiness-blocked',
      lifecycle: 'unchanged',
      readiness: {
        ready: false,
        violations: [{ code: 'retrieval.profile.fact-ungrounded' }],
      },
    });
    expect(port.publish).not.toHaveBeenCalled();
    expect(repository.approve).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  test('active transition fails closed when the Core production port is unavailable', async () => {
    const projectRoot = makeProject();
    const repository = {
      approve: vi.fn(async () => {}),
      publish: vi.fn(async () => {}),
    };

    const result = await handleKnowledge('manage', { operation: 'publish', id: 'recipe-pending' }, {
      projectRoot,
      knowledgeRepo: repository,
    } as never);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Recipe production port not available');
    expect(repository.approve).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  test('Core publish exceptions retain structured readiness evidence', async () => {
    const projectRoot = makeProject();
    const changedReadiness = {
      ...readyReport,
      ready: false,
      profileHash: null,
      documentSetHash: null,
      violations: [
        {
          code: 'retrieval.profile.changed',
          field: 'retrievalProfile',
          message: 'Profile changed after the preflight check.',
        },
      ],
    } satisfies RetrievalReadinessReport;
    const publishError = Object.assign(new Error('readiness changed before publish'), {
      code: 'VALIDATION_ERROR',
      details: { readiness: changedReadiness },
    });
    const port = {
      evaluateReadiness: vi.fn(async () => readyReport),
      publish: vi.fn(async () => {
        throw publishError;
      }),
    };

    const result = await handleKnowledge('manage', { operation: 'publish', id: 'recipe-staging' }, {
      projectRoot,
      recipeGateway: port,
    } as never);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      status: 'readiness-blocked',
      lifecycle: 'unchanged',
      reason: 'core-readiness-blocked',
      code: 'VALIDATION_ERROR',
      readiness: {
        ready: false,
        violations: [{ code: 'retrieval.profile.changed' }],
      },
    });
  });

  test.each([
    ['opportunistic', {}],
    ['session-bound', { runtime: { dimensionScopeId: 'session-scope' } }],
    ['dimension-bearing', { params: { dimensionId: 'typescript' } }],
    ['cold-start', { runtime: { dimensionMeta: { id: 'architecture' } } }],
  ])('%s submit reaches Core production port with equivalent profile semantics', async (_name, ctx) => {
    const projectRoot = makeProject();
    const fake = fakePort(readyReport);
    const params = submitParams(ctx.params ?? {});
    const result = await handleKnowledge('submit', params, {
      projectRoot,
      recipeGateway: fake.port,
      sessionStore: null,
      runtime: ctx.runtime,
    } as never);

    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].context).toEqual({
      source: 'alembic-agent',
      userId: 'alembic-agent',
      capability: 'knowledge-submit',
    });
    const item = fake.calls[0].input.items[0] as Record<string, unknown>;
    const profile = item.retrievalProfile as ReturnType<typeof authoredProfile> & {
      schemaVersion: string;
      provenance: ReturnType<typeof authoredProfile>['provenance'] & {
        evidenceRefs: string[];
        sourceContentHash: string;
        generator: string;
      };
    };
    expect(profile).toMatchObject({
      schemaVersion: '1',
      primaryLanguage: 'zh',
      summary: authoredProfile().summary,
      concepts: authoredProfile().concepts,
      scenarios: authoredProfile().scenarios,
      exclusions: authoredProfile().exclusions,
      provenance: {
        evidenceRefs: ['src/a.ts:2-3'],
        sourceFieldRefs: [...authoredProfile().provenance.sourceFieldRefs].sort((left, right) =>
          left.localeCompare(right)
        ),
        generator: 'alembic-agent-recipe-profile-v1',
      },
    });
    expect(profile.provenance.sourceContentHash).toBe(computeRecipeSourceContentHash(item));
    expect(result.data).toMatchObject({
      status: 'created',
      lifecycle: 'staging',
      production: { capability: 'knowledge-submit', source: 'alembic-agent' },
      readiness: { ready: true, violations: [] },
    });
    expect(fake.publishCalls).toBe(0);
  });

  test('real Agent call reaches Core production port and persists/project the native profile', async () => {
    const projectRoot = makeProject();
    const previousQuiet = process.env.ALEMBIC_QUIET;
    process.env.ALEMBIC_QUIET = '1';
    pathGuard.configure({ projectRoot, knowledgeBaseDir: 'Alembic' });
    const connection = new DatabaseConnection({ path: '.asd/alembic.db' });
    try {
      await connection.connect();
      await connection.runMigrations();
      const repository = new KnowledgeRepositoryImpl(connection);
      const service = new KnowledgeService(repository, { log: async () => {} }, null, null, {
        fileWriter: new KnowledgeFileWriter(projectRoot),
      });
      const port = new RecipeProductionGateway({ knowledgeService: service, projectRoot });

      const result = await handleKnowledge('submit', submitParams(), {
        projectRoot,
        recipeGateway: port,
        sessionStore: null,
      } as never);

      expect(result.ok).toBe(true);
      const output = result.data as {
        id: string;
        production: { capability: string; source: string };
        readiness: RetrievalReadinessReport;
      };
      expect(output.production).toEqual({
        capability: 'knowledge-submit',
        source: 'alembic-agent',
      });
      expect(output.readiness.ready).toBe(true);
      const persisted = await repository.findById(output.id);
      expect(persisted?.retrievalProfile).toBeTruthy();
      if (!persisted) {
        throw new Error('Core production port did not persist the Agent candidate');
      }
      expect(persisted.retrievalProfile?.provenance.sourceContentHash).toBe(
        computeRecipeSourceContentHash(persisted)
      );
      expect(projectRecipeRetrievalDocumentSet(persisted).documentSetHash).toBe(
        output.readiness.documentSetHash
      );
      const candidatePath = path.join(projectRoot, persisted?.sourceFile ?? '');
      expect(fs.existsSync(candidatePath)).toBe(true);
      expect(
        parseKnowledgeMarkdown(fs.readFileSync(candidatePath, 'utf8')).retrievalProfile
      ).toEqual(persisted?.retrievalProfile);
    } finally {
      connection.close();
      if (previousQuiet === undefined) {
        delete process.env.ALEMBIC_QUIET;
      } else {
        process.env.ALEMBIC_QUIET = previousQuiet;
      }
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: 'field-only grounding',
      overrides: {
        coreCode: '',
        reasoning: { sources: ['src/a.ts:2-3'] },
      },
      expectedEvidenceRefs: ['src/a.ts:2-3'],
      codeAccepted: true,
    },
    {
      name: 'documentation grounding',
      overrides: {
        coreCode: '',
        reasoning: { sources: ['docs/design.md:1-3'] },
        retrievalProfile: documentationGroundedProfile(),
      },
      expectedEvidenceRefs: ['docs/design.md:1-3'],
      codeAccepted: true,
    },
    {
      name: 'rejected documentation coreCode',
      overrides: {
        coreCode: '# Design\nUse import type for type-only dependencies.',
        reasoning: { sources: ['docs/design.md:1-3'] },
        retrievalProfile: documentationGroundedProfile(),
      },
      expectedEvidenceRefs: ['docs/design.md:1-3'],
      codeAccepted: false,
    },
  ])('real Core port persists and evaluates $name independently from code admission', async ({
    overrides,
    expectedEvidenceRefs,
    codeAccepted,
  }) => {
    const projectRoot = makeProject();
    const previousQuiet = process.env.ALEMBIC_QUIET;
    process.env.ALEMBIC_QUIET = '1';
    pathGuard.configure({ projectRoot, knowledgeBaseDir: 'Alembic' });
    const connection = new DatabaseConnection({ path: '.asd/alembic.db' });
    try {
      await connection.connect();
      await connection.runMigrations();
      const repository = new KnowledgeRepositoryImpl(connection);
      const service = new KnowledgeService(repository, { log: async () => {} }, null, null, {
        fileWriter: new KnowledgeFileWriter(projectRoot),
      });
      const port = new RecipeProductionGateway({ knowledgeService: service, projectRoot });
      const prepared = prepareRecipeProductionItem(directProductionParams(overrides), projectRoot);
      const production = await port.createOrStage(
        {
          items: [prepared.item],
          options: { systemInjectedFields: ['coreCode'] },
        },
        {
          source: 'alembic-agent',
          userId: 'alembic-agent',
          capability: 'knowledge-submit',
        }
      );
      const created = production.created[0];
      if (!created) {
        throw new Error(
          `Core production port did not persist the prepared Agent candidate: ${JSON.stringify(production)}`
        );
      }

      const readiness = await port.evaluateReadiness(created.id);
      const persisted = await repository.findById(created.id);
      expect(readiness.ready).toBe(true);
      expect(prepared.codeEvidence.accepted).toBe(codeAccepted);
      expect(prepared.item.coreCode).toBe('');
      expect(persisted?.retrievalProfile?.provenance.evidenceRefs).toEqual(expectedEvidenceRefs);
      expect(persisted?.retrievalProfile).toEqual(prepared.item.retrievalProfile);
      expect(readiness.violations.map((violation) => violation.code)).not.toContain(
        'retrieval.profile.missing'
      );
      const candidatePath = path.join(projectRoot, persisted?.sourceFile ?? '');
      expect(
        parseKnowledgeMarkdown(fs.readFileSync(candidatePath, 'utf8')).retrievalProfile
      ).toEqual(persisted?.retrievalProfile);
    } finally {
      connection.close();
      if (previousQuiet === undefined) {
        delete process.env.ALEMBIC_QUIET;
      } else {
        process.env.ALEMBIC_QUIET = previousQuiet;
      }
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('real Core readiness block leaves persisted lifecycle unchanged through knowledge.manage', async () => {
    const projectRoot = makeProject();
    const previousQuiet = process.env.ALEMBIC_QUIET;
    process.env.ALEMBIC_QUIET = '1';
    pathGuard.configure({ projectRoot, knowledgeBaseDir: 'Alembic' });
    const connection = new DatabaseConnection({ path: '.asd/alembic.db' });
    try {
      await connection.connect();
      await connection.runMigrations();
      const repository = new KnowledgeRepositoryImpl(connection);
      const service = new KnowledgeService(repository, { log: async () => {} }, null, null, {
        fileWriter: new KnowledgeFileWriter(projectRoot),
      });
      const port = new RecipeProductionGateway({ knowledgeService: service, projectRoot });
      const prepared = prepareRecipeProductionItem(
        directProductionParams({ coreCode: '', retrievalProfile: undefined }),
        projectRoot
      );
      const production = await port.createOrStage(
        {
          items: [prepared.item],
          options: { systemInjectedFields: ['coreCode'] },
        },
        {
          source: 'alembic-agent',
          userId: 'alembic-agent',
          capability: 'knowledge-submit',
        }
      );
      const created = production.created[0];
      if (!created) {
        throw new Error(
          `Core production port did not persist the invalid candidate: ${JSON.stringify(production)}`
        );
      }
      const before = await repository.findById(created.id);
      const legacyRepository = {
        approve: vi.fn(async () => {}),
        publish: vi.fn(async () => {}),
      };

      const result = await handleKnowledge('manage', { operation: 'publish', id: created.id }, {
        projectRoot,
        recipeGateway: port,
        knowledgeRepo: legacyRepository,
      } as never);
      const after = await repository.findById(created.id);

      expect(result.ok).toBe(false);
      expect(result.data).toMatchObject({
        status: 'readiness-blocked',
        lifecycle: 'unchanged',
        readiness: { ready: false },
      });
      expect(after?.lifecycle).toBe(before?.lifecycle);
      expect(after?.lifecycle).not.toBe('active');
      expect(legacyRepository.approve).not.toHaveBeenCalled();
      expect(legacyRepository.publish).not.toHaveBeenCalled();
    } finally {
      connection.close();
      if (previousQuiet === undefined) {
        delete process.env.ALEMBIC_QUIET;
      } else {
        process.env.ALEMBIC_QUIET = previousQuiet;
      }
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('surfaces Core readiness violations structurally while the candidate remains pending', async () => {
    const projectRoot = makeProject();
    const readiness: RetrievalReadinessReport = {
      ready: false,
      schemaVersion: '1',
      profileHash: null,
      documentSetHash: null,
      violations: [
        {
          code: 'retrieval.profile.fact-ungrounded',
          field: 'retrievalProfile.concepts.0',
          message: 'Every retrieval fact must resolve to profile evidence or source fields.',
          provenanceRefs: ['field:missing'],
        },
      ],
      warnings: [{ code: 'retrieval.provider.unavailable', message: 'Provider offline.' }],
    };
    const fake = fakePort(readiness);
    const result = await handleKnowledge('submit', submitParams(), {
      projectRoot,
      recipeGateway: fake.port,
      sessionStore: null,
    } as never);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'created',
      lifecycle: 'pending',
      readiness: {
        ready: false,
        violations: [
          {
            code: 'retrieval.profile.fact-ungrounded',
            field: 'retrievalProfile.concepts.0',
            provenanceRefs: ['field:missing'],
          },
        ],
      },
    });
    expect(fake.publishCalls).toBe(0);
  });

  test('provider availability does not change production input or Core readiness truth', async () => {
    const projectRoot = makeProject();
    const withoutProvider = fakePort(readyReport);
    const offlineProvider = fakePort(readyReport);
    const first = await handleKnowledge('submit', submitParams(), {
      projectRoot,
      recipeGateway: withoutProvider.port,
      sessionStore: null,
    } as never);
    const second = await handleKnowledge('submit', submitParams(), {
      projectRoot,
      recipeGateway: offlineProvider.port,
      sessionStore: null,
      runtime: {
        aiProvider: {
          chatWithTools: async () => {
            throw new Error('provider offline');
          },
        },
      },
    } as never);

    expect(withoutProvider.calls[0].input).toEqual(offlineProvider.calls[0].input);
    expect((first.data as { readiness: unknown }).readiness).toEqual(
      (second.data as { readiness: unknown }).readiness
    );
  });

  test.each([
    ['whole-file range', { reasoning: { sources: ['src/a.ts:1-4'] }, coreCode: '__WHOLE_FILE__' }],
    [
      'unrelated snippet',
      {
        reasoning: { sources: ['src/a.ts:2-3'] },
        coreCode: 'export const invented = makeUncitedValue();',
      },
    ],
    [
      'documentation range',
      {
        reasoning: { sources: ['docs/design.md:1-3'] },
        coreCode: '# Design\nUse import type for type-only dependencies.',
      },
    ],
    [
      'out-of-range citation',
      {
        reasoning: { sources: ['src/a.ts:99-100'] },
        coreCode: 'export const count = 1;',
      },
    ],
    [
      'bare citation',
      {
        reasoning: { sources: ['src/a.ts'] },
        coreCode: 'export const count = 1;',
      },
    ],
  ])('%s cannot inject code but preserves an independently grounded profile', async (_name, override) => {
    const projectRoot = makeProject();
    const fake = fakePort(readyReport);
    const resolvedOverride =
      override.coreCode === '__WHOLE_FILE__'
        ? {
            ...override,
            coreCode: fs.readFileSync(path.join(projectRoot, 'src/a.ts'), 'utf8'),
          }
        : override;
    const result = await handleKnowledge('submit', submitParams(resolvedOverride), {
      projectRoot,
      recipeGateway: fake.port,
      sessionStore: null,
    } as never);

    expect(result.ok).toBe(true);
    const item = fake.calls[0].input.items[0];
    expect(item.coreCode).toBe('');
    expect(item.retrievalProfile).toBeTruthy();
    expect(result.data).toMatchObject({
      lifecycle: 'staging',
      codeEvidence: { accepted: false, reason: 'unbounded-or-unrelated' },
      readiness: { ready: true },
    });
    expect(fake.publishCalls).toBe(0);
  });

  test.each([
    ['field-only profile', { coreCode: '', reasoning: { sources: [] } }, []],
    [
      'documentation-grounded profile',
      { coreCode: '', reasoning: { sources: ['docs/design.md:1-3'] } },
      ['docs/design.md:1-3'],
    ],
    [
      'profile with rejected document coreCode',
      {
        coreCode: '# Design\nUse import type for type-only dependencies.',
        reasoning: { sources: ['docs/design.md:1-3'] },
      },
      ['docs/design.md:1-3'],
    ],
  ])('%s survives profile preparation independently from code admission', (_name, override, evidenceRefs) => {
    const projectRoot = makeProject();
    const prepared = prepareRecipeProductionItem(submitParams(override), projectRoot);

    expect(prepared.item.retrievalProfile).toBeTruthy();
    expect(prepared.item.retrievalProfile?.provenance.evidenceRefs).toEqual(evidenceRefs);
    expect(prepared.item.coreCode).toBe('');
    if (String(override.coreCode ?? '')) {
      expect(prepared.codeEvidence).toEqual({
        accepted: false,
        reason: 'unbounded-or-unrelated',
      });
    } else {
      expect(prepared.codeEvidence).toEqual({ accepted: true, reason: 'absent' });
    }
  });

  test('root-escape and absolute citations cannot read or inject code', async () => {
    const projectRoot = makeProject();
    const outsideName = `outside-${path.basename(projectRoot)}.ts`;
    const outsidePath = path.join(path.dirname(projectRoot), outsideName);
    fs.writeFileSync(
      outsidePath,
      'export const secretOutsideProject = true;\nexport const secondOutsideLine = true;',
      'utf8'
    );
    fs.symlinkSync(outsidePath, path.join(projectRoot, 'src/outside-link.ts'));
    try {
      for (const source of [
        `../${outsideName}:1-1`,
        `${outsidePath}:1-1`,
        'src/outside-link.ts:1-1',
      ]) {
        const prepared = prepareRecipeProductionItem(
          {
            coreCode: 'export const secretOutsideProject = true;',
            reasoning: { sources: [source] },
            retrievalProfile: authoredProfile(),
          },
          projectRoot
        );
        expect(prepared.item.coreCode).toBe('');
        expect(prepared.item.retrievalProfile).toBeTruthy();
        expect(prepared.codeEvidence.accepted).toBe(false);
      }
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });
});
