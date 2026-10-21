/**
 * 追踪重放（测试与复查专用的独立精确位置 oracle）：把四个历史版本的 Redaction 逐条规则重写成“带来源”的
 * 形式，每个输出字符都记下它取自输入的哪段区间（合成字符记 -1）。重放结果必须与对应版本的真实输出逐字节
 * 相同（replay* 返回前自检，不同就抛错），所以它给出的“被遮位置”不依赖底线实现里的对齐算法。
 *
 * 阶段 4 起运行时底线是 src/agent/utils/redaction/trackedReplay.ts 的分段来源实现；本文件保持逐字符来源的
 * 独立实现（v3 取自 git blob 夹具而不是冻结副本），两者在全部语料上必须给出相同的被遮位置
 * （test/redaction-tracked-replay.test.ts），互为对照，避免同一处转录错误同时骗过运行时与 oracle。
 *
 * 规则正则、判定函数都从各版本 blob 原样抄来（见各段注释里的来源）；只有替换动作改写成带来源的拼接。
 * 换行、标记、合成引号一律记为合成；JSON 载体解码后再编码的字符继承原转义序列的整段来源。
 */
import {
  redactAt1b394ce,
  redactAt246055e,
  redactAtD113986,
} from '../../../src/agent/utils/redaction/frozenBaselines.js';
import { redactDeveloperText as redactAtB60a61e } from '../redaction-baselines/redaction-at-b60a61e.js';

export interface Tracked {
  text: string;
  /** 每个字符的来源区间 [start, end)；start = -1 表示合成字符。 */
  start: Int32Array;
  end: Int32Array;
}

export type BaselineRevision = '246055e' | '1b394ce' | 'd113986' | 'b60a61e';

export function originTracked(text: string): Tracked {
  const start = new Int32Array(text.length);
  const end = new Int32Array(text.length);
  for (let index = 0; index < text.length; index++) {
    start[index] = index;
    end[index] = index + 1;
  }
  return { text, start, end };
}

class TrackedBuilder {
  private readonly texts: string[] = [];
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];

  keep(source: Tracked, from: number, to: number): void {
    if (to <= from) {
      return;
    }
    this.texts.push(source.text.slice(from, to));
    for (let index = from; index < to; index++) {
      this.starts.push(source.start[index] ?? -1);
      this.ends.push(source.end[index] ?? -1);
    }
  }

  synth(text: string): void {
    this.texts.push(text);
    for (let index = 0; index < text.length; index++) {
      this.starts.push(-1);
      this.ends.push(-1);
    }
  }

  char(char: string, start: number, end: number): void {
    this.texts.push(char);
    this.starts.push(start);
    this.ends.push(end);
  }

  append(fragment: Tracked): void {
    this.keep(fragment, 0, fragment.text.length);
  }

  build(): Tracked {
    return {
      text: this.texts.join(''),
      start: Int32Array.from(this.starts),
      end: Int32Array.from(this.ends),
    };
  }
}

type Part = { keep: [number, number] } | { synth: string } | { tracked: Tracked };

function applyParts(builder: TrackedBuilder, source: Tracked, parts: Part[]): void {
  for (const part of parts) {
    if ('keep' in part) {
      builder.keep(source, part.keep[0], part.keep[1]);
    } else if ('synth' in part) {
      builder.synth(part.synth);
    } else {
      builder.append(part.tracked);
    }
  }
}

function withIndices(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.includes('d') ? pattern.flags : `${pattern.flags}d`
  );
}

function groupRange(match: RegExpExecArray, group: number): [number, number] | null {
  const range = match.indices?.[group];
  return range === undefined ? null : [range[0], range[1]];
}

