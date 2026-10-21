/**
 * 脱敏阶段 4 的按位置渲染（设计 redaction-design-2026-10-19 第 4.6 节）。
 *
 * 输入只有原文 x 与遮蔽位置集合（追踪重放给出的四个版本位置之并，后续包的检测器区间也并入这里），输出只由
 * 原文里未被遮的字符与合成文本拼成，所以不可能把别的版本已经遮住的输入字节重新写出（按来源分流原型的渲染泄漏）。
 *
 * 被遮区间（相邻被遮位置连成的最长区间）按下面的顺序处理：
 * 1. 区间里含有输入原有的完整标记、且没有任何“内容”位置（其余只有结构记号、引号及其转义反斜杠）时原样
 *    输出：这些位置在不变量 S 的口径里都是信息等价的，原样输出也保证幂等（原子标记：被遮区间触到输入里
 *    原有的完整标记时，调用方已把整个标记并入区间）。
 * 2. 用各版本的缺口（每个缺口的合成文本都只由标记、引号、换行组成）加信息等价字符的原样步精确铺满区间：
 *    每个位置先按版本优先级试缺口（现行规则 v3 优先，再依次 v2、v1、v0），都不行时才原样输出一个信息等价
 *    记号（结构记号、原有标记、引号、紧贴引号的反斜杠串）。这样常见写法的输出与 HEAD 逐字相同（例如 JSON
 *    数值位置的 "[redacted]"，引号是合成的），早期版本吃进去的转义引号反斜杠也不会被吞掉，载体 JSON 保持合法
 *    （复查意见 3）。只有引号或结构、没有标记的区间（例如空引号值 password='' 的闭引号）同样先试缺口：历史
 *    版本在这里写过 '[redacted]'，沿用它才不会把“值为空”暴露出来。
 *    缺口里的换行结构若比合成文本多（历史版本吞掉了 JSON 字面量里的转义换行，M-12），把缺的那些按原顺序放回
 *    第一个标记之后——只暴露换行个数（D3 阶段 4 子项）。多重集差按解码后的换行字符比较：x 里的 \u000a 与
 *    版本重新写出的 \n 是同一个换行，不会多放一次（复查意见 2）。
 * 3. 否则写新标记 [redacted]：保留区间首尾的分隔引号，区间内的结构记号（裸换行、可解析字面量里的转义换行）
 *    按原顺序放回，其余字符一律不出现。不做等长占位。
 * 标记文字沿用封闭词表，不新增形态。本模块是纯函数，不持有模块级可变状态。
 */
import type { BaselineRevision, Gap, StructureAnalysis, StructureToken } from './trackedReplay.js';

/** 新写标记只用最通用的一个；更具体的标记只会经缺口复用（历史版本自己写出的）出现。 */
const NEW_MARKER = '[redacted]';

export interface GapSet {
  revision: BaselineRevision;
  gaps: readonly Gap[];
}

export interface RenderStats {
  /** 原样输出（只含结构、引号、原有标记）的区间数。 */
  verbatimRuns: number;
  /** 由历史缺口（可夹带信息等价的原样步）精确铺满、沿用合成文本的区间数。 */
  tiledRuns: number;
  /** 写新标记的区间数。 */
  fallbackRuns: number;
  /** 放回的换行结构记号个数（合成文本缺少的转义换行，以及新标记路径下放回的全部结构记号）。 */
  restoredTokens: number;
  /** 合成文本不纯（含标记、引号、换行以外的字符）而被拒绝复用的缺口数；正常规则下恒为 0。 */
  impureSynths: number;
}

export interface RenderResult {
  text: string;
  /** 输出每个字符取自 x 的位置；-1 为合成字符。只在 wantOrigin 时生成（生产路径不分配）。 */
  origin: Int32Array | null;
  stats: RenderStats;
}

export function emptyRenderStats(): RenderStats {
  return { verbatimRuns: 0, tiledRuns: 0, fallbackRuns: 0, restoredTokens: 0, impureSynths: 0 };
}

const CORE_SUFFIXES = [
  ']',
  '-nested-value]',
  '-private-key]',
  '-google-api-key]',
  '-api-key]',
  '-token]',
  '-unaligned]',
];

