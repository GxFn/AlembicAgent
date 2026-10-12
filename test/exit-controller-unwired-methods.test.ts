/**
 * ExitController 未接线方法的文档与语义锁定（L5-P9 / I34）。
 *
 * 背景：checkAfterAiError / checkAfterTextResponse / checkToolChoiceViolation 是公开方法，但
 * AgentRuntime 从不调用它们——AI 错误、文本终答、toolChoice 违规都由 Runtime 内联判定，且两边语义
 * 已经分叉。审阅决定采纳方案 b（随待决事项②删除这三个方法与 ExitSignal.nudge / 'graceful_exit'），
 * 事项②未答复前只修正注释，不删除任何导出。
 *
 * 本文件锁定三件事：
 *   1. 注释说真话：不再宣称这些方法“replaces #handleAiError / #processTextResponse”，每个方法都标明
 *      未接线（@deprecated）并写出与内联判定的语义差异；ExitSignal.needsSummary / nudge / action 的
 *      注释不再宣称被 #finalize 或消息流消费；AgentRuntime 的三处内联判定反向标注平行方法。
 *   2. “未被 Runtime 使用”这一说法本身成立：src 中除定义外没有任何调用点。
 *      若将来有人把它们接线，这里会失败，提醒同步修改注释（或改走方案 a）。
 *   3. 注释里写出的语义差异是真实行为（特征测试，修注释前后都应通过）：
 *      - checkToolChoiceViolation 无 tracker 时放行工具调用，Runtime 在 toolChoice='none' 下会忽略；
 *      - checkToolChoiceViolation 在 SUMMARIZE 下不看 provider 例外，Runtime 对 DeepSeek V4 首轮放行；
 *      - checkAfterAiError 不递增 consecutiveAiErrors，第一次错误返回 retry；
 *      - checkAfterTextResponse 对任何管线都返回 graceful_exit，Runtime 只对 analyst 注入 digest nudge。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ExplorationTracker } from '../src/agent/context/ExplorationTracker.js';
import { ExitController, type ExitControllerConfig } from '../src/agent/runtime/ExitController.js';
import type { LoopContext } from '../src/agent/runtime/LoopContext.js';
import { allowsToolCallsUnderForcedNone } from '../src/agent/runtime/ProviderToolChoicePolicy.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT_CONTROLLER_PATH = path.join(repoRoot, 'src/agent/runtime/ExitController.ts');
const AGENT_RUNTIME_PATH = path.join(repoRoot, 'src/agent/runtime/AgentRuntime.ts');

const UNWIRED_METHODS = [
  'checkAfterAiError',
  'checkAfterTextResponse',
  'checkToolChoiceViolation',
] as const;

function readSource(file: string): string {
  return readFileSync(file, 'utf8');
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 取紧贴在某个声明前的 JSDoc 块文本（不含 /** 与 *\/）。
 * 正则内容不允许出现 *\/，所以只会匹配到紧邻声明的那一块注释。
 */
function jsDocBefore(source: string, declarationPattern: string): string {
  const re = new RegExp(`/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\s*${declarationPattern}`);
  const match = re.exec(source);
  if (!match) {
    throw new Error(`no JSDoc block directly before declaration /${declarationPattern}/`);
  }
  return match[1] ?? '';
}

function createFakeTracker(overrides: Record<string, unknown> = {}) {
  return {
    phase: 'SCAN',
    iteration: 0,
    totalSubmits: 0,
    isGracefulExit: false,
    isHardExit: false,
    tick: vi.fn(),
    shouldExit: vi.fn(() => false),
    forceTerminal: vi.fn(),
    metrics: { phaseRounds: 0 },
    ...overrides,
  };
}

function createController(tracker: Record<string, unknown> | null) {
  const config: ExitControllerConfig = {
    tracker: tracker as unknown as ExplorationTracker | null,
    effectiveTimeoutMs: 0,
    abortSignal: null,
    validateDuring: () => ({ ok: true }),
    skipPolicyIterCheck: true,
    loopStartTime: Date.now(),
    maxIterations: 10,
  };
  return new ExitController(config);
}

function createLoopCtx(overrides: { consecutiveAiErrors?: number } = {}): LoopContext {
  return {
    iteration: 1,
    isSystem: false,
    consecutiveEmptyResponses: 0,
    consecutiveAiErrors: 0,
    ...overrides,
  } as unknown as LoopContext;
}

const TOOL_CALLS = [{ id: 'call-1', name: 'code.search', args: {} }];

