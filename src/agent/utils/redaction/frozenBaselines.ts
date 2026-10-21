// ============================================================================================
// 冻结基线（禁止修改）。脱敏零回退底线：main 上 Redaction.ts 的四个历史版本原样副本。
//
// 来源（git blob，可用 `git show <rev>:src/agent/utils/Redaction.ts` 复核）：
//   v0 246055e  blob f0a6f21a523807ec4cd129d94b40899c63520124  → redactAt246055e
//   v1 1b394ce  blob feaa1229ca6eb2d6ce3019f13e74a287777a5551  → redactAt1b394ce
//   v2 d113986  blob c3e65b20e96c4f86d8ab22ad1bb35cefa1a88f20  → redactAtD113986（即 b60a61e^）
//   v3 b60a61e  blob 2a8dad0b5fbc6a585e9949d0c71536f96ff36bdb  → redactAtB60a61e（阶段 4 冻结的 HEAD 现行规则）
//
// 每段代码与对应 blob 逐字节相同，唯一改动是导出名 redactDeveloperText → redactAt<rev>。v3 与 v2 的模块级
// 标识符同名（SECRET_KEY_SOURCE、JSON_FIELD、redactText 等），所以 v3 整段放在 namespace B60a61e 内部：
// 块内文本仍与 blob 逐字节相同（不缩进、不改格式），namespace 只提供独立作用域，不改变任何语义；
// 模块出口 redactAtB60a61e 是该 namespace 导出函数的别名。
// test/redaction-legacy-floor.test.ts 的黄金摘要用例逐段比对源码文本并比对输出摘要；任何改动
// （包括格式化、注释、改写正则）都会让底线的对齐前提失效，必须先改设计再改这里。
//
// 合成标记词表（设计附录 C，hiddenSpans.ts 的 T_ABS 词法覆盖全部形态）：
//   v0：[redacted-api-key]、[redacted-google-api-key]、$1[redacted-token]、$1[redacted]
//   v1：$1"[redacted]"，以及 v0 的各形态
//   v2：[redacted-nested-value]（经 JSON.stringify 带引号）；"[redacted]" 加原样重出的裸换行；
//       [redacted] 加裸换行；${keyQuote}[redacted]${keyQuote}；JSON 载体重编码（内层标记变成 \"…\"，
//       内层换行变成 \n 转义；非规范编码的保留字符可能被换成别的编码，由非规范载体守卫兜住）
//   v3：v2 的各形态；$1[redacted]@（URL userinfo）；"[redacted] 或 "[redacted]" 加裸换行（容器）；
//       [redacted-private-key] 加原样重出的换行（裸换行或 \n、\r 字面序列）
//
// 模块级正则（v2 的 JSON_FIELD 等）只经 String.prototype.replace 使用：replace 对全局正则先从
// lastIndex=0 收集全部匹配再调用回调，递归调用不会踩踏状态；doctrine lint 只登记 let 与空集合，
// 这些 const 正则不属于登记范围，行为与原 blob 完全相同。
// ============================================================================================

// ---- v0 246055e（blob f0a6f21a523807ec4cd129d94b40899c63520124）原样副本开始 ----
/**
 * 开发者可见文本脱敏 — 单源工具（Wave A E1 自 AgentRuntime 私有函数迁出，行为字节不变）。
 *
 * 消费方：LLM 工件留痕（AgentRuntime）、证据台账落盘（EvidenceLedgerStore 注入）。
 * 规则集中在此一处：API key / Google key / Bearer token / 键值对形态的
 * api_key|token|secret|password|authorization。新增规则时全部消费方同步生效。
 */
export function redactAt246055e(text: string): string {
  return text
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-google-api-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted-token]')
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
      '$1[redacted]'
    );
}
// ---- v0 246055e 原样副本结束 ----

// ---- v1 1b394ce（blob feaa1229ca6eb2d6ce3019f13e74a287777a5551）原样副本开始 ----
/**
 * 开发者可见文本脱敏 — 单源工具（Wave A E1 自 AgentRuntime 私有函数迁出，行为字节不变）。
 *
 * 消费方：LLM 工件留痕（AgentRuntime）、证据台账落盘（EvidenceLedgerStore 注入）。
 * 规则集中在此一处：API key / Google key / Bearer token / 键值对形态的
 * api_key|token|secret|password|authorization。新增规则时全部消费方同步生效。
 */
