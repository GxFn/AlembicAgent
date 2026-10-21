/**
 * 脱敏阶段 1：从某个版本的输出 y = v(x) 反推它遮住了输入 x 的哪些字符（设计 4.3 节、附录 B）。
 *
 * 只把版本当黑盒：输出被切成“保留段”（原样来自 x 的子串）与“合成段”（标记及其两侧吸收的引号、换行），
 * 再把保留段夹逼对齐回 x。正确性依赖三条前提，全部由测试锁定：
 * - O1 词表封闭：任一版本的合成输出都落在 T_ABS 词法内（核心标记 + 可带反斜杠的引号 + 换行与转义换行），
 *   标记之外的字符都是 x 的原样子序列，顺序不变。
 * - O2 换行守恒：v0、v2、v3 逐字符保留裸 \r、\n（只会在标记之后原序重出），所以输出第 k 行对应输入第 k 行，
 *   每行单独对齐；v1 会在 JSON 引号值里吞掉裸换行（D3 不计入底线），换行数不一致时退回整段对齐。
 * - 重编码：v2/v3 会把内层被改写的 JSON 字面量用 JSON.stringify 重新编码。规范编码的字面量重编码后保留字符
 *   逐字节不变；只有出现 \/、\uXXXX 或孤立代理时字节会变。非规范载体守卫按行兜住：被改写且含这些序列的行，
 *   超集取整行、子集不作任何断言。字面量不跨行（JSON.parse 拒绝裸换行），所以按行兜底覆盖设计所说的
 *   “整个字面量内部”，也不受字段替换后字面量切分位置变化的影响。
 *
 * 两个方向：
 * - hiddenSuperset：v 可能遮住的字符（超集）。用于历史版本，宁多勿少，少一个就是泄漏。
 * - hiddenSubset：v 一定遮住的字符（子集）。用于现行规则与最终输出，宁少勿多，多一个就是泄漏。
 *
 * 本模块是纯函数，不持有模块级可变状态；所有正则在调用时构造。词法扫描用 indexOf 实现（与下方 T_ABS、T_SUB
 * 正则逐 token 等价，由属性测试锁定），避免可选前缀让正则在每个位置都重试。
 */

/** 封闭标记词表（设计 4.6 节、附录 C）。[redacted-unaligned] 是阶段 1 唯一新增的失败即关标记。 */
export const REDACTION_MARKERS: readonly string[] = [
  '[redacted]',
  '[redacted-api-key]',
  '[redacted-google-api-key]',
  '[redacted-token]',
  '[redacted-private-key]',
  '[redacted-nested-value]',
  '[redacted-unaligned]',
];

const CORE_SOURCE = String.raw`\[redacted(?:-nested-value|-private-key|-google-api-key|-api-key|-token|-unaligned)?\]`;
/** 宽词法：吸收标记两侧（可带转义）的引号与其后的换行、转义换行。超集、补遮定位都用它。 */
export const T_ABS_SOURCE = String.raw`((?:\\*["'])?)(${CORE_SOURCE})((?:\\*["'])?)((?:\\+[nr]|\r|\n)*)`;
/** 窄词法：只吸收标记后的裸换行。子集计算时作为额外的交叉校验，只会让子集更小。 */
export const T_SUB_SOURCE = String.raw`()(${CORE_SOURCE})()([\r\n]*)`;

export type MarkerLexicon = 'abs' | 'sub';

export interface MarkerToken {
  start: number;
  end: number;
  /** 标记前被吸收的引号部分（可能是原文保留的，也可能是合成的）。 */
  pre: string;
  core: string;
  /** 标记后被吸收的引号部分。 */
  quote: string;
  /** 标记后被吸收的裸换行与转义换行。 */
  tail: string;
}

/**
 * 对齐器变异注入点：只供 test/redaction-legacy-floor.test.ts 的变异测试使用，生产调用不传。
 * 每个变异体都是一种曾被讨论过的错误实现，精确 oracle 必须把它们全部判为失败。
 */
export type AlignerMutation =
  | 'swap-earliest-latest'
  | 'drop-anchors'
  | 'ignore-wild'
  | 'skip-inner-absorbed'
  | 'no-subset-trim';

export interface AlignOptions {
  mutation?: AlignerMutation;
  /** 预先算好的 x 行表（同一轮里多次对齐共用）。 */
  xLines?: LineTable;
  /** 只为这些行生成放置计划（后置条件只复查有残差的行）；其余行不参与结果。 */
  onlyLines?: ReadonlySet<number>;
}

export interface SpanOptions extends AlignOptions {
  /** 版本会重编码 JSON 载体（v2、v3）：启用非规范载体守卫。 */
  reencodes: boolean;
  /** 子集计算时额外视为不可信的行（后置条件沿用现行规则输出上的守卫结果）。 */
  untrustedLines?: ReadonlySet<number>;
}

export interface SpanStats {
  /** 保留段无法放回输入、整行按“未知”处理的行数。 */
  wildLines: number;
  /** 非规范载体守卫命中的行数。 */
  guardedLines: number;
  /** 换行不守恒、退回整段对齐（1）或否（0）。 */
  newlineMismatch: number;
  /** 放置不唯一的保留段个数。 */
  ambiguousPieces: number;
}

