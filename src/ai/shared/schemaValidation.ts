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
 * 先编译调用者的原始 JSON Schema，失败时不发模型请求。
 * 按调用持有校验器，避免共享 $id 注册表和可变 schema 缓存串用。
 * 不加载远端 $ref，不补默认值、删除字段或转换类型；验证不修改模型事实。
 */
export function prepareStructuredValidation(
  schema: Record<string, unknown> | undefined,
  log: StructuredLogFn
): ((value: unknown) => boolean) | null {
  if (schema === undefined) {
    return () => true;
  }
  let validate: ValidateFunction;
  try {
    const snapshot = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
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
    const ajv =
      dialect === 'https://json-schema.org/draft/2020-12/schema'
        ? new Ajv2020(options)
        : dialect === 'https://json-schema.org/draft/2019-09/schema'
          ? new Ajv2019(options)
          : new Ajv(options);
    // ajv-formats 的 CommonJS 包在 NodeNext 下通过显式 default 暴露插件。
    addFormats.default(ajv);
    validate = ajv.compile(snapshot);
    if ('$async' in validate && validate.$async === true) {
      throw new Error('Asynchronous output schemas are unsupported');
    }
  } catch (err: unknown) {
    logSafely(
      log,
      'warn',
      `[structured-output] invalid_schema; model request skipped: ${err instanceof Error ? err.message : 'invalid schema'}`
    );
    return null;
  }
  return (value) => {
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