export function redactAt1b394ce(text: string): string {
  return (
    text
      // JSON 值可以含空格与转义引号；整值替换才能同时保证脱敏和 JSON 可解析性。
      .replace(
        /("(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
        '$1"[redacted]"'
      )
      .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-google-api-key]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted-token]')
      .replace(
        /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
        '$1[redacted]'
      )
  );
}
// ---- v1 1b394ce 原样副本结束 ----

// ---- v2 d113986（blob c3e65b20e96c4f86d8ab22ad1bb35cefa1a88f20）原样副本开始 ----
/**
 * 开发者文本与台账内容的脱敏入口。只处理已知凭据形态/敏感键纯量，业务回执不在此改写。
 * 保留非敏感字节及换行；台账 freshness 使用同一入口，不能为了清理JSON而重排整个文档。
 */
const SECRET_KEY_SOURCE = 'api[_-]?key|token|secret|password|authorization';
const SECRET_KEY = new RegExp(`(?:${SECRET_KEY_SOURCE})$`, 'i');
const JSON_STRING = String.raw`"(?:\\[\s\S]|[^"\\])*"`;
const JSON_FIELD = new RegExp(
  String.raw`(?<!\\)(${JSON_STRING})(\s*:\s*)(${JSON_STRING}|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|[,}\]]|$)`,
  'g'
);
const QUOTED_ASSIGNMENT = new RegExp(
  String.raw`((?:${SECRET_KEY_SOURCE})["']?\s*[:=]\s*)(["'])((?:\\[\s\S]|(?!\2)[^\\])*)\2`,
  'gi'
);
const BARE_ASSIGNMENT = new RegExp(
  String.raw`((?:${SECRET_KEY_SOURCE})(["']?)\s*[:=]\s*)(?!\\+["'])([^\s"',;{}\[\]()]+)`,
  'gi'
);
const UNTERMINATED_ASSIGNMENT = new RegExp(
  String.raw`((?:${SECRET_KEY_SOURCE})["']?\s*[:=]\s*)(["'])((?:\\[\s\S]|(?!\2)[^\\])*)(?:\\)?$`,
  'gi'
);
const JSON_LITERALS = new RegExp(JSON_STRING, 'g');
const MAX_ENCODED_DEPTH = 8;

export function redactAtD113986(text: string): string {
  return redactText(text, 0);
}

function redactText(text: string, depth: number): string {
  if (depth > MAX_ENCODED_DEPTH) {
    // 工具结果可能多次JSON编码；超深时用可见标记降级，不回显未检查的内层原文。
    return '[redacted-nested-value]';
  }
  const jsonFields = text.replace(
    JSON_FIELD,
    (field, keyText: string, separator: string, valueText: string) => {
      try {
        const key = JSON.parse(keyText) as string;
        if (SECRET_KEY.test(key)) {
          // 数字秘密值也替换成合法JSON字符串；前后空白、键序与非敏感数字不变化。
          return `${keyText}${separator}"[redacted]"${(valueText.match(/\r\n|\r|\n/g) || []).join('')}`;
        }
      } catch (err: unknown) {
        // 非法/截断JSON仍走下方文本规则，不能把解析错误或原始值写入额外日志。
        void err;
      }
      return field;
    }
  );
  // 字符串载体不只出现在对象属性：根字符串/数组项也可能携带已JSON编码的工具观察。
  const decoded = jsonFields.replace(JSON_LITERALS, (literal) => {
    try {
      const value = JSON.parse(literal) as string;
      const redacted = redactText(value, depth + 1);
      return value === redacted ? literal : JSON.stringify(redacted);
    } catch (err: unknown) {
      void err;
      return literal;
    }
  });
  return (
    decoded
      // 必须在JSON载体解码后处理当前层的引号，避免把双重转义当作闭引号。
      .replace(
        UNTERMINATED_ASSIGNMENT,
        (_value, prefix: string, quote: string, body: string) =>
          `${prefix}${quote}[redacted]${(body.match(/\r\n|\r|\n/g) || []).join('')}`
      )
      .replace(
        QUOTED_ASSIGNMENT,
        (_value, prefix: string, quote: string, body: string) =>
          `${prefix}${quote}[redacted]${(body.match(/\r\n|\r|\n/g) || []).join('')}${quote}`
      )
      .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-google-api-key]')
      // Bearer的协议语法没有12字符下限；保留scheme供诊断，但不保留短凭据。
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted-token]')
      .replace(/(authorization\s*[:=]\s*Basic\s+)[A-Za-z0-9+/=_-]+/gi, '$1[redacted-token]')
      .replace(BARE_ASSIGNMENT, (value, prefix: string, keyQuote: string, body: string) => {
        if (/^authorization["']?\s*[:=]/i.test(prefix) && /^(Bearer|Basic)$/i.test(body)) {
          return value;
        }
        // 引号属于键时，替换值也须带引号，避免破坏JSON/对象字面量中的纯量语法。
        return `${prefix}${keyQuote}[redacted]${keyQuote}`;
      })
  );
}
// ---- v2 d113986 原样副本结束 ----

