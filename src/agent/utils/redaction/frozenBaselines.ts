// ============================================================================================
// 冻结基线（禁止修改）。脱敏阶段 1 的零回退底线：main 上 Redaction.ts 的三个早期版本原样副本。
//
// 来源（git blob，可用 `git show <rev>:src/agent/utils/Redaction.ts` 复核）：
//   v0 246055e  blob f0a6f21a523807ec4cd129d94b40899c63520124  → redactAt246055e
//   v1 1b394ce  blob feaa1229ca6eb2d6ce3019f13e74a287777a5551  → redactAt1b394ce
//   v2 d113986  blob c3e65b20e96c4f86d8ab22ad1bb35cefa1a88f20  → redactAtD113986（即 b60a61e^）
//   v3 b60a61e 是现行规则本身（Redaction.ts 的 redactWithCurrentRules），阶段 1 不在此冻结。
//
// 每段代码与对应 blob 逐字节相同，唯一改动是导出名 redactDeveloperText → redactAt<rev>。
// test/redaction-legacy-floor.test.ts 的黄金摘要用例逐段比对源码文本并比对输出摘要；任何改动
// （包括格式化、注释、改写正则）都会让底线的对齐前提失效，必须先改设计再改这里。
//
// 合成标记词表（设计附录 C，hiddenSpans.ts 的 T_ABS 词法覆盖全部形态）：
//   v0：[redacted-api-key]、[redacted-google-api-key]、$1[redacted-token]、$1[redacted]
//   v1：$1"[redacted]"，以及 v0 的各形态
//   v2：[redacted-nested-value]（经 JSON.stringify 带引号）；"[redacted]" 加原样重出的裸换行；
//       [redacted] 加裸换行；${keyQuote}[redacted]${keyQuote}；JSON 载体重编码（内层标记变成 \"…\"，
//       内层换行变成 \n 转义；非规范编码的保留字符可能被换成别的编码，由非规范载体守卫兜住）
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
