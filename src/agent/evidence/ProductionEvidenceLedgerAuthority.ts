import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  createStrictEvidenceLedgerSnapshotV1,
  type StrictEvidenceLedgerSnapshotV1,
} from '@alembic/core/host-agent-workflows';
import { type EvidenceEntry, type EvidenceRange, isEvidenceToolId } from '@alembic/core/knowledge';
import { redactDeveloperText } from '../utils/Redaction.js';
import { type EvidenceEntryDraft, EvidenceLedgerStore } from './EvidenceLedgerStore.js';

const AUTHORITY_KIND = 'alembic-agent-production-evidence-ledger-v1';
const COORDINATE_MAX_LENGTH = 512;
const CAPTURE_ERROR_PREFIX = 'ALEMBIC_AGENT_EVIDENCE_LEDGER_CAPTURE_INVALID';
const CAPTURE_ALLOWED_FIELDS = new Set(['tool', 'callId', 'file', 'range', 'content']);
const CAPTURE_REQUIRED_FIELDS = ['tool', 'callId', 'content'] as const;
const CAPTURE_MISSING_FIELD_REASONS = {
  tool: 'MISSING_TOOL',
  callId: 'MISSING_CALL_ID',
  content: 'MISSING_CONTENT',
} as const;
// 每次 capture 的私有 token 只认证本次调用内部生成的错误；旧错误或 caller trap 无法复用理由。
const captureValidationErrorTokens = new WeakMap<object, object>();

export interface ProductionEvidenceLedgerCoordinatesV1 {
  /**
   * 可信宿主选择的 Agent data root。该路径不会出现在公开 identity 中，只参与哈希绑定。
   */
  readonly dataRoot: string;
  readonly jobId: string;
  readonly sessionId: string;
  readonly dimensionId: string;
}

export interface ProductionEvidenceLedgerIdentityV1 {
  readonly schemaVersion: 1;
  readonly authorityKind: typeof AUTHORITY_KIND;
  readonly storeId: string;
  readonly storeConfigHash: string;
  readonly jobId: string;
  readonly sessionId: string;
  readonly dimensionId: string;
  readonly persistence: 'append-only-jsonl-v1';
}

export type ProductionEvidenceCaptureInputV1 = Readonly<EvidenceEntryDraft>;

export interface ProductionEvidenceLedgerCaptureFacetV1 {
  readonly identity: ProductionEvidenceLedgerIdentityV1;
  capture(input: ProductionEvidenceCaptureInputV1): EvidenceEntry;
}

export interface ProductionEvidenceLedgerReadFacetV1 {
  readonly identity: ProductionEvidenceLedgerIdentityV1;
  get(reference: string): EvidenceEntry | null;
  strictSnapshot(): StrictEvidenceLedgerSnapshotV1;
}

export interface ProductionEvidenceLedgerAuthorityV1 {
  readonly identity: ProductionEvidenceLedgerIdentityV1;
  readonly capture: ProductionEvidenceLedgerCaptureFacetV1;
  readonly read: ProductionEvidenceLedgerReadFacetV1;
}

interface AuthorityBinding {
  readonly identity: ProductionEvidenceLedgerIdentityV1;
  readonly store: EvidenceLedgerStore;
}

const authorityBindings = new WeakMap<ProductionEvidenceLedgerAuthorityV1, AuthorityBinding>();
const readFacetBindings = new WeakMap<ProductionEvidenceLedgerReadFacetV1, AuthorityBinding>();

/**
 * 打开 Agent 唯一的 production Evidence Ledger。
 *
 * capture/read 两个 facet 都闭包到同一真实 store 实例；重新以相同可信坐标调用会 hydrate
 * 同一 JSONL。调用方不能注入 adapter、redactor、store id 或 config hash。
 */
