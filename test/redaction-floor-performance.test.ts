/**
 * 脱敏性能预算（用户决定 D13）：语料不超过现行规则（b60a61e）的 2.5 倍；对抗输入随输入线性增长。
 *
 * 门禁口径（总控决定，2026-10-21）：D13 的“阶段 4 对抗输入 ≤4×”是阶段 4 整体的验收口径，在 4f（关键字预过滤
 * 快路径 + processEvents 实例级 LRU）落地后验收；4a–4e 沿用阶段 1 的硬门禁（语料 ≤2.5× HEAD、对抗输入 ≤8×
 * 且线性），这里把 4× 作为目标值报告而不断言。追踪重放保留为运行时底线，不为门禁退回对齐路径；对齐 H⁺
 * 只作测试期 oracle 与自检失败时的回退，它的倍数一并报告（只对阶段 1 的三种形态测，其余形态不报告）。
 *
 * 阶段 4a 的对抗输入实测在回报 notes 里：每轮都要对四个冻结版本各算一次输出（自检）并至少跑两轮到不动点，
 * 仅这部分就是 HEAD 的 3–3.7 倍，所以 4× 需要 4f 压低热路径，不是本包能单独达到的。计时交错执行、取多次
 * 最小值，抵消并行测试带来的负载波动。
 *
 * 阶段 4b 追加 T1 检测器的对抗形态（复查实测曾超线性）：单段长 eyJ 串、base64 / base64url 编码的 JSON 数组
 * （大量 eyJ 起点落在同一段里）、密集未闭合的 “:// {”、JSON stdout 里的未闭合 URL 花括号、密集 sig= 候选（有无
 * sv= 版本参数）、同一行大量未闭合 ${ 的认证头、共享尾段的嵌套 URL 花括号组。每种都断言相对 v3 ≤8× 且线性。
 * 第三轮复查追加：解码后形似 JSON 对象却不合法的链式 JWT 段与尾逗号 JSON（JWT 判定不再走 JSON.parse 的异常路径）、
 * 单个 Cookie 头或 Digest 头里的大量短值与 40 对 Cookie 的日志行（列表整段一个标记，输出不再膨胀）、开引号带不同
 * 个数反斜杠的 Digest 参数与 Cookie 值（闭引号走全文索引）。同样断言相对 v3 ≤8× 且线性。其中 Digest 反斜杠形态的
 * 倍数主要来自底线自身（无检测器时与 HEAD 相同，约 6–8×），检测器只占很小一部分。
 * “密集短凭据”一组按总控裁定（2026-10-22）推迟到 4f 验收：本包只报告倍数、断言线性，原因与裁定见 DEFERRED_TO_4F
 * 的注释。
 * 第四轮复查追加 URL 授权段里连续的已闭合花括号组（有无口令、每行一个只含四个组的 URL：断言相对 v3 ≤8× 且线性），
 * 四种写法另断言检测器相对无检测器底线的增量有界（CLOSED_URL_GROUPS）；口令由大量 ${A} 引用组成的写法底线自身就
 * 超过 8×，按总控裁定（2026-10-22）只断言线性与检测器增量、相对 v3 的倍数只报告，≤8× 与 ≤4× 在 RED-P4f 验收（原因
 * 见 FLOOR_DOMINATED 的注释）。样本全部是合成值。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';
import {
  applyAlignmentFloor,
  applyRedactionFloor,
} from '../src/agent/utils/redaction/legacyFloor.js';
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

function b64u(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** base64（或 base64url）编码的 JSON 数组：标准 base64 的 ASCII 正文里几乎没有 + 和 /，整段是一个长串，eyJ 起点密集。 */
function base64JsonArray(count: number, encoding: 'base64' | 'base64url'): string {
  const items = Array.from({ length: count }, (_, index) => ({
    id: index,
    name: `SYNTHETIC${index}`,
    ok: index % 2 === 0,
  }));
  return Buffer.from(JSON.stringify(items), 'utf8').toString(encoding);
}

interface AdversarialForm {
  name: string;
  build: (count: number) => string;
  /** 阶段 1 的三种形态另报告对齐回退的倍数。 */
  reportAlignment?: boolean;
}

/** 无检测器的底线（只供度量检测器的增量；生产门面总带默认检测器表）。 */
function floorWithoutDetectors(text: string): string {
  return applyRedactionFloor(text, { detectors: [] }).text;
}

