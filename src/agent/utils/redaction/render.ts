/**
 * 脱敏阶段 4 的按位置渲染（设计 redaction-design-2026-10-19 第 4.6 节）。
 *
 * 输入只有原文 x 与遮蔽位置集合（追踪重放给出的四个版本位置之并 ∪ 检测器区间），输出只由原文里未被遮的字符
 * 与合成文本拼成，所以不可能把别的版本已经遮住的输入字节重新写出（按来源分流原型的渲染泄漏）。
 *
 * 被遮区间（相邻被遮位置连成的最长区间）按下面的顺序处理：
 * 1. 区间里含有输入原有的完整标记、且没有任何“内容”位置（其余只有结构记号、值边界上的定界引号记号）时原样
 *    输出：这些位置在不变量 S 的口径里都是信息等价的，原样输出也保证幂等（原子标记：被遮区间触到输入里
 *    原有的完整标记时，调用方已把整个标记并入区间）。
 * 2. 用各版本的缺口（每个缺口的合成文本都只由标记、引号、换行组成）加信息等价字符的原样步精确铺满区间：
 *    每个位置先按版本优先级试缺口（现行规则 v3 优先，再依次 v2、v1、v0，最后是检测器缺口——合成文本就是检测
 *    规则的标记，例如前缀 token 的 [redacted-api-key]；历史版本也遮住的区间因此与上一包逐字相同，只有底线没遮
 *    到的区间才用检测器的标记），都不行时才原样输出一个信息等价
 *    记号（结构记号、原有标记、值边界上的定界引号记号）。这样常见写法的输出与 HEAD 逐字相同（例如 JSON
 *    数值位置的 "[redacted]"，引号是合成的），早期版本吃进去的转义引号反斜杠也不会被吞掉，载体 JSON 保持合法
 *    （复查意见 3）。只有引号或结构、没有标记的区间（例如空引号值 password='' 的闭引号）同样先试缺口：历史
 *    版本在这里写过 '[redacted]'，沿用它才不会把“值为空”暴露出来。
 *    引号记号（RED-P4a2 第 3 项，与 oracle 的 exemptPositions 同一口径）：紧贴引号的奇数长度反斜杠串连同引号
 *    是一个记号（该引号的转义）；偶数长度的反斜杠串是内容（转义的反斜杠），引号单独成记号。只有值边界上的定界
 *    引号记号信息等价：相邻的引号记号连成一簇，某个历史版本把簇两侧最近的非引号字符都遮住时，簇里的记号是那个
 *    值内部的引号（例如 "ab\"cd\"ef" 里的 \"），按内容处理，不原样输出。转义单元（最后一个反斜杠加它转义的
 *    引号）不被切开：部分被遮时整体扩进被遮区间，缺口吞掉了反斜杠时不单独写出引号（见 expandEscapedQuotes），
 *    否则会留下没有转义的引号、载体 JSON 失效。
 *    缺口里的换行结构若比合成文本多（历史版本吞掉了 JSON 字面量里的转义换行，M-12），把缺的那些按原顺序放回
 *    第一个标记之后——只暴露换行个数（D3 阶段 4 子项）。多重集差按形态分开计数（RED-P4a2 第 1 项）：裸换行只与
 *    合成文本里的裸换行相抵，转义换行只与合成文本里同一转义层级的转义换行相抵，所以合成文本重出的裸换行不会
 *    被转义记号抵掉、再把真正的裸换行多放一次；同一层级内按解码后的换行字符比较：x 里的 \u000a 与版本重新写出
 *    的 \n 是同一个换行，不会多放一次（复查意见 2）。
 * 3. 否则写新标记 [redacted]：保留区间首尾的定界引号记号，区间内的结构记号（裸换行、JSON 载体字面量里的转义
 *    换行）按原顺序放回，其余字符一律不出现。不做等长占位。
 * 标记文字沿用封闭词表，不新增形态。本模块是纯函数，不持有模块级可变状态。
 */
import type { BaselineRevision, Gap, StructureAnalysis, StructureToken } from './trackedReplay.js';

/** 新写标记只用最通用的一个；更具体的标记只会经缺口复用出现（历史版本自己写出的，或检测规则指定的）。 */
const NEW_MARKER = '[redacted]';

