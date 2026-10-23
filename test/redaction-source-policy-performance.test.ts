/**
 * 脱敏阶段 4e 的性能门禁：带来源上下文的台账入口 redactDeveloperTextInContext（复查意见：T3 终端 env 规则在
 * 对抗输入上是平方级，旧门禁只测了 redactDeveloperText，覆盖不到台账路径；第二轮复查：只取样了三种复查点名
 * 形态，T3 密集命中、走合并路径的形态没有测到，合并路径相对门面多出 3.8–5.7 个 HEAD）。
 *
 * 口径（总控裁定，2026-10-22，在用户已批准的 D13 内，与对 4a 的裁定同一原则）：
 * - 4f 之前，门面 redactDeveloperText 继续断言阶段 1 硬门禁（语料 ≤2.5×、对抗 ≤8× 且线性），见
 *   test/redaction-floor-performance.test.ts；D13 的“阶段 4 对抗 ≤4×”在 4f 统一验收，范围包括门面与台账入口。
 * - 台账入口断言三项：(a) 全部 T3 密集形态线性（输入放大 4 倍、耗时放大 ≤7 倍，远低于平方级的 16 倍）；
 *   (b) 相对门面（同一输入的 redactDeveloperText）的额外开销 ≤ EXTRA_GATE = 5 个 HEAD；(c) 第一轮版本部分复用、
 *   合并路径不重做整轮，由 test/redaction-source-policy-replay-share.test.ts 在模块边界计数确定性钉住。
 * - curl -v 头与混合载体这类台账入口总倍数在 8× 上下的形态（门面本身已是 6–7 倍 HEAD，结构下限见 EXTRA_GATE）只报告
 *   不断言，复查不以台账入口总倍数 >8× 判阻塞。其余形态（复查点名的三种、门面留有余量的密集形态）仍断言 ≤8×，
 *   作为回退保护保留（实测最高约 6.8×，不是裁定新增的要求）。
 * - 扫描器本身（detectSourcePolicySpans）在全部对抗形态上 4 倍输入耗时 ≤7 倍。
 * 计时交错执行、取多次最小值，抵消并行负载的波动。样本全部是合成值。
 */
import { describe, expect, test } from 'vitest';
import { redactDeveloperText, redactDeveloperTextInContext } from '../src/agent/utils/Redaction.js';
import {
  detectSourcePolicySpans,
  type RedactionSourceContext,
  sourcePolicyRulesFor,
} from '../src/agent/utils/redaction/sourcePolicy.js';
import { redactDeveloperText as redactAtB60a61e } from './fixtures/redaction-baselines/redaction-at-b60a61e.js';

/** 阶段 1 的硬门禁（相对 HEAD）。 */
const ADVERSARIAL_GATE = 8;
/** 4 倍输入的耗时放大上限（线性约 4 倍，平方级约 16 倍）。 */
const GROWTH_GATE = 7;
/**
 * 带来源调用相对未知来源门面的额外开销上限（以同一输入上 HEAD 的耗时为单位）。结构下限：不变量 A 按构造要求先跑完
 * 整的未知来源底线（即门面），合并路径再在原文上扫一遍 T3、按位置渲染一次，并对自己的输出确认一次不动点（四个
 * 冻结版本各跑一遍、T3 再扫一遍）——这一遍确认是幂等的保证，不能省。第一轮的整轮重放、位掩码、缺口与结构分析经
 * legacyFloor 的 replayShare 复用，不再重做（第二轮复查意见）；重做一轮在 curl -v 头上约 3–4 个 HEAD，会越过本上限。
 * 确认那一遍在输出与原文一样昂贵时（引号未闭合的 YAML：v2、v3 的每个 JSON 字面量都抛错）约 2.5 个 HEAD；HEAD 本身
 * 很便宜的形态（.env）里渲染与两遍扫描按 HEAD 计也会显得大。第二轮实测上限约 4.3 个 HEAD。
 * 原上限 3 是第一轮的估计，没有覆盖合并路径占主导的形态，第二轮复查实测被越过；总控已裁定取 5（2026-10-22）。
 */
const EXTRA_GATE = 5;

const CONTEXTS: Readonly<Record<'terminal' | 'secret-bearing', RedactionSourceContext>> = {
  terminal: { tool: 'terminal.exec' },
  'secret-bearing': { tool: 'code.read', file: 'deploy/.env' },
};

/** 交错测量两个实现在同一批输入上的耗时，各取最小值（毫秒）。 */
function interleavedBest(
  inputs: readonly string[],
  baseline: (text: string) => unknown,
  candidate: (text: string) => unknown,
  rounds: number
): { baseline: number; candidate: number } {
  const [baselineBest = 0, candidateBest = 0] = bestOf(inputs, [baseline, candidate], rounds);
  return { baseline: baselineBest, candidate: candidateBest };
}

