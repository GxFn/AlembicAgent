/** 工具参数的运行期形状合同；Core/handler 继续拥有证据、权限及业务状态验证。 */
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { ToolRuntimeCallContext } from '#tools/kernel/context.js';
import type { ParsedToolCall, ToolAction } from '#tools/kernel/registry.js';

export const DIMENSION_SUBMIT_REQUIREMENT_NOTE =
  ' [REQUIRED every submit: params.reasoning.evidenceRefs — cite [evidence] E-x ids from tool results]';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 维度允许的 knowledgeType 列表：只收非空字符串，去空白、去重并保持宿主给定顺序（首项即回落值）。 */
function allowedKnowledgeTypeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const types = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(types)];
}

/**
 * 模型描述只广告 canonical evidenceRefs；执行保留历史 sources 输入，由 authoring
 * 在真实台账中推导并校验 refs。这里只共享字段形状，绝不伪造 refs 或重复业务推导。
 * 调用者拿到自有副本，静态注册表和同轮其他 schema 不受变体影响。
 *
 * I37：model 用途在当前维度给出 allowedKnowledgeTypes 时，为 knowledgeType 广告一个可选 enum，
 * 让模型在本维度允许的类型中自选。execution 用途刻意不加该 enum：执行面按静态注册表编译并缓存，
 * 不知道当前维度；列表外或缺失的值不拒收，而由提交归一化（handlers/knowledge/input.ts）回落到
 * 列表第一个并打诊断——这是本字段广告面与执行面唯一有意的差异。
 */
export function dimensionSubmitParameters(
  schema: Record<string, unknown>,
  purpose: 'model' | 'execution',
  options: { allowedKnowledgeTypes?: unknown } = {}
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
    const allowedKnowledgeTypes = allowedKnowledgeTypeList(options.allowedKnowledgeTypes);
    // 没有可用列表（非维度运行或维度未声明）时不广告：提交归一化此时也不限制 knowledgeType。
    if (allowedKnowledgeTypes.length > 0) {
      properties.knowledgeType = {
        type: 'string',
        enum: allowedKnowledgeTypes,
        description: `Knowledge type of this candidate: pick the best fit from the current dimension's allowed types. Optional; an omitted or unlisted value falls back to "${allowedKnowledgeTypes[0]}" with a host diagnostic.`,
      };
    }
  }
  return params;
}

type SchemaVariant = 'base' | 'dimension-submit';
/** 编译失败只来自 schema 本身：error 是固定类别，detail 是 Ajv 给出的关键字/路径说明（可缺省）。 */
type Compiled = { validate: ValidateFunction } | { error: string; detail?: string };
interface CachedSchema {
  source: string;
  variants: Partial<Record<SchemaVariant, Compiled>>;
}

/**
 * 参数准入拒绝的来源（只在 runtime 内部流转，不进入公开出口）：
 * - 'params'：模型给出的参数不符合 schema，由模型修正后重试；
 * - 'schema'：注册表 schema 本身无法编译，是注册表/宿主缺陷，换参数重试也不会成功。
 */
export interface ToolParameterRejection {
  source: 'params' | 'schema';
  reason: string;
}

/** schema 编译失败的一次性报告；只在失败首次编译并写入缓存时调用，缓存命中不再重复报告。 */
export type ToolParameterSchemaFailureSink = (failure: {
  label: string;
  variant: SchemaVariant;
  reason: string;
}) => void;

// schema 是公开可变对象：身份相同仍需比较内容，变体分别编译；只保留有界最近使用条目。
const PARAMETER_SCHEMA_CACHE_LIMIT = 64;
const compiledSchemas = new Map<Record<string, unknown>, CachedSchema>();
/** 无法序列化（循环引用、BigInt 等）的 schema 用这个不可能是合法 JSON 的源标记缓存失败结果。 */
const UNSERIALIZABLE_SCHEMA_SOURCE = '\u0000unserializable-schema';
/** Ajv 编译说明的长度上限：足够定位关键字与路径，又不会把超长 schema 片段灌进诊断。 */
const SCHEMA_ERROR_DETAIL_LIMIT = 300;

/** 编译/序列化异常只保留单行、有界的 message；Ajv 的说明只描述 schema 关键字与路径，不含调用参数。 */
function schemaErrorDetail(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return text.length > SCHEMA_ERROR_DETAIL_LIMIT
    ? `${text.slice(0, SCHEMA_ERROR_DETAIL_LIMIT)}…`
    : text || 'unknown schema error';
}

function serializeSchema(schema: Record<string, unknown>): { source: string; failure?: Compiled } {
  try {
    return { source: JSON.stringify(schema) };
  } catch (err: unknown) {
    return {
      source: UNSERIALIZABLE_SCHEMA_SOURCE,
      failure: {
        error: 'Invalid tool parameter schema',
        detail: `schema is not JSON-serializable (${schemaErrorDetail(err)})`,
      },
    };
  }
}

