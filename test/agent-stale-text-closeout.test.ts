import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Logger from '@alembic/core/logging';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProfileCompiler } from '../src/agent/profiles/AgentProfileCompiler.js';
import { AgentProfileRegistry } from '../src/agent/profiles/AgentProfileRegistry.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { TOOL_REGISTRY } from '../src/tools/runtime/registry.js';

/**
 * W 线收尾清理（W-CL1）的文字漂移守卫。
 *
 * W1/W2a 删除了 observationRecord、公开 AgentState 实例、SessionStore 只读工具缓存与清理定时器、
 * 策略层 maxSessionTokens、kernel handler 层、LLMGateway 模块级单例等表面，但注释、文档、诊断文案
 * 与测试残留仍按删除前描述。这里只钉住复核后的事实，不约束措辞细节：
 *   - 注释不再把已删除的实现说成“移出装配”或“仍在写入”；
 *   - 兼容分支写明消费者、原因、删除条件、清理触发与负责人；
 *   - 告警与模型可见描述说的是真实行为（没有按累计终止的上限；evidence.get 会读当前文件）；
 *   - 文档里的路径与行号指向当前代码；
 *   - ToolRuntimePort 不再 Pick 已无读取方的 emitProgress / bus（真实编译器探针）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** 取紧贴在锚点之前的 JSDoc 块（两者之间只能有空白）；没有则返回 null。 */