/**
 * 一组可复用的缺口：四个历史版本各一组（合成文本是版本自己写出的替换文本），检测器一组（revision='detector'，
 * 合成文本是检测规则的标记）。调用方按优先级排列：v3、v2、v1、v0，检测器最后。
 */
export interface GapSet {
  revision: BaselineRevision | 'detector';
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

/**
 * 转义引号的最小单元（紧贴引号的最后一个反斜杠加引号，且反斜杠串是奇数长度，RED-P4a2 第 3 项）被部分遮住时扩到
 * 整个单元。只会多遮；它是值边界上的定界引号记号的一部分时在被遮区间内原样放回，可见信息不变。这样缺口与区间的
 * 边界不会把转义反斜杠和它转义的引号切开：早期版本的裸值字符类吃进了 \" 的反斜杠、引号留在区间外时，只用那个
 * 缺口铺排会留下没有转义的引号，载体 JSON 失效（复查意见 3 的同一类问题）。串里前面成对的反斜杠各自是完整的转义
 * （载体里是内层的反斜杠），缺口可以在它们之间结束，不扩展；偶数长度的反斜杠串是内容，也不扩展。
 */
export function expandEscapedQuotes(x: string, hidden: Uint8Array): void {
  for (let at = x.indexOf('\\'); at >= 0; ) {
    let cursor = at;
    while (x[cursor] === '\\') {
      cursor++;
    }
    if (isQuote(x[cursor]) && (cursor - at) % 2 === 1) {
      if (hidden[cursor - 1] === 1 || hidden[cursor] === 1) {
        hidden[cursor - 1] = 1;
        hidden[cursor] = 1;
      }
    }
    at = x.indexOf('\\', cursor);
  }
}

type NewlineChar = '\n' | '\r';

interface SynthShape {
  pure: boolean;
  /** 第一个核心标记结束的位置；没有标记时为 -1。 */
  firstCoreEnd: number;
  /** 合成文本里的换行记号，已归一到解码后的换行字符（裸换行或整串反斜杠加 n/r）。 */
  tokens: NewlineChar[];
  /**
   * 与 tokens 一一对应的载体层级（口径同 StructureToken.level）：0 = 裸换行；k 个反斜杠加 n/r 是第 1 + log2(k) 层
   * 的换行（JSON.stringify 每编码一层反斜杠翻倍：\n、\\n、\\\\n）；k 不是 2 的幂时记 -1，不与任何记号相抵。
   * 多重集差只在同一层级内相抵（RED-P4a2 第 1 项）。
   */
  levels: number[];
}

/** k 个反斜杠加 n/r 的转义换行所在的载体层级：k = 2^(d-1) 时是第 d 层；其他 k 返回 -1（不与任何记号相抵）。 */
function escapeLevel(backslashes: number): number {
  let level = 1;
  for (let run = 1; run <= backslashes; run *= 2, level++) {
    if (run === backslashes) {
      return level;
    }
  }
  return -1;
}

/**
 * 判断合成文本是否只由标记、引号（可带转义反斜杠）、换行（裸的或转义的）组成（设计 4.6 的沿用条件），
 * 同时切出其中的换行记号。词法与 hiddenSpans 的 T_ABS 一致。
 */
export function analyzeSynth(synth: string): SynthShape {
  const tokens: NewlineChar[] = [];
  const levels: number[] = [];
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
      levels.push(0);
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
        levels.push(escapeLevel(cursor - index));
        index = cursor + 1;
        continue;
      }
    }
    return { pure: false, firstCoreEnd, tokens, levels };
  }
  return { pure: true, firstCoreEnd, tokens, levels };
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

/**
 * 合成文本缺少的换行记号：按（载体层级，解码后的换行字符）分槽做多重集之差，保持区间内的原顺序（RED-P4a2
 * 第 1 项）。裸换行只与合成文本里的裸换行相抵，转义换行只与同一层级的转义换行相抵：合成文本重出的裸换行不能被
 * 转义记号先用掉（否则真正的裸换行会被当成缺失再放回一次，裸换行多出一个，整篇退回骨架）；载体里同理，版本重出
 * 的第 1 层换行（\n）也不能被第 2 层的转义记号（\\n）抵掉，否则解码后的行数多出一行。同一层级内仍按解码后的字符
 * 比较（\u000a 与 \n 是同一个换行，复查意见 2）；记号的层级由结构分析按载体递归给出，不看转义序列的写法。
 */
