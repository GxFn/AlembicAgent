/**
 * 脱敏阶段 1 的零回退底线（设计 4.2 节不变量 S、附录 B）。
 *
 * 不变量 S：对任一输入 x、任一历史版本 v ∈ {246055e, 1b394ce, d113986, b60a61e}，凡 v(x) 遮住的非换行
 * 字符，最终输出也必须遮住。b60a61e 即现行规则（由调用方注入）；另外三个版本冻结在 frozenBaselines.ts。
 *
 * 做法：现行规则的输出 y3 是主渲染，代码一行不改；用夹逼对齐算出三个早期版本可能遮住的字符（超集）与
 * y3 一定遮住的字符（子集），二者之差就是残差，只在 y3 上补遮。补遮只会多遮，所以每一轮都满足 S；
 * 再迭代到不动点（≤8 轮），幂等由构造保证。
 *
 * 失败即关：
 * - 保留段放置不唯一、对不上或所在行可能被重编码时，整段（或整行）补遮；
 * - 补遮后在最终输出上重算残差（后置条件自检），仍不为空的行整行替换为 [redacted-unaligned]；
 * - 现行规则的输出换行不守恒（不应发生）时无法按行补遮，退回“每个非空行都替换为 [redacted-unaligned]”。
 * 这些路径都写进 FloorReport（只含计数与种类，不含正文），由有日志通道的调用方记录。
 *
 * 移除条件：阶段 4 冻结现行规则为 v3、改为追踪重放与按位置渲染后，本模块退为运行时自检的对照实现。
 */
import { redactAt1b394ce, redactAt246055e, redactAtD113986 } from './frozenBaselines.js';
import {
  type Alignment,
  alignToInput,
  type GapGroup,
  groupOuterRange,
  hiddenSuperset,
  isGuardedLine,
  type LinePlan,
  type LineTable,
  lexMarkers,
  type MarkerToken,
  narrowFor,
  splitLines,
  subsetFromAlignments,
} from './hiddenSpans.js';

export type CurrentRules = (text: string) => string;

export type LegacyBaselineId = '246055e' | '1b394ce' | 'd113986';

interface LegacyBaseline {
  id: LegacyBaselineId;
  redact: (text: string) => string;
  /** 是否会重编码 JSON 载体（决定是否启用非规范载体守卫）。 */
  reencodes: boolean;
}

const LEGACY_BASELINES: readonly LegacyBaseline[] = Object.freeze([
  { id: '246055e', redact: redactAt246055e, reencodes: false },
  { id: '1b394ce', redact: redactAt1b394ce, reencodes: false },
  { id: 'd113986', redact: redactAtD113986, reencodes: true },
]);

/** 不动点轮数上限：每轮只会遮得更多，触顶时 S 仍成立，只是不保证幂等，报告里标记 fixpoint-cap。 */
export const MAX_FLOOR_ROUNDS = 8;

/** 失败即关的整行标记，只用于后置条件自检失败与换行不守恒的兜底。 */
export const UNALIGNED_MARKER = '[redacted-unaligned]';

const PATCH_MARKER = '[redacted]';

export type FloorEventKind =
  | 'residual-patched'
  | 'whole-piece-mask'
  | 'absorbed-mask'
  | 'untrusted-line-mask'
  | 'wild-line-mask'
  | 'guarded-line'
  | 'newline-mismatch'
  | 'unaligned-line'
  | 'skeleton-fallback'
  | 'fixpoint-cap';

export interface FloorReport {
  /** 实际执行的 floor 轮数（含确认不动点的最后一轮）。 */
  rounds: number;
  fixpointReached: boolean;
  /** 各轮残差（需要补遮的输入字符）总数。 */
  residualChars: number;
  /** 残差按贡献它的历史版本拆分（同一字符可被多个版本计入）。 */
  residualByBaseline: Record<LegacyBaselineId, number>;
  /** 补遮后渲染出的新标记段数。 */
  patchedRuns: number;
  /** 保留段放置不唯一，整段补遮的次数。 */
  wholePieceMasks: number;
  /** 合成段吸收的引号、转义换行可能命中残差，一并遮住的次数。 */
  absorbedMasks: number;
  /** 现行规则可能重编码了非规范载体的行，整行补遮的次数。 */
  untrustedLineMasks: number;
  /** 现行规则输出对不上输入的行，整行补遮的次数。 */
  wildLineMasks: number;
  /** 非规范载体守卫在历史版本上命中的行数。 */
  guardedLines: number;
  /** 历史版本换行不守恒、退回整段对齐的次数（v1 在 JSON 引号值里吞换行属预期）。 */
  newlineMismatches: number;
  /** 后置条件自检失败、整行替换为 [redacted-unaligned] 的行数。 */
  unalignedLines: number;
  /** 现行规则输出换行不守恒、整篇退回骨架遮蔽的次数。 */
  skeletonFallbacks: number;
  /** 出现过的事件种类（去重、按首次出现排序）。 */
  kinds: FloorEventKind[];
}

