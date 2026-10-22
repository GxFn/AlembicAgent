/**
 * L5-P48 / I49：runtime 公开面上的死参数、死成员与无记录的兼容分支（W1-03 删除落地）。
 *
 * 用户决策（采纳全部删除；②“公开面收窄”与③“单宿主假设”已于 2026-10-20 答复）。删除前四处零引用
 * 扫描（Agent src/test、宿主 lib/bin/test、Plugin/Dashboard/Core）复核通过，W1-03 一并落地：
 *   - produceForcedSummary：删除 contextWindow/tokenUsage 兼容输入与默认导出，summaryMode 改必填；
 *   - LLMResultType 只留 CONTINUE，LLMResult.type 收窄为字面量 'continue'；
 *   - 删除 BuildSystemRunContextOptions.allowDistinctActiveContext：trace 与 activeContext 不同一律抛错；
 *   - 删除 MessageAdapter 四个无调用成员（formatToolResult/getToolResultQuota/compactIfNeeded 与
 *     ContextWindowAdapter.contextWindow getter），MessageAdapter 改为 abstract class；
 *   - 删除 ContextWindowAdapter 的旧 duck-typed 窗口兼容分支：没有合法 readViewRevision 时构造即抛错。
 * 公开导出的名字与运行时种类不变（签名快照零差异）。原 @deprecated 守卫逐项改写为“已不存在”断言，
 * 类型收窄用 TypeScript 编译器探针（tsconfig 只含 src，vitest 不做类型检查）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/ContextWindow.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import * as forcedSummaryModule from '../src/agent/runtime/forcedSummary.js';
import { LLMResultType } from '../src/agent/runtime/LLMResultType.js';
import {
  ContextWindowAdapter,
  MessageAdapter,
  SimpleArrayAdapter,
} from '../src/agent/runtime/MessageAdapter.js';

// 包一层真实实现：只观察 AgentRuntime 实际传入的参数，不改变摘要行为。
vi.mock('../src/agent/runtime/forcedSummary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/runtime/forcedSummary.js')>();
  return { ...actual, produceForcedSummary: vi.fn(actual.produceForcedSummary) };
});

afterEach(() => {
  vi.mocked(forcedSummaryModule.produceForcedSummary).mockClear();
});

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 立即硬退出的 tracker 桩：循环不调用模型，直接进入 #finalize 的强制摘要。 */
function exitingTracker(pipelineType: string) {
  return {
    phase: 'SUMMARIZE',
    pipelineType,
    isGracefulExit: false,
    isHardExit: true,
    iteration: 1,
    totalSubmits: 0,
    tick: vi.fn(),
    shouldExit: vi.fn(() => true),
  };
}

describe('AgentRuntime → produceForcedSummary 参数', () => {
  it('只传阶段声明的 summaryMode，不传已删除的 contextWindow/tokenUsage；摘要用量按返回值累计一次', async () => {
    const chatWithTools = vi.fn(async () => ({
      text: '## 报告\n内容',
      functionCalls: [],
      usage: { inputTokens: 11, outputTokens: 7 },
    }));
    const runtime = new AgentRuntime({
      aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute: vi.fn() } as never,
      capabilities: [],
      strategy: { name: 'unused', execute: vi.fn() } as never,
    });
    const contextWindow = new ContextWindow(100_000);

    const result = await runtime.reactLoop('analyze', {
      source: 'system',
      tracker: exitingTracker('analyst') as never,
      contextWindow,
      context: { pipelinePhase: 'analyze', summaryMode: 'analyst-report' },
      budgetOverride: { maxIterations: 2, timeoutMs: 5_000 },
    });

    const spy = vi.mocked(forcedSummaryModule.produceForcedSummary);
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0]?.[0] ?? {};
    expect(Object.keys(opts)).not.toContain('contextWindow');
    expect(Object.keys(opts)).not.toContain('tokenUsage');
    expect(opts).toMatchObject({
      prompt: 'analyze',
      source: 'system',
      summaryMode: 'analyst-report',
    });
    expect(chatWithTools).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe('## 报告\n内容');
    // 用量只经返回值进入 loop 与运行级总账；不再有调用方累加器可被重复写入。
    expect(result.tokenUsage).toMatchObject({ input: 11, output: 7 });
    expect(runtime.tokenUsage).toMatchObject({ input: 11, output: 7 });
  });
});

/* ── AST 守卫：用 TypeScript 解析声明，而不是匹配行号 ───────────────── */

