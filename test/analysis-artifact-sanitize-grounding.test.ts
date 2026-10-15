/**
 * L7-P16（C06 / C43 / C47）：analysisArtifact 的 nudge 回显清理与锚点补读读盘诊断。
 *
 * - C06/C47：sanitizeAnalysisText 的多行块正则此前在 m 标志下把 `$` 当成“任意行尾”，惰性匹配
 *   到首个行尾即停，只删掉块的第一行；结尾的计划小节没有文本结尾分支，完全不删。这里的样本
 *   全部取自 NudgeGenerator / PlanTracker 的真实生成函数（不复制文案），覆盖块在中间、在结尾、
 *   后跟真实小节以及后跟无标题正文四种位置，断言整块清除且正文保留。
 * - C06 防过度清理：生产链上 AgentRuntime 先用 cleanFinalAnswer 删掉反思块末尾的防复制收尾句，
 *   sanitize 收到的回显块没有这句话。这里按真实链路 cleanFinalAnswer → sanitizeAnalysisText，以中期反思、
 *   停滞反思、PRODUCE 阶段反思与只回显思考方向的真实输出为样本，断言块后的无标题正文完整保留。
 * - C43：锚点补读的读盘端口此前用无参 catch 吞掉所有异常；现在按根外拒绝 / 文件缺失 / 行号越界 /
 *   空范围 / 其它读取错误分类计数，并入既有 `[AnalysisArtifact] anchor grounding` 日志。
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { describe, expect, it, vi } from 'vitest';
import { NudgeGenerator } from '../src/agent/context/exploration/NudgeGenerator.js';
import { PlanTracker } from '../src/agent/context/exploration/PlanTracker.js';
import {
  buildAnalysisArtifact,
  buildAnalysisReport,
  sanitizeAnalysisText,
} from '../src/agent/evaluation/analysisArtifact.js';
import { cleanFinalAnswer } from '../src/agent/runtime/finalAnswer.js';
import { createTempProject } from './helpers/tempProject.js';

type NudgeStateArg = Parameters<NudgeGenerator['generate']>[0];
type NudgeTraceArg = Parameters<NudgeGenerator['generate']>[1];
type PlanStateArg = Parameters<PlanTracker['checkPlanning']>[0];
type PlanTraceArg = Parameters<PlanTracker['checkPlanning']>[1];

/** 未读取过的“幽灵”路径：只出现在回显的思考方向里，清理后不得残留进正文或 referencedFiles。 */
const GHOST_THOUGHTS = ['看 src/ghost/router.ts 的路由分发', '查 src/ghost/cache.ts 的缓存失效'];

/** 反思样本的可变参数：轮次、停滞轮数、阶段与是否带思考方向 / 计划进度。 */
interface ReflectionSampleOptions {
  iteration?: number;
  roundsSinceNewInfo?: number;
  phase?: 'EXPLORE' | 'PRODUCE';
  thoughts?: string[];
  withPlan?: boolean;
}

/**
 * NudgeGenerator #checkReflection 的真实输出（经公开的 generate 入口取得，不复制文案）。
 * 默认是第 8/20 轮的周期反思（中期反思，反思间隔 4，带思考方向与计划进度）；
 * 第 9/20 轮、连续 5 轮无新信息时同一入口产出停滞反思（9 不是间隔 4 的倍数，未到 10 轮最少探索
 * 轮次，收敛提示与 75% 预算警告都不抢先）。
 */