export interface FloorResult {
  text: string;
  report: FloorReport;
}

function emptyReport(): FloorReport {
  return {
    rounds: 0,
    fixpointReached: false,
    residualChars: 0,
    residualByBaseline: { '246055e': 0, '1b394ce': 0, d113986: 0 },
    patchedRuns: 0,
    wholePieceMasks: 0,
    absorbedMasks: 0,
    untrustedLineMasks: 0,
    wildLineMasks: 0,
    guardedLines: 0,
    newlineMismatches: 0,
    unalignedLines: 0,
    skeletonFallbacks: 0,
    kinds: [],
  };
}

function note(report: FloorReport, kind: FloorEventKind): void {
  if (!report.kinds.includes(kind)) {
    report.kinds.push(kind);
  }
}

function anyMarked(marks: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    if (marks[index] === 1) {
      return true;
    }
  }
  return false;
}

/** 现行规则改写过、且带有非规范编码痕迹的行：这些行的保留段可能被重编码，对齐不可信。 */
function untrustedLinesOf(x: string, alignment: Alignment): Set<number> {
  const lines = new Set<number>();
  if (alignment.mode !== 'lines') {
    return lines;
  }
  for (const plan of alignment.plans) {
    if (isGuardedLine(x, plan, alignment, true)) {
      lines.add(plan.index);
    }
  }
  return lines;
}

function maskAbsorbed(mask: Uint8Array, group: GapGroup): void {
  for (const item of group.items) {
    if (item.kind === 'cont') {
      mask.fill(1, item.start, item.end);
    } else {
      mask.fill(1, item.start, item.coreStart);
      mask.fill(1, item.coreEnd, item.end);
    }
  }
}

function maskWholeLine(mask: Uint8Array, plan: LinePlan): void {
  for (const item of plan.line.items) {
    if (item.kind === 'tok') {
      mask.fill(1, item.start, item.coreStart);
      mask.fill(1, item.coreEnd, item.end);
    } else {
      mask.fill(1, item.start, item.end);
    }
  }
}

/**
 * 残差是否落在某个缺口可能覆盖的区间里。残差已扣掉“现行规则一定遮住”的字符，所以落在缺口里的残差
 * 只可能是：被吸收进合成段、实为原文保留的引号或转义换行；或放置有歧义的保留段（另由整段补遮处理）。
 * 不区分两者，一律把该组吸收的字符一并遮住，只会多遮。
 */
function residualTouchesGroup(residual: Uint8Array, plan: LinePlan, group: GapGroup): boolean {
  const [outerStart, outerEnd] = groupOuterRange(plan, group);
  return anyMarked(residual, outerStart, outerEnd);
}

/**
 * 在 y3 上补遮残差（附录 B 的 patchOnto）。保留段放置唯一时按偏移逐字符补遮；放置有歧义时，只要可能
 * 覆盖残差就整段补遮；行对不上或可能被重编码时整行补遮。残差落在缺口的吸收字符上时，把该组吸收的引号、
 * 转义换行一并遮住。只会多遮，不会让 y3 已遮住的字符重新露出。
 */
