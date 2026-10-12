import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * tools/runtime 注释的事实守卫（L4-P1：I29 注释漂移；L4-P38：I47 intent 经执行端口透传）。
 *
 * 与 tool-contract-comments.test.ts 同一套思路：一是锁住已证伪的旧说法不回流到注释；
 * 二是核对注释里陈述的“当前事实”在源码里仍然成立。第二类失败说明调用链变了，
 * 应同步改注释，而不是放宽这里的断言去迁就旧注释。这些用例不触碰任何运行行为。
 */

const repoRoot = process.cwd();

function readSource(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function walkSource(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSource(filePath, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(filePath);
    }
  }
  return acc;
}

function sourceFiles(): Array<{ file: string; text: string }> {
  return walkSource(path.join(repoRoot, 'src')).map((filePath) => ({
    file: path.relative(repoRoot, filePath).split(path.sep).join('/'),
    text: readFileSync(filePath, 'utf8'),
  }));
}

/** 取紧挨在 `marker` 之前的那一个 JSDoc 块（不允许中间夹代码）。 */
function docBlockBefore(text: string, marker: string): string | null {
  const index = text.indexOf(marker);
  if (index < 0) {
    return null;
  }
  const head = text.slice(0, index).trimEnd();
  if (!head.endsWith('*/')) {
    return null;
  }
  const start = head.lastIndexOf('/**');
  return start < 0 ? null : head.slice(start);
}

/** 文件头第一个 JSDoc 块。 */
function headerBlock(text: string): string {
  const end = text.indexOf('*/');
  return end < 0 ? '' : text.slice(0, end + 2);
}

