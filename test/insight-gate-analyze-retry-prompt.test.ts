/**
 * C53(L7-P2)：scan 管线(evaluation/stageBuilders)与 insight 预设(profiles/presets/insightPreset)的
 * analyze 阶段 retryPromptBuilder 曾是两份逐字相同的拷贝——修一处另一处会悄悄分叉。
 * 收敛后两处都委托 prompts/insightGate.ts 的内部函数 buildAnalyzeRetryPrompt。
 *
 * 这里锁住三件事：
 * 1. 防分叉：两条管线对同一 (retryCtx, prev) 产出逐字一致的重试提示，且与共享构建器一致；
 *    提示模板只在 insightGate.ts 出现一次，阶段工厂里不再有本地拷贝。
 * 2. 行为不变：提示 = 上一轮 analyze 回复 + 「⚠️ 上述分析未通过质量检查: <reason>」+ buildRetryPrompt 提示，
 *    reason 缺失时沿用旧口径(模板插值 undefined、提示按空原因路由)。
 * 3. 公开面不变：共享构建器是内部 helper，不进入 @alembic/agent/prompts 冻结名集；
 *    insightGate 原有的三个公开名仍经 ./prompts 按原值导出。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEPTH_GAP_REASON,
  GENERIC_DEPTH_GAP_HINT,
  REQUIRED_MEMORY_FINDING_SUGGESTION,
} from '../src/agent/evaluation/qualityGates.js';
import { buildScanPipelineStages } from '../src/agent/evaluation/stageBuilders.js';
import { INSIGHT_PRESET } from '../src/agent/profiles/presets/insightPreset.js';
import * as promptsFacade from '../src/agent/prompts/index.js';
import * as insightGate from '../src/agent/prompts/insightGate.js';
import { buildRetryPrompt } from '../src/agent/prompts/insightGate.js';

type RetryCtx = { reason?: string };
type AnalyzeRetryBuilder = (
  retryCtx: RetryCtx,
  origPrompt: string,
  prev: Record<string, unknown>
) => string;

const SHARED_HELPER = 'buildAnalyzeRetryPrompt';
const RETRY_TEMPLATE_MARKER = '上述分析未通过质量检查';

function analyzeRetryBuilderOf(stages: ReadonlyArray<unknown>, label: string): AnalyzeRetryBuilder {
  const stage = (stages as Array<{ name?: string; retryPromptBuilder?: unknown }>).find(
    (candidate) => candidate.name === 'analyze'
  );
  if (!stage || typeof stage.retryPromptBuilder !== 'function') {
    throw new Error(`${label}: analyze stage lacks retryPromptBuilder`);
  }
  return stage.retryPromptBuilder as AnalyzeRetryBuilder;
}

const scanAnalyzeRetry = analyzeRetryBuilderOf(
  buildScanPipelineStages({
    task: 'extract',
    producePrompt: 'scan producer system prompt',
    analyzeCaps: [],
    produceCaps: [],
  }),
  'scan pipeline'
);
const insightAnalyzeRetry = analyzeRetryBuilderOf(INSIGHT_PRESET.strategy.stages, 'insight preset');

/** 共享构建器在修复前不存在；按名从模块命名空间读取，缺失时给出明确失败而不是 TypeError。 */
function sharedAnalyzeRetry(): (retryCtx: RetryCtx, prev: Record<string, unknown>) => string {
  const candidate = (insightGate as Record<string, unknown>)[SHARED_HELPER];
  if (typeof candidate !== 'function') {
    throw new Error(`prompts/insightGate.ts does not provide ${SHARED_HELPER}`);
  }
  return candidate as (retryCtx: RetryCtx, prev: Record<string, unknown>) => string;
}

const PREV_REPLY = '## 发现\n- 入口在 src/a.ts:12 (来源: src/a.ts:12)';

