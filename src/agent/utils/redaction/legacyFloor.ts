/**
 * 脱敏底线的编排（设计 redaction-design-2026-10-19 第 4.2 节不变量 S、第 4.3 节、第 6 节阶段 4）。
 *
 * 不变量 S：对任一输入 x、任一历史版本 v ∈ {246055e, 1b394ce, d113986, b60a61e}，凡 v(x) 遮住的非结构字符，
 * 最终输出也必须遮住。四个版本都冻结在 frozenBaselines.ts（阶段 4 把 HEAD 现行规则冻结为 v3）。
 *
 * 阶段 4 的运行时路径 applyRedactionFloor（默认）：
 *   Floor = ∪ 追踪重放位置(v0..v3)（trackedReplay.ts，带运行时自检：重放文本 === 冻结原版输出）
 *   M = Floor ∪ 检测器区间（挂点 detectors：在同一轮原文上计算区间后并入，禁止串接；阶段 4b 起默认是
 *       detectors.ts 的 T1 高置信格式层，带各自的标记，作为最低优先级的缺口交给渲染器；底线已遮住全部位置的
 *       区间不并入，所以检测器没有多遮任何位置时输出与无检测器时逐字相同；底线没遮住的级联触发前缀——v0/v1
 *       的“关键字 + 分隔符”——不并入检测区间，下一轮的级联遮蔽因此照常发生，不变量 A 在门面层（不动点多轮）
 *       也成立）
 *   渲染一次（render.ts，只依据原文与位置）→ 不动点（≤ MAX_FLOOR_ROUNDS 轮）。
 * 每轮只会遮得更多，所以每轮都满足 S；不动点处幂等。
 *
 * 失败即关：
 * - 某版本的重放文本与冻结原版输出不同（或重放内部不一致）时，该版本的位置整体不可信：冻结版本改动过的行
 *   （输入 vs 冻结输出不同）与重放文本不同的行都整行替换为 [redacted-unaligned]；无法按行定位（换行数对不上）
 *   时每个非空行都替换。重放给出的位置仍并入 Floor，只会多遮。
 * - 渲染结果的换行数与输入不同（只会由错误的重放或缺口引起：渲染放回换行时按裸换行与转义换行分开计数，
 *   RED-P4a2）时无法按行定位，整篇退回输入的换行骨架。
 * - 不动点触顶时 S 仍成立，只是不保证幂等，报告里标记 fixpoint-cap。
 * 这些路径都写进 FloorReport（只含计数与种类，不含正文），由有日志通道的调用方记录。
 *
 * 重放共享（阶段 4e）：调用方可以传入按次新建的 replayShare，让同一次调用里在同一原文上的多遍底线共享第一轮的
 * 版本重放与版本部分的汇总（位掩码、缺口、失配行、标记核心、结构分析；按来源的合并路径用它，各遍只复制位掩码再
 * 并入自己的检测器区间）。复用的结果与重新计算逐位相同，输出与报告都不变。
 *
 * 阶段 1 的对齐路径 applyAlignmentFloor 保留为回退实现（设计：性能不达标时退回对齐 H⁺ 加非规范载体守卫）
 * 与测试期的独立对照：现行规则输出 y3 作主渲染，三个早期版本经 hiddenSpans 黑盒对齐得到超集，残差补遮，
 * 后置条件自检，不动点。它不再被门面调用；换行口径与追踪重放一致（结构位置见 trackedReplay.structurePositions）。
 */