function missingTokens(runTokens: readonly StructureToken[], shape: SynthShape): StructureToken[] {
  const available = new Map<string, number>();
  const slotOf = (level: number, newline: NewlineChar): string => `${level}${newline}`;
  for (const [index, newline] of shape.tokens.entries()) {
    const slot = slotOf(shape.levels[index] ?? 0, newline);
    available.set(slot, (available.get(slot) ?? 0) + 1);
  }
  const missing: StructureToken[] = [];
  for (const token of runTokens) {
    const slot = slotOf(token.level, token.newline);
    const count = available.get(slot) ?? 0;
    if (count > 0) {
      available.set(slot, count - 1);
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

/**
 * 每个起点上可用的缺口，按版本优先级（调用方传入的 gapSets 顺序）排列。用按位置下标的单链表保存（head[p] 是起点
 * p 上第一个候选，next[i] 是同一起点上的下一个），不为每个起点分配数组；下标都存 slot+1，0 表示没有，新分配的
 * 类型数组本来就是 0，不必整篇预填 -1。合成文本的形态按文本记忆化。
 */
interface CandidateIndex {
  head: Int32Array;
  next: Int32Array;
  gaps: Gap[];
  shapes: SynthShape[];
}

function candidatesByStart(
  length: number,
  gapSets: readonly GapSet[],
  stats: RenderStats
): CandidateIndex {
  let total = 0;
  for (const { gaps } of gapSets) {
    total += gaps.length;
  }
  const head = new Int32Array(length + 1);
  const next = new Int32Array(total);
  const gapsOut: Gap[] = [];
  const shapesOut: SynthShape[] = [];
  const shapes = new Map<string, SynthShape>();
  // 逆序遍历（优先级最低的缺口集、集内最后一个缺口先处理）并插到表头，遍历链表时恰好是 gapSets 的原顺序。
  for (let setIndex = gapSets.length - 1; setIndex >= 0; setIndex--) {
    const gaps = gapSets[setIndex]?.gaps ?? [];
    for (let gapIndex = gaps.length - 1; gapIndex >= 0; gapIndex--) {
      const gap = gaps[gapIndex];
      if (gap === undefined || gap.end <= gap.start) {
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
      if (gap.start < 0 || gap.start > length) {
        // 起点在 x 之外的缺口不会被任何区间查到（与按起点查表的旧实现一致），不入表。
        continue;
      }
      const slot = gapsOut.length;
      gapsOut.push(gap);
      shapesOut.push(shape);
      next[slot] = head[gap.start] ?? 0;
      head[gap.start] = slot + 1;
    }
  }
  return { head, next, gaps: gapsOut, shapes: shapesOut };
}

function candidateAt(index: CandidateIndex, slot: number): Candidate | null {
  const gap = index.gaps[slot];
  const shape = index.shapes[slot];
  return gap === undefined || shape === undefined ? null : { gap, shape };
}

/** 铺满区间的一步：沿用某个版本的缺口，或原样输出一个信息等价记号。 */
type Step = Candidate | { verbatimStart: number; verbatimEnd: number };

function isVerbatim(step: Step): step is { verbatimStart: number; verbatimEnd: number } {
  return 'verbatimStart' in step;
}

interface TileFrame {
  at: number;
  /** 下一个要试的候选（链表下标；-1 = 缺口都试过了）。 */
  cursor: number;
  /** 原样步是否已经试过。 */
  verbatimTried: boolean;
}

/**
 * 用缺口与原样步精确铺满 [start, end)：显式栈的深度优先，每个位置先按优先级试缺口，再试原样步；失败的位置
 * 记忆化（dead 由调用方复用，失败时清空）。常见情形是单个缺口恰好等于区间，第一步即命中（快路径，结果与深度
 * 优先的第一步相同，只是不分配栈）。exemptAt 给出某位置上信息等价记号的长度（0 = 内容字符，不能原样输出）。
 */
function tile(
  index: CandidateIndex,
  exemptAt: (position: number, end: number) => number,
  start: number,
  end: number,
  dead: Set<number>
): Step[] | null {
  if (!dead.has(start)) {
    // 快路径：深度优先在起点上选的是第一个不越过区间末尾的缺口；它恰好铺满区间时直接返回同一结果。
    for (let slot = (index.head[start] ?? 0) - 1; slot >= 0; slot = (index.next[slot] ?? 0) - 1) {
      const gapEnd = index.gaps[slot]?.end ?? Number.POSITIVE_INFINITY;
      if (gapEnd > end) {
        continue;
      }
      if (gapEnd === end) {
        const only = candidateAt(index, slot);
        if (only !== null) {
          return [only];
        }
      }
      break;
    }
  }
  const frameAt = (at: number): TileFrame => ({
    at,
    cursor: dead.has(at) ? -1 : (index.head[at] ?? 0) - 1,
    verbatimTried: false,
  });
  const chosen: Step[] = [];
  const stack: TileFrame[] = [frameAt(start)];
  for (;;) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      dead.clear();
      return null;
    }
    if (frame.at === end) {
      return chosen;
    }
    let advanced = false;
    while (frame.cursor >= 0) {
      const slot = frame.cursor;
      frame.cursor = (index.next[slot] ?? 0) - 1;
      const candidate = candidateAt(index, slot);
      if (candidate === null || candidate.gap.end > end) {
        continue;
      }
      chosen.push(candidate);
      stack.push(frameAt(candidate.gap.end));
      advanced = true;
      break;
    }
    if (!advanced && !frame.verbatimTried) {
      // 缺口都试过了：最后一个选择是原样输出一个信息等价记号（截到区间末尾）。
      frame.verbatimTried = true;
      const step = dead.has(frame.at) ? 0 : exemptAt(frame.at, end);
      if (step > 0) {
        const to = Math.min(end, frame.at + step);
        chosen.push({ verbatimStart: frame.at, verbatimEnd: to });
        stack.push(frameAt(to));
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
 * x 的引号记号（RED-P4a2 第 3 项）：tokenStart[i] 是包含位置 i 的引号记号起点 +1（0 = 不属于任何引号记号），
 * tokenEnd[i] 是它的终点。紧贴引号的奇数长度反斜杠串连同引号是一个记号（该引号的转义，深层载体里的 \\\" 同样
 * 是）；偶数长度的反斜杠串是内容（每一对是一个转义的反斜杠），引号单独成记号；不紧贴引号的反斜杠串是内容。
 * 反斜杠串按整串取奇偶，所以缺口在串中间结束时，剩下的那段也按整串判定。
 * 相邻的引号记号连成一簇（例如内层值的闭引号 \" 紧贴载体字面量的闭引号 "）：clusterStart[i]、clusterEnd[i] 是
 * 包含位置 i 的那一簇的区间，簇两侧最近的非引号字符决定簇里的记号是否在值内部。一遍线性扫描，只在第一次需要时建。
 */
interface QuoteTokens {
  tokenStart: Int32Array;
  tokenEnd: Int32Array;
  clusterStart: Int32Array;
  clusterEnd: Int32Array;
}

function lexQuoteTokens(x: string): QuoteTokens {
  const tokenStart = new Int32Array(x.length);
  const tokenEnd = new Int32Array(x.length);
  const clusterStart = new Int32Array(x.length);
  const clusterEnd = new Int32Array(x.length);
  const mark = (start: number, end: number): void => {
    for (let index = start; index < end; index++) {
      tokenStart[index] = start + 1;
      tokenEnd[index] = end;
    }
  };
  let index = 0;
  while (index < x.length) {
    const char = x[index];
    if (isQuote(char)) {
      mark(index, index + 1);
      index++;
      continue;
    }
    if (char !== '\\') {
      index++;
      continue;
    }
    let cursor = index;
    while (x[cursor] === '\\') {
      cursor++;
    }
    if (isQuote(x[cursor])) {
      if ((cursor - index) % 2 === 1) {
        mark(index, cursor + 1);
      } else {
        mark(cursor, cursor + 1);
      }
      index = cursor + 1;
      continue;
    }
    index = cursor;
  }
  for (let from = 0; from < x.length; ) {
    if (tokenStart[from] === 0) {
      from++;
      continue;
    }
    let to = from;
    while (to < x.length && (tokenStart[to] ?? 0) > 0) {
      to++;
    }
    clusterStart.fill(from, from, to);
    clusterEnd.fill(to, from, to);
    from = to;
  }
  return { tokenStart, tokenEnd, clusterStart, clusterEnd };
}

/** 区间首尾的定界引号记号长度（记号必须完整地从区间起点开始 / 在区间终点结束）。 */
function leadingQuoteLength(quotes: QuoteTokens, start: number, end: number): number {
  const tokenStart = (quotes.tokenStart[start] ?? 0) - 1;
  const tokenEnd = quotes.tokenEnd[start] ?? 0;
  return tokenStart === start && tokenEnd <= end ? tokenEnd - start : 0;
}

function trailingQuoteLength(quotes: QuoteTokens, start: number, end: number): number {
  if (end <= start) {
    return 0;
  }
  const tokenStart = (quotes.tokenStart[end - 1] ?? 0) - 1;
  const tokenEnd = quotes.tokenEnd[end - 1] ?? 0;
  return tokenStart >= start && tokenEnd === end ? end - tokenStart : 0;
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

/**
 * [start, end) 里有没有结构字符。只对铺满区间所选的缺口调用，这些缺口互不重叠且都在被遮区间内，所以总开销
 * 不超过被遮字符数（线性），不必为整篇分配前缀和数组。
 */
function hasStructureIn(marks: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    if (marks[index] === 1) {
      return true;
    }
  }
  return false;
}

/**
 * 按位置渲染。hidden 是与 x 等长的遮蔽位置（调用方已做原子标记扩展；本函数再把被部分遮住的结构记号就地扩展
 * 为整体，只会多遮），structure 是 analyzeStructure(x)，gapSets 按版本优先级排列（v3 在前）。cores 是调用方
 * 已算好的 markerCores(x)（同一个 x；缺省时在这里计算），省掉一遍全文扫描。
 */
export function renderByPositions(
  x: string,
  hidden: Uint8Array,
  structure: StructureAnalysis,
  gapSets: readonly GapSet[],
  wantOrigin = false,
  cores: ReadonlyArray<readonly [number, number]> = markerCores(x)
): RenderResult {
  const stats = emptyRenderStats();
  const output = new Output(wantOrigin);
  const inCore = new Uint8Array(x.length);
  for (const [start, end] of cores) {
    inCore.fill(1, start, end);
  }
  const tokens = structure.tokens;
  expandStructureTokens(hidden, tokens);
  expandEscapedQuotes(x, hidden);
  let tokenAtStart: Int32Array | null = null;
  if (tokens.length > 0) {
    tokenAtStart = new Int32Array(x.length + 1);
    for (const [index, token] of tokens.entries()) {
      tokenAtStart[token.start] = index + 1;
    }
  }
  const structureMarks = structure.marks;
  // 引号记号与各历史版本的遮蔽位置只在第一次遇到引号或反斜杠时才建（多数被遮区间不含它们）。
  let quotes: QuoteTokens | null = null;
  const quoteTokens = (): QuoteTokens => {
    quotes ??= lexQuoteTokens(x);
    return quotes;
  };
  // baselineMasks[i] 的第 k 位：第 k 个历史版本缺口集遮住了位置 i（缺口就是该版本的被遮区间）。检测器缺口不计入：
  // “值内部”是相对历史版本的遮蔽而言的（不变量 S 的口径），与 oracle 的 exemptPositions 一致。
  let baselineMasks: Uint8Array | null = null;
  const baselineMaskOf = (): Uint8Array => {
    if (baselineMasks !== null) {
      return baselineMasks;
    }
    const masks = new Uint8Array(x.length);
    let bit = 1;
    for (const set of gapSets) {
      if (set.revision === 'detector') {
        continue;
      }
      for (const gap of set.gaps) {
        const from = Math.max(0, gap.start);
        const to = Math.min(x.length, gap.end);
        for (let index = from; index < to; index++) {
          masks[index] = (masks[index] ?? 0) | bit;
        }
      }
      bit = (bit << 1) & 0xff;
    }
    baselineMasks = masks;
    return masks;
  };
  // 值内部的引号记号：同一个历史版本把它所在引号簇两侧最近的非引号字符都遮住了（例如 "ab\"cd\"ef" 里的 \"）。
  // 它按内容处理，不能原样输出；值边界上的定界引号至少有一侧是该版本可见的字符（或文本边界）。跳过相邻的引号
  // 记号，是因为载体重编码会合成外层字面量的引号：内层值的闭引号 \" 紧贴的载体闭引号 " 在该版本里也算被遮。
  const isInteriorQuote = (lexicon: QuoteTokens, at: number): boolean => {
    const left = (lexicon.clusterStart[at] ?? 0) - 1;
    const right = lexicon.clusterEnd[at] ?? x.length;
    if (left < 0 || right >= x.length) {
      return false;
    }
    const masks = baselineMaskOf();
    return ((masks[left] ?? 0) & (masks[right] ?? 0)) !== 0;
  };
  /**
   * 从 at 开始的信息等价记号长度（截到 end）：结构记号（整个转义序列）、输入原有的完整标记、值边界上的定界引号
   * 记号（引号可以在区间之外：奇数长度的反斜杠串是那个引号的转义，与引号一起视为结构）。0 表示 at 是内容位置。
   * 口径与 test/fixtures/redaction-catalog/legacyRegressionOracle.ts 的 exemptPositions 相同。
   */
  const exemptAt = (at: number, end: number): number => {
    // tokenAtStart 存 记号下标+1，0 表示该位置不是记号起点。
    const tokenIndex = tokenAtStart === null ? -1 : (tokenAtStart[at] ?? 0) - 1;
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
    if (!isQuote(char) && char !== '\\') {
      return 0;
    }
    const lexicon = quoteTokens();
    const quoteStart = (lexicon.tokenStart[at] ?? 0) - 1;
    if (quoteStart < 0) {
      // 不转义引号的反斜杠串（偶数长度、或后面不是引号）是内容。
      return 0;
    }
    const quoteEnd = lexicon.tokenEnd[at] ?? at;
    if (isInteriorQuote(lexicon, at)) {
      return 0;
    }
    if (char === '\\' && (quoteEnd - 1 - at) % 2 === 0) {
      // 缺口在奇数长度反斜杠串的奇数位置结束：剩下的反斜杠是偶数个，原样写出后引号就不再被转义。只允许从成对
      // 转义的边界（剩余奇数个）起原样步。
      return 0;
    }
    if (isQuote(char) && quoteStart < at && hidden[at - 1] === 1) {
      // 转义这个引号的反斜杠是被遮的，已经被前一个缺口的合成文本吞掉（转义单元已整体扩进被遮区间，见
      // expandEscapedQuotes）：单独写出引号会留下没有转义的引号，载体 JSON 随之失效（复查意见 3 的同一类问题）。
      // 不从引号起原样步，让铺排回溯到别的缺口，或走新标记路径（它整体保留区间末尾的定界引号记号）。
      return 0;
    }
    return Math.min(quoteEnd, end) - at;
  };
  // 原样步不跨过输入原有的标记：含内容的区间触到标记时，标记随区间一起被同一个标记取代（原子标记），
  // 不单独重出，否则 password=SYNTHETIChead[redacted] 会渲染成两个相邻标记。
  const verbatimStepAt = (at: number, end: number): number =>
    inCore[at] === 1 ? 0 : exemptAt(at, end);
  const dead = new Set<number>();
  let byStart: CandidateIndex | null = null;
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
    let content = false;
    for (let at = start; at < end; ) {
      const step = exemptAt(at, end);
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
      byStart = candidatesByStart(x.length, gapSets, stats);
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
        if (!hasStructureIn(structureMarks, gap.start, gap.end)) {
          // 缺口里没有结构字符：合成文本原样沿用（它自带的换行记号是版本自己写出的）。
          output.synth(gap.synth);
          continue;
        }
        const missing = missingTokens(structureTokensIn(tokens, gap.start, gap.end), shape);
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
    // 新标记路径只保留区间首尾的定界引号记号（记号完整地落在区间边界上，且按簇判定不在值内部）；偶数长度反斜杠串
    // 里的反斜杠是内容，不随引号保留。
    const lexicon = quoteTokens();
    const lead =
      start < end && !isInteriorQuote(lexicon, start) ? leadingQuoteLength(lexicon, start, end) : 0;
    const trail =
      lead >= end - start || isInteriorQuote(lexicon, end - 1)
        ? 0
        : trailingQuoteLength(lexicon, start + lead, end);
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
