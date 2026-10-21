/**
 * 脱敏性能预算（用户决定 D13）：语料不超过现行规则（b60a61e）的 2.5 倍；对抗输入随输入线性增长。
 *
 * 门禁口径（总控决定，2026-10-21）：D13 的“阶段 4 对抗输入 ≤4×”是阶段 4 整体的验收口径，在 4f（关键字预过滤
 * 快路径 + processEvents 实例级 LRU）落地后验收；4a–4e 沿用阶段 1 的硬门禁（语料 ≤2.5× HEAD、对抗输入 ≤8×
 * 且线性），这里把 4× 作为目标值报告而不断言。追踪重放保留为运行时底线，不为门禁退回对齐路径；对齐 H⁺
 * 只作测试期 oracle 与自检失败时的回退，它的倍数一并报告。
 *
 * 阶段 4a 的对抗输入实测在回报 notes 里：每轮都要对四个冻结版本各算一次输出（自检）并至少跑两轮到不动点，
 * 仅这部分就是 HEAD 的 3–3.7 倍，所以 4× 需要 4f 压低热路径，不是本包能单独达到的。计时交错执行、取多次
 * 最小值，抵消并行测试带来的负载波动。样本全部是合成值。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';
import { applyAlignmentFloor } from '../src/agent/utils/redaction/legacyFloor.js';
import { redactDeveloperText as redactAtB60a61e } from './fixtures/redaction-baselines/redaction-at-b60a61e.js';

/** 阶段 1 的硬门禁；阶段 4 的 4× 目标见文件头与 notes。 */
const ADVERSARIAL_GATE = 8;
/** 阶段 4 设计目标，只报告不断言（本包达不到，原因见文件头）。 */
const STAGE4_TARGET = 4;

function alignmentFloor(text: string): string {
  return applyAlignmentFloor(text).text;
}

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

describe('performance budget (D13)', () => {
  test('source corpus stays within 2.5x of the current rules', ({ annotate }) => {
    const inputs = sourceFiles(path.join(repoRoot, 'src/agent')).map((file) =>
      readFileSync(file, 'utf8')
    );
    expect(inputs.length).toBeGreaterThan(50);
    interleavedBest(inputs.slice(0, 20), redactAtB60a61e, redactDeveloperText, 1);
    const timing = interleavedBest(inputs, redactAtB60a61e, redactDeveloperText, 5);
    void annotate(
      `corpus: tracked replay ${(timing.candidate / timing.baseline).toFixed(2)}x HEAD`
    );
    expect(timing.candidate / timing.baseline).toBeLessThanOrEqual(2.5);
  }, 120_000);

  test.for(ADVERSARIAL)(
    'adversarial $name stays within the gate and grows linearly',
    ({ build }, context) => {
      const small = build(2_000);
      const large = build(8_000);
      interleavedBest([small], redactAtB60a61e, redactDeveloperText, 1);
      const smallTiming = interleavedBest([small], redactAtB60a61e, redactDeveloperText, 7);
      const largeTiming = interleavedBest([large], redactAtB60a61e, redactDeveloperText, 7);
      const fallback = interleavedBest([large], redactAtB60a61e, alignmentFloor, 3);
      const ratio = largeTiming.candidate / largeTiming.baseline;
      void context.annotate(
        `adversarial: tracked replay ${ratio.toFixed(2)}x HEAD (stage-4 target ${STAGE4_TARGET}x, gate ${ADVERSARIAL_GATE}x); alignment fallback ${(fallback.candidate / fallback.baseline).toFixed(2)}x`
      );
      expect(ratio).toBeLessThanOrEqual(ADVERSARIAL_GATE);
      // 输入放大 4 倍，耗时应近似放大 4 倍；留出噪声余量，但远低于平方级的 16 倍。
      expect(largeTiming.candidate / smallTiming.candidate).toBeLessThanOrEqual(7);
    },
    180_000
  );
});