/** 交错测量多个实现（每轮依次各跑一遍），各取最小值（毫秒）。 */
function bestOf(
  inputs: readonly string[],
  implementations: ReadonlyArray<(text: string) => unknown>,
  rounds: number
): number[] {
  const best = implementations.map(() => Number.POSITIVE_INFINITY);
  for (let round = 0; round < rounds; round++) {
    for (const [slot, implementation] of implementations.entries()) {
      const started = performance.now();
      for (const input of inputs) {
        implementation(input);
      }
      best[slot] = Math.min(best[slot] ?? Number.POSITIVE_INFINITY, performance.now() - started);
    }
  }
  return best;
}

/** 复查点名的三种形态（同一行、没有空白或 ;&|) 引号隔开的敏感 KEY=）。 */
const REVIEW_SHAPES: ReadonlyArray<{ name: string; build: (count: number) => string }> = [
  { name: 'chained KEY=', build: (count) => 'A_TOKEN='.repeat(count) },
  { name: 'comma separated', build: (count) => 'a_token=x,'.repeat(count) },
  { name: 'minified js', build: (count) => 'e.key=t,'.repeat(count) },
];

const PEM_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCSYNTHETICPEMONEAAAAAAAAAAAAAAAAA';

/** 阶段 1 门禁的三种对抗形态（redaction-floor-performance），这里走带来源的入口。 */
const FLOOR_SHAPES: ReadonlyArray<{ name: string; build: (count: number) => string }> = [
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

/**
 * T3 密集命中的形态（复查意见：合并路径占主导，旧门禁只取样了三种复查点名形态与阶段 1 形态）：几乎每一行都有
 * T3 命中，走合并路径。上下文按各形态的真实来源给出；count 为行数（大输入与阶段 1 门禁同一规模）。
 */
const DENSE_SHAPES: ReadonlyArray<{
  name: string;
  context: RedactionSourceContext;
  build: (count: number) => string;
  /** false：门面本身已接近 8 倍，台账入口总倍数只报告（总控裁定，见文件头）。 */
  totalGate: boolean;
}> = [
  {
    name: 'curl -v headers',
    context: { tool: 'terminal.exec' },
    totalGate: false,
    build: (count) =>
      Array.from({ length: count }, (_, index) =>
        index % 2 === 0 ? `> Authorization: Bearer t${index}` : `< Set-Cookie: s=${index}; Path=/`
      ).join('\n'),
  },
  {
    name: 'kubectl get secret -o yaml',
    context: { tool: 'terminal.exec' },
    totalGate: true,
    build: (count) =>
      `apiVersion: v1\ndata:\n${Array.from(
        { length: count },
        (_, index) => `  k${index}: U1lOVEhFVElD${index}==`
      ).join('\n')}\nkind: Secret\ntype: Opaque`,
  },
  {
    name: 'secrets.yaml with open quotes',
    context: { tool: 'code.read', file: 'deploy/secrets.yaml' },
    totalGate: true,
    build: (count) =>
      `apiVersion: v1\ndata:\n${Array.from({ length: count }, (_, index) => `  k${index}: "v${index}`).join('\n')}\nkind: Secret`,
  },
  {
    name: '.env file',
    context: { tool: 'code.read', file: 'deploy/.env' },
    totalGate: true,
    build: (count) =>
      Array.from({ length: count }, (_, index) => `KEY_${index}=value${index}`).join('\n'),
  },
  {
    name: 'env dump',
    context: { tool: 'terminal.exec' },
    totalGate: true,
    build: (count) =>
      Array.from({ length: count }, (_, index) => `SVC_TOKEN_${index}=tok${index}x`).join('\n'),
  },
  {
    name: 'mixed carrier (terminal)',
    context: { tool: 'terminal.exec' },
    totalGate: false,
    build: (count) => FLOOR_SHAPES[1]?.build(count) ?? '',
  },
  {
    name: 'mixed carrier (secret-bearing)',
    context: { tool: 'code.read', file: 'deploy/.env' },
    totalGate: false,
    build: (count) => FLOOR_SHAPES[1]?.build(count) ?? '',
  },
];

/** 扫描器的对抗形态（字符数约为 size）。 */
const SCANNER_SHAPES: ReadonlyArray<{ name: string; build: (size: number) => string }> = [
  ...REVIEW_SHAPES.map(({ name, build }) => ({ name, build: (size: number) => build(size / 8) })),
  { name: 'escaped quote leads', build: (size) => '\\"a_token=x'.repeat(size / 11) },
  {
    name: 'netrc quoted passwords',
    build: (size) => 'machine h login u '.concat('password "x '.repeat(size / 12)),
  },
  { name: 'spaced env pairs', build: (size) => 'X '.concat('TOKEN=v '.repeat(size / 8)) },
  { name: 'json strings', build: (size) => `{${'"k":"v",'.repeat(size / 9)}}` },
];

const CONTEXT_CASES = Object.keys(CONTEXTS) as Array<keyof typeof CONTEXTS>;

describe('source policy performance (D13 gates on the ledger entry)', () => {
  test.for(REVIEW_SHAPES.flatMap((shape) => CONTEXT_CASES.map((source) => ({ ...shape, source }))))(
    '$name in $source context stays within the gate and grows linearly',
    ({ build, source }, context) => {
      const redact = (text: string) => redactDeveloperTextInContext(text, CONTEXTS[source]);
      const small = build(3_200);
      const large = build(12_800);
      interleavedBest([small], redactAtB60a61e, redact, 1);
      const smallTiming = interleavedBest([small], redactAtB60a61e, redact, 7);
      const largeTiming = interleavedBest([large], redactAtB60a61e, redact, 7);
      const ratio = largeTiming.candidate / largeTiming.baseline;
      const growth = largeTiming.candidate / smallTiming.candidate;
      void context.annotate(
        `${source}: ${ratio.toFixed(2)}x HEAD (gate ${ADVERSARIAL_GATE}x), 4x input -> ${growth.toFixed(2)}x time`
      );
      expect(ratio).toBeLessThanOrEqual(ADVERSARIAL_GATE);
      expect(growth).toBeLessThanOrEqual(GROWTH_GATE);
    },
    180_000
  );

  test.for(DENSE_SHAPES)(
    'dense T3 shape $name grows linearly (and stays within the gate where the facade leaves room)',
    ({ build, context: source, totalGate }, context) => {
      const redact = (text: string) => redactDeveloperTextInContext(text, source);
      const small = build(2_000);
      const large = build(8_000);
      interleavedBest([small], redactAtB60a61e, redact, 1);
      const smallTiming = interleavedBest([small], redactAtB60a61e, redact, 7);
      const largeTiming = interleavedBest([large], redactAtB60a61e, redact, 7);
      const ratio = largeTiming.candidate / largeTiming.baseline;
      const growth = largeTiming.candidate / smallTiming.candidate;
      void context.annotate(
        `${ratio.toFixed(2)}x HEAD (${totalGate ? `gate ${ADVERSARIAL_GATE}x` : 'reported only per the 2026-10-22 ruling; 4x accepted in RED-P4f'}), 4x input -> ${growth.toFixed(2)}x time`
      );
      if (totalGate) {
        expect(ratio).toBeLessThanOrEqual(ADVERSARIAL_GATE);
      }
      expect(growth).toBeLessThanOrEqual(GROWTH_GATE);
    },
    180_000
  );

  test.for(SCANNER_SHAPES)(
    'scanner: $name grows linearly',
    ({ build }, context) => {
      for (const source of CONTEXT_CASES) {
        const rules = sourcePolicyRulesFor(source);
        const detect = (text: string) => detectSourcePolicySpans(text, rules);
        const small = build(100_000);
        const large = build(400_000);
        bestOf([small, large], [detect], 1);
        const [smallBest = 0] = bestOf([small], [detect], 5);
        const [largeBest = 0] = bestOf([large], [detect], 5);
        // 小输入只有零点几毫秒时，计时分辨率与调度抖动会放大比值；以 1ms 为下限只放宽毫秒以下的噪声，
        // 平方级在这个规模上是数秒，不受影响。
        const growth = largeBest / Math.max(smallBest, 1);
        void context.annotate(
          `${source}: ${smallBest.toFixed(2)}ms -> ${largeBest.toFixed(2)}ms (${growth.toFixed(2)}x)`
        );
        expect(growth, source).toBeLessThanOrEqual(GROWTH_GATE);
      }
    },
    180_000
  );

  test.for([
    ...[
      ...REVIEW_SHAPES.map((shape) => ({ ...shape, count: 12_800 })),
      // 与阶段 1 门禁的大输入同一规模。
      ...FLOOR_SHAPES.map((shape) => ({ ...shape, count: 8_000 })),
    ].flatMap((shape) =>
      CONTEXT_CASES.map((source) => ({ ...shape, source, scoped: CONTEXTS[source] }))
    ),
    ...DENSE_SHAPES.map((shape) => ({
      ...shape,
      count: 8_000,
      source: 'dense',
      scoped: shape.context,
    })),
  ])(
    '$name in $source context adds bounded overhead over the unknown-source facade',
    ({ build, source, scoped, count }, context) => {
      const redact = (text: string) => redactDeveloperTextInContext(text, scoped);
      const input = build(count);
      bestOf([input], [redactAtB60a61e, redactDeveloperText, redact], 1);
      // 9 轮取最小：HEAD 很便宜的形态（.env）上几毫秒的调度抖动按 HEAD 计会放大成一个以上的单位。
      const [head = 0, facade = 0, ledger = 0] = bestOf(
        [input],
        [redactAtB60a61e, redactDeveloperText, redact],
        9
      );
      const extra = (ledger - facade) / head;
      void context.annotate(
        `${source}: ledger entry ${(ledger / head).toFixed(2)}x HEAD, facade ${(facade / head).toFixed(2)}x HEAD, extra ${extra.toFixed(2)} HEAD (gate ${EXTRA_GATE})`
      );
      expect(extra).toBeLessThanOrEqual(EXTRA_GATE);
    },
    180_000
  );
});
