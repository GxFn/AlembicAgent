import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * L8-P07（L8-C16）注释漂移与类型擦除守卫。
 *
 * - insight preset / presets 组装件的注释是维护者排查门动作、维度 profile 与工具观察者接线的入口，
 *   说错名字（bootstrap-dimension、orchestrator 注入 onToolCall、宿主行号）会把人引到不存在的路径。
 * - AgentRuntimeBuilder 的 capability 生命周期注释必须与「每次 build 新建」的事实一致；
 *   aiProvider / toolRegistry 不再用 `as never` 擦除到任意类型。
 * - SystemRunContextFactory.createSystemContext / projectSystemRunContext 的返回值必须带具体字段类型，
 *   让 ScanAgentRun 不靠强转就能拿到 systemRunContext 与 scopeId：字段改名时编译器能发现。
 * 这里只钉住已核实的事实，不约束措辞细节；类型断言用真实编译器检查探针源码。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string): string {
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

/** 锚点之前若干行的文本（用于检查声明旁的行内注释）。 */
function linesBefore(source: string, anchor: string, count: number): string {
  const anchorIndex = source.indexOf(anchor);
  expect(anchorIndex, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const lines = source.slice(0, anchorIndex).split('\n');
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
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

/** 源码里所有 `x as never` 断言的文本（只看真实 AST，不受注释措辞影响）。 */
function neverAssertionsIn(source: string): string[] {
  const sourceFile = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.NeverKeyword) {
      found.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('system run context projection keeps concrete field types (U55-F10)', () => {
  it('types systemRunContext / scopeId on createSystemContext and projectSystemRunContext', () => {
    const diagnostics = typecheckProbe(
      '__system-run-context-projection-probe.ts',
      [
        "import type { SystemRunContextFactory } from '../src/agent/service/SystemRunContextFactory.js';",
        "import { projectSystemRunContext, type SystemRunContext } from '../src/agent/runtime/SystemRunContext.js';",
        'declare const factory: SystemRunContextFactory;',
        'declare const ctx: SystemRunContext;',
        "const projected = factory.createSystemContext({ label: 'probe' });",
        'const run: SystemRunContext = projected.systemRunContext;',
        'const scopeId: string = projected.scopeId;',
        'const dimensionScopeId: string = projected.sharedState._dimensionScopeId;',
        'const projectedAgain: SystemRunContext = projectSystemRunContext(ctx).systemRunContext;',
        // 投影仍要能整体作为 strategyContext（Record<string, unknown>）传递，不收窄消费方入口。
        'const asStrategyContext: Record<string, unknown> = projected;',
        'export { run, scopeId, dimensionScopeId, projectedAgain, asStrategyContext };',
      ].join('\n')
    );
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it('removes the uncalled SystemRunContextFactory.project wrapper (W2a-06 / L8-P17)', async () => {
    // project() 只是 projectSystemRunContext 的转发，宿主与三仓都没有调用方；调用方直接用后者。
    const { SystemRunContextFactory } = await import(
      '../src/agent/service/SystemRunContextFactory.js'
    );
    const factory = new SystemRunContextFactory();
    expect((factory as unknown as Record<string, unknown>).project).toBeUndefined();
    expect('project' in SystemRunContextFactory.prototype).toBe(false);
    const diagnostics = typecheckProbe(
      '__system-run-context-factory-project-probe.ts',
      [
        "import type { SystemRunContextFactory } from '../src/agent/service/SystemRunContextFactory.js';",
        "import type { SystemRunContext } from '../src/agent/runtime/SystemRunContext.js';",
        'declare const factory: SystemRunContextFactory;',
        'declare const ctx: SystemRunContext;',
        'export const viaProject = factory.project(ctx);',
      ].join('\n')
    );
    expect(diagnostics).toEqual([
      "Property 'project' does not exist on type 'SystemRunContextFactory'.",
    ]);
  }, 60_000);

  it('ScanAgentRun reads the projection without casting systemRunContext or scopeId', () => {
    const source = readSource('src/agent/runs/scan/ScanAgentRun.ts');
    expect(source).not.toContain("as AgentRunInput['context']['systemRunContext']");
    expect(source).not.toMatch(/scopeId\s+as\s+string/u);
    expect(source).toMatch(/systemRunContext:\s*systemCtx\.systemRunContext,/u);
    expect(source).toMatch(/dimensionScopeId:\s*systemCtx\.scopeId\s*\}/u);
  });
});

describe('AgentRuntimeBuilder comments and casts match the code (U54-F8)', () => {
  const source = readSource('src/agent/service/AgentRuntimeBuilder.ts');

  it('describes capabilities as created per build, not reused across runs', () => {
    // 旧注释原句声称能力实例跨运行复用，与 CapabilityRegistry.create 每次 new 的事实相反。
    expect(source).not.toContain('能力实例跨运行复用');
    const capabilityComment = linesBefore(source, '#getCapabilityOpts() {', 6);
    expect(capabilityComment).toContain('每次 build');
  });

  it('does not erase aiProvider / toolRegistry with `as never`', () => {
    expect(neverAssertionsIn(source)).toEqual([]);
    // 替代写法必须与 AgentRuntime 的构造契约同源，并在旁边说明宿主注入边界。
    expect(source).toContain("RuntimeConfig['aiProvider']");
    expect(source).toContain("RuntimeConfig['toolRegistry']");
  });
});

describe('insight preset and presets assembly comments match the code (U52-F8)', () => {
  it('names the current gate actions, dimension profiles and onToolCall wiring', () => {
    const source = readSource('src/agent/profiles/presets/insightPreset.ts');
    expect(source).not.toContain('bootstrap-dimension');
    expect(source).not.toContain('三态');
    expect(source).not.toContain('orchestrator');
    expect(source).toContain('generate-dimension');
    expect(source).toContain('module-mining-dimension');
    expect(source).toContain('generateDimensionPipeline');
    for (const action of ['analysis_retry', 'record_repair', 'summary_rewrite', 'degrade']) {
      expect(source).toContain(action);
    }
    // 工具观察者走 runtime 级 onToolCall，由宿主经 AgentRunInput.execution 传入。
    expect(source).toContain('execution.onToolCall');
  });

  it('references host consumers by symbol, without host line numbers or truncated @returns', () => {
    const source = readSource('src/agent/profiles/presets/index.ts');
    expect(source).not.toMatch(/\.ts:\d+/u);
    expect(source).not.toMatch(/@returns\s*\}/u);
    const getPresetDoc = jsDocImmediatelyBefore(source, 'export function getPreset(');
    expect(getPresetDoc).not.toBeNull();
    expect(getPresetDoc).toMatch(/@param presetName\s+\S/u);
    expect(getPresetDoc).toMatch(/@returns\s+\S/u);
    expect(getPresetDoc).toContain('strategyInstance');
  });
});