// ---- v3 b60a61e（blob 2a8dad0b5fbc6a585e9949d0c71536f96ff36bdb）原样副本开始 ----
// biome-ignore-start lint/correctness/noUnusedVariables: Biome 不解析 namespace 内部的函数引用（redactText 由 redactAtB60a61e 调用）；块内文本必须保持与 blob 逐字节相同，不能在其中插入抑制注释。
// biome-ignore format: 冻结副本必须与 git blob 逐字节相同，不能被格式化器改动缩进。
namespace B60a61e {
/**
 * 开发者文本与台账内容的脱敏入口。只处理已知凭据形态/敏感键的值，业务回执不在此改写。
 * 保留非敏感字节及换行；台账 freshness 使用同一入口，不能为了清理JSON而重排整个文档。
 *
 * 本函数事实上是证据台账哈希规范的一部分：EvidenceLedgerStore 落盘与 checkFreshness 重算都经过这里。
 * 规则变更后，升级时在途 job 中受影响的旧条目会被判 stale（EVIDENCE_STALE 提示重采），不会丢数据。
 *
 * 误伤边界：源码比较（== / === / !=）、箭头函数（=>）、作用域符（::）、类型注解、case 标签与三元
 * 表达式都不是凭据赋值，必须逐字保留；否则 code.read 证据被改写后经 evidence.get 回到模型，
 * 写进 Recipe 的片段会在下游逐字校验中被拒。
 */

/** 以这些关键字结尾的键沿用历史覆盖面：GITHUB_TOKEN、client_secret、x-api-key 等前缀形态都算。 */
const SECRET_KEY_SOURCE = 'api[_-]?key|token|secret|password|authorization';
const SECRET_KEY_SUFFIX = new RegExp(`(?:${SECRET_KEY_SOURCE})$`, 'i');
/** 复合键（SECRET_KEY、AWS_SECRET_ACCESS_KEY、secretKey、PRIVATE_KEY…）按分词判定，见 classifyKey。 */
const COMPOUND_FIRST_WORDS = new Set(['secret', 'private', 'access']);
const COMPOUND_JOINED_WORDS = new Set(['secretkey', 'privatekey', 'accesskey']);
const KEY_HINT_SOURCE = `${SECRET_KEY_SOURCE}|(?:private|access)[_.-]?key`;
/**
 * 文本键：完整标识符（含 . - $ 组成的属性路径、CLI 参数与 HTTP 头）。先行断言只要求标识符里出现关键字，
 * 真正是否敏感由 classifyKey 对整个键判定（tokenizer、secretKeyword 会被放行）。不用“惰性前缀 + 惰性
 * 后缀”的写法，是因为那在超长标识符里会退化成平方级回溯。
 */
const TEXT_KEY = String.raw`(?<![\w$.-])((?=[\w$.-]*?(?:${KEY_HINT_SOURCE}))[\w$.-]+)`;
/**
 * 赋值分隔符：= 后不能接 = 或 >（排除 ==、===、=>），: 后不能接 :（排除 ::）；
 * 左侧兜底排除 = ! < >，使 !=、<=、>= 的尾部永远不会被当作分隔符。
 */
const SEPARATOR = '(?<![=!<>])(?:=(?![=>])|:(?!:))';
const JSON_STRING = String.raw`"(?:\\[\s\S]|[^"\\])*"`;
const JSON_FIELD = new RegExp(
  String.raw`(?<!\\)(${JSON_STRING})(\s*:\s*)(${JSON_STRING}|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|[,}\]]|$)`,
  'g'
);
/** 值为数组或对象的 JSON 字段；只有敏感键才会被整体替换，见 redactSensitiveContainers。 */
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
/**
 * PEM 私钥块：保留 BEGIN/END 标记与换行（含转义的 \n），正文换成标记。正文只接受 base64、空白、
 * 转义换行与 RFC 1421/OpenPGP 头行，所以源码里单独出现的 '-----BEGIN PRIVATE KEY-----' 常量不会
 * 吞掉后续代码；缺少 END 的截断输出仍会遮住已经出现的正文。
 */
const PEM_PRIVATE_KEY =
  /(-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----)((?:(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset): [^\r\n\\]*|\\[nr]|[A-Za-z0-9+/=\s])*)(-----END \2PRIVATE KEY\3-----)?/g;
/**
 * URL userinfo 中的密码：scheme://user:password@host 只遮 password，保留用户名与主机供诊断。
 * 密码段贪婪匹配到授权段内最后一个 @（未编码的 @ 也算进密码），不跨越 / ? # 与空白。
 * scheme 起点用“前一字符不属于 scheme”而不是 \b：a-a-a-… 这类长串里每个 - 后都是词边界，会退化成平方级。
 */
const URL_USERINFO =
  /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/?#@"'<>]*:)([^\s/?#"'<>]+)@/g;
const JSON_LITERALS = new RegExp(JSON_STRING, 'g');
const MAX_ENCODED_DEPTH = 8;
/** 判断 case 标签、三元表达式、行首配置项时只看键前后这么多字符，避免超长单行把匹配拖成平方级。 */
const CONTEXT_WINDOW = 256;
/** 冒号后的常见类型名（TS/JS、Swift/Kotlin/Java/C#、Python/Rust/Dart），按大小写精确比较。 */
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
/** 标识符或成员链（process.env.SECRET_KEY、config.secretKey）：在源码里是引用，不是凭据字面量。 */
const CODE_REFERENCE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** 行首配置项的前缀：缩进、可选的 export / YAML 列表标记，以及键自带的引号。 */
const CONFIG_LINE_PREFIX = /^[ \t]*(?:export[ \t]+|-[ \t]+)?["']?$/;
/** 值后到行尾只剩空白或 # 注释。 */
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

export function redactAtB60a61e(text: string): string {
  return redactText(text, 0);
}

function redactText(text: string, depth: number): string {
  if (depth > MAX_ENCODED_DEPTH) {
    // 工具结果可能多次JSON编码；超深时用可见标记降级，不回显未检查的内层原文。
    return '[redacted-nested-value]';
  }
  const containers = redactSensitiveContainers(text);
  const jsonFields = containers.replace(
    JSON_FIELD,
    (field, keyText: string, separator: string, valueText: string) => {
      if (isSensitiveJsonKey(keyText)) {
        // 数字秘密值也替换成合法JSON字符串；前后空白、键序与非敏感数字不变化。
        return `${keyText}${separator}"[redacted]"${lineBreaks(valueText)}`;
      }
      return field;
    }
  );
  // 字符串载体不只出现在对象属性：根字符串/数组项也可能携带已JSON编码的工具观察。
  const decoded = jsonFields.replace(JSON_LITERALS, (literal) => {
    try {
      const value = JSON.parse(literal) as string;
      const redacted = redactText(value, depth + 1);
      return value === redacted ? literal : JSON.stringify(redacted);
    } catch (err: unknown) {
      void err;
      return literal;
    }
  });
  // 必须在JSON载体解码后处理当前层的引号，避免把双重转义当作闭引号。
  const shaped = decoded
    .replace(PEM_PRIVATE_KEY, redactPemBlock)
    .replace(URL_USERINFO, '$1[redacted]@');
  const unterminated = replaceAssignments(shaped, UNTERMINATED_ASSIGNMENT, (match) => {
    const [, key = '', separator = '', quote = '', body = ''] = match;
    return classifyKey(key) === null
      ? null
      : `${key}${separator}${quote}[redacted]${lineBreaks(body)}`;
  });
  const quoted = replaceAssignments(unterminated, QUOTED_ASSIGNMENT, (match) => {
    const [, key = '', separator = '', quote = '', body = ''] = match;
    return classifyKey(key) === null
      ? null
      : `${key}${separator}${quote}[redacted]${lineBreaks(body)}${quote}`;
  });
  const shapedTokens = quoted
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-google-api-key]')
    // Bearer的协议语法没有12字符下限；保留scheme供诊断，但不保留短凭据。
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted-token]')
    .replace(/(authorization\s*[:=]\s*Basic\s+)[A-Za-z0-9+/=_-]+/gi, '$1[redacted-token]');
  return replaceAssignments(shapedTokens, BARE_ASSIGNMENT, redactBareAssignment);
}