/** text 在 at 处开始的完整核心标记长度；不是标记时为 0。 */
export function coreMarkerLengthAt(text: string, at: number): number {
  if (!text.startsWith('[redacted', at)) {
    return 0;
  }
  const after = at + '[redacted'.length;
  for (const suffix of CORE_SUFFIXES) {
    if (text.startsWith(suffix, after)) {
      return '[redacted'.length + suffix.length;
    }
  }
  return 0;
}

/** 输入里原有的完整标记区间 [start, end)。 */
export function markerCores(text: string): Array<[number, number]> {
  const cores: Array<[number, number]> = [];
  let from = 0;
  for (let at = text.indexOf('[redacted', from); at >= 0; at = text.indexOf('[redacted', from)) {
    const length = coreMarkerLengthAt(text, at);
    if (length === 0) {
      from = at + 1;
      continue;
    }
    cores.push([at, at + length]);
    from = at + length;
  }
  return cores;
}

/** 原子标记：被遮区间触到输入里原有的完整标记时，把整个标记并入区间。只会多遮。 */
export function expandAtomicMarkers(
  hidden: Uint8Array,
  cores: ReadonlyArray<[number, number]>
): void {
  for (const [start, end] of cores) {
    let touched = false;
    for (let index = start; index < end; index++) {
      if (hidden[index] === 1) {
        touched = true;
        break;
      }
    }
    if (touched) {
      hidden.fill(1, start, end);
    }
  }
}

/**
 * 结构记号被部分遮住时扩到整个记号。只会多遮；记号在被遮区间内按原样放回，所以可见信息不变，
 * 而缺口与区间的边界再也不会切开一个转义序列。
 */
export function expandStructureTokens(hidden: Uint8Array, tokens: readonly StructureToken[]): void {
  for (const token of tokens) {
    if (token.end - token.start <= 1) {
      continue;
    }
    let touched = false;
    for (let index = token.start; index < token.end; index++) {
      if (hidden[index] === 1) {
        touched = true;
        break;
      }
    }
    if (touched) {
      hidden.fill(1, token.start, token.end);
    }
  }
}

function isQuote(char: string | undefined): boolean {
  return char === '"' || char === "'";
}

type NewlineChar = '\n' | '\r';

interface SynthShape {
  pure: boolean;
  /** 第一个核心标记结束的位置；没有标记时为 -1。 */
  firstCoreEnd: number;
  /** 合成文本里的换行记号，已归一到解码后的换行字符（裸换行或整串反斜杠加 n/r）。 */
  tokens: NewlineChar[];
}

/**
 * 判断合成文本是否只由标记、引号（可带转义反斜杠）、换行（裸的或转义的）组成（设计 4.6 的沿用条件），
 * 同时切出其中的换行记号。词法与 hiddenSpans 的 T_ABS 一致。
 */
export function analyzeSynth(synth: string): SynthShape {
  const tokens: NewlineChar[] = [];
  let firstCoreEnd = -1;
  let index = 0;
  while (index < synth.length) {
    const char = synth[index];
    const coreLength = coreMarkerLengthAt(synth, index);
    if (coreLength > 0) {
      if (firstCoreEnd < 0) {
        firstCoreEnd = index + coreLength;
      }
      index += coreLength;
      continue;
    }
    if (char === '\n' || char === '\r') {
      tokens.push(char);
      index++;
      continue;
    }
    if (isQuote(char)) {
      index++;
      continue;
    }
    if (char === '\\') {
      let cursor = index;
      while (synth[cursor] === '\\') {
        cursor++;
      }
      const next = synth[cursor];
      if (isQuote(next)) {
        index = cursor + 1;
        continue;
      }
      if (next === 'n' || next === 'r') {
        tokens.push(next === 'n' ? '\n' : '\r');
        index = cursor + 1;
        continue;
      }
    }
    return { pure: false, firstCoreEnd, tokens };
  }
  return { pure: true, firstCoreEnd, tokens };
}

