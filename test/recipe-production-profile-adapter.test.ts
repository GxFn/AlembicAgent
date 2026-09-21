import fs from 'node:fs';
import path from 'node:path';
import {
  computeRecipeSourceContentHash,
  DivergenceError,
  KnowledgeRepositoryImpl,
  type ProducerContext,
  projectRecipeRetrievalDocumentSet,
  type RecipeProductionInput,
  type RetrievalReadinessReport,
} from '@alembic/core';
import { DatabaseConnection } from '@alembic/core/database';
import { pathGuard } from '@alembic/core/io';
import {
  KnowledgeEntry,
  KnowledgeFileWriter,
  KnowledgeService,
  parseKnowledgeMarkdown,
  RecipeProductionGateway,
} from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { describe, expect, test, vi } from 'vitest';
import { handle as handleKnowledge } from '../src/tools/runtime/handlers/knowledge.js';
import { prepareRecipeProductionItem } from '../src/tools/runtime/handlers/recipeProductionAdapter.js';
import { ToolRouterAdapter } from '../src/tools/runtime/index.js';
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

function submitThroughAdapter(
  projectRoot: string,
  recipeGateway: unknown,
  params: Record<string, unknown> = submitParams()
) {
  const adapter = new ToolRouterAdapter({
    contextFactory: { create: () => ({ projectRoot, tokenBudget: 8000, recipeGateway }) },
  });
  return adapter.execute({
    toolId: 'knowledge',
    args: { action: 'submit', params },
    surface: 'runtime',
    actor: { role: 'agent' },
    source: { kind: 'runtime', name: 'production-receipt-fixture' },
  });
}

const readyReport: RetrievalReadinessReport = {
  ready: true,
  schemaVersion: '1',
  profileHash: 'profile-hash',
  documentSetHash: 'document-set-hash',
  violations: [],
  warnings: [],
};

/** 真 Core merge/序列化/读回，只将 Drizzle 执行面替换为本测试私有内存行。 */
function managementCoreRepository() {
  let row: Record<string, unknown>;
  let writes = 0;
  const drizzle = {
    update: () => ({
      set: (next: Record<string, unknown>) => ({
        where: () => ({
          run: () => {
            row = { ...row, ...next };
            writes += 1;
            return { changes: 1 };
          },
        }),
      }),
    }),
  };
  const repository = new KnowledgeRepositoryImpl({ getDb: () => ({}) } as never, drizzle as never);
  row = repository._entityToRow(
    KnowledgeEntry.fromJSON({
      id: 'management-recipe',
      title: 'Management fixture',
      description: 'Original description',
      lifecycle: 'staging',
      stagingDeadline: 1_000_000,
      autoApprovable: true,
      stats: { stagingReview: { outcome: 'fail', reviewedAt: 1 } },
      content: { markdown: 'Verified source content', rationale: 'Existing evidence' },
    })
  );
  vi.spyOn(repository, 'findById').mockImplementation(async () => repository._rowToEntity(row));
  return {
    repository,
    writes: () => writes,
    read: () => {
      const entry = repository._rowToEntity(row);
      if (!entry) {
        throw new Error('Core management fixture readback is missing');
      }
      return entry.toJSON();
    },
  };
}

