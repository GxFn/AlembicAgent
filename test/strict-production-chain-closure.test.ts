import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Logger from '@alembic/core/logging';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAnalysisArtifact } from '../src/agent/evaluation/analysisArtifact.js';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import { createStrictAnalysisContextProjectionV1 } from '../src/agent/production/StrictProductionPipeline.js';
import { GenerateProduce } from '../src/tools/runtime/toolsets/GenerateProduce.js';
import { ScanProduce } from '../src/tools/runtime/toolsets/ScanProduce.js';

/**
 * W1-01 严格链收口（审阅包 L4-P35、L6-P27、L7-P27 C45、L7-P09）。
 *
 * 决定④：严格冷启动只由阶段配置表达——buildStrictProductionPipelineStagesV1 的 analyze/produce
 * 阶段 capabilities:[]、additionalTools:[]、toolChoiceOverride:'none'（见 strict-production-chain
 * 的阶段断言）。由此收口的三处 Agent 内部旁路：
 *   - GenerateProduce / ScanProduce 不再接收 strictColdStart 构造选项（CapabilityRegistry 从不传它，
 *     宿主不直接构造这两个类，只有测试锁定）；
 *   - ActiveContext 不再绑定、蒸馏、序列化严格分析上下文投影（宿主 StrictColdStartOrchestrator 独立
 *     承担严格链），memory 层不再反向依赖 production 层；
 *   - buildAnalysisArtifact 的 opts 收窄为 { projectRoot? }，不再透传严格投影，也不再需要
 *     “严格上下文混入 legacy 工件”的过渡告警（C45 诊断与分支同批删除）。
 * tsconfig 只包含 src/**，vitest 不做类型检查，所以“选项已不可传”用真实编译器探针锁定；JS 调用方
 * 仍可能传入旧字段，运行时用例钉住它们会静默得到完整工具集或普通 legacy 工件（提交说明中的可见变化）。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 旧版本持久化/蒸馏可能带出的严格投影（只用作“旧字段输入”，不再有 Agent 内消费方）。 */
const legacyStrictContext = createStrictAnalysisContextProjectionV1({
  runId: 'run-closure',
  journalId: 'journal-closure',
  manifestHash: 'manifest-closure',
  planCognitionHash: 'plan-cognition-closure',
  planHash: 'plan-closure',
  requiredUniverseHash: 'universe-closure',
  baselineScheduleHash: 'schedule-closure',
  expansionHeadHash: null,
  currentExpandedScheduleHash: 'schedule-closure',
  finalExpandedScheduleHash: null,
  analysisFixpointHash: null,
  privateCorpusRevision: null,
  hypothesisExpressionSetHash: null,
  lensBindingsHash: 'lens-closure',
  sourceArtifactHash: 'artifact-closure',
  sourceRevisionVectorHash: 'vector-closure',
  questionIds: ['q-root'],
  factQueryObligationIds: ['base-1'],
  analysisUnitIds: ['unit-1'],
  factIds: ['fact-a'],
  witnessIds: ['witness-a'],
  populationHashes: ['population-1'],
  clusterSetHashes: [],
  inductionReceiptHashes: [],
  hypothesisIds: [],
  falsificationReceiptHashes: [],
  dispositionReviewIds: [],
  evidenceEntryIds: ['E-1'],
  derivedFindingCount: 0,
});