/** 第一个 start ≥ position 的记号下标（记号按 start 升序）。 */
function firstTokenFrom(tokens: readonly StructureToken[], position: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((tokens[middle]?.start ?? 0) < position) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** [start, end) 内的结构记号，按原顺序（记号已扩展为整体，不会跨越区间边界）。 */
function structureTokensIn(
  tokens: readonly StructureToken[],
  start: number,
  end: number
): StructureToken[] {
  const inside: StructureToken[] = [];
  for (let index = firstTokenFrom(tokens, start); index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined || token.start >= end) {
      break;
    }
    inside.push(token);
  }
  return inside;
}

/** 合成文本缺少的换行记号：按解码后的换行字符做多重集之差，保持区间内的原顺序。 */
function missingTokens(
  runTokens: readonly StructureToken[],
  synthTokens: readonly NewlineChar[]
): StructureToken[] {
  let lineFeeds = 0;
  let carriageReturns = 0;
  for (const token of synthTokens) {
    if (token === '\n') {
      lineFeeds++;
    } else {
      carriageReturns++;
    }
  }
  const missing: StructureToken[] = [];
  for (const token of runTokens) {
    if (token.newline === '\n') {
      if (lineFeeds > 0) {
        lineFeeds--;
        continue;
      }
    } else if (carriageReturns > 0) {
      carriageReturns--;
      continue;
    }
    missing.push(token);
  }
  return missing;
}

interface Candidate {
  gap: Gap;
  shape: SynthShape;
}

/** 每个起点上可用的缺口，按版本优先级（调用方传入的 gapSets 顺序）排列。合成文本的形态按文本记忆化。 */
function candidatesByStart(
  gapSets: readonly GapSet[],
  stats: RenderStats
): Map<number, Candidate[]> {
  const byStart = new Map<number, Candidate[]>();
  const shapes = new Map<string, SynthShape>();
  for (const { gaps } of gapSets) {
    for (const gap of gaps) {
      if (gap.end <= gap.start) {
        continue;
      }
      let shape = shapes.get(gap.synth);
      if (shape === undefined) {
        shape = analyzeSynth(gap.synth);
        shapes.set(gap.synth, shape);
      }
      if (!shape.pure) {
        stats.impureSynths++;
        continue;
      }
      const list = byStart.get(gap.start);
      if (list === undefined) {
        byStart.set(gap.start, [{ gap, shape }]);
      } else {
        list.push({ gap, shape });
      }
    }
  }
  return byStart;
}

/** 铺满区间的一步：沿用某个版本的缺口，或原样输出一个信息等价记号。 */
type Step = Candidate | { verbatimStart: number; verbatimEnd: number };

function isVerbatim(step: Step): step is { verbatimStart: number; verbatimEnd: number } {
  return 'verbatimStart' in step;
}

/**
 * 用缺口与原样步精确铺满 [start, end)：显式栈的深度优先，每个位置先按优先级试缺口，再试原样步；失败的位置
 * 记忆化（dead 由调用方复用，失败时清空）。常见情形是单个缺口恰好等于区间，第一步即命中。exemptAt 给出某
 * 位置上信息等价记号的长度（0 = 内容字符，不能原样输出）。
 */
function tile(
  byStart: Map<number, Candidate[]>,
  exemptAt: (position: number) => number,
  start: number,
  end: number,
  dead: Set<number>
): Step[] | null {
  const chosen: Step[] = [];
  const stack: Array<{ at: number; next: number }> = [{ at: start, next: 0 }];
  for (;;) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      dead.clear();
      return null;
    }
    if (frame.at === end) {
      return chosen;
    }
    const candidates = dead.has(frame.at) ? [] : (byStart.get(frame.at) ?? []);
    let advanced = false;
    while (!advanced && frame.next <= candidates.length) {
      const index = frame.next++;
      const candidate = candidates[index];
      if (candidate !== undefined) {
        if (candidate.gap.end > end) {
          continue;
        }
        chosen.push(candidate);
        stack.push({ at: candidate.gap.end, next: 0 });
        advanced = true;
        break;
      }
      // 缺口都试过了：最后一个选择是原样输出一个信息等价记号（截到区间末尾）。
      const step = dead.has(frame.at) ? 0 : exemptAt(frame.at);
      if (step > 0) {
        const to = Math.min(end, frame.at + step);
        chosen.push({ verbatimStart: frame.at, verbatimEnd: to });
        stack.push({ at: to, next: 0 });
        advanced = true;
      }
    }
    if (advanced) {
      continue;
    }
    dead.add(frame.at);
    stack.pop();
    if (stack.length > 0) {
      chosen.pop();
    }
  }
}

