import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 注释漂移守卫（module-review L6 C09 及 C63 的纯注释部分）：这些文件的 JSDoc 会进入生成的 .d.ts，
// 宿主与下游维护者按注释理解 Agent 上下文/记忆/提示词边界。这里只锁住能机械判定的几类漂移：
// 残缺的 @returns 片段、facade 注释里的符号计数、已收敛的 V2 工具系统标签、预算档位数值、
// 以及几条已被证伪的说法（"无状态"、"getQualityMetrics 使用"、"轻量模式禁用 Scratchpad" 等）。
// 其余语义性描述（流程说明、调用方清单）无法可靠地机械判定，靠代码审阅维护。

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

/** 文件头 JSDoc：第一个块注释结束符之前的全部内容。 */
function fileHeader(relativePath: string): string {
  return readSource(relativePath).split('*/')[0] ?? '';
}

/** 紧贴在 `anchor` 所在行之前的那段 JSDoc 文本；找不到时返回空串。 */
function jsDocBefore(source: string, anchor: string): string {
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex < 0) {
    return '';
  }
  const closeIndex = source.lastIndexOf('*/', anchorIndex);
  const openIndex = source.lastIndexOf('/**', closeIndex);
  if (closeIndex < 0 || openIndex < 0) {
    return '';
  }
  // JSDoc 与 anchor 之间只能隔空白，否则说明 anchor 没有自己的 JSDoc。
  if (source.slice(closeIndex + 2, anchorIndex).trim() !== '') {
    return '';
  }
  return source.slice(openIndex, closeIndex + 2);
}

const REVIEWED_FILES = [
  'src/agent/context/ContextWindow.ts',
  'src/agent/context/ConversationStore.ts',
  'src/agent/context/exploration/NudgeGenerator.ts',
  'src/agent/context/exploration/SignalDetector.ts',
  'src/agent/memory/EpisodicConsolidator.ts',
  'src/agent/memory/MemoryConsolidator.ts',
  'src/agent/memory/MemoryCoordinator.ts',
  'src/agent/memory/SessionStore.ts',
  'src/agent/prompts/index.ts',
  'src/agent/prompts/insightGate.ts',
  'src/agent/prompts/insightProducer.ts',
];

// 类型被删掉后残留的 `@returns }`、`@returns >}`、`@returns |null}`、`@returns []}` 等片段；
// 合法写法要么是 `@returns {Type} 描述`，要么是 `@returns 描述`。
const TRUNCATED_RETURNS = /@returns\s*(?:\|?null|[|>[\]])*\s*\}/;
// 整段内容只剩一个右花括号的 JSDoc：`/** } */`。
const EMPTY_BRACE_JSDOC = /\/\*\*\s*\}\s*\*\//;