export interface SpanResult {
  /** 与 x 等长；1 表示该位置属于集合。 */
  marks: Uint8Array;
  stats: SpanStats;
}

export interface LineTable {
  starts: number[];
  ends: number[];
}

/** 一行（或整段模式下的全文）里的输出元素。 */
export interface YItem {
  kind: 'piece' | 'tok' | 'cont';
  /** 在 y 中的区间。 */
  start: number;
  end: number;
  /** tok：标记前吸收的引号。 */
  pre: string;
  /** tok：标记后吸收的引号与本行内的转义换行；cont：整段（上一行标记延续过来的转义换行）。 */
  post: string;
  /** tok：核心标记在 y 中的区间；其余为 -1。 */
  coreStart: number;
  coreEnd: number;
}

export interface YLine {
  start: number;
  end: number;
  /** 行首处在上一行延续过来的遮蔽区内（上一行以合成段结束）。 */
  openStart: boolean;
  items: YItem[];
}

export interface GapGroup {
  items: YItem[];
  /** 左侧保留段下标；-1 表示行首。 */
  left: number;
  /** 右侧保留段下标；-1 表示行尾。 */
  right: number;
  openStart: boolean;
  /** 紧贴左边界、可能是原文保留的吸收字符（左边界是保留段或闭合行首时才有）。 */
  leftAbsorbed: string;
  /** 紧贴右边界、可能是原文保留的吸收字符。 */
  rightAbsorbed: string;
  /** 组内还有不贴边界的吸收字符（相邻合成段合并、或开放行首后的标记）。 */
  innerAbsorbed: boolean;
}

export interface LinePlan {
  index: number;
  xStart: number;
  xEnd: number;
  line: YLine;
  /** 输出行与输入行逐字相同：该行没有任何字符被遮。 */
  identical: boolean;
  wild: boolean;
  pieces: YItem[];
  /** 每个保留段在 x 中的最早、最晚起点（绝对位置）。 */
  earliest: number[];
  latest: number[];
  groups: GapGroup[];
}

export interface Alignment {
  mode: 'lines' | 'whole';
  lexicon: MarkerLexicon;
  xLines: LineTable;
  tokens: MarkerToken[];
  plans: LinePlan[];
}

function isNewline(char: string | undefined): boolean {
  return char === '\n' || char === '\r';
}

/** 按每个 \r、\n 字符切行（\r\n 算两次换行）：版本逐字符保留换行，按字符计数才能一一对应。 */
export function splitLines(text: string): LineTable {
  const starts: number[] = [0];
  const ends: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) {
      ends.push(index);
      starts.push(index + 1);
    }
  }
  ends.push(text.length);
  return { starts, ends };
}

/** 参照实现：直接用 T_ABS / T_SUB 正则切分。只供测试比对 lexMarkers 的等价性。 */
export function lexMarkersByRegex(text: string, lexicon: MarkerLexicon): MarkerToken[] {
  const pattern = new RegExp(lexicon === 'abs' ? T_ABS_SOURCE : T_SUB_SOURCE, 'g');
  const tokens: MarkerToken[] = [];
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      pre: match[1] ?? '',
      core: match[2] ?? '',
      quote: match[3] ?? '',
      tail: match[4] ?? '',
    });
  }
  return tokens;
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

function isQuoteChar(char: string | undefined): boolean {
  return char === '"' || char === "'";
}

function coreLengthAt(text: string, at: number): number {
  const after = at + '[redacted'.length;
  for (const suffix of CORE_SUFFIXES) {
    if (text.startsWith(suffix, after)) {
      return '[redacted'.length + suffix.length;
    }
  }
  return 0;
}

/**
 * 按 T_ABS / T_SUB 词法切出合成标记。与 lexMarkersByRegex 逐 token 等价：全局正则从上一个 token 的末尾
 * 继续扫描，取最左匹配；前缀只能是紧贴核心标记的一个引号及其前面的整串反斜杠（不越过上一个 token），
 * 后缀先取“反斜杠串 + 引号”（没有引号时整组为空），再贪婪吸收裸换行与转义换行（T_SUB 只吸收裸换行）。
 */
export function lexMarkers(text: string, lexicon: MarkerLexicon): MarkerToken[] {
  const wide = lexicon === 'abs';
  const tokens: MarkerToken[] = [];
  let previousEnd = 0;
  let from = 0;
  for (let at = text.indexOf('[redacted', from); at >= 0; at = text.indexOf('[redacted', from)) {
    const coreLength = coreLengthAt(text, at);
    if (coreLength === 0) {
      from = at + 1;
      continue;
    }
    const coreEnd = at + coreLength;
    let start = at;
    if (wide && at - 1 >= previousEnd && isQuoteChar(text[at - 1])) {
      start = at - 1;
      while (start - 1 >= previousEnd && text[start - 1] === '\\') {
        start--;
      }
    }
    let quoteEnd = coreEnd;
    if (wide) {
      let cursor = coreEnd;
      while (text[cursor] === '\\') {
        cursor++;
      }
      if (isQuoteChar(text[cursor])) {
        quoteEnd = cursor + 1;
      }
    }
    let end = quoteEnd;
    for (;;) {
      const char = text[end];
      if (char === '\n' || char === '\r') {
        end++;
        continue;
      }
      if (wide && char === '\\') {
        let cursor = end;
        while (text[cursor] === '\\') {
          cursor++;
        }
        if (text[cursor] === 'n' || text[cursor] === 'r') {
          end = cursor + 1;
          continue;
        }
      }
      break;
    }
    tokens.push({
      start,
      end,
      pre: text.slice(start, at),
      core: text.slice(at, coreEnd),
      quote: text.slice(coreEnd, quoteEnd),
      tail: text.slice(quoteEnd, end),
    });
    previousEnd = end;
    from = end;
  }
  return tokens;
}

