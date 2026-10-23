import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  ActiveContext,
  MemoryConsolidator,
  MemoryCoordinator,
  PersistentMemory,
  SessionStore,
} from '../src/agent/memory/index.js';

/**
 * W2a-10 记忆层废弃成员删除（审阅包 L6-P25 第二组、L6-P16 的 setPlan/updatePlan 耦合项）。
 *
 * 决定②（2026-10-20 用户答复“全部按推荐”）批准删除下列无生产消费者的公开成员；删除前在工作区根
 * 做过四处扫描（Agent src/test、宿主生产与宿主测试、Plugin/Dashboard/Core），宿主与三仓零引用，
 * Agent 测试中的旧用法已改写到仍保留的生产入口：
 *   - ActiveContext 旧 RT/WM 入口与计划/读取方法、静态 fromJSON、构造选项 lightweight；
 *   - MemoryCoordinator 的维度/会话生命周期方法、检查点链（checkpoint/restore）与 dispose
 *     （总控裁定第 7 节第 5 项：宿主只 dispose SessionStore）、DimensionScopeConfig.lightweight；
 *   - SessionStore 的检查点读写（saveCheckpoint/loadCheckpoint）与 4 个无生产调用的读写方法；
 *   - PersistentMemory / MemoryConsolidator 的 migrateFromLegacy（连带私有 #mapLegacyType）。
 * 这些都是成员或类型层面的收窄，运行时导出名字与种类不变（签名快照零差异）。tsconfig 只包含 src，
 * vitest 不做类型检查，所以类型层面的删除用真实编译器探针锁定，运行时用原型断言锁定。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 用真实编译器检查一组探针源码，返回每个探针文件自身的诊断文本。 */
function typecheckProbes(probes: Record<string, string>): Record<string, string[]> {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
  };
  // 探针放在 test/ 下的虚拟路径，按仓库自己的 package.json（type: module + imports）走 NodeNext 解析。
  const virtualFiles = new Map(
    Object.entries(probes).map(([name, text]) => [path.join(REPO_ROOT, 'test', name), text])
  );
  const host = ts.createCompilerHost(options);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) => virtualFiles.has(fileName) || baseFileExists(fileName);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? baseReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtualFiles.get(fileName);
    return text === undefined
      ? baseGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const program = ts.createProgram([...virtualFiles.keys()], options, host);
  const result: Record<string, string[]> = {};
  for (const name of Object.keys(probes)) {
    const sourceFile = program.getSourceFile(path.join(REPO_ROOT, 'test', name));
    expect(sourceFile).toBeDefined();
    result[name] = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
  return result;
}

/** 探针统一从公开 memory 子路径的源码入口导入，与宿主经 @alembic/agent/memory 看到的类型一致。 */
const PROBE_PRELUDE = [
  'import {',
  '  ActiveContext,',
  '  MemoryConsolidator,',
  '  MemoryCoordinator,',
  '  PersistentMemory,',
  '  SessionStore,',
  "} from '../src/agent/memory/index.js';",
  'declare const context: ActiveContext;',
  'declare const coordinator: MemoryCoordinator;',
  'declare const store: SessionStore;',
  'declare const persistent: PersistentMemory;',
  'declare const consolidator: MemoryConsolidator;',
  'export const used = [context, coordinator, store, persistent, consolidator];',
];

