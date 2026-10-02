import { Ajv, type Options, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { observeSafely } from '#shared/observers.js';
import type { StructuredLogFn } from './structuredOutput.js';

/** 诊断旁路不能把合法 JSON 变成失败，也不能覆盖原 schema/解析拒绝。 */
function logSafely(
  log: StructuredLogFn,
  level: Parameters<StructuredLogFn>[0],
  message: string
): void {
  observeSafely(
    () => log(level, message),
    () => undefined
  );
}

/** 有 schema 时只接受完整 JSON，避免截断修复后恰好满足 schema 被当成完整输出。 */
export function parseSchemaOutput(
  text: string,
  validate: (value: unknown) => boolean,
  log: StructuredLogFn
): unknown {
  let source = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(source);
  if (fence) {
    source = fence[1];
    logSafely(
      log,
      'info',
      '[structured-output] outer_json_fence_removed; validating complete payload'
    );
  }
  try {
    const value: unknown = JSON.parse(source);
    return validate(value) ? value : null;
  } catch (err: unknown) {
    logSafely(
      log,
      'warn',
      `[structured-output] parse_failed kind=${err instanceof SyntaxError ? 'invalid_json' : 'validation_error'}; no repair attempted`
    );
    return null;
  }
}

/**
 * schema 编译调用点：决定失败诊断的措辞。
 * - response-schema：结构化输出的响应 schema，在发模型请求前编译，失败即跳过请求。
 * - tool-parameters：工具参数 schema，由 transport 在构造请求前预编译，失败即拒绝本次请求。
 */
export type StructuredValidationContext = 'response-schema' | 'tool-parameters';

/** 编译缓存上限：覆盖一次 Agent 会话常见的工具数与响应 schema，避免无界增长。 */
const COMPILED_SCHEMA_CACHE_LIMIT = 64;

/**
 * 按「方言 + schema 快照 JSON」缓存已编译校验器（LRU，Map 插入序即使用序）。
 * 每个条目持有独立 Ajv 实例，因此不同 schema 之间仍不共享 $id 注册表；
 * 键是快照而非调用者对象引用，调用者之后修改原 schema 只会产生新键，不会污染旧条目。
 * 只缓存编译成功的结果：失败的 schema 每次都重新编译并按调用点记日志。
 */
const compiledSchemaCache = new Map<string, ValidateFunction>();

function compileSnapshot(snapshot: Record<string, unknown>): ValidateFunction {
  const options: Options = {
    strict: true,
    strictTypes: false,
    strictTuples: false,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    logger: false,
  };
  const dialect =
    typeof snapshot.$schema === 'string' ? snapshot.$schema.replace(/#$/, '') : undefined;
  const key = `${dialect ?? 'default'}\n${JSON.stringify(snapshot)}`;
  const cached = compiledSchemaCache.get(key);
  if (cached) {
    // 命中后移到队尾，标记为最近使用。
    compiledSchemaCache.delete(key);
    compiledSchemaCache.set(key, cached);
    return cached;
  }
  const ajv =
    dialect === 'https://json-schema.org/draft/2020-12/schema'
      ? new Ajv2020(options)
      : dialect === 'https://json-schema.org/draft/2019-09/schema'
        ? new Ajv2019(options)
        : new Ajv(options);
  // ajv-formats 的 CommonJS 包在 NodeNext 下通过显式 default 暴露插件。
  addFormats.default(ajv);
  const validate = ajv.compile(snapshot);
  if ('$async' in validate && validate.$async === true) {
    throw new Error('Asynchronous output schemas are unsupported');
  }
  compiledSchemaCache.set(key, validate);
  if (compiledSchemaCache.size > COMPILED_SCHEMA_CACHE_LIMIT) {
    // Map 迭代序的第一个键即最久未使用的条目。
    const oldest = compiledSchemaCache.keys().next();
    if (!oldest.done) {
      compiledSchemaCache.delete(oldest.value);
    }
  }
  return validate;
}

/**
 * 先编译调用者的原始 JSON Schema；失败时返回 null，由调用点决定跳过或拒绝请求。
 * 编译结果按快照缓存（见 compiledSchemaCache），每个返回的闭包按本次调用的 log 记录不匹配。
 * 不加载远端 $ref，不补默认值、删除字段或转换类型；验证不修改模型事实。
 */
export function prepareStructuredValidation(
  schema: Record<string, unknown> | undefined,
  log: StructuredLogFn,
  context: StructuredValidationContext = 'response-schema'
): ((value: unknown) => boolean) | null {
  if (schema === undefined) {
    return () => true;
  }
  let validate: ValidateFunction;
  try {
    const snapshot = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
    validate = compileSnapshot(snapshot);
  } catch (err: unknown) {
    // 工具参数 schema 是本地声明缺陷，不能写成“跳过模型请求”或归因给模型输出。
    const outcome =
      context === 'tool-parameters'
        ? 'tool request rejected before dispatch'
        : 'model request skipped';
    logSafely(
      log,
      'warn',
      `[structured-output] invalid_schema context=${context}; ${outcome}: ${err instanceof Error ? err.message : 'invalid schema'}`
    );
    return null;
  }
  return (value) => {
    // 缓存的 ValidateFunction 被多个调用共享；errors 在同步调用后立即读取，不会被其他调用覆盖。
    if (validate(value)) {
      return true;
    }
    // 只记录位置与规则，不把模型输出、schema 或厂商原始响应写入日志。
    const first = validate.errors?.[0];
    logSafely(
      log,
      'warn',
      `[structured-output] schema_mismatch path=${first?.instancePath || '/'} keyword=${first?.keyword ?? 'unknown'}; result rejected`
    );
    return false;
  };
}