function generateReflection(options: ReflectionSampleOptions = {}): string {
  const {
    iteration = 8,
    roundsSinceNewInfo = 0,
    phase = 'EXPLORE',
    thoughts = GHOST_THOUGHTS,
    withPlan = true,
  } = options;
  const state = {
    phase,
    metrics: {
      iteration,
      roundsSinceNewInfo,
      roundsSinceSubmit: 0,
      searchRoundsInPhase: 0,
      phaseRounds: 0,
      submitCount: 0,
      evidenceToolCallCount: 0,
      memoryFindingCount: 0,
      uniqueFiles: new Set(['src/a.ts', 'src/b.ts']),
      uniquePatterns: new Set(['router']),
      uniqueQueries: new Set<string>(),
    },
    budget: { maxIterations: 20, searchBudget: 10, softSubmitLimit: 0, maxSubmits: 0 },
    strategy: {
      name: 'analyst',
      enableReflection: true,
      reflectionInterval: 4,
      enablePlanning: withPlan,
    },
    gracefulExitRound: null,
    submitToolName: 'knowledge',
    pipelineType: 'analyst',
    isTerminalPhase: false,
  } as unknown as NudgeStateArg;
  const trace = {
    getRecentSummary: () => ({ thoughts, roundCount: 4, newInfoRatio: 0.5 }),
    getStats: () => ({ totalActions: 12 }),
    getPlan: () => ({ steps: [{ status: 'done' }, { status: 'pending' }] }),
    setReflection: () => undefined,
  } as unknown as NudgeTraceArg;
  const nudge = new NudgeGenerator().generate(state, trace);
  // 样本自检：确实拿到了反思 nudge，且是多行块（首行之后还有评估问题和防复制指令）。
  expect(nudge?.type).toBe('reflection');
  const text = nudge?.text ?? '';
  expect(text).toMatch(/^📊 (?:中期|停滞)反思 \(/);
  expect(text).toContain('请评估:');
  return text;
}

/** NudgeGenerator 周期反思的真实输出（第 8/20 轮、反思间隔 4、启用计划进度）。 */
function realReflectionNudge(): string {
  const text = generateReflection();
  expect(text).toMatch(/^📊 中期反思 \(/);
  expect(text).toContain('你最近的思考方向:');
  return text;
}

/** NudgeGenerator 停滞反思的真实输出（第 9/20 轮、连续 5 轮无新信息）。 */
function realStagnationReflectionNudge(): string {
  const text = generateReflection({ iteration: 9, roundsSinceNewInfo: 5 });
  expect(text).toMatch(/^📊 停滞反思 \(第 9\/20 轮, 连续 5 轮无新信息\):/);
  expect(text).toContain('你最近的思考方向:');
  return text;
}

/** 反思 nudge 中“你最近的思考方向”段落（Analyst 只回显这一段时的真实形状）。 */
function realThoughtDirectionParagraph(): string {
  const paragraph = realReflectionNudge()
    .split('\n\n')
    .find((part) => part.startsWith('你最近的思考方向:'));
  expect(paragraph).toBeDefined();
  return paragraph ?? '';
}

/**
 * PlanTracker 首轮计划征集的真实示例步骤（编号列表）。Analyst 按该征集写出的计划就是
 * sanitize 要清掉的“### 探索计划 / ## 执行计划”小节正文。
 */
function realPlanSteps(): string[] {
  const state = {
    phase: 'EXPLORE',
    metrics: { iteration: 1 },
    budget: { maxIterations: 24 },
    strategy: { replanInterval: 8 },
    pipelineType: 'analyst',
    isTerminalPhase: false,
  } as unknown as PlanStateArg;
  const trace = { expectPlan: () => undefined } as unknown as PlanTraceArg;
  const elicitation = new PlanTracker().checkPlanning(state, trace);
  expect(elicitation?.type).toBe('planning');
  const steps = (elicitation?.text ?? '').match(/^\d+\.\s.+$/gm) ?? [];
  expect(steps.length).toBeGreaterThanOrEqual(3);
  return steps;
}

describe('sanitizeAnalysisText 以真实 nudge 模板为样本整块清除 (L7-P16/C06/C47)', () => {
  it('反思块在两个真实小节之间：整块删除，前后小节原样保留', () => {
    const text = `## 结论\n正文A\n\n${realReflectionNudge()}\n\n## 模块分析\n正文B`;
    expect(sanitizeAnalysisText(text)).toBe('## 结论\n正文A\n\n## 模块分析\n正文B');
  });

  it('反思块位于文本结尾：整块删除，不残留思考方向与防复制指令', () => {
    const text = `## 结论\n正文A\n\n${realReflectionNudge()}`;
    expect(sanitizeAnalysisText(text)).toBe('## 结论\n正文A');
  });

  it('反思块在开头且后跟真实小节：整块删除，小节保留', () => {
    const text = `${realReflectionNudge()}\n\n## 模块分析\n真实内容见 src/real/a.ts`;
    expect(sanitizeAnalysisText(text)).toBe('## 模块分析\n真实内容见 src/real/a.ts');
  });

  it('原始回显（带防复制句）后跟无标题正文：块在防复制指令处结束，后续正文不被误删', () => {
    const text = `${realReflectionNudge()}\n\n后续分析正文：入口在 src/real/a.ts。`;
    expect(sanitizeAnalysisText(text)).toBe('后续分析正文：入口在 src/real/a.ts。');
  });

  it('只回显思考方向段落（位于结尾）：整段删除，不残留编号思考行', () => {
    const text = `## 结论\n正文A\n\n${realThoughtDirectionParagraph()}`;
    expect(sanitizeAnalysisText(text)).toBe('## 结论\n正文A');
  });

  it('回显残留不再把思考方向里的未读路径计入 referencedFiles', () => {
    const report = buildAnalysisReport(
      { reply: `## 结论\n正文A\n\n${realReflectionNudge()}`, toolCalls: [] },
      'architecture'
    );
    expect(report.analysisText).toBe('## 结论\n正文A');
    expect(report.referencedFiles).not.toContain('src/ghost/router.ts');
    expect(report.referencedFiles).not.toContain('src/ghost/cache.ts');
  });

  it('探索计划小节位于结尾：整块删除', () => {
    const text = `## 结论\n正文A\n\n### 探索计划\n${realPlanSteps().join('\n')}`;
    expect(sanitizeAnalysisText(text)).toBe('## 结论\n正文A');
  });

  it('探索计划小节后跟真实小节：整块删除，小节保留', () => {
    const text = `### 探索计划\n${realPlanSteps().join('\n')}\n\n## 模块分析\n正文B`;
    expect(sanitizeAnalysisText(text)).toBe('## 模块分析\n正文B');
  });

  it('探索计划小节后跟空行与正文段落：计划删除，正文段落不被误删', () => {
    const text = `### 探索计划\n${realPlanSteps().join('\n')}\n\n入口逻辑在 src/real/a.ts 中完成。`;
    expect(sanitizeAnalysisText(text)).toBe('入口逻辑在 src/real/a.ts 中完成。');
  });

  it('执行计划小节位于结尾：整块删除（此前没有文本结尾分支，原样保留）', () => {
    const steps = realPlanSteps().map((step) => step.replace(/^\d+\.\s/, '- '));
    const text = `## 结论\n正文A\n\n## 执行计划\n${steps.join('\n')}`;
    expect(sanitizeAnalysisText(text)).toBe('## 结论\n正文A');
  });

  it('执行计划小节在中间：沿用原终止条件，后续真实小节保留', () => {
    const steps = realPlanSteps().map((step) => step.replace(/^\d+\.\s/, '- '));
    const text = `## 执行计划\n${steps.join('\n')}\n\n## 结论\n正文A`;
    expect(sanitizeAnalysisText(text)).toBe('## 结论\n正文A');
  });

  it('轮次小节位于结尾：整块删除', () => {
    const text = `## 结论\n正文A\n\n## 第 3 轮：继续探索\n- 读取路由\n- 检查缓存\n- 汇总发现`;
    expect(sanitizeAnalysisText(text)).toBe('## 结论\n正文A');
  });
});

/**
 * 生产链：AgentRuntime 以 cleanFinalAnswer(llmResult.text) 作为最终答复，gateEvaluators 再把它交给
 * buildAnalysisArtifact → sanitizeAnalysisText。cleanFinalAnswer 已按 NUDGE_DIRECTIVE_TEXTS 逐行删掉
 * 反思块末尾的防复制指令句，所以到达 sanitize 的回显块没有固定收尾句；块的终止不能只靠这句话，
 * 否则块会一直吞到文本结尾，把 Analyst 按“不需要特定格式”写的无标题正文整段删掉。
 */
function throughProductionChain(llmText: string): string {
  return sanitizeAnalysisText(cleanFinalAnswer(llmText));
}

/** Analyst 的无标题正文：两段散文 + 一个编号段落（编号段落不是反思模板的段落开头）。 */
const UNHEADED_PROSE = [
  '后续分析正文：入口在 src/real/a.ts。',
  '第二段正文。',
  '',
  '1. 路由分发在 src/real/router.ts 完成。',
  '2. 缓存失效由 src/real/cache.ts 负责。',
].join('\n');

describe('生产链 cleanFinalAnswer → sanitizeAnalysisText：回显块之后的无标题正文完整保留 (L7-P16/C06)', () => {
  const reflectionSamples: Array<[string, () => string]> = [
    ['中期反思（带思考方向与计划进度）', realReflectionNudge],
    ['停滞反思', realStagnationReflectionNudge],
    [
      'PRODUCE 阶段中期反思（无思考方向、无计划进度）',
      () => generateReflection({ phase: 'PRODUCE', thoughts: [], withPlan: false }),
    ],
  ];

  for (const [label, sample] of reflectionSamples) {
    it(`${label}：防复制句已被 cleanFinalAnswer 删除，块后正文原样保留、块整体清除`, () => {
      const nudge = sample();
      // 前提自检：cleanFinalAnswer 确实删掉了固定收尾句（这正是生产输入的形状）。
      expect(cleanFinalAnswer(`${nudge}\n\n${UNHEADED_PROSE}`)).not.toContain('以上是行为指令');
      expect(throughProductionChain(`${nudge}\n\n${UNHEADED_PROSE}`)).toBe(UNHEADED_PROSE);
    });

    it(`${label}：位于真实小节之后、无标题正文之前，前后内容都保留`, () => {
      const text = `## 结论\n正文A\n\n${sample()}\n\n${UNHEADED_PROSE}`;
      expect(throughProductionChain(text)).toBe(`## 结论\n正文A\n\n${UNHEADED_PROSE}`);
    });
  }

  it('只回显思考方向段落后跟无标题正文：段落清除，正文原样保留', () => {
    const text = `${realThoughtDirectionParagraph()}\n\n${UNHEADED_PROSE}`;
    expect(throughProductionChain(text)).toBe(UNHEADED_PROSE);
  });

  it('只回显反思首行（停滞反思标题）后跟正文：只删标题，正文保留', () => {
    const header = realStagnationReflectionNudge().split('\n')[0];
    expect(throughProductionChain(`${header}\n\n${UNHEADED_PROSE}`)).toBe(UNHEADED_PROSE);
  });

  it('反思块后直接跟正文行（无空行）：块在第一行非模板正文处结束', () => {
    const nudge = realReflectionNudge();
    // 模型省略防复制句、紧接着写正文：没有空行分隔，块也不能吞到文本结尾。
    const echoed = nudge.replace(/\n+⚠️[^\n]*$/, '');
    expect(throughProductionChain(`${echoed}\n${UNHEADED_PROSE}`)).toBe(UNHEADED_PROSE);
  });

  it('第 N 轮小节后跟空行与无标题正文：小节删除，正文段落不被误删', () => {
    const text = `## 第 3 轮：继续探索\n- 读取路由\n- 检查缓存\n\n${UNHEADED_PROSE}`;
    expect(throughProductionChain(text)).toBe(UNHEADED_PROSE);
  });

  it('经 buildAnalysisReport：回显块之后正文里的真实路径仍计入 referencedFiles，幽灵路径不计入', () => {
    const report = buildAnalysisReport(
      {
        reply: cleanFinalAnswer(`${realStagnationReflectionNudge()}\n\n${UNHEADED_PROSE}`),
        toolCalls: [],
      },
      'architecture'
    );
    expect(report.analysisText).toBe(UNHEADED_PROSE);
    expect(report.referencedFiles).toEqual(
      expect.arrayContaining(['src/real/a.ts', 'src/real/router.ts', 'src/real/cache.ts'])
    );
    expect(report.referencedFiles).not.toContain('src/ghost/router.ts');
    expect(report.referencedFiles).not.toContain('src/ghost/cache.ts');
  });
});

describe('锚点补读读盘端口按原因分类计数 (L7-P16/C43)', () => {
  function writeProjectFile(root: string, relativePath: string, content: string) {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    return absolute;
  }

  function groundingLogFor(projectRoot: string, anchors: string[]): string {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    try {
      buildAnalysisArtifact(
        { reply: '## 结论\n正文', toolCalls: [] },
        'architecture',
        null,
        {
          distill: () => ({
            keyFindings: anchors.map((evidence, index) => ({
              finding: `发现 ${index}`,
              evidence,
              importance: 8,
            })),
            toolCallSummary: [],
          }),
        },
        { projectRoot }
      );
      const line = info.mock.calls
        .map(([entry]) => String(entry))
        .find((entry) => entry.includes('[AnalysisArtifact] anchor grounding'));
      expect(line).toBeDefined();
      return line ?? '';
    } finally {
      info.mockRestore();
    }
  }

  it('区分根外拒绝、文件缺失、行号越界与空范围，计数之和等于 readerMiss', () => {
    const projectRoot = createTempProject('p16-reader-');
    const outsideRoot = createTempProject('p16-outside-');
    writeProjectFile(projectRoot, 'src/short.ts', 'export const a = 1;\nexport const b = 2;\n');
    writeProjectFile(
      projectRoot,
      'src/blank.ts',
      `export const head = 1;\n${'\n'.repeat(30)}export const tail = 2;\n`
    );
    const outsideFile = writeProjectFile(outsideRoot, 'secret.ts', 'export const secret = 1;\n');
    // 根内 symlink 指向根外：resolveProjectPath 抛 Access denied，必须计为根外拒绝而不是静默吞掉。
    symlinkSync(outsideFile, path.join(projectRoot, 'src', 'escape.ts'));

    const line = groundingLogFor(projectRoot, [
      'src/escape.ts:1',
      'src/missing.ts:3',
      'src/short.ts:50',
      'src/blank.ts:5',
    ]);
    expect(line).toContain('readerMiss=4');
    expect(line).toContain('outsideRoot=1');
    expect(line).toContain('missing=1');
    expect(line).toContain('outOfRange=1');
    expect(line).toContain('emptyRange=1');
    expect(line).toContain('readError=0');
    expect(line).toContain('(dim=architecture)');
  });

  it('补读成功时各未命中分类为 0', () => {
    const projectRoot = createTempProject('p16-reader-ok-');
    writeProjectFile(projectRoot, 'src/short.ts', 'export const a = 1;\nexport const b = 2;\n');
    const line = groundingLogFor(projectRoot, ['src/short.ts:1']);
    expect(line).toContain('readerMiss=0');
    expect(line).toContain('outsideRoot=0');
    expect(line).toContain('missing=0');
    expect(line).toContain('readError=0');
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    '其它读取异常（无读权限）计入 readError，返回值仍为“未补读”',
    () => {
      const projectRoot = createTempProject('p16-reader-eacces-');
      const locked = writeProjectFile(projectRoot, 'src/locked.ts', 'export const a = 1;\n');
      chmodSync(locked, 0o000);
      try {
        const line = groundingLogFor(projectRoot, ['src/locked.ts:1']);
        expect(line).toContain('readerMiss=1');
        expect(line).toContain('readError=1');
        expect(line).toContain('groundedSnippets=+0');
      } finally {
        chmodSync(locked, 0o644);
      }
    }
  );
});