import {
  type DetectorEventKind,
  type DetectorMarker,
  type DetectorSink,
  detectT1Spans,
} from './detectors.js';
import {
  redactAt1b394ce,
  redactAt246055e,
  redactAtB60a61e,
  redactAtD113986,
} from './frozenBaselines.js';
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
import { expandAtomicMarkers, type GapSet, markerCores, renderByPositions } from './render.js';
import {
  analyzeStructure,
  type BaselineRevision,
  frozenRedact,
  type Gap,
  gapsFromTracked,
  originTracked,
  type ReplayResult,
  replayTracked,
  type Segment,
  type StructureAnalysis,
  type Tracked,
} from './trackedReplay.js';

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
  | 'fixpoint-cap'
  | 'alignment-fallback'
  | 'replay-mismatch'
  | 'replay-skeleton'
  | 'render-skeleton'
  | 'detector-span'
  | 'detector-rejected'
  | 'detector-reference-skip'
  | 'detector-unbalanced-fallback'
  | 'detector-truncated'
  | 'detector-window-exceeded'
  | 'detector-carrier-quote'
  | 'detector-unclosed-quote'
  | 'detector-unclosed-group'
  | 'detector-glued-header'
  | 'detector-trigger-kept'
  | 'detector-already-masked'
  | 'detector-floor-covered'
  | 'tiled-run'
  | 'fallback-run'
  | 'marker-verbatim'
  | 'newline-restored'
  | 'impure-synth';

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
  /** 底线遮住的内容字符总数（各轮累计；不含结构字符与输入里原有的标记）。 */
  floorChars: number;
  /** 各版本遮住的内容字符数（各轮累计；同一字符可被多个版本计入）。 */
  hiddenByBaseline: Record<BaselineRevision, number>;
  /** 检测器挂点并入、且底线没有遮住的字符数（各轮累计）。 */
  detectorChars: number;
  /** 检测器给出的区间个数（各轮累计；含底线已覆盖而跳过的区间，不含已是标记而跳过的区间）。 */
  detectorSpans: number;
  /** 各检测规则给出的区间个数，键为规则 id（口径同 detectorSpans；只含计数，不含正文）。 */
  detectorHits: Record<string, number>;
  /**
   * 检测器的诊断事件计数（各轮累计）：候选被否决、纯引用占位被跳过、URL 花括号失配退回不配平扫描、
   * 按截断形态命中、有界窗口触顶、Cookie 引号判为载体引号、引号到行尾未闭合、认证头未闭合的 ${ 组被丢弃、
   * 凭据串在紧贴头名处截断、保留底线级联触发前缀（区间里不并入的那部分）、区间完全落在已有标记上而跳过、
   * 底线已遮住区间全部位置而跳过、预过滤短路（整条规则没有运行；只计数，不进 kinds）。见 detectors.ts 的
   * DetectorEventKind。
   */
  detectorEvents: Record<DetectorEventKind, number>;
  /** 追踪重放自检失败的次数（版本 × 轮次）。 */
  replayMismatches: number;
  /** 因自检失败而整行替换为 [redacted-unaligned] 的行数。 */
  replayMismatchLines: number;
  /**
   * 渲染结果换行数与输入不同、整篇退回输入换行骨架的次数（正常规则下恒为 0：放回换行按形态分开计数，由
   * 全部语料与“同一缺口混合两种换行”生成器上的断言钉住，RED-P4a2）。
   */
  renderSkeletons: number;
  /** 渲染：只含结构、引号、原有标记而原样输出的区间数。 */
  verbatimRuns: number;
  /** 渲染：由历史缺口精确铺满、沿用合成文本的区间数。 */
  tiledRuns: number;
  /** 渲染：写新标记的区间数。 */
  fallbackRuns: number;
  /** 渲染：放回的换行结构记号个数。 */
  restoredTokens: number;
  /** 渲染：合成文本不纯而拒绝复用的缺口数（正常规则下恒为 0）。 */
  impureSynths: number;
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
    floorChars: 0,
    hiddenByBaseline: { '246055e': 0, '1b394ce': 0, d113986: 0, b60a61e: 0 },
    detectorChars: 0,
    detectorSpans: 0,
    detectorHits: {},
    detectorEvents: {
      rejected: 0,
      'reference-skip': 0,
      'unbalanced-fallback': 0,
      truncated: 0,
      'window-exceeded': 0,
      'carrier-quote': 0,
      'unclosed-quote': 0,
      'unclosed-group': 0,
      'glued-header': 0,
      'trigger-kept': 0,
      'already-masked': 0,
      'floor-covered': 0,
      'prefilter-skip': 0,
    },
    replayMismatches: 0,
    replayMismatchLines: 0,
    renderSkeletons: 0,
    verbatimRuns: 0,
    tiledRuns: 0,
    fallbackRuns: 0,
    restoredTokens: 0,
    impureSynths: 0,
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

/**
 * 阶段 1 的对齐路径（回退实现与测试对照）：迭代到不动点（≤ MAX_FLOOR_ROUNDS 轮）。每轮只会遮得更多，
 * 所以每轮都满足 S；不动点处幂等。currentRules 默认取冻结的 v3；测试可注入构造的规则以覆盖失败即关路径。
 */
export function applyAlignmentFloor(
  text: string,
  currentRules: CurrentRules = redactAtB60a61e
): FloorResult {
  return runAlignmentFloor(text, currentRules, undefined);
}

/** 同 applyAlignmentFloor，另返回逐轮记录（测试期的对照 oracle 用）。 */
export function applyAlignmentFloorWithTrace(
  text: string,
  currentRules: CurrentRules = redactAtB60a61e
): FloorResult & { trace: FloorRoundTrace[] } {
  const trace: FloorRoundTrace[] = [];
  return { ...runAlignmentFloor(text, currentRules, trace), trace };
}