/** 区间内是否含有输入原有的完整标记。 */
function containsCore(inCore: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    if (inCore[index] === 1) {
      return true;
    }
  }
  return false;
}

/**
 * 从 at 开始的信息等价记号长度（截到 end）：结构记号（整个转义序列）、输入原有的完整标记、引号、紧贴引号的
 * 反斜杠串（引号可以在区间之外：反斜杠是那个引号的转义，与引号一起视为结构）。0 表示 at 是内容位置。
 * 口径与 test/fixtures/redaction-catalog/legacyRegressionOracle.ts 的 exemptPositions 相同。
 */
function exemptTokenLength(
  x: string,
  inCore: Uint8Array,
  tokens: readonly StructureToken[],
  tokenAtStart: Int32Array | null,
  at: number,
  end: number
): number {
  const tokenIndex = tokenAtStart === null ? -1 : (tokenAtStart[at] ?? -1);
  if (tokenIndex >= 0) {
    return Math.min(tokens[tokenIndex]?.end ?? at, end) - at;
  }
  if (inCore[at] === 1) {
    let cursor = at;
    while (cursor < end && inCore[cursor] === 1) {
      cursor++;
    }
    return cursor - at;
  }
  const char = x[at];
  if (isQuote(char)) {
    return 1;
  }
  if (char === '\\') {
    let cursor = at;
    while (x[cursor] === '\\') {
      cursor++;
    }
    if (isQuote(x[cursor])) {
      return Math.min(cursor + 1, end) - at;
    }
  }
  return 0;
}

/** 区间首尾的分隔引号（可带转义反斜杠）长度。 */
function leadingQuoteLength(x: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && x[cursor] === '\\') {
    cursor++;
  }
  return cursor < end && isQuote(x[cursor]) ? cursor + 1 - start : 0;
}

function trailingQuoteLength(x: string, start: number, end: number): number {
  if (end <= start || !isQuote(x[end - 1])) {
    return 0;
  }
  let cursor = end - 1;
  while (cursor - 1 >= start && x[cursor - 1] === '\\') {
    cursor--;
  }
  return end - cursor;
}

class Output {
  readonly parts: string[] = [];
  readonly origin: number[] | null;

  constructor(wantOrigin: boolean) {
    this.origin = wantOrigin ? [] : null;
  }

  keep(x: string, start: number, end: number): void {
    if (end <= start) {
      return;
    }
    this.parts.push(x.slice(start, end));
    if (this.origin !== null) {
      for (let index = start; index < end; index++) {
        this.origin.push(index);
      }
    }
  }

  synth(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.parts.push(text);
    if (this.origin !== null) {
      for (let index = 0; index < text.length; index++) {
        this.origin.push(-1);
      }
    }
  }
}

/** 结构位置的前缀和：O(1) 判断某区间里有没有结构字符。 */
function structurePrefix(structure: Uint8Array): Int32Array {
  const prefix = new Int32Array(structure.length + 1);
  for (let index = 0; index < structure.length; index++) {
    prefix[index + 1] = (prefix[index] ?? 0) + (structure[index] === 1 ? 1 : 0);
  }
  return prefix;
}

/**
 * 按位置渲染。hidden 是与 x 等长的遮蔽位置（调用方已做原子标记扩展；本函数再把被部分遮住的结构记号就地扩展
 * 为整体，只会多遮），structure 是 analyzeStructure(x)，gapSets 按版本优先级排列（v3 在前）。
 */
