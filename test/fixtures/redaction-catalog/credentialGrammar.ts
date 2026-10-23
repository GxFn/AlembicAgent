/**
 * 凭据语法生成器 G（设计 redaction-design-2026-10-19 第 6 节阶段 4 测试要求 2；阶段 4b 先覆盖 T1 的写法维度）。
 *
 * 判据只来自生成器自身的元数据，不调用被测实现：每个用例都记下秘密在最终输入里的位置（secret）和凭据位置
 * （credential region：值的起点到写法结束，含截断标记）。测试据此判定两件事：
 * 1. 秘密的任何不短于 4 字符的片段都不得出现在脱敏输出里（只计输入里仅出现在秘密之内的片段，并排除标记词表
 *    自身的片段，避免巧合误报）；
 * 2. “G 缺维度”：四个历史版本遮住的任何非结构字符都必须落在 G 声明的凭据位置上。若某基线遮住了别处，说明输入里
 *    还有 G 不知道的凭据写法（载体、行前缀或写法本身被基线当成了凭据），G 的维度模型不完整，判失败。
 *
 * 维度：秘密 × 写法 × 载体 × 行前缀 × 截断位置。
 * - 秘密：T1 的前缀 token（GitHub 经典与细粒度、GitLab、Slack、Stripe、npm、Anthropic、Google、AWS 访问密钥 ID）、
 *   JWT（这些在任何写法下都由 T1 覆盖），以及通用口令（只在 T1 声明覆盖的写法下出现：URL basic auth、
 *   URL 里 ${…:-默认值}、认证头、Cookie / Set-Cookie）。
 * - 写法：散文、env 赋值、YAML 冒号、YAML 块标量、JSON 字段、URL basic auth、URL 默认值、# 与 // 注释、CSV、
 *   Authorization（多种方案）、Proxy-Authorization、Cookie、Set-Cookie。键名都不含历史版本的敏感关键字，
 *   这样基线只会在声明的凭据位置上动手（G 缺维度检查才有意义）。
 * - 载体：原文、JSON、二次 JSON、CRLF、字面 \n 转义。
 * - 行前缀：N|、cat -n、path:N:、NN: 、diff +/-、//、#、*、>、INFO 、pytest 的 E   （每一行都加）。
 * - 截断：不截断，或在秘密内部截断后接 ...、…、[truncated]、 [truncated]、... [N lines omitted] ...，写法在截断
 *   点之后的部分全部丢弃。
 * 后续包（T2 关键字扩展、PEM 状态机、YAML 嵌套映射、T3 按来源）在这里追加秘密种类与写法，并在 claims 里声明覆盖。
 * 所有秘密都是运行时按片段拼接的合成值（SYNTHETIC 字母表），源码里不出现连续的 token 形态。
 */
import { seededRandom } from './fuzzCorpus.js';

type Random = () => number;

function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) {
    throw new Error('credential grammar: empty pick');
  }
  return item;
}