describe('agent context/memory/prompts doc drift guard', () => {
  it('keeps truncated @returns fragments and empty-brace JSDoc out of the reviewed files', () => {
    const offenders: string[] = [];
    for (const relativePath of REVIEWED_FILES) {
      const lines = readSource(relativePath).split('\n');
      for (const [index, line] of lines.entries()) {
        if (TRUNCATED_RETURNS.test(line) || EMPTY_BRACE_JSDOC.test(line)) {
          offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('counts the symbols the prompts facade actually re-exports from evaluation', () => {
    const text = readSource('src/agent/prompts/index.ts');
    const declared = /以下\s*(\d+)\s*个符号/.exec(text);
    const reExportBlock = /export\s*\{([^}]*)\}\s*from\s*'\.\.\/evaluation\/index\.js'/.exec(text);
    expect(declared).not.toBeNull();
    expect(reExportBlock).not.toBeNull();
    const names = (reExportBlock?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    expect(Number(declared?.[1])).toBe(names.length);
  });

  it('drops the converged V2 tool-system label from exploration and memory comments', () => {
    for (const relativePath of [
      'src/agent/context/exploration/SignalDetector.ts',
      'src/agent/memory/MemoryCoordinator.ts',
    ]) {
      expect({ relativePath, hasV2Label: /\bV2\b/.test(readSource(relativePath)) }).toEqual({
        relativePath,
        hasV2Label: false,
      });
    }
  });

  it('describes the insightGate quality evaluators without repeating a name', () => {
    // 去掉 JSDoc 续行前缀（换行 + ` * `），让跨行列举的名字拼回同一行再拆分。
    const header = (readSource('src/agent/prompts/insightGate.ts').split('*/')[0] ?? '').replace(
      /\n\s*\*\s*/g,
      ''
    );
    const listed = /质量评估器\s*\(([^)]*)\)/.exec(header);
    expect(listed).not.toBeNull();
    const names = (listed?.[1] ?? '')
      .split('/')
      .map((name) => name.replace(/\s*等$/, '').trim())
      .filter((name) => name.length > 0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists every resolveTokenBudget tier literal in its JSDoc (system / non-system)', () => {
    const source = readSource('src/agent/context/ContextWindow.ts');
    const doc = jsDocBefore(source, 'static resolveTokenBudget(');
    expect(doc).not.toBe('');
    const bodyStart = source.indexOf('static resolveTokenBudget(');
    const body = source.slice(bodyStart, source.indexOf('return budget;', bodyStart));
    const pairs = [...body.matchAll(/isSystem \? ([\d_.]+) : ([\d_.]+)/g)].map((match) => [
      (match[1] ?? '').replaceAll('_', ''),
      (match[2] ?? '').replaceAll('_', ''),
    ]);
    // 四个整数档位 + 微窗口系数，一共五组。
    expect(pairs).toHaveLength(5);
    for (const [system, nonSystem] of pairs) {
      expect({ system, nonSystem, inDoc: doc.includes(system) && doc.includes(nonSystem) }).toEqual(
        { system, nonSystem, inDoc: true }
      );
    }
  });

  it('does not describe ConversationStore.load as auto-summarizing or use a private token ratio', () => {
    const header = fileHeader('src/agent/context/ConversationStore.ts');
    expect(header).not.toMatch(/超限时自动生成摘要/);
    expect(header).not.toMatch(/3\.5\s*字符中文/);
    expect(header).toMatch(/tokenUtils\.estimateTokens/);
  });

  it('describes NudgeGenerator as a stateful per-run instance with an unreachable force_exit via the tracker', () => {
    const header = fileHeader('src/agent/context/exploration/NudgeGenerator.ts');
    // 类内持有一次性标志与 bootstrap 限流计数，不能再宣称"无状态"。
    expect(header).not.toMatch(/无状态/);
    expect(header).toMatch(/有状态/);
    // force_exit 经 ExplorationTracker 不可达（终结阶段 getNudge 直接返回 null），注释必须写明。
    const forceExitLine = header.split('\n').find((line) => line.includes('force_exit')) ?? '';
    expect(forceExitLine).toMatch(/ExplorationTracker/);
    expect(forceExitLine).toMatch(/不可达/);
  });

  it('keeps ActiveContext getStats and lightweight comments aligned with their real consumers', () => {
    const source = readSource('src/agent/memory/ActiveContext.ts');
    const getStatsDoc = jsDocBefore(source, '  getStats() {');
    expect(getStatsDoc).not.toBe('');
    // ExplorationTracker.getQualityMetrics 无生产调用方；真实消费者是反思 nudge、LLMInputAssembly 等。
    expect(getStatsDoc).not.toMatch(/getQualityMetrics 使用/);
    expect(getStatsDoc).toMatch(/LLMInputAssembly/);
    // lightweight 只跳过滑动窗口与 buildContext，noteKeyFinding 仍写 Scratchpad。
    const lightweightLines = source
      .split('\n')
      .filter((line) => /lightweight|轻量模式/.test(line) && /^\s*(?:\*|\/\*\*|\/\/)/.test(line));
    expect(lightweightLines.length).toBeGreaterThan(0);
    for (const line of lightweightLines) {
      expect({
        line: line.trim(),
        claimsScratchpadDisabled: /(?:禁用|跳过)[^\n]*Scratchpad/.test(line),
      }).toEqual({
        line: line.trim(),
        claimsScratchpadDisabled: false,
      });
    }
  });

  it('names the real insightProducer importers instead of the retired bootstrap preset', () => {
    const header = fileHeader('src/agent/prompts/insightProducer.ts');
    expect(header).not.toMatch(/bootstrap preset 直接引用/);
    expect(header).toMatch(/insightPreset/);
    expect(header).toMatch(/stageBuilders/);
    // v1 buildProducerPrompt 仍在公开面，但无生产调用方；头注释要说明这一点。
    // 先把 JSDoc 续行拼回一行，避免说明跨行时误判。
    const joined = header.replace(/\n\s*\*\s*/g, ' ');
    expect(joined).toMatch(/v1 buildProducerPrompt[^。]*无生产调用方/);
  });
});
