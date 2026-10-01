import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTempProject } from './helpers/tempProject.js';

/**
 * 隐式键 lint 的行为钉子：执行发布入口脚本本身，夹具只链接现有依赖。
 *
 * sharedState / strategyContext / phaseResults 上的下划线键没有编译期约束；登记表
 * (config/implicit-keys.json) 是它们唯一的归属声明，这里验证登记表与源码不一致时
 * lint 一定失败，并且失败信息能定位到键和文件。
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface ChannelRow {
  container: string;
  writers: string[];
  purpose: string;
  unwiredReason?: string;
}

interface Registry {
  channels?: Record<string, ChannelRow>;
  prefixes?: Record<string, ChannelRow>;
  fields?: Record<string, { owner: string; purpose: string }>;
}

function runLint(sources: Record<string, string>, registry: Registry, args: string[] = []) {
  const root = createTempProject('agent-implicit-keys-');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'config'), { recursive: true });
  copyFileSync(
    path.join(REPO_ROOT, 'scripts/lint-implicit-keys.mjs'),
    path.join(root, 'scripts/lint-implicit-keys.mjs')
  );
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  writeFileSync(
    path.join(root, 'config/implicit-keys.json'),
    JSON.stringify({ schemaVersion: 1, channels: {}, prefixes: {}, fields: {}, ...registry })
  );
  for (const [file, content] of Object.entries(sources)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return spawnSync(process.execPath, ['scripts/lint-implicit-keys.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

const channel = (writers: string[], container = 'sharedState') => ({
  container,
  writers,
  purpose: 'fixture channel',
});

describe('implicit key lint CLI', () => {
  it('passes the repository registry against the real source tree', () => {
    const result = spawnSync(process.execPath, ['scripts/lint-implicit-keys.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Implicit-key lint OK');
    // 无人写入的通道只剩重复调用缓存的三个快照键（去留随图谱接线决定）；新增必须显式登记原因。
    expect(result.stdout).toContain(
      'unwired channels (read here, written by nobody): _projectRevision, _projectSnapshotId, _workspaceRevision\n'
    );
  });

  it('accepts registered channels, key families and typed fields, and reports unwired channels', () => {
    const result = runLint(
      {
        'src/writer.ts': [
          'export function write(shared: Record<string, unknown>, phases: Record<string, unknown>) {',
          '  shared._counter = 1;',
          "  shared['_quoted'] ??= {};",
          // 夹具源码里的模板占位符需要转义，避免被当成本文件的插值。
          `  phases[\`_retries_\${String(shared.stage)}\`] = 1;`,
          '  return { _literal: true };',
          '}',
        ].join('\n'),
        'src/reader.ts': [
          'interface Row { _score?: number }',
          'export function read(shared: Record<string, unknown>, row: Row) {',
          '  const { _literal } = shared;',
          "  return [shared._counter, shared._hostOnly, shared._nobody, '_quoted' in shared, _literal, row._score];",
          '}',
        ].join('\n'),
      },
      {
        channels: {
          _counter: channel(['agent']),
          _quoted: channel(['agent']),
          _literal: channel(['agent']),
          _hostOnly: channel(['host']),
          _nobody: { ...channel([]), unwiredReason: 'fixture: provider not wired yet' },
        },
        prefixes: { _retries_: channel(['agent'], 'phaseResults') },
        fields: { _score: { owner: 'src/reader.ts', purpose: 'fixture typed field' } },
      }
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('5 channels, 1 key families, 1 typed fields registered');
    expect(result.stdout).toContain('unwired channels (read here, written by nobody): _nobody');
  });

  it('ignores class members reached through this and ordinary underscore locals', () => {
    const result = runLint(
      {
        'src/service.ts': [
          'export class Service {',
          '  _cache = new Map<string, number>();',
          '  get(_unused: string, key: string) {',
          '    const _local = this._cache.get(key);',
          '    return _local;',
          '  }',
          '}',
        ].join('\n'),
      },
      {}
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails on an unregistered key and points at the file and line', () => {
    const result = runLint(
      {
        'src/leak.ts': [
          'export function leak(shared: Record<string, unknown>) {',
          '  return shared._hiddenChannel;',
          '}',
        ].join('\n'),
      },
      {}
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/leak.ts:2 uses unregistered key '_hiddenChannel'");
  });

  it('fails on an unregistered key family built with a template', () => {
    const result = runLint(
      {
        'src/family.ts': `export const key = (stage: string) => \`_attempts_\${stage}\`;\nexport const other = 1;`,
      },
      {}
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/family.ts:1 builds key family '_attempts_…'");
  });

  it('fails when a registered key no longer occurs in the source', () => {
    const result = runLint(
      { 'src/empty.ts': 'export const value = 1;' },
      { channels: { _retired: channel(['agent']) } }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("registered key '_retired' no longer occurs in src/");
  });

  it.each([
    {
      label: 'an agent write that the registry does not declare',
      source: 'export function f(s: Record<string, unknown>) {\n  s._flag = true;\n}',
      writers: ['host'],
      message: `channel '_flag' is written in src/ but "agent" is not in its writers`,
    },
    {
      label: 'a declared agent writer without any write site',
      source: 'export function f(s: Record<string, unknown>) {\n  return s._flag;\n}',
      writers: ['agent'],
      message: `channel '_flag' lists "agent" as a writer but src/ has no write site`,
    },
  ])('fails on $label', ({ source, writers, message }) => {
    const result = runLint({ 'src/flag.ts': source }, { channels: { _flag: channel(writers) } });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it('fails on a channel nobody writes unless the gap is acknowledged with a reason', () => {
    const result = runLint(
      { 'src/read.ts': 'export const f = (s: Record<string, unknown>) => s._orphan;' },
      { channels: { _orphan: channel([]) } }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "channel '_orphan' has no writer — wire it, delete the read, or record an unwiredReason"
    );
  });

  it('fails on a stale unwired acknowledgment once the channel has a writer', () => {
    const result = runLint(
      {
        'src/wired.ts':
          'export function f(s: Record<string, unknown>) {\n  s._wired = 1;\n  return s._wired;\n}',
      },
      { channels: { _wired: { ...channel(['agent']), unwiredReason: 'no longer true' } } }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "channel '_wired' has writers but still carries an unwiredReason"
    );
  });

  it('rejects malformed registry rows before scanning', () => {
    const result = runLint(
      { 'src/empty.ts': 'export const value = 1;' },
      {
        channels: {
          _bad: { container: 'somewhere', writers: ['nobody'], purpose: '' },
        },
        fields: { _field: { owner: 'src/missing.ts', purpose: 'fixture' } },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'_bad' container must be one of");
    expect(result.stderr).toContain("'_bad' writers must be an array drawn from agent, host");
    expect(result.stderr).toContain("'_bad' needs a non-empty purpose");
    expect(result.stderr).toContain("field '_field' owner must be an existing source file");
  });

  it('prints the scanned usage table in report mode without consulting the registry rows', () => {
    const result = runLint(
      {
        'src/report.ts':
          'export function f(s: Record<string, unknown>) {\n  s._a = 1;\n  return s._a;\n}',
      },
      {},
      ['--report']
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('_a\tread=1 write=1 declare=0\tsrc/report.ts');
  });
});