describe('tools/runtime comments describe current facts (L4-P1)', () => {
  it('registry header lists every place a new action must be synced, not "one line here"', () => {
    const text = readSource('src/tools/runtime/registry.ts');
    const header = headerBlock(text);
    expect(header).not.toContain('只需在此文件加一行');
    for (const place of [
      'handlers/',
      'availability.ts',
      'toolsets/',
      'toolSelection.ts',
      'phaseGates.ts',
      'test/',
    ]) {
      expect(header).toContain(place);
    }

    // 事实核对：可用性快照与阶段策略确实按动作名硬编码，新增动作不会自动进入这些表。
    const availability = readSource('src/tools/runtime/availability.ts');
    expect(availability).toMatch(/check\(\s*'knowledge',\s*'submit'/);
    const phaseGates = readSource('src/agent/runtime/toolPipeline/phaseGates.ts');
    expect(phaseGates).toMatch(/PRODUCER_KNOWLEDGE_ACTIONS = new Set\(\['submit'\]\)/);
    const meta = readSource('src/tools/runtime/handlers/meta.ts');
    expect(meta).toMatch(/default:\s*\n\s*return fail\(`Unknown meta action/);
  });

  it('dimension submit variant comment no longer claims the lightweight schema reaches the provider by reference', () => {
    const text = readSource('src/tools/runtime/registry.ts');
    const doc = docBlockBefore(text, 'export function applyDimensionSubmitSchemaVariant');
    expect(doc).not.toBeNull();
    expect(doc).not.toContain('按引用直达 provider');
    expect(doc).toContain('深拷贝');

    // 事实核对：两条投影路径都先深拷贝 action.params，变体自身也只改克隆。
    expect(text).toMatch(/const params = cloneJsonSchema\(action\.params\)/);
    expect(text).toMatch(
      /const clone = JSON\.parse\(JSON\.stringify\(schema\)\) as Record<string, unknown>/
    );
    const selection = readSource('src/tools/runtime/selection.ts');
    expect(selection).toMatch(/JSON\.parse\(JSON\.stringify\(action\.params\)\)/);
  });

  it('recipeAuthoringGate names its symlink guard and the createOrStage write path', () => {
    const text = readSource('src/tools/runtime/handlers/recipeAuthoringGate.ts');
    expect(text).not.toContain('逐字节复刻 host 侧');
    expect(text).not.toMatch(/gateway\.create（/);
    expect(text).toContain('recipeGateway.createOrStage');
    expect(text).toContain('AlembicPlugin');
    const resolverDoc = docBlockBefore(text, 'export function createInProcessSourceRefResolver');
    expect(resolverDoc).not.toBeNull();
    expect(resolverDoc).toContain('符号链接');
    expect(resolverDoc).toContain('resolveProjectPath');

    // 事实核对（L4-P22）：resolver 经共享读取模块 sourceRange 取行，符号链接越界判定由该模块
    // 调用 resolveProjectPath 完成；三处消费方都从同一模块读取，不再各自切行。
    expect(text).toMatch(/from '\.\/knowledge\/sourceRange\.js'/);
    expect(text).toMatch(/readSourceRange\(projectRoot, \{/);
    expect(text).not.toMatch(/readFileSync/);
    const sourceRange = readSource('src/tools/runtime/handlers/knowledge/sourceRange.ts');
    expect(sourceRange).toMatch(/resolveProjectPath\(projectRoot, relative\)/);
    expect(sourceRange).toMatch(/content\.split\(\/\\r\?\\n\/\)/);
    for (const consumer of [
      'src/tools/runtime/handlers/recipeProductionAdapter.ts',
      'src/tools/runtime/handlers/knowledge/sources.ts',
    ]) {
      const consumerText = readSource(consumer);
      expect(consumerText).toMatch(/sourceRange\.js'/);
      expect(consumerText).not.toMatch(/readFileSync|realpathSync|\.split\('\\n'\)/);
    }
    const submission = readSource('src/tools/runtime/handlers/knowledge/submission.ts');
    expect(submission).toMatch(/gateway\.createOrStage\(/);
  });

  it('memory note_finding M3 comment matches the "file present means verified" rule', () => {
    const text = readSource('src/tools/runtime/handlers/memory.ts');
    expect(text).not.toContain('带 file+range 的条目（read 类采集）');
    expect(text).not.toMatch(/全为 search\/structure\/terminal 类引用的发现是"未核实线索"/);
    const m3 = text.slice(text.indexOf('M3（VERIFY 机械化）'));
    expect(text.indexOf('M3（VERIFY 机械化）')).toBeGreaterThanOrEqual(0);
    expect(m3.slice(0, 400)).toContain('文件归属');

    // 事实核对：判定代码仍是“有 file 即 verified”。
    expect(text).toMatch(/if \(entry\.file\) \{\s*verified = true;/);
  });

  it('buildEvidenceCandidatesHint carries its own E5 doc comment; no dangling doc block remains', () => {
    const text = readSource('src/tools/runtime/handlers/submitEvidenceExpansion.ts');
    const hintDoc = docBlockBefore(text, 'export function buildEvidenceCandidatesHint');
    expect(hintDoc).not.toBeNull();
    expect(hintDoc).toContain('INSUFFICIENT_EVIDENCE 拒绝反馈增强（E5）');

    const inferDoc = docBlockBefore(text, 'export function inferEvidenceRefsFromSources');
    expect(inferDoc).not.toBeNull();
    expect(inferDoc).toContain('拒收治理');
    expect(inferDoc).not.toContain('INSUFFICIENT_EVIDENCE');
    // 两个 JSDoc 块首尾相接即说明有一块悬空。
    expect(text).not.toMatch(/\*\/\s*\n\/\*\*/);
  });

  it('TerminalCommandAllowlist.intent comments describe the production forwarding chain truthfully', () => {
    const kernel = readSource('src/tools/kernel/registry.ts');
    const intentStart = kernel.indexOf('export interface TerminalCommandAllowlist');
    expect(intentStart).toBeGreaterThanOrEqual(0);
    const allowlistDecl = kernel.slice(
      kernel.lastIndexOf('/**', intentStart),
      kernel.indexOf('\n}', intentStart)
    );
    // 旧说法（仅声明、当前不执行）已证伪，不得回流；新说法写明生产入口、透传出口与宿主现状。
    expect(allowlistDecl).not.toContain('仅声明');
    expect(allowlistDecl).not.toContain('当前不执行');
    expect(allowlistDecl).toContain('bins');
    expect(allowlistDecl).toContain('opts.intent');
    expect(allowlistDecl).toContain('透传给宿主');
    expect(allowlistDecl).toContain('loopCtx.capabilities');
    expect(allowlistDecl).toContain('runtime.terminalIntent');
    expect(allowlistDecl).toContain('terminal_intent_not_enforced');
    // 宿主 SandboxExecutorBridge 目前不读 opts.intent：注释必须如实写出，不能宣称隔离已生效。
    expect(allowlistDecl).toContain('尚未读取');

    const sandboxDoc = docBlockBefore(kernel, '  sandboxExecutor?: unknown;');
    expect(sandboxDoc).not.toBeNull();
    expect(sandboxDoc).toContain('runtime.terminalIntent');
    expect(sandboxDoc).toContain('loopCtx.capabilities');
    expect(sandboxDoc).toContain('尚未读取');

    const evolution = readSource('src/tools/runtime/toolsets/Evolution.ts');
    const evolutionDoc = docBlockBefore(evolution, 'const EVOLUTION_READONLY_TERMINAL_ALLOWLIST');
    expect(evolutionDoc).not.toBeNull();
    expect(evolutionDoc).not.toContain('仅声明');
    expect(evolutionDoc).not.toContain('当前不执行');
    expect(evolutionDoc).toContain('opts.intent');
    expect(evolutionDoc).toContain('透传给宿主');
    expect(evolutionDoc).toContain('loopCtx.capabilities');
    expect(evolutionDoc).toContain('尚未读取');

    // 事实核对一：读取 allowlist intent 的代码只有两处——生产链路的 runtimeBridge（从
    // loopCtx.capabilities 投影）与 terminal handler（合并两个来源后交给执行器）。
    // 只看代码行：注释里提到 commandAllowlist.intent 不算读取。
    const codeOnly = (source: string) =>
      source
        .split('\n')
        .filter((line) => !/^\s*(?:\*|\/\*|\/\/)/.test(line))
        .join('\n');
    const intentReaders = sourceFiles()
      .filter(({ text: source }) =>
        /(?:[Aa]llowlist|ALLOWLIST)\??\.intent\b/.test(codeOnly(source))
      )
      .map(({ file }) => file)
      .sort();
    expect(intentReaders).toEqual([
      'src/agent/runtime/toolPipeline/runtimeBridge.ts',
      'src/tools/runtime/handlers/terminal.ts',
    ]);

    // 事实核对二：生产链路的每一跳都在。宿主的 ToolRouterAdapter 不带 capability，
    // intent 只能经 request.runtime 到达 handler。
    const bridge = codeOnly(readSource('src/agent/runtime/toolPipeline/runtimeBridge.ts'));
    expect(bridge).toMatch(/loopCtx\.capabilities \?\? \[\]\)\.map\(/);
    expect(bridge).toMatch(/mergeTerminalIntents\(declarations\)/);
    expect(bridge).toMatch(/\.\.\.\(terminalIntent \? \{ terminalIntent \} : \{\}\)/);
    const adapter = codeOnly(readSource('src/tools/runtime/adapter/ToolRouterAdapter.ts'));
    expect(adapter).toMatch(/\.\.\.\(request\.runtime \? \{ runtime: request\.runtime \} : \{\}\)/);
    const terminal = codeOnly(readSource('src/tools/runtime/handlers/terminal.ts'));
    expect(terminal).toMatch(
      /checkTerminalCommandAllowlist\(command, ctx\.commandAllowlist\.bins\)/
    );
    expect(terminal).toMatch(/resolveTerminalIntent\(ctx\)/);
    expect(terminal).toMatch(/intent: ctx\.runtime\?\.terminalIntent/);
    expect(terminal).toMatch(/intent: ctx\.commandAllowlist\?\.intent/);
    expect(terminal).toMatch(
      /executor\.exec\(command, \{\s*cwd,\s*projectRoot: ctx\.projectRoot,\s*timeout,\s*signal: ctx\.abortSignal,\s*\.\.\.\(intent \? \{ intent \} : \{\}\),\s*\}\)/
    );

    // 事实核对三：生产形态的行为覆盖存在（真实 pipeline + 不带 capability 的 adapter，断言执行器
    // 收到 opts.intent）。源码形状守卫只能定位调用链，到达性由该文件的行为测试证明。
    const productionTest = readSource('test/tool-pipeline-terminal-intent.test.ts');
    expect(productionTest).toContain(
      'new ToolRouterAdapter({ contextFactory: { create: () => toolContext } })'
    );
    expect(productionTest).toContain('createToolPipeline().execute(terminalCall(');
    expect(productionTest).toContain(
      "expect(calls[0]?.opts.intent).toEqual({ network: 'none', filesystem: 'read-only' });"
    );
  });

  it('terminal header no longer claims the token-budget truncation step belongs to this handler', () => {
    const text = readSource('src/tools/runtime/handlers/terminal.ts');
    const header = headerBlock(text);
    expect(header).not.toMatch(/OutputCompressor 压缩 → token budget 截断/);
    expect(header).toContain('enforceOutputLimit');

    // 事实核对：最终按 maxOutputTokens 截断的是 router.enforceOutputLimit。
    const router = readSource('src/tools/runtime/router.ts');
    expect(router).toMatch(/enforceOutputLimit\(result, action\.maxOutputTokens/);
  });
});