export function createProductionEvidenceLedgerAuthority(
  input: ProductionEvidenceLedgerCoordinatesV1
): ProductionEvidenceLedgerAuthorityV1 {
  const coordinates = normalizeCoordinates(input);
  const identity = createIdentity(coordinates);
  const store = new EvidenceLedgerStore({
    ...coordinates,
    redactor: redactDeveloperText,
  });
  store.assertProductionAuthorityHealthy();
  const binding: AuthorityBinding = { identity, store };
  const capture = Object.freeze({
    identity,
    capture: (draft: ProductionEvidenceCaptureInputV1) =>
      freezeEvidenceEntry(store.append(validateCaptureInput(draft))),
  }) satisfies ProductionEvidenceLedgerCaptureFacetV1;
  const read = Object.freeze({
    identity,
    get: (reference: string) => {
      const entry = store.get(reference);
      return entry ? freezeEvidenceEntry(entry) : null;
    },
    strictSnapshot: () => createStrictEvidenceLedgerSnapshotV1(store.listStrictSnapshotEntries()),
  }) satisfies ProductionEvidenceLedgerReadFacetV1;
  const authority = Object.freeze({
    identity,
    capture,
    read,
  }) satisfies ProductionEvidenceLedgerAuthorityV1;

  authorityBindings.set(authority, binding);
  readFacetBindings.set(read, binding);
  return authority;
}

/**
 * Durable runtime 的内部真实性闸门。结构相同的 caller adapter 不在 WeakMap 中，必须拒绝。
 * 该函数只在 Agent 私有模块间使用，不从 package public facade 导出。
 */
export function resolveProductionEvidenceLedgerReadBinding(
  candidate: unknown
): AuthorityBinding | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  return readFacetBindings.get(candidate as ProductionEvidenceLedgerReadFacetV1) ?? null;
}

/**
 * AgentRuntime 的兼容调用链仍需要完整 ledger 查询面；它必须从同一 public factory 的
 * authority 取回私有 store，禁止另行 new 第二个 EvidenceLedgerStore。
 */
export function resolveProductionEvidenceLedgerStore(
  authority: ProductionEvidenceLedgerAuthorityV1
): EvidenceLedgerStore {
  const binding = authorityBindings.get(authority);
  if (!binding) {
    throw new Error('ALEMBIC_AGENT_EVIDENCE_LEDGER_AUTHORITY_INVALID');
  }
  return binding.store;
}

/**
 * Production facade 会被 JavaScript、JSON 和跨进程调用；TypeScript 的 draft 类型在运行时
 * 已被擦除。必须先复制并冻结一份通过白名单校验的值，再允许 store 分配 E-n 或 append。
 */
function validateCaptureInput(input: unknown): EvidenceEntryDraft {
  const validationToken = Object.freeze({});
  try {
    return validateCaptureInputUnchecked(input, validationToken);
  } catch (err: unknown) {
    if (isCurrentCaptureValidationError(err, validationToken)) {
      throw err;
    }
    throwCaptureError('UNREADABLE_INPUT', validationToken);
  }
}

function validateCaptureInputUnchecked(
  input: unknown,
  validationToken: object
): EvidenceEntryDraft {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throwCaptureError('DRAFT_NOT_OBJECT', validationToken);
  }
  const record = input as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !CAPTURE_ALLOWED_FIELDS.has(key)) {
      throwCaptureError('EXTRA_FIELD', validationToken);
    }
  }
  for (const field of CAPTURE_REQUIRED_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      throwCaptureError(CAPTURE_MISSING_FIELD_REASONS[field], validationToken);
    }
  }
  const tool = record.tool;
  const callId = record.callId;
  const content = record.content;
  if (typeof tool !== 'string' || !isEvidenceToolId(tool)) {
    throwCaptureError('TOOL', validationToken);
  }
  if (typeof callId !== 'string') {
    throwCaptureError('CALL_ID', validationToken);
  }
  if (typeof content !== 'string') {
    throwCaptureError('CONTENT', validationToken);
  }

  let file: string | undefined;
  if (Object.hasOwn(record, 'file')) {
    const candidateFile = record.file;
    if (typeof candidateFile !== 'string' || candidateFile.length === 0) {
      throwCaptureError('FILE', validationToken);
    }
    file = candidateFile;
  }
  const hasRange = Object.hasOwn(record, 'range');
  const candidateRange = hasRange ? record.range : undefined;
  const range = hasRange ? validateCaptureRange(candidateRange, validationToken) : undefined;
  return Object.freeze({
    tool,
    callId,
    ...(file ? { file } : {}),
    ...(range ? { range } : {}),
    content,
  });
}