function readSource(rel: string) {
  const file = fileURLToPath(new URL(`../${rel}`, import.meta.url));
  const text = readFileSync(file, 'utf8');
  return { text, sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) };
}

function memberName(member: ts.Node): string | undefined {
  const name = (member as { name?: ts.PropertyName }).name;
  if (!name) {
    return undefined;
  }
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)
    ? name.text
    : undefined;
}

function findContainer(
  sf: ts.SourceFile,
  containerName: string
): ts.InterfaceDeclaration | ts.ClassDeclaration {
  for (const stmt of sf.statements) {
    if (
      (ts.isInterfaceDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      stmt.name?.text === containerName
    ) {
      return stmt;
    }
  }
  throw new Error(`container ${containerName} not found`);
}

/** 容器（interface / class）声明的成员名，按出现顺序去重。 */
function memberNamesOf(sf: ts.SourceFile, containerName: string): string[] {
  const names: string[] = [];
  for (const member of findContainer(sf, containerName).members) {
    const name = memberName(member);
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function memberOf(sf: ts.SourceFile, containerName: string, name: string) {
  return findContainer(sf, containerName).members.find((member) => memberName(member) === name);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
    (modifier) => modifier.kind === kind
  );
}

/** LLMResultType = Object.freeze({...}) 字面量的属性名。 */
function llmResultTypeKeys(sf: ts.SourceFile): string[] {
  const keys: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'LLMResultType' &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const literal = node.initializer.arguments[0];
      if (literal && ts.isObjectLiteralExpression(literal)) {
        for (const prop of literal.properties) {
          const name = memberName(prop);
          if (name) {
            keys.push(name);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

/** 顶层被整体废弃的声明（文件头注释若写了 @deprecated 会误标紧随其后的公开导出）。 */
function deprecatedTopLevelNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.getJSDocDeprecatedTag(stmt) || ts.getJSDocDeprecatedTag(decl)) {
          names.push(decl.name.getText(sf));
        }
      }
    } else if (ts.getJSDocDeprecatedTag(stmt)) {
      names.push(memberName(stmt) ?? ts.SyntaxKind[stmt.kind]);
    }
  }
  return names;
}

/** 残缺 JSDoc：`@returns }`、`@returns >}`、`@returns }>}` 等只剩括号的标签。 */
const BROKEN_RETURNS = /@returns\s*[}>]+\s*$/m;