/** 等价于 String.prototype.replace(全局正则, 回调)：先按 lastIndex 收集全部匹配，再逐个替换。 */
function trackedReplace(
  source: Tracked,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => Part[]
): Tracked {
  const scanner = withIndices(pattern);
  const builder = new TrackedBuilder();
  let cursor = 0;
  for (let match = scanner.exec(source.text); match !== null; match = scanner.exec(source.text)) {
    if (match[0].length === 0) {
      throw new Error(`tracked replay: unexpected empty match for /${pattern.source}/`);
    }
    builder.keep(source, cursor, match.index);
    applyParts(builder, source, replacer(match));
    cursor = match.index + match[0].length;
  }
  builder.keep(source, cursor, source.text.length);
  return builder.build();
}

function keepGroupThenSynth(group: number, synth: string): (match: RegExpExecArray) => Part[] {
  return (match) => {
    const range = groupRange(match, group);
    return range === null ? [{ synth }] : [{ keep: range }, { synth }];
  };
}

function wholeSynth(synth: string): (match: RegExpExecArray) => Part[] {
  return () => [{ synth }];
}

function keepWhole(match: RegExpExecArray): Part[] {
  return [{ keep: [match.index, match.index + match[0].length] }];
}

function breaksOf(text: string, pattern: RegExp): string {
  return (text.match(pattern) || []).join('');
}

/** 解码 JSON 字符串字面量（含两侧引号），每个解码字符继承其转义序列的来源区间。 */
function decodeLiteral(source: Tracked, from: number, to: number): Tracked {
  const builder = new TrackedBuilder();
  const text = source.text;
  let index = from + 1;
  while (index < to - 1) {
    const char = text[index] ?? '';
    let decoded = char;
    let length = 1;
    if (char === '\\') {
      const escapeChar = text[index + 1] ?? '';
      if (escapeChar === 'u') {
        decoded = String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
        length = 6;
      } else {
        const table: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        decoded = table[escapeChar] ?? escapeChar;
        length = 2;
      }
    }
    let low = -1;
    let high = -1;
    for (let cursor = index; cursor < index + length; cursor++) {
      const start = source.start[cursor] ?? -1;
      if (start < 0) {
        continue;
      }
      low = low < 0 ? start : Math.min(low, start);
      high = Math.max(high, source.end[cursor] ?? -1);
    }
    builder.char(decoded, low, high);
    index += length;
  }
  return builder.build();
}

/** 与 JSON.stringify（良构字符串）逐码元一致的编码；编码出的字符继承原字符的来源。 */
function encodeLiteral(value: Tracked): Tracked {
  const builder = new TrackedBuilder();
  builder.synth('"');
  const text = value.text;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const start = value.start[index] ?? -1;
    const end = value.end[index] ?? -1;
    const push = (encoded: string): void => {
      for (const char of encoded) {
        builder.char(char, start, end);
      }
    };
    if (code === 0x22) {
      push('\\"');
    } else if (code === 0x5c) {
      push('\\\\');
    } else if (code === 0x08) {
      push('\\b');
    } else if (code === 0x0c) {
      push('\\f');
    } else if (code === 0x0a) {
      push('\\n');
    } else if (code === 0x0d) {
      push('\\r');
    } else if (code === 0x09) {
      push('\\t');
    } else if (code < 0x20) {
      push(`\\u${code.toString(16).padStart(4, '0')}`);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        builder.char(text[index] ?? '', start, end);
        builder.char(
          text[index + 1] ?? '',
          value.start[index + 1] ?? -1,
          value.end[index + 1] ?? -1
        );
        index++;
      } else {
        push(`\\u${code.toString(16)}`);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      push(`\\u${code.toString(16)}`);
    } else {
      builder.char(text[index] ?? '', start, end);
    }
  }
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
  return trackedReplace(source, new RegExp(JSON_STRING, 'g'), (match) => {
    const literal = match[0];
    let value: string;
    try {
      value = JSON.parse(literal) as string;
    } catch (err: unknown) {
      void err;
      return keepWhole(match);
    }
    const inner = decodeLiteral(source, match.index, match.index + literal.length);
    if (inner.text !== value) {
      throw new Error('tracked replay: literal decode mismatch');
    }
    const redacted = recurse(inner, depth + 1);
    if (redacted.text === value) {
      return keepWhole(match);
    }
    const encoded = encodeLiteral(redacted);
    if (encoded.text !== JSON.stringify(redacted.text)) {
      throw new Error('tracked replay: literal encode mismatch');
    }
    return [{ tracked: encoded }];
  });
}