// 第四轮复查阻塞形态：URL 授权段里连续的已闭合花括号组。
const CLOSED_BEFORE_PASSWORD: AdversarialForm = {
  name: 'closed brace groups before a URL password',
  build: (count) => `x://${'{}'.repeat(count * 2)}:pw@h`,
};
const CLOSED_WITHOUT_PASSWORD: AdversarialForm = {
  name: 'closed brace groups in a URL without a password',
  build: (count) => `x://${'{}'.repeat(count * 4)}`,
};
const DOLLAR_BRACE_PASSWORD: AdversarialForm = {
  name: 'URL password made of many dollar-brace references',
  build: (count) => `x://u:${['$', '{A}'].join('').repeat(count * 2)}@h`,
};
const FOUR_CLOSED_PER_LINE: AdversarialForm = {
  name: 'one URL with four closed brace groups per line',
  build: (count) => 'x://{}{}{}{}:pw@h\n'.repeat(count),
};

/**
 * 检测器相对底线的增量上限：有检测器的门面不超过无检测器底线的这个倍数。第四轮复查实测旧实现在连续闭合组上是
 * 底线的 4–10 倍（逐组的 Map 读写与对象分配），改为按位置下标的类型数组后约 1.1–1.5 倍。
 */
const DETECTOR_INCREMENT_GATE = 2;

/** 连续闭合组的四种写法：检测器自身的开销必须很小（相对无检测器的底线有界）。 */
const CLOSED_URL_GROUPS: readonly AdversarialForm[] = [
  CLOSED_BEFORE_PASSWORD,
  CLOSED_WITHOUT_PASSWORD,
  DOLLAR_BRACE_PASSWORD,
  FOUR_CLOSED_PER_LINE,
];

/**
 * 底线主导的形态（第四轮复查列出）：口令由大量 ${A} 引用组成的 URL。
 *
 * 口径（总控裁定 2026-10-22，在用户批准的 D13 内，与对 4a、4e、4b2 的裁定同一原则）：
 * - 本包只断言线性，相对 v3 的倍数只报告、不断言；
 * - 检测器自身的开销另由 CLOSED_URL_GROUPS 断言“有检测器的门面 ≤ 无检测器底线的 2 倍”（下面的用例同时核对每个
 *   底线主导形态都在那一组里，避免有形态绕过增量门禁）；
 * - 相对 v3 的 ≤8×（阶段 1 门禁）与 ≤4×（D13 的阶段 4 目标）一并在 RED-P4f 验收。
 *
 * 原因：v3 对这种输入只跑一遍便宜的 URL 正则（约 2 ns/字符），底线却要跑四个冻结版本与各自的追踪重放。四个版本的
 * frozenRedact 与 replayTracked 各约 6× v3，无检测器的底线已是 9–14.7× v3（复查实测上一包 dbc078f 的底线为
 * 11.8–14.5×），检测器在其上的增量约 1.3×。超出来自底线自身、与检测器无关，压低底线开销属于 4f 的范围。
 */
const FLOOR_DOMINATED: readonly AdversarialForm[] = [DOLLAR_BRACE_PASSWORD];

