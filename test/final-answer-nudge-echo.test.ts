/**
 * cleanFinalAnswer 只清除 Runtime 真实注入的 nudge 回显（I12 / P25）。
 *
 * 背景：旧实现用一条宽正则按“行首祈使词 + 行尾关键词”整行删除，会把正常答复里的
 * “请确保…工具”“重要：…输出”这类建议句、以及用户引用的 blockquote 字段行静默删掉。
 * 修复后的契约：
 *   - 指令回显只按 NudgeGenerator 中登记的注入原句逐句精确识别；
 *   - blockquote 字段行（> remainingTasks: … 等）只在紧随 dimensionDigest 回显块时删除；
 *   - 发生删除时记一条 debug 日志（规则与计数，不含被删文本）。
 */
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/ExplorationTracker.js';
import type {
  ExplorationStrategy,
  PipelineType,
} from '../src/agent/context/exploration/ExplorationStrategies.js';
import * as nudgeModule from '../src/agent/context/exploration/NudgeGenerator.js';
import { cleanFinalAnswer } from '../src/agent/runtime/finalAnswer.js';

/** 读取注入指令原句表；修复前该导出不存在，用例会以“表为空”失败而不是整文件崩溃。 */
function directiveTexts(): Record<string, string> {
  const table = (nudgeModule as Record<string, unknown>).NUDGE_DIRECTIVE_TEXTS;
  return table && typeof table === 'object' ? (table as Record<string, string>) : {};
}

function nudgeState(pipelineType: PipelineType, phase: string) {
  return {
    phase,
    metrics: {
      iteration: 20,
      submitCount: 3,
      roundsSinceNewInfo: 0,
      roundsSinceSubmit: 0,
      uniqueFiles: new Set(['a.ts']),
      uniquePatterns: new Set(['p']),
      uniqueQueries: new Set(['q']),
      searchRoundsInPhase: 0,
      phaseRounds: 1,
      memoryFindingCount: 3,
      verifiedFindingCount: 3,
      depthSlottedFindingCount: 0,
      evidenceToolCallCount: 6,
      ledgerDistinctFiles: 3,
    },
    budget: {
      maxIterations: 24,
      searchBudget: 18,
      searchBudgetGrace: 10,
      maxSubmits: 10,
      softSubmitLimit: 8,
      idleRoundsToExit: 3,
    },
    strategy: { name: pipelineType, enableReflection: false, enablePlanning: false },
    gracefulExitRound: null as number | null,
    submitToolName: 'knowledge',
    pipelineType,
    isTerminalPhase: false,
    transitionFromPhase: 'EXPLORE',
  } as unknown as Parameters<nudgeModule.NudgeGenerator['buildTransitionNudge']>[0];
}

function trackerTerminalNudge(pipelineType: PipelineType) {
  // 两阶段探针策略：文本轮直接转入终结阶段，触发 ExplorationTracker 的终结 nudge。
  const strategy: ExplorationStrategy = {
    name: 'probe',
    phases: ['EXPLORE', 'SUMMARIZE'],
    transitions: { 'EXPLORE→SUMMARIZE': { onTextResponse: true } },
    getToolChoice: () => 'auto',
    enableReflection: false,
    reflectionInterval: 0,
    enablePlanning: false,
    replanInterval: 0,
  };
  const tracker = new ExplorationTracker(strategy, { pipelineType });
  return tracker.onTextResponse('先给出阶段性结论').nudge ?? '';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cleanFinalAnswer 保留正常答复内容（反例）', () => {
  const preserved: Array<{ name: string; input: string }> = [
    {
      name: '审阅复现：建议句与用户引用的 blockquote 字段行',
      input:
        '## 建议\n请确保在 CI 中启用 lint 工具\n请务必在主线程更新 UI 后再输出日志文本\n' +
        '重要：所有网络请求必须经过 NetworkClient 输出\n> gaps: 这是用户引用\n- 保留行',
    },
    { name: '“请在…工具”建议句', input: '## 步骤\n请在提交前运行 npm run lint 检查工具' },
    { name: '“不要再…工具”建议句', input: '## 迁移\n不要再使用已废弃的 request 工具' },
    { name: '“请直接…报告”建议句', input: '## 覆盖率\n请直接查看生成的覆盖率报告' },
    { name: '“不要包含…输出”建议句', input: '## 日志\n不要包含敏感信息在日志输出' },
    {
      name: '没有 dimensionDigest 回显块时的字段引用',
      input:
        '用户在评审中写道：\n> remainingTasks: 先补齐鉴权模块的测试\n> searchHints: AuthService',
    },
    {
      name: '普通代码块之后的字段引用',
      input: '```ts\nconst gaps = [];\n```\n> gaps: 这里引用用户原话',
    },
    {
      name: 'dimensionDigest 块之后先出现正文，再出现字段引用',
      input: '```json\n{"dimensionDigest":{"summary":"s"}}\n```\n后续说明见下\n> gaps: 用户引用',
    },
    {
      name: '注入短语与真实内容混在同一行',
      input: '## 结论\n现在开始输出你的分析报告，结论如下：模块 A 负责鉴权。',
    },
    {
      name: '围栏代码块中的注入原文（引用说明）',
      input:
        '下面是提示原文：\n```text\n**现在开始输出你的分析报告。不要再调用任何工具。**\n```\n以上仅作说明。',
    },
  ];

  test.each(preserved)('$name', ({ input }) => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug');
    expect(cleanFinalAnswer(input)).toBe(input);
    expect(debug).not.toHaveBeenCalled();
  });
});