function pieceItem(start: number, end: number): YItem {
  return { kind: 'piece', start, end, pre: '', post: '', coreStart: -1, coreEnd: -1 };
}

/**
 * 把 y 按裸换行切行，并标出每行的保留段与合成段。合成段内部的裸换行把它切成多行：第一行放标记本体，
 * 后续行只剩延续的转义换行（cont），并且这些行的行首是“开放”的——遮蔽区可能从上一行延续过来。
 * whole=true 时不切行（整段对齐），合成段的换行都留在 post 里。
 */
export function buildYLines(y: string, tokens: MarkerToken[], whole: boolean): YLine[] {
  const lines: YLine[] = [];
  let items: YItem[] = [];
  let openStart = false;
  let lineStart = 0;
  const finishLine = (end: number, endsInsideToken: boolean): void => {
    lines.push({ start: lineStart, end, openStart, items });
    items = [];
    openStart = endsInsideToken;
    lineStart = end + 1;
  };
  let position = 0;
  let tokenIndex = 0;
  while (position < y.length) {
    const token = tokens[tokenIndex];
    if (token !== undefined && token.start === position) {
      const coreStart = token.start + token.pre.length;
      const coreEnd = coreStart + token.core.length;
      if (whole) {
        items.push({
          kind: 'tok',
          start: token.start,
          end: token.end,
          pre: token.pre,
          post: token.quote + token.tail,
          coreStart,
          coreEnd,
        });
      } else {
        let segmentStart = token.start;
        let first = true;
        for (let cursor = coreEnd; cursor <= token.end; cursor++) {
          if (cursor === token.end || isNewline(y[cursor])) {
            if (first) {
              items.push({
                kind: 'tok',
                start: segmentStart,
                end: cursor,
                pre: token.pre,
                post: y.slice(coreEnd, cursor),
                coreStart,
                coreEnd,
              });
              first = false;
            } else if (cursor > segmentStart) {
              items.push({
                kind: 'cont',
                start: segmentStart,
                end: cursor,
                pre: '',
                post: y.slice(segmentStart, cursor),
                coreStart: -1,
                coreEnd: -1,
              });
            }
            if (cursor < token.end) {
              finishLine(cursor, true);
              segmentStart = cursor + 1;
            }
          }
        }
      }
      position = token.end;
      tokenIndex++;
      continue;
    }
    if (!whole && isNewline(y[position])) {
      finishLine(position, false);
      position++;
      continue;
    }
    const limit = token === undefined ? y.length : token.start;
    let end = position;
    while (end < limit && (whole || !isNewline(y[end]))) {
      end++;
    }
    items.push(pieceItem(position, end));
    position = end;
  }
  lines.push({ start: lineStart, end: y.length, openStart, items });
  return lines;
}