// ---------------------------------------------------------------------------------------------
// v0 246055e（规则来源：git show 246055e:src/agent/utils/Redaction.ts 第 9-16 行）
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
    keepGroupThenSynth(1, '[redacted-token]')
  );
  return trackedReplace(
    text,
    /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
    keepGroupThenSynth(1, '[redacted]')
  );
}

// ---------------------------------------------------------------------------------------------
// v1 1b394ce（规则来源：git show 1b394ce:src/agent/utils/Redaction.ts 第 10-22 行）
// ---------------------------------------------------------------------------------------------
function replay1b394ce(source: Tracked): Tracked {
  let text = trackedReplace(
    source,
    /("(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    keepGroupThenSynth(1, '"[redacted]"')
  );
  text = trackedReplace(text, /sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, wholeSynth('[redacted-api-key]'));
  text = trackedReplace(text, /AIza[0-9A-Za-z_-]{20,}/g, wholeSynth('[redacted-google-api-key]'));
  text = trackedReplace(
    text,
    /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    keepGroupThenSynth(1, '[redacted-token]')
  );
  return trackedReplace(
    text,
    /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
    keepGroupThenSynth(1, '[redacted]')
  );
}

// ---------------------------------------------------------------------------------------------
// v2 d113986（规则来源：git show d113986:src/agent/utils/Redaction.ts 第 5-89 行）
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
  if (depth > 8) {
    const builder = new TrackedBuilder();
    builder.synth('[redacted-nested-value]');
    return builder.build();
  }
  const jsonFields = trackedReplace(source, V2_JSON_FIELD, (match) => {
    const keyText = match[1] ?? '';
    const valueText = match[3] ?? '';
    try {
      const key = JSON.parse(keyText) as string;
      if (V2_SECRET_KEY.test(key)) {
        const valueRange = groupRange(match, 3);
        return [
          { keep: [match.index, valueRange === null ? match.index : valueRange[0]] },
          { synth: `"[redacted]"${breaksOf(valueText, NEWLINES)}` },
        ];
      }
    } catch (err: unknown) {
      void err;
    }
    return keepWhole(match);
  });
  const decoded = replayLiterals(jsonFields, depth, replayD113986);
  let text = trackedReplace(decoded, V2_UNTERMINATED, (match) => {
    const quote = groupRange(match, 2);
    return [
      { keep: [match.index, quote === null ? match.index : quote[1]] },
      { synth: `[redacted]${breaksOf(match[3] ?? '', NEWLINES)}` },
    ];
  });
  text = trackedReplace(text, V2_QUOTED, (match) => {
    const quote = groupRange(match, 2);
    return [
      { keep: [match.index, quote === null ? match.index : quote[1]] },
      { synth: `[redacted]${breaksOf(match[3] ?? '', NEWLINES)}${match[2] ?? ''}` },
    ];
  });
  text = trackedReplace(text, /sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, wholeSynth('[redacted-api-key]'));
  text = trackedReplace(text, /AIza[0-9A-Za-z_-]{20,}/g, wholeSynth('[redacted-google-api-key]'));
  text = trackedReplace(
    text,
    /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    keepGroupThenSynth(1, '[redacted-token]')
  );
  text = trackedReplace(
    text,
    /(authorization\s*[:=]\s*Basic\s+)[A-Za-z0-9+/=_-]+/gi,
    keepGroupThenSynth(1, '[redacted-token]')
  );
  return trackedReplace(text, V2_BARE, (match) => {
    const prefix = match[1] ?? '';
    const keyQuote = match[2] ?? '';
    const body = match[3] ?? '';
    if (/^authorization["']?\s*[:=]/i.test(prefix) && /^(Bearer|Basic)$/i.test(body)) {
      return keepWhole(match);
    }
    const prefixRange = groupRange(match, 1);
    return [
      { keep: [match.index, prefixRange === null ? match.index : prefixRange[1]] },
      { synth: `${keyQuote}[redacted]${keyQuote}` },
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// v3 b60a61e（规则与判定函数来源：git show b60a61e:src/agent/utils/Redaction.ts，即 HEAD 现行规则）
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
  replacer: (match: RegExpExecArray, text: string) => Part[] | null
): Tracked {
  const scanner = withIndices(pattern);
  const builder = new TrackedBuilder();
  let cursor = 0;
  for (let match = scanner.exec(source.text); match !== null; match = scanner.exec(source.text)) {
    const parts = replacer(match, source.text);
    if (parts === null) {
      scanner.lastIndex = match.index + Math.max(1, (match[1] ?? '').length);
      continue;
    }
    builder.keep(source, cursor, match.index);
    applyParts(builder, source, parts);
    cursor = match.index + match[0].length;
  }
  builder.keep(source, cursor, source.text.length);
  return builder.build();
}

function replayContainers(source: Tracked): Tracked {
  const text = source.text;
  const builder = new TrackedBuilder();
  let cursor = 0;
  for (const match of text.matchAll(JSON_CONTAINER_FIELD)) {
    const start = match.index + match[0].length;
    if (match.index < cursor || !isSensitiveJsonKey(match[1] ?? '')) {
      continue;
    }
    const end = findContainerEnd(text, start);
    const valueEnd = end ?? text.length;
    builder.keep(source, cursor, start);
    builder.synth(
      `${end === null ? '"[redacted]' : '"[redacted]"'}${breaksOf(text.slice(start, valueEnd), NEWLINES)}`
    );
    cursor = valueEnd;
  }
  builder.keep(source, cursor, text.length);
  return builder.build();
}

function replayB60a61e(source: Tracked, depth: number): Tracked {
  if (depth > 8) {
    const builder = new TrackedBuilder();
    builder.synth('[redacted-nested-value]');
    return builder.build();
  }
  const containers = replayContainers(source);
  const jsonFields = trackedReplace(containers, JSON_FIELD, (match) => {
    if (!isSensitiveJsonKey(match[1] ?? '')) {
      return keepWhole(match);
    }
    const valueRange = groupRange(match, 3);
    return [
      { keep: [match.index, valueRange === null ? match.index : valueRange[0]] },
      { synth: `"[redacted]"${breaksOf(match[3] ?? '', NEWLINES)}` },
    ];
  });
  const decoded = replayLiterals(jsonFields, depth, replayB60a61e);
  let text = trackedReplace(decoded, PEM_PRIVATE_KEY, (match) => {
    const body = match[4] ?? '';
    const [start, stop] = pemContentBounds(body);
    if (start >= stop) {
      return keepWhole(match);
    }
    const beginRange = groupRange(match, 1);
    const bodyRange = groupRange(match, 4);
    const endRange = groupRange(match, 5);
    if (beginRange === null || bodyRange === null) {
      throw new Error('tracked replay: PEM groups missing');
    }
    const parts: Part[] = [
      { keep: beginRange },
      { keep: [bodyRange[0], bodyRange[0] + start] },
      {
        synth: `[redacted-private-key]${breaksOf(body.slice(start, stop), /\r\n|\r|\n|\\r\\n|\\n|\\r/g)}`,
      },
      { keep: [bodyRange[0] + stop, bodyRange[1]] },
    ];
    if (endRange !== null) {
      parts.push({ keep: endRange });
    }
    return parts;
  });
  text = trackedReplace(text, URL_USERINFO, (match) => {
    const userRange = groupRange(match, 1);
    const at = match.index + match[0].length - 1;
    return [
      { keep: userRange ?? [match.index, match.index] },
      { synth: '[redacted]' },
      { keep: [at, at + 1] },
    ];
  });
  text = trackedReplaceAssignments(text, UNTERMINATED_ASSIGNMENT, (match) => {
    const key = match[1] ?? '';
    if (classifyKey(key) === null) {
      return null;
    }
    const quote = groupRange(match, 3);
    return [
      { keep: [match.index, quote === null ? match.index : quote[1]] },
      { synth: `[redacted]${breaksOf(match[4] ?? '', NEWLINES)}` },
    ];
  });
  text = trackedReplaceAssignments(text, QUOTED_ASSIGNMENT, (match) => {
    const key = match[1] ?? '';
    if (classifyKey(key) === null) {
      return null;
    }
    const quote = groupRange(match, 3);
    return [
      { keep: [match.index, quote === null ? match.index : quote[1]] },
      { synth: `[redacted]${breaksOf(match[4] ?? '', NEWLINES)}${match[3] ?? ''}` },
    ];
  });
  text = trackedReplace(text, /sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, wholeSynth('[redacted-api-key]'));
  text = trackedReplace(text, /AIza[0-9A-Za-z_-]{20,}/g, wholeSynth('[redacted-google-api-key]'));
  text = trackedReplace(
    text,
    /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    keepGroupThenSynth(1, '[redacted-token]')
  );
  text = trackedReplace(
    text,
    /(authorization\s*[:=]\s*Basic\s+)[A-Za-z0-9+/=_-]+/gi,
    keepGroupThenSynth(1, '[redacted-token]')
  );
  return trackedReplaceAssignments(text, BARE_ASSIGNMENT, (match, source) => {
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
      preceding: precedingOnLine(source, match.index),
      following: source.slice(end, end + CONTEXT_WINDOW),
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
    const valueRange = groupRange(match, 6);
    return [
      { keep: [match.index, valueRange === null ? match.index : valueRange[0]] },
      { synth: `${keyQuote}[redacted]${keyQuote}` },
    ];
  });
}

const FROZEN: Record<BaselineRevision, (text: string) => string> = {
  '246055e': redactAt246055e,
  '1b394ce': redactAt1b394ce,
  d113986: redactAtD113986,
  b60a61e: redactAtB60a61e,
};

const REPLAYS: Record<BaselineRevision, (source: Tracked) => Tracked> = {
  '246055e': replay246055e,
  '1b394ce': replay1b394ce,
  d113986: (source) => replayD113986(source, 0),
  b60a61e: (source) => replayB60a61e(source, 0),
};

export const BASELINE_REVISIONS: readonly BaselineRevision[] = [
  '246055e',
  '1b394ce',
  'd113986',
  'b60a61e',
];

export function frozenRedact(revision: BaselineRevision, text: string): string {
  return FROZEN[revision](text);
}

/**
 * 对任意已带来源的文本重放某个版本；重放文本必须与该版本真实输出逐字节相同，否则抛错
 * （说明重放实现与冻结代码不一致，oracle 不能下结论）。
 */
export function replayTracked(revision: BaselineRevision, source: Tracked): Tracked {
  const replayed = REPLAYS[revision](source);
  const actual = FROZEN[revision](source.text);
  if (replayed.text !== actual) {
    throw new Error(
      `tracked replay of ${revision} diverged from the frozen output (replay ${JSON.stringify(replayed.text.slice(0, 200))} vs actual ${JSON.stringify(actual.slice(0, 200))})`
    );
  }
  return replayed;
}

/** 某个版本在 x 上精确遮住的位置（1 = 没有任何输出字符取自该位置）。 */
export function exactHidden(revision: BaselineRevision, x: string): Uint8Array {
  return hiddenFromTracked(replayTracked(revision, originTracked(x)), x.length);
}

export function hiddenFromTracked(tracked: Tracked, length: number): Uint8Array {
  const visible = new Uint8Array(length);
  for (let index = 0; index < tracked.text.length; index++) {
    const start = tracked.start[index] ?? -1;
    const end = tracked.end[index] ?? -1;
    for (let cursor = Math.max(0, start); cursor < end && cursor < length; cursor++) {
      visible[cursor] = 1;
    }
  }
  const hidden = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    hidden[index] = visible[index] === 1 ? 0 : 1;
  }
  return hidden;
}
