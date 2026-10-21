/**
 * 脱敏阶段 4 的运行时底线：追踪重放（设计 redaction-design-2026-10-19 第 4.3 节、第 6 节阶段 4）。
 *
 * 把四个历史版本（v0 246055e、v1 1b394ce、v2 d113986、v3 b60a61e）的规则逐条重写成“带来源”的形式：输出的
 * 每一段字符都记下它取自输入的哪段区间，合成字符（标记、合成引号、重出的换行）记为无来源。重放一遍之后，
 * 输入里没有任何输出字符取自它的位置，就是该版本“遮住”的位置；四个版本的位置之并就是底线 Floor（不变量 S）。
 *
 * 规则正则与判定函数都从各版本的冻结副本原样抄来（见各段注释里的来源），只有替换动作改成带来源的拼接；
 * JSON 载体解码后再编码的字符继承原转义序列的整段来源，所以 \u0041 这类非规范编码解码后仍算“可见”，
 * 不会因为编码形态不同而被误判为被遮。
 *
 * 运行时自检（失败即关）：重放得到的文本必须与冻结原版对同一输入的输出逐字节相同；不同就说明重放与冻结代码
 * 不一致，重放给出的位置不可信，replayTracked 返回 verified=false，由 legacyFloor 把受影响的行整行替换为
 * [redacted-unaligned] 并计入 FloorReport。重放过程中的内部不一致（解码/编码对不上、分组缺失）同样只走
 * 这条失败即关路径，不抛到调用方。
 *
 * 结构字符（D3 及其阶段 4 子项）：裸 \r、\n 视为结构；可解析的 JSON 字符串字面量内、解码后是换行的转义
 * 序列（\n、\r、\u000a、\u000d，按载体递归到 MAX_ENCODED_DEPTH）也视为结构。structurePositions 给出这些
 * 位置，底线对它们不作遮蔽要求，渲染器在被遮区间内按原顺序放回它们——只暴露换行个数，不暴露任何字符。
 * 这一口径同时约束 hiddenSpans 的对齐 oracle（测试期）与本模块（运行时），由测试钉住。
 *
 * 表示：Tracked 用分段而不是逐字符数组记录来源（copy 段：输出连续区间一一对应输入连续区间；range 段：
 * 每个输出字符都对应同一段输入区间，用于转义序列；synth 段：无来源）。没有匹配的规则趟只做 O(段数) 的
 * 整段保留，所以重放开销主要是正则扫描本身。本模块是纯函数，不持有模块级可变状态。
 */
import {
  redactAt1b394ce,
  redactAt246055e,
  redactAtB60a61e,
  redactAtD113986,
} from './frozenBaselines.js';

export type BaselineRevision = '246055e' | '1b394ce' | 'd113986' | 'b60a61e';

export const BASELINE_REVISIONS: readonly BaselineRevision[] = [
  '246055e',
  '1b394ce',
  'd113986',
  'b60a61e',
];

/** 载体递归深度上限，与 v2/v3 的 MAX_ENCODED_DEPTH 相同（超过时版本输出 [redacted-nested-value]）。 */
const MAX_ENCODED_DEPTH = 8;

/** 来源分段：out 为输出偏移；src<0 为合成；range=true 时每个输出字符都对应 [src, srcEnd)。 */
export interface Segment {
  out: number;
  len: number;
  src: number;
  srcEnd: number;
  range: boolean;
}

export interface Tracked {
  text: string;
  segments: Segment[];
}

class ReplayDivergence extends Error {
  constructor(message: string) {
    super(`tracked replay: ${message}`);
    this.name = 'ReplayDivergence';
  }
}

export function originTracked(text: string): Tracked {
  if (text.length === 0) {
    return { text, segments: [] };
  }
  return {
    text,
    segments: [{ out: 0, len: text.length, src: 0, srcEnd: text.length, range: false }],
  };
}