function runAlignmentFloor(
  text: string,
  currentRules: CurrentRules,
  trace: FloorRoundTrace[] | undefined
): FloorResult {
  const report = emptyReport();
  note(report, 'alignment-fallback');
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

// =============================================================================================
// 阶段 4 运行时路径：追踪重放位置并集 → 按位置渲染 → 不动点
// =============================================================================================

/**
 * 检测器给出的一个区间：[start, end) 在当前轮原文上；marker 是该区间用的标记（封闭词表），缺省时由渲染器按
 * 历史缺口或通用标记 [redacted] 处理；ruleId 只用于报告计数。
 */
export interface FloorDetectorSpan {
  readonly start: number;
  readonly end: number;
  readonly marker?: DetectorMarker;
  readonly ruleId?: string;
}

/**
 * 检测器挂点（阶段 4b–4e）：在当前轮的原文上计算要遮住的区间，与 Floor 取并集。
 * 检测器之间、检测器与底线之间都不串接（不在别的检测器输出上继续匹配），所以组合是单调的（不变量 A）。
 * 返回值可以是 [start, end] 元组（不指定标记），也可以是带标记的区间；sink 接收检测器的诊断计数事件。
 */
export type FloorDetector = (
  text: string,
  sink?: DetectorSink
) => ReadonlyArray<readonly [number, number] | FloorDetectorSpan>;

/**
 * 默认检测器表（生产门面使用）：阶段 4b 的 T1 高置信格式层。后续包（4c–4e）只往这里追加。
 * 模块级只读：冻结的非空数组，不是可变状态。
 */
export const DEFAULT_FLOOR_DETECTORS: readonly FloorDetector[] = Object.freeze([detectT1Spans]);

export interface RedactionFloorOptions {
  /**
   * 检测器表；缺省为 DEFAULT_FLOOR_DETECTORS。显式传入（含空数组）时替换默认表：只供测试度量“无检测器的底线”
   * 与验证挂点本身，生产门面（Redaction.ts）不传。
   */
  detectors?: readonly FloorDetector[];
  /**
   * 测试接缝：替换某个版本的追踪重放实现，用来验证自检失败即关的路径（生产调用不传）。
   * 返回 null 表示沿用真实重放。
   */
  replayOverride?: (
    revision: BaselineRevision,
    source: Tracked,
    frozen: string
  ) => ReplayResult | null;
  /**
   * 同一次调用内的重放共享（见 createFloorReplayShare）。只在某一轮的原文正是共享对象的原文时读写；
   * 带 replayOverride 时不读不写。
   */
  replayShare?: FloorReplayShare;
  /**
   * 按来源追加的检测器（阶段 4e，只由 sourcePolicy.ts 的合并路径传入；门面与测试缺省为空）：与 detectors 一样在
   * 每轮原文上计算、并入同一轮（不串接），排在 detectors 之后；区别只在于不按 v0/v1 级联触发前缀切开区间。
   * 理由：保留触发前缀是为了让“有检测器 ⊇ 无检测器”在门面的多轮不动点上成立；按来源路径的 ⊇ 由种子（未知来源
   * 最终遮住的输入位置）在第一轮直接并入来构造性地保证，种子若被切掉触发前缀，就要依赖后续轮次的级联重新遮住，
   * 构造性丢失。T3 区间同理：secret-bearing 的取值里出现 `token:` 一类写法时整段遮住，不留关键字。
   */
  sourceDetectors?: readonly FloorDetector[];
}

/**
 * 某个版本在某段原文上的重放结果：冻结输出、追踪重放与缺口（都只取决于版本与原文）。被遮位置由
 * markHiddenByTracked 从 result.tracked 直接写进位掩码（不再分配整篇的可见表）。
 */
export interface RevisionReplay {
  readonly frozen: string;
  /** frozen 与原文相同（该版本没有改动文本）时为 null：没有遮住任何内容，不重放。 */
  readonly result: ReplayResult | null;
  /** 自检通过时的缺口（只读，渲染按版本优先级复用）。 */
  readonly gaps: readonly Gap[] | null;
}

/**
 * 一次调用内跨多遍底线共享的第一轮重放（阶段 4e）。按来源的合并路径在同一原文上先后跑两遍底线：未知来源一遍
 * （种子与快路径判定要它的逐字符来源），带 T3 区间与种子的一遍；两遍第一轮四个版本的冻结输出、追踪重放、被遮
 * 位置与缺口只取决于这段原文，完全相同，第二遍直接复用，省掉一整轮重放（合并路径的主要开销）。
 * 只缓存创建时给定原文上的结果，其它轮次的文本照常计算；由调用方每次调用新建、随调用结束丢弃，不是模块级状态。
 * 复用的结果与重新计算逐位相同，报告计数（含自检失配）照常按轮累加，所以共享与否输出和报告都不变。
 */
export interface FloorReplayShare {
  readonly text: string;
  readonly replays: Map<BaselineRevision, RevisionReplay>;
  /**
   * 同一原文上第一轮“版本部分”的汇总（见 FloorRoundBase）：第一遍算出后写入，后续各遍只复制位掩码再并入各自的
   * 检测器区间，不再逐版本合并可见表、重算标记核心与结构分析。随共享对象按次新建、随调用结束丢弃。
   */
  base?: FloorRoundBase;
}

/**
 * 某段原文上四个版本部分的汇总，只取决于原文与版本（与检测器无关）：版本位掩码、按优先级排列的缺口、自检失配的
 * 行与次数、原文里已有的完整标记；结构分析在第一次需要渲染时求出并缓存。全部只读使用：位掩码由使用方复制后
 * 再并入检测器区间，失配次数在每一遍按原顺序计入报告，所以复用与重算的输出和报告逐位相同。
 */
export interface FloorRoundBase {
  readonly bits: Uint8Array;
  readonly gapSets: readonly GapSet[];
  readonly cores: ReadonlyArray<[number, number]>;
  readonly unaligned: ReadonlySet<number>;
  readonly maskAll: boolean;
  readonly anyHidden: boolean;
  /** 自检失配的版本数（每个计一次 replay-mismatch）。 */
  readonly mismatches: number;
  structure: StructureAnalysis | null;
}

export function createFloorReplayShare(text: string): FloorReplayShare {
  return { text, replays: new Map() };
}

export interface ProvenanceResult extends FloorResult {
  /** 最终输出每个字符取自原始输入的位置；-1 为合成字符。供测试期 oracle 逐字符判定露出。 */
  origin: Int32Array;
}

/** 缺口复用的优先级：现行规则 v3 优先，其次依次 v2、v1、v0。 */
const REPLAY_PRIORITY: readonly BaselineRevision[] = ['b60a61e', 'd113986', '1b394ce', '246055e'];

const ALL_LINES = 'all';

interface ReplayRound {
  /** 本轮是否需要渲染（有被遮位置或有自检失败）。 */
  changed: boolean;
  text: string;
  origin: Int32Array | null;
}

function countLines(text: string): number {
  // 按字符数 \n 与 \r（不合并 \r\n），与逐字符扫描等价；indexOf 走引擎的快速字符搜索，载体里只有转义换行的
  // 长单行文本不必逐字符走一遍。
  let count = 1;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) {
    count++;
  }
  for (let at = text.indexOf('\r'); at >= 0; at = text.indexOf('\r', at + 1)) {
    count++;
  }
  return count;
}