/** 用真实编译器检查一组探针源码，返回每个探针文件自身的诊断文本。 */
function typecheckProbes(probes: Record<string, string>): Record<string, string[]> {
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

function probeSource(lines: readonly string[]): string {
  return [...lines, ''].join('\n');
}

describe('strict cold-start options are no longer part of the typed surface (compiler probes)', () => {
  it('rejects strictColdStart on both production capabilities and on buildAnalysisArtifact', () => {
    const diagnostics = typecheckProbes({
      '__strict-closure-generate-produce.probe.ts': probeSource([
        "import { GenerateProduce } from '../src/tools/runtime/toolsets/GenerateProduce.js';",
        'export const probe = new GenerateProduce({ strictColdStart: true });',
      ]),
      '__strict-closure-scan-produce.probe.ts': probeSource([
        "import { ScanProduce } from '../src/tools/runtime/toolsets/ScanProduce.js';",
        'export const probe = new ScanProduce({ strictColdStart: true });',
      ]),
      '__strict-closure-artifact-option.probe.ts': probeSource([
        "import { buildAnalysisArtifact } from '../src/agent/evaluation/analysisArtifact.js';",
        "export const probe = buildAnalysisArtifact({ reply: '' }, 'architecture', null, null, {",
        '  strictColdStart: true,',
        '});',
      ]),
      '__strict-closure-artifact-result.probe.ts': probeSource([
        "import { buildAnalysisArtifact } from '../src/agent/evaluation/analysisArtifact.js';",
        "const artifact = buildAnalysisArtifact({ reply: '' }, 'architecture');",
        'export const probe = artifact.strictAnalysisContext;',
      ]),
      '__strict-closure-distilled-context.probe.ts': probeSource([
        "import type { DistilledContext } from '../src/agent/memory/MemoryFlushContract.js';",
        'declare const distilled: DistilledContext;',
        'export const probe = distilled.strictAnalysisContext;',
      ]),
      '__strict-closure-active-context-bind.probe.ts': probeSource([
        "import { ActiveContext } from '../src/agent/memory/ActiveContext.js';",
        'export const probe = new ActiveContext().bindStrictAnalysisContext;',
      ]),
      // 正对照：收口后仍合法的调用形态必须零诊断，避免探针因解析失败而“恒报错”。
      '__strict-closure-positive-control.probe.ts': probeSource([
        "import { buildAnalysisArtifact } from '../src/agent/evaluation/analysisArtifact.js';",
        "import { ActiveContext } from '../src/agent/memory/ActiveContext.js';",
        "import type { DistilledContext } from '../src/agent/memory/MemoryFlushContract.js';",
        "import { GenerateProduce } from '../src/tools/runtime/toolsets/GenerateProduce.js';",
        "import { ScanProduce } from '../src/tools/runtime/toolsets/ScanProduce.js';",
        'export const generate = new GenerateProduce().allowedTools;',
        'export const scan = new ScanProduce().allowedTools;',
        'const context = new ActiveContext();',
        'export const distilled: DistilledContext = context.distill();',
        "export const artifact = buildAnalysisArtifact({ reply: '' }, 'architecture', null, context, {",
        "  projectRoot: 'project-root',",
        '});',
      ]),
    });

    expect(diagnostics['__strict-closure-generate-produce.probe.ts']).toEqual([
      'Expected 0 arguments, but got 1.',
    ]);
    expect(diagnostics['__strict-closure-scan-produce.probe.ts']).toEqual([
      'Expected 0 arguments, but got 1.',
    ]);
    expect(diagnostics['__strict-closure-artifact-option.probe.ts']).toEqual([
      expect.stringContaining("'strictColdStart' does not exist in type"),
    ]);
    expect(diagnostics['__strict-closure-artifact-result.probe.ts']).toEqual([
      expect.stringContaining("Property 'strictAnalysisContext' does not exist"),
    ]);
    expect(diagnostics['__strict-closure-distilled-context.probe.ts']).toEqual([
      "Property 'strictAnalysisContext' does not exist on type 'DistilledContext'.",
    ]);
    expect(diagnostics['__strict-closure-active-context-bind.probe.ts']).toEqual([
      "Property 'bindStrictAnalysisContext' does not exist on type 'ActiveContext'.",
    ]);
    expect(diagnostics['__strict-closure-positive-control.probe.ts']).toEqual([]);
  }, 120000);
});

describe('JS callers that still pass strictColdStart get the ordinary behavior', () => {
  /** 模拟无类型检查的 JS 调用方：仍按旧习惯传入 strictColdStart。 */
  type LegacyOptionsCtor<T> = new (options: Readonly<Record<string, unknown>>) => T;

  it('GenerateProduce keeps its full production allowlist and prompt', () => {
    const LegacyGenerate = GenerateProduce as unknown as LegacyOptionsCtor<GenerateProduce>;
    const capability = new LegacyGenerate({ strictColdStart: true });
    expect(capability.allowedTools).toEqual(new GenerateProduce().allowedTools);
    expect(capability.allowedTools).toEqual({
      knowledge: ['submit'],
      memory: ['recall'],
      evidence: ['get', 'search'],
      meta: ['review'],
    });
    expect(capability.promptFragment).toBe(new GenerateProduce().promptFragment);
    expect(capability.promptFragment).not.toContain('Strict knowledge proposal authoring');
  });

  it('ScanProduce keeps its full production allowlist and evidence rescue prompt', () => {
    const LegacyScan = ScanProduce as unknown as LegacyOptionsCtor<ScanProduce>;
    const capability = new LegacyScan({ strictColdStart: true });
    expect(capability.allowedTools).toEqual({
      code: ['read'],
      knowledge: ['submit'],
      memory: ['recall'],
      evidence: ['get', 'search'],
    });
    expect(capability.promptFragment).toBe(new ScanProduce().promptFragment);
    expect(capability.promptFragment).toContain('## 扫描生产证据自救通道');
    expect(capability.promptFragment).not.toContain('Strict scan proposal authoring');
  });
});

describe('ActiveContext no longer carries a strict analysis context projection', () => {
  it('has no strict binding entrypoint on the prototype', () => {
    expect('bindStrictAnalysisContext' in ActiveContext.prototype).toBe(false);
  });

  it('never emits a strict field from distill() or toJSON()', () => {
    const context = new ActiveContext();
    context.noteKeyFinding('legacy finding', 'src/live.ts:1', 8);
    expect(context.distill()).not.toHaveProperty('strictAnalysisContext');
    expect(context.toJSON()).not.toHaveProperty('strictAnalysisContext');
  });

  it.each([
    { label: 'an intact projection', strict: legacyStrictContext },
    // 旧实现在恢复时重算 hash 并抛 STRICT_CONTEXT_HASH_MISMATCH；字段不再被读取后，
    // 篡改过的旧快照同样只是被忽略的未知字段，不能让 legacy 部分恢复失败。
    { label: 'a tampered projection', strict: { ...legacyStrictContext, contextHash: 'tampered' } },
    { label: 'an unsupported schema', strict: { ...legacyStrictContext, schemaVersion: 2 } },
  ])('ignores $label in persisted JSON and restores the legacy state', ({ strict }) => {
    const source = new ActiveContext();
    source.noteKeyFinding('legacy scratchpad finding', 'src/live.ts:1', 8);
    const persisted = { ...source.toJSON(), strictAnalysisContext: strict };

    let restored: ActiveContext | undefined;
    expect(() => {
      restored = ActiveContext.fromJSON(persisted);
    }).not.toThrow();
    expect(restored?.distill()).not.toHaveProperty('strictAnalysisContext');
    expect(restored?.toJSON()).not.toHaveProperty('strictAnalysisContext');
    expect(restored?.distill().keyFindings).toEqual([
      { finding: 'legacy scratchpad finding', evidence: 'src/live.ts:1', importance: 8 },
    ]);
  });
});

describe('buildAnalysisArtifact treats a strict-carrying distill as a plain legacy artifact', () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'agent-strict-closure-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, 'src', 'alpha.ts'),
      Array.from({ length: 20 }, (_, i) => `export const alpha${i} = ${i};`).join('\n')
    );
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spyLogs() {
    // winston 的 warn/info 返回 Logger 本身；mock 返回同一实例以满足签名，不触发真实输出。
    const warn = vi
      .spyOn(Logger.getInstance(), 'warn')
      .mockImplementation(() => Logger.getInstance());
    const info = vi
      .spyOn(Logger.getInstance(), 'info')
      .mockImplementation(() => Logger.getInstance());
    return { warn, info };
  }

  /** 旧版 distill 桩：在 legacy 字段之外仍带出严格投影（例如旧快照恢复后的外部实现）。 */
  function strictCarryingContext(
    keyFindings: { finding: string; evidence: string; importance: number }[]
  ) {
    const distilled = {
      keyFindings,
      toolCallSummary: [],
      strictAnalysisContext: legacyStrictContext,
    };
    return { distill: () => distilled };
  }

  const readCall = (filePath: string) => ({
    tool: 'code',
    args: { action: 'read', path: filePath },
    result: Array.from({ length: 5 }, (_, i) => `${i + 1}|export const v${i} = ${i};`).join('\n'),
  });

  it('keeps memory findings and post-hoc anchor reads, drops the strict field and stays silent', () => {
    const { warn } = spyLogs();
    const artifact = buildAnalysisArtifact(
      { reply: '## alpha\nsee src/alpha.ts:12-13', toolCalls: [] },
      'architecture',
      null,
      strictCarryingContext([
        {
          finding: 'alpha constants are sequential',
          evidence: 'src/alpha.ts:12-13',
          importance: 8,
        },
      ]),
      { projectRoot }
    );

    expect(artifact).not.toHaveProperty('strictAnalysisContext');
    expect(artifact.findings).toEqual([
      { finding: 'alpha constants are sequential', evidence: 'src/alpha.ts:12-13', importance: 8 },
    ]);
    expect(artifact.metadata).toMatchObject({ memoryFindingCount: 1, derivedFindingCount: 0 });
    // R1 锚点补读照常：窗口外锚点从磁盘补出逐字片段。
    expect(artifact.metadata.postHocLiveReadCount).toBeGreaterThan(0);
    const snippets = artifact.evidenceMap.get('src/alpha.ts')?.codeSnippets ?? [];
    expect(snippets.map((snippet) => snippet.content).join('\n')).toContain(
      'export const alpha11 = 11;'
    );
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('strict analysis context'))
    ).toEqual([]);
  });

  it('derives grounded findings from text when no memory finding exists', () => {
    const { warn } = spyLogs();
    const artifact = buildAnalysisArtifact(
      {
        reply: ['## 认证流程', '逻辑在 src/real/auth.ts 中分发。'].join('\n'),
        toolCalls: [readCall('src/real/auth.ts')],
      },
      'architecture',
      null,
      strictCarryingContext([])
    );

    expect(artifact).not.toHaveProperty('strictAnalysisContext');
    expect(artifact.metadata).toMatchObject({ memoryFindingCount: 0, derivedFindingCount: 1 });
    expect(artifact.findings).toEqual([
      { finding: '认证流程', evidence: 'src/real/auth.ts', importance: 6 },
    ]);
    expect(artifact.fullToolTrace).toHaveLength(1);
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('strict analysis context'))
    ).toEqual([]);
  });

  it('ignores a stray strictColdStart option from a JS caller instead of isolating or throwing', () => {
    spyLogs();
    // 旧实现：strictColdStart=true 时丢弃 legacy findings/工具轨迹，缺严格上下文还抛
    // STRICT_ANALYSIS_CONTEXT_REQUIRED。收口后该字段不再被读取，调用方得到普通 legacy 工件。
    const legacyOptions: Readonly<Record<string, unknown>> = { projectRoot, strictColdStart: true };
    const artifact = buildAnalysisArtifact(
      { reply: '## alpha\nsee src/alpha.ts:12-13', toolCalls: [readCall('src/alpha.ts')] },
      'architecture',
      null,
      {
        distill: () => ({
          keyFindings: [{ finding: 'alpha', evidence: 'src/alpha.ts:12-13', importance: 8 }],
          toolCallSummary: [],
        }),
      },
      legacyOptions as { projectRoot?: string }
    );
    expect(artifact.findings).toHaveLength(1);
    expect(artifact.fullToolTrace).toHaveLength(1);
    expect(artifact.analysisText).toContain('src/alpha.ts');
    expect(artifact).not.toHaveProperty('strictAnalysisContext');
  });
});