/** 第一个覆盖 position（out ≤ position < out+len）的分段下标；分段有序且无空洞。 */
function segmentIndexAt(segments: readonly Segment[], position: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    if (segment === undefined || segment.out + segment.len <= position) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

class TrackedBuilder {
  private readonly parts: string[] = [];
  private readonly segments: Segment[] = [];
  private length = 0;

  keep(source: Tracked, from: number, to: number): void {
    if (to <= from) {
      return;
    }
    this.parts.push(source.text.slice(from, to));
    let index = segmentIndexAt(source.segments, from);
    let cursor = from;
    while (cursor < to) {
      const segment = source.segments[index];
      if (segment === undefined) {
        throw new ReplayDivergence('segment table does not cover the kept range');
      }
      const take = Math.min(segment.out + segment.len, to) - cursor;
      const offset = cursor - segment.out;
      if (segment.src < 0) {
        this.push(take, -1, -1, false);
      } else if (segment.range) {
        this.push(take, segment.src, segment.srcEnd, true);
      } else {
        this.push(take, segment.src + offset, segment.src + offset + take, false);
      }
      cursor += take;
      index++;
    }
  }

  synth(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.parts.push(text);
    this.push(text.length, -1, -1, false);
  }

  /** 单个输出字符，对应输入区间 [start, end)（start<0 为合成）。 */
  char(char: string, start: number, end: number): void {
    this.parts.push(char);
    if (start < 0) {
      this.push(char.length, -1, -1, false);
    } else {
      this.push(char.length, start, end, true);
    }
  }

  append(fragment: Tracked): void {
    this.keep(fragment, 0, fragment.text.length);
  }

  private push(len: number, src: number, srcEnd: number, range: boolean): void {
    const last = this.segments[this.segments.length - 1];
    if (last !== undefined) {
      const bothSynth = last.src < 0 && src < 0;
      const bothCopy = !last.range && !range && last.src >= 0 && last.src + last.len === src;
      const sameRange = last.range && range && last.src === src && last.srcEnd === srcEnd;
      if (bothSynth || bothCopy || sameRange) {
        last.len += len;
        if (bothCopy) {
          last.srcEnd = last.src + last.len;
        }
        this.length += len;
        return;
      }
    }
    this.segments.push({ out: this.length, len, src, srcEnd, range });
    this.length += len;
  }

  build(): Tracked {
    return { text: this.parts.join(''), segments: this.segments };
  }
}

/** 替换回调的输出口：对 source 的 [from, to) 原样保留、写合成文本、或整段接入已带来源的文本。 */
interface Emitter {
  keep(from: number, to: number): void;
  synth(text: string): void;
  append(fragment: Tracked): void;
}

class SourceEmitter implements Emitter {
  constructor(
    private readonly builder: TrackedBuilder,
    private readonly source: Tracked
  ) {}

  keep(from: number, to: number): void {
    this.builder.keep(this.source, from, to);
  }

  synth(text: string): void {
    this.builder.synth(text);
  }

  append(fragment: Tracked): void {
    this.builder.append(fragment);
  }
}

/**
 * 等价于 String.prototype.replace(全局正则, 回调)：按 lastIndex 顺序逐个匹配，回调通过 emit 写出替换。
 * 不使用正则的 d 标志：各规则的分组都是匹配的前缀或后缀，区间按长度算出，避免为每个匹配物化 indices。
 */
function trackedReplace(
  source: Tracked,
  pattern: RegExp,
  replacer: (match: RegExpExecArray, emit: Emitter) => void
): Tracked {
  const scanner = new RegExp(pattern.source, pattern.flags);
  const first = scanner.exec(source.text);
  if (first === null) {
    // 没有任何匹配：输出就是输入，直接共享（Tracked 构造后不再被改动）。
    return source;
  }
  const builder = new TrackedBuilder();
  const emit = new SourceEmitter(builder, source);
  let cursor = 0;
  for (
    let match: RegExpExecArray | null = first;
    match !== null;
    match = scanner.exec(source.text)
  ) {
    if (match[0].length === 0) {
      throw new ReplayDivergence(`unexpected empty match for /${pattern.source}/`);
    }
    builder.keep(source, cursor, match.index);
    replacer(match, emit);
    cursor = match.index + match[0].length;
  }
  builder.keep(source, cursor, source.text.length);
  return builder.build();
}

/** 保留前缀分组 1，其余写合成文本。 */
function keepGroupThenSynth(synth: string): (match: RegExpExecArray, emit: Emitter) => void {
  return (match, emit) => {
    emit.keep(match.index, match.index + (match[1] ?? '').length);
    emit.synth(synth);
  };
}

function wholeSynth(synth: string): (match: RegExpExecArray, emit: Emitter) => void {
  return (_match, emit) => {
    emit.synth(synth);
  };
}

function keepWhole(match: RegExpExecArray, emit: Emitter): void {
  emit.keep(match.index, match.index + match[0].length);
}

function breaksOf(text: string, pattern: RegExp): string {
  return (text.match(pattern) || []).join('');
}

/** source 中 [from, to) 这段输出字符对应的输入区间（取非合成来源的最小起点与最大终点；全合成为 [-1,-1]）。 */
function sourceRangeOf(source: Tracked, from: number, to: number): [number, number] {
  let low = -1;
  let high = -1;
  let index = segmentIndexAt(source.segments, from);
  let cursor = from;
  while (cursor < to) {
    const segment = source.segments[index];
    if (segment === undefined) {
      break;
    }
    const take = Math.min(segment.out + segment.len, to) - cursor;
    if (segment.src >= 0) {
      const start = segment.range ? segment.src : segment.src + (cursor - segment.out);
      const end = segment.range ? segment.srcEnd : start + take;
      low = low < 0 ? start : Math.min(low, start);
      high = Math.max(high, end);
    }
    cursor += take;
    index++;
  }
  return [low, high];
}

const ESCAPE_TABLE: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** 解码 JSON 字符串字面量（含两侧引号 [from, to)），每个解码字符继承其转义序列的来源区间。 */
export function decodeLiteral(source: Tracked, from: number, to: number): Tracked {
  const builder = new TrackedBuilder();
  const text = source.text;
  let index = from + 1;
  const end = to - 1;
  while (index < end) {
    const backslash = text.indexOf('\\', index);
    const plainEnd = backslash < 0 || backslash >= end ? end : backslash;
    if (plainEnd > index) {
      // 无转义的连续字符原样保留，来源一一对应。
      builder.keep(source, index, plainEnd);
      index = plainEnd;
      continue;
    }
    const escapeChar = text[index + 1] ?? '';
    let decoded: string;
    let length: number;
    if (escapeChar === 'u') {
      decoded = String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
      length = 6;
    } else {
      decoded = ESCAPE_TABLE[escapeChar] ?? escapeChar;
      length = 2;
    }
    const [low, high] = sourceRangeOf(source, index, index + length);
    builder.char(decoded, low, high);
    index += length;
  }
  return builder.build();
}

function escapedForm(code: number): string {
  if (code === 0x22) {
    return '\\"';
  }
  if (code === 0x5c) {
    return '\\\\';
  }
  if (code === 0x08) {
    return '\\b';
  }
  if (code === 0x0c) {
    return '\\f';
  }
  if (code === 0x0a) {
    return '\\n';
  }
  if (code === 0x0d) {
    return '\\r';
  }
  if (code === 0x09) {
    return '\\t';
  }
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

/** 需要转义的码元：引号、反斜杠、控制字符、代理（成对代理在下方原样保留）。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON 编码必须转义 U+0000–U+001F，这里就是要匹配它们。
const ESCAPE_SCAN = /["\\\u0000-\u001f\ud800-\udfff]/g;

/** 与 JSON.stringify（良构字符串编码）逐码元一致的编码；编码出的字符继承原字符的来源。 */
export function encodeLiteral(value: Tracked): Tracked {
  const builder = new TrackedBuilder();
  builder.synth('"');
  const text = value.text;
  const scanner = new RegExp(ESCAPE_SCAN.source, ESCAPE_SCAN.flags);
  let cursor = 0;
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
    const index = match.index;
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // 配对代理原样输出（well-formed JSON.stringify 不转义成对代理）。
        scanner.lastIndex = index + 2;
        continue;
      }
    }
    builder.keep(value, cursor, index);
    const [charStart, charEnd] = sourceRangeOf(value, index, index + 1);
    for (const char of escapedForm(code)) {
      builder.char(char, charStart, charEnd);
    }
    cursor = index + 1;
  }
  builder.keep(value, cursor, text.length);
  builder.synth('"');
  return builder.build();
}