/** 每个被删成员一条探针：单独一个文件，诊断只可能来自这一行。 */
const RETIRED_MEMBER_PROBES: Record<string, { member: string; line: string }> = {
  'ActiveContext.addAction': { member: 'addAction', line: "context.addAction('code', {});" },
  'ActiveContext.addObservation': {
    member: 'addObservation',
    line: "context.addObservation('code', {});",
  },
  'ActiveContext.observe': { member: 'observe', line: "context.observe('code', {}, 1);" },
  'ActiveContext.setPlan': { member: 'setPlan', line: "context.setPlan('1. Read src/a.ts', 1);" },
  'ActiveContext.updatePlan': {
    member: 'updatePlan',
    line: "context.updatePlan('1. Read src/a.ts', 2);",
  },
  'ActiveContext.getPlanHistory': { member: 'getPlanHistory', line: 'context.getPlanHistory();' },
  'ActiveContext.getCurrentIteration': {
    member: 'getCurrentIteration',
    line: 'context.getCurrentIteration();',
  },
  'ActiveContext.getThoughts': { member: 'getThoughts', line: 'context.getThoughts();' },
  'ActiveContext.getHighPriorityFindings': {
    member: 'getHighPriorityFindings',
    line: 'context.getHighPriorityFindings(7);',
  },
  'ActiveContext.fromJSON': { member: 'fromJSON', line: 'ActiveContext.fromJSON({});' },
  'ActiveContextOptions.lightweight': {
    member: 'lightweight',
    line: 'new ActiveContext({ lightweight: true });',
  },
  'MemoryCoordinator.completeDimension': {
    member: 'completeDimension',
    line: "coordinator.completeDimension('scope');",
  },
  'MemoryCoordinator.completeSession': {
    member: 'completeSession',
    line: 'void coordinator.completeSession();',
  },
  'MemoryCoordinator.extractFromConversation': {
    member: 'extractFromConversation',
    line: "coordinator.extractFromConversation('prompt', 'reply', 'user');",
  },
  'MemoryCoordinator.getPersistentMemory': {
    member: 'getPersistentMemory',
    line: 'coordinator.getPersistentMemory();',
  },
  'MemoryCoordinator.checkpoint': {
    member: 'checkpoint',
    line: "void coordinator.checkpoint('/project');",
  },
  'MemoryCoordinator.restore': { member: 'restore', line: "void coordinator.restore('/project');" },
  'MemoryCoordinator.dispose': { member: 'dispose', line: 'coordinator.dispose();' },
  'DimensionScopeConfig.lightweight': {
    member: 'lightweight',
    line: "coordinator.createDimensionScope('scope', { lightweight: true });",
  },
  'SessionStore.saveCheckpoint': {
    member: 'saveCheckpoint',
    line: "void store.saveCheckpoint('/project');",
  },
  'SessionStore.loadCheckpoint': {
    member: 'loadCheckpoint',
    line: "void store.loadCheckpoint('/project');",
  },
  'SessionStore.addEvidence': {
    member: 'addEvidence',
    line: "store.addEvidence('src/a.ts', { finding: 'f', importance: 5 });",
  },
  'SessionStore.getEvidenceForFile': {
    member: 'getEvidenceForFile',
    line: "store.getEvidenceForFile('src/a.ts');",
  },
  'SessionStore.buildContextSnapshot': {
    member: 'buildContextSnapshot',
    line: "store.buildContextSnapshot('next');",
  },
  'SessionStore.getDistilledForProducer': {
    member: 'getDistilledForProducer',
    line: "store.getDistilledForProducer('dim');",
  },
  'PersistentMemory.migrateFromLegacy': {
    member: 'migrateFromLegacy',
    line: "void persistent.migrateFromLegacy('/project');",
  },
  'MemoryConsolidator.migrateFromLegacy': {
    member: 'migrateFromLegacy',
    line: "void consolidator.migrateFromLegacy('/project');",
  },
};

function probeFileName(label: string): string {
  return `__memory-retired-${label.replace(/\W+/g, '-')}.probe.ts`;
}

describe('W2a-10 retired memory members are gone from the typed surface (compiler probes)', () => {
  it('rejects every retired member and option while the kept entrypoints still type-check', () => {
    const probes: Record<string, string> = {
      '__memory-retired-kept-surface.probe.ts': [
        ...PROBE_PRELUDE,
        // 仍保留的生产入口：构造、计划授权与提取、轮次记录、序列化与会话快照恢复。
        'const fresh = new ActiveContext({ maxRecentRounds: 2 });',
        'fresh.expectPlan();',
        "fresh.extractAndSetPlan('1. Read src/a.ts entry', 1);",
        'fresh.startRound(1);',
        "fresh.recordToolCall('code', { action: 'read', path: 'src/a.ts' }, 'x', true);",
        'fresh.endRound();',
        'export const rounds = fresh.toJSON().rounds.length + (fresh.getPlan()?.steps.length ?? 0);',
        "export const scope = coordinator.createDimensionScope('scope', { maxRecentRounds: 1 });",
        // 宿主断点续跑的恢复路径：持久化的 JSON 快照经 SessionStore.fromJSON 重建。
        'const persisted: Record<string, unknown> = JSON.parse(JSON.stringify(store.toJSON()));',
        "export const evidence = SessionStore.fromJSON(persisted).searchEvidence('src/a.ts');",
        'store.dispose();',
        '',
      ].join('\n'),
    };
    for (const [label, { line }] of Object.entries(RETIRED_MEMBER_PROBES)) {
      probes[probeFileName(label)] = [...PROBE_PRELUDE, line, ''].join('\n');
    }

    const diagnostics = typecheckProbes(probes);

    expect(diagnostics['__memory-retired-kept-surface.probe.ts']).toEqual([]);
    for (const [label, { member }] of Object.entries(RETIRED_MEMBER_PROBES)) {
      const messages = diagnostics[probeFileName(label)] ?? [];
      expect({
        label,
        rejected: messages.some(
          (message) =>
            message.includes(`'${member}'`) &&
            /does not exist on type|Object literal may only specify known properties/.test(message)
        ),
      }).toEqual({ label, rejected: true });
    }
  });
});