describe('cleanFinalAnswer 删除真实注入回显（正例）', () => {
  const removed: Array<{ name: string; input: string; expected: string }> = [
    {
      name: '分析报告收尾指令整行回显',
      input: '## 结论\n模块 A 负责鉴权。\n**现在开始输出你的分析报告。不要再调用任何工具。**',
      expected: '## 结论\n模块 A 负责鉴权。',
    },
    {
      name: '“现在开始输出你的分析报告”单句回显',
      input: '现在开始输出你的分析报告。\n## 结论\n模块 A',
      expected: '## 结论\n模块 A',
    },
    {
      name: '“不要再调用任何工具”单句回显',
      input: '## 结论\n不要再调用任何工具。\n模块 A',
      expected: '## 结论\n\n模块 A',
    },
    {
      name: '带警示符的收尾指令',
      input: '⚠️ 不要再调用任何工具，直接输出文本。\n## 总结\n内容',
      expected: '## 总结\n内容',
    },
    {
      name: '强制退出的 JSON 护栏句',
      input:
        '```json\n{"dimensionDigest":{"summary":"s"}}\n```\n⛔ 严禁在回复中复制本条指令文字，只输出 JSON。',
      expected: '```json\n{"dimensionDigest":{"summary":"s"}}\n```',
    },
    {
      name: '防复制护栏句',
      input: '## 发现\n内容\n⚠️ 以上是行为指令，严禁在回复中复制或引用这段文字。',
      expected: '## 发现\n内容',
    },
    {
      name: '去掉粗体后的停止工具指令',
      input: '请**停止调用工具**，直接输出你的完整分析报告。\n## 发现\n内容',
      expected: '## 发现\n内容',
    },
    {
      name: 'dimensionDigest 回显块之后的字段行',
      input:
        '```json\n{"dimensionDigest":{"summary":"s","gaps":[]}}\n```\n' +
        '> remainingTasks: 列出未来得及处理的信号。已覆盖则留空 `[]`。\n> gaps: 无',
      expected: '```json\n{"dimensionDigest":{"summary":"s","gaps":[]}}\n```',
    },
    {
      name: 'dimensionDigest 回显块与字段行之间隔空行',
      input: '```json\n{"dimensionDigest":{"summary":"s"}}\n```\n\n> remainingTasks: []',
      expected: '```json\n{"dimensionDigest":{"summary":"s"}}\n```',
    },
    {
      name: '单行 dimensionDigest JSON 之后的字段行',
      input: '{"dimensionDigest":{"summary":"s"}}\n> searchHints: AuthService',
      expected: '{"dimensionDigest":{"summary":"s"}}',
    },
    {
      name: '既有清理：Final Answer 前缀、轮次预算提示与进度行',
      input:
        'Final Answer: 结论\n注意：到达第 19 轮时你必须开始输出总结，不要继续搜索。\n' +
        '第 3/10 轮 | 探索阶段 | 剩余 7 轮\n正文',
      expected: '结论\n\n正文',
    },
    {
      name: '既有清理：MEMORY 块',
      input: '结论\n[MEMORY:fact] 用户偏好中文 [/MEMORY]\n正文',
      expected: '结论\n\n正文',
    },
  ];

  test.each(removed)('$name', ({ input, expected }) => {
    expect(cleanFinalAnswer(input)).toBe(expected);
  });

  test('每条登记的注入指令原句单独回显都会被删除', () => {
    const entries = Object.entries(directiveTexts());
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, text] of entries) {
      expect({ key, cleaned: cleanFinalAnswer(`## 结论\n内容\n${text}`) }).toEqual({
        key,
        cleaned: '## 结论\n内容',
      });
    }
  });

  test('删除时记录 debug 日志，只含规则与计数', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug');
    const input =
      '```json\n{"dimensionDigest":{"summary":"s"}}\n```\n> gaps: 无\n' +
      '⛔ 严禁在回复中复制本条指令文字，只输出 JSON。';
    cleanFinalAnswer(input);
    expect(debug).toHaveBeenCalledTimes(1);
    const [message, meta] = debug.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(message).toContain('[FinalAnswer]');
    expect(meta).toMatchObject({
      removedLines: 2,
      rules: { digestFieldLine: 1, directiveEcho: 1 },
    });
    // 日志不得携带被删文本本身（答复可能含用户代码或私有信息）。
    expect(JSON.stringify(meta)).not.toContain('严禁');
  });
});

