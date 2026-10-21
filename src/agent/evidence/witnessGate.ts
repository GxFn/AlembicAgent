/**
 * 严格链逐字节见证 profile 的写盘前闸门（脱敏阶段 3，L7-P11 方案 b；用户决定 D5，2026-10-19）。
 *
 * 见证 profile（contentProfile = 'verbatim-witness'）把宿主冻结的源文件逐字节写进
 * <dataRoot>/.asd/evidence-witness/<runId>/，不脱敏、不截断。这里决定一份内容能不能进入见证台账，
 * 只做“拒绝 / 放行”，从不改写内容：
 *
 * 1. 单文件上限：UTF-8 字节数超过 1 MiB 拒绝（按字节而不是字符计，多字节文本不能绕过上限）。
 * 2. UTF-8 往返：EvidenceEntry.content 是 string，Core 用 Buffer.from(content) 与冻结字节比对。
 *    - 孤立代理项（lone surrogate）无法按 UTF-8 往返，写进去后哈希与比对必然失配；
 *    - U+FFFD 是调用方把非 UTF-8 字节有损解码后的唯一痕迹（宿主用 toString('utf8') 解 base64），
 *      string 接口看不到原始字节，逐字节见证无法证明这些位置的原字节，所以同样拒绝。
 *      三仓源码（AlembicAgent/src+test、AlembicCore/src、Alembic/lib）实测含字面 U+FFFD 的文件为 0。
 * 3. 见证闸门：只用 T1 格式层里的三类高置信形态（设计 4.4/4.8 节）——带前缀的 token、JWT、
 *    带正文的 PEM 私钥块。URL userinfo、关键字赋值等低置信形态不进闸门：源码里的 `${password}`
 *    一类占位会被大量误拒，全量规则作闸门时三个仓库全部不可用（b-safe 方案已否决）。
 *
 * 拒绝理由只含原因、规则种类、规则 id 与文件路径，绝不带正文或匹配片段。
 *
 * 规则写成数据 {id, kind, pattern, examples, negativeExamples}，由测试逐条遍历正反例。
 * 正例全部在运行时按片段拼接的合成值（SYNTHETIC），源码文本里不出现连续的 token 形态，
 * 保证本文件被宿主投影捕获时不会命中自己。本模块不依赖任何其它模块，可单独加载做语料实测。
 */

/**
 * 见证闸门策略 id，进入见证 profile 的 storeConfigHash。闸门只拒绝、不改写内容，所以规则微调
 * 不影响已存内容的语义，不随之轮换；只有闸门语义整体改变（例如改为改写内容）时才换 id。
 */
export const WITNESS_GATE_POLICY_ID = 'evidence-witness-gate-t1-subset-v1';

/** 见证 profile 单文件上限：1 MiB（UTF-8 字节）。 */
export const WITNESS_MAX_CONTENT_BYTES = 1024 * 1024;

/**
 * U+FFFD（替换字符）：用码点构造，源码文本里不出现该字符本身，
 * 否则本文件被宿主投影捕获时会因为“有损解码痕迹”被自己的闸门拒绝。
 */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/** 见证拒绝错误的前缀；完整格式见 describeWitnessRejection。 */
export const WITNESS_REJECTION_ERROR_PREFIX = 'ALEMBIC_AGENT_EVIDENCE_WITNESS_REJECTED';

export type WitnessGateRuleKind = 'prefixed-token' | 'jwt' | 'pem-private-key';

export interface WitnessGateRule {
  readonly id: string;
  readonly kind: WitnessGateRuleKind;
  /** 候选匹配，必须带 g 标志（用 matchAll 迭代，matchAll 内部克隆正则，不共享 lastIndex）。 */
  readonly pattern: RegExp;
  /** 正例：必须被本规则命中。 */
  readonly examples: readonly string[];
  /** 反例：整个闸门都不得命中。 */
  readonly negativeExamples: readonly string[];
  /** 候选的二次确认（JWT 解码、PEM 正文行）；缺省表示候选即命中。 */
  readonly confirm?: (text: string, match: RegExpMatchArray) => boolean;
}

export interface WitnessGateHit {
  readonly ruleId: string;
  readonly kind: WitnessGateRuleKind;
}