/** 两段换行数相同的文本逐行比较，返回内容不同的行号。 */
function differingLines(left: string, right: string): Set<number> {
  const leftTable = splitLines(left);
  const rightTable = splitLines(right);
  const lines = new Set<number>();
  for (let index = 0; index < leftTable.starts.length; index++) {
    const leftLine = left.slice(leftTable.starts[index] ?? 0, leftTable.ends[index] ?? 0);
    const rightLine = right.slice(rightTable.starts[index] ?? 0, rightTable.ends[index] ?? 0);
    if (leftLine !== rightLine) {
      lines.add(index);
    }
  }
  return lines;
}

/**
 * 自检失败时要失败即关的行。重放一旦失配，它给出的位置整体不可信，所以冻结输出改动过的行（输入 vs 冻结输出
 * 不同，这些行上该版本遮住了东西）一律失败即关；文本失配时再并上重放文本与冻结输出不同的行（重放可能在
 * 冻结输出没动的行上写了别的东西）。冻结输出或重放文本与输入换行数对不上时无法按行定位，返回 'all'
 * （每个非空行）。
 */
function mismatchLines(
  x: string,
  frozen: string,
  replayed: string | null
): Set<number> | typeof ALL_LINES {
  const expectedLines = countLines(x);
  if (countLines(frozen) !== expectedLines) {
    return ALL_LINES;
  }
  const lines = differingLines(x, frozen);
  if (replayed === null) {
    return lines;
  }
  if (countLines(replayed) !== expectedLines) {
    return ALL_LINES;
  }
  for (const line of differingLines(frozen, replayed)) {
    lines.add(line);
  }
  return lines;
}

/** 把指定行整行替换为 [redacted-unaligned]，并同步改写来源表。 */
function maskLinesWithOrigin(
  text: string,
  lines: ReadonlySet<number> | typeof ALL_LINES,
  origin: Int32Array | null
): { text: string; origin: Int32Array | null } {
  const table = splitLines(text);
  const parts: string[] = [];
  const nextOrigin: number[] | null = origin === null ? null : [];
  for (let index = 0; index < table.starts.length; index++) {
    const start = table.starts[index] ?? 0;
    const end = table.ends[index] ?? 0;
    const masked = lines === ALL_LINES ? end > start : lines.has(index);
    if (masked) {
      parts.push(UNALIGNED_MARKER);
      if (nextOrigin !== null) {
        for (let offset = 0; offset < UNALIGNED_MARKER.length; offset++) {
          nextOrigin.push(-1);
        }
      }
    } else {
      parts.push(text.slice(start, end));
      if (nextOrigin !== null && origin !== null) {
        for (let from = start; from < end; from++) {
          nextOrigin.push(origin[from] ?? -1);
        }
      }
    }
    if (end < text.length) {
      parts.push(text[end] ?? '');
      if (nextOrigin !== null && origin !== null) {
        nextOrigin.push(origin[end] ?? -1);
      }
    }
  }
  return { text: parts.join(''), origin: nextOrigin === null ? null : Int32Array.from(nextOrigin) };
}

/** 版本在位掩码中的位（按 REPLAY_PRIORITY 顺序）。 */
const REVISION_BIT: Readonly<Record<BaselineRevision, number>> = {
  b60a61e: 1,
  d113986: 2,
  '1b394ce': 4,
  '246055e': 8,
};

/**
 * 检测器事件种类 → 报告里的事件种类。预过滤短路是每次调用的常规快路径（像 rounds 一样只计数），不进 kinds：
 * 干净文本的报告 kinds 仍为空，kinds 只列出改变或解释输出的事件。
 */
const DETECTOR_EVENT_KINDS: Readonly<
  Record<Exclude<DetectorEventKind, 'prefilter-skip'>, FloorEventKind>
> = {
  rejected: 'detector-rejected',
  'reference-skip': 'detector-reference-skip',
  'unbalanced-fallback': 'detector-unbalanced-fallback',
  truncated: 'detector-truncated',
  'window-exceeded': 'detector-window-exceeded',
  'carrier-quote': 'detector-carrier-quote',
  'unclosed-quote': 'detector-unclosed-quote',
  'unclosed-group': 'detector-unclosed-group',
  'glued-header': 'detector-glued-header',
  'trigger-kept': 'detector-trigger-kept',
  'already-masked': 'detector-already-masked',
  'floor-covered': 'detector-floor-covered',
};