function patchOnto(
  y3: string,
  alignment: Alignment,
  residual: Uint8Array,
  untrusted: ReadonlySet<number>,
  report: FloorReport
): Uint8Array {
  const mask = new Uint8Array(y3.length);
  for (const plan of alignment.plans) {
    if (!anyMarked(residual, plan.xStart, plan.xEnd)) {
      continue;
    }
    if (plan.identical) {
      // 现行规则没动这一行：输出行与输入行逐字对应，按偏移补遮。
      for (let index = plan.xStart; index < plan.xEnd; index++) {
        if (residual[index] === 1) {
          mask[plan.line.start + (index - plan.xStart)] = 1;
        }
      }
      continue;
    }
    if (plan.wild || (untrusted.has(plan.index) && plan.pieces.length > 0)) {
      maskWholeLine(mask, plan);
      if (plan.wild) {
        report.wildLineMasks++;
        note(report, 'wild-line-mask');
      } else {
        report.untrustedLineMasks++;
        note(report, 'untrusted-line-mask');
      }
      continue;
    }
    for (let index = 0; index < plan.pieces.length; index++) {
      const piece = plan.pieces[index];
      const earliest = plan.earliest[index];
      const latest = plan.latest[index];
      if (piece === undefined || earliest === undefined || latest === undefined) {
        continue;
      }
      const length = piece.end - piece.start;
      if (earliest === latest) {
        for (let offset = 0; offset < length; offset++) {
          if (residual[earliest + offset] === 1) {
            mask[piece.start + offset] = 1;
          }
        }
      } else if (anyMarked(residual, earliest, latest + length)) {
        mask.fill(1, piece.start, piece.end);
        report.wholePieceMasks++;
        note(report, 'whole-piece-mask');
      }
    }
    for (const group of plan.groups) {
      if (residualTouchesGroup(residual, plan, group)) {
        maskAbsorbed(mask, group);
        report.absorbedMasks++;
        note(report, 'absorbed-mask');
      }
    }
  }
  return mask;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 渲染：被遮字符连成的段（触到已有核心标记时把整个标记并入，原子标记）换成一个 [redacted]；只由原有标记
 * 组成的段原样输出；裸换行从不被遮，所以行数守恒。被遮段切在代理对中间时扩到完整码点，只会多遮。
 */
function render(
  y3: string,
  tokens: readonly MarkerToken[],
  mask: Uint8Array,
  report: FloorReport,
  keep: number[] | null
): string {
  const core = new Uint8Array(y3.length);
  for (const token of tokens) {
    const coreStart = token.start + token.pre.length;
    core.fill(1, coreStart, coreStart + token.core.length);
  }
  for (let index = 0; index < y3.length; index++) {
    if (mask[index] !== 1) {
      continue;
    }
    const code = y3.charCodeAt(index);
    if (isHighSurrogate(code) && isLowSurrogate(y3.charCodeAt(index + 1))) {
      mask[index + 1] = 1;
    } else if (isLowSurrogate(code) && index > 0 && isHighSurrogate(y3.charCodeAt(index - 1))) {
      mask[index - 1] = 1;
    }
  }
  const parts: string[] = [];
  let index = 0;
  while (index < y3.length) {
    if (mask[index] !== 1 && core[index] !== 1) {
      let end = index;
      while (end < y3.length && mask[end] !== 1 && core[end] !== 1) {
        end++;
      }
      parts.push(y3.slice(index, end));
      if (keep !== null) {
        for (let from = index; from < end; from++) {
          keep.push(from);
        }
      }
      index = end;
      continue;
    }
    let end = index;
    let masked = false;
    while (end < y3.length && (mask[end] === 1 || core[end] === 1)) {
      masked = masked || mask[end] === 1;
      end++;
    }
    if (masked) {
      parts.push(PATCH_MARKER);
      report.patchedRuns++;
      if (keep !== null) {
        for (let offset = 0; offset < PATCH_MARKER.length; offset++) {
          keep.push(-1);
        }
      }
    } else {
      parts.push(y3.slice(index, end));
      if (keep !== null) {
        for (let from = index; from < end; from++) {
          keep.push(from);
        }
      }
    }
    index = end;
  }
  return parts.join('');
}

/**
 * 把指定行（按输入行号，换行守恒保证一一对应）整行替换为 [redacted-unaligned]。
 * keep 不为 null 时，同步改写逐字符来源（被替换的行记为 -1）。
 */
function maskLines(text: string, lines: ReadonlySet<number>, keep: number[] | null): string {
  const table = splitLines(text);
  const parts: string[] = [];
  const nextKeep: number[] = [];
  for (let index = 0; index < table.starts.length; index++) {
    const start = table.starts[index] ?? 0;
    const end = table.ends[index] ?? 0;
    if (lines.has(index)) {
      parts.push(UNALIGNED_MARKER);
      if (keep !== null) {
        for (let offset = 0; offset < UNALIGNED_MARKER.length; offset++) {
          nextKeep.push(-1);
        }
      }
    } else {
      parts.push(text.slice(start, end));
      if (keep !== null) {
        for (let from = start; from < end; from++) {
          nextKeep.push(keep[from] ?? -1);
        }
      }
    }
    if (end < text.length) {
      parts.push(text[end] ?? '');
      if (keep !== null) {
        nextKeep.push(keep[end] ?? -1);
      }
    }
  }
  if (keep !== null) {
    // 逐个拷回：大文本时展开参数会超出调用参数上限。
    keep.length = nextKeep.length;
    for (let index = 0; index < nextKeep.length; index++) {
      keep[index] = nextKeep[index] ?? -1;
    }
  }
  return parts.join('');
}

/** 兜底：保留输入的换行骨架，每个非空行都换成 [redacted-unaligned]。 */
function skeleton(x: string): string {
  const table = splitLines(x);
  const lines = new Set<number>();
  for (let index = 0; index < table.starts.length; index++) {
    if ((table.ends[index] ?? 0) > (table.starts[index] ?? 0)) {
      lines.add(index);
    }
  }
  return maskLines(x, lines, null);
}

function linesWithMarks(xLines: LineTable, marks: Uint8Array): Set<number> {
  const lines = new Set<number>();
  for (let line = 0; line < xLines.starts.length; line++) {
    if (anyMarked(marks, xLines.starts[line] ?? 0, xLines.ends[line] ?? 0)) {
      lines.add(line);
    }
  }
  return lines;
}

interface LegacyFloorMarks {
  union: Uint8Array;
  perBaseline: Array<{ id: LegacyBaselineId; marks: Uint8Array }>;
}

/**
 * 三个早期版本可能遮住的非换行字符之并（裸换行按 D3 视为结构，不计入）。
 * 遮蔽集合只由 (x, 输出) 决定：输出与现行规则逐字相同的版本，遮住的字符与现行规则完全相同，不产生残差；
 * 与先前某个版本输出相同的也不必重复对齐。跳过它们是精确的，不是放行。
 */
function legacySuperset(
  x: string,
  xLines: LineTable,
  y3: string,
  report: FloorReport
): LegacyFloorMarks | null {
  const union = new Uint8Array(x.length);
  const perBaseline: LegacyFloorMarks['perBaseline'] = [];
  const seen: string[] = [];
  for (const baseline of LEGACY_BASELINES) {
    const output = baseline.redact(x);
    if (output === x || output === y3 || seen.includes(output)) {
      continue;
    }
    seen.push(output);
    const result = hiddenSuperset(x, output, { reencodes: baseline.reencodes, xLines });
    if (result.stats.guardedLines > 0) {
      report.guardedLines += result.stats.guardedLines;
      note(report, 'guarded-line');
    }
    if (result.stats.newlineMismatch > 0) {
      report.newlineMismatches += result.stats.newlineMismatch;
      note(report, 'newline-mismatch');
    }
    perBaseline.push({ id: baseline.id, marks: result.marks });
    for (let index = 0; index < x.length; index++) {
      if (result.marks[index] === 1) {
        union[index] = 1;
      }
    }
  }
  if (perBaseline.length === 0) {
    return null;
  }
  // 行表的每个行尾位置（最后一行除外）正是一个裸换行字符。
  for (let line = 0; line < xLines.ends.length - 1; line++) {
    union[xLines.ends[line] ?? 0] = 0;
  }
  return { union, perBaseline };
}

function subtract(target: Uint8Array, remove: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < target.length; index++) {
    if (target[index] === 1 && remove[index] === 1) {
      target[index] = 0;
    }
    if (target[index] === 1) {
      count++;
    }
  }
  return count;
}