const JSON_STRING = String.raw`"(?:\\[\s\S]|[^"\\])*"`;

/** v2/v3 共有的载体递归：可解析且内层被改写的字面量重新编码，否则原样保留。 */
function replayLiterals(
  source: Tracked,
  depth: number,
  recurse: (inner: Tracked, depth: number) => Tracked
): Tracked {
  return trackedReplace(source, new RegExp(JSON_STRING, 'g'), (match, emit) => {
    const literal = match[0];
    let value: string;
    try {
      value = JSON.parse(literal) as string;
    } catch (err: unknown) {
      void err;
      keepWhole(match, emit);
      return;
    }
    const inner = decodeLiteral(source, match.index, match.index + literal.length);
    if (inner.text !== value) {
      throw new ReplayDivergence('literal decode mismatch');
    }
    const redacted = recurse(inner, depth + 1);
    if (redacted.text === value) {
      keepWhole(match, emit);
      return;
    }
    const encoded = encodeLiteral(redacted);
    if (encoded.text !== JSON.stringify(redacted.text)) {
      throw new ReplayDivergence('literal encode mismatch');
    }
    emit.append(encoded);
  });
}

// ---------------------------------------------------------------------------------------------
// v0 246055e（规则来源：frozenBaselines.ts 的 redactAt246055e，即 git show 246055e:src/agent/utils/Redaction.ts）
// ---------------------------------------------------------------------------------------------
function replay246055e(source: Tracked): Tracked {
  let text = trackedReplace(
    source,
    /sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g,
    wholeSynth('[redacted-api-key]')
  );
  text = trackedReplace(text, /AIza[0-9A-Za-z_-]{20,}/g, wholeSynth('[redacted-google-api-key]'));
  text = trackedReplace(
    text,
    /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    keepGroupThenSynth('[redacted-token]')
  );
  return trackedReplace(
    text,
    /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
    keepGroupThenSynth('[redacted]')
  );
}