/** 第一个结束位置在 position 之后的 token 下标（tokens 有序且互不重叠）。 */
function firstTokenEndingAfter(tokens: MarkerToken[], position: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((tokens[middle]?.end ?? 0) > position) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function newlineInsideToken(tokens: MarkerToken[], position: number): boolean {
  const token = tokens[firstTokenEndingAfter(tokens, position)];
  return token !== undefined && token.start <= position;
}

function nextNewline(y: string, from: number, limit: number): number {
  for (let index = from; index < limit; index++) {
    const code = y.charCodeAt(index);
    if (code === 10 || code === 13) {
      return index;
    }
  }
  return limit;
}

/**
 * 只为一行 [start, end) 构造输出元素，语义与 buildYLines 的逐行结果相同：跨行合成段在起始行是 tok，
 * 在后续行是 cont（两次裸换行之间的转义换行）。用于只复查少数行时避免为全文建元素。
 */
function buildYLineAt(
  y: string,
  tokens: MarkerToken[],
  start: number,
  end: number,
  openStart: boolean
): YLine {
  const items: YItem[] = [];
  let position = start;
  let tokenIndex = firstTokenEndingAfter(tokens, start);
  while (position < end) {
    const token = tokens[tokenIndex];
    if (token !== undefined && token.start <= position) {
      const coreStart = token.start + token.pre.length;
      const coreEnd = coreStart + token.core.length;
      if (token.start === position) {
        const segmentEnd = nextNewline(y, coreEnd, token.end);
        items.push({
          kind: 'tok',
          start: position,
          end: segmentEnd,
          pre: token.pre,
          post: y.slice(coreEnd, segmentEnd),
          coreStart,
          coreEnd,
        });
        position = segmentEnd;
      } else {
        const segmentEnd = nextNewline(y, position, token.end);
        if (segmentEnd > position) {
          items.push({
            kind: 'cont',
            start: position,
            end: segmentEnd,
            pre: '',
            post: y.slice(position, segmentEnd),
            coreStart: -1,
            coreEnd: -1,
          });
        }
        position = segmentEnd;
      }
      if (position >= token.end) {
        tokenIndex++;
      }
      continue;
    }
    const limit = token === undefined ? end : Math.min(token.start, end);
    items.push(pieceItem(position, limit));
    position = limit;
  }
  return { start, end, openStart, items };
}

function groupItems(line: YLine): { pieces: YItem[]; groups: GapGroup[] } {
  const pieces: YItem[] = [];
  const groups: GapGroup[] = [];
  let current: YItem[] | null = line.openStart ? [] : null;
  let currentLeft = -1;
  let currentOpen = line.openStart;
  const close = (right: number): void => {
    if (current === null) {
      return;
    }
    groups.push(describeGroup(current, currentLeft, right, currentOpen));
    current = null;
  };
  for (const item of line.items) {
    if (item.kind === 'piece') {
      close(pieces.length);
      pieces.push(item);
      continue;
    }
    if (current === null) {
      current = [];
      currentLeft = pieces.length - 1;
      currentOpen = pieces.length === 0 && line.openStart;
    }
    current.push(item);
  }
  close(-1);
  return { pieces, groups };
}

function absorbedLength(item: YItem): number {
  return item.kind === 'cont' ? item.post.length : item.pre.length + item.post.length;
}

function describeGroup(items: YItem[], left: number, right: number, openStart: boolean): GapGroup {
  const first = items[0];
  const last = items[items.length - 1];
  // 开放行首没有左侧保留段可以贴靠：此时组首的吸收字符只能当作“组内”处理。
  const leftAbsorbed = !openStart && first !== undefined && first.kind === 'tok' ? first.pre : '';
  let rightAbsorbed = '';
  if (last !== undefined) {
    rightAbsorbed = last.post;
  }
  let total = 0;
  for (const item of items) {
    total += absorbedLength(item);
  }
  // 单个合成段时左、右吸收部分互不重叠；开放行首下单个 cont 只有右侧部分。
  const designated = leftAbsorbed.length + rightAbsorbed.length;
  return {
    items,
    left,
    right,
    openStart,
    leftAbsorbed,
    rightAbsorbed,
    innerAbsorbed: total > designated,
  };
}

/** 夹逼放置：每个保留段的最早、最晚起点。任何合法放置 P 都满足 earliest ≤ P ≤ latest。 */
function placePieces(
  x: string,
  xStart: number,
  xEnd: number,
  y: string,
  line: YLine,
  pieces: YItem[],
  mutation: AlignerMutation | undefined
): { earliest: number[]; latest: number[]; wild: boolean } {
  const count = pieces.length;
  const earliest = new Array<number>(count).fill(-1);
  const latest = new Array<number>(count).fill(-1);
  const anchors = mutation !== 'drop-anchors';
  const firstItem = line.items[0];
  const lastItem = line.items[line.items.length - 1];
  const anchoredStart = anchors && !line.openStart && firstItem?.kind === 'piece';
  const anchoredEnd = anchors && lastItem?.kind === 'piece';
  const texts = pieces.map((piece) => y.slice(piece.start, piece.end));
  const segment = x.slice(xStart, xEnd);

  let cursor = 0;
  for (let index = 0; index < count; index++) {
    const text = texts[index] ?? '';
    let found: number;
    if (index === 0 && anchoredStart) {
      found = segment.startsWith(text) ? 0 : -1;
    } else if (index === count - 1 && anchoredEnd) {
      const anchor = segment.length - text.length;
      found = anchor >= cursor && segment.endsWith(text) ? anchor : -1;
    } else {
      found = segment.indexOf(text, cursor);
    }
    if (found < 0) {
      if (mutation === 'ignore-wild') {
        // 变异体：把放不下的段当作就地保留，等于少算一段遮蔽。
        found = Math.min(cursor, segment.length);
      } else {
        return { earliest, latest, wild: true };
      }
    }
    earliest[index] = found;
    cursor = found + text.length;
  }
  if (anchoredEnd && count > 0 && cursor !== segment.length && mutation !== 'ignore-wild') {
    return { earliest, latest, wild: true };
  }

  let bound = segment.length;
  for (let index = count - 1; index >= 0; index--) {
    const text = texts[index] ?? '';
    let found: number;
    if (index === count - 1 && anchoredEnd) {
      found = segment.length - text.length;
    } else if (index === 0 && anchoredStart) {
      found = text.length <= bound ? 0 : -1;
    } else {
      const from = bound - text.length;
      found = from < 0 ? -1 : segment.lastIndexOf(text, from);
    }
    if (found < 0) {
      if (mutation === 'ignore-wild') {
        found = Math.max(0, Math.min(bound - text.length, earliest[index] ?? 0));
      } else {
        return { earliest, latest, wild: true };
      }
    }
    latest[index] = found;
    bound = found;
  }
  for (let index = 0; index < count; index++) {
    const low = earliest[index] ?? -1;
    const high = latest[index] ?? -1;
    if (low > high && mutation !== 'ignore-wild') {
      return { earliest, latest, wild: true };
    }
    earliest[index] = low + xStart;
    latest[index] = high + xStart;
  }
  return { earliest, latest, wild: false };
}

function planFor(
  x: string,
  y: string,
  index: number,
  xStart: number,
  xEnd: number,
  line: YLine,
  compareText: boolean,
  mutation: AlignerMutation | undefined
): LinePlan {
  const identical = compareText && x.slice(xStart, xEnd) === y.slice(line.start, line.end);
  if (identical) {
    return {
      index,
      xStart,
      xEnd,
      line,
      identical,
      wild: false,
      pieces: [],
      earliest: [],
      latest: [],
      groups: [],
    };
  }
  const { pieces, groups } = groupItems(line);
  // 闭合行首、没有任何输出元素的行：输入行必须为空，否则对不上。
  if (line.items.length === 0 && !line.openStart) {
    return {
      index,
      xStart,
      xEnd,
      line,
      identical: false,
      wild: xEnd > xStart,
      pieces,
      earliest: [],
      latest: [],
      groups,
    };
  }
  const placed = placePieces(x, xStart, xEnd, y, line, pieces, mutation);
  return {
    index,
    xStart,
    xEnd,
    line,
    identical: false,
    wild: placed.wild,
    pieces,
    earliest: placed.earliest,
    latest: placed.latest,
    groups,
  };
}

/** 夹逼对齐：逐行（换行不守恒时整段）求保留段在 x 中的放置区间。逐字相同的行不建元素。 */
export function alignToInput(
  x: string,
  y: string,
  lexicon: MarkerLexicon,
  options: AlignOptions = {}
): Alignment {
  const xLines = options.xLines ?? splitLines(x);
  const yTable = splitLines(y);
  const tokens = lexMarkers(y, lexicon);
  if (yTable.starts.length !== xLines.starts.length) {
    const whole = buildYLines(y, tokens, true);
    const line = whole[0] ?? { start: 0, end: y.length, openStart: false, items: [] };
    return {
      mode: 'whole',
      lexicon,
      xLines,
      tokens,
      plans: [planFor(x, y, 0, 0, x.length, line, false, options.mutation)],
    };
  }
  const plans: LinePlan[] = [];
  const indices =
    options.onlyLines === undefined ? null : [...options.onlyLines].sort((a, b) => a - b);
  const count = indices === null ? yTable.starts.length : indices.length;
  for (let position = 0; position < count; position++) {
    const index = indices === null ? position : (indices[position] ?? -1);
    const yStart = yTable.starts[index];
    const yEnd = yTable.ends[index];
    const xStart = xLines.starts[index];
    const xEnd = xLines.ends[index];
    if (yStart === undefined || yEnd === undefined || xStart === undefined || xEnd === undefined) {
      continue;
    }
    if (xEnd - xStart === yEnd - yStart && x.slice(xStart, xEnd) === y.slice(yStart, yEnd)) {
      plans.push(identicalPlan(index, xStart, xEnd, yStart, yEnd));
      continue;
    }
    const openStart = index > 0 && newlineInsideToken(tokens, yStart - 1);
    const line = buildYLineAt(y, tokens, yStart, yEnd, openStart);
    plans.push(planFor(x, y, index, xStart, xEnd, line, false, options.mutation));
  }
  return { mode: 'lines', lexicon, xLines, tokens, plans };
}

function identicalPlan(
  index: number,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number
): LinePlan {
  return {
    index,
    xStart,
    xEnd,
    line: { start: yStart, end: yEnd, openStart: false, items: [] },
    identical: true,
    wild: false,
    pieces: [],
    earliest: [],
    latest: [],
    groups: [],
  };
}

/** 非规范编码的痕迹：\/、任何 \u 转义（含嵌套层的多重转义）、孤立代理。 */
export function hasNonCanonicalMarker(text: string): boolean {
  return (
    /\\[u/]/.test(text) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
  );
}

function lcpAt(absorbed: string, x: string, from: number, limit: number): number {
  let count = 0;
  while (count < absorbed.length && from + count < limit && absorbed[count] === x[from + count]) {
    count++;
  }
  return count;
}

function lcsAt(absorbed: string, x: string, lowerBound: number, to: number): number {
  let count = 0;
  while (
    count < absorbed.length &&
    to - count - 1 >= lowerBound &&
    absorbed[absorbed.length - 1 - count] === x[to - count - 1]
  ) {
    count++;
  }
  return count;
}

/** 合成段可能吸收的原文字符：引号、反斜杠、转义换行的字母、裸换行。 */
function isAbsorbableAt(x: string, index: number): boolean {
  const char = x[index];
  if (char === '"' || char === "'" || char === '\\' || char === '\n' || char === '\r') {
    return true;
  }
  return (char === 'n' || char === 'r') && x[index - 1] === '\\';
}

interface GroupBounds {
  outerLeft: number;
  outerRight: number;
  sureLeft: number;
  sureRight: number;
  leftExact: boolean;
  rightExact: boolean;
}

function groupBounds(
  plan: LinePlan,
  group: GapGroup,
  mutation: AlignerMutation | undefined
): GroupBounds {
  const leftPiece = group.left >= 0 ? plan.pieces[group.left] : undefined;
  const leftLength = leftPiece === undefined ? 0 : leftPiece.end - leftPiece.start;
  const leftEarliest = group.left >= 0 ? (plan.earliest[group.left] ?? plan.xStart) : plan.xStart;
  const leftLatest = group.left >= 0 ? (plan.latest[group.left] ?? plan.xStart) : plan.xStart;
  const rightEarliest = group.right >= 0 ? (plan.earliest[group.right] ?? plan.xEnd) : plan.xEnd;
  const rightLatest = group.right >= 0 ? (plan.latest[group.right] ?? plan.xEnd) : plan.xEnd;
  const swap = mutation === 'swap-earliest-latest';
  const outerLeft = group.left >= 0 ? (swap ? leftLatest : leftEarliest) + leftLength : plan.xStart;
  const outerRight = group.right >= 0 ? (swap ? rightEarliest : rightLatest) : plan.xEnd;
  const sureLeft = group.left >= 0 ? (swap ? leftEarliest : leftLatest) + leftLength : plan.xStart;
  const sureRight = group.right >= 0 ? (swap ? rightLatest : rightEarliest) : plan.xEnd;
  const leftExact = group.left >= 0 ? leftEarliest === leftLatest : !group.openStart;
  const rightExact = group.right >= 0 ? rightEarliest === rightLatest : true;
  return { outerLeft, outerRight, sureLeft, sureRight, leftExact, rightExact };
}

/** 缺口在任何合法放置下可能覆盖的最大区间（不做边界修剪）。补遮时用它判断吸收字符是否可能命中残差。 */
export function groupOuterRange(plan: LinePlan, group: GapGroup): [number, number] {
  const bounds = groupBounds(plan, group, undefined);
  return [bounds.outerLeft, Math.max(bounds.outerLeft, bounds.outerRight)];
}

/**
 * 吸收字符串切成的记号：一个引号（可带整串反斜杠）、一个转义换行（整串反斜杠加 n/r）或一个裸换行。
 * 词法与 T_ABS 的 pre/quote/tail 分组一致。
 */
function absorbedTokens(absorbed: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < absorbed.length) {
    const char = absorbed[index];
    if (char === '\\') {
      let cursor = index;
      while (absorbed[cursor] === '\\') {
        cursor++;
      }
      const next = absorbed[cursor];
      const end = isQuoteChar(next) || next === 'n' || next === 'r' ? cursor + 1 : cursor;
      tokens.push(absorbed.slice(index, end));
      index = end;
      continue;
    }
    tokens.push(char ?? '');
    index++;
  }
  return tokens;
}