/** 对抗输入：每行都有只被早期版本遮住的值、载体混合写法、截断 PEM 后接敏感键，以及 T1 检测器的密集候选形态。 */
const ADVERSARIAL: readonly AdversarialForm[] = [
  {
    name: 'legacy-only value on every line',
    reportAlignment: true,
    build: (count) =>
      Array.from({ length: count }, (_, index) => `JWT_SECRET=!SYNTHETIC${index}pw`).join('\n'),
  },
  {
    name: 'mixed carrier',
    reportAlignment: true,
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
    reportAlignment: true,
    build: (count) =>
      Array.from(
        { length: count },
        (_, index) =>
          `// key ${index}\n-----BEGIN PRIVATE KEY-----\n${PEM_LINE}\npassword: SYNTHETIC${index}`
      ).join('\n'),
  },
  { name: 'single long eyJ run', build: (count) => ['ey', 'J'].join('').repeat(count * 3) },
  { name: 'base64 JSON array', build: (count) => base64JsonArray(count / 4, 'base64') },
  { name: 'base64url JSON array', build: (count) => base64JsonArray(count / 4, 'base64url') },
  { name: 'dense unclosed :// {', build: (count) => 'a://{'.repeat(count * 2) },
  {
    name: 'JSON stdout with unclosed URL braces',
    build: (count) =>
      JSON.stringify({
        stdout: Array.from({ length: count }, (_, index) => `u${index}=http://{h${index}`).join(
          ', '
        ),
      }),
  },
  { name: 'dense sig= without sv=', build: (count) => '?sig=abcdefgh'.repeat(count) },
  { name: 'dense sig= with sv=', build: (count) => '&sv=2020&sig=abcdefgh'.repeat(count) },
  {
    name: 'many unclosed dollar-brace groups in Authorization headers',
    build: (count) => ['Authorization: Bearer x$', '{'].join('').repeat(count),
  },
  {
    name: 'nested URL brace groups sharing one tail',
    build: (count) =>
      `${'x://{'.repeat(count)}${'}'.repeat(count)}:${'SYNTHETIC'.repeat(count / 8)}`,
  },
  // 第四轮复查阻塞形态（URL 授权段里连续的已闭合花括号组）：每个组的检测开销必须是常数、不分配对象、不按位置
  // 查 Map。有无口令、每行一个只含少量组的 URL 三种写法在这里断言；口令由大量 ${A} 引用组成的写法底线自身就超过
  // 8×，见 FLOOR_DOMINATED（只断言线性，≤8× 在 4f 验收）。四种写法的检测器增量另由 CLOSED_URL_GROUPS 断言。
  CLOSED_BEFORE_PASSWORD,
  CLOSED_WITHOUT_PASSWORD,
  FOUR_CLOSED_PER_LINE,
  // 第三轮复查阻塞形态（JWT 判定）：解码后以 { 开头、} 结尾却不是合法 JSON 的段，链式排列时每个候选都要判一次。
  {
    name: 'chained JWT-like segments that are not JSON',
    build: (count) => `${b64u('{"xx}')}.`.repeat(count * 2),
  },
  {
    name: 'JWT-like segments with trailing-comma JSON',
    build: (count) => `${b64u('{"a":1,}')}.${b64u('{"b":2,}')}.sig `.repeat(count),
  },
  // 第三轮复查阻塞形态（Cookie 与 auth-param 的密集短值）：逐值打标记会把输出放大约 4 倍，不动点轮在放大后的
  // 文本上重跑四个版本。
  {
    name: 'one Cookie header with many short values',
    build: (count) => `Cookie: ${'a=b; '.repeat(count * 2)}`,
  },
  {
    name: 'one Digest header with many short parameters',
    build: (count) => `Authorization: Digest ${'a=b,'.repeat(count * 2)}`,
  },
  {
    name: 'log lines with 40-pair Cookie headers',
    build: (count) =>
      Array.from(
        { length: count / 20 },
        (_, line) =>
          `Cookie: ${Array.from({ length: 40 }, (_, pair) => `c${pair}=v${line}`).join('; ')}`
      ).join('\n'),
  },
  // 第三轮复查阻塞形态（带引号的值找闭引号）：每个候选的开引号带不同个数的反斜杠，闭引号要找同样个数的反斜杠。
  {
    name: 'Digest values opened by varying backslash-quote runs',
    build: (count) =>
      Array.from(
        { length: count },
        (_, index) => `Authorization:Digest a=${'\\'.repeat(index % 80)}" `
      ).join(''),
  },
  {
    name: 'Cookie values opened by varying backslash-quote runs',
    build: (count) =>
      Array.from({ length: count }, (_, index) => `Cookie:a=${'\\'.repeat(index % 80)}" `).join(''),
  },
];

/**
 * 推迟到 4f 验收的“密集短凭据”形态（总控裁定 2026-10-22，在用户批准的 D13 内，与对 4a、4e 的裁定同一原则）：
 * 本包只报告倍数、断言线性；降到 ≤4× 的验收放在 4f（关键字预过滤快路径 + processEvents 实例级缓存）。
 * 形态：每 10–12 个字符就有一个只被检测器遮住的短凭据（逐行的 Cookie / Set-Cookie 头、截断的前缀 token、同一
 * URL 里大量 sig=）。检测本身是线性的，自身只占 v3 的 1.2–2.9 倍；超出来自不动点轮：渲染后每个短凭据都换成封闭
 * 词表里带关键字的标记（[redacted-token]、[redacted-api-key]，设计 4.6 规定），四个冻结版本要在这样的输出上重跑
 * 一遍，v3 的关键字前瞻在每个标记上都会回溯，单这一轮就是 v3 处理输入的 3.5–5 倍，四个版本两轮合计已是 5–7 倍。
 * 不采用的做法（裁定一并否决）：改用 [redacted] 标记（违反设计 4.6 的标记分配）、按密度合并区间（放宽误伤棘轮）。
 * 这一组之外已断言 ≤8× 的形态保持断言（包括 ADVERSARIAL 里的 “dense sig= with sv=”）。接近真实的形态（每行一个
 * 32 位十六进制的会话 cookie）在 4× 左右，列在最后作对照。
 */