function compileVariant(source: string, variant: SchemaVariant): Compiled {
  try {
    const snapshot = JSON.parse(source) as Record<string, unknown>;
    const effective =
      variant === 'dimension-submit'
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
    return '$async' in validate && validate.$async === true
      ? { error: 'Asynchronous tool parameter schemas are unsupported' }
      : { validate };
  } catch (err: unknown) {
    // 保留 Ajv 的编译说明（例如 unknown format "uri" ignored in schema at path "#/properties/x"），
    // 它只描述 schema 关键字与路径；schema 本身已投影给模型，不含请求参数或宿主私有值。
    return { error: 'Invalid tool parameter schema', detail: schemaErrorDetail(err) };
  }
}

/**
 * 按 schema 内容与变体取编译结果。失败结果与成功结果一样写入缓存：注册表缺陷不会因每次调用
 * 重编译而反复失败、反复报告；schema 原地修正后内容变化，缓存条目随之重建并重新编译。
 */
function compiledParameters(
  schema: Record<string, unknown>,
  variant: SchemaVariant,
  report?: (reason: string) => void
): Compiled {
  const serialized = serializeSchema(schema);
  let cached = compiledSchemas.get(schema);
  if (!cached || cached.source !== serialized.source) {
    cached = { source: serialized.source, variants: {} };
  }
  compiledSchemas.delete(schema);
  compiledSchemas.set(schema, cached);
  if (compiledSchemas.size > PARAMETER_SCHEMA_CACHE_LIMIT) {
    const oldest = compiledSchemas.keys().next().value;
    if (oldest !== undefined) {
      compiledSchemas.delete(oldest);
    }
  }
  const previous = cached.variants[variant];
  if (previous) {
    return previous;
  }
  const compiled = serialized.failure ?? compileVariant(serialized.source, variant);
  cached.variants[variant] = compiled;
  if ('error' in compiled) {
    report?.(schemaFailureReason(compiled));
  }
  return compiled;
}

function schemaFailureReason(failure: { error: string; detail?: string }, label?: string): string {
  return `${failure.error}${label ? ` for ${label}` : ''}${failure.detail ? `: ${failure.detail}` : ''}`;
}

/**
 * 守护/诊断入口：用执行路径同一套缓存与编译选项检查某个 schema 变体能否编译，返回失败原因或 null。
 * 不报告诊断事件；注册表守护测试据此遍历全部动作的 base 与 dimension-submit 变体。
 */
export function toolParameterSchemaError(
  schema: Record<string, unknown>,
  variant: SchemaVariant
): string | null {
  const compiled = compiledParameters(schema, variant);
  return 'error' in compiled ? schemaFailureReason(compiled) : null;
}

function parameterError(call: ParsedToolCall, error: ErrorObject | undefined): string {
  if (error?.keyword === 'required') {
    const field = `${error.instancePath ? `${error.instancePath}/` : ''}${String(error.params.missingProperty)}`;
    return `Missing required param "${field}" for ${call.tool}.${call.action}`;
  }
  const at = error?.instancePath || '/';
  return `Invalid params for ${call.tool}.${call.action} at ${at}: ${error?.message ?? 'schema mismatch'}`;
}

/**
 * 运行期参数准入。返回 null 表示通过；拒绝时区分模型参数错误与 schema 编译失败，
 * 由 router 分别映射为 discover（TOOL_CALL_INVALID）与 execute/blocked（TOOL_UNAVAILABLE）。
 * onSchemaInvalid 只在某个 schema 变体首次编译失败时调用一次，供调用方输出诊断事件。
 */
export function validateToolParameters(
  call: ParsedToolCall,
  action: ToolAction,
  runtime?: ToolRuntimeCallContext,
  onSchemaInvalid?: ToolParameterSchemaFailureSink
): ToolParameterRejection | null {
  if (!record(call.params)) {
    return {
      source: 'params',
      reason: `Invalid params for ${call.tool}.${call.action}: expected object`,
    };
  }
  const variant: SchemaVariant =
    call.tool === 'knowledge' && call.action === 'submit' && Boolean(runtime?.evidenceLedger)
      ? 'dimension-submit'
      : 'base';
  const label = `${call.tool}.${call.action}`;
  const compiled = compiledParameters(
    action.params,
    variant,
    onSchemaInvalid && ((reason) => onSchemaInvalid({ label, variant, reason }))
  );
  if ('error' in compiled) {
    return { source: 'schema', reason: schemaFailureReason(compiled, label) };
  }
  return compiled.validate(call.params)
    ? null
    : { source: 'params', reason: parameterError(call, compiled.validate.errors?.[0]) };
}