/** x 中从 from 开始、不越过 limit 的一个可吸收记号；不是记号时为 null。反斜杠串取最长，记号边界因此唯一。 */
function absorbableTokenAt(x: string, from: number, limit: number): string | null {
  const char = x[from];
  if (from >= limit || char === undefined) {
    return null;
  }
  if (char === '\n' || char === '\r' || isQuoteChar(char)) {
    return char;
  }
  if (char !== '\\') {
    return null;
  }
  let cursor = from;
  while (cursor < limit && x[cursor] === '\\') {
    cursor++;
  }
  const next = x[cursor];
  if (cursor < limit && (isQuoteChar(next) || next === 'n' || next === 'r')) {
    return x.slice(from, cursor + 1);
  }
  return null;
}

/** x 中结束于 to、不早于 lowerBound 的一个可吸收记号；不是记号时为 null。反斜杠串向前取最长。 */
function absorbableTokenEndingAt(x: string, lowerBound: number, to: number): string | null {
  const last = x[to - 1];
  if (to <= lowerBound || last === undefined) {
    return null;
  }
  if (last === '\n' || last === '\r') {
    return last;
  }
  if (!isQuoteChar(last) && last !== 'n' && last !== 'r') {
    return null;
  }
  let start = to - 1;
  while (start - 1 >= lowerBound && x[start - 1] === '\\') {
    start--;
  }
  if (isQuoteChar(last)) {
    return x.slice(start, to);
  }
  // n/r 只有带反斜杠才是转义换行记号；裸露的 n/r 是值的末字符，不能与记号对到同一位置。
  return start < to - 1 ? x.slice(start, to) : null;
}

