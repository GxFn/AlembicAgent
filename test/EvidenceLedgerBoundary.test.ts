/**
 * 证据台账 PCV 边界测试（Wave A E1，用户约束 2026-07-04）：
 * PCV 是测试辅助——主线证据模块（src/agent/evidence/**、utils/Redaction）不得 import
 * 任何 Pcv* 文件；台账只借鉴其 callId↔sourceRefs 链路概念。此测试是结构守卫，
 * 防止后续迭代把观察层文件重新渗入主线（R-2 解耦方向的第一道钉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('EvidenceLedger PCV 边界（主线零 Pcv 依赖）', () => {
  test('src/agent/evidence/** 与 utils/Redaction.ts 不含任何 Pcv 引用', () => {
    const files = [
      ...listTsFiles(path.join(repoRoot, 'src/agent/evidence')),
      path.join(repoRoot, 'src/agent/utils/Redaction.ts'),
    ];
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text.includes('Pcv'), `${path.relative(repoRoot, file)} 不得引用 Pcv*`).toBe(false);
    }
  });
});
