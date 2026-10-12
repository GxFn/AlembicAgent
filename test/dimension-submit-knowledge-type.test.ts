/**
 * I37：维度运行的 knowledge.submit 广告面要让模型能在本维度 allowedKnowledgeTypes 内自选
 * knowledgeType——schema 变体给出可选 enum，Producer 提示说明自选与回落规则，AgentRuntime
 * 用当前维度（sharedState._dimensionMeta）的允许列表构造变体。执行面不收紧：列表外的值由
 * 提交归一化回落并留诊断（见 recipe-production-profile-adapter.test.ts）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildProducerPrompt,
  buildProducerPromptV2,
} from '../src/agent/prompts/insightProducer.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import {
  applyDimensionSubmitSchemaVariant,
  generateLightweightSchemas,
  TOOL_REGISTRY,
} from '../src/tools/runtime/registry.js';

type R = Record<string, unknown>;

const ARCHITECTURE_TYPES = ['architecture', 'module-dependency', 'boundary-constraint'];

function submitParamsOf(schema: R | undefined): R {
  return ((schema?.parameters as R).properties as R).params as R;
}

function knowledgeSchema(schemas: R[]): R | undefined {
  return schemas.find((schema) => schema.name === 'knowledge');
}

describe('dimension submit schema advertises the allowed knowledgeType enum', () => {
  it('adds an optional knowledgeType enum built from the current dimension list', () => {
    const base = generateLightweightSchemas({ knowledge: ['submit'] }) as unknown as R[];
    const variant = applyDimensionSubmitSchemaVariant(base, {
      allowedKnowledgeTypes: [...ARCHITECTURE_TYPES, 'architecture', '  ', 7],
    });
    const params = submitParamsOf(knowledgeSchema(variant));
    const knowledgeType = (params.properties as R).knowledgeType as R;
    expect(knowledgeType).toMatchObject({ type: 'string', enum: ARCHITECTURE_TYPES });
    expect(String(knowledgeType.description)).toContain('architecture');
    // 可选：不进入 required，缺失时由提交归一化回落并留诊断。
    expect(params.required as string[]).not.toContain('knowledgeType');
    // 原件与静态注册表都不被变体污染。
    expect((submitParamsOf(knowledgeSchema(base)).properties as R).knowledgeType).toBeUndefined();
    expect(
      (TOOL_REGISTRY.knowledge.actions.submit.params.properties as R).knowledgeType
    ).toBeUndefined();
  });

  it('does not advertise knowledgeType when the dimension has no usable allowed list', () => {
    const base = generateLightweightSchemas({ knowledge: ['submit'] }) as unknown as R[];
    for (const options of [
      undefined,
      {},
      { allowedKnowledgeTypes: [] },
      { allowedKnowledgeTypes: 'architecture' },
    ]) {
      const variant = applyDimensionSubmitSchemaVariant(base, options);
      const params = submitParamsOf(knowledgeSchema(variant));
      expect((params.properties as R).knowledgeType).toBeUndefined();
      // 既有变体行为保持：evidenceRefs 必填。
      expect(((params.properties as R).reasoning as R).required).toEqual(['evidenceRefs']);
    }
  });
});

describe('Producer prompt explains knowledgeType self-selection', () => {
  const analysis = { analysisText: 'analysis', referencedFiles: [] };
  const dimConfig = {
    id: 'architecture',
    label: '架构',
    allowedKnowledgeTypes: ARCHITECTURE_TYPES,
  };

  it.each([
    ['v1', () => buildProducerPrompt(analysis, dimConfig, { name: 'Demo' })],
    [
      'v2',
      () =>
        buildProducerPromptV2({ ...analysis, findings: [], negativeSignals: [] }, dimConfig, {
          name: 'Demo',
        }),
    ],
  ])('%s tells the model to pick params.knowledgeType from the allowed list', (_name, build) => {
    const prompt = build();
    expect(prompt).toContain('params.knowledgeType');
    expect(prompt).toContain('自选');
    expect(prompt).toContain(ARCHITECTURE_TYPES.join(', '));
    // 回落规则对模型可见：缺失或不在列表内时由宿主取列表第一个并记录诊断。
    expect(prompt).toContain('回落为 architecture');
  });

  it('keeps the unrestricted wording when the dimension lists no types', () => {
    const prompt = buildProducerPrompt(
      analysis,
      { id: 'architecture', label: '架构' },
      { name: 'Demo' }
    );
    expect(prompt).toContain('允许的 knowledgeType: (all)');
    expect(prompt).not.toContain('回落为');
  });
});

describe('AgentRuntime builds the dimension submit variant from the current dimension', () => {
  it('sends the knowledgeType enum of sharedState._dimensionMeta to the provider', async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'alembic-agent-knowledge-type-'));
    const capture: { toolSchemas?: R[] } = {};
    const chatWithTools = vi.fn(async (_prompt: string, opts?: R) => {
      capture.toolSchemas = opts?.toolSchemas as R[] | undefined;
      return { text: 'done', functionCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const schemas = generateLightweightSchemas({ knowledge: ['submit'] }) as unknown as R[];
    const runtime = new AgentRuntime({
      id: 'session:knowledge-type-variant',
      dataRoot,
      jobId: 'job:knowledge-type-variant',
      aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute: vi.fn(), releaseScope: vi.fn() } as never,
      container: {
        get: (name: string) =>
          name === 'capabilityCatalog'
            ? {
                toToolSchemas: (ids?: readonly string[] | null) =>
                  schemas.filter((schema) => ids?.includes(String(schema.name))),
              }
            : undefined,
      } as never,
      capabilities: [],
      additionalTools: ['knowledge'],
      strategy: { name: 'unused', execute: vi.fn() } as never,
    });
    runtime.logger = { info: () => undefined, warn: () => undefined };
    try {
      await runtime.reactLoop('produce architecture candidates', {
        source: 'system',
        sharedState: {
          _bootstrapSessionId: 'job:knowledge-type-variant',
          _dimensionMeta: { id: 'architecture', allowedKnowledgeTypes: ARCHITECTURE_TYPES },
        },
        budgetOverride: { maxIterations: 1, timeoutMs: 1_000 },
      });
      expect(chatWithTools).toHaveBeenCalled();
      const params = submitParamsOf(knowledgeSchema(capture.toolSchemas ?? []));
      expect(((params.properties as R).reasoning as R).required).toEqual(['evidenceRefs']);
      expect((params.properties as R).knowledgeType).toMatchObject({ enum: ARCHITECTURE_TYPES });
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});