describe('W2a-10 retired memory members are gone at runtime (prototype assertions)', () => {
  it.each([
    [
      'ActiveContext',
      ActiveContext.prototype,
      [
        'addAction',
        'addObservation',
        'observe',
        'setPlan',
        'updatePlan',
        'getPlanHistory',
        'getCurrentIteration',
        'getThoughts',
        'getHighPriorityFindings',
      ],
    ],
    [
      'MemoryCoordinator',
      MemoryCoordinator.prototype,
      [
        'completeDimension',
        'completeSession',
        'extractFromConversation',
        'getPersistentMemory',
        'checkpoint',
        'restore',
        'dispose',
      ],
    ],
    [
      'SessionStore',
      SessionStore.prototype,
      [
        'saveCheckpoint',
        'loadCheckpoint',
        'addEvidence',
        'getEvidenceForFile',
        'buildContextSnapshot',
        'getDistilledForProducer',
      ],
    ],
    ['PersistentMemory', PersistentMemory.prototype, ['migrateFromLegacy']],
    ['MemoryConsolidator', MemoryConsolidator.prototype, ['migrateFromLegacy']],
  ] as const)('%s no longer carries the retired members', (owner, prototype, members) => {
    for (const member of members) {
      expect({ owner, member, present: member in prototype }).toEqual({
        owner,
        member,
        present: false,
      });
    }
  });

  it('keeps the production entrypoints that replace the retired members', () => {
    for (const member of [
      'recordToolCall',
      'expectPlan',
      'extractAndSetPlan',
      'getPlan',
      'getPlanStepsMutable',
      'getCurrentRoundActions',
      'toJSON',
      'distill',
      'clear',
    ]) {
      expect({ member, present: member in ActiveContext.prototype }).toEqual({
        member,
        present: true,
      });
    }
    // ActiveContext 不再有静态恢复入口；SessionStore.fromJSON 是宿主断点续跑的恢复路径，保留。
    expect(Object.hasOwn(ActiveContext, 'fromJSON')).toBe(false);
    expect(typeof SessionStore.fromJSON).toBe('function');
    // SessionStore.dispose 保留：宿主在会话结束时只 dispose SessionStore（L6-P28）。
    expect(typeof SessionStore.prototype.dispose).toBe('function');
    expect(typeof SessionStore.prototype.searchEvidence).toBe('function');
    expect(typeof MemoryCoordinator.prototype.createDimensionScope).toBe('function');
    expect(typeof MemoryCoordinator.prototype.searchEvidenceWithDiagnostics).toBe('function');
  });

  it('removes the dead lightweight branches, the checkpoint file chain and the legacy type mapper from source', () => {
    expect(read('src/agent/memory/ActiveContext.ts')).not.toMatch(/#lightweight|lightweight\?:/);
    expect(read('src/agent/memory/MemoryCoordinator.ts')).not.toMatch(/lightweight/);
    expect(read('src/agent/memory/SessionStore.ts')).not.toMatch(/bootstrap-checkpoint|renameSync/);
    expect(read('src/agent/memory/MemoryConsolidator.ts')).not.toMatch(
      /#mapLegacyType|memory\.jsonl/
    );
  });

  it('drops the deleted members from the deprecatedPendingNarrowing registry', () => {
    const signatures = JSON.parse(read('config/agent-public-api-signatures.json')) as {
      deprecatedPendingNarrowing: { members: Array<{ owner: string; members: string[] }> };
    };
    const registered = new Map(
      signatures.deprecatedPendingNarrowing.members.map((entry) => [entry.owner, entry.members])
    );
    // 本包删除后不应再有任何登记项的 owner（ActiveContext、ActiveContextOptions、DimensionScopeConfig、
    // SessionStore、PersistentMemory、MemoryConsolidator），MemoryCoordinator 只剩不在本包的成员。
    for (const owner of [
      'ActiveContext',
      'ActiveContextOptions',
      'DimensionScopeConfig',
      'SessionStore',
      'PersistentMemory',
      'MemoryConsolidator',
    ]) {
      expect({ owner, registered: registered.has(owner) }).toEqual({ owner, registered: false });
    }
    const coordinatorMembers = registered.get('MemoryCoordinator') ?? [];
    for (const member of [
      'checkpoint',
      'completeDimension',
      'completeSession',
      'dispose',
      'extractFromConversation',
      'getPersistentMemory',
      'restore',
    ]) {
      expect({ member, registered: coordinatorMembers.includes(member) }).toEqual({
        member,
        registered: false,
      });
    }
  });
});

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}
