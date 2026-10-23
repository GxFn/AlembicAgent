import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { BudgetPolicy, PolicyEngine } from '../src/agent/policies/index.js';
import { AgentEvents } from '../src/agent/runtime/AgentEventBus.js';
import { AgentMessage, Channel } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';

/**
 * W2a-05（L5-P42 / I41）：AgentMessage 的 transport 工厂（fromHttp/fromCli/fromMcp）与 replyFn 回写已退役。
 *
 * 退役理由：三个工厂与 replyFn 在 Agent 源码、测试与宿主中都没有调用方；fromHttp 把请求体 userId 当身份，
 * 可伪造 SafetyPolicy 白名单；replyFn 在执行期限与取消之外被 await。宿主只用 `new AgentMessage({ content })`
 * 与类型引用，消息投递由宿主自己负责（AgentService 返回 result.reply）。
 *
 * 签名快照只记录导出名字与种类，静态成员与实例成员不在快照内，所以这里用运行时断言、源码守护与
 * 编译器探针三层锁定，防止工厂或回写路径被悄悄恢复。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MESSAGE_SOURCE = readFileSync(
  path.join(REPO_ROOT, 'src/agent/runtime/AgentMessage.ts'),
  'utf8'
);
const RUNTIME_SOURCE = readFileSync(
  path.join(REPO_ROOT, 'src/agent/runtime/AgentRuntime.ts'),
  'utf8'
);

const RETIRED_FACTORIES = ['fromHttp', 'fromCli', 'fromMcp'] as const;
const RETIRED_SHAPES = ['ReplyFn', 'HttpRequestBody', 'HttpRequest', 'CliOptions', 'McpRequest'];

/**
 * 源码守护走 AST 而不是全文匹配：模块头注释会说明退役历史，注释不是节点，不会误报；
 * 只有标识符、私有名、字符串字面量和调用表达式会被检查。
 */
function scanSource(fileName: string, text: string) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const identifiers = new Set<string>();
  const strings: string[] = [];
  const calledMembers = new Set<string>();
  const declaredTypes = new Set<string>();
  const classMembers = new Map<string, string[]>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      identifiers.add(node.text);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
      strings.push(node.text);
    }
    if (ts.isTemplateTail(node)) {
      strings.push(node.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      calledMembers.add(node.expression.name.text);
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      declaredTypes.add(node.name.text);
    }
    if (ts.isClassDeclaration(node) && node.name) {
      classMembers.set(
        node.name.text,
        node.members.flatMap((member) =>
          member.name && (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name))
            ? [member.name.text]
            : []
        )
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { identifiers, strings, calledMembers, declaredTypes, classMembers };
}

/**
 * 只替换 strategy（外部执行体），真实 AgentRuntime 的 execute 边界、阶段字段、事件总线和诊断收集保持接线，
 * 以验证回写路径退役后运行结论、reply 返回与终态事件保持不变。
 */
function runtimeWithStrategy(execute: (...args: never[]) => Promise<unknown>) {
  return new AgentRuntime({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools: vi.fn() } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    strategy: { name: 'reply-fixture', execute } as never,
    policies: new PolicyEngine([new BudgetPolicy({ maxIterations: 2, timeoutMs: 1000 })]),
    capabilities: [],
  });
}

function completedStrategy(reply = 'final answer') {
  return vi.fn(async () => ({
    reply,
    toolCalls: [],
    tokenUsage: { input: 1, output: 1 },
    iterations: 1,
  }));
}

function observeTerminalEvents(runtime: AgentRuntime) {
  const completed = vi.fn();
  const failed = vi.fn();
  const aborted = vi.fn();
  runtime.bus.on(AgentEvents.AGENT_COMPLETED, completed);
  runtime.bus.on(AgentEvents.AGENT_FAILED, failed);
  runtime.bus.on(AgentEvents.AGENT_ABORTED, aborted);
  return { completed, failed, aborted };
}

function warningCodes(result: { diagnostics?: { warnings?: Array<{ code: string }> } }) {
  return (result.diagnostics?.warnings ?? []).map((warning) => warning.code);
}

/**
 * 编译器探针：tsconfig 只包含 src/**，vitest 不做类型检查，类型收窄必须经 TypeScript compiler API 锁定。
 * 探针放在 test/ 下的虚拟路径，按仓库 package.json（type: module）走 NodeNext 解析，只拉入 AgentMessage.ts。
 */