export function renderByPositions(
  x: string,
  hidden: Uint8Array,
  structure: StructureAnalysis,
  gapSets: readonly GapSet[],
  wantOrigin = false
): RenderResult {
  const stats = emptyRenderStats();
  const output = new Output(wantOrigin);
  const cores = markerCores(x);
  const inCore = new Uint8Array(x.length);
  for (const [start, end] of cores) {
    inCore.fill(1, start, end);
  }
  const tokens = structure.tokens;
  expandStructureTokens(hidden, tokens);
  let tokenAtStart: Int32Array | null = null;
  if (tokens.length > 0) {
    tokenAtStart = new Int32Array(x.length + 1).fill(-1);
    for (const [index, token] of tokens.entries()) {
      tokenAtStart[token.start] = index;
    }
  }
  const prefix = structurePrefix(structure.marks);
  const hasStructure = (start: number, end: number): boolean =>
    (prefix[end] ?? 0) - (prefix[start] ?? 0) > 0;
  const dead = new Set<number>();
  let byStart: Map<number, Candidate[]> | null = null;
  let index = 0;
  while (index < x.length) {
    if (hidden[index] !== 1) {
      let end = index;
      while (end < x.length && hidden[end] !== 1) {
        end++;
      }
      output.keep(x, index, end);
      index = end;
      continue;
    }
    let end = index;
    while (end < x.length && hidden[end] === 1) {
      end++;
    }
    const start = index;
    index = end;
    const exemptAt = (at: number): number =>
      exemptTokenLength(x, inCore, tokens, tokenAtStart, at, end);
    // 原样步不跨过输入原有的标记：含内容的区间触到标记时，标记随区间一起被同一个标记取代（原子标记），
    // 不单独重出，否则 password=SYNTHETIChead[redacted] 会渲染成两个相邻标记。
    const verbatimStepAt = (at: number): number => (inCore[at] === 1 ? 0 : exemptAt(at));
    let content = false;
    for (let at = start; at < end; ) {
      const step = exemptAt(at);
      if (step === 0) {
        content = true;
        break;
      }
      at += step;
    }
    if (!content && containsCore(inCore, start, end)) {
      stats.verbatimRuns++;
      output.keep(x, start, end);
      continue;
    }
    if (byStart === null) {
      byStart = candidatesByStart(gapSets, stats);
    }
    const tiled = tile(byStart, verbatimStepAt, start, end, dead);
    if (tiled !== null) {
      if (tiled.every(isVerbatim)) {
        stats.verbatimRuns++;
      } else {
        stats.tiledRuns++;
      }
      for (const step of tiled) {
        if (isVerbatim(step)) {
          output.keep(x, step.verbatimStart, step.verbatimEnd);
          continue;
        }
        const { gap, shape } = step;
        if (!hasStructure(gap.start, gap.end)) {
          // 缺口里没有结构字符：合成文本原样沿用（它自带的换行记号是版本自己写出的）。
          output.synth(gap.synth);
          continue;
        }
        const missing = missingTokens(structureTokensIn(tokens, gap.start, gap.end), shape.tokens);
        if (missing.length === 0) {
          output.synth(gap.synth);
          continue;
        }
        // 历史版本吞掉的换行按原形态放回第一个标记之后；它们是结构位置，只暴露换行个数。
        const at = shape.firstCoreEnd < 0 ? gap.synth.length : shape.firstCoreEnd;
        output.synth(gap.synth.slice(0, at));
        for (const token of missing) {
          output.keep(x, token.start, token.end);
          stats.restoredTokens++;
        }
        output.synth(gap.synth.slice(at));
      }
      continue;
    }
    stats.fallbackRuns++;
    const lead = leadingQuoteLength(x, start, end);
    const trail = lead >= end - start ? 0 : trailingQuoteLength(x, start + lead, end);
    output.keep(x, start, start + lead);
    output.synth(NEW_MARKER);
    for (const token of structureTokensIn(tokens, start + lead, end - trail)) {
      output.keep(x, token.start, token.end);
      stats.restoredTokens++;
    }
    output.keep(x, end - trail, end);
  }
  return {
    text: output.parts.join(''),
    origin: output.origin === null ? null : Int32Array.from(output.origin),
    stats,
  };
}
