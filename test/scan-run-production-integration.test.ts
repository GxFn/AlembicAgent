import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeRepositoryImpl } from '@alembic/core';
import { DatabaseConnection } from '@alembic/core/database';
import { pathGuard } from '@alembic/core/io';
import {
  KnowledgeFileWriter,
  KnowledgeService,
  RecipeProductionGateway,
} from '@alembic/core/knowledge';
import { describe, expect, test, vi } from 'vitest';
import { runScanAgentTask } from '../src/agent/runs/scan/ScanAgentRun.js';
import type { AgentRuntimeLike } from '../src/agent/service/AgentRunContracts.js';
import { AgentService } from '../src/agent/service/AgentService.js';
import { SystemRunContextFactory } from '../src/agent/service/SystemRunContextFactory.js';
import { handle as handleKnowledge } from '../src/tools/runtime/handlers/knowledge.js';

function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scan-projection-'));
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'src/a.ts'),
    [
      '// header',
      "import type { User } from './user.js';",
      'export const count = 1;',
      '// footer',
    ].join('\n')
  );
  return projectRoot;
}

function submitParams() {
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
    retrievalProfile: {
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
    },
  };
}

describe('scan run production projection', () => {
  test('projects the persisted pending Recipe through the real handler and Core gateway seam', async () => {
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
      const findSimilarRecipes = vi.fn(() => []);
      const port = new RecipeProductionGateway({
        knowledgeService: service,
        projectRoot,
        findSimilarRecipes,
      });
      const create = vi.spyOn(service, 'create');
      const createOrStage = vi.spyOn(port, 'createOrStage');
      const evaluateReadiness = vi.spyOn(port, 'evaluateReadiness');
      const publish = vi.spyOn(port, 'publish');
      const params = submitParams();
      const agentService = new AgentService({
        runtimeBuilder: {
          build(): AgentRuntimeLike {
            return {
              id: 'scan-production-runtime',
              async execute() {
                const toolResult = await handleKnowledge('submit', params, {
                  projectRoot,
                  recipeGateway: port,
                  sessionStore: null,
                } as never);
                if (!toolResult.ok) {
                  throw new Error(toolResult.error || String(toolResult.data));
                }
                return {
                  reply: 'Persisted one Recipe.',
                  toolCalls: [
                    {
                      tool: 'knowledge',
                      args: { action: 'submit', params },
                      result: toolResult.data,
                      durationMs: 1,
                    },
                  ],
                  tokenUsage: { input: 1, output: 1 },
                  iterations: 1,
                  durationMs: 1,
                };
              },
            };
          },
        },
      });

      const projection = await runScanAgentTask({
        agentService,
        systemRunContextFactory: new SystemRunContextFactory(),
        label: 'TypeImports',
        files: [
          {
            relativePath: 'src/a.ts',
            content: fs.readFileSync(path.join(projectRoot, 'src/a.ts'), 'utf8'),
          },
        ],
        task: 'extract',
      });

      expect(projection).toMatchObject({
        targetName: 'TypeImports',
        extracted: 1,
        recipes: [
          {
            status: 'created',
            id: expect.any(String),
            candidateId: expect.any(String),
            lifecycle: 'pending',
            title: params.title,
            description: params.description,
            trigger: params.trigger,
            readiness: { ready: true },
          },
        ],
      });
      const projected = projection.recipes[0];
      expect(projected?.candidateId).toBe(projected?.id);
      const persisted = await repository.findById(projected?.id || '');
      expect(persisted).toMatchObject({
        id: projected?.id,
        lifecycle: 'pending',
        title: params.title,
        description: params.description,
        trigger: params.trigger,
      });
      expect(createOrStage).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(evaluateReadiness).toHaveBeenCalledTimes(1);
      expect(findSimilarRecipes).toHaveBeenCalledTimes(1);
      expect(publish).not.toHaveBeenCalled();
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
});
