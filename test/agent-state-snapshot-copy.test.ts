import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetPolicy, PolicyEngine } from '../src/agent/policies/index.js';
import { AgentEvents } from '../src/agent/runtime/AgentEventBus.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { AgentPhase, AgentState } from '../src/agent/runtime/AgentState.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';

afterEach(() => vi.restoreAllMocks());

/**
 * I40 / P46：快照必须与运行时内部状态脱钩。
 *
 * 旧实现 toJSON() 直接返回内部 #data / #history 引用，AgentRuntime 把它写进 result.state：
 * execute 返回后状态机上的任何转移（通配的 abort/error 在终态仍可匹配）都会把记录追加进
 * 已返回结果的 history，快照前后矛盾。fromJSON 同理直接持有调用方传入的 history 数组。
 *
 * L5-P46（W1-06，事项②已答复）：AgentRuntime 不再持有 AgentState，改为私有最小 phase 字段，
 * result.state 只含 { phase }。AgentState 类在 W2b（派发行 D3）删除前仍公开导出，
 * 所以第一组用例继续守住它的拷贝语义；后两组覆盖 runtime 的 phase 快照与类型面。
 */

/** 真实 SingleStrategy + 文本回复的 provider：走完整的 idle → executing → completed 阶段。 */
function textRuntime() {
  const chatWithTools = vi.fn(async () => ({ text: 'done', functionCalls: [] }));
  return new AgentRuntime({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    strategy: new SingleStrategy(),
    policies: new PolicyEngine([new BudgetPolicy({ maxIterations: 2, timeoutMs: 1000 })]),
    capabilities: [],
  });
}

describe('AgentState snapshot copy semantics (I40)', () => {
  it('toJSON returns data/history copies that later transitions do not append to', () => {
    const state = new AgentState({ initialData: { runtimeId: 'r1' } });
    state.send('start');
    state.send('plan_ready');
    state.send('finish', { reply: 'ok' });
    const snapshot = state.toJSON();
    expect(snapshot.phase).toBe(AgentPhase.COMPLETED);
    expect(snapshot.history).toHaveLength(4);

    // 通配 abort 在终态仍会转移（终态保护属于事项②），但不能改写已经导出的快照。
    expect(state.send('abort', { reason: 'late' })).toBe(true);
    expect(state.phase).toBe(AgentPhase.ABORTED);
    expect(snapshot.phase).toBe(AgentPhase.COMPLETED);
    expect(snapshot.history).toHaveLength(4);
    expect(snapshot.history.at(-1)).toMatchObject({ phase: 'completed', event: 'finish' });
    expect(snapshot.data).not.toHaveProperty('reason');
    expect(state.history).toHaveLength(5);
  });

  it('toJSON copies are not write-through: mutating the snapshot leaves the state intact', () => {
    const state = new AgentState({ initialData: { runtimeId: 'r1' } });
    state.send('start');
    const snapshot = state.toJSON();

    snapshot.history.length = 0;
    snapshot.data.injected = true;

    expect(state.history).toHaveLength(2);
    expect(state.data).not.toHaveProperty('injected');
    // 再次导出得到的是新的独立拷贝。
    const again = state.toJSON();
    expect(again.history).toHaveLength(2);
    expect(again.history).not.toBe(state.toJSON().history);
    expect(again.data).not.toBe(state.toJSON().data);
  });

  it('fromJSON copies the incoming history instead of holding the caller array', () => {
    const source = new AgentState({ initialData: { runtimeId: 'r1' } });
    source.send('start');
    const snapshot = source.toJSON();
    const history = snapshot.history;
    const before = history.length;

    const restored = AgentState.fromJSON(snapshot);
    expect(restored.phase).toBe(AgentPhase.PLANNING);
    expect(restored.history).toEqual(history);

    expect(restored.send('plan_ready')).toBe(true);
    // 恢复出的状态机继续转移，不能追加进调用方持有的快照数组。
    expect(history).toHaveLength(before);
    expect(restored.history).toHaveLength(before + 1);

    // 反向同样隔离：调用方事后改动快照数组，不影响已恢复的状态机。
    history.length = 0;
    expect(restored.history).toHaveLength(before + 1);
  });
});