/**
 * 边界修剪 R-Q 的记号版（复查意见 1）：吸收字符串从左（右）边界起整记号与 x 相同的长度。按字符比较会把
 * 转义换行记号 \n 的末字符 n 与被遮值的末字符 n 当成同一位置，超集漏掉那个 n；按记号比较时，x 里的反斜杠串
 * 取最长，所以 \n 不会与 \\n 或裸露的 n 对上。
 */
function tokenPrefixLength(absorbed: string, x: string, from: number, limit: number): number {
  let cursor = from;
  for (const token of absorbedTokens(absorbed)) {
    if (absorbableTokenAt(x, cursor, limit) !== token) {
      break;
    }
    cursor += token.length;
  }
  return cursor - from;
}

function tokenSuffixLength(absorbed: string, x: string, lowerBound: number, to: number): number {
  let cursor = to;
  const tokens = absorbedTokens(absorbed);
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index] ?? '';
    if (absorbableTokenEndingAt(x, lowerBound, cursor) !== token) {
      break;
    }
    cursor -= token.length;
  }
  return to - cursor;
}

/**
 * 超集里的一个缺口区间，含边界修剪 R-Q：贴着放置唯一的保留段（或行界）时，合成段吸收的引号、转义换行
 * 若与 x 在同一边界上的记号相同，就算“同一位置可见”（信息等价），从区间中扣除。不修剪会让被多算的闭引号
 * 经不动点放大（UNTERMINATED 一直吞到文末）。修剪按整个记号进行，见 tokenPrefixLength。
 */