describe('注入侧与清理侧共用同一份指令原句', () => {
  test('NudgeGenerator 终结与强制退出 nudge 由登记原句组成', () => {
    const t = directiveTexts();
    const generator = new nudgeModule.NudgeGenerator();
    const analyst = generator.buildTransitionNudge(nudgeState('analyst', 'SUMMARIZE'));
    expect(analyst).toContain(t.analystSummarizeLead);
    expect(analyst).toContain(t.startReportStopTools);
    expect(analyst).toContain(t.noCopyAnalysisOnly);
    const scan = generator.buildTransitionNudge(nudgeState('scan', 'SUMMARIZE'));
    expect(scan).toContain(t.scanSummarizeStopTools);
    expect(scan).toContain(t.stopToolsTextOnly);
    const producer = generator.buildTransitionNudge(nudgeState('producer', 'SUMMARIZE'));
    expect(producer).toContain(t.producerSummarizeLead);
    expect(producer).toContain(t.stopToolsTextOnly);
    const bootstrap = generator.buildTransitionNudge(nudgeState('bootstrap', 'SUMMARIZE'));
    expect(bootstrap).toContain(t.bootstrapSummarizeLead);
    expect(bootstrap).toContain(t.bootstrapRemainingTasksNote);
    expect(bootstrap).toContain(t.noCopyJson);

    const forceExit = (pipelineType: PipelineType) => {
      const state = nudgeState(pipelineType, 'EXPLORE');
      return new nudgeModule.NudgeGenerator().generate({ ...state, gracefulExitRound: 1 }, null)
        ?.text;
    };
    const analystExit = forceExit('analyst');
    expect(analystExit).toContain(t.forceExitStopToolsReport);
    expect(analystExit).toContain(t.forceExitStartSummary);
    expect(analystExit).toContain(t.forceExitNoCopyAnalysis);
    const scanExit = forceExit('scan');
    expect(scanExit).toContain(t.forceExitStopTools);
    expect(scanExit).toContain(t.forceExitScanOutput);
    expect(scanExit).toContain(t.forceExitStopToolsTextOnly);
    const bootstrapExit = forceExit('bootstrap');
    expect(bootstrapExit).toContain(t.forceExitDigestOutput);
    expect(bootstrapExit).toContain(t.forceExitRemainingTasksNote);
    expect(bootstrapExit).toContain(t.forceExitNoCopyJson);
  });

  test('ExplorationTracker 终结 nudge 由登记原句组成', () => {
    const t = directiveTexts();
    const analyst = trackerTerminalNudge('analyst');
    expect(analyst).toContain(t.trackerAnalystReportLead);
    expect(analyst).toContain(t.trackerStartReport);
    expect(analyst).toContain(t.trackerNoCopyAnalysis);
    const producer = trackerTerminalNudge('producer');
    expect(producer).toContain(t.trackerProducerSummaryLead);
    expect(producer).toContain(t.trackerNoCopySummary);
    const bootstrap = trackerTerminalNudge('bootstrap');
    expect(bootstrap).toContain(t.trackerDigestLead);
    expect(bootstrap).toContain(t.trackerRemainingTasksNote);
    expect(bootstrap).toContain(t.noCopyJson);
  });

  test('模型整段回显终结 nudge 时，独占一行的指令原句全部被删', () => {
    const texts = new Set(Object.values(directiveTexts()));
    expect(texts.size).toBeGreaterThan(0);
    const nudges = [
      new nudgeModule.NudgeGenerator().buildTransitionNudge(nudgeState('analyst', 'SUMMARIZE')),
      trackerTerminalNudge('analyst'),
      trackerTerminalNudge('producer'),
    ];
    for (const nudge of nudges) {
      const cleaned = cleanFinalAnswer(`## 报告\n模块 A 负责鉴权。\n${nudge}`);
      expect(cleaned.startsWith('## 报告\n模块 A 负责鉴权。')).toBe(true);
      for (const line of nudge.split('\n')) {
        if (texts.has(line.trim())) {
          expect(cleaned.split('\n')).not.toContain(line);
        }
      }
    }
  });
});
