/**
 * 脱敏阶段 1 性能预算（用户决定 D13）：语料不超过现行规则（b60a61e）的 2.5 倍；对抗输入不超过 8 倍，
 * 并且随输入线性增长。计时交错执行、取多次最小值，抵消并行测试带来的负载波动。样本全部是合成值。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';
import { redactDeveloperText as redactAtB60a61e } from './fixtures/redaction-baselines/redaction-at-b60a61e.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 交错测量两个实现在同一批输入上的耗时，各取最小值（毫秒）。 */
function interleavedBest(
  inputs: readonly string[],
  baseline: (text: string) => string,
  candidate: (text: string) => string,
  rounds: number
): { baseline: number; candidate: number } {
  let baselineBest = Number.POSITIVE_INFINITY;
  let candidateBest = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round++) {
    let started = performance.now();
    for (const input of inputs) {
      baseline(input);
    }
    baselineBest = Math.min(baselineBest, performance.now() - started);
    started = performance.now();
    for (const input of inputs) {
      candidate(input);
    }
    candidateBest = Math.min(candidateBest, performance.now() - started);
  }
  return { baseline: baselineBest, candidate: candidateBest };
}

const PEM_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCSYNTHETICPEMONEAAAAAAAAAAAAAAAAA';

/** 对抗输入：每行都有只被早期版本遮住的值、载体混合写法、截断 PEM 后接敏感键。 */
const ADVERSARIAL: ReadonlyArray<{ name: string; build: (count: number) => string }> = [
  {
    name: 'legacy-only value on every line',
    build: (count) =>
      Array.from({ length: count }, (_, index) => `JWT_SECRET=!SYNTHETIC${index}pw`).join('\n'),
  },
  {
    name: 'mixed carrier',
    build: (count) =>
      JSON.stringify({
        stdout: Array.from(
          { length: count },
          (_, index) => `DB_PASSWORD=abc;x${index} token: Data${index}[1] https://u:p${index}@h/x`
        ).join('\n'),
      }),
  },
  {
    name: 'truncated PEM followed by a key',
    build: (count) =>
      Array.from(
        { length: count },
        (_, index) =>
          `// key ${index}\n-----BEGIN PRIVATE KEY-----\n${PEM_LINE}\npassword: SYNTHETIC${index}`
      ).join('\n'),
  },
];

describe('phase-1 performance budget (D13)', () => {
  test('source corpus stays within 2.5x of the current rules', () => {
    const inputs = sourceFiles(path.join(repoRoot, 'src/agent')).map((file) =>
      readFileSync(file, 'utf8')
    );
    expect(inputs.length).toBeGreaterThan(50);
    interleavedBest(inputs.slice(0, 20), redactAtB60a61e, redactDeveloperText, 1);
    const timing = interleavedBest(inputs, redactAtB60a61e, redactDeveloperText, 5);
    expect(timing.candidate / timing.baseline).toBeLessThanOrEqual(2.5);
  }, 120_000);

  test.each(ADVERSARIAL)('adversarial $name stays within 8x and grows linearly', ({ build }) => {
    const small = build(2_000);
    const large = build(8_000);
    interleavedBest([small], redactAtB60a61e, redactDeveloperText, 1);
    const smallTiming = interleavedBest([small], redactAtB60a61e, redactDeveloperText, 5);
    const largeTiming = interleavedBest([large], redactAtB60a61e, redactDeveloperText, 5);
    expect(largeTiming.candidate / largeTiming.baseline).toBeLessThanOrEqual(8);
    // 输入放大 4 倍，耗时应近似放大 4 倍；留出噪声余量，但远低于平方级的 16 倍。
    expect(largeTiming.candidate / smallTiming.candidate).toBeLessThanOrEqual(7);
  }, 120_000);
});