/**
 * v0/v1 的关键字级联触发前缀：（可带引号的）关键字 + 可选闭引号 + 空白 + 分隔符 + 空白 + 值的开引号。v0（246055e）
 * 与 v1（1b394ce）的键值规则对任何位置的关键字生效，值的字符类包含标记的全部字符，所以上一轮写出的 [redacted]
 * 加上其后的短值在下一轮会凑够 8 个字符被继续遮住（不动点级联）。检测区间若吞掉底线没遮住的触发前缀，下一轮
 * 就看不到关键字，级联遮蔽丢失，有检测器的输出反而少遮（复查反例：前缀 token 正文贪婪吸收紧贴的 token 关键字，
 * {SYNTH 露出）。关键字表与分隔符取自冻结的 v0/v1 规则源码（frozenBaselines.ts），不能放宽。
 */
const CASCADE_TRIGGER =
  /["']?(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?/gi;

/** 本轮原文上全部级联触发前缀的位置（1 = 属于某个触发前缀）。只在有检测区间需要并入时才计算。 */
function cascadeTriggerMarks(x: string): Uint8Array {
  const marks = new Uint8Array(x.length);
  const scanner = new RegExp(CASCADE_TRIGGER.source, CASCADE_TRIGGER.flags);
  for (let match = scanner.exec(x); match !== null; match = scanner.exec(x)) {
    marks.fill(1, match.index, match.index + match[0].length);
    if (match[0].length === 0) {
      scanner.lastIndex++;
    }
  }
  return marks;
}

function normalizeDetectorSpan(
  raw: readonly [number, number] | FloorDetectorSpan
): FloorDetectorSpan {
  if ('start' in raw) {
    return raw;
  }
  return { start: raw[0], end: raw[1] };
}

/**
 * 运行检测器并把区间并入 bits（检测器位 16），带标记的区间作为检测器缺口返回（渲染器在全部历史版本缺口之后
 * 才试它们）。底线已遮住全部位置的区间不增加遮蔽位置，也不并入缺口：遮蔽位置与缺口集合都和无检测器时相同，渲染
 * 逐字相同（检测器只在它真正多遮的地方改变输出）。底线没遮住的级联触发前缀位置（cascadeTriggerMarks）不并入：
 * 区间被它们切成几段，各段分别作为缺口；只剩触发前缀可并的区间按底线已覆盖处理。诊断事件与命中计数写进报告
 * （不含正文）。
 * keepTriggers 为 false 时（按来源的 sourceDetectors）不保留触发前缀：区间按原样并入，只做“底线已覆盖”与
 * “落在已有标记内”两种精确跳过（理由见 RedactionFloorOptions.sourceDetectors）。
 */
function applyDetectors(
  x: string,
  detectors: readonly FloorDetector[],
  bits: Uint8Array,
  cores: ReadonlyArray<[number, number]>,
  report: FloorReport,
  keepTriggers: boolean
): { gaps: Gap[]; anyHidden: boolean } {
  const length = x.length;
  const gaps: Gap[] = [];
  let anyHidden = false;
  const sink: DetectorSink = {
    event(kind) {
      // kinds 去重且按首次出现排序：只在该种事件第一次计数时登记（不动点轮里同种事件可能有上万次）。
      if (report.detectorEvents[kind]++ === 0 && kind !== 'prefilter-skip') {
        note(report, DETECTOR_EVENT_KINDS[kind]);
      }
    },
  };
  let coreMask: Uint8Array | null = null;
  let triggers: Uint8Array | null = null;
  // 位置 index 是否保留可见：底线没遮住、且是保留的级联触发前缀。触发前缀表第一次需要时才计算（一遍正则）。
  const keepVisible = (index: number): boolean => {
    if (!keepTriggers || (bits[index] & 15) !== 0) {
      return false;
    }
    triggers ??= cascadeTriggerMarks(x);
    return triggers[index] === 1;
  };
  for (const detector of detectors) {
    for (const raw of detector(x, sink)) {
      const span = normalizeDetectorSpan(raw);
      const ruleId = span.ruleId ?? 'detector';
      const from = Math.max(0, span.start);
      const to = Math.min(length, span.end);
      if (to <= from) {
        continue;
      }
      if (cores.length > 0) {
        if (coreMask === null) {
          coreMask = new Uint8Array(length);
          for (const [start, end] of cores) {
            coreMask.fill(1, start, end);
          }
        }
        let insideMarker = true;
        for (let index = from; index < to; index++) {
          if (coreMask[index] !== 1) {
            insideMarker = false;
            break;
          }
        }
        if (insideMarker) {
          // 区间完全落在输入里原有的完整标记上（由多个标记拼成；恰好一个标记的区间 detectT1Spans 已跳过）：
          // 标记只会原样渲染，遮它不改变输出，却会让不动点轮多做一次结构分析与渲染。精确跳过并计数。
          sink.event('already-masked', ruleId);
          continue;
        }
      }
      report.detectorSpans++;
      if (span.ruleId !== undefined) {
        report.detectorHits[span.ruleId] = (report.detectorHits[span.ruleId] ?? 0) + 1;
      }
      // 只看四个历史版本的位（低 4 位）：被别的检测区间遮住不算底线覆盖，那个区间的缺口仍要并入。
      let beyondFloor = false;
      let keptTrigger = false;
      for (let index = from; index < to; index++) {
        if ((bits[index] & 15) === 0) {
          if (!keepVisible(index)) {
            beyondFloor = true;
            break;
          }
          keptTrigger = true;
        }
      }
      if (!beyondFloor) {
        // 底线已遮住区间的全部位置（或只剩保留的触发前缀）：检测器不增加遮蔽位置。不置检测器位、不并入缺口，
        // 遮蔽位置与缺口集合都和无检测器时相同，渲染逐字相同；只计数（例如对抗输入里每行已被 v3 遮住的 URL 口令）。
        if (keptTrigger) {
          sink.event('trigger-kept', ruleId);
        }
        sink.event('floor-covered', ruleId);
        continue;
      }
      // 并入：逐位置位，遇到保留的触发前缀就把区间切开，各段分别作为缺口。
      let runStart = -1;
      keptTrigger = false;
      for (let index = from; index < to; index++) {
        if (keepVisible(index)) {
          keptTrigger = true;
          if (runStart >= 0 && span.marker !== undefined) {
            gaps.push({ start: runStart, end: index, synth: span.marker });
          }
          runStart = -1;
          continue;
        }
        if (bits[index] === 0) {
          report.detectorChars++;
        }
        bits[index] |= 16;
        if (runStart < 0) {
          runStart = index;
        }
      }
      if (runStart >= 0 && span.marker !== undefined) {
        gaps.push({ start: runStart, end: to, synth: span.marker });
      }
      if (keptTrigger) {
        sink.event('trigger-kept', ruleId);
      }
      anyHidden = true;
      note(report, 'detector-span');
    }
  }
  return { gaps, anyHidden };
}

/** 分段在 x 里的来源起点（截到 0 以上）；不取自 x 的分段（合成文本）返回 -1。 */
function sourceStart(segment: Segment): number {
  return segment.src < 0 ? -1 : Math.max(0, segment.src);
}

/** 分段在 x 里的来源终点（截到 length 以内）。只对 sourceStart ≥ 0 的分段有意义。 */
function sourceEnd(segment: Segment, length: number): number {
  return Math.min(length, segment.range ? segment.srcEnd : segment.src + segment.len);
}

/**
 * 把某个版本遮住的位置（没有任何输出字符取自它的位置，即各分段来源区间之并在 [0, length) 里的补集）并入 bits。
 * 与 visibleFromTracked(tracked, length) 后逐位取反完全等价，但不分配整篇的可见数组、只写被遮的位置：来源区间
 * 按起点有序时（重放分段的常态）一遍扫过求补集；先单独核对一遍是否有序，无序时把区间按起点排序后再求补集，
 * 不会因为提前写入而多遮。两条路径算出的都是同一个精确补集（不是降级或回退，所以不记诊断事件）；随机分段上与
 * visibleFromTracked 的逐位等价由 test/redaction-floor-properties.test.ts 校验。返回是否有被遮位置。
 */
export function markHiddenByTracked(
  tracked: Tracked,
  length: number,
  bits: Uint8Array,
  bit: number
): boolean {
  const segments = tracked.segments;
  let sorted = true;
  let lastStart = -1;
  for (const segment of segments) {
    const start = sourceStart(segment);
    if (start < 0 || sourceEnd(segment, length) <= start) {
      continue;
    }
    if (start < lastStart) {
      sorted = false;
      break;
    }
    lastStart = start;
  }
  const ordered = sorted
    ? segments
    : segments
        .filter((segment) => {
          const start = sourceStart(segment);
          return start >= 0 && sourceEnd(segment, length) > start;
        })
        .sort((left, right) => sourceStart(left) - sourceStart(right));
  let any = false;
  let cursor = 0;
  for (const segment of ordered) {
    const start = sourceStart(segment);
    const end = start < 0 ? start : sourceEnd(segment, length);
    if (end <= start) {
      continue;
    }
    if (start > cursor) {
      for (let index = cursor; index < start; index++) {
        bits[index] |= bit;
      }
      any = true;
    }
    if (end > cursor) {
      cursor = end;
    }
  }
  // 补集的尾段 [cursor, length)。
  if (cursor < length) {
    for (let index = cursor; index < length; index++) {
      bits[index] |= bit;
    }
    any = true;
  }
  return any;
}

/** 某个版本在原文 x 上的冻结输出与追踪重放（带自检），以及由它派生的缺口。 */
function replayRevision(
  revision: BaselineRevision,
  x: string,
  options: RedactionFloorOptions
): RevisionReplay {
  const frozen = frozenRedact(revision, x);
  if (frozen === x) {
    return { frozen, result: null, gaps: null };
  }
  const source = originTracked(x);
  const result =
    options.replayOverride?.(revision, source, frozen) ?? replayTracked(revision, source, frozen);
  const tracked = result.tracked;
  return {
    frozen,
    result,
    gaps: tracked !== null && result.verified ? gapsFromTracked(tracked, x.length) : null,
  };
}

/**
 * 一轮里的版本部分：四个版本的追踪重放（带自检）位置并集、缺口、自检失配的行（失败即关）与原文里已有的标记。
 * replays 非空时逐版本读写共享的重放结果（同一原文上的多遍只算一次）。报告计数不在这里改动，由调用方按
 * mismatches 计入。
 */
function versionRoundBase(
  x: string,
  options: RedactionFloorOptions,
  replays: Map<BaselineRevision, RevisionReplay> | null
): FloorRoundBase {
  const length = x.length;
  // bits[i]：遮住位置 i 的版本位掩码（低 4 位，检测器用更高的位，由使用方在复制件上并入）。
  const bits = new Uint8Array(length);
  const gapSets: GapSet[] = [];
  const unaligned = new Set<number>();
  let maskAll = false;
  let anyHidden = false;
  let mismatches = 0;
  for (const revision of REPLAY_PRIORITY) {
    let replay = replays?.get(revision);
    if (replay === undefined) {
      replay = replayRevision(revision, x, options);
      replays?.set(revision, replay);
    }
    const { frozen, result } = replay;
    if (result === null) {
      // 该版本没有改动文本：没有遮住任何内容。跳过是精确的，不是放行。
      continue;
    }
    if (result.tracked !== null) {
      if (markHiddenByTracked(result.tracked, length, bits, REVISION_BIT[revision])) {
        anyHidden = true;
      }
    }
    if (replay.gaps !== null) {
      gapSets.push({ revision, gaps: replay.gaps });
    }
    if (!result.verified) {
      // 自检失败：重放位置不可信（仍并入，只会多遮），受影响的行整行失败即关。
      mismatches++;
      const lines = mismatchLines(x, frozen, result.tracked === null ? null : result.tracked.text);
      if (lines === ALL_LINES) {
        maskAll = true;
      } else {
        for (const line of lines) {
          unaligned.add(line);
        }
      }
    }
  }
  return {
    bits,
    gapSets,
    cores: markerCores(x),
    unaligned,
    maskAll,
    anyHidden,
    mismatches,
    structure: null,
  };
}

/** 单轮：四个版本的追踪重放（带自检）并集、检测器区间、原子标记扩展、按位置渲染、失败即关。 */
function replayFloorOnce(
  x: string,
  report: FloorReport,
  options: RedactionFloorOptions,
  wantOrigin: boolean
): ReplayRound {
  const detectors = options.detectors ?? DEFAULT_FLOOR_DETECTORS;
  const length = x.length;
  // 共享只在本轮原文正是共享对象的原文时生效（同一字符串引用时比较是 O(1)）；测试替换重放时不读不写，
  // 免得替换结果混进缓存或被缓存遮住。
  const share =
    options.replayShare !== undefined &&
    options.replayOverride === undefined &&
    options.replayShare.text === x
      ? options.replayShare
      : null;
  let base = share?.base;
  if (base === undefined) {
    base = versionRoundBase(x, options, share?.replays ?? null);
    if (share !== null) {
      share.base = base;
    }
  }
  // 自检失配按版本逐个计入报告（与逐版本重算时同序：失配记在检测器区间之前）。
  for (let count = 0; count < base.mismatches; count++) {
    report.replayMismatches++;
    note(report, 'replay-mismatch');
  }
  // bits[i]：遮住位置 i 的版本位掩码（检测器用位 16）；hidden 由它派生。共享的汇总只读：复制一份再并入检测器；
  // 不共享时汇总是本轮新建的局部对象，直接就地并入（门面路径不多一次整篇复制）。
  const bits = share !== null ? base.bits.slice() : base.bits;
  const { cores, unaligned, maskAll } = base;
  let anyHidden = base.anyHidden;
  const detected = applyDetectors(x, detectors, bits, cores, report, true);
  if (detected.anyHidden) {
    anyHidden = true;
  }
  // 按来源追加的检测器（T3 区间与 A 的种子）在默认检测器之后并入，不按级联触发前缀切开（见 sourceDetectors）。
  const sourced =
    options.sourceDetectors !== undefined && options.sourceDetectors.length > 0
      ? applyDetectors(x, options.sourceDetectors, bits, cores, report, false)
      : null;
  if (sourced?.anyHidden) {
    anyHidden = true;
  }
  const detectorGaps =
    sourced === null || sourced.gaps.length === 0
      ? detected.gaps
      : [...detected.gaps, ...sourced.gaps];
  // 检测器缺口排在全部历史版本之后（最低优先级）：只有历史版本铺不满的区间才会用到检测器的标记。共享汇总里的
  // 缺口表只读，有检测器缺口时另建一份再追加。
  const gapSets: readonly GapSet[] =
    detectorGaps.length > 0
      ? [...base.gapSets, { revision: 'detector', gaps: detectorGaps }]
      : base.gapSets;
  if (!anyHidden && !maskAll && unaligned.size === 0) {
    return { changed: false, text: x, origin: null };
  }
  base.structure ??= analyzeStructure(x);
  const structure = base.structure;
  const structureMarks = structure.marks;
  const coreMarks = new Uint8Array(length);
  for (const [start, end] of cores) {
    coreMarks.fill(1, start, end);
  }
  // 统计只看内容字符：结构字符与输入里原有的标记不计入 S，也不计入报告。
  const hidden = new Uint8Array(length);
  const counts = [0, 0, 0, 0];
  const residualCounts = [0, 0, 0, 0];
  let floorChars = 0;
  let residualChars = 0;
  for (let index = 0; index < length; index++) {
    const mask = bits[index];
    if (mask === 0) {
      continue;
    }
    hidden[index] = 1;
    if (structureMarks[index] === 1 || coreMarks[index] === 1) {
      continue;
    }
    const baselineMask = mask & 15;
    if (baselineMask === 0) {
      // 只被检测器遮住：已计入 detectorChars，不算底线字符，也不是残差（残差指只有早期版本遮住的字符）。
      continue;
    }
    floorChars++;
    const legacyOnly = (baselineMask & 1) === 0;
    if (legacyOnly) {
      residualChars++;
    }
    for (let slot = 0; slot < 4; slot++) {
      if ((mask & (1 << slot)) !== 0) {
        counts[slot] = (counts[slot] ?? 0) + 1;
        if (legacyOnly) {
          residualCounts[slot] = (residualCounts[slot] ?? 0) + 1;
        }
      }
    }
  }
  report.floorChars += floorChars;
  report.residualChars += residualChars;
  for (const [slot, revision] of REPLAY_PRIORITY.entries()) {
    report.hiddenByBaseline[revision] += counts[slot] ?? 0;
    if (revision !== 'b60a61e') {
      report.residualByBaseline[revision] += residualCounts[slot] ?? 0;
    }
  }
  if (residualChars > 0) {
    note(report, 'residual-patched');
  }
  expandAtomicMarkers(hidden, cores);
  const rendered = renderByPositions(x, hidden, structure, gapSets, wantOrigin, cores);
  report.verbatimRuns += rendered.stats.verbatimRuns;
  report.tiledRuns += rendered.stats.tiledRuns;
  report.fallbackRuns += rendered.stats.fallbackRuns;
  report.restoredTokens += rendered.stats.restoredTokens;
  report.impureSynths += rendered.stats.impureSynths;
  if (rendered.stats.verbatimRuns > 0) {
    note(report, 'marker-verbatim');
  }
  if (rendered.stats.tiledRuns > 0) {
    note(report, 'tiled-run');
  }
  if (rendered.stats.fallbackRuns > 0) {
    note(report, 'fallback-run');
  }
  if (rendered.stats.restoredTokens > 0) {
    note(report, 'newline-restored');
  }
  if (rendered.stats.impureSynths > 0) {
    note(report, 'impure-synth');
  }
  let text = rendered.text;
  let origin = rendered.origin;
  if (countLines(text) !== countLines(x)) {
    // 渲染只放回输入里的换行（裸换行与转义换行各自做多重集差），合成文本里的裸换行又只能来自通过自检的重放；
    // 换行数仍对不上说明某个缺口或重放写出了多余或缺失的换行，按行定位已不可能，整篇退回输入的换行骨架（每个
    // 非空行 [redacted-unaligned]），计入 renderSkeletons 与 render-skeleton。
    report.renderSkeletons++;
    note(report, 'render-skeleton');
    const fallback = skeleton(x);
    return {
      changed: true,
      text: fallback,
      origin: wantOrigin ? new Int32Array(fallback.length).fill(-1) : null,
    };
  }
  if (maskAll || unaligned.size > 0) {
    const masked = maskLinesWithOrigin(text, maskAll ? ALL_LINES : unaligned, origin);
    report.replayMismatchLines += maskAll ? countLines(text) : unaligned.size;
    note(report, maskAll ? 'replay-skeleton' : 'replay-mismatch');
    text = masked.text;
    origin = masked.origin;
  }
  return { changed: true, text, origin };
}

function identityOrigin(length: number): Int32Array {
  const origin = new Int32Array(length);
  for (let index = 0; index < length; index++) {
    origin[index] = index;
  }
  return origin;
}

function runReplayFloor(
  text: string,
  options: RedactionFloorOptions,
  wantOrigin: boolean
): ProvenanceResult {
  const report = emptyReport();
  let current = text;
  let origin = wantOrigin ? identityOrigin(text.length) : null;
  for (let round = 1; round <= MAX_FLOOR_ROUNDS; round++) {
    const step = replayFloorOnce(current, report, options, wantOrigin);
    report.rounds = round;
    if (!step.changed || step.text === current) {
      report.fixpointReached = true;
      return { text: current, report, origin: origin ?? new Int32Array(0) };
    }
    if (origin !== null && step.origin !== null) {
      const composed = new Int32Array(step.origin.length);
      for (let index = 0; index < step.origin.length; index++) {
        const from = step.origin[index] ?? -1;
        composed[index] = from < 0 ? -1 : (origin[from] ?? -1);
      }
      origin = composed;
    }
    current = step.text;
  }
  note(report, 'fixpoint-cap');
  return { text: current, report, origin: origin ?? new Int32Array(0) };
}

/** 阶段 4 默认路径：Floor（追踪重放位置并集 ∪ 检测器区间）→ 渲染一次 → 不动点（≤ MAX_FLOOR_ROUNDS 轮）。 */
export function applyRedactionFloor(
  text: string,
  options: RedactionFloorOptions = {}
): FloorResult {
  const { text: output, report } = runReplayFloor(text, options, false);
  return { text: output, report };
}

/** 同 applyRedactionFloor，另返回最终输出到原始输入的逐字符来源（复查夹具 assertNoLegacyRegression 用）。 */
export function applyRedactionFloorWithProvenance(
  text: string,
  options: RedactionFloorOptions = {}
): ProvenanceResult {
  return runReplayFloor(text, options, true);
}
