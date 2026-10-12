import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 工具契约注释的事实守卫（L3-P05）。
 *
 * 这些用例只锁两类东西：一是已证伪的旧说法不能回流到注释里；二是注释里陈述的
 * “当前事实”在源码中仍然成立。后者一旦失败，说明调用链变了，需要同步改注释，
 * 而不是改这里的断言去迁就旧注释。
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

describe('tool contract comments describe current facts', () => {
  it('UnifiedToolCatalog header drops the GovernanceEngine/ToolRouter claims and token ratios', () => {
    const text = readSource('src/tools/catalog/UnifiedToolCatalog.ts');
    // 三个仓库里都不存在 GovernanceEngine；ToolRouter 也不读取任何 catalog。
    expect(text).not.toContain('GovernanceEngine');
    expect(text).not.toMatch(/保持对\s*`?ToolRouter`?\s*的兼容/);
    // 未经测量的 token 节省比例不能写成事实。
    expect(text).not.toMatch(/~?\d+\s*-\s*\d+%/);
    // toToolSchemasForModel 是新增的包装方法，不是父类方法的覆盖。
    expect(text).not.toContain("Override parent's toToolSchemas");
    expect(text).toContain('Dashboard/Skill manifest');

    // 事实核对：runtime router 不依赖 catalog；setRouter 在 src 中没有调用方。
    const routerText = readSource('src/tools/runtime/router.ts');
    expect(routerText).not.toMatch(/\b(UnifiedToolCatalog|CapabilityCatalog)\b/);
    const setRouterCallers = sourceFiles()
      .filter(({ file }) => file !== 'src/tools/catalog/UnifiedToolCatalog.ts')
      .filter(({ text: source }) => /\.setRouter\s*\(/.test(source))
      .map(({ file }) => file);
    expect(setRouterCallers).toEqual([]);
  });

  it('request.ts names ToolRouterAdapter as the only ToolRouterContract implementation', () => {
    const text = readSource('src/tools/kernel/request.ts');
    expect(text).not.toContain('host-surface router');
    expect(text).toContain('当前唯一实现是 ToolRouterAdapter');

    const implementers = sourceFiles()
      .filter(({ text: source }) => /\bimplements\b[^{]*\bToolRouterContract\b/.test(source))
      .map(({ file }) => file);
    expect(implementers).toEqual(['src/tools/runtime/adapter/ToolRouterAdapter.ts']);
  });

  it('ToolRouterAdapter no longer claims the presenter default projection runs on this path', () => {
    const text = readSource('src/tools/runtime/adapter/ToolRouterAdapter.ts');
    expect(text).not.toContain('仍由 presenter 的默认投影执行');
    expect(text).toMatch(/presentToolResult\W{0,2}目前没有生产调用方/u);

    // 事实核对：presentToolResult 除定义外在 src 中没有调用方。
    const callers = sourceFiles()
      .filter(({ file }) => file !== 'src/tools/kernel/presenter.ts')
      .filter(({ text: source }) => /\bpresentToolResult\s*\(/.test(source))
      .map(({ file }) => file);
    expect(callers).toEqual([]);
  });

  it('manifest.ts marks execution/governance fields that nobody reads as descriptive only', () => {
    const text = readSource('src/tools/kernel/manifest.ts');
    expect(text).toContain('仅描述性');

    // 事实核对：这些字段在 src 中没有读取方；一旦有了读取方，就要把它移到“实际消费”清单。
    const descriptiveRead =
      /\.(execution|governance|risk)\??\.(timeoutMs|maxOutputBytes|abortMode|artifactMode|adapter|approvalPolicy|allowedRoles|allowInComposer|allowInNonInteractive|gatewayAction|gatewayResource|requiresHumanConfirmation|owaspTags|dataAccess)\b/;
    // 只看接触 manifest 类型或 getManifest 的文件：其他模块里同名的 execution.timeoutMs
    // （例如 AgentService 的运行输入）与能力清单无关。
    const touchesManifest =
      /\b(ToolCapabilityManifest|ToolExecutionProfile|ToolGovernanceProfile|ToolRiskProfile|ToolDefinition|getManifest)\b/;
    const readers = sourceFiles()
      .filter(({ file }) => file !== 'src/tools/kernel/manifest.ts')
      .filter(({ text: source }) => touchesManifest.test(source) && descriptiveRead.test(source))
      .map(({ file }) => file);
    expect(readers).toEqual([]);
  });

  it('ToolResultMeta states that ok is a legacy marker and resultStatus wins', () => {
    const text = readSource('src/tools/kernel/registry.ts');
    const metaStart = text.indexOf('export interface ToolResultMeta');
    const resultStart = text.indexOf('export interface ToolResult {');
    expect(metaStart).toBeGreaterThan(0);
    expect(resultStart).toBeGreaterThan(metaStart);
    // ToolResultMeta 前的 JSDoc 加上类型本体都算“该类型的注释范围”。
    const commentWindow = text.slice(Math.max(0, metaStart - 800), resultStart);
    expect(commentWindow).toContain('ok 是旧兼容标记');
    expect(commentWindow).toContain('以 resultStatus 为准');
  });
});
