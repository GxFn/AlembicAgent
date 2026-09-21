/** 工具参数的运行期形状合同；Core/handler 继续拥有证据、权限及业务状态验证。 */
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { ToolRuntimeCallContext } from '#tools/kernel/context.js';
import type { ParsedToolCall, ToolAction } from '#tools/kernel/registry.js';

export const DIMENSION_SUBMIT_REQUIREMENT_NOTE =
  ' [REQUIRED every submit: params.reasoning.evidenceRefs — cite [evidence] E-x ids from tool results]';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 模型描述只广告 canonical evidenceRefs；执行保留历史 sources 输入，由 authoring
 * 在真实台账中推导并校验 refs。这里只共享字段形状，绝不伪造 refs 或重复业务推导。
 * 调用者拿到自有副本，静态注册表和同轮其他 schema 不受变体影响。
 */
export function dimensionSubmitParameters(
  schema: Record<string, unknown>,
  purpose: 'model' | 'execution'
): Record<string, unknown> | null {
  if (!record(schema.properties) || !record(schema.properties.reasoning)) {
    return null;
  }
  const params = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const properties = params.properties as Record<string, unknown>;
  const reasoning = properties.reasoning as Record<string, unknown>;
  if (purpose === 'model') {
    reasoning.required = ['evidenceRefs'];
  } else {
    // 仅替换来源字段的必填规则；公开schema中其他required/allOf约束仍保留。
    const required = (reasoning.required ?? []) as string[];
    reasoning.required = required.filter((name) => name !== 'sources' && name !== 'evidenceRefs');
    reasoning.allOf = [
      ...((reasoning.allOf ?? []) as unknown[]),
      { anyOf: [{ required: ['evidenceRefs'] }, { required: ['sources'] }] },
    ];
  }
  const sources = record(reasoning.properties) ? reasoning.properties.sources : undefined;
  if (record(sources)) {
    sources.description =
      'Auto-expanded from evidenceRefs by the ledger — do NOT hand-write. Only fill real file:line when citing search/terminal-class evidence entries that carry no file range.';
  }
  if (purpose === 'model') {
    // 模型只广告 canonical 写法；执行沿用 base 约束，scope 别名与业务含义交给 Core。
    properties.scope = {
      type: 'string',
      enum: ['narrow', 'module', 'project'],
      description:
        'Evidence-breadth self-declaration. Use "narrow" when evidence spans <3 distinct files (single-file/local rule).',
    };
  }
  return params;
}

type Compiled = { validate: ValidateFunction } | { error: string };
interface CachedSchema {
  source: string;
  variants: Partial<Record<'base' | 'dimension-submit', Compiled>>;
}

// schema 是公开可变对象：身份相同仍需比较内容，变体分别编译；只保留有界最近使用条目。
const PARAMETER_SCHEMA_CACHE_LIMIT = 64;
const compiledSchemas = new Map<Record<string, unknown>, CachedSchema>();

function compiledParameters(schema: Record<string, unknown>, dimensionSubmit: boolean): Compiled {
  try {
    const source = JSON.stringify(schema);
    let cached = compiledSchemas.get(schema);
    if (!cached || cached.source !== source) {
      cached = { source, variants: {} };
    }
    compiledSchemas.delete(schema);
    compiledSchemas.set(schema, cached);
    if (compiledSchemas.size > PARAMETER_SCHEMA_CACHE_LIMIT) {
      const oldest = compiledSchemas.keys().next().value;
      if (oldest !== undefined) {
        compiledSchemas.delete(oldest);
      }
    }
    const variant = dimensionSubmit ? 'dimension-submit' : 'base';
    const previous = cached.variants[variant];
    if (previous) {
      return previous;
    }
    const snapshot = JSON.parse(source) as Record<string, unknown>;
    const effective = dimensionSubmit
      ? (dimensionSubmitParameters(snapshot, 'execution') ?? snapshot)
      : snapshot;
    // 每个编译器拥有自己的$id空间；不联网解析$ref，不转换类型/补默认值/删除字段。
    const validate = new Ajv({
      strict: true,
      strictTypes: false,
      // anyOf 来源分支引用父级 properties；关闭作用域 lint，不关闭 required 的实际校验。
      strictRequired: false,
      allErrors: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      logger: false,
    }).compile(effective);
    const compiled: Compiled =
      '$async' in validate && validate.$async === true
        ? { error: 'Asynchronous tool parameter schemas are unsupported' }
        : { validate };
    cached.variants[variant] = compiled;
    return compiled;
  } catch (err: unknown) {
    // 只报告合同问题，避免把schema或请求中的私有值写进诊断。
    void err;
    return { error: 'Invalid tool parameter schema' };
  }
}

function parameterError(call: ParsedToolCall, error: ErrorObject | undefined): string {
  if (error?.keyword === 'required') {
    const field = `${error.instancePath ? `${error.instancePath}/` : ''}${String(error.params.missingProperty)}`;
    return `Missing required param "${field}" for ${call.tool}.${call.action}`;
  }
  const at = error?.instancePath || '/';
  return `Invalid params for ${call.tool}.${call.action} at ${at}: ${error?.message ?? 'schema mismatch'}`;
}

export function validateToolParameters(
  call: ParsedToolCall,
  action: ToolAction,
  runtime?: ToolRuntimeCallContext
): string | null {
  if (!record(call.params)) {
    return `Invalid params for ${call.tool}.${call.action}: expected object`;
  }
  const dimensionSubmit =
    call.tool === 'knowledge' && call.action === 'submit' && Boolean(runtime?.evidenceLedger);
  const compiled = compiledParameters(action.params, dimensionSubmit);
  if ('error' in compiled) {
    return `${compiled.error} for ${call.tool}.${call.action}`;
  }
  return compiled.validate(call.params)
    ? null
    : parameterError(call, compiled.validate.errors?.[0]);
}