function typecheckProbes(probes: Record<string, string>): Record<string, string[]> {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
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
  const result: Record<string, string[]> = {};
  for (const name of Object.keys(probes)) {
    const sourceFile = program.getSourceFile(path.join(REPO_ROOT, 'test', name));
    expect(sourceFile).toBeDefined();
    result[name] = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
  return result;
}

const PROBE_IMPORT =
  "import { AgentMessage, Channel } from '../src/agent/runtime/AgentMessage.js';";

describe('AgentMessage transport factories retired (W2a-05 / L5-P42)', () => {
  it.each(RETIRED_FACTORIES)('does not expose static %s at runtime', (factory) => {
    // JS 调用方再调这些工厂会得到 TypeError（属性不存在）。
    expect(factory in AgentMessage).toBe(false);
    expect(Reflect.has(AgentMessage, factory)).toBe(false);
  });

  it('keeps AgentMessage.internal and the Channel key set unchanged', () => {
    // Channel 键集合按批准范围保留：删除 fromCli 后 CLI 没有生产者，但收窄 Channel 未获授权。
    expect(Object.values(Channel)).toEqual(['http', 'cli', 'mcp', 'internal']);
    expect(Object.isFrozen(Channel)).toBe(true);
    expect(typeof AgentMessage.internal).toBe('function');
    const internal = AgentMessage.internal('child task', {
      sourceAgentId: 'parent',
      dimension: 'arch',
      metadata: { dimension: { id: 'arch' }, source: 'unit' },
    });
    expect(internal.channel).toBe(Channel.INTERNAL);
    expect(internal.sender).toEqual({ id: 'parent', type: 'agent' });
    // 0448bd5 的修正保留：显式 dimension 覆盖 metadata 中的同名对象。
    expect(internal.metadata.dimension).toBe('arch');
    expect(internal.metadata.source).toBe('unit');
  });

  it('source no longer defines the factories, the reply members or their request shapes', () => {
    const scan = scanSource('AgentMessage.ts', MESSAGE_SOURCE);
    expect(scan.classMembers.get('AgentMessage')).toEqual([
      'id',
      'content',
      'channel',
      'session',
      'sender',
      'metadata',
      'timestamp',
      'history',
      'internal',
      'toJSON',
    ]);
    for (const name of [...RETIRED_FACTORIES, 'replyFn', ...RETIRED_SHAPES]) {
      expect(scan.identifiers.has(name), name).toBe(false);
    }
    for (const shape of RETIRED_SHAPES) {
      expect(scan.declaredTypes.has(shape), shape).toBe(false);
    }
    // 保留的非导出类型仍在：构造参数与 internal() 选项。
    expect([...scan.declaredTypes].sort()).toEqual([
      'AgentMessageOptions',
      'InternalMessageOptions',
      'Sender',
      'Session',
    ]);
  });
});

describe('AgentMessage replyFn write-back retired (W2a-05 / L5-P42)', () => {
  it('has no replyFn instance field and no reply() method', () => {
    const message = new AgentMessage({ content: 'x' });
    expect('replyFn' in message).toBe(false);
    expect('reply' in AgentMessage.prototype).toBe(false);
    expect('reply' in message).toBe(false);
    // 序列化形状不变（toJSON 本来就不含 replyFn）。
    expect(Object.keys(message.toJSON())).toEqual([
      'id',
      'content',
      'channel',
      'session',
      'sender',
      'metadata',
      'timestamp',
    ]);
  });

  it('silently ignores a replyFn passed by a JS caller and never invokes it', async () => {
    const runtime = runtimeWithStrategy(completedStrategy());
    const events = observeTerminalEvents(runtime);
    const replyFn = vi.fn(async () => undefined);

    // 只有绕过类型检查的 JS 调用方还能传 replyFn；它不再被保存，也不会被调用。
    const message = new AgentMessage({ content: 'task', replyFn } as never);
    expect('replyFn' in message).toBe(false);

    const result = await runtime.execute(message);

    expect(replyFn).not.toHaveBeenCalled();
    expect(result.reply).toBe('final answer');
    expect(events.completed).toHaveBeenCalledOnce();
    expect(events.failed).not.toHaveBeenCalled();
    expect(warningCodes(result)).not.toContain('reply_delivery_failed');
  });

  it('keeps a completed run completed, returns result.reply and publishes AGENT_COMPLETED once', async () => {
    const runtime = runtimeWithStrategy(completedStrategy('ok reply'));
    const events = observeTerminalEvents(runtime);

    const result = await runtime.execute(new AgentMessage({ content: 'task' }));

    expect(result.reply).toBe('ok reply');
    // stub strategy 不走 reactLoop，'finish' 从 idle 出发是被跳过的非法转移，阶段停在 idle；关键是不进入 failed。
    expect(result.state).toEqual({ phase: 'idle' });
    expect(events.completed).toHaveBeenCalledOnce();
    expect(events.aborted).not.toHaveBeenCalled();
    expect(events.failed).not.toHaveBeenCalled();
    expect(warningCodes(result)).not.toContain('reply_delivery_failed');
  });

  it('keeps a cancelled run aborted with the cancellation reply and publishes AGENT_ABORTED once', async () => {
    const parent = new AbortController();
    const runtime = runtimeWithStrategy(
      vi.fn(async () => {
        parent.abort();
        return { reply: 'late', toolCalls: [], tokenUsage: { input: 0, output: 0 }, iterations: 1 };
      })
    );
    const events = observeTerminalEvents(runtime);

    const result = await runtime.execute(new AgentMessage({ content: 'task' }), {
      abortSignal: parent.signal,
    });

    expect(result.reply).toContain('[run stopped: abort_signal]');
    expect(result.state).toEqual({ phase: 'aborted' });
    expect(events.aborted).toHaveBeenCalledOnce();
    expect(events.completed).not.toHaveBeenCalled();
    expect(events.failed).not.toHaveBeenCalled();
    expect(warningCodes(result)).toContain('runtime_aborted');
    expect(warningCodes(result)).not.toContain('reply_delivery_failed');
  });

  it('runtime source no longer carries the write-back branch or its diagnostic code', () => {
    const scan = scanSource('AgentRuntime.ts', RUNTIME_SOURCE);
    expect(scan.identifiers.has('#deliverReply')).toBe(false);
    expect(scan.identifiers.has('replyFn')).toBe(false);
    expect(scan.calledMembers.has('reply')).toBe(false);
    expect(scan.strings.some((text) => text.includes('reply_delivery_failed'))).toBe(false);
    expect(scan.classMembers.get('AgentRuntime')).not.toContain('#deliverReply');
    // 正对照：守护确实扫描到了 execute 边界里的私有方法与诊断码，避免 AST 扫描空转。
    expect(scan.identifiers.has('#transitionPhase')).toBe(true);
    expect(scan.strings).toContain('runtime_aborted');
  });

  it('rejects the retired members at compile time while the kept surface still type-checks', () => {
    const diagnostics = typecheckProbes({
      '__agent-message-kept-surface.probe.ts': [
        PROBE_IMPORT,
        "const message = new AgentMessage({ content: 'x', channel: Channel.CLI });",
        "export const internal = AgentMessage.internal('x', { sourceAgentId: 'a' });",
        'export const shape = [message.history, message.toJSON(), message.sender.id];',
        '',
      ].join('\n'),
      '__agent-message-factory.probe.ts': [
        PROBE_IMPORT,
        "export const viaHttp = AgentMessage.fromHttp({ body: { prompt: 'x' } });",
        '',
      ].join('\n'),
      '__agent-message-reply-option.probe.ts': [
        PROBE_IMPORT,
        "export const message = new AgentMessage({ content: 'x', replyFn: async () => undefined });",
        '',
      ].join('\n'),
      '__agent-message-reply-member.probe.ts': [
        PROBE_IMPORT,
        "const message = new AgentMessage({ content: 'x' });",
        "export const sent = message.reply('x');",
        '',
      ].join('\n'),
    });
    expect(diagnostics['__agent-message-kept-surface.probe.ts']).toEqual([]);
    expect(diagnostics['__agent-message-factory.probe.ts']).toEqual([
      "Property 'fromHttp' does not exist on type 'typeof AgentMessage'.",
    ]);
    expect(diagnostics['__agent-message-reply-option.probe.ts']).toEqual([
      "Object literal may only specify known properties, and 'replyFn' does not exist in type 'AgentMessageOptions'.",
    ]);
    expect(diagnostics['__agent-message-reply-member.probe.ts']).toEqual([
      "Property 'reply' does not exist on type 'AgentMessage'.",
    ]);
  }, 60000);
});