const CASES: Array<{ label: string; retryCtx: RetryCtx; prev: Record<string, unknown> }> = [
  {
    label: 'depth gap with dimension names',
    retryCtx: { reason: `${DEPTH_GAP_REASON}: designIntent, tradeoffs` },
    prev: { analyze: { reply: PREV_REPLY } },
  },
  {
    label: 'depth gap with generic hint',
    retryCtx: { reason: `${DEPTH_GAP_REASON}: ${GENERIC_DEPTH_GAP_HINT}` },
    prev: { analyze: { reply: PREV_REPLY } },
  },
  {
    label: 'memory finding required',
    retryCtx: { reason: REQUIRED_MEMORY_FINDING_SUGGESTION },
    prev: { analyze: { reply: PREV_REPLY } },
  },
  {
    label: 'known short-analysis reason',
    retryCtx: { reason: 'Analysis too short' },
    prev: { analyze: { reply: PREV_REPLY }, quality_gate: { pass: false } },
  },
  {
    label: 'unknown reason, analyze reply missing',
    retryCtx: { reason: 'something else' },
    prev: { analyze: {} },
  },
  { label: 'reason missing, analyze phase missing', retryCtx: {}, prev: {} },
  {
    label: 'empty reply string',
    retryCtx: { reason: 'Too few file references' },
    prev: { analyze: { reply: '' } },
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('analyze retry prompt is single-sourced in prompts/insightGate (C53)', () => {
  it.each(CASES)('$label：scan 与 insight 两条管线的 analyze 重试提示逐字一致', ({
    retryCtx,
    prev,
  }) => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const scanPrompt = scanAnalyzeRetry(retryCtx, 'original prompt', prev);
    const insightPrompt = insightAnalyzeRetry(retryCtx, 'original prompt', prev);
    expect(scanPrompt).toBe(insightPrompt);
    expect(scanPrompt).toBe(sharedAnalyzeRetry()(retryCtx, prev));
  });

  it('保持旧提示口径：上一轮回复 + 失败原因 + buildRetryPrompt 提示', () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const build = sharedAnalyzeRetry();
    const reason = 'Analysis lacks structure';
    expect(build({ reason }, { analyze: { reply: PREV_REPLY } })).toBe(
      `${PREV_REPLY}\n\n⚠️ 上述分析未通过质量检查: ${reason}\n\n${buildRetryPrompt(reason)}`
    );
    // reason 缺失：模板沿用旧插值(undefined)，提示按空原因路由到通用深挖文案；没有上一轮回复时以空串开头。
    expect(build({}, {})).toBe(
      `\n\n⚠️ 上述分析未通过质量检查: undefined\n\n${buildRetryPrompt('')}`
    );
  });

  it('上一轮 analyze 回复缺失时留下可区分的观测日志', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const build = sharedAnalyzeRetry();
    build({ reason: 'Analysis too short' }, {});
    build({ reason: 'Analysis too short' }, { analyze: { reply: PREV_REPLY } });
    const messages = info.mock.calls.map((call) => String(call[0]));
    const analyzeRetryLogs = messages.filter((message) =>
      message.includes('[InsightGate] analyze retry prompt')
    );
    expect(analyzeRetryLogs).toHaveLength(2);
    expect(analyzeRetryLogs[0]).toContain('path=no-previous-analysis');
    expect(analyzeRetryLogs[0]).toContain('prevAnalysisChars=0');
    expect(analyzeRetryLogs[1]).toContain('path=with-previous-analysis');
    expect(analyzeRetryLogs[1]).toContain(`prevAnalysisChars=${PREV_REPLY.length}`);
  });

  it('提示模板只在 insightGate.ts 定义一次，阶段工厂不再保留本地拷贝', () => {
    const read = (relativePath: string) =>
      readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    for (const relativePath of [
      'src/agent/evaluation/stageBuilders.ts',
      'src/agent/profiles/presets/insightPreset.ts',
    ]) {
      const source = read(relativePath);
      expect({ relativePath, hasLocalTemplate: source.includes(RETRY_TEMPLATE_MARKER) }).toEqual({
        relativePath,
        hasLocalTemplate: false,
      });
      expect({ relativePath, delegates: source.includes(SHARED_HELPER) }).toEqual({
        relativePath,
        delegates: true,
      });
    }
    const gateSource = read('src/agent/prompts/insightGate.ts');
    expect(gateSource.split(RETRY_TEMPLATE_MARKER)).toHaveLength(2);
  });

  it('共享构建器不进入 @alembic/agent/prompts 名集，insightGate 原有公开名照旧导出', () => {
    expect(typeof sharedAnalyzeRetry()).toBe('function');
    expect(Object.hasOwn(promptsFacade, SHARED_HELPER)).toBe(false);
    const facade = promptsFacade as Record<string, unknown>;
    const publicGateNames = Object.keys(insightGate)
      .filter((name) => name !== SHARED_HELPER)
      .sort();
    expect(publicGateNames).toEqual([
      'buildRecordRepairPrompt',
      'buildRetryPrompt',
      'buildSummaryRewritePrompt',
    ]);
    for (const name of publicGateNames) {
      expect({
        name,
        same: facade[name] === (insightGate as Record<string, unknown>)[name],
      }).toEqual({ name, same: true });
    }
  });
});