/**
 * 逐个匹配并替换。replacer 返回 null 表示“这里不是凭据赋值”：只跳过键名、从值的位置继续扫描，
 * 避免被放行的值（例如 `case token: password=x`）把其后真实的凭据赋值一起吞掉。
 */
function replaceAssignments(
  text: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray, source: string) => string | null
): string {
  // 每次调用用独立的正则实例：redactText 会经 JSON 载体递归，共享 lastIndex 会互相踩踏。
  const scanner = new RegExp(pattern.source, pattern.flags);
  let output = '';
  let cursor = 0;
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
    const replacement = replacer(match, text);
    if (replacement === null) {
      scanner.lastIndex = match.index + Math.max(1, (match[1] ?? '').length);
      continue;
    }
    output += `${text.slice(cursor, match.index)}${replacement}`;
    cursor = match.index + match[0].length;
  }
  return `${output}${text.slice(cursor)}`;
}

function redactBareAssignment(match: RegExpExecArray, source: string): string | null {
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
  // `:=`、`= =`、`: <placeholder>`、`: !tag`、YAML 块标记 `: |` 这类以运算符开头的值不是凭据纯量。
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
  // Authorization 的 scheme 由上面的 Bearer/Basic 规则遮凭据本体，scheme 本身保留供诊断。
  if (/authorization$/i.test(key) && /^(?:Bearer|Basic)$/i.test(value)) {
    return null;
  }
  // 复合键是新扩的覆盖面，只在值确实是字面量时替换，不能把源码里的变量引用改写掉。
  if (keyClass === 'compound' && !isLiteralBareValue(assignment)) {
    return null;
  }
  // 引号属于键时，替换值也须带引号，避免破坏JSON/对象字面量中的纯量语法。
  return `${key}${keyQuote}${beforeSeparator}${separator}${afterSeparator}${keyQuote}[redacted]${keyQuote}`;
}