export type WitnessContentRejection =
  | {
      readonly reason: 'CONTENT_TOO_LARGE';
      readonly kind: 'byte-limit';
      readonly byteLength: number;
    }
  | {
      readonly reason: 'CONTENT_NOT_UTF8';
      readonly kind: 'lone-surrogate' | 'replacement-character';
    }
  | {
      readonly reason: 'SECRET_DETECTED';
      readonly kind: WitnessGateRuleKind;
      readonly ruleId: string;
    };

/**
 * gitleaks 式左右边界。左边界额外接受紧跟在字面 `\n` `\r` `\t` 转义之后的位置：字符串字面量里
 * "line\nghp_…" 的 token 前一字符是字母 n，单靠非字母数字边界会漏掉。
 */
const LEFT_BOUNDARY = String.raw`(?:(?<![A-Za-z0-9_-])|(?<=\\[nrt]))`;
const RIGHT_BOUNDARY = '(?![A-Za-z0-9_-])';

function bounded(body: string): RegExp {
  return new RegExp(`${LEFT_BOUNDARY}${body}${RIGHT_BOUNDARY}`, 'g');
}

/** 按字母表循环拼出指定长度的合成串，只用于规则正反例。 */
function synthetic(
  length: number,
  alphabet = 'SYNTHETIC0123456789abcdefghijklmnopqrstuvwxyz'
): string {
  let out = '';
  for (let index = 0; out.length < length; index += 1) {
    out += alphabet[index % alphabet.length];
  }
  return out;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** base64url 段解码后是否为 JSON 对象（JWT 的 header 与 payload 都是 JSON 对象）。 */
function decodesToJsonObject(segment: string | undefined): boolean {
  if (!segment) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch (err: unknown) {
    // 解码或 JSON 解析失败只说明这不是 JWT（候选被否决），不是错误路径。
    void err;
    return false;
  }
}

function isJwtCandidateConfirmed(_text: string, match: RegExpMatchArray): boolean {
  return decodesToJsonObject(match[1]) && decodesToJsonObject(match[2]);
}

// ── PEM 私钥块：BEGIN … PRIVATE KEY 之后（跳过空行与 RFC 1421/OpenPGP 头行）的第一行必须是正文 ──
/**
 * 只看 BEGIN 标记之后这么多字符：足够容纳头行、空行与带缩进/拼接载体的第一行正文；
 * 有界窗口让“满文件重复 BEGIN 标记”这类输入的总开销保持线性（标记数 × 窗口）。
 */
const PEM_LOOKAHEAD_CHARS = 1024;
/** BEGIN 之后最多跳过的空行 / 头行数；超过仍没有正文就不算私钥块。 */
const PEM_MAX_SKIPPED_LINES = 8;
/** 正文行：去掉载体后整行是长度不少于 16 的 base64（可带 = 填充）。 */
const PEM_BODY_LINE = /^[A-Za-z0-9+/]{16,}={0,2}$/;
const PEM_HEADER_LINE = /^(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset|MessageID):/;
/** 字符串里的转义换行（含 JSON 二次转义的多个反斜杠）还原成真实换行，再按行判断。 */
const PEM_ESCAPED_LINE_BREAK = /\\+(?:r\\+n|n|r)/g;
/**
 * 行首载体：空白、注释前缀（`//` 后须跟空白，避免吃掉以 `/` 开头的 base64）、`# * ; > -`、
 * 引号、逗号、拼接用的 `+`、括号，以及 Python 的 b/r/u/f 字符串前缀。
 */
const PEM_LEADING_CARRIER = /^(?:\s|\/\/+(?=\s)|[#*;>'"`,+([{-]|[bBrRuUfF]{1,2}(?=["'`]))+/;
/** 行尾载体：空白、引号、逗号、分号、拼接的 `+`、右括号、续行反斜杠。 */
const PEM_TRAILING_CARRIER = /(?:\s|[\\'"`,;+)\]}])+$/;

/**
 * 单行形态：BEGIN 与 END 落在同一行（换行被替换成空格的环境变量 / JSON 值）。
 * 只看 END 标记之前的片段，按空白切成 token，任一 token 去掉载体后是正文行即命中；
 * 片段为空或只有 `[\s\S]*?` 一类正则 / 普通单词时不命中（标记本身不是私钥）。
 */
function hasInlinePemBody(segmentBeforeEnd: string): boolean {
  for (const token of segmentBeforeEnd.split(/\s+/)) {
    const stripped = token.replace(PEM_LEADING_CARRIER, '').replace(PEM_TRAILING_CARRIER, '');
    if (stripped.length > 0 && PEM_BODY_LINE.test(stripped)) {
      return true;
    }
  }
  return false;
}

function hasPemPrivateKeyBody(text: string, match: RegExpMatchArray): boolean {
  const start = (match.index ?? 0) + match[0].length;
  const window = text
    .slice(start, start + PEM_LOOKAHEAD_CHARS)
    .replace(PEM_ESCAPED_LINE_BREAK, '\n');
  let skipped = 0;
  for (const raw of window.split(/\r\n|\r|\n/)) {
    const endIndex = raw.indexOf('-----END');
    if (endIndex >= 0) {
      // 同一行就到了 END：要么是只有标记本身（文档、正则或常量），要么是把换行换成空格的
      // 单行私钥；前者不命中，后者按 END 之前的 token 判定。
      return hasInlinePemBody(raw.slice(0, endIndex));
    }
    const line = raw.replace(PEM_LEADING_CARRIER, '').replace(PEM_TRAILING_CARRIER, '');
    if (line.length === 0 || PEM_HEADER_LINE.test(line)) {
      skipped += 1;
      if (skipped > PEM_MAX_SKIPPED_LINES) {
        return false;
      }
      continue;
    }
    // 第一条非空、非头行就是判定行：是正文即命中，否则标记后面接的是普通文本或代码。
    return PEM_BODY_LINE.test(line);
  }
  return false;
}

// ── 合成正反例（运行时拼接） ──
const pemBegin = (label: string) => ['-----BEGIN', `${label}PRIVATE KEY-----`].join(' ');
const pemEnd = (label: string) => ['-----END', `${label}PRIVATE KEY-----`].join(' ');
const pemBody = synthetic(64, 'SYNTHETICbase64+/');
const pemTail = synthetic(24, 'SYNTHETIC/');
const jwtHeader = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
const jwtPayload = base64UrlJson({ sub: 'SYNTHETIC', iat: 0 });

function freezeRule(rule: WitnessGateRule): WitnessGateRule {
  return Object.freeze({
    ...rule,
    examples: Object.freeze([...rule.examples]),
    negativeExamples: Object.freeze([...rule.negativeExamples]),
  });
}

/** 规则表原稿；导出前逐条冻结（含正反例数组）。 */
const RULE_TABLE: readonly WitnessGateRule[] = [
  {
    id: 'github-token',
    kind: 'prefixed-token',
    pattern: bounded('gh[pousr]_[A-Za-z0-9]{36}'),
    examples: ['p', 'o', 'u', 's', 'r'].map((letter) => `gh${letter}_${synthetic(36)}`),
    negativeExamples: [
      `gh${'p'}_${synthetic(35)}`,
      `gh${'p'}_${synthetic(37)}`,
      `x${'gh'}p_${synthetic(36)}`,
      `gh${'x'}_${synthetic(36)}`,
      'const prefix = "ghp_";',
    ],
  },
  {
    id: 'github-fine-grained-pat',
    kind: 'prefixed-token',
    pattern: bounded('github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}'),
    examples: [`github${'_pat_'}${synthetic(22)}_${synthetic(59)}`],
    negativeExamples: [
      'const kind = "github_pat_placeholder";',
      `github${'_pat_'}${synthetic(22)}_${synthetic(20)}`,
    ],
  },
  {
    id: 'gitlab-pat',
    kind: 'prefixed-token',
    pattern: bounded('glpat-[A-Za-z0-9_-]{20,}'),
    examples: [`glpat${'-'}${synthetic(20)}`, `glpat${'-'}${synthetic(27)}`],
    negativeExamples: [`glpat${'-'}${synthetic(19)}`, 'const prefix = "glpat-";'],
  },
  {
    id: 'slack-token',
    kind: 'prefixed-token',
    pattern: bounded('xox[abposr]-(?:[0-9]{1,13}-){1,3}[A-Za-z0-9][A-Za-z0-9-]{7,}'),
    examples: [
      `xoxb${'-'}1234567890-1234567890123-${synthetic(24)}`,
      `xoxp${'-'}123456789012-123456789012-123456789012-${synthetic(32)}`,
      `xoxa${'-'}2-${synthetic(40)}`,
      `xoxo${'-'}1234567890-${synthetic(24)}`,
      `xoxs${'-'}1234567890-1234567890-${synthetic(24)}`,
      `xoxr${'-'}1-${synthetic(32)}`,
    ],
    negativeExamples: [
      'const slack = "xoxb-your-token-here";',
      `xoxz${'-'}1234567890-${synthetic(24)}`,
      'const prefix = "xoxp-";',
    ],
  },
  {
    id: 'stripe-secret-key',
    kind: 'prefixed-token',
    pattern: bounded('(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}'),
    examples: [
      `sk${'_live_'}${synthetic(24)}`,
      `sk${'_test_'}${synthetic(24)}`,
      `rk${'_live_'}${synthetic(24)}`,
      `rk${'_test_'}${synthetic(99)}`,
    ],
    negativeExamples: [
      `pk${'_live_'}${synthetic(24)}`,
      `sk${'_test_'}short`,
      'const mode = "sk_live_";',
    ],
  },
  {
    id: 'npm-token',
    kind: 'prefixed-token',
    pattern: bounded('npm_[A-Za-z0-9]{36}'),
    examples: [`npm${'_'}${synthetic(36)}`],
    negativeExamples: [
      'process.env.npm_package_version',
      'process.env.npm_config_registry',
      `npm${'_'}${synthetic(35)}`,
    ],
  },
  {
    id: 'anthropic-api-key',
    kind: 'prefixed-token',
    pattern: bounded('sk-ant-[a-z]{2,10}[0-9]{2}-[A-Za-z0-9_-]{32,}'),
    examples: [`sk${'-ant-'}api03-${synthetic(93)}AA`, `sk${'-ant-'}admin01-${synthetic(93)}AA`],
    negativeExamples: [
      'const prefix = "sk-ant-";',
      `sk${'-ant-'}api03-short`,
      // OpenAI 一类的 sk- key 不在设计列出的 T1 子集里（只拒绝高置信前缀）。
      `sk${'-proj-'}${synthetic(48)}`,
    ],
  },
  {
    id: 'google-api-key',
    kind: 'prefixed-token',
    pattern: bounded('AIza[A-Za-z0-9_-]{35}'),
    examples: [`AI${'za'}${synthetic(35)}`],
    negativeExamples: [`AI${'za'}${synthetic(34)}`, 'const googlePrefix = "AIza";'],
  },
  {
    id: 'jwt',
    kind: 'jwt',
    pattern: bounded(String.raw`(eyJ[A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{16,})`),
    confirm: isJwtCandidateConfirmed,
    examples: [
      [jwtHeader, jwtPayload, synthetic(43)].join('.'),
      [
        base64UrlJson({ alg: 'RS256', kid: 'SYNTHETIC' }),
        base64UrlJson({ iss: 'https://issuer.invalid', aud: 'SYNTHETIC', exp: 1 }),
        synthetic(342),
      ].join('.'),
    ],
    negativeExamples: [
      // 第二段解码后不是 JSON
      [
        jwtHeader,
        Buffer.from('not-json-payload', 'utf8').toString('base64url'),
        synthetic(43),
      ].join('.'),
      // 第一段解码后不是完整 JSON
      [Buffer.from('{"alg":"HS256"', 'utf8').toString('base64url'), jwtPayload, synthetic(43)].join(
        '.'
      ),
      // 只有两段 / 签名段过短
      [jwtHeader, jwtPayload].join('.'),
      [jwtHeader, jwtPayload, 'short'].join('.'),
    ],
  },
  {
    id: 'pem-private-key-block',
    kind: 'pem-private-key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
    confirm: hasPemPrivateKeyBody,
    examples: [
      [pemBegin(''), pemBody, pemTail, pemEnd('')].join('\n'),
      [
        pemBegin('RSA '),
        'Proc-Type: 4,ENCRYPTED',
        'DEK-Info: AES-128-CBC,SYNTHETIC0123456789',
        '',
        pemBody,
        pemEnd('RSA '),
      ].join('\n'),
      [pemBegin('OPENSSH '), pemBody, pemEnd('OPENSSH ')].join('\r\n'),
      [pemBegin('EC '), pemBody, pemEnd('EC ')].join('\\n'),
      [`'${pemBegin('')}\\n' +`, `  '${pemBody}\\n' +`, `  '${pemEnd('')}'`].join('\n'),
      [
        ['-----BEGIN', 'PGP PRIVATE KEY BLOCK-----'].join(' '),
        'Version: SYNTHETIC 1',
        '',
        pemBody,
        ['-----END', 'PGP PRIVATE KEY BLOCK-----'].join(' '),
      ].join('\n'),
      [`// ${pemBegin('')}`, `// ${pemBody}`, `// ${pemEnd('')}`].join('\n'),
      // 单行形态：换行被替换成空格的环境变量 / JSON 值。
      [pemBegin(''), pemBody, pemTail, pemEnd('')].join(' '),
      `PRIVATE_KEY="${[pemBegin('RSA '), pemBody, pemEnd('RSA ')].join(' ')}"`,
    ],
    negativeExamples: [
      `// ${pemBegin('')}\nexport const next = 1;`,
      `// matches ${pemBegin('')} markers only; no key body follows`,
      ` * 源码里单独出现的 '${pemBegin('')}' 常量不会吞掉后续代码；`,
      `const PEM_RE = /${pemBegin('')}[\\s\\S]*?${pemEnd('')}/;`,
      [pemBegin(''), 'short', pemEnd('')].join('\n'),
      [pemBegin(''), 'short', pemEnd('')].join(' '),
      `const sample = '${pemBegin('')} ... ${pemEnd('')}';`,
      [pemBegin(''), 'const body = readKeyFromVault();', pemEnd('')].join('\n'),
      [pemBegin(''), ['$', '{KEY_BODY_PLACEHOLDER}'].join(''), pemEnd('')].join('\n'),
      [pemBegin(''), pemEnd('')].join('\n'),
      [['-----BEGIN', 'PUBLIC KEY-----'].join(' '), pemBody].join('\n'),
      [['-----BEGIN', 'CERTIFICATE-----'].join(' '), pemBody].join('\n'),
    ],
  },
];

/**
 * 见证闸门规则表（T1 子集）。顺序即报告优先级：同一文件命中多条时只报第一条。
 */
export const WITNESS_GATE_RULES: readonly WitnessGateRule[] = Object.freeze(
  RULE_TABLE.map(freezeRule)
);

/**
 * 见证闸门：按规则表顺序找第一条确认命中。返回值只有规则 id 与种类，不含匹配片段。
 */
export function findWitnessGateHit(text: string): WitnessGateHit | null {
  for (const rule of WITNESS_GATE_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      if (!rule.confirm || rule.confirm(text, match)) {
        return Object.freeze({ ruleId: rule.id, kind: rule.kind });
      }
    }
  }
  return null;
}

/**
 * 见证 profile 的完整写盘前判定：上限 → UTF-8 往返 → 有损解码痕迹 → 见证闸门。
 * 先查上限，超限内容不再跑正则。返回 null 表示可以逐字节写入。
 */
export function inspectWitnessContent(content: string): WitnessContentRejection | null {
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > WITNESS_MAX_CONTENT_BYTES) {
    return Object.freeze({ reason: 'CONTENT_TOO_LARGE', kind: 'byte-limit', byteLength });
  }
  if (Buffer.from(content, 'utf8').toString('utf8') !== content) {
    return Object.freeze({ reason: 'CONTENT_NOT_UTF8', kind: 'lone-surrogate' });
  }
  if (content.includes(REPLACEMENT_CHARACTER)) {
    return Object.freeze({ reason: 'CONTENT_NOT_UTF8', kind: 'replacement-character' });
  }
  const hit = findWitnessGateHit(content);
  if (hit) {
    return Object.freeze({ reason: 'SECRET_DETECTED', kind: hit.kind, ruleId: hit.ruleId });
  }
  return null;
}

/**
 * 拒绝错误的消息：`<前缀>:<原因>:<规则种类>[ rule=<规则 id>] file=<JSON 路径>`。
 * 只含原因、规则种类、规则 id 与文件路径；正文、匹配片段、长度以外的内容一律不进入消息。
 */
export function describeWitnessRejection(
  rejection: WitnessContentRejection,
  file: string | undefined
): string {
  const rule = rejection.reason === 'SECRET_DETECTED' ? ` rule=${rejection.ruleId}` : '';
  return `${WITNESS_REJECTION_ERROR_PREFIX}:${rejection.reason}:${rejection.kind}${rule} file=${JSON.stringify(file ?? null)}`;
}