// ---------------------------------------------------------------------------------------------
// v1 1b394ce（规则来源：frozenBaselines.ts 的 redactAt1b394ce）
// ---------------------------------------------------------------------------------------------
function replay1b394ce(source: Tracked): Tracked {
  let text = trackedReplace(
    source,
    /("(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    keepGroupThenSynth('"[redacted]"')
  );
  text = trackedReplace(text, /sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, wholeSynth('[redacted-api-key]'));
  text = trackedReplace(text, /AIza[0-9A-Za-z_-]{20,}/g, wholeSynth('[redacted-google-api-key]'));
  text = trackedReplace(
    text,
    /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    keepGroupThenSynth('[redacted-token]')
  );
  return trackedReplace(
    text,
    /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
    keepGroupThenSynth('[redacted]')
  );
}

// ---------------------------------------------------------------------------------------------
// v2 d113986（规则来源：frozenBaselines.ts 的 redactAtD113986）
// ---------------------------------------------------------------------------------------------
const V2_SECRET_KEY_SOURCE = 'api[_-]?key|token|secret|password|authorization';
const V2_SECRET_KEY = new RegExp(`(?:${V2_SECRET_KEY_SOURCE})$`, 'i');
const V2_JSON_FIELD = new RegExp(
  String.raw`(?<!\\)(${JSON_STRING})(\s*:\s*)(${JSON_STRING}|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|[,}\]]|$)`,
  'g'
);
const V2_QUOTED = new RegExp(
  String.raw`((?:${V2_SECRET_KEY_SOURCE})["']?\s*[:=]\s*)(["'])((?:\\[\s\S]|(?!\2)[^\\])*)\2`,
  'gi'
);
const V2_BARE = new RegExp(
  String.raw`((?:${V2_SECRET_KEY_SOURCE})(["']?)\s*[:=]\s*)(?!\\+["'])([^\s"',;{}\[\]()]+)`,
  'gi'
);
const V2_UNTERMINATED = new RegExp(
  String.raw`((?:${V2_SECRET_KEY_SOURCE})["']?\s*[:=]\s*)(["'])((?:\\[\s\S]|(?!\2)[^\\])*)(?:\\)?$`,
  'gi'
);
const NEWLINES = /\r\n|\r|\n/g;

function replayD113986(source: Tracked, depth: number): Tracked {
  if (depth > MAX_ENCODED_DEPTH) {
    const builder = new TrackedBuilder();
    builder.synth('[redacted-nested-value]');
    return builder.build();
  }
  const jsonFields = trackedReplace(source, V2_JSON_FIELD, (match, emit) => {
    const keyText = match[1] ?? '';
    const valueText = match[3] ?? '';
    try {
      const key = JSON.parse(keyText) as string;
      if (V2_SECRET_KEY.test(key)) {
        // 值分组是匹配的后缀（尾部只有零宽先行断言）。
        emit.keep(match.index, match.index + match[0].length - valueText.length);
        emit.synth(`"[redacted]"${breaksOf(valueText, NEWLINES)}`);
        return;
      }
    } catch (err: unknown) {
      void err;
    }
    keepWhole(match, emit);
  });
  const decoded = replayLiterals(jsonFields, depth, replayD113986);
  let text = trackedReplace(decoded, V2_UNTERMINATED, (match, emit) => {
    // 分组 2 是紧跟前缀分组 1 的那个引号。
    emit.keep(match.index, match.index + (match[1] ?? '').length + 1);
    emit.synth(`[redacted]${breaksOf(match[3] ?? '', NEWLINES)}`);
  });
  text = trackedReplace(text, V2_QUOTED, (match, emit) => {
    emit.keep(match.index, match.index + (match[1] ?? '').length + 1);
    emit.synth(`[redacted]${breaksOf(match[3] ?? '', NEWLINES)}${match[2] ?? ''}`);
  });
  text = trackedReplace(text, /sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, wholeSynth('[redacted-api-key]'));
  text = trackedReplace(text, /AIza[0-9A-Za-z_-]{20,}/g, wholeSynth('[redacted-google-api-key]'));
  text = trackedReplace(
    text,
    /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    keepGroupThenSynth('[redacted-token]')
  );
  text = trackedReplace(
    text,
    /(authorization\s*[:=]\s*Basic\s+)[A-Za-z0-9+/=_-]+/gi,
    keepGroupThenSynth('[redacted-token]')
  );
  return trackedReplace(text, V2_BARE, (match, emit) => {
    const prefix = match[1] ?? '';
    const keyQuote = match[2] ?? '';
    const body = match[3] ?? '';
    if (/^authorization["']?\s*[:=]/i.test(prefix) && /^(Bearer|Basic)$/i.test(body)) {
      keepWhole(match, emit);
      return;
    }
    emit.keep(match.index, match.index + prefix.length);
    emit.synth(`${keyQuote}[redacted]${keyQuote}`);
  });
}

// ---------------------------------------------------------------------------------------------
// v3 b60a61e（规则与判定函数来源：frozenBaselines.ts 的 redactAtB60a61e，即 HEAD 现行规则）
// ---------------------------------------------------------------------------------------------
const SECRET_KEY_SOURCE = 'api[_-]?key|token|secret|password|authorization';
const SECRET_KEY_SUFFIX = new RegExp(`(?:${SECRET_KEY_SOURCE})$`, 'i');
const COMPOUND_FIRST_WORDS = new Set(['secret', 'private', 'access']);
const COMPOUND_JOINED_WORDS = new Set(['secretkey', 'privatekey', 'accesskey']);
const KEY_HINT_SOURCE = `${SECRET_KEY_SOURCE}|(?:private|access)[_.-]?key`;
const TEXT_KEY = String.raw`(?<![\w$.-])((?=[\w$.-]*?(?:${KEY_HINT_SOURCE}))[\w$.-]+)`;
const SEPARATOR = '(?<![=!<>])(?:=(?![=>])|:(?!:))';
const JSON_FIELD = new RegExp(
  String.raw`(?<!\\)(${JSON_STRING})(\s*:\s*)(${JSON_STRING}|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|[,}\]]|$)`,
  'g'
);
const JSON_CONTAINER_FIELD = new RegExp(String.raw`(?<!\\)(${JSON_STRING})(\s*:\s*)(?=[\[{])`, 'g');
const QUOTED_ASSIGNMENT = new RegExp(
  String.raw`${TEXT_KEY}(["']?\s*${SEPARATOR}\s*)(["'])((?:\\[\s\S]|(?!\3)[^\\])*)\3`,
  'gi'
);
const BARE_ASSIGNMENT = new RegExp(
  String.raw`${TEXT_KEY}(["']?)(\s*)(${SEPARATOR})(\s*)(?!\\+["'])([^\s"',;{}\[\]()]+)`,
  'gi'
);
const UNTERMINATED_ASSIGNMENT = new RegExp(
  String.raw`${TEXT_KEY}(["']?\s*${SEPARATOR}\s*)(["'])((?:\\[\s\S]|(?!\3)[^\\])*)(?:\\)?$`,
  'gi'
);
const PEM_PRIVATE_KEY =
  /(-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----)((?:(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset): [^\r\n\\]*|\\[nr]|[A-Za-z0-9+/=\s])*)(-----END \2PRIVATE KEY\3-----)?/g;
const URL_USERINFO =
  /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/?#@"'<>]*:)([^\s/?#"'<>]+)@/g;
const CONTEXT_WINDOW = 256;
const TYPE_NAMES = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'any',
  'unknown',
  'never',
  'void',
  'object',
  'undefined',
  'null',
  'String',
  'Int',
  'Int32',
  'Int64',
  'UInt',
  'Bool',
  'Boolean',
  'Double',
  'Float',
  'Long',
  'Short',
  'Byte',
  'Char',
  'Character',
  'Data',
  'Any',
  'AnyObject',
  'Object',
  'Integer',
  'Unit',
  'str',
  'int',
  'bool',
  'float',
  'bytes',
  'dict',
  'list',
  'tuple',
  'None',
  'char',
  'u8',
  'u32',
  'u64',
  'i32',
  'i64',
  'usize',
  'dynamic',
]);
const CODE_REFERENCE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const CONFIG_LINE_PREFIX = /^[ \t]*(?:export[ \t]+|-[ \t]+)?["']?$/;
const CONFIG_LINE_END = /^[ \t]*(?:#.*)?(?:\r|\n|$)/;

type SecretKeyClass = 'suffix' | 'compound';

interface BareAssignment {
  key: string;
  beforeSeparator: string;
  separator: string;
  afterSeparator: string;
  value: string;
  preceding: string;
  following: string;
}

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function hasCompoundSecretWords(key: string): boolean {
  const words = keyWords(key);
  return words.some(
    (word, index) =>
      COMPOUND_JOINED_WORDS.has(word) ||
      (COMPOUND_FIRST_WORDS.has(word) && words[index + 1] === 'key')
  );
}

function classifyKey(key: string): SecretKeyClass | null {
  if (SECRET_KEY_SUFFIX.test(key)) {
    return 'suffix';
  }
  return hasCompoundSecretWords(key) ? 'compound' : null;
}

function isSensitiveJsonKey(keyText: string): boolean {
  try {
    const key: unknown = JSON.parse(keyText);
    return typeof key === 'string' && classifyKey(key) !== null;
  } catch (err: unknown) {
    void err;
    return false;
  }
}

function findContainerEnd(text: string, start: number): number | null {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote !== null) {
      if (char === '\\') {
        index++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[' || char === '{') {
      depth++;
    } else if (char === ']' || char === '}') {
      depth--;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return null;
}

function pemContentBounds(body: string): [number, number] {
  const isPadding = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);
  const isEscape = (char: string | undefined): boolean => char === 'n' || char === 'r';
  let start = 0;
  while (start < body.length) {
    if (isPadding(body[start])) {
      start++;
    } else if (body[start] === '\\' && isEscape(body[start + 1])) {
      start += 2;
    } else {
      break;
    }
  }
  let stop = body.length;
  while (stop > start) {
    if (isPadding(body[stop - 1])) {
      stop--;
    } else if (stop - 2 >= start && body[stop - 2] === '\\' && isEscape(body[stop - 1])) {
      stop -= 2;
    } else {
      break;
    }
  }
  return [start, stop];
}

function precedingOnLine(source: string, offset: number): string {
  const window = source.slice(Math.max(0, offset - CONTEXT_WINDOW), offset);
  const lineBreak = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('\r'));
  return window.slice(lineBreak + 1);
}

function isColonCodeContext({ preceding, beforeSeparator }: BareAssignment): boolean {
  if (/(?:^|[{;:])\s*case\s+["']?$/.test(preceding)) {
    return true;
  }
  return beforeSeparator.length > 0 && /[\w$)\]'"`]\s+\?\s+["']?$/.test(preceding);
}

function looksLikeTypeAnnotation({ value, following }: BareAssignment): boolean {
  if (TYPE_NAMES.has(value) || /^[&?][A-Za-z_']/.test(value)) {
    return true;
  }
  if (/^[A-Za-z_][\w.]*(?:<|\|[A-Za-z_]|\?$)/.test(value)) {
    return true;
  }
  return /^[A-Za-z_][\w.]*$/.test(value) && /^(?:[ \t]*\|[^|]|\[)/.test(following);
}

function isLiteralBareValue(assignment: BareAssignment): boolean {
  const { key, beforeSeparator, separator, afterSeparator, value, preceding, following } =
    assignment;
  if (value.startsWith('$') || /^[([]/.test(following)) {
    return false;
  }
  if (!CODE_REFERENCE.test(value)) {
    return true;
  }
  if (separator === '=' && beforeSeparator === '' && afterSeparator === '') {
    return true;
  }
  if (key.includes('-')) {
    return true;
  }
  return (
    !value.includes('.') && CONFIG_LINE_PREFIX.test(preceding) && CONFIG_LINE_END.test(following)
  );
}

/** b60a61e 的 replaceAssignments：replacer 返回 null 时只跳过键名、从值的位置继续扫描。 */
function trackedReplaceAssignments(
  source: Tracked,
  pattern: RegExp,
  replacer: (match: RegExpExecArray, text: string) => ((emit: Emitter) => void) | null
): Tracked {
  const scanner = new RegExp(pattern.source, pattern.flags);
  let builder: TrackedBuilder | null = null;
  let emit: SourceEmitter | null = null;
  let cursor = 0;
  for (let match = scanner.exec(source.text); match !== null; match = scanner.exec(source.text)) {
    const write = replacer(match, source.text);
    if (write === null) {
      // b60a61e 的 replaceAssignments：不是凭据赋值时只跳过键名、从值的位置继续扫描。
      scanner.lastIndex = match.index + Math.max(1, (match[1] ?? '').length);
      continue;
    }
    if (builder === null || emit === null) {
      builder = new TrackedBuilder();
      emit = new SourceEmitter(builder, source);
    }
    builder.keep(source, cursor, match.index);
    write(emit);
    cursor = match.index + match[0].length;
  }
  if (builder === null) {
    // 没有任何替换：输出就是输入，直接共享。
    return source;
  }
  builder.keep(source, cursor, source.text.length);
  return builder.build();
}

function replayContainers(source: Tracked): Tracked {
  const text = source.text;
  let builder: TrackedBuilder | null = null;
  let cursor = 0;
  for (const match of text.matchAll(JSON_CONTAINER_FIELD)) {
    const start = match.index + match[0].length;
    if (match.index < cursor || !isSensitiveJsonKey(match[1] ?? '')) {
      continue;
    }
    const end = findContainerEnd(text, start);
    const valueEnd = end ?? text.length;
    if (builder === null) {
      builder = new TrackedBuilder();
    }
    builder.keep(source, cursor, start);
    builder.synth(
      `${end === null ? '"[redacted]' : '"[redacted]"'}${breaksOf(text.slice(start, valueEnd), NEWLINES)}`
    );
    cursor = valueEnd;
  }
  if (builder === null) {
    return source;
  }
  builder.keep(source, cursor, text.length);
  return builder.build();
}

function replayB60a61e(source: Tracked, depth: number): Tracked {
  if (depth > MAX_ENCODED_DEPTH) {
    const builder = new TrackedBuilder();
    builder.synth('[redacted-nested-value]');
    return builder.build();
  }
  const containers = replayContainers(source);
  const jsonFields = trackedReplace(containers, JSON_FIELD, (match, emit) => {
    if (!isSensitiveJsonKey(match[1] ?? '')) {
      keepWhole(match, emit);
      return;
    }
    const valueText = match[3] ?? '';
    emit.keep(match.index, match.index + match[0].length - valueText.length);
    emit.synth(`"[redacted]"${breaksOf(valueText, NEWLINES)}`);
  });
  const decoded = replayLiterals(jsonFields, depth, replayB60a61e);
  let text = trackedReplace(decoded, PEM_PRIVATE_KEY, (match, emit) => {
    const body = match[4] ?? '';
    const [start, stop] = pemContentBounds(body);
    if (start >= stop) {
      keepWhole(match, emit);
      return;
    }
    // 分组布局：1 BEGIN 行（前缀，含分组 2、3）、4 正文、5 可选的 END 行（后缀）。
    const bodyStart = match.index + (match[1] ?? '').length;
    const bodyEnd = bodyStart + body.length;
    emit.keep(match.index, bodyStart + start);
    emit.synth(
      `[redacted-private-key]${breaksOf(body.slice(start, stop), /\r\n|\r|\n|\\r\\n|\\n|\\r/g)}`
    );
    emit.keep(bodyStart + stop, match.index + match[0].length);
    if (bodyEnd + (match[5] ?? '').length !== match.index + match[0].length) {
      throw new ReplayDivergence('PEM groups do not tile the match');
    }
  });
  text = trackedReplace(text, URL_USERINFO, (match, emit) => {
    const at = match.index + match[0].length - 1;
    emit.keep(match.index, match.index + (match[1] ?? '').length);
    emit.synth('[redacted]');
    emit.keep(at, at + 1);
  });
  text = trackedReplaceAssignments(text, UNTERMINATED_ASSIGNMENT, (match) => {
    const key = match[1] ?? '';
    if (classifyKey(key) === null) {
      return null;
    }
    // 分组 3 是紧跟分组 1、2 的那个引号。
    const quoteEnd = match.index + key.length + (match[2] ?? '').length + 1;
    return (emit) => {
      emit.keep(match.index, quoteEnd);
      emit.synth(`[redacted]${breaksOf(match[4] ?? '', NEWLINES)}`);
    };
  });
  text = trackedReplaceAssignments(text, QUOTED_ASSIGNMENT, (match) => {
    const key = match[1] ?? '';
    if (classifyKey(key) === null) {
      return null;
    }
    const quoteEnd = match.index + key.length + (match[2] ?? '').length + 1;
    return (emit) => {
      emit.keep(match.index, quoteEnd);
      emit.synth(`[redacted]${breaksOf(match[4] ?? '', NEWLINES)}${match[3] ?? ''}`);
    };
  });
  text = trackedReplace(text, /sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, wholeSynth('[redacted-api-key]'));
  text = trackedReplace(text, /AIza[0-9A-Za-z_-]{20,}/g, wholeSynth('[redacted-google-api-key]'));
  text = trackedReplace(
    text,
    /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    keepGroupThenSynth('[redacted-token]')
  );
  text = trackedReplace(
    text,
    /(authorization\s*[:=]\s*Basic\s+)[A-Za-z0-9+/=_-]+/gi,
    keepGroupThenSynth('[redacted-token]')
  );
  return trackedReplaceAssignments(text, BARE_ASSIGNMENT, (match, sourceText) => {
    const [
      whole,
      key = '',
      keyQuote = '',
      beforeSeparator = '',
      separator = '',
      afterSeparator = '',
    ] = match;
    const value = match[6] ?? '';
    const keyClass = classifyKey(key);
    if (keyClass === null) {
      return null;
    }
    if (/^[=<>!|]/.test(value)) {
      return null;
    }
    const end = match.index + whole.length;
    const assignment: BareAssignment = {
      key,
      beforeSeparator,
      separator,
      afterSeparator,
      value,
      preceding: precedingOnLine(sourceText, match.index),
      following: sourceText.slice(end, end + CONTEXT_WINDOW),
    };
    if (
      separator === ':' &&
      (isColonCodeContext(assignment) || looksLikeTypeAnnotation(assignment))
    ) {
      return null;
    }
    if (/authorization$/i.test(key) && /^(?:Bearer|Basic)$/i.test(value)) {
      return null;
    }
    if (keyClass === 'compound' && !isLiteralBareValue(assignment)) {
      return null;
    }
    // 值分组 6 是匹配的后缀。
    return (emit) => {
      emit.keep(match.index, end - value.length);
      emit.synth(`${keyQuote}[redacted]${keyQuote}`);
    };
  });
}

const FROZEN: Readonly<Record<BaselineRevision, (text: string) => string>> = {
  '246055e': redactAt246055e,
  '1b394ce': redactAt1b394ce,
  d113986: redactAtD113986,
  b60a61e: redactAtB60a61e,
};

const REPLAYS: Readonly<Record<BaselineRevision, (source: Tracked) => Tracked>> = {
  '246055e': replay246055e,
  '1b394ce': replay1b394ce,
  d113986: (source) => replayD113986(source, 0),
  b60a61e: (source) => replayB60a61e(source, 0),
};

/** 冻结原版的输出（黑盒，供自检与测试使用）。 */
export function frozenRedact(revision: BaselineRevision, text: string): string {
  return FROZEN[revision](text);
}

export interface ReplayResult {
  revision: BaselineRevision;
  /** 冻结原版的输出；重放文本必须与它逐字节相同。 */
  frozen: string;
  /** 重放结果；verified=false 时它的来源信息不可信，只能作为“只会多遮”的附加输入。 */
  tracked: Tracked | null;
  verified: boolean;
  /** 自检失败的原因种类（不含正文）：divergence = 文本不同；internal = 重放内部不一致。 */
  failure: 'divergence' | 'internal' | null;
}

/**
 * 对带来源的文本重放某个版本并自检。frozen 由调用方传入时直接复用（避免重复计算冻结输出）。
 * 失败即关：任何内部不一致都归入 failure='internal'，文本不等归入 'divergence'，不向上抛出。
 */
export function replayTracked(
  revision: BaselineRevision,
  source: Tracked,
  frozen?: string
): ReplayResult {
  const expected = frozen ?? FROZEN[revision](source.text);
  try {
    const tracked = REPLAYS[revision](source);
    if (tracked.text !== expected) {
      return { revision, frozen: expected, tracked, verified: false, failure: 'divergence' };
    }
    return { revision, frozen: expected, tracked, verified: true, failure: null };
  } catch (err: unknown) {
    // 只吞掉重放自身的不一致；其他异常（例如正则引擎错误）同样按失败即关处理，但不能让底线崩溃。
    void err;
    return { revision, frozen: expected, tracked: null, verified: false, failure: 'internal' };
  }
}

/** 有输出字符取自的输入位置（1 = 可见）。 */
export function visibleFromTracked(tracked: Tracked, length: number): Uint8Array {
  const visible = new Uint8Array(length);
  for (const segment of tracked.segments) {
    if (segment.src < 0) {
      continue;
    }
    const start = Math.max(0, segment.src);
    const end = Math.min(length, segment.range ? segment.srcEnd : segment.src + segment.len);
    if (end > start) {
      visible.fill(1, start, end);
    }
  }
  return visible;
}

/** 某个版本精确遮住的位置（1 = 没有任何输出字符取自该位置），含裸换行等结构位置。 */
export function hiddenFromTracked(tracked: Tracked, length: number): Uint8Array {
  const visible = visibleFromTracked(tracked, length);
  const hidden = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    hidden[index] = visible[index] === 1 ? 0 : 1;
  }
  return hidden;
}

/** 某个版本在 x 上精确遮住的位置；自检失败时返回 null。 */
export function exactHidden(revision: BaselineRevision, x: string): Uint8Array | null {
  const result = replayTracked(revision, originTracked(x));
  return result.verified && result.tracked !== null
    ? hiddenFromTracked(result.tracked, x.length)
    : null;
}

/**
 * 缺口：相邻两段保留输出之间被遮住的输入区间 [start, end) 及该处的合成文本（版本原来写出的替换文本）。
 * 渲染器只在合成文本完全由标记、引号、换行组成时沿用它（设计 4.6），否则写新标记。
 */
export interface Gap {
  start: number;
  end: number;
  synth: string;
}

export function gapsFromTracked(tracked: Tracked, length: number): Gap[] {
  const gaps: Gap[] = [];
  let cursor = 0;
  let pending = '';
  for (const segment of tracked.segments) {
    if (segment.src < 0) {
      pending += tracked.text.slice(segment.out, segment.out + segment.len);
      continue;
    }
    const start = segment.src;
    const end = segment.range ? segment.srcEnd : segment.src + segment.len;
    if (start > cursor || (pending.length > 0 && start >= cursor)) {
      gaps.push({ start: cursor, end: Math.max(cursor, start), synth: pending });
    }
    pending = '';
    // 同一转义序列编码出的多个字符共享来源区间，start 会小于 cursor；来源只会向前推进。
    cursor = Math.max(cursor, end);
  }
  if (cursor < length || pending.length > 0) {
    gaps.push({ start: cursor, end: Math.max(cursor, length), synth: pending });
  }
  return gaps;
}

/**
 * 一个换行结构记号：x 中 [start, end) 这段字符（裸换行是 1 个字符；转义形态是整个转义序列，深层载体下可能跨越
 * 多重转义，例如 \\n 或 \n）解码后恰好是一个换行字符 newline。渲染器按记号放回换行，并按 newline 归一后
 * 与历史合成文本里的换行记号做多重集差（复查意见 2：\u000a 与 \n 是同一个换行）。
 */
export interface StructureToken {
  start: number;
  end: number;
  newline: '\n' | '\r';
}

export interface StructureAnalysis {
  /** 与 x 等长；1 = 结构位置。 */
  marks: Uint8Array;
  /** 按 start 升序、互不重叠的换行记号。 */
  tokens: StructureToken[];
}

/**
 * 结构位置（D3 与阶段 4 子项）：裸 \r、\n，以及可解析 JSON 字符串字面量内解码后是换行的转义序列（按载体递归）。
 * 底线对这些位置不作遮蔽要求；渲染器在被遮区间内按原顺序放回它们——只暴露换行个数，不暴露任何字符。
 */
export function analyzeStructure(x: string): StructureAnalysis {
  const marks = new Uint8Array(x.length);
  const tokens: StructureToken[] = [];
  collectStructure(originTracked(x), marks, tokens, 0);
  tokens.sort((left, right) => left.start - right.start || left.end - right.end);
  // 来源区间互不重叠时逐个保留；若因多重转义对到同一段来源（理论上不会发生），只保留先出现的记号，
  // 位置标记不受影响，放回的换行只会更少，不会多出任何字符。
  const disjoint: StructureToken[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start < cursor || token.end <= token.start) {
      continue;
    }
    disjoint.push(token);
    cursor = token.end;
  }
  return { marks, tokens: disjoint };
}

/** 只要位置标记时的入口（测试与 oracle 用）。 */
export function structurePositions(x: string): Uint8Array {
  return analyzeStructure(x).marks;
}

function collectStructure(
  level: Tracked,
  marks: Uint8Array,
  tokens: StructureToken[],
  depth: number
): void {
  const text = level.text;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) {
      const [low, high] = sourceRangeOf(level, index, index + 1);
      if (low >= 0) {
        const end = Math.min(high, marks.length);
        marks.fill(1, low, end);
        tokens.push({ start: low, end, newline: code === 10 ? '\n' : '\r' });
      }
    }
  }
  if (depth >= MAX_ENCODED_DEPTH) {
    return;
  }
  const scanner = new RegExp(JSON_STRING, 'g');
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
    const literal = match[0];
    // 只有含 \n、\r、\u 转义的字面量才可能在解码后出现换行（深层载体的换行也经这些转义编码）。
    if (!/\\[nru]/.test(literal)) {
      continue;
    }
    try {
      JSON.parse(literal);
    } catch (err: unknown) {
      void err;
      continue;
    }
    collectStructure(
      decodeLiteral(level, match.index, match.index + literal.length),
      marks,
      tokens,
      depth + 1
    );
  }
}