/**
 * 复查与测试夹具用的逐轮记录：本轮输入、现行规则输出、补遮后输出，以及输出每个字符取自现行规则输出的
 * 位置（-1 表示新写的标记）。与 frozen 版本的追踪重放组合后，可逐字符精确判定输出露出了输入的哪些位置。
 * 生产路径不传 trace，不分配这些数组。
 */
export interface FloorRoundTrace {
  input: string;
  current: string;
  output: string;
  outputFromCurrent: Int32Array;
}

function identityKeep(length: number): Int32Array {
  const keep = new Int32Array(length);
  for (let index = 0; index < length; index++) {
    keep[index] = index;
  }
  return keep;
}

/** 单轮底线：现行规则主渲染 + 残差补遮 + 后置条件自检。 */
export function floorOnce(
  x: string,
  currentRules: CurrentRules,
  report: FloorReport,
  trace?: FloorRoundTrace[]
): string {
  const y3 = currentRules(x);
  const finish = (output: string, keep: Int32Array | number[] | null): string => {
    if (trace !== undefined) {
      trace.push({
        input: x,
        current: y3,
        output,
        outputFromCurrent: keep === null ? identityKeep(output.length) : Int32Array.from(keep),
      });
    }
    return output;
  };
  const xLines = splitLines(x);
  const legacy = legacySuperset(x, xLines, y3, report);
  if (legacy === null) {
    return finish(y3, null);
  }
  const residual = legacy.union.slice();
  // 现行规则没改动任何字符时：它一定遮住的集合为空，补遮直接按位置进行，不必对齐。
  const wide = y3 === x ? null : alignToInput(x, y3, 'abs', { xLines });
  const residualCount =
    wide === null
      ? subtract(residual, new Uint8Array(0))
      : subtract(
          residual,
          subsetFromAlignments(x, wide, narrowFor(x, y3, wide, { xLines }), { reencodes: true })
            .marks
        );
  if (residualCount === 0) {
    return finish(y3, null);
  }
  report.residualChars += residualCount;
  note(report, 'residual-patched');
  for (const { id, marks } of legacy.perBaseline) {
    let count = 0;
    for (let index = 0; index < x.length; index++) {
      if (residual[index] === 1 && marks[index] === 1) {
        count++;
      }
    }
    report.residualByBaseline[id] += count;
  }
  if (wide !== null && wide.mode !== 'lines') {
    // 现行规则按设计守恒换行（O2）；一旦不守恒就无法按行补遮，只能整篇失败即关。
    report.skeletonFallbacks++;
    note(report, 'skeleton-fallback');
    const fallback = skeleton(x);
    return finish(fallback, new Int32Array(fallback.length).fill(-1));
  }
  const untrusted = wide === null ? new Set<number>() : untrustedLinesOf(x, wide);
  const mask = wide === null ? residual.slice() : patchOnto(y3, wide, residual, untrusted, report);
  const keep: number[] | null = trace === undefined ? null : [];
  // 原子标记：即使现行规则没改动，输入里原有的标记也要参与合并，补遮触到时整段并入。
  const patched = render(
    y3,
    wide === null ? lexMarkers(y3, 'abs') : wide.tokens,
    mask,
    report,
    keep
  );
  // 后置条件自检：在最终输出上重算三个早期版本的残差，仍可能露出的字符所在行整行遮蔽。只需复查有残差的行：
  // 其余行补遮时没动，输出行与 y3 行逐字相同，而 y3 在这些行上一定遮住的字符已覆盖历史版本的超集。
  const residualLines = linesWithMarks(xLines, residual);
  const postOptions = {
    reencodes: false,
    untrustedLines: untrusted,
    xLines,
    onlyLines: residualLines,
  };
  const postWide = alignToInput(x, patched, 'abs', postOptions);
  const postSure = subsetFromAlignments(
    x,
    postWide,
    narrowFor(x, patched, postWide, postOptions),
    postOptions
  ).marks;
  const unaligned = new Set<number>();
  for (const line of residualLines) {
    for (let index = xLines.starts[line] ?? 0; index < (xLines.ends[line] ?? 0); index++) {
      if (legacy.union[index] === 1 && postSure[index] !== 1) {
        unaligned.add(line);
        break;
      }
    }
  }
  if (unaligned.size === 0) {
    return finish(patched, keep);
  }
  report.unalignedLines += unaligned.size;
  note(report, 'unaligned-line');
  return finish(maskLines(patched, unaligned, keep), keep);
}

/** 迭代到不动点（≤ MAX_FLOOR_ROUNDS 轮）。每轮只会遮得更多，所以每轮都满足 S；不动点处幂等。 */
export function applyLegacyFloor(text: string, currentRules: CurrentRules): FloorResult {
  return runFloor(text, currentRules, undefined);
}

/** 同 applyLegacyFloor，另返回逐轮记录（复查夹具 assertNoLegacyRegression 用）。 */
export function applyLegacyFloorWithTrace(
  text: string,
  currentRules: CurrentRules
): FloorResult & { trace: FloorRoundTrace[] } {
  const trace: FloorRoundTrace[] = [];
  return { ...runFloor(text, currentRules, trace), trace };
}

function runFloor(
  text: string,
  currentRules: CurrentRules,
  trace: FloorRoundTrace[] | undefined
): FloorResult {
  const report = emptyReport();
  let current = text;
  for (let round = 1; round <= MAX_FLOOR_ROUNDS; round++) {
    const next = floorOnce(current, currentRules, report, trace);
    report.rounds = round;
    if (next === current) {
      report.fixpointReached = true;
      return { text: current, report };
    }
    current = next;
  }
  note(report, 'fixpoint-cap');
  return { text: current, report };
}