export function groupSupersetRange(
  x: string,
  plan: LinePlan,
  group: GapGroup,
  mutation?: AlignerMutation
): [number, number] {
  const bounds = groupBounds(plan, group, mutation);
  let left = bounds.outerLeft;
  let right = bounds.outerRight;
  if (bounds.leftExact && group.leftAbsorbed.length > 0) {
    left += tokenPrefixLength(group.leftAbsorbed, x, left, right);
  }
  if (bounds.rightExact && group.rightAbsorbed.length > 0) {
    right -= tokenSuffixLength(group.rightAbsorbed, x, left, right);
  }
  return [left, Math.max(left, right)];
}

/**
 * 子集里的一个缺口区间：只取任何合法放置下都处在两段之间的位置，再扣掉可能是原文保留的吸收字符。
 * 放置唯一时只扣与 x 边界逐字相同的那部分（最长公共前缀/后缀）；不唯一时整段扣掉。
 */
export function groupSubsetRange(
  x: string,
  plan: LinePlan,
  group: GapGroup,
  mutation?: AlignerMutation
): [number, number] {
  const bounds = groupBounds(plan, group, mutation);
  const left = bounds.sureLeft;
  const right = bounds.sureRight;
  if (left >= right) {
    return [left, left];
  }
  if (mutation === 'no-subset-trim') {
    return [left, right];
  }
  let trimLeft = 0;
  if (group.leftAbsorbed.length > 0) {
    trimLeft = bounds.leftExact
      ? lcpAt(group.leftAbsorbed, x, left, right)
      : group.leftAbsorbed.length;
  }
  let trimRight = 0;
  if (group.rightAbsorbed.length > 0) {
    trimRight = bounds.rightExact
      ? lcsAt(group.rightAbsorbed, x, left + trimLeft, right)
      : group.rightAbsorbed.length;
  }
  const start = Math.min(right, left + trimLeft);
  return [start, Math.max(start, right - trimRight)];
}

function markRange(marks: Uint8Array, start: number, end: number): void {
  for (let index = start; index < end; index++) {
    marks[index] = 1;
  }
}

function emptyStats(): SpanStats {
  return { wildLines: 0, guardedLines: 0, newlineMismatch: 0, ambiguousPieces: 0 };
}

function countAmbiguous(plan: LinePlan): number {
  let count = 0;
  for (let index = 0; index < plan.pieces.length; index++) {
    if (plan.earliest[index] !== plan.latest[index]) {
      count++;
    }
  }
  return count;
}

/** 非规范载体守卫：会重编码的版本改写了一行，而这一行带有非规范编码痕迹。 */
export function isGuardedLine(
  x: string,
  plan: LinePlan,
  alignment: Alignment,
  reencodes: boolean
): boolean {
  if (!reencodes || plan.identical) {
    return false;
  }
  const text = alignment.mode === 'whole' ? x : x.slice(plan.xStart, plan.xEnd);
  return hasNonCanonicalMarker(text);
}

/** 由已算好的对齐求超集。 */
export function supersetFromAlignment(
  x: string,
  alignment: Alignment,
  options: SpanOptions
): SpanResult {
  const marks = new Uint8Array(x.length);
  const stats = emptyStats();
  stats.newlineMismatch = alignment.mode === 'whole' ? 1 : 0;
  for (const plan of alignment.plans) {
    if (plan.identical) {
      continue;
    }
    const guarded = isGuardedLine(x, plan, alignment, options.reencodes);
    if (guarded) {
      stats.guardedLines++;
    }
    if (plan.wild) {
      stats.wildLines++;
    }
    if (plan.wild || guarded) {
      // 对不上或可能被重编码：整行都算可能被遮。
      markRange(marks, plan.xStart, plan.xEnd);
      continue;
    }
    stats.ambiguousPieces += countAmbiguous(plan);
    for (const group of plan.groups) {
      const [start, end] = groupSupersetRange(x, plan, group, options.mutation);
      markRange(marks, start, end);
    }
  }
  return { marks, stats };
}

