import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  createStrictEvidenceLedgerSnapshotV1,
  type StrictEvidenceLedgerSnapshotV1,
} from '@alembic/core/host-agent-workflows';
import type { EvidenceEntry } from '@alembic/core/knowledge';
import { redactDeveloperText } from '../utils/Redaction.js';
import { type EvidenceEntryDraft, EvidenceLedgerStore } from './EvidenceLedgerStore.js';

const AUTHORITY_KIND = 'alembic-agent-production-evidence-ledger-v1';
const COORDINATE_MAX_LENGTH = 512;

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
    capture: (draft: ProductionEvidenceCaptureInputV1) => freezeEvidenceEntry(store.append(draft)),
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