describe('ExitController 未接线方法：注释与实际接线一致（I34）', () => {
  it('不再宣称三个方法替代 AgentRuntime 的内联路径', () => {
    const source = readSource(EXIT_CONTROLLER_PATH);
    expect(source).not.toMatch(/replaces #handleAiError/);
    expect(source).not.toMatch(/replaces #processTextResponse/);
  });

  it.each(
    UNWIRED_METHODS
  )('%s 的 JSDoc 标明未接线（@deprecated、AgentRuntime 不调用、随事项②删除）', (method) => {
    const doc = jsDocBefore(readSource(EXIT_CONTROLLER_PATH), `${method}\\(`);
    expect(doc).toContain('@deprecated');
    expect(doc).toContain('AgentRuntime 不调用');
    expect(doc).toContain('事项②');
    expect(doc).toContain('语义差异');
  });

  it('每个未接线方法的 JSDoc 指向真正生效的内联判定，并写出关键差异', () => {
    const source = readSource(EXIT_CONTROLLER_PATH);

    const aiErrorDoc = jsDocBefore(source, 'checkAfterAiError\\(');
    expect(aiErrorDoc).toContain('AgentRuntime.#handleAiError');
    // 差异：本方法不递增计数；Runtime 在 2-strike 时重置消息并写错误回复
    expect(aiErrorDoc).toContain('consecutiveAiErrors');
    expect(aiErrorDoc).toContain('resetToPromptOnly');

    const textDoc = jsDocBefore(source, 'checkAfterTextResponse\\(');
    expect(textDoc).toContain('AgentRuntime.#processTextResponse');
    // 差异：Runtime 只对 analyst 注入 digest nudge；grounding guard 阻断轮不在本方法里
    expect(textDoc).toContain('analyst');
    expect(textDoc).toContain('grounding');

    const violationDoc = jsDocBefore(source, 'checkToolChoiceViolation\\(');
    expect(violationDoc).toContain('AgentRuntime.#callLLM');
    // 差异：Runtime 条件含 toolChoice='none' 与 provider 例外，本方法只看 tracker
    expect(violationDoc).toContain("toolChoice === 'none'");
    expect(violationDoc).toContain('allowsToolCallsUnderForcedNone');
    expect(violationDoc).toContain('无 tracker');
  });

  it('ExitSignal 的 needsSummary / nudge / action 注释不再宣称有运行时消费者', () => {
    const source = readSource(EXIT_CONTROLLER_PATH);

    const needsSummaryDoc = jsDocBefore(source, 'needsSummary\\?:');
    expect(needsSummaryDoc).not.toMatch(/Whether #finalize should produce a forced summary/);
    expect(needsSummaryDoc).toContain('AgentRuntime 不读取');
    expect(needsSummaryDoc).toContain('#getForcedSummarySuppression');

    const nudgeDoc = jsDocBefore(source, 'nudge\\?:');
    expect(nudgeDoc).not.toMatch(/Text to inject into message stream/);
    expect(nudgeDoc).toContain('checkAfterTextResponse');
    expect(nudgeDoc).toContain('没有消费者');

    const actionDoc = jsDocBefore(source, 'action:');
    expect(actionDoc).toContain("'graceful_exit'");
    expect(actionDoc).toContain('checkAfterTextResponse');
  });

  it('模块头写明三个方法与内联判定语义不同，不能作为复用入口', () => {
    const header = readSource(EXIT_CONTROLLER_PATH).split('@module')[0] ?? '';
    expect(header).toContain('语义已与内联判定分叉');
    expect(header).toContain('不要把它们当作退出判定的复用入口');
  });

  it('AgentRuntime 的三处内联判定反向标注对应的未接线平行方法', () => {
    const runtime = readSource(AGENT_RUNTIME_PATH);
    for (const method of UNWIRED_METHODS) {
      expect(runtime).toContain(`ExitController.${method}`);
    }
  });

  it('“未被 Runtime 使用”成立：src 中除定义外没有任何调用点', () => {
    const srcRoot = path.join(repoRoot, 'src');
    const offenders: string[] = [];
    for (const file of listTsFiles(srcRoot)) {
      const text = readSource(file);
      for (const method of UNWIRED_METHODS) {
        // 调用形态是 `.method(`；ExitController.ts 内的定义是 `method(` 前面没有点，注释里的
        // `ExitController.method` 不带括号，不会被计为调用。
        if (new RegExp(`\\.${method}\\s*\\(`).test(text)) {
          offenders.push(`${path.relative(repoRoot, file)} → ${method}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('ExitController 未接线方法：注释所写的语义差异是真实行为（特征测试）', () => {
  it('checkToolChoiceViolation 无 tracker 时放行工具调用（Runtime 在 toolChoice=none 下会忽略）', () => {
    const controller = createController(null);
    expect(
      controller.checkToolChoiceViolation({ text: 'final', functionCalls: TOOL_CALLS })
    ).toEqual({ action: 'continue' });
  });

  it('checkToolChoiceViolation 在 SUMMARIZE 下不看 provider 例外（Runtime 对 DeepSeek V4 首轮放行）', () => {
    // Runtime 侧：tools-visible-no-forced-tool-choice 例外下 toolChoice=none 的工具调用被放行。
    expect(allowsToolCallsUnderForcedNone('tools-visible-no-forced-tool-choice')).toBe(true);
    // 本方法：tracker 自然转入 SUMMARIZE（isGracefulExit=false）时一律判违规，无法表达该例外。
    const controller = createController(
      createFakeTracker({ phase: 'SUMMARIZE', isGracefulExit: false })
    );
    expect(
      controller.checkToolChoiceViolation({ text: null, functionCalls: TOOL_CALLS })
    ).toMatchObject({ action: 'retry', reason: 'tool_choice_violation' });
  });

  it('checkAfterAiError 不递增 consecutiveAiErrors：计数由调用方预先维护', () => {
    const controller = createController(createFakeTracker());
    const ctx = createLoopCtx({ consecutiveAiErrors: 1 });
    const signal = controller.checkAfterAiError({ message: 'boom' }, ctx);
    expect(signal).toMatchObject({ action: 'retry', reason: 'error_accumulated' });
    expect(ctx.consecutiveAiErrors).toBe(1);
    expect(
      controller.checkAfterAiError({ message: 'boom' }, createLoopCtx({ consecutiveAiErrors: 2 }))
    ).toMatchObject({ action: 'exit', reason: 'error_accumulated', needsSummary: true });
  });

  it('checkAfterTextResponse 不区分管线：metrics 转入终结阶段的终答一律返回 graceful_exit', () => {
    const controller = createController(createFakeTracker({ pipelineType: 'bootstrap' }));
    const signal = controller.checkAfterTextResponse(
      { isFinalAnswer: true, needsDigestNudge: false, shouldContinue: false, nudge: null },
      true,
      createLoopCtx()
    );
    expect(signal).toMatchObject({ action: 'graceful_exit', reason: 'task_complete', nudge: null });
  });
});