/** 键名分词：驼峰按大小写边界拆，再按非字母数字切开（AWSSecretAccessKey → aws/secret/access/key）。 */
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

/**
 * suffix：以历史关键字结尾，沿用旧语义（任意裸值都遮）；compound：分词后含 secret/private/access key，
 * 裸值只在字面量时遮。两者的 JSON 纯量、引号值、数组与对象值都整体遮。
 */
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
    // 非法/截断JSON键不在这里判定，仍走下方文本规则；不能把解析错误或原始值写入额外日志。
    void err;
    return false;
  }
}

/**
 * 敏感键下的数组/对象值整体换成 "[redacted]"，保留其中的换行以免台账 range 漂移。
 * 容器没有闭合（输出被截断）时遮到文本末尾，并保留缺失的闭引号让截断仍然可见。
 */
function redactSensitiveContainers(text: string): string {
  let output = '';
  let cursor = 0;
  for (const match of text.matchAll(JSON_CONTAINER_FIELD)) {
    const start = match.index + match[0].length;
    if (match.index < cursor || !isSensitiveJsonKey(match[1] ?? '')) {
      continue;
    }
    const end = findContainerEnd(text, start);
    const valueEnd = end ?? text.length;
    const replacement = end === null ? '"[redacted]' : '"[redacted]"';
    output += `${text.slice(cursor, start)}${replacement}${lineBreaks(text.slice(start, valueEnd))}`;
    cursor = valueEnd;
  }
  return `${output}${text.slice(cursor)}`;
}