describe('已删除的兼容成员不再存在（原 @deprecated 守卫逐项改写）', () => {
  it('ForcedSummaryOpts：contextWindow/tokenUsage 与本地 TokenUsage 已删除，summaryMode 必填，无默认导出', () => {
    const { sf, text } = readSource('src/agent/runtime/forcedSummary.ts');
    const members = memberNamesOf(sf, 'ForcedSummaryOpts');
    expect(members).not.toContain('contextWindow');
    expect(members).not.toContain('tokenUsage');
    const summaryMode = memberOf(sf, 'ForcedSummaryOpts', 'summaryMode');
    expect(summaryMode && ts.isPropertySignature(summaryMode)).toBe(true);
    expect((summaryMode as ts.PropertySignature).questionToken).toBeUndefined();
    expect(sf.statements.some((stmt) => ts.isExportAssignment(stmt))).toBe(false);
    expect(() => findContainer(sf, 'TokenUsage')).toThrow('not found');
    expect(Object.keys(forcedSummaryModule)).not.toContain('default');
    expect(deprecatedTopLevelNames(sf)).toEqual([]);
    expect(text).not.toContain('@deprecated');
    expect(text).not.toMatch(BROKEN_RETURNS);
  });

  it('BuildSystemRunContextOptions.allowDistinctActiveContext 已删除，其余选项保持', () => {
    const { sf, text } = readSource('src/agent/runtime/SystemRunContext.ts');
    const members = memberNamesOf(sf, 'BuildSystemRunContextOptions');
    expect(members).not.toContain('allowDistinctActiveContext');
    expect(members).toEqual(
      expect.arrayContaining(['memoryCoordinator', 'scopeId', 'trace', 'activeContext'])
    );
    expect(text).not.toContain('allowDistinctActiveContext');
    expect(deprecatedTopLevelNames(sf)).toEqual([]);
  });

  it('LLMResultType 只剩 CONTINUE；文件头不自称“类型安全控制流”，JSDoc 无残缺', () => {
    const { sf, text } = readSource('src/agent/runtime/LLMResultType.ts');
    expect(llmResultTypeKeys(sf)).toEqual(['CONTINUE']);
    expect(Object.keys(LLMResultType)).toEqual(['CONTINUE']);
    expect(LLMResultType.CONTINUE).toBe('continue');
    expect(Object.isFrozen(LLMResultType)).toBe(true);
    expect(deprecatedTopLevelNames(sf)).toEqual([]);
    expect(text).not.toContain('@deprecated');
    expect(text).not.toContain('类型安全控制流');
    expect(text).not.toMatch(BROKEN_RETURNS);
  });

  it('LLMResult.type 收窄为 typeof LLMResultType.CONTINUE', () => {
    const { sf } = readSource('src/agent/runtime/AgentRuntimeTypes.ts');
    const type = memberOf(sf, 'LLMResult', 'type');
    expect(type && ts.isPropertySignature(type)).toBe(true);
    expect((type as ts.PropertySignature).type?.getText(sf)).toBe('typeof LLMResultType.CONTINUE');
  });

  it('AgentRuntime 不再把 continueResult() 强转为 LLMResult', () => {
    const { text } = readSource('src/agent/runtime/AgentRuntime.ts');
    expect(/continueResult\(\)\s+as\s+LLMResult/.test(text)).toBe(false);
  });

  it('MessageAdapter 是 abstract class：七个消息方法为 abstract 声明，四个无调用成员已删除', () => {
    const { sf, text } = readSource('src/agent/runtime/MessageAdapter.ts');
    const base = findContainer(sf, 'MessageAdapter');
    expect(hasModifier(base, ts.SyntaxKind.AbstractKeyword)).toBe(true);
    const abstractMembers = base.members
      .filter((member) => hasModifier(member, ts.SyntaxKind.AbstractKeyword))
      .map((member) => memberName(member))
      .sort();
    expect(abstractMembers).toEqual(
      [
        'appendAssistantText',
        'appendAssistantWithToolCalls',
        'appendToolResult',
        'appendUserMessage',
        'appendUserNudge',
        'resetToPromptOnly',
        'toMessages',
      ].sort()
    );
    const removed = ['formatToolResult', 'getToolResultQuota', 'compactIfNeeded'];
    for (const owner of ['MessageAdapter', 'ContextWindowAdapter', 'SimpleArrayAdapter']) {
      const members = memberNamesOf(sf, owner);
      for (const name of removed) {
        expect({ owner, name, present: members.includes(name) }).toEqual({
          owner,
          name,
          present: false,
        });
      }
    }
    expect(memberNamesOf(sf, 'ContextWindowAdapter')).not.toContain('contextWindow');
    expect(memberNamesOf(sf, 'ContextWindowAdapter')).not.toContain('legacyReadView');
    // 只为 formatToolResult 存在的宽松信封识别与专用导入一并删除。
    expect(text).not.toContain('looksLikeToolResultEnvelope');
    expect(text).not.toContain('isToolResultEnvelope');
    expect(text).not.toContain('limitToolResult');
    expect(text).not.toContain('TOOL_ENVELOPE_SHAPE_REJECTED');
    expect(text).not.toContain('readRejectedEnvelopeText');
    expect(text).not.toContain('@deprecated');
    expect(deprecatedTopLevelNames(sf)).toEqual([]);
    // 运行时原型上也不存在（JS 调用方得到 undefined，而不是兼容实现）。
    for (const proto of [
      MessageAdapter.prototype,
      ContextWindowAdapter.prototype,
      SimpleArrayAdapter.prototype,
    ]) {
      for (const name of [...removed, 'contextWindow']) {
        expect(name in proto).toBe(false);
      }
    }
  });
});

describe('MessageAdapter 文档漂移', () => {
  const { text } = readSource('src/agent/runtime/MessageAdapter.ts');

  it('模块路径与 @returns 不再残缺/错误', () => {
    expect(text).not.toContain('@module core/MessageAdapter');
    expect(text).toContain('@module agent/runtime/MessageAdapter');
    expect(text).not.toMatch(BROKEN_RETURNS);
  });

  it('resetToPromptOnly 注释说明保留的是首条消息（有 history 时为 history 首条）', () => {
    expect(text).not.toContain('重置到仅保留初始 prompt');
    expect(text).toContain('仅保留首条消息');
    expect(text).toContain('history 首条');
  });
});

/* ── 编译器探针：类型收窄必须在编译期报错，而不只是运行时 ───────────────── */