function randomString(random: Random, length: number, alphabet: string): string {
  let out = '';
  for (let index = 0; index < length; index++) {
    out += alphabet[Math.floor(random() * alphabet.length)];
  }
  return out;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ALNUM_DASH = `${ALNUM}_-`;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE64URL = `${ALNUM}_-`;
const TOKEN68 = `${ALNUM}-._~`;
const PATHY = `${ALNUM}/?#@:`;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export interface GeneratedSecret {
  value: string;
  /** 截断时最少保留的可见长度（前缀 + 至少 4 个正文字符；JWT 至少保留一个签名字符）。 */
  minCut: number;
}

export interface SecretKind {
  id: string;
  /** true：T1 在任何写法下都覆盖（前缀 token、JWT）；false：只在 T1 声明覆盖的写法下出现。 */
  anywhere: boolean;
  make: (random: Random) => GeneratedSecret;
}

/** 前缀与正文分开拼接，源码文本里不出现完整的 token 形态。 */
function prefixed(prefix: string, body: string): GeneratedSecret {
  return { value: `${prefix}${body}`, minCut: prefix.length + 4 };
}

export const SECRET_KINDS: readonly SecretKind[] = [
  {
    id: 'github-classic',
    anywhere: true,
    make: (random) =>
      prefixed(
        ['gh', pick(random, ['p', 'o', 'u', 's', 'r']), '_'].join(''),
        randomString(random, 36, ALNUM)
      ),
  },
  {
    id: 'github-fine-grained',
    anywhere: true,
    make: (random) =>
      prefixed(
        ['github', '_pat_'].join(''),
        `${randomString(random, 22, ALNUM)}_${randomString(random, 59, ALNUM)}`
      ),
  },
  {
    id: 'gitlab',
    anywhere: true,
    make: (random) => prefixed(['glpat', '-'].join(''), randomString(random, 20, ALNUM_DASH)),
  },
  {
    id: 'slack',
    anywhere: true,
    make: (random) =>
      prefixed(
        ['xox', pick(random, ['a', 'b', 'p', 'o', 's', 'r']), '-'].join(''),
        `${randomString(random, 10, '0123456789')}-${randomString(random, 12, '0123456789')}-${randomString(random, 24, ALNUM)}`
      ),
  },
  {
    id: 'stripe',
    anywhere: true,
    make: (random) =>
      prefixed(
        [pick(random, ['s', 'r']), 'k_', pick(random, ['live', 'test']), '_'].join(''),
        randomString(random, 24, ALNUM)
      ),
  },
  {
    id: 'npm',
    anywhere: true,
    make: (random) => prefixed(['npm', '_'].join(''), randomString(random, 36, ALNUM)),
  },
  {
    id: 'anthropic',
    anywhere: true,
    make: (random) =>
      prefixed(['sk', '-ant-'].join(''), `api03-${randomString(random, 93, ALNUM_DASH)}AA`),
  },
  {
    id: 'google',
    anywhere: true,
    make: (random) => prefixed(['AI', 'za'].join(''), randomString(random, 35, ALNUM_DASH)),
  },
  {
    id: 'aws-access-key-id',
    anywhere: true,
    make: (random) =>
      prefixed(
        pick(random, [['AK', 'IA'].join(''), ['AS', 'IA'].join('')]),
        randomString(random, 16, BASE32)
      ),
  },
  {
    id: 'jwt',
    anywhere: true,
    make: (random) => {
      const head = `${base64UrlJson({ alg: pick(random, ['HS256', 'RS256']), typ: 'JWT' })}.${base64UrlJson(
        {
          sub: `SYNTHETIC${randomString(random, 6, ALNUM)}`,
          iat: Math.floor(random() * 1_000_000),
        }
      )}.`;
      return { value: `${head}${randomString(random, 43, BASE64URL)}`, minCut: head.length + 1 };
    },
  },
  {
    id: 'password',
    anywhere: false,
    make: (random) => ({ value: `SYN${randomString(random, 17, TOKEN68)}`, minCut: 4 }),
  },
  {
    id: 'path-password',
    anywhere: false,
    make: (random) => ({ value: `SYN${randomString(random, 17, PATHY)}`, minCut: 4 }),
  },
];

/** 写法的四段：lead（凭据位置之前）、open（凭据位置内、秘密之前）、close（秘密之后）、tail（凭据位置之后）。 */
export interface WritingParts {
  lead: string;
  open: string;
  close: string;
  tail: string;
}

export interface Writing {
  id: string;
  /** 该写法下 T1 声明覆盖的秘密种类。 */
  accepts: (kind: SecretKind) => boolean;
  build: (random: Random) => WritingParts;
}

const anywhereOnly = (kind: SecretKind): boolean => kind.anywhere;
const tokenOrPassword = (kind: SecretKind): boolean => kind.anywhere || kind.id === 'password';

export const WRITINGS: readonly Writing[] = [
  {
    id: 'prose',
    accepts: anywhereOnly,
    build: () => ({ lead: 'deploy credential ', open: '', close: '', tail: ' rotated nightly' }),
  },
  {
    id: 'env',
    accepts: anywhereOnly,
    build: () => ({ lead: 'export DEPLOY_CRED=', open: '', close: '', tail: '' }),
  },
  {
    id: 'yaml-colon',
    accepts: anywhereOnly,
    build: () => ({ lead: 'deploy_cred: ', open: '', close: '', tail: '\nregion: eu' }),
  },
  {
    id: 'yaml-block-scalar',
    accepts: anywhereOnly,
    build: (random) => ({
      lead: 'deploy_cred: ',
      open: `${pick(random, ['|', '>', '|-'])}\n  `,
      close: '',
      tail: '\nregion: eu',
    }),
  },
  {
    id: 'json-field',
    accepts: anywhereOnly,
    build: () => ({ lead: '{"cred": ', open: '"', close: '"', tail: ', "region": "eu"}' }),
  },
  {
    id: 'url-basic-auth',
    accepts: tokenOrPassword,
    build: (random) => ({
      lead: `git remote add origin ${pick(random, ['https', 'ssh', 'git+https'])}://deploy:`,
      open: '',
      close: '',
      tail: '@git.example.com/org/repo.git',
    }),
  },
  {
    id: 'url-env-default',
    accepts: (kind) => kind.anywhere || kind.id === 'password' || kind.id === 'path-password',
    build: (random) => ({
      lead: `DATABASE_URL: ${pick(random, ['postgres', 'mongodb+srv', 'redis'])}://app:`,
      open: ['$', '{DB_PASS:-'].join(''),
      close: '}',
      tail: '@db.internal:5432/app',
    }),
  },
  {
    id: 'comment-hash',
    accepts: anywhereOnly,
    build: () => ({ lead: '# old value ', open: '', close: '', tail: ' (revoked)' }),
  },
  {
    id: 'comment-slash',
    accepts: anywhereOnly,
    build: () => ({ lead: '// fallback ', open: '', close: '', tail: '' }),
  },
  {
    id: 'csv',
    accepts: anywhereOnly,
    build: () => ({ lead: 'svc-deploy,', open: '', close: '', tail: ',2026-10-21,active' }),
  },
  {
    id: 'authorization-header',
    accepts: tokenOrPassword,
    build: (random) => ({
      lead: 'Authorization: ',
      open: `${pick(random, ['Bearer', 'Token', 'Basic', 'Bot', 'ApiKey'])} `,
      close: '',
      tail: '',
    }),
  },
  {
    id: 'proxy-authorization-header',
    accepts: tokenOrPassword,
    build: () => ({ lead: 'Proxy-Authorization: ', open: 'Basic ', close: '', tail: '' }),
  },
  {
    id: 'cookie-header',
    accepts: tokenOrPassword,
    build: () => ({ lead: 'Cookie: theme=dark; session=', open: '', close: '', tail: '; lang=en' }),
  },
  {
    id: 'set-cookie-header',
    accepts: tokenOrPassword,
    build: () => ({ lead: 'Set-Cookie: sid=', open: '', close: '', tail: '; Path=/; HttpOnly' }),
  },
];

export interface LinePrefix {
  id: string;
  make: (line: number) => string;
}

export const LINE_PREFIXES: readonly LinePrefix[] = [
  { id: 'none', make: () => '' },
  { id: 'N|', make: (line) => `${line}|` },
  { id: 'cat -n', make: (line) => `    ${line}\t` },
  { id: 'path:N:', make: (line) => `src/app/settings.ts:${line}:` },
  { id: 'NN: ', make: (line) => `  ${line}: ` },
  { id: 'diff +', make: () => '+' },
  { id: 'diff -', make: () => '-' },
  { id: '//', make: () => '// ' },
  { id: '#', make: () => '# ' },
  { id: '*', make: () => ' * ' },
  { id: '>', make: () => '> ' },
  { id: 'INFO', make: () => 'INFO ' },
  { id: 'pytest E', make: () => 'E   ' },
];

export const TRUNCATION_MARKERS: readonly string[] = [
  '...',
  '…',
  '[truncated]',
  ' [truncated]',
  '... [42 lines omitted] ...',
];

/** 一层编码：每个输入字符独立映射到输出（JSON 转义、换行替换都是逐字符的），map[i] 是输入字符 i 的输出起点。 */
interface Encoded {
  text: string;
  /** 长度为输入长度 + 1；map[input.length] 是编码后正文的结束位置。 */
  map: Int32Array;
}

function encodeEach(
  text: string,
  encodeChar: (char: string) => string,
  prefix = '',
  suffix = ''
): Encoded {
  const map = new Int32Array(text.length + 1);
  let out = prefix;
  for (let index = 0; index < text.length; index++) {
    map[index] = out.length;
    out += encodeChar(text[index] ?? '');
  }
  map[text.length] = out.length;
  return { text: out + suffix, map };
}

function compose(inner: Int32Array, outer: Int32Array): Int32Array {
  const map = new Int32Array(inner.length);
  for (let index = 0; index < inner.length; index++) {
    map[index] = outer[inner[index] ?? 0] ?? 0;
  }
  return map;
}

const jsonEscape = (char: string): string => JSON.stringify(char).slice(1, -1);

export interface Carrier {
  id: string;
  encode: (text: string) => Encoded;
}

export const CARRIERS: readonly Carrier[] = [
  { id: 'raw', encode: (text) => encodeEach(text, (char) => char) },
  {
    id: 'json',
    encode: (text) => encodeEach(text, jsonEscape, '{"stdout":"', '","status":"success"}'),
  },
  {
    id: 'json2',
    encode: (text) => {
      const inner = encodeEach(text, jsonEscape, '{"stdout":"', '"}');
      const outer = encodeEach(inner.text, jsonEscape, '{"message":"', '"}');
      return { text: outer.text, map: compose(inner.map, outer.map) };
    },
  },
  { id: 'crlf', encode: (text) => encodeEach(text, (char) => (char === '\n' ? '\r\n' : char)) },
  {
    id: 'escaped-newline',
    encode: (text) =>
      encodeEach(text, (char) => (char === '\n' ? '\\n' : char === '\r' ? '\\r' : char)),
  },
];

/** 在每一行行首插入前缀（行号从 41 起），返回新文本与位置映射。 */
function prefixLines(text: string, prefix: LinePrefix): Encoded {
  const map = new Int32Array(text.length + 1);
  let line = 41;
  let out = prefix.make(line);
  for (let index = 0; index < text.length; index++) {
    map[index] = out.length;
    const char = text[index] ?? '';
    out += char;
    if (char === '\n') {
      line++;
      out += prefix.make(line);
    }
  }
  map[text.length] = out.length;
  return { text: out, map };
}

export interface GrammarCase {
  input: string;
  /** 输入里可见的秘密（截断后只剩可见部分）。 */
  secrets: string[];
  /** 秘密在输入里的区间 [start, end)。 */
  secretSpans: Array<[number, number]>;
  /** 凭据位置区间 [start, end)：基线只允许在这里遮蔽。 */
  regions: Array<[number, number]>;
  dims: {
    secret: string;
    writing: string;
    carrier: string;
    prefix: string;
    truncation: string;
  };
}

/** 声明覆盖的（秘密种类, 写法）组合。 */
export function claimedCombos(): Array<{ kind: SecretKind; writing: Writing }> {
  const combos: Array<{ kind: SecretKind; writing: Writing }> = [];
  for (const writing of WRITINGS) {
    for (const kind of SECRET_KINDS) {
      if (writing.accepts(kind)) {
        combos.push({ kind, writing });
      }
    }
  }
  return combos;
}

/**
 * 固定种子生成 count 个用例：（秘密, 写法）按声明覆盖的组合轮转分层，载体按轮次分层，行前缀、截断与写法
 * 内部的选择取自随机数。
 */
export function credentialGrammarCases(count: number, seed: number): GrammarCase[] {
  const random = seededRandom(seed);
  const combos = claimedCombos();
  const cases: GrammarCase[] = [];
  for (let index = 0; index < count; index++) {
    const combo = combos[index % combos.length];
    if (combo === undefined) {
      throw new Error('credential grammar: no combos');
    }
    const carrier = CARRIERS[Math.floor(index / combos.length) % CARRIERS.length];
    if (carrier === undefined) {
      throw new Error('credential grammar: no carrier');
    }
    const prefix = pick(random, LINE_PREFIXES);
    const secret = combo.kind.make(random);
    const parts = combo.writing.build(random);
    const truncated = random() < 0.4;
    const marker = truncated ? pick(random, TRUNCATION_MARKERS) : '';
    let visible = secret.value;
    if (truncated) {
      const span = secret.value.length - secret.minCut;
      visible = secret.value.slice(0, secret.minCut + Math.floor(random() * Math.max(1, span)));
    }
    const raw = truncated
      ? `${parts.lead}${parts.open}${visible}${marker}`
      : `${parts.lead}${parts.open}${visible}${parts.close}${parts.tail}`;
    const regionStart = parts.lead.length;
    const secretStart = regionStart + parts.open.length;
    const secretEnd = secretStart + visible.length;
    const regionEnd = truncated ? raw.length : secretEnd + parts.close.length;
    const lined = prefixLines(raw, prefix);
    const encoded = carrier.encode(lined.text);
    const at = (position: number): number => encoded.map[lined.map[position] ?? 0] ?? 0;
    cases.push({
      input: encoded.text,
      secrets: [visible],
      secretSpans: [[at(secretStart), at(secretEnd)]],
      regions: [[at(regionStart), at(regionEnd)]],
      dims: {
        secret: combo.kind.id,
        writing: combo.writing.id,
        carrier: carrier.id,
        prefix: prefix.id,
        truncation: truncated ? marker : 'none',
      },
    });
  }
  return cases;
}

/**
 * 秘密泄漏判据（只用元数据）：秘密的 4 字符片段出现在输出里即泄漏。排除输入里在秘密之外也出现的片段与标记词表
 * 自身的片段（巧合，不能归因到秘密）。返回泄漏的片段。
 */
export function leakedFragments(
  entry: GrammarCase,
  output: string,
  vocabulary: readonly string[]
): string[] {
  const outside: string[] = [];
  let cursor = 0;
  for (const [start, end] of entry.secretSpans) {
    outside.push(entry.input.slice(cursor, start));
    cursor = end;
  }
  outside.push(entry.input.slice(cursor));
  const elsewhere = outside.join('\u0000');
  const leaks: string[] = [];
  for (const secret of entry.secrets) {
    for (let index = 0; index + 4 <= secret.length; index++) {
      const gram = secret.slice(index, index + 4);
      if (elsewhere.includes(gram) || vocabulary.some((marker) => marker.includes(gram))) {
        continue;
      }
      if (output.includes(gram)) {
        leaks.push(gram);
      }
    }
  }
  return leaks;
}
