import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * L7-P1（C54 / C30）注释与文档漂移守卫。
 *
 * 这些注释是维护者排查质量门、证据采集与跨仓哈希时的第一入口：注释说错调用链（activeContext
 * 来源、search 回执形态、Core 是否已导出规范哈希）会把人引到不存在的路径上。这里只钉住
 * 已核实的事实与仓库规则要求的兼容登记（消费方、原因、移除条件），不约束措辞细节。
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

/** 锚点之前若干行的文本（用于检查分支旁的行内兼容登记注释）。 */
function linesBefore(source: string, anchor: string, count: number): string {
  const anchorIndex = source.indexOf(anchor);
  expect(anchorIndex, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const lines = source.slice(0, anchorIndex).split('\n');
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

const EVALUATION_FILES = [
  'src/agent/evaluation/gateEvaluators.ts',
  'src/agent/evaluation/qualityGates.ts',
  'src/agent/evaluation/stageBuilders.ts',
];

describe('evaluation gate comments match the code they document (C54)', () => {
  it('keeps no truncated `@returns }` tags', () => {
    for (const file of EVALUATION_FILES) {
      expect(readSource(file), file).not.toMatch(/@returns\s*\}/u);
    }
  });

  it('documents insightGateEvaluator right above its definition, not above applyModuleCoverageGate', () => {
    const source = readSource('src/agent/evaluation/gateEvaluators.ts');
    // 两个 JSDoc 块首尾相接说明有一块被孤立（它描述的不是紧随其后的声明）。
    expect(source).not.toMatch(/\*\/\s*\/\*\*/u);

    const insightDoc = jsDocImmediatelyBefore(source, 'export function insightGateEvaluator(');
    expect(insightDoc).not.toBeNull();
    expect(insightDoc).toContain('PipelineStrategy');
    expect(insightDoc).toMatch(/@returns\s+\S/u);

    const coverageDoc = jsDocImmediatelyBefore(source, 'export function applyModuleCoverageGate<');
    expect(coverageDoc).not.toBeNull();
    expect(coverageDoc).not.toContain('包装函数');
  });

  it('names the real activeContext source for the scan quality gate', () => {
    const source = readSource('src/agent/evaluation/stageBuilders.ts');
    // 仓内没有 buildSystemContext：activeContext 由 SystemRunContextFactory.createSystemContext 创建，
    // trace 别名只是 PipelineStrategy 在缺失时的降级兜底（带 pipeline_context_warning 诊断）。
    expect(source).not.toContain('buildSystemContext');
    const gateComment = linesBefore(source, "name: 'quality_gate'", 12);
    expect(gateComment).toContain('SystemRunContextFactory');
    expect(gateComment).toContain('pipeline_context_warning');
  });

  it('reads the required Core groundedSignalCount without a defensive cast', () => {
    const source = readSource('src/agent/evaluation/qualityGates.ts');
    expect(source).not.toMatch(/as\s*\{\s*groundedSignalCount/u);
    expect(source).toContain('depthReview.groundedSignalCount');
  });
});

describe('EvidenceCollector comments match the current tool receipts (C54)', () => {
  const source = readSource('src/agent/evidence/EvidenceCollector.ts');

  it('names the TypeScript module in its header and drops the empty type-definition section', () => {
    const header = source.slice(0, source.indexOf('*/'));
    expect(header).toContain('EvidenceCollector.ts');
    expect(header).not.toContain('EvidenceCollector.js');
    expect(source).not.toContain('类型定义 (JSDoc)');
  });

  it('documents graphEvidence in the build() result', () => {
    const buildDoc = jsDocImmediatelyBefore(source, '  build() {');
    expect(buildDoc).not.toBeNull();
    expect(buildDoc).toContain('graphEvidence');
  });

  it('no longer claims the search handler returns a formatted string', () => {
    expect(source).not.toContain('data 就是这个格式化字符串');
    const parserDoc = jsDocImmediatelyBefore(source, 'function parseSearchOutputText(');
    expect(parserDoc).not.toBeNull();
    // 仓库规则：兼容代码必须登记消费方、原因与移除条件。
    for (const field of ['消费方', '原因', '移除条件']) {
      expect(parserDoc, field).toContain(field);
    }
  });

  it('registers the legacy zero-match text and batchResults branches', () => {
    const zeroMatchComment = linesBefore(source, '0 matches \\(showing 0\\)', 6);
    expect(zeroMatchComment).toContain('移除条件');
    const batchComment = linesBefore(source, 'if (Object.keys(batchResults).length > 0) {', 8);
    for (const field of ['消费方', '原因', '移除条件']) {
      expect(batchComment, field).toContain(field);
    }
  });
});

describe('strict hashCoreCanonical comment states the real Core export status (C30)', () => {
  it('names the Core public export and the reason the mirror is kept', () => {
    const source = readSource('src/agent/production/strict/primitives.ts');
    expect(source).not.toContain('Core 尚未从公开子路径导出');
    const doc = jsDocImmediatelyBefore(source, 'export function hashCoreCanonical(');
    expect(doc).not.toBeNull();
    expect(doc).toContain('@alembic/core/project-context-foundation');
    expect(doc).toContain('hashCanonicalJson');
    expect(doc).toContain('layer-contract');
    // 镜像与 Core 的已知差异必须写在注释里，迁移时才知道会变成 fail-closed。
    expect(doc).toContain('非有限数');
  });
});