describe('AgentRuntime result.state is a phase-only snapshot after execute (I40 / L5-P46)', () => {
  it('returns only { phase } and a later abort() does not rewrite the returned snapshot', async () => {
    const runtime = textRuntime();
    const result = await runtime.execute(new AgentMessage({ content: 'task' }));
    expect(result.reply).toBe('done');
    // L5-P46：result.state 不再携带 data/history，只剩本次运行结束时的阶段。
    expect(result.state).toEqual({ phase: 'completed' });

    // 公开 abort()：没有活动执行时只记日志（P24/I39），不转移、不改写已返回的结果。
    runtime.abort('late cancel');
    expect(result.state).toEqual({ phase: 'completed' });
  });

  it('keeps result.state intact when an AGENT_COMPLETED observer aborts the runtime', async () => {
    const runtime = textRuntime();
    // AGENT_COMPLETED 在 result.state 写入之后发布：观察者此时的 abort() 不能回写进本次结果。
    const onCompleted = (event: { payload?: { agentId?: string } }) => {
      if (event.payload?.agentId === runtime.id) {
        runtime.abort('observer late abort');
      }
    };
    runtime.bus.on(AgentEvents.AGENT_COMPLETED, onCompleted);
    try {
      const result = await runtime.execute(new AgentMessage({ content: 'task' }));
      expect(result.state).toEqual({ phase: 'completed' });
    } finally {
      runtime.bus.off(AgentEvents.AGENT_COMPLETED, onCompleted);
    }
  });

  it('hands out a fresh state object per result so mutating one cannot leak into the next run', async () => {
    const runtime = textRuntime();
    const first = await runtime.execute(new AgentMessage({ content: 'first' }));
    (first.state as { phase: string }).phase = 'tampered';
    const second = await runtime.execute(new AgentMessage({ content: 'second' }));
    expect(second.state).toEqual({ phase: 'completed' });
    expect(second.state).not.toBe(first.state);
  });
});

/**
 * L5-P46 类型面守护（AST 断言）：tsconfig 只包含 src/**，vitest 不做类型检查，所以类型收窄用源码 AST 固定。
 * - AgentRuntime 不再导入 AgentState/AgentPhase，也不再声明实例成员 `state`：编译出的 d.ts 不会再引用 AgentState。
 * - AgentResult.state 收窄为只含 `phase` 的类型字面量（不再是 Record<string, unknown>）。
 * AgentState.ts 本身仍导出到 W2b（派发行 D3）删除，这里不断言它的去留。
 */
describe('AgentRuntime phase surface source guard (L5-P46)', () => {
  const runtimeSourcePath = new URL('../src/agent/runtime/AgentRuntime.ts', import.meta.url);
  const typesSourcePath = new URL('../src/agent/runtime/AgentRuntimeTypes.ts', import.meta.url);

  function parse(url: URL) {
    return ts.createSourceFile(
      url.pathname,
      readFileSync(url, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS
    );
  }

  it('AgentRuntime neither imports AgentState nor declares a state member', () => {
    const source = parse(runtimeSourcePath);
    const importSpecifiers = source.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
    expect(importSpecifiers).not.toContain('./AgentState.js');
    const identifiers = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        identifiers.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(identifiers.has('AgentState')).toBe(false);
    expect(identifiers.has('AgentPhase')).toBe(false);

    const runtimeClass = source.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && statement.name?.text === 'AgentRuntime'
    );
    expect(runtimeClass).toBeDefined();
    const memberNames = (runtimeClass?.members ?? [])
      .map((member) => member.name)
      .filter((name): name is ts.Identifier => name !== undefined && ts.isIdentifier(name))
      .map((name) => name.text);
    expect(memberNames).not.toContain('state');
  });

  it('AgentResult.state is narrowed to a type literal whose only member is phase', () => {
    const source = parse(typesSourcePath);
    const agentResult = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'AgentResult'
    );
    expect(agentResult).toBeDefined();
    const stateMember = agentResult?.members.find(
      (member): member is ts.PropertySignature =>
        ts.isPropertySignature(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'state'
    );
    expect(stateMember?.type).toBeDefined();
    const stateType = stateMember?.type;
    expect(stateType && ts.isTypeLiteralNode(stateType)).toBe(true);
    const memberNames =
      stateType && ts.isTypeLiteralNode(stateType)
        ? stateType.members.map((member) =>
            member.name && ts.isIdentifier(member.name) ? member.name.text : '<computed>'
          )
        : [];
    expect(memberNames).toEqual(['phase']);
  });
});