/** 从 [ 或 { 开始找配对的闭合符；双引号与单引号字符串里的括号不计数。找不到返回 null。 */
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

function redactPemBlock(
  block: string,
  begin: string,
  _label: string,
  _blockSuffix: string | undefined,
  body: string,
  end: string | undefined
): string {
  const [start, stop] = pemContentBounds(body);
  // 只有标记、空白与转义换行时是源码里的标记常量或文档占位，不是私钥正文，原样保留。
  if (start >= stop) {
    return block;
  }
  // 正文前后的缩进与换行原样保留（YAML 块里的 END 行仍对齐），正文内的换行逐个保留以免行号漂移。
  const breaks = body.slice(start, stop).match(/\r\n|\r|\n|\\r\\n|\\n|\\r/g) || [];
  return `${begin}${body.slice(0, start)}[redacted-private-key]${breaks.join('')}${body.slice(stop)}${end ?? ''}`;
}

/**
 * PEM 正文去掉首尾空白与转义换行后的区间 [start, stop)。手写线性扫描而不用 `\s*$` 之类的尾锚正则：
 * 后者在正文内部的长空白段上会逐位置重试，退化成平方级。base64 正文本身不含反斜杠。
 */
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

/** 键所在行、键之前的文本（最多 CONTEXT_WINDOW 个字符）。 */
function precedingOnLine(source: string, offset: number): string {
  const window = source.slice(Math.max(0, offset - CONTEXT_WINDOW), offset);
  const lineBreak = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('\r'));
  return window.slice(lineBreak + 1);
}

/** case 标签（case token:）与带空格的三元表达式（cond ? token : other）里的冒号不是键值分隔符。 */
function isColonCodeContext({ preceding, beforeSeparator }: BareAssignment): boolean {
  if (/(?:^|[{;:])\s*case\s+["']?$/.test(preceding)) {
    return true;
  }
  return beforeSeparator.length > 0 && /[\w$)\]'"`]\s+\?\s+["']?$/.test(preceding);
}

/**
 * 冒号后的类型注解：常见类型名、Rust 引用/PHP 可空（&str、?string）、泛型/联合/可选（Array<T>、
 * string|null、String?），以及后接联合或下标的类型名（Token | undefined、Token[]、Optional[str]）。
 */
function looksLikeTypeAnnotation({ value, following }: BareAssignment): boolean {
  if (TYPE_NAMES.has(value) || /^[&?][A-Za-z_']/.test(value)) {
    return true;
  }
  if (/^[A-Za-z_][\w.]*(?:<|\|[A-Za-z_]|\?$)/.test(value)) {
    return true;
  }
  return /^[A-Za-z_][\w.]*$/.test(value) && /^(?:[ \t]*\|[^|]|\[)/.test(following);
}

/**
 * 复合键裸值是否为字面量：调用、下标与 $ 变量引用一律不是；标识符语法写不出的值（含 - / + @ 等或
 * 数字开头）是；标识符形态的值只在 env/shell 紧贴的 KEY=value、连字符键（HTTP 头、CLI 参数）或
 * 独占一行的配置项（YAML/INI/.env）里算字面量。
 */
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

function lineBreaks(text: string): string {
  return (text.match(/\r\n|\r|\n/g) || []).join('');
}
}
// biome-ignore-end lint/correctness/noUnusedVariables: 见上。
// ---- v3 b60a61e 原样副本结束 ----

/** 阶段 4 冻结的现行规则（b60a61e，即 HEAD）；与 Redaction.ts 曾经的 redactWithCurrentRules 逐字节相同。 */
export const redactAtB60a61e: (text: string) => string = B60a61e.redactAtB60a61e;