const DEFERRED_TO_4F: readonly AdversarialForm[] = [
  { name: 'one short Cookie header per line', build: (count) => 'Cookie: a=b\n'.repeat(count * 2) },
  {
    name: 'short Cookie headers glued by commas',
    build: (count) => 'Cookie:a=b,'.repeat(count * 2),
  },
  {
    name: 'one short Set-Cookie header per line',
    build: (count) => 'Set-Cookie: a=b\n'.repeat(count * 2),
  },
  {
    name: 'truncated prefixed tokens, one per line',
    build: (count) => `${['gh', 'p_'].join('')}abcd...\n`.repeat(count * 2),
  },
  {
    name: 'truncated prefixed tokens with an ellipsis',
    build: (count) => `${['gh', 'p_'].join('')}abcd\u2026\n`.repeat(count * 2),
  },
  {
    name: 'one sv= and many sig= in one URL',
    build: (count) => `?sv=2020${'&sig=abcdefgh'.repeat(count * 2)}`,
  },
  {
    name: 'session cookie per line (realistic control)',
    build: (count) =>
      Array.from(
        { length: count / 2 },
        (_, index) => `Cookie: sid=${(index * 2_654_435_761).toString(16).padStart(32, '0')}`
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
    ({ build, reportAlignment }, context) => {
      const small = build(2_000);
      const large = build(8_000);
      interleavedBest([small], redactAtB60a61e, redactDeveloperText, 1);
      const smallTiming = interleavedBest([small], redactAtB60a61e, redactDeveloperText, 7);
      const largeTiming = interleavedBest([large], redactAtB60a61e, redactDeveloperText, 7);
      const ratio = largeTiming.candidate / largeTiming.baseline;
      const fallback =
        reportAlignment === true
          ? interleavedBest([large], redactAtB60a61e, alignmentFloor, 3)
          : null;
      void context.annotate(
        `adversarial: tracked replay ${ratio.toFixed(2)}x HEAD (stage-4 target ${STAGE4_TARGET}x, gate ${ADVERSARIAL_GATE}x)${fallback === null ? '' : `; alignment fallback ${(fallback.candidate / fallback.baseline).toFixed(2)}x`}`
      );
      expect(ratio).toBeLessThanOrEqual(ADVERSARIAL_GATE);
      // 输入放大 4 倍，耗时应近似放大 4 倍；留出噪声余量，但远低于平方级的 16 倍。
      expect(largeTiming.candidate / smallTiming.candidate).toBeLessThanOrEqual(7);
    },
    180_000
  );

  test.for(CLOSED_URL_GROUPS)(
    'closed URL brace groups: $name keeps the detector increment over the floor bounded',
    ({ build }, context) => {
      const large = build(8_000);
      interleavedBest([large], floorWithoutDetectors, redactDeveloperText, 1);
      const timing = interleavedBest([large], floorWithoutDetectors, redactDeveloperText, 7);
      const increment = timing.candidate / timing.baseline;
      void context.annotate(
        `detector increment: ${increment.toFixed(2)}x the floor without detectors (gate ${DETECTOR_INCREMENT_GATE}x)`
      );
      expect(increment).toBeLessThanOrEqual(DETECTOR_INCREMENT_GATE);
    },
    180_000
  );

  test.for(FLOOR_DOMINATED)(
    'floor-dominated: $name grows linearly (ratio to v3 reported only)',
    ({ name, build }, context) => {
      // 底线主导形态的检测器开销必须仍受增量门禁约束（裁定要求两者同时断言）。
      expect(CLOSED_URL_GROUPS.map((form) => form.name)).toContain(name);
      const small = build(2_000);
      const large = build(8_000);
      interleavedBest([small], redactAtB60a61e, redactDeveloperText, 1);
      const smallTiming = interleavedBest([small], redactAtB60a61e, redactDeveloperText, 7);
      const largeTiming = interleavedBest([large], redactAtB60a61e, redactDeveloperText, 7);
      const floor = interleavedBest([large], redactAtB60a61e, floorWithoutDetectors, 7);
      void context.annotate(
        `floor-dominated: tracked replay ${(largeTiming.candidate / largeTiming.baseline).toFixed(2)}x HEAD; floor without detectors ${(floor.candidate / floor.baseline).toFixed(2)}x HEAD (floor-dominated: gate ${ADVERSARIAL_GATE}x and target ${STAGE4_TARGET}x accepted in RED-P4f)`
      );
      expect(largeTiming.candidate / smallTiming.candidate).toBeLessThanOrEqual(7);
    },
    180_000
  );

  test.for(DEFERRED_TO_4F)(
    'deferred to 4f: $name grows linearly (ratio reported only)',
    ({ build }, context) => {
      const small = build(2_000);
      const large = build(8_000);
      interleavedBest([small], redactAtB60a61e, redactDeveloperText, 1);
      const smallTiming = interleavedBest([small], redactAtB60a61e, redactDeveloperText, 7);
      const largeTiming = interleavedBest([large], redactAtB60a61e, redactDeveloperText, 7);
      const ratio = largeTiming.candidate / largeTiming.baseline;
      void context.annotate(
        `deferred to 4f: tracked replay ${ratio.toFixed(2)}x HEAD (gate ${ADVERSARIAL_GATE}x not asserted in 4b; ${STAGE4_TARGET}x accepted in 4f)`
      );
      expect(largeTiming.candidate / smallTiming.candidate).toBeLessThanOrEqual(7);
    },
    180_000
  );
});