function validateCaptureRange(value: unknown, validationToken: object): EvidenceRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwCaptureError('RANGE', validationToken);
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  const start = record.start;
  const end = record.end;
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== 'start' && key !== 'end') ||
    !Object.hasOwn(record, 'start') ||
    !Object.hasOwn(record, 'end') ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (start as number) < 1 ||
    (end as number) < (start as number)
  ) {
    throwCaptureError('RANGE', validationToken);
  }
  return Object.freeze({
    start: start as number,
    end: end as number,
  });
}

function normalizeCoordinates(
  input: ProductionEvidenceLedgerCoordinatesV1
): ProductionEvidenceLedgerCoordinatesV1 {
  if (!input || typeof input !== 'object') {
    throwCoordinateError('coordinates must be an object');
  }
  if (
    typeof input.dataRoot !== 'string' ||
    input.dataRoot.trim() !== input.dataRoot ||
    input.dataRoot.length === 0 ||
    !path.isAbsolute(input.dataRoot)
  ) {
    throwCoordinateError('dataRoot must be a non-empty absolute path');
  }
  for (const [field, value] of [
    ['jobId', input.jobId],
    ['sessionId', input.sessionId],
    ['dimensionId', input.dimensionId],
  ] as const) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > COORDINATE_MAX_LENGTH ||
      value.trim() !== value ||
      value === '.' ||
      value === '..' ||
      value.includes('/') ||
      value.includes('\\') ||
      value.includes('\0')
    ) {
      throwCoordinateError(`${field} is not a safe ledger coordinate`);
    }
  }
  return Object.freeze({
    dataRoot: path.resolve(input.dataRoot),
    jobId: input.jobId,
    sessionId: input.sessionId,
    dimensionId: input.dimensionId,
  });
}

function createIdentity(
  coordinates: ProductionEvidenceLedgerCoordinatesV1
): ProductionEvidenceLedgerIdentityV1 {
  const storageRootHash = sha256(`storage-root\0${coordinates.dataRoot}`);
  const storeSemantic = {
    schemaVersion: 1,
    authorityKind: AUTHORITY_KIND,
    storageRootHash,
    jobId: coordinates.jobId,
    sessionId: coordinates.sessionId,
    dimensionId: coordinates.dimensionId,
    persistence: 'append-only-jsonl-v1',
  } as const;
  const storeId = `agent-evidence-ledger:${digestCanonical(storeSemantic)}`;
  const storeConfigHash = sha256(
    JSON.stringify({
      authorityKind: AUTHORITY_KIND,
      persistence: storeSemantic.persistence,
      redaction: 'redact-developer-text-v1',
      storeId,
    })
  );
  return Object.freeze({
    schemaVersion: 1,
    authorityKind: AUTHORITY_KIND,
    storeId,
    storeConfigHash,
    jobId: coordinates.jobId,
    sessionId: coordinates.sessionId,
    dimensionId: coordinates.dimensionId,
    persistence: storeSemantic.persistence,
  });
}

function digestCanonical(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function freezeEvidenceEntry(entry: EvidenceEntry): EvidenceEntry {
  const frozen = {
    ...entry,
    ...(entry.range ? { range: Object.freeze({ ...entry.range }) } : {}),
  };
  return Object.freeze(frozen);
}

function throwCoordinateError(message: string): never {
  throw new Error(`ALEMBIC_AGENT_EVIDENCE_LEDGER_COORDINATES_INVALID: ${message}`);
}

function throwCaptureError(reason: string, validationToken: object): never {
  const error = new Error(`${CAPTURE_ERROR_PREFIX}:${reason}`);
  captureValidationErrorTokens.set(error, validationToken);
  throw error;
}

function isCurrentCaptureValidationError(value: unknown, validationToken: object): value is Error {
  return (
    typeof value === 'object' &&
    value !== null &&
    captureValidationErrorTokens.get(value) === validationToken
  );
}
