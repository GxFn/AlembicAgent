import type { Relations } from '../scripts/relations.mjs';
import { readerSections } from './sections';
export interface SourceFile {
  path: string;
  kind: string;
  sha256: string;
  lines: number;
  symbols: string[];
  references?: string[];
  typeReferences?: string[];
  testCases?: string[];
}
export interface ImportEdge {
  from: string;
  to: string;
  specifier: string;
  kind: string;
  typeOnly: boolean;
  line: number;
}
export interface Diagram {
  id: string;
  source: string;
  digest: string;
  title: string;
}
export interface AtlasDocument {
  id: string;
  path: string;
  body: string;
  freshness: string;
  inputFiles: string[];
  errors: string[];
  metadata: {
    title: string;
    topic: string;
    viewType: string;
    truthKind: string;
    reviewDepth: string;
    baselineCommit: string;
    sourceFingerprint: string;
    verifiedAt: string;
    sourcePaths: string[];
    testPaths: string[];
  };
  diagrams: Diagram[];
  rows: { id: string; code: string; test: string; claim: string }[];
}
export interface RenderReceipt {
  renderer: string;
  rendererVersion: string;
  checkedAt: string;
  results: {
    id: string;
    digest: string;
    status: string;
    width: number;
    height: number;
    error?: string;
  }[];
}
export interface PilotReceipt {
  status: string;
  checkedAt: string;
  sourceFingerprint: string;
  testFingerprint: string;
  sourcePatterns: string[];
  real: string[];
  controlled: string[];
  unverified: string[];
  scenarios: {
    id: string;
    status: string;
    serviceStatus: string;
    toolStatuses: string[];
    assertion: string;
  }[];
}
export interface Reading {
  path: string;
  sha256: string;
  reading: string;
  freshness: string;
  role: string;
  basis: string;
  flow?: string;
  tests?: string[];
  risks?: string[];
  reviewPage?: string;
  provenance?: { kind: string; snapshotId?: string };
}
export interface Snapshot {
  relations?: Relations;
  health?: Health;
  publicApi?: unknown;
  scopedRuns?: ScopedExecutionReport | null;
  config?: Catalog['config'];
  id: string;
  capturedAt: string;
  baselineCommit: string;
  sourceFingerprint: string;
  inventory: Inventory;
  documents: AtlasDocument[];
  renderReceipt: RenderReceipt | null;
  pilot: PilotReceipt | null;
  readings?: Reading[];
  rendererVersion?: string;
  renderAttempt?: RenderAttempt | null;
  renderFreshness?: string;
}
export interface Inventory {
  files: SourceFile[];
  edges: ImportEdge[];
  externalEdges: ImportEdge[];
  unresolved: { from: string; specifier: string | null; reason: string }[];
  fingerprint: string;
}
export interface Catalog {
  relations?: Relations;
  health?: Health;
  publicApi?: unknown;
  scopedRuns?: ScopedExecutionReport | null;
  schemaVersion: number;
  checkedAt: string;
  git: { commit: string; dirtyPaths: string[] };
  config: { topics: { id: string; slug: string; title: string; question: string }[] };
  inventory: Inventory;
  documents: AtlasDocument[];
  current: { id: string; capturedAt: string } | null;
  history: SnapshotSummary[];
  rendererVersion: string;
  renderReceipt: RenderReceipt | null;
  pilot: PilotReceipt | null;
  pilotFreshness?: string;
  readings: Reading[];
  evidenceDiagnostics?: string[];
  renderAttempt?: RenderAttempt | null;
  renderFreshness?: string;
}
export const escapeHtml = (text: unknown): string =>
  String(text ?? '').replace(
    /[&<>"']/gu,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
export function parseRoute(hash: string): {
  kind: 'home' | 'doc' | 'files' | 'health' | 'scenarios' | 'missing';
  id: string;
  section?: string;
  edge?: string;
} {
  const [route, query] = hash.replace(/^#\/?/u, '').split('?');
  const [kind, ...rest] = route.split('/');
  if (!kind || kind === 'home') {
    return { kind: 'home', id: '' };
  }
  if (kind !== 'doc' && kind !== 'files' && kind !== 'health' && kind !== 'scenarios') {
    return { kind: 'missing', id: '' };
  }
  try {
    const result: ReturnType<typeof parseRoute> = { kind, id: decodeURIComponent(rest.join('/')) };
    const params = new URLSearchParams(query);
    if (kind === 'doc' && params.get('section')) {
      result.section = params.get('section') ?? undefined;
    }
    if (kind === 'doc' && params.get('edge')) {
      result.edge = params.get('edge') ?? undefined;
    }
    return result;
  } catch {
    return { kind: 'missing', id: '' };
  }
}
export function renderMatches(
  receipt: RenderReceipt | null,
  diagram: Diagram,
  version: string,
): boolean {
  if (
    !receipt ||
    !Array.isArray(receipt.results) ||
    receipt.results.some((r) => !r || typeof r !== 'object') ||
    receipt.rendererVersion !== version ||
    receipt.renderer !== 'mermaid' ||
    !Number.isFinite(Date.parse(receipt.checkedAt))
  ) {
    return false;
  }
  const results = receipt.results.filter((r) => r.id === diagram.id);
  return (
    results.length === 1 &&
    results[0].status === 'pass' &&
    results[0].digest === diagram.digest &&
    Number.isFinite(results[0].width) &&
    Number.isFinite(results[0].height) &&
    results[0].width > 0 &&
    results[0].height > 0
  );
}
export function selectDependencyGraph(
  inventory: Inventory,
  focus: string,
  direction: 'both' | 'out' | 'in',
  types: boolean,
  external: boolean,
  limit = 32,
) {
  const all = [...inventory.edges, ...(external ? inventory.externalEdges : [])];
  const selected = all.filter(
    (e) =>
      (types || !e.typeOnly) &&
      ((direction !== 'in' && e.from === focus) || (direction !== 'out' && e.to === focus)),
  );
  const paths = [
    focus,
    ...new Set(selected.flatMap((e) => [e.from, e.to]).filter((p) => p !== focus)),
  ];
  const nodes = paths.slice(0, limit);
  const kept = new Set(nodes);
  const edges = selected.filter((e) => kept.has(e.from) && kept.has(e.to));
  return {
    nodes,
    edges,
    omittedNodes: Math.max(0, paths.length - nodes.length),
    omittedEdges: selected.length - edges.length,
  };
}
export function searchCatalog(documents: AtlasDocument[], files: SourceFile[], query: string) {
  const q = query.trim().toLocaleLowerCase();
  const matching = q
    ? documents.filter((d) => `${d.metadata.title} ${d.body}`.toLocaleLowerCase().includes(q))
    : [];
  const matchingFiles = q
    ? files.filter((f) => `${f.path} ${f.symbols.join(' ')}`.toLocaleLowerCase().includes(q))
    : [];
  return {
    totalDocuments: matching.length,
    totalFiles: matchingFiles.length,
    documents: matching.slice(0, 12).map((d) => {
      const sections = readerSections(d.body).filter((s) =>
        `${s.title} ${s.text}`.toLocaleLowerCase().includes(q),
      );
      const section = sections.find((s) => s.title.startsWith('场景')) ?? sections[0];
      const text = (section?.text ?? d.body).replace(/[`*#<>]/gu, '').replace(/\s+/gu, ' ');
      const index = text.toLocaleLowerCase().indexOf(q);
      return {
        ...d,
        section: section?.id,
        snippet: text.slice(Math.max(0, index - 50), Math.max(0, index - 50) + 180),
      };
    }),
    files: matchingFiles.slice(0, 24),
  };
}

export interface Health {
  sampledAt: string;
  commit: string;
  baseline: string | null;
  sourceCount: number;
  readings: { matched: number; stale: number; missing: number };
  documents: { total: number; matched: number; needsReview: number };
  pilot: string;
  render: string;
  executionGroups: { id: string; file: string; status: string; freshness: string; scope: string }[];
  changes: {
    path: string;
    kind: string;
    status: string;
    before: string | null;
    after: string | null;
  }[];
  impacts: {
    path: string;
    status: string;
    documents: { id: string; title: string; semantic: boolean; errors: number }[];
    executionGroups: string[];
  }[];
  renderNeeds: string[];
  diagnostics: {
    id: string;
    path: string;
    title: string;
    primary: string[];
    secondaryCount: number;
  }[];
}
/** 自有模板应存在的节点／数据缺失时显式失败，不用非空断言掩盖脱节。 */
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Atlas expected DOM element or data is unavailable');
  }
  return value;
}

export interface AssetRef {
  url: string;
  sha256: string;
  bytes: number;
}
export interface SnapshotSummary {
  id: string;
  capturedAt: string;
  baselineCommit: string;
  sourceFiles?: number;
  documents?: number;
  diagrams?: number;
  asset: AssetRef;
}
export interface Bootstrap {
  schemaVersion: 2;
  kind: 'alembic-atlas-bootstrap';
  checkedAt: string;
  currentAsset: AssetRef;
  history: SnapshotSummary[];
}
export interface RenderAttempt {
  id: string;
  status: 'running' | 'pass' | 'fail' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  inputFingerprint: string;
  errors?: string[];
}
export function pilotEvidence(
  receipt: PilotReceipt | null,
  freshness: string | undefined,
  historical: boolean,
) {
  const count = Array.isArray(receipt?.scenarios)
    ? receipt.scenarios.filter((s) => s?.status === 'pass').length
    : 0;
  if (!receipt) {
    return { label: historical ? '历史未记录执行' : '尚未执行', tone: 'neutral', count: 0 };
  }
  if (
    !Array.isArray(receipt.scenarios) ||
    receipt.scenarios.some((s) => !s || typeof s.id !== 'string')
  ) {
    return { label: '执行证据格式无效', tone: 'warning', count: 0 };
  }
  const prefix = historical ? '历史 · ' : '';
  if (receipt.status !== 'pass') {
    return {
      label: prefix + (receipt.status === 'running' ? '正在执行' : '最近执行失败'),
      tone: 'warning',
      count,
    };
  }
  if (!count || count !== receipt.scenarios.length) {
    return { label: `${prefix}执行证据不完整`, tone: 'warning', count };
  }
  if (!historical && freshness !== 'matched') {
    return { label: '执行输入已变化／需复核', tone: 'warning', count };
  }
  return { label: `${prefix + count} 场景通过`, tone: historical ? 'neutral' : 'good', count };
}
export function readingFreshness(
  entry: { sha256: string } | undefined,
  reading: { sha256: string; freshness: string } | undefined,
) {
  if (!reading) {
    return 'unreviewed';
  }
  return entry?.sha256 === reading.sha256 ? reading.freshness : 'stale';
}

export interface ScopedExecutionReport {
  schemaVersion: 1 | 2;
  checkedAt: string;
  groups: {
    id: string;
    file: string;
    status: string;
    passed: number;
    failed: number;
    skipped: number;
    inputFreshness: string;
    cases: { title: string; status: string }[];
  }[];
}
export function scopedEvidence(
  report: ScopedExecutionReport | null | undefined,
  historical: boolean,
) {
  if (!report) {
    return {
      label: historical ? '历史未记录定向验证' : '尚无定向验证',
      tone: 'neutral',
      passed: 0,
    };
  }
  const passed = report.groups.reduce((n, g) => n + g.passed, 0);
  const healthy =
    report.groups.length > 0 &&
    report.groups.every(
      (g) =>
        g.status === 'pass' && g.failed === 0 && g.passed > 0 && g.inputFreshness === 'matched',
    );
  return {
    label:
      (historical ? '历史 · ' : '') + (healthy ? `${passed} 项定向测试通过` : '定向验证待复核'),
    tone: healthy ? (historical ? 'neutral' : 'good') : 'warning',
    passed,
  };
}