interface ProbeDiagnostic {
  code: number;
  message: string;
}

function typecheckProbes(probes: Record<string, string>): Record<string, ProbeDiagnostic[]> {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  // 探针放在 test/ 下的虚拟路径，按仓库自己的 package.json（type: module、#imports）走 NodeNext 解析。
  const virtualFiles = new Map(
    Object.entries(probes).map(([name, text]) => [path.join(REPO_ROOT, 'test', name), text])
  );
  const host = ts.createCompilerHost(options);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) => virtualFiles.has(fileName) || baseFileExists(fileName);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? baseReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtualFiles.get(fileName);
    return text === undefined
      ? baseGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const program = ts.createProgram([...virtualFiles.keys()], options, host);
  const result: Record<string, ProbeDiagnostic[]> = {};
  for (const [name] of Object.entries(probes)) {
    const sourceFile = program.getSourceFile(path.join(REPO_ROOT, 'test', name));
    expect(sourceFile).toBeDefined();
    result[name] = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ].map((diagnostic) => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
  }
  return result;
}

describe('编译器探针：收窄后的公开类型', () => {
  it('LLMResult.type、abstract MessageAdapter、必填 summaryMode 与已删除选项都在编译期拒绝', () => {
    const diagnostics = typecheckProbes({
      '__w103-llm-result-fatal.probe.ts': [
        "import type { LLMResult } from '../src/agent/runtime/AgentRuntimeTypes.js';",
        "export const fatal: LLMResult = { type: 'fatal' };",
        '',
      ].join('\n'),
      // 正对照：唯一合法值与 continueResult() 无需强转即可赋给 LLMResult。
      '__w103-llm-result-continue.probe.ts': [
        "import type { LLMResult } from '../src/agent/runtime/AgentRuntimeTypes.js';",
        "import { continueResult } from '../src/agent/runtime/LLMResultType.js';",
        "export const literal: LLMResult = { type: 'continue' };",
        'export const viaHelper: LLMResult = continueResult();',
        '',
      ].join('\n'),
      '__w103-message-adapter-abstract.probe.ts': [
        "import { MessageAdapter } from '../src/agent/runtime/MessageAdapter.js';",
        'export const adapter = new MessageAdapter();',
        '',
      ].join('\n'),
      '__w103-forced-summary-mode-required.probe.ts': [
        "import type { AiProvider } from '../src/ai/AiProvider.js';",
        "import { produceForcedSummary } from '../src/agent/runtime/forcedSummary.js';",
        'declare const aiProvider: AiProvider;',
        "export const missing = produceForcedSummary({ aiProvider, prompt: 'p' });",
        '',
      ].join('\n'),
      '__w103-forced-summary-removed-inputs.probe.ts': [
        "import type { AiProvider } from '../src/ai/AiProvider.js';",
        "import { produceForcedSummary } from '../src/agent/runtime/forcedSummary.js';",
        'declare const aiProvider: AiProvider;',
        'export const legacy = produceForcedSummary({',
        "  aiProvider, prompt: 'p', summaryMode: 'user', contextWindow: null,",
        '});',
        '',
      ].join('\n'),
      '__w103-system-run-context-option.probe.ts': [
        "import { createSystemRunContext } from '../src/agent/runtime/SystemRunContext.js';",
        "import type { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';",
        'declare const memoryCoordinator: MemoryCoordinator;',
        'export const ctx = createSystemRunContext({',
        "  memoryCoordinator, scopeId: 's', allowDistinctActiveContext: true,",
        '});',
        '',
      ].join('\n'),
    });
    const codes = (name: string) => diagnostics[name].map((diagnostic) => diagnostic.code);
    expect(codes('__w103-llm-result-fatal.probe.ts')).toEqual([2322]);
    expect(diagnostics['__w103-llm-result-continue.probe.ts']).toEqual([]);
    expect(codes('__w103-message-adapter-abstract.probe.ts')).toEqual([2511]);
    expect(codes('__w103-forced-summary-mode-required.probe.ts')).toEqual([2345]);
    expect(diagnostics['__w103-forced-summary-mode-required.probe.ts'][0].message).toContain(
      'summaryMode'
    );
    expect(codes('__w103-forced-summary-removed-inputs.probe.ts')).toEqual([2353]);
    expect(codes('__w103-system-run-context-option.probe.ts')).toEqual([2353]);
  }, 60_000);
});