function jsDocImmediatelyBefore(source: string, anchor: string): string | null {
  const anchorIndex = source.indexOf(anchor);
  expect(anchorIndex, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const head = source.slice(0, anchorIndex);
  const end = head.lastIndexOf('*/');
  if (end < 0 || head.slice(end + 2).trim() !== '') {
    return null;
  }
  const start = head.lastIndexOf('/**', end);
  return start < 0 ? null : head.slice(start, end + 2);
}

/** 文件开头的第一个块注释（测试文件头说明）。 */
function leadingBlockComment(source: string): string {
  const start = source.indexOf('/**');
  const end = source.indexOf('*/', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

/** 用真实编译器检查只做类型赋值的探针源码，返回探针文件自身的诊断文本。 */
function typecheckProbe(name: string, text: string): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
  };
  // 探针放在 test/ 下的虚拟路径，按仓库自己的 package.json（type: module + imports）走 NodeNext 解析。
  const probePath = path.join(ROOT, 'test', name);
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

describe('W-CL1 source comments describe the code after the W line', () => {
  it('registerDefaultHooks no longer says observationRecord was only moved out of the default chain', () => {
    const doc = jsDocImmediatelyBefore(
      readRepoFile('src/agent/runtime/HookSystem.ts'),
      'export function registerDefaultHooks('
    );
    expect(doc).not.toBeNull();
    expect(doc).not.toContain('observationRecord 已移出默认装配');
    // 实现与公开导出已随 W1-04 删除，注释要说清这一点。
    expect(doc).toContain('W1-04');
  });

  it('AgentState.toJSON no longer claims AgentRuntime writes it into result.state', () => {
    const doc = jsDocImmediatelyBefore(
      readRepoFile('src/agent/runtime/AgentState.ts'),
      '  toJSON() {'
    );
    expect(doc).not.toBeNull();
    expect(doc).not.toContain('AgentRuntime 把它写进 result.state');
    // W1-06 起 result.state 来自 AgentRuntime 私有的 #phaseSnapshot()。
    expect(doc).toContain('W1-06');
    expect(doc).toContain('#phaseSnapshot');
  });

  it('the SessionStore retired-key compat branch records consumer, reason, removal condition, trigger and owner', () => {
    const doc = jsDocImmediatelyBefore(
      readRepoFile('src/agent/memory/SessionStore.ts'),
      'const RETIRED_CONFIG_KEYS'
    );
    expect(doc).not.toBeNull();
    for (const label of ['消费者', '原因', '删除条件', '清理触发', '负责人']) {
      expect(doc, label).toContain(label);
    }
  });

  it('ToolRuntimePort no longer picks the unread emitProgress and bus members', () => {
    const diagnostics = typecheckProbe(
      '__wcl1-tool-runtime-port.probe.ts',
      [
        "import type { ToolRuntimePort } from '../src/agent/runtime/toolPipeline/contracts.js';",
        'type PortKeys = keyof ToolRuntimePort;',
        "export const emitProgress: 'emitProgress' extends PortKeys ? 'picked' : 'narrowed' = 'narrowed';",
        "export const bus: 'bus' extends PortKeys ? 'picked' : 'narrowed' = 'narrowed';",
        // 正对照：管道真实读取的端口成员保留。
        "export const router: 'toolRouter' extends PortKeys ? 'picked' : 'missing' = 'picked';",
        "export const logger: 'logger' extends PortKeys ? 'picked' : 'missing' = 'picked';",
        "export const policies: 'policies' extends PortKeys ? 'picked' : 'missing' = 'picked';",
        "export const projectRoot: 'projectRoot' extends PortKeys ? 'picked' : 'missing' = 'picked';",
        "export const presetName: 'presetName' extends PortKeys ? 'picked' : 'missing' = 'picked';",
        "export const aiProvider: 'aiProvider' extends PortKeys ? 'picked' : 'missing' = 'picked';",
        "export const lang: 'lang' extends PortKeys ? 'picked' : 'missing' = 'picked';",
        "export const id: 'id' extends PortKeys ? 'picked' : 'missing' = 'picked';",
        '',
      ].join('\n')
    );
    expect(diagnostics).toEqual([]);
  });
});

describe('W-CL1 diagnostics and model-visible text match the real behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the removed maxSessionTokens warning names the real run caps instead of the stage compaction budget', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    new AgentProfileCompiler({
      profileRegistry: new AgentProfileRegistry([]),
      stageFactoryRegistry: new AgentStageFactoryRegistry(),
    }).compile({
      basePreset: 'chat',
      policies: [{ type: 'budget', maxSessionTokens: 1_000 }],
    });

    const messages = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('policy_session_fields_deprecated'));
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message).toContain('maxSessionTokens=1000 has been removed and is ignored');
    // 已没有按累计 token 终止运行的上限；阶段级 maxSessionInputTokens 只是压缩触发，不是替代品。
    expect(message).toContain('no longer any cap that stops the run on cumulative tokens');
    expect(message).toContain('only as the in-stage compaction trigger');
    expect(message).not.toMatch(
      /maxSessionInputTokens \(executed in-stage by BudgetController\) instead/
    );
    // 现存的真实手段：策略层轮数/超时，以及（阶段也声明时才生效的）策略层运行级 input 上限。
    expect(message).toContain('BudgetPolicy maxIterations or timeoutMs');
    expect(message).toContain('token_budget_exhausted');
    expect(message).toContain('policy_session_limit_bypassed');
  });

  it('evidence.get describes the current-file readback and its verbatim/redaction fields', () => {
    const description = TOOL_REGISTRY.evidence?.actions.get?.description ?? '';
    expect(description).not.toContain('never touches the file system');
    // 回读路径：读当前文件判 freshness，fresh 时返回原文并标 verbatim: true。
    expect(description).toContain('reads the current file');
    expect(description).toContain('verbatim: true');
    // 降级路径：返回台账存储内容（可能含脱敏标记），带 verbatim: false、redaction 与 hint。
    expect(description).toContain('verbatim: false');
    expect(description).toContain('redaction: {markers, lines}');
    expect(description).toContain('code.read');
    // I21 的坐标说明保持不变。
    expect(description).toContain('file line numbers');
    expect(description).toContain('1-based line numbers within the entry');
  });
});

describe('W-CL1 tests no longer pass the retired SessionStore cleanup key', () => {
  /** 专门验证“旧键被忽略”的用例保留旧键；其余测试不应再传它。 */
  const RETIRED_KEY_FIXTURE_FILES = new Set([
    'memory-session-store-lazy-cleanup.test.ts',
    'memory-context.test.ts',
    'agent-stale-text-closeout.test.ts',
  ]);

  it('only the dedicated retired-key cases construct SessionStore with cleanupIntervalMs', () => {
    const offenders = readdirSync(path.join(ROOT, 'test'))
      .filter((name) => name.endsWith('.test.ts') && !RETIRED_KEY_FIXTURE_FILES.has(name))
      .filter((name) => /\bcleanupIntervalMs\s*:/.test(readRepoFile(path.join('test', name))));
    expect(offenders).toEqual([]);
  });
});

