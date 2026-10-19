/**
 * 模型 JSON 对象回复的共享解析器（L8-P10 / L8-C07）。
 *
 * 关系发现、翻译等 run 投影原本各自用正则截取再 JSON.parse，顺序与失败语义各不相同，且失败时静默回退。
 * 这里收敛为一条固定级联，并把“用了哪条策略 / 为什么失败”交给调用方写诊断与日志：
 *   1. code-block：按出现顺序尝试每个 ``` 围栏块（语言标记可有可无）；
 *   2. full-text：整段回复去首尾空白后直接解析；
 *   3. balanced-object：从首个 `{` 起按括号配平（跳过字符串字面量与转义）截取一个完整对象再解析。
 * 只接受普通 JSON 对象；数组、null、标量都算失败。第 3 步只从首个 `{` 截取、不继续向后扫描：
 * 说明文字里的示例对象可能出现在真正结果之后，向后试探会把无关对象误当结果。
 *
 * 诊断只含策略名、错误类别（如 SyntaxError、unbalanced）与回复长度，绝不回显回复正文：
 * V8 的 JSON.parse 错误消息会夹带输入片段，所以这里只取 err.name。
 *
 * PlanAgentRun 的严格解析器失败语义是抛错，暂不迁移到这里（见 L8-P10 approach）。
 */

/** 级联中实际命中的策略；全部失败时为 'none'。 */
export type JsonObjectParseStrategy = 'code-block' | 'full-text' | 'balanced-object' | 'none';

export interface JsonObjectParseOutcome {
  /** 解析出的 JSON 对象；所有策略都失败时为 null。 */
  value: Record<string, unknown> | null;
  strategy: JsonObjectParseStrategy;
  /**
   * 仅失败时出现：按尝试顺序汇总的失败原因，例如
   * `full-text=SyntaxError; balanced-object=unbalanced`；空回复为 `empty_reply`。不含回复正文。
   */
  parseError?: string;
  /**
   * 仅“成功但前序策略失败”时出现：被跳过的失败尝试汇总（格式同 parseError）。
   * 这是解析器级联回退（parser fallback），调用方据此记一条 info 日志，区分一次命中与降级命中。
   */
  recoveredFrom?: string;
  /** 原始回复长度（字符数），供日志区分空回复、截断与长文本。 */
  replyLength: number;
}

type AttemptStrategy = Exclude<JsonObjectParseStrategy, 'none'>;

type AttemptResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

const FENCED_BLOCK = /```[A-Za-z0-9_-]*[^\S\r\n]*\r?\n?([\s\S]*?)```/g;

export function parseJsonObjectWithDiagnostics(
  text: string | null | undefined
): JsonObjectParseOutcome {
  const replyLength = typeof text === 'string' ? text.length : 0;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { value: null, strategy: 'none', parseError: 'empty_reply', replyLength };
  }

  const failures: string[] = [];
  const record = (strategy: AttemptStrategy, result: AttemptResult) => {
    if (!result.ok) {
      failures.push(`${strategy}=${result.error}`);
    }
    return result;
  };
  const success = (
    value: Record<string, unknown>,
    strategy: AttemptStrategy
  ): JsonObjectParseOutcome => ({
    value,
    strategy,
    ...(failures.length > 0 ? { recoveredFrom: failures.join('; ') } : {}),
    replyLength,
  });

  // 1. 围栏块：模型常把 JSON 包在 ```json 里并附带说明；前一个块无效时继续尝试后续块。
  for (const match of text.matchAll(FENCED_BLOCK)) {
    const result = record('code-block', parseObject(match[1] ?? ''));
    if (result.ok) {
      return success(result.value, 'code-block');
    }
  }

  // 2. 全文：没有围栏或围栏内容无效时，回复本身可能就是纯 JSON。
  const fullText = record('full-text', parseObject(text.trim()));
  if (fullText.ok) {
    return success(fullText.value, 'full-text');
  }

  // 3. 括号配平：前后带说明文字时，从首个 { 截取到与之配平的 }，避免贪婪正则吞进后续花括号。
  const balanced = record('balanced-object', parseFirstBalancedObject(text));
  if (balanced.ok) {
    return success(balanced.value, 'balanced-object');
  }

  return { value: null, strategy: 'none', parseError: failures.join('; '), replyLength };
}

function parseObject(candidate: string): AttemptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (err: unknown) {
    return { ok: false, error: describeParseError(err) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `not_object:${describeJsonType(parsed)}` };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function parseFirstBalancedObject(text: string): AttemptResult {
  const start = text.indexOf('{');
  if (start === -1) {
    return { ok: false, error: 'no_open_brace' };
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      // 字符串内的花括号不参与配平；反斜杠只转义紧随其后的一个字符。
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return parseObject(text.slice(start, index + 1));
      }
    }
  }
  // 扫到结尾仍未配平：典型是输出被 max tokens 截断。
  return { ok: false, error: 'unbalanced' };
}

function describeParseError(err: unknown): string {
  // 只取错误类别：V8 的 SyntaxError 消息会夹带输入片段，不能进入诊断或日志。
  return err instanceof Error ? err.name : typeof err;
}

function describeJsonType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}
