import fs from 'node:fs';
import os from 'node:os';
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
import { describe, expect, test } from 'vitest';
import { handle as handleKnowledge } from '../src/tools/runtime/handlers/knowledge.js';

function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-recipe-profile-'));
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
  ])('%s cannot inject code or retain an activatable profile', async (_name, override) => {
    const projectRoot = makeProject();
    const fake = fakePort({
      ...readyReport,
      ready: false,
      profileHash: null,
      documentSetHash: null,
      violations: [
        {
          code: 'retrieval.profile.missing',
          field: 'retrievalProfile',
          message: 'A native retrieval profile is required before active publish.',
        },
      ],
    });
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
    expect(item.retrievalProfile ?? null).toBeNull();
    expect(result.data).toMatchObject({
      lifecycle: 'pending',
      readiness: {
        ready: false,
        violations: [{ code: 'retrieval.profile.missing' }],
      },
    });
    expect(fake.publishCalls).toBe(0);
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
    const { prepareRecipeProductionItem } = await import(
      '../src/tools/runtime/handlers/recipeProductionAdapter.js'
    );
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
        expect(prepared.item.retrievalProfile ?? null).toBeNull();
        expect(prepared.codeEvidence.accepted).toBe(false);
      }
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });
});