describe('W-CL1 docs and machine records describe the current code', () => {
  it('tool-host-integration says knowledge.prime no longer accepts knowledgeRepo', () => {
    const doc = readRepoFile('docs/tool-host-integration.md');
    const repoBullet = doc.split('\n').find((line) => line.startsWith('- `knowledgeRepo`'));
    expect(repoBullet).toBeDefined();
    expect(repoBullet).toContain('prime');
    expect(repoBullet).toContain('KNOWLEDGE_READ_PORT_UNAVAILABLE');
  });

  it('side-effect census cites current paths and line numbers', () => {
    const census = readRepoFile('docs/side-effect-doctrine-census.md');
    expect(census).not.toContain('src/tools/v2/');
    expect(census).not.toContain('ConversationStore.ts:25,68');
    expect(census).not.toContain('SessionStore.ts:200,871');
    expect(census).not.toContain('whose checkpoint restore');

    // pathGuard 的引用行号必须真的落在 pathGuard 上。
    const match = /src\/agent\/context\/ConversationStore\.ts:(\d+),(\d+)/.exec(census);
    expect(match).not.toBeNull();
    const conversationLines = readRepoFile('src/agent/context/ConversationStore.ts').split('\n');
    for (const lineNo of [Number(match?.[1]), Number(match?.[2])]) {
      expect(conversationLines[lineNo - 1], `ConversationStore.ts:${lineNo}`).toContain(
        'pathGuard'
      );
    }

    // I6 的 SessionStore 冻结默认值引用必须落在 RETIRED_TOOL_CACHE_STATS 上。
    const freeze = /src\/agent\/memory\/SessionStore\.ts:(\d+)/.exec(census);
    expect(freeze).not.toBeNull();
    const sessionLines = readRepoFile('src/agent/memory/SessionStore.ts').split('\n');
    expect(sessionLines[Number(freeze?.[1]) - 1]).toContain(
      'RETIRED_TOOL_CACHE_STATS: Readonly<SessionStoreCacheStats> = Object.freeze('
    );
  });

  it('memory-runtime states that host dispatch row D15 (dispose SessionStore) has not landed yet', () => {
    const doc = readRepoFile('docs/memory-runtime.md');
    const paragraph = doc
      .split('\n')
      .find((line) => line.includes('会话结束时只 dispose SessionStore'));
    expect(paragraph).toBeDefined();
    expect(paragraph).toContain('D15');
    expect(paragraph).toContain('尚未落地');
  });

  it('the doctrine record no longer describes a SessionStore cleanup interval', () => {
    const doctrine = JSON.parse(readRepoFile('config/side-effect-doctrine.json')) as {
      outOfRepoSingletons: Array<{ name: string; agentUsage: string }>;
    };
    const timer = doctrine.outOfRepoSingletons.find((entry) => entry.name === 'timerRegistry');
    expect(timer).toBeDefined();
    expect(timer?.agentUsage).not.toContain('cleanup interval');
    expect(timer?.agentUsage).toContain('W1-04');
  });

  it('the doctrine lint header no longer names LLMGateway as a lazy-slot user', () => {
    const header = readRepoFile('scripts/lint-doctrine.mjs').split('\n').slice(0, 20).join('\n');
    expect(header).not.toContain('used by ModelRegistry and LLMGateway');
    expect(header).toContain('W2a-11');
  });

  it('the repository CLAUDE.md tool-kernel bullet no longer lists the deleted handler layer', () => {
    // 仓库根 CLAUDE.md 不在并行修复编排的路径过滤内，由总控单独提交（453650d）；这里只守住事实陈述。
    const claude = readRepoFile('CLAUDE.md');
    const kernelBullet = claude
      .split('\n- ')
      .find((bullet) => bullet.startsWith('工具契约只有一份'));
    expect(kernelBullet).toBeDefined();
    expect(kernelBullet).not.toMatch(/call context、handler、registry/);
    expect(kernelBullet).toContain('handler.ts');
  });

  it('test file headers no longer describe deleted members as current behavior', () => {
    const timeoutHeader = leadingBlockComment(
      readRepoFile('test/exit-controller-runtime-timeout.test.ts')
    );
    expect(timeoutHeader).toContain('W2a-07');

    const conversationHeader = leadingBlockComment(
      readRepoFile('test/conversation-capability.test.ts')
    );
    expect(conversationHeader).not.toMatch(
      /buildDynamicMemoryPrompt \/\s*\n?\s*\*?\s*recordObservation/
    );
    expect(conversationHeader).toContain('W1-04');
  });
});
