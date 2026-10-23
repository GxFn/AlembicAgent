/**
 * W2a-08：门评估器与 scan 阶段构造收窄（L7-P27 的 C49/C50/C51；用户 2026-10-20 答复②③）。
 *
 * 三处都是 ./prompts 公开函数的参数收窄，函数名与运行时种类不变（签名快照不变），所以按三层锁定：
 *   - 运行时断言：旧字段被忽略后的实际判定结果（decayedRecipes 不再是期望集合；submitToolNames 不再
 *     改变拒绝率门统计的工具）；
 *   - 源码 AST 守护：src 中不再出现被删字段、回退函数与诊断常量的标识符（注释与字符串不计）；
 *   - 编译器探针：tsconfig 只包含 src/**，vitest 不做类型检查，opts 必填与字段删除只能经
 *     TypeScript compiler API 锁定。
 *
 * 保留项同样钉住：existingRecipes 仍是进化门唯一期望集合来源；buildScanPipelineStages 的运行期入口
 * 校验（assertScanPipelineOpts）对 JS 调用方仍以带字段名的 Error 拒绝缺失或非法 opts。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Logger from '@alembic/core/logging';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evolutionGateEvaluator,
  producerRejectionGateEvaluator,
} from '../src/agent/evaluation/gateEvaluators.js';
import { buildScanPipelineStages } from '../src/agent/evaluation/stageBuilders.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const GATE_EVALUATORS_PATH = path.join(SRC_ROOT, 'agent', 'evaluation', 'gateEvaluators.ts');

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

/** src 中名为 names 之一的标识符出现位置（含属性名、对象字面量键）；注释与字符串字面量不计。 */
function srcIdentifierHits(names: readonly string[]): string[] {
  const wanted = new Set(names);
  const hits: string[] = [];
  for (const file of listTsFiles(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && wanted.has(node.text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        hits.push(`${path.relative(REPO_ROOT, file)}:${line + 1} ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return hits;
}

/** 编译器探针：所有探针放在 test/ 下的虚拟路径、同一个 Program 里检查，按 NodeNext 解析 src 模块。 */
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

function spyWarn() {
  // winston 的 warn 返回 Logger 本身；mock 返回同一实例以满足签名，不触发真实输出。
  return vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => Logger.getInstance());
}

const rejectedKnowledgeSubmit = {
  tool: 'knowledge',
  args: { action: 'submit' },
  result: { status: 'rejected' },
};
const otherToolSubmit = {
  tool: 'other_submit_tool',
  args: { action: 'submit' },
  result: { status: 'rejected' },
};

// ── C49：进化门 decayedRecipes 别名删除（决定③）──
describe('evolutionGateEvaluator without the decayedRecipes alias (W2a-08 / C49)', () => {
  it('ignores a JS caller that still passes decayedRecipes: empty expectation, pass, no alias log', () => {
    const warn = spyWarn();
    const result = evolutionGateEvaluator({ toolCalls: [] }, null, {
      decayedRecipes: [{ id: 'recipe-1' }, { id: 'recipe-2' }],
    } as never);
    expect(result).toEqual({
      action: 'pass',
      artifact: {
        processed: 0,
        totalRecipes: 0,
        pendingIds: [],
        evolved: 0,
        deprecated: 0,
        skipped: 0,
      },
    });
    const aliasLogs = warn.mock.calls.filter(([message]) =>
      String(message).includes('decayedRecipes')
    );
    expect(aliasLogs).toEqual([]);
  });

  it('keeps existingRecipes as the only expectation source', () => {
    const result = evolutionGateEvaluator({ toolCalls: [] }, null, {
      existingRecipes: [{ id: 'recipe-current' }],
      decayedRecipes: [{ id: 'recipe-legacy' }],
    } as never);
    expect(result).toMatchObject({
      action: 'retry',
      artifact: { totalRecipes: 1, pendingIds: ['recipe-current'] },
    });
    expect(evolutionGateEvaluator(null, null)).toMatchObject({
      action: 'pass',
      artifact: { totalRecipes: 0, pendingIds: [] },
    });
  });
});

// ── C50：拒绝率门 submitToolNames 选项删除（决定②）──
describe('producerRejectionGateEvaluator counts knowledge.submit only (W2a-08 / C50)', () => {
  it('no longer counts another tool as rejected submissions when submitToolNames names it', () => {
    expect(
      producerRejectionGateEvaluator(
        { toolCalls: [otherToolSubmit, otherToolSubmit] },
        {},
        {
          submitToolNames: ['other_submit_tool'],
        }
      ).action
    ).toBe('pass');
  });

  it('keeps counting rejected knowledge.submit even when submitToolNames excludes knowledge', () => {
    const result = producerRejectionGateEvaluator(
      { toolCalls: [rejectedKnowledgeSubmit, rejectedKnowledgeSubmit] },
      {},
      { submitToolNames: ['other_submit_tool'] }
    );
    expect(result).toEqual({ action: 'retry', reason: '2 rejections vs 0 successes' });
  });

  it('wires the scan rejection gate to the shared evaluator without an override wrapper', () => {
    const stages = buildScanPipelineStages({
      task: 'extract',
      producePrompt: 'scan producer system prompt',
      analyzeCaps: ['code_analysis'],
      produceCaps: ['scan_production'],
    });
    const rejectionGate = stages[3] as { name?: string; gate?: { evaluator?: unknown } };
    expect(rejectionGate.name).toBe('rejection_gate');
    expect(rejectionGate.gate?.evaluator).toBe(producerRejectionGateEvaluator);
  });
});

// ── 源码 AST 守护：被删字段、回退函数与诊断常量不再出现在 src ──
describe('gate evaluator narrowing source guards (W2a-08)', () => {
  it('leaves no decayedRecipes / submitToolNames identifiers or alias fallback helpers in src', () => {
    expect(
      srcIdentifierHits([
        'decayedRecipes',
        'submitToolNames',
        'resolveEvolutionRecipes',
        'DECAYED_RECIPES_ALIAS_LOG_MESSAGE',
      ])
    ).toEqual([]);
  });

  it('drops the names parameter from countSubmissions and the option from GateStrategyContext', () => {
    const text = readFileSync(GATE_EVALUATORS_PATH, 'utf8');
    const sourceFile = ts.createSourceFile(
      GATE_EVALUATORS_PATH,
      text,
      ts.ScriptTarget.Latest,
      true
    );
    let countSubmissionsParams: string[] | null = null;
    let gateContextMembers: string[] | null = null;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'countSubmissions') {
        countSubmissionsParams = node.parameters.map((param) => param.name.getText(sourceFile));
      }
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'GateStrategyContext') {
        gateContextMembers = node.members.map((member) =>
          member.name ? member.name.getText(sourceFile) : `[${ts.SyntaxKind[member.kind]}]`
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(countSubmissionsParams).toEqual(['toolCalls']);
    expect(gateContextMembers).not.toBeNull();
    expect(gateContextMembers).not.toContain('submitToolNames');
  });
});

// ── C51 与字段删除的编译器探针 ──
describe('gate evaluator and scan stage compiler probes (W2a-08)', () => {
  it('requires buildScanPipelineStages opts and rejects decayedRecipes in the evolution gate context', () => {
    const diagnostics = typecheckProbes({
      '__scan-opts-missing.probe.ts': [
        "import { buildScanPipelineStages } from '../src/agent/evaluation/stageBuilders.js';",
        'export const missing = buildScanPipelineStages();',
        '',
      ].join('\n'),
      '__evolution-gate-decayed-recipes.probe.ts': [
        "import { evolutionGateEvaluator } from '../src/agent/evaluation/gateEvaluators.js';",
        "export const legacy = evolutionGateEvaluator(null, null, { decayedRecipes: [{ id: 'r' }] });",
        '',
      ].join('\n'),
      // 正对照：合法调用零诊断；opts 参数类型不再包含 undefined。
      '__gate-scan-valid.probe.ts': [
        "import { evolutionGateEvaluator } from '../src/agent/evaluation/gateEvaluators.js';",
        "import { buildScanPipelineStages } from '../src/agent/evaluation/stageBuilders.js';",
        'export const stages = buildScanPipelineStages({',
        "  task: 'extract',",
        "  producePrompt: 'p',",
        '  analyzeCaps: [],',
        '  produceCaps: [],',
        '});',
        'type ScanOpts = Parameters<typeof buildScanPipelineStages>[0];',
        "export const optionality: undefined extends ScanOpts ? 'optional' : 'required' = 'required';",
        "export const gate = evolutionGateEvaluator(null, null, { existingRecipes: [{ id: 'r' }] });",
        '',
      ].join('\n'),
    });
    expect(diagnostics['__scan-opts-missing.probe.ts']).toEqual([
      'Expected 1 arguments, but got 0.',
    ]);
    expect(diagnostics['__evolution-gate-decayed-recipes.probe.ts']).toHaveLength(1);
    expect(diagnostics['__evolution-gate-decayed-recipes.probe.ts']?.[0]).toMatch(
      /'decayedRecipes' does not exist in type/
    );
    expect(diagnostics['__gate-scan-valid.probe.ts']).toEqual([]);
  }, 60000);

  it('keeps the runtime opts check for JS callers that still omit opts', () => {
    const untypedBuild = buildScanPipelineStages as unknown as (opts?: unknown) => unknown;
    expect(() => untypedBuild()).toThrow(/opts\.task/);
    expect(() => untypedBuild(null)).toThrow(/buildScanPipelineStages.*opts/);
  });
});