describe('knowledge management boundaries', () => {
  test.each([
    { label: 'stagingDeadline', data: { stagingDeadline: 1, description: 'Do not apply' } },
    { label: 'stats', data: { stats: {}, description: 'Do not apply' } },
    {
      label: 'unknown system field',
      data: { futureSystemState: undefined, description: 'Do not apply' },
    },
  ])('rejects $label before the actual Core merge and preserves the complete input', async ({
    data,
  }) => {
    const fixture = managementCoreRepository();
    const before = fixture.read();
    const input = structuredClone(data);
    expect(before.stats).toMatchObject({ stagingReview: { outcome: 'fail' } });
    const result = await handleKnowledge(
      'manage',
      {
        operation: 'update',
        id: 'management-recipe',
        data,
      },
      { projectRoot: '.', knowledgeRepo: fixture.repository } as never
    );
    const after = fixture.read();
    expect({
      ok: result.ok,
      writes: fixture.writes(),
      description: after.description,
      deadline: after.stagingDeadline,
      review: (after.stats as Record<string, unknown>).stagingReview,
    }).toEqual({
      ok: false,
      writes: 0,
      description: before.description,
      deadline: before.stagingDeadline,
      review: (before.stats as Record<string, unknown>).stagingReview,
    });
    expect(data).toEqual(input);
  });

  test('applies permitted content edits through the actual Core merge without mutating input', async () => {
    const fixture = managementCoreRepository();
    const data = Object.freeze({
      description: 'Verified revised description',
      title: 'Revised title',
    });
    const result = await handleKnowledge(
      'manage',
      {
        operation: 'update',
        id: 'management-recipe',
        data,
      },
      { projectRoot: '.', knowledgeRepo: fixture.repository } as never
    );
    expect(result.ok).toBe(true);
    expect(fixture.writes()).toBe(1);
    expect(fixture.read()).toMatchObject({
      ...data,
      lifecycle: 'staging',
      stagingDeadline: 1_000_000,
      stats: { stagingReview: { outcome: 'fail' } },
    });
    expect(data).toEqual({ description: 'Verified revised description', title: 'Revised title' });
  });

  test.each([
    'review',
    'review-queue',
  ])('normalizes %s service exceptions at the public handle boundary', async (operation) => {
    const reject = async () => {
      throw new Error('staging unavailable');
    };
    await expect(
      handleKnowledge('manage', { operation, id: 'recipe', outcome: 'pass' }, {
        projectRoot: '.',
        stagingManager: { listReviewQueue: reject, recordReview: reject },
      } as never)
    ).resolves.toMatchObject({
      ok: false,
      data: { operation, status: 'failed' },
      error: expect.stringContaining('staging unavailable'),
    });
  });

  test('settles a cancelled review queue before a non-cooperative read returns', async () => {
    const controller = new AbortController();
    let release!: (queue: unknown[]) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let settled = false;
    const pending = handleKnowledge('manage', { operation: 'review-queue', limit: 1 }, {
      projectRoot: '.',
      abortSignal: controller.signal,
      stagingManager: {
        listReviewQueue: () => {
          started();
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    } as never).then((result) => {
      settled = true;
      return result;
    });
    try {
      await entered;
      controller.abort();
      for (let index = 0; index < 30; index += 1) {
        await Promise.resolve();
      }
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ ok: false, error: expect.stringMatching(/abort/i) });
      release([{ id: 'late' }]);
      expect((await pending).data).toBeNull();
    } finally {
      release?.([]);
      await pending;
    }
  });

  test.each([
    true,
    false,
  ])('retains the actual review write receipt after cancellation: %s', async (recorded) => {
    const controller = new AbortController();
    const result = await handleKnowledge(
      'manage',
      { operation: 'review', id: 'recipe', outcome: 'fail' },
      {
        projectRoot: '.',
        abortSignal: controller.signal,
        stagingManager: {
          recordReview: async () => {
            controller.abort();
            return recorded;
          },
        },
      } as never
    );
    expect(result.ok).toBe(recorded);
    if (recorded) {
      expect(result.data).toMatchObject({ recorded: true, outcome: 'fail' });
      expect(result._meta?.degraded).toBe(true);
    } else {
      expect(result.error).toContain('not in staging');
    }
  });

  test.each([
    'review',
    'publish',
  ])('preserves Core partial-persistence details for %s', async (operation) => {
    const details = {
      code: 'core.diagnostic.knowledge.file-db-divergence',
      entryIds: ['recipe'],
      fileOpsCompleted: 1,
      operation,
      reconcileVia: 'KnowledgeSyncService.sync',
    };
    const error = new DivergenceError('File persisted but DB commit failed', details);
    const reject = async () => {
      throw error;
    };
    const result = await handleKnowledge('manage', { operation, id: 'recipe', outcome: 'pass' }, {
      projectRoot: '.',
      stagingManager: { recordReview: reject },
      recipeGateway: { evaluateReadiness: async () => readyReport, publish: reject },
    } as never);
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      code: 'STATE_DIVERGENCE',
      details,
      writeState: 'partial',
      requiresReadback: true,
    });
    expect(result._meta?.degraded).toBe(true);
    if (operation === 'publish') {
      expect(result.data).toMatchObject({ lifecycle: 'unknown' });
    }
  });

  test.each([
    'readiness',
    'publish',
  ])('distinguishes an unknown write from a %s preflight failure', async (phase) => {
    const error = new Error('host unavailable');
    const publish = vi.fn(async () => {
      throw error;
    });
    const result = await handleKnowledge('manage', { operation: 'publish', id: 'recipe' }, {
      projectRoot: '.',
      recipeGateway: {
        evaluateReadiness: async () => {
          if (phase === 'readiness') {
            throw error;
          }
          return readyReport;
        },
        publish,
      },
    } as never);
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      lifecycle: phase === 'publish' ? 'unknown' : 'unchanged',
      writeState: phase === 'publish' ? 'unknown' : 'not-started',
      requiresReadback: phase === 'publish',
    });
    expect(publish).toHaveBeenCalledTimes(phase === 'publish' ? 1 : 0);
  });

  test.each([
    'evolve',
    'deprecate',
  ])('preserves Core skipped %s as a no-op with its reason', async (operation) => {
    const result = await handleKnowledge('manage', { operation, id: 'recipe' }, {
      projectRoot: '.',
      proposalGateway: {
        submit: async () => ({
          recipeId: 'recipe',
          action: operation === 'evolve' ? 'update' : 'deprecate',
          outcome: 'skipped',
          error: 'Duplicate proposal (evidence not richer)',
        }),
      },
    } as never);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      outcome: 'skipped',
      status: operation === 'evolve' ? 'evolution_skipped' : 'deprecation_skipped',
      reason: 'Duplicate proposal (evidence not richer)',
    });
    expect(result.error).toBeUndefined();
    expect(result.data).not.toHaveProperty('proposalId', expect.any(String));
  });

  test.each([
    ['evolve', 'proposal-created', 'evolution_proposed'],
    ['evolve', 'proposal-upgraded', 'evolution_proposal_upgraded'],
    ['deprecate', 'immediately-executed', 'deprecated'],
    ['skip_evolution', 'verified', 'evolution_verified'],
  ])('retains confirmed Core %s/%s receipts', async (operation, outcome, status) => {
    const result = await handleKnowledge('manage', { operation, id: 'recipe' }, {
      projectRoot: '.',
      proposalGateway: { submit: async () => ({ outcome, proposalId: 'proposal' }) },
    } as never);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ operation, outcome, status });
  });

  test.each([
    'reject',
    'score',
    'validate',
    'update',
  ])('reports a missing %s management port structurally without inventing an implementation', async (operation) => {
    const result = await handleKnowledge(
      'manage',
      {
        operation,
        id: 'recipe',
        data: operation === 'update' ? { description: 'Edit' } : { score: 50 },
      },
      { projectRoot: '.', knowledgeRepo: {} } as never
    );
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      status: 'port-unavailable',
      code: 'KNOWLEDGE_MANAGEMENT_PORT_UNAVAILABLE',
      operation,
      id: 'recipe',
      port: 'knowledgeRepo',
      method: operation,
    });
    expect(result.error).not.toContain('is not a function');
  });

  test.each([
    { label: 'score NaN', params: { operation: 'score', id: 'recipe', data: { score: NaN } } },
    {
      label: 'score Infinity',
      params: { operation: 'score', id: 'recipe', data: { score: Infinity } },
    },
    {
      label: 'score string',
      params: { operation: 'score', id: 'recipe', data: { score: 'high' } },
    },
    { label: 'score missing', params: { operation: 'score', id: 'recipe' } },
    {
      label: 'confidence negative',
      params: { operation: 'deprecate', id: 'recipe', data: { confidence: -0.1 } },
    },
    {
      label: 'confidence percentage',
      params: { operation: 'deprecate', id: 'recipe', data: { confidence: 80 } },
    },
    {
      label: 'confidence NaN',
      params: { operation: 'evolve', id: 'recipe', data: { confidence: NaN }, confidence: 0.9 },
    },
    {
      label: 'confidence Infinity',
      params: { operation: 'evolve', id: 'recipe', confidence: Infinity },
    },
    {
      label: 'confidence string',
      params: { operation: 'deprecate', id: 'recipe', confidence: '0.9' },
    },
    {
      label: 'confidence null',
      params: { operation: 'deprecate', id: 'recipe', data: { confidence: null } },
    },
    { label: 'id number', params: { operation: 'evolve', id: 12 } },
    { label: 'id object', params: { operation: 'evolve', id: {} } },
    { label: 'id blank', params: { operation: 'evolve', id: '   ' } },
    { label: 'limit fractional', params: { operation: 'review-queue', limit: 0.5 } },
    { label: 'limit negative', params: { operation: 'review-queue', limit: -1 } },
    { label: 'limit Infinity', params: { operation: 'review-queue', limit: Infinity } },
    { label: 'limit string', params: { operation: 'review-queue', limit: 'small' } },
  ])('rejects invalid explicit management input: $label', async ({ params }) => {
    const score = vi.fn(async () => {});
    const submit = vi.fn(async () => ({ outcome: 'proposal-created', proposalId: 'proposal' }));
    const listReviewQueue = vi.fn(async () => []);
    const result = await handleKnowledge('manage', params, {
      projectRoot: '.',
      knowledgeRepo: { score },
      proposalGateway: { submit },
      stagingManager: { listReviewQueue },
    } as never);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Validation failed:');
    expect(score).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(listReviewQueue).not.toHaveBeenCalled();
  });

  test('preserves valid numeric boundaries and defaults only omitted confidence', async () => {
    const submitted: Array<{ confidence: number; recipeId: string }> = [];
    const submit = vi.fn(async (decision: { confidence: number; recipeId: string }) => {
      submitted.push(decision);
      return { ...decision, outcome: 'proposal-created', proposalId: 'proposal' };
    });
    for (const confidence of [0, 1, undefined]) {
      const result = await handleKnowledge(
        'manage',
        {
          operation: 'deprecate',
          id: '  recipe  ',
          ...(confidence === undefined ? {} : { confidence }),
        },
        { projectRoot: '.', proposalGateway: { submit } } as never
      );
      expect(result.ok).toBe(true);
    }
    expect(submitted.map((decision) => decision.confidence)).toEqual([0, 1, 0.7]);
    expect(submitted.every((decision) => decision.recipeId === 'recipe')).toBe(true);
    const score = vi.fn(async () => {});
    const result = await handleKnowledge(
      'manage',
      {
        operation: 'score',
        id: 'recipe',
        data: { score: 0 },
      },
      { projectRoot: '.', knowledgeRepo: { score } } as never
    );
    expect(result.ok).toBe(true);
    expect(score).toHaveBeenCalledWith('recipe', 0);
  });

  test.each([
    'lifecycle',
    'lifecycleHistory',
    'publishedAt',
    'publishedBy',
    'reviewedBy',
    'reviewedAt',
    'rejectionReason',
    'autoApprovable',
  ])('rejects update of Core-managed %s before invoking the host', async (field) => {
    const update = vi.fn(async () => {});
    const result = await handleKnowledge(
      'manage',
      {
        operation: 'update',
        id: 'recipe-pending',
        data: { [field]: 'active' },
      },
      { projectRoot: '.', knowledgeRepo: { update } } as never
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain(field);
    expect(update).not.toHaveBeenCalled();
  });

  test('preserves supported ordinary update calls', async () => {
    const update = vi.fn(async () => {});
    const data = { description: 'Verified description' };
    const result = await handleKnowledge('manage', { operation: 'update', id: 'recipe', data }, {
      projectRoot: '.',
      knowledgeRepo: { update },
    } as never);
    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledWith('recipe', data);
  });

  test('rejects an own lifecycle field even when its explicit value is undefined', async () => {
    const update = vi.fn(async () => {});
    const result = await handleKnowledge(
      'manage',
      {
        operation: 'update',
        id: 'recipe',
        data: { lifecycle: undefined },
      },
      { projectRoot: '.', knowledgeRepo: { update } } as never
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('lifecycle');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('Agent Recipe production profile adapter', () => {
  test('checks cancellation after preparation yields and before starting the Core write', async () => {
    const controller = new AbortController();
    const fake = fakePort(readyReport);
    // 合法候选无需 AI 修复，但异步准备边界仍可能让父取消先于 Core 写入发生。
    queueMicrotask(() => controller.abort());
    const result = await handleKnowledge('submit', submitParams(), {
      projectRoot: makeProject(),
      recipeGateway: fake.port,
      abortSignal: controller.signal,
    } as never);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('aborted');
    expect(fake.calls).toHaveLength(0);
  });

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
      reasoning: { sources: ['src/a.ts:2-3'] },
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

  test.each([
    'approve',
    'publish',
  ])('keeps an unknown write outcome when real Core returns a null %s receipt', async (operation) => {
    const projectRoot = makeProject();
    const publish = vi.fn(async () => null);
    const port = new RecipeProductionGateway({
      projectRoot,
      knowledgeService: {
        create: vi.fn(async () => ({ id: 'unused', title: 'unused', lifecycle: 'pending' })),
        update: vi.fn(async () => null),
        updateQuality: vi.fn(async () => undefined),
        evaluateRetrievalReadiness: vi.fn(async () => readyReport),
        publish,
      },
    });

    const result = await handleKnowledge('manage', { operation, id: 'recipe-null-receipt' }, {
      projectRoot,
      recipeGateway: port,
    } as never);

    expect(publish).toHaveBeenCalledExactlyOnceWith('recipe-null-receipt', {
      userId: 'alembic-agent',
    });
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      operation,
      id: 'recipe-null-receipt',
      status: 'publish-failed',
      code: 'KNOWLEDGE_WRITE_RECEIPT_UNAVAILABLE',
      lifecycle: 'unknown',
      writeState: 'unknown',
      requiresReadback: true,
      details: {
        operation,
        id: 'recipe-null-receipt',
        coreReceipt: null,
        writeState: 'unknown',
        requiresReadback: true,
        retryable: false,
      },
    });
    expect(result._meta).toMatchObject({
      degraded: true,
      diagnosticWarnings: [
        expect.objectContaining({ code: 'KNOWLEDGE_WRITE_RECEIPT_UNAVAILABLE' }),
      ],
    });
    expect(result.data).not.toHaveProperty('record');
  });

  test('retains the confirmed identity when real Core relation readback makes created.raw null', async () => {
    const projectRoot = makeProject();
    const create = vi.fn(async (data: Record<string, unknown>) => ({
      ...data,
      id: 'recipe-confirmed',
      title: String(data.title),
      lifecycle: 'staging',
    }));
    const update = vi.fn(async () => null);
    const evaluateReadiness = vi.fn(async () => readyReport);
    const port = new RecipeProductionGateway({
      projectRoot,
      knowledgeService: {
        create,
        update,
        updateQuality: vi.fn(async () => undefined),
        evaluateRetrievalReadiness: evaluateReadiness,
      },
    });
    const createOrStage = vi.spyOn(port, 'createOrStage');
    const save = vi.fn();
    const result = await handleKnowledge(
      'submit',
      submitParams({
        localRelationKey: 'confirmed',
        relations: { related: [{ target: 'local:confirmed', description: 'confirmed reference' }] },
        sourceGraphRefs: ['sourceGraph:fixture-relation-readback'],
      }),
      { projectRoot, recipeGateway: port, sessionStore: { save } } as never
    );

    expect(createOrStage).toHaveBeenCalledOnce();
    const coreResult = await createOrStage.mock.results[0].value;
    expect(coreResult.created).toHaveLength(1);
    expect(coreResult.created[0]).toMatchObject({
      id: 'recipe-confirmed',
      lifecycle: 'staging',
      raw: null,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'created',
      id: 'recipe-confirmed',
      candidateId: 'recipe-confirmed',
      lifecycle: 'staging',
      readiness: readyReport,
    });
    expect(result._meta).toMatchObject({
      degraded: true,
      diagnosticWarnings: [
        expect.objectContaining({ code: 'KNOWLEDGE_CREATED_DETAILS_UNAVAILABLE' }),
      ],
    });
    expect(result.data).not.toHaveProperty('description');
    expect(evaluateReadiness).toHaveBeenCalledExactlyOnceWith('recipe-confirmed');
    expect(save).toHaveBeenCalledOnce();
  });

  test.each([
    'raw getter',
    'missing-details logger',
  ])('retains the confirmed created wrapper when its optional %s fails', async (failure) => {
    const projectRoot = makeProject();
    const fake = fakePort(readyReport);
    const gateway = {
      ...fake.port,
      createOrStage: async (input: RecipeProductionInput, context: ProducerContext) => {
        const result = await fake.port.createOrStage(input, context);
        return {
          ...result,
          created: result.created.map((created) => ({
            ...created,
            raw:
              failure === 'missing-details logger'
                ? null
                : Object.defineProperty({ ...created.raw }, 'description', {
                    get() {
                      throw new Error('Fixture optional detail unavailable');
                    },
                  }),
          })),
        };
      },
    };
    const warn =
      failure === 'missing-details logger'
        ? vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {
            throw new Error('Fixture post-commit logger unavailable');
          })
        : undefined;
    try {
      const result = await submitThroughAdapter(projectRoot, gateway);
      expect(fake.calls).toHaveLength(1);
      expect(result).toMatchObject({
        ok: true,
        status: 'success',
        structuredContent: {
          status: 'created',
          id: 'recipe-1',
          candidateId: 'recipe-1',
          lifecycle: 'staging',
          readiness: readyReport,
        },
        diagnostics: { degraded: true },
      });
      expect(result.diagnostics.warnings).toContainEqual(
        expect.objectContaining({ code: 'KNOWLEDGE_CREATED_DETAILS_UNAVAILABLE' })
      );
      expect(result.structuredContent).not.toHaveProperty('description');
    } finally {
      warn?.mockRestore();
    }
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

  test('uses the real document source behind a code alias without losing its declared provenance', async () => {
    const projectRoot = makeProject();
    const code = submitParams().coreCode;
    fs.writeFileSync(
      path.join(projectRoot, 'docs/design.md'),
      `# Design\n${code}\nDocumentation footer`
    );
    fs.symlinkSync('../docs/design.md', path.join(projectRoot, 'src/document-link.ts'));
    for (const source of ['docs/design.md:2-3', 'src/document-link.ts:2-3']) {
      const fake = fakePort(readyReport);
      const params = submitParams({
        sourceRefs: [source],
        reasoning: { whyStandard: 'Documented source fact.', sources: [source], confidence: 0.95 },
      });
      const result = await submitThroughAdapter(projectRoot, fake.port, params);
      expect(fake.calls).toHaveLength(1);
      expect(result.ok).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: 'created',
        coreCode: '',
        codeEvidence: { accepted: false, reason: 'unbounded-or-unrelated' },
      });
      expect(fake.calls[0].input.items[0]).toMatchObject({
        coreCode: '',
        reasoning: { sources: [source] },
        retrievalProfile: { provenance: { evidenceRefs: [source] } },
      });
    }
  });

  test.each([
    { source: 'src/not-present.ts:2-3', code: 'SOURCE_REF_NOT_FOUND' },
    { source: 'src/a.ts:2-999', code: 'SOURCE_REF_LINE_OUT_OF_RANGE' },
    { source: 'src/a.ts', code: 'SOURCE_REF_LINE_MISSING' },
    { source: '../outside.ts:2-3', code: 'SOURCE_REF_INVALID' },
    {
      source: 'src/a.ts:2-3',
      code: 'SNIPPET_MISMATCH',
      pattern: 'export const notInSources = true;',
    },
  ])('does not bypass Core $code by adding an unsafe coreCode', async ({
    source,
    code,
    pattern,
  }) => {
    const projectRoot = makeProject();
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    try {
      for (const coreCode of ['', 'export const fabricatedEvidence = true;']) {
        const fake = fakePort(readyReport);
        const params = submitParams({
          coreCode,
          sourceRefs: [source],
          reasoning: { whyStandard: 'Fixture source claim.', sources: [source], confidence: 0.95 },
          ...(pattern ? { content: { ...submitParams().content, pattern } } : {}),
        });
        const result = await submitThroughAdapter(projectRoot, fake.port, params);
        expect(fake.calls).toHaveLength(0);
        expect(result).toMatchObject({ ok: false, status: 'error' });
        expect(result.text).toContain(code);
        if (coreCode) {
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsafe coreCode removed'));
        }
      }
    } finally {
      warn.mockRestore();
    }
  });
});