describe('source guards: the strict projection stays out of memory and the legacy artifact', () => {
  function sourceFilesUnder(relativeDir: string): string[] {
    const absolute = path.join(REPO_ROOT, relativeDir);
    return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => path.join(relativeDir, entry));
  }

  /** 读取源码中全部 import/export-from 的模块说明符（只看真实 AST，不受注释措辞影响）。 */
  function moduleSpecifiers(relativePath: string): string[] {
    const text = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
    const sourceFile = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    for (const statement of sourceFile.statements) {
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
    return specifiers;
  }

  it('keeps strictColdStart out of every production toolset', () => {
    const offenders = sourceFilesUnder('src/tools/runtime/toolsets').filter((file) =>
      readFileSync(path.join(REPO_ROOT, file), 'utf8').includes('strictColdStart')
    );
    expect(offenders).toEqual([]);
  });

  it('keeps memory and analysisArtifact free of production-layer imports', () => {
    const files = [
      ...sourceFilesUnder('src/agent/memory'),
      'src/agent/evaluation/analysisArtifact.ts',
    ];
    expect(files).toContain('src/agent/memory/ActiveContext.ts');
    expect(files).toContain('src/agent/memory/MemoryFlushContract.ts');
    const offenders = files.flatMap((file) =>
      moduleSpecifiers(file)
        .filter((specifier) => /(?:^|\/)production(?:\/|$)/u.test(specifier))
        .map((specifier) => `${file} -> ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });

  it('retires the strict-context error codes and the C45 mix diagnostic together with the branches', () => {
    const activeContext = readFileSync(
      path.join(REPO_ROOT, 'src/agent/memory/ActiveContext.ts'),
      'utf8'
    );
    const artifact = readFileSync(
      path.join(REPO_ROOT, 'src/agent/evaluation/analysisArtifact.ts'),
      'utf8'
    );
    for (const token of [
      'bindStrictAnalysisContext',
      'strictAnalysisContext',
      'STRICT_CONTEXT_SCHEMA_UNSUPPORTED',
      'STRICT_CONTEXT_HASH_MISMATCH',
    ]) {
      expect(activeContext).not.toContain(token);
    }
    for (const token of [
      'strictColdStart',
      'strictAnalysisContext',
      'STRICT_ANALYSIS_CONTEXT_REQUIRED',
      'reportStrictContextLegacyMix',
      'STRICT_CONTEXT_LEGACY_MIX_LOG_MESSAGE',
    ]) {
      expect(artifact).not.toContain(token);
    }
  });
});
