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

export function redactDeveloperText(text: string): string {
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
