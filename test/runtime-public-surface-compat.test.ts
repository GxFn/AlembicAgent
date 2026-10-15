/**
 * L5-P48 / I49：runtime 公开面上的死参数、死成员与无记录的兼容分支。
 *
 * 用户决策（采纳全部删除，但删除随待决事项②“公开面收窄”与③“单宿主假设”落地）：现在只做
 *   - AgentRuntime 停止向 produceForcedSummary 传 contextWindow/tokenUsage 两个兼容输入；
 *   - 两个兼容字段、默认导出、allowDistinctActiveContext、LLMResultType 非 CONTINUE 成员与
 *     MessageAdapter 四个无调用成员标 @deprecated（不删除，公开导出名与种类不变）；
 *   - 修正残缺/错误的 JSDoc，ContextWindowAdapter 的旧 duck-typed 窗口兼容分支写明消费者、原因、
 *     移除条件与清理触发点。
 * 删除与类型收窄不在本包；这里的守卫只锁住“现在可做”的部分，②③落地时随删除一并改写。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/ContextWindow.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import * as forcedSummaryModule from '../src/agent/runtime/forcedSummary.js';

// 包一层真实实现：只观察 AgentRuntime 实际传入的参数，不改变摘要行为。
vi.mock('../src/agent/runtime/forcedSummary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/runtime/forcedSummary.js')>();
  return { ...actual, produceForcedSummary: vi.fn(actual.produceForcedSummary) };
});

afterEach(() => {
  vi.mocked(forcedSummaryModule.produceForcedSummary).mockClear();
});

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
  it('不再传 contextWindow/tokenUsage 兼容输入；摘要用量仍按返回值累计一次', async () => {
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

/* ── 公开面文档守卫：用 TypeScript 解析 JSDoc，而不是匹配行号 ───────────────── */

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

/** 返回容器（interface / class）中带 @deprecated 的成员名；同名重载/getter 合并计算。 */
function deprecatedMembersOf(sf: ts.SourceFile, containerName: string): Set<string> {
  const out = new Set<string>();
  let found = false;
  for (const stmt of sf.statements) {
    if (
      (ts.isInterfaceDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      stmt.name?.text === containerName
    ) {
      found = true;
      for (const member of stmt.members) {
        const name = memberName(member);
        if (name && ts.getJSDocDeprecatedTag(member)) {
          out.add(name);
        }
      }
    }
  }
  if (!found) {
    throw new Error(`container ${containerName} not found`);
  }
  return out;
}

/** LLMResultType = Object.freeze({...}) 中带 @deprecated 的属性名。 */
function deprecatedLlmResultTypeKeys(sf: ts.SourceFile): { all: string[]; deprecated: string[] } {
  const all: string[] = [];
  const deprecated: string[] = [];
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
          if (!name) {
            continue;
          }
          all.push(name);
          if (ts.getJSDocDeprecatedTag(prop)) {
            deprecated.push(name);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { all, deprecated };
}

/**
 * 顶层声明自身不能被废弃：TypeScript 会把行中的 `@deprecated` 也解析成标签，文件头注释若写了它，
 * 会把紧随其后的整个公开导出（如 LLMResultType 常量或某个 class）标成废弃。
 */
function deprecatedTopLevelNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.getJSDocDeprecatedTag(stmt) || ts.getJSDocDeprecatedTag(decl)) {
          names.push(decl.name.getText(sf));
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      if (ts.getJSDocDeprecatedTag(stmt)) {
        names.push('default');
      }
    } else if (ts.getJSDocDeprecatedTag(stmt)) {
      names.push(memberName(stmt) ?? ts.SyntaxKind[stmt.kind]);
    }
  }
  return names;
}

/** 残缺 JSDoc：`@returns }`、`@returns >}`、`@returns }>}` 等只剩括号的标签。 */
const BROKEN_RETURNS = /@returns\s*[}>]+\s*$/m;

describe('公开面兼容成员 @deprecated 标注', () => {
  it('ForcedSummaryOpts 的 contextWindow/tokenUsage 与默认导出标 @deprecated', () => {
    const { sf, text } = readSource('src/agent/runtime/forcedSummary.ts');
    const deprecated = deprecatedMembersOf(sf, 'ForcedSummaryOpts');
    expect([...deprecated].sort()).toEqual(['contextWindow', 'tokenUsage']);
    // 只废弃默认导出；命名导出 produceForcedSummary 与其他顶层声明保持未废弃。
    expect(deprecatedTopLevelNames(sf)).toEqual(['default']);
    expect(text).not.toMatch(BROKEN_RETURNS);
  });

  it('BuildSystemRunContextOptions.allowDistinctActiveContext 标 @deprecated，其余选项不受影响', () => {
    const { sf } = readSource('src/agent/runtime/SystemRunContext.ts');
    expect([...deprecatedMembersOf(sf, 'BuildSystemRunContextOptions')]).toEqual([
      'allowDistinctActiveContext',
    ]);
    expect(deprecatedTopLevelNames(sf)).toEqual([]);
  });

  it('LLMResultType 只有 CONTINUE 未废弃；文件头不再自称“类型安全控制流”，JSDoc 无残缺', () => {
    const { sf, text } = readSource('src/agent/runtime/LLMResultType.ts');
    const keys = deprecatedLlmResultTypeKeys(sf);
    // 成员名保持不变（公开对象形状不变），只加废弃标注。
    expect(keys.all).toEqual(['CONTINUE', 'TEXT', 'TOOL_CALLS', 'ERROR', 'FATAL']);
    expect(keys.deprecated).toEqual(['TEXT', 'TOOL_CALLS', 'ERROR', 'FATAL']);
    // LLMResultType 常量与 continueResult 本身仍是受支持的公开导出。
    expect(deprecatedTopLevelNames(sf)).toEqual([]);
    expect(text).not.toContain('类型安全控制流');
    expect(text).not.toMatch(BROKEN_RETURNS);
  });

  it('MessageAdapter 四个无调用成员在基类与子类上都标 @deprecated，常规成员不受影响', () => {
    const { sf } = readSource('src/agent/runtime/MessageAdapter.ts');
    expect([...deprecatedMembersOf(sf, 'MessageAdapter')].sort()).toEqual([
      'compactIfNeeded',
      'formatToolResult',
      'getToolResultQuota',
    ]);
    expect([...deprecatedMembersOf(sf, 'ContextWindowAdapter')].sort()).toEqual([
      'compactIfNeeded',
      'contextWindow',
      'getToolResultQuota',
    ]);
    expect([...deprecatedMembersOf(sf, 'SimpleArrayAdapter')].sort()).toEqual([
      'compactIfNeeded',
      'getToolResultQuota',
    ]);
    // 三个类与 createMessageAdapter 本身不废弃（含 import 语句：文件头注释不能夹带废弃标签）。
    expect(deprecatedTopLevelNames(sf)).toEqual([]);
  });
});

describe('MessageAdapter 文档漂移与兼容分支登记', () => {
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

  it('旧 duck-typed 窗口兼容分支写明消费者、原因、移除条件与清理触发点', () => {
    const start = text.indexOf('readonly #legacyReadView');
    expect(start).toBeGreaterThan(0);
    // 登记写在字段声明之前的注释块里。
    const block = text.slice(Math.max(0, start - 1600), start);
    for (const label of ['消费者', '原因', '移除条件', '清理触发', '负责']) {
      expect(block).toContain(label);
    }
    expect(block).toContain('tool-resource-scope.test.ts');
  });
});