/** v 可能遮住的字符（超集）。 */
export function hiddenSuperset(x: string, y: string, options: SpanOptions): SpanResult {
  if (x === y) {
    return { marks: new Uint8Array(x.length), stats: emptyStats() };
  }
  return supersetFromAlignment(x, alignToInput(x, y, 'abs', options), options);
}

function subsetMarksFor(
  x: string,
  alignment: Alignment,
  options: SpanOptions,
  stats: SpanStats | null
): Uint8Array {
  const marks = new Uint8Array(x.length);
  for (const plan of alignment.plans) {
    if (plan.identical) {
      continue;
    }
    const guarded =
      isGuardedLine(x, plan, alignment, options.reencodes) ||
      (alignment.mode === 'lines' && options.untrustedLines?.has(plan.index) === true);
    if (stats !== null) {
      if (guarded) {
        stats.guardedLines++;
      }
      if (plan.wild) {
        stats.wildLines++;
      }
    }
    // 对不上的行不作任何断言；不可信的行只有在没有任何保留段时（整行都是合成段）才可断言。
    if (plan.wild || (guarded && plan.pieces.length > 0)) {
      continue;
    }
    if (stats !== null) {
      stats.ambiguousPieces += countAmbiguous(plan);
    }
    for (const group of plan.groups) {
      const [start, end] = groupSubsetRange(x, plan, group, options.mutation);
      const inner = group.innerAbsorbed && options.mutation !== 'skip-inner-absorbed';
      for (let index = start; index < end; index++) {
        // 合并的合成段之间夹着的引号、转义换行可能是原文保留的，位置无法确定，一律不断言。
        if (inner && isAbsorbableAt(x, index)) {
          continue;
        }
        marks[index] = 1;
      }
    }
  }
  return marks;
}

/**
 * 由宽、窄两种词法的对齐求子集：宽词法结果再与窄词法（该行可放置时）取交集，只会更保守。
 * narrow 为 null 时只用宽词法（变异测试路径）。
 */
export function subsetFromAlignments(
  x: string,
  wide: Alignment,
  narrow: Alignment | null,
  options: SpanOptions
): SpanResult {
  const stats = emptyStats();
  stats.newlineMismatch = wide.mode === 'whole' ? 1 : 0;
  if (wide.mode === 'whole' && options.reencodes && hasNonCanonicalMarker(x)) {
    // 换行不守恒且可能重编码：没有可信的锚点，不作任何断言。
    stats.guardedLines++;
    return { marks: new Uint8Array(x.length), stats };
  }
  const marks = subsetMarksFor(x, wide, options, stats);
  if (narrow === null || narrow.mode !== wide.mode) {
    return { marks, stats };
  }
  const narrowMarks = subsetMarksFor(x, narrow, options, null);
  for (const plan of narrow.plans) {
    if (plan.identical || plan.wild) {
      // 窄词法放不下（合成引号、重出的转义换行）时不参与交叉校验，保持宽词法结果。
      continue;
    }
    for (let index = plan.xStart; index < plan.xEnd; index++) {
      if (narrowMarks[index] === 0) {
        marks[index] = 0;
      }
    }
  }
  return { marks, stats };
}

/**
 * 需要窄词法交叉校验的行：宽词法在该行吸收了引号或转义换行（tok 的前后缀、cont）。其余行上两种词法切出的
 * 元素完全相同（窄词法只多吸收裸换行，而裸换行就是行界），交叉校验是空操作，可以跳过。
 */
export function linesNeedingNarrowCheck(wide: Alignment): Set<number> {
  const lines = new Set<number>();
  if (wide.mode !== 'lines') {
    return lines;
  }
  for (const plan of wide.plans) {
    if (plan.identical) {
      continue;
    }
    for (const item of plan.line.items) {
      if (item.kind !== 'piece' && (item.pre.length > 0 || item.post.length > 0)) {
        lines.add(plan.index);
        break;
      }
    }
  }
  return lines;
}

/** v 一定遮住的字符（子集）。宽词法结果再与窄词法（可放置时）取交集，只会更保守。 */
export function hiddenSubset(x: string, y: string, options: SpanOptions): SpanResult {
  if (x === y) {
    return { marks: new Uint8Array(x.length), stats: emptyStats() };
  }
  const wide = alignToInput(x, y, 'abs', options);
  const narrow = options.mutation === undefined ? narrowFor(x, y, wide, options) : null;
  return subsetFromAlignments(x, wide, narrow, options);
}

/** 只为需要交叉校验的行做窄词法对齐（整段模式时整段都做）。 */
export function narrowFor(x: string, y: string, wide: Alignment, options: AlignOptions): Alignment {
  if (wide.mode !== 'lines') {
    return alignToInput(x, y, 'sub', { ...options, mutation: undefined });
  }
  const needed = linesNeedingNarrowCheck(wide);
  const onlyLines =
    options.onlyLines === undefined
      ? needed
      : new Set([...needed].filter((line) => options.onlyLines?.has(line) === true));
  return alignToInput(x, y, 'sub', { ...options, mutation: undefined, onlyLines });
}
