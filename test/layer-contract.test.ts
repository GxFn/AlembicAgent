import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTempProject } from './helpers/tempProject.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PIPELINE_DIR = 'src/agent/runtime/toolPipeline';
const ENGINE = `${PIPELINE_DIR}/engine.ts`;
const CONTRACTS = `${PIPELINE_DIR}/contracts.ts`;
const FACADE = 'src/agent/runtime/ToolExecutionPipeline.ts';

interface FileBoundaries {
  requiredUnder: string[];
  runtimeImports: Record<string, string[]>;
}

interface ConfigOverrides {
  fileBoundaries?: FileBoundaries;
  typeOnlyImportsExempt?: boolean;
  blessedImports?: { file: string; to: string }[];
}

const fileBoundaries = (allowed: string[] = []): FileBoundaries => ({
  requiredUnder: [`${PIPELINE_DIR}/`],
  runtimeImports: { [ENGINE]: allowed, [CONTRACTS]: [] },
});

/** 执行发布入口本身；fixture 只链接现有依赖，不写源码树或相邻 Core。 */
function runLint(
  sources: Record<string, string>,
  overrides: ConfigOverrides = { fileBoundaries: fileBoundaries() },
  args: string[] = []
) {
  const root = createTempProject('agent-layer-contract-');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'config'), { recursive: true });
  copyFileSync(
    path.join(REPO_ROOT, 'scripts/lint-layer-contract.mjs'),
    path.join(root, 'scripts/lint-layer-contract.mjs')
  );
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  writeFileSync(
    path.join(root, 'config/layer-contract.json'),
    JSON.stringify({
      schemaVersion: 1,
      areas: ['agent', 'ai', 'root', 'shared', 'tools', 'types'],
      allowedRuntimeImports: {
        agent: ['ai', 'shared', 'tools'],
        ai: ['shared'],
        root: ['*'],
        shared: [],
        tools: ['shared'],
        types: [],
      },
      typeOnlyImportsExempt: true,
      blessedImports: [],
      ...overrides,
    })
  );
  for (const [file, content] of Object.entries({
    [ENGINE]: 'export {};',
    [CONTRACTS]: 'export type Contract = { value: string };',
    [FACADE]: 'export const facade = 1;',
    ...sources,
  })) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return spawnSync(process.execPath, ['scripts/lint-layer-contract.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('layer contract CLI', () => {
  it.each([
    '../ToolExecutionPipeline.js',
    '#agent/runtime/ToolExecutionPipeline.js',
  ])('rejects an engine back-edge to its facade through %s', (specifier) => {
    const result = runLint({ [ENGINE]: `import { facade } from '${specifier}';` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${ENGINE}:1`);
    expect(result.stderr).toContain(FACADE);
    expect(result.stderr).toContain('file boundary');
  });

  it('uses one source-file identity for relative and alias dependencies', () => {
    const result = runLint(
      {
        [ENGINE]: `
          import { value } from './contracts.js';
          export { value } from '#agent/runtime/toolPipeline/contracts.js';
          void import('./contracts.js');
        `,
      },
      { fileBoundaries: fileBoundaries([CONTRACTS]) }
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['#ai/value.js', 'src/ai/value.ts'],
    ['#shared/value.js', 'src/shared/value.ts'],
    ['#tools/value.js', 'src/tools/value.ts'],
    ['../../../shared/value.mjs', 'src/shared/value.mts'],
    ['../../../shared/value.cjs', 'src/shared/value.cts'],
    ['../../../shared/value.jsx', 'src/shared/value.tsx'],
    ['../../../shared/value.jsx', 'src/shared/value.ts'],
    ['../../../shared/value', 'src/shared/value/index.ts'],
  ])('resolves %s to its actual source target %s', (specifier, target) => {
    const result = runLint(
      { [ENGINE]: `import { value } from '${specifier}';`, [target]: 'export const value = 1;' },
      { fileBoundaries: fileBoundaries([target]) }
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('prefers a source file over a same-name index when resolving an extensionless import', () => {
    const result = runLint(
      {
        [ENGINE]: "import '#shared/value';",
        'src/shared/value.tsx': 'export {};',
        'src/shared/value/index.ts': 'export {};',
      },
      { fileBoundaries: fileBoundaries(['src/shared/value.tsx']) }
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('resolves extensionless imports as .ts/.tsx rather than implicit .mts/.cts', () => {
    const preferred = runLint(
      {
        [ENGINE]: "import '#shared/value';",
        'src/shared/value.mts': 'export {};',
        'src/shared/value.tsx': 'export {};',
      },
      { fileBoundaries: fileBoundaries(['src/shared/value.tsx']) }
    );
    expect(preferred.status, preferred.stderr).toBe(0);

    const unresolved = runLint(
      {
        [ENGINE]: "import '#shared/value';",
        'src/shared/value.mts': 'export {};',
        'src/shared/value.cts': 'export {};',
      },
      { fileBoundaries: fileBoundaries(['src/shared/value.mts', 'src/shared/value.cts']) }
    );
    expect(unresolved.status).toBe(1);
    expect(unresolved.stderr).toContain('runtime import src/shared/value (#shared/value)');
  });

  it('requires a rule for every source file under a constrained directory', () => {
    const unlisted = `${PIPELINE_DIR}/unexpected.ts`;
    const result = runLint({ [unlisted]: 'export {};' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${unlisted}:1`);
    expect(result.stderr).toContain('no file boundary rule');
  });

  it('does not match sibling directory names by a partial prefix', () => {
    const result = runLint({ 'src/agent/runtime/toolPipelineSibling/file.ts': 'export {};' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('also constrains explicitly configured files outside requiredUnder', () => {
    const result = runLint(
      { [FACADE]: "export * from './toolPipeline/engine.js';" },
      {
        fileBoundaries: {
          ...fileBoundaries(),
          runtimeImports: { ...fileBoundaries().runtimeImports, [FACADE]: [] },
        },
      }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${FACADE}:1`);
    expect(result.stderr).toContain(ENGINE);
  });

  it('exempts whole-statement and inline type-only imports and exports', () => {
    const result = runLint({
      [ENGINE]: `
        import type DefaultType from '../ToolExecutionPipeline.js';
        import type { Shape } from '../ToolExecutionPipeline.js';
        import { type Shape as OtherShape } from '../ToolExecutionPipeline.js';
        import type Facade = require('../ToolExecutionPipeline.js');
        export type { Shape } from '../ToolExecutionPipeline.js';
        export { type Shape as ExportedShape } from '../ToolExecutionPipeline.js';
        export type * from '../ToolExecutionPipeline.js';
        type LazyShape = import('../ToolExecutionPipeline.js').Shape;
      `,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    "import { type Shape, facade } from '../ToolExecutionPipeline.js';",
    "import facade, { type Shape } from '../ToolExecutionPipeline.js';",
    "export { type Shape, facade } from '../ToolExecutionPipeline.js';",
    "import {} from '../ToolExecutionPipeline.js';",
    "export {} from '../ToolExecutionPipeline.js';",
    "export * from '../ToolExecutionPipeline.js';",
    "import '../ToolExecutionPipeline.js';",
    "void import('../ToolExecutionPipeline.js');",
    'void import(`../ToolExecutionPipeline.js`);',
    "import facade = require('../ToolExecutionPipeline.js');",
  ])('enforces runtime dependencies in %s', (statement) => {
    const result = runLint({ [ENGINE]: statement });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(FACADE);
  });

  it('checks exact external runtime specifiers', () => {
    const result = runLint(
      { [ENGINE]: "import path from 'node:path';\nimport 'node:fs';" },
      { fileBoundaries: fileBoundaries(['node:path']) }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${ENGINE}:2`);
    expect(result.stderr).toContain('node:fs');
    expect(result.stderr).not.toContain('node:path');
  });

  it('rejects nonliteral dynamic imports only inside constrained files', () => {
    const result = runLint({
      [ENGINE]: 'const target = "./contracts.js";\nvoid import(target);',
      [FACADE]: 'const target = "./toolPipeline/engine.js";\nvoid import(target);',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${ENGINE}:2`);
    expect(result.stderr).toContain('nonliteral dynamic import');
    expect(result.stderr).not.toContain(`${FACADE}:`);
  });

  it('allows direct require calls to explicitly permitted local and external targets', () => {
    const ctsFile = `${PIPELINE_DIR}/common.cts`;
    const result = runLint(
      {
        [ctsFile]: `
          const local = require('./contracts.js');
          const alias = require('#agent/runtime/toolPipeline/contracts.js');
          const path = require('node:path');
        `,
      },
      {
        fileBoundaries: {
          ...fileBoundaries(),
          runtimeImports: {
            ...fileBoundaries().runtimeImports,
            [ctsFile]: [CONTRACTS, 'node:path'],
          },
        },
      }
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects direct require calls to unlisted local and external targets', () => {
    const result = runLint({
      [ENGINE]:
        "const facade = require('../ToolExecutionPipeline.js');\nconst fs = require('node:fs');",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${ENGINE}:1`);
    expect(result.stderr).toContain(FACADE);
    expect(result.stderr).toContain(`${ENGINE}:2`);
    expect(result.stderr).toContain('node:fs');
  });

  it('rejects nonliteral require calls only inside constrained files', () => {
    const result = runLint({
      [ENGINE]: 'const target = "./contracts.js";\nconst local = require(target);',
      [FACADE]: 'const target = "./toolPipeline/engine.js";\nconst local = require(target);',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${ENGINE}:2`);
    expect(result.stderr).toContain('nonliteral require');
    expect(result.stderr).not.toContain(`${FACADE}:`);
  });

  it('leaves file boundaries optional for the existing top-level contract', () => {
    const result = runLint(
      { [ENGINE]: "import '../ToolExecutionPipeline.js';\nvoid import(target);" },
      {}
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('ignores imports written inside comments and ordinary strings', () => {
    const result = runLint({
      'src/shared/example.ts': `
        // import { facade } from '#agent/runtime/ToolExecutionPipeline.js';
        /* export * from '#agent/runtime/ToolExecutionPipeline.js'; */
        const example = "import '#agent/runtime/ToolExecutionPipeline.js';";
        const dynamicExample = "import('#agent/runtime/ToolExecutionPipeline.js')";
        const templateExample = \`export * from '#agent/runtime/ToolExecutionPipeline.js';\`;
      `,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('retains top-level denial and its existing blessed-edge override', () => {
    const source = { 'src/shared/value.ts': "import '#agent/runtime/ToolExecutionPipeline.js';" };
    const denied = runLint(source);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('runtime import shared -> agent');
    const blessed = runLint(source, {
      blessedImports: [{ file: 'src/shared/value.ts', to: 'agent' }],
    });
    expect(blessed.status, blessed.stderr).toBe(0);
  });

  it('keeps the top-level type exemption switch separate from file-level type bridges', () => {
    const result = runLint(
      {
        'src/shared/value.ts':
          "import type { Shape } from '#agent/runtime/ToolExecutionPipeline.js';",
      },
      {
        typeOnlyImportsExempt: false,
        fileBoundaries: {
          ...fileBoundaries(),
          runtimeImports: { ...fileBoundaries().runtimeImports, 'src/shared/value.ts': [] },
        },
      }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime import shared -> agent');
    expect(result.stderr).not.toContain('violates the file boundary');
  });

  it('does not let an area-level allowance override an explicit file boundary', () => {
    const result = runLint(
      {
        [ENGINE]: "import '#shared/value.js';",
        'src/shared/value.ts': 'export {};',
      },
      { fileBoundaries: fileBoundaries(), blessedImports: [{ file: ENGINE, to: 'shared' }] }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('violates the file boundary');
  });

  it('counts real cross-area edges and inline type bridges in observation mode', () => {
    const result = runLint(
      {
        [ENGINE]: 'void import(target);',
        'src/agent/example.ts': `
          import { value } from '../shared/value.js';
          export { value as other } from '#shared/value.js';
          import type { Shape } from '#shared/value.js';
          export { type Shape } from '#shared/value.js';
          type LazyShape = import('#shared/value.js').Shape;
          type ModuleType = typeof import('#shared/value.js');
        `,
        'src/shared/value.ts': "import '#agent/runtime/ToolExecutionPipeline.js';",
      },
      { fileBoundaries: fileBoundaries() },
      ['--report']
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Observed cross-area runtime edges (as-is graph):');
    expect(result.stdout).toContain('  agent -> shared: 2');
    expect(result.stdout).toContain('  shared -> agent: 1');
    expect(result.stdout).toContain('Total: 3 runtime edges, 4 type-only bridges.');
  });
});
