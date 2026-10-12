/**
 * L4-P36b / I16：code.outline 与 >500 行 code.read 的 AST 大纲端口。
 *
 * - kernel 的 ToolContext.outlineFile(absPath, relPath) 是宿主绑定的 AST 大纲端口（宿主读源码、映射语言、
 *   调 Core analyzeFile 后适配成 OutlineDefinition[]）；availability 只按这个端口广告 code.outline。
 * - 旧 astAnalyzer.analyzeFile(absPath) 鸭子类型只作为已弃用兼容入口在 handler 内服务，不再被广告。
 * - code.outline 的 kinds / maxDepth 真正生效，过滤后为空时返回带说明的空大纲。
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { handle as handleCode } from '../src/tools/runtime/handlers/code.js';
import type { ToolContext } from '../src/tools/runtime/index.js';
import { ToolRouter } from '../src/tools/runtime/index.js';

let baseRoot: string;

beforeAll(async () => {
  baseRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-outline-port-')));
});

afterAll(async () => {
  await rm(baseRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function project(name: string, lines = 1200): Promise<string> {
  const root = await mkdtemp(join(baseRoot, `${name}-`));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'src/big.ts'),
    Array.from({ length: lines }, (_, index) => `export const v${index + 1} = ${index + 1};`).join(
      '\n'
    )
  );
  return root;
}

/** 宿主适配后的定义：两层类、一个三层方法、顶层函数与接口。 */
const DEFINITIONS = [
  {
    name: 'Widget',
    kind: 'class',
    startLine: 1,
    endLine: 400,
    depth: 0,
    signature: 'export class Widget',
  },
  { name: 'render', kind: 'method', startLine: 10, endLine: 50, depth: 1, signature: 'render()' },
  { name: 'Inner', kind: 'class', startLine: 60, endLine: 90, depth: 1 },
  { name: 'deepMethod', kind: 'method', startLine: 70, endLine: 80, depth: 2 },
  { name: 'helper', kind: 'function', startLine: 401, endLine: 420, depth: 0 },
  { name: 'Shape', kind: 'interface', startLine: 430, endLine: 440, depth: 0 },
];

function portContext(
  root: string,
  extra: Record<string, unknown> = {}
): ToolContext & Record<string, unknown> {
  return {
    projectRoot: root,
    tokenBudget: 5000,
    outlineFile: vi.fn(async () => DEFINITIONS.map((def) => ({ ...def }))),
    ...extra,
  } as ToolContext & Record<string, unknown>;
}

async function outline(ctx: ToolContext, params: Record<string, unknown>) {
  return new ToolRouter().execute(
    { tool: 'code', action: 'outline', params: { path: 'src/big.ts', ...params } },
    ctx
  );
}

describe('outlineFile port (I16)', () => {
  it('serves a >500-line code.read through outlineFile with (absPath, relPath) and marks it ast', async () => {
    const root = await project('read');
    const ctx = portContext(root);
    const result = await new ToolRouter().execute(
      { tool: 'code', action: 'read', params: { path: 'src/big.ts' } },
      ctx
    );
    expect(result.ok).toBe(true);
    const text = String(result.data);
    expect(text).toContain('// 1200 lines, TypeScript, Tree-sitter AST');
    expect(text).toContain('export class Widget [1-400]');
    expect(text).toContain('    deepMethod [70-80]');
    expect(text).toContain('File has 1200 lines. Showing outline.');
    expect(result._meta?.degraded).toBeUndefined();
    expect(result._meta?.fallbackUsed).toBeUndefined();

    const port = ctx.outlineFile as ReturnType<typeof vi.fn>;
    expect(port).toHaveBeenCalledTimes(1);
    const [absPath, relPath] = port.mock.calls[0] as [string, string];
    expect(isAbsolute(absPath)).toBe(true);
    expect(absPath).toBe(join(root, 'src/big.ts'));
    expect(relPath).toBe('src/big.ts');

    const batch = await new ToolRouter().execute(
      { tool: 'code', action: 'read', params: { filePaths: ['src/big.ts'] } },
      portContext(root)
    );
    const files = (batch.data as { files: Array<Record<string, unknown>> }).files;
    expect(files[0]).toMatchObject({ ok: true, mode: 'outline', outlineSource: 'ast' });
    expect(files[0]?.outlineReason).toBeUndefined();
  });

  it('returns the full skeleton from code.outline without a filter header', async () => {
    const root = await project('full');
    const result = await outline(portContext(root), {});
    expect(result.ok).toBe(true);
    const text = String(result.data);
    for (const def of DEFINITIONS) {
      expect(text).toContain(def.signature ?? def.name);
    }
    expect(text).not.toContain('filter');
  });

  it('prefers outlineFile over the deprecated astAnalyzer duck type', async () => {
    const root = await project('prefer');
    const legacy = vi.fn(async () => ({ definitions: [] }));
    const ctx = portContext(root, { astAnalyzer: { analyzeFile: legacy } });
    const result = await outline(ctx, {});
    expect(result.ok).toBe(true);
    expect(String(result.data)).toContain('export class Widget [1-400]');
    expect(legacy).not.toHaveBeenCalled();
    expect(ctx.outlineFile).toHaveBeenCalledTimes(1);
  });

  it('reports a null port result as no-definitions for both outline and read', async () => {
    const root = await project('null');
    const ctx = portContext(root, { outlineFile: vi.fn(async () => null) });
    const result = await outline(ctx, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('returned no definitions');

    const batch = await new ToolRouter().execute(
      { tool: 'code', action: 'read', params: { filePaths: ['src/big.ts'] } },
      ctx
    );
    const files = (batch.data as { files: Array<Record<string, unknown>> }).files;
    expect(files[0]).toMatchObject({ outlineSource: 'head-tail', outlineReason: 'no-definitions' });
  });

  it('reports a throwing port as analyzer-error with the error class', async () => {
    const root = await project('throws');
    const logger = Logger.getInstance();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const ctx = portContext(root, {
      outlineFile: vi.fn(async () => {
        throw new RangeError('grammar missing');
      }),
    });
    const result = await outline(ctx, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('AST analyzer threw RangeError: grammar missing');
    expect(warn.mock.calls.some((call) => String(call[0]).includes('[code.outline]'))).toBe(true);
  });

  it('drops malformed port entries with a warning log and keeps the valid ones', async () => {
    const root = await project('malformed');
    const logger = Logger.getInstance();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const ctx = portContext(root, {
      outlineFile: vi.fn(async () => [
        { name: 'Kept', kind: 'class', startLine: 3, endLine: 9 },
        { kind: 'class', startLine: 4 },
        null,
        { name: 'BadLine', kind: 'function', startLine: 'x' },
      ]),
    });
    const result = await outline(ctx, {});
    expect(result.ok).toBe(true);
    const text = String(result.data);
    expect(text).toContain('Kept [3-9]');
    expect(text).not.toContain('BadLine');
    const logs = warn.mock.calls.map((call) => String(call[0]));
    expect(
      logs.some(
        (line) =>
          line.includes('[code.outline]') && line.includes('port=outlineFile dropped=3 of 4')
      )
    ).toBe(true);

    const allBad = await outline(
      portContext(root, { outlineFile: vi.fn(async () => [{ kind: 'class' }]) }),
      {}
    );
    expect(allBad.ok).toBe(false);
    expect(allBad.error).toContain('returned no definitions');
  });

  it('still serves the deprecated astAnalyzer duck type with a compatibility log', async () => {
    const root = await project('legacy');
    const logger = Logger.getInstance();
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    const legacy = vi.fn(async () => ({ definitions: DEFINITIONS }));
    const result = await outline(
      { projectRoot: root, tokenBudget: 5000, astAnalyzer: { analyzeFile: legacy } },
      {}
    );
    expect(result.ok).toBe(true);
    expect(legacy).toHaveBeenCalledWith(join(root, 'src/big.ts'));
    const logs = debug.mock.calls.map((call) => String(call[0]));
    expect(logs.some((line) => line.includes('legacy-astAnalyzer'))).toBe(true);
  });
});

describe('code.outline kinds / maxDepth filter (I16)', () => {
  it('keeps only the requested kinds and says how many definitions the filter hid', async () => {
    const root = await project('kinds');
    const result = await outline(portContext(root), { kinds: ['class'] });
    expect(result.ok).toBe(true);
    const text = String(result.data);
    expect(text).toContain('export class Widget [1-400]');
    expect(text).toContain('Inner [60-90]');
    expect(text).not.toContain('render()');
    expect(text).not.toContain('helper');
    expect(text).not.toContain('Shape');
    expect(text).toContain('filter kinds=class: showing 2 of 6 definitions');
  });

  it('treats maxDepth as nesting levels to keep (1 = top-level only)', async () => {
    const root = await project('depth');
    const top = String((await outline(portContext(root), { maxDepth: 1 })).data);
    expect(top).toContain('export class Widget [1-400]');
    expect(top).toContain('helper [401-420]');
    expect(top).toContain('Shape [430-440]');
    expect(top).not.toContain('render()');
    expect(top).not.toContain('Inner');
    expect(top).not.toContain('deepMethod');
    expect(top).toContain('filter maxDepth=1: showing 3 of 6 definitions');

    const two = String((await outline(portContext(root), { maxDepth: 2 })).data);
    expect(two).toContain('render()');
    expect(two).toContain('Inner');
    expect(two).not.toContain('deepMethod');
  });

  it('combines kinds and maxDepth', async () => {
    const root = await project('combined');
    const text = String(
      (await outline(portContext(root), { kinds: ['class', 'method'], maxDepth: 1 })).data
    );
    expect(text).toContain('export class Widget [1-400]');
    expect(text).not.toContain('Inner');
    expect(text).not.toContain('render()');
    expect(text).toContain('filter kinds=class,method maxDepth=1: showing 1 of 6 definitions');
  });

  it('returns an explained empty outline when the filter matches nothing', async () => {
    const root = await project('empty');
    const result = await outline(portContext(root), { kinds: ['enum'] });
    expect(result.ok).toBe(true);
    const text = String(result.data);
    expect(text).toContain('// 1200 lines, TypeScript, Tree-sitter AST');
    expect(text).toContain('filter kinds=enum: showing 0 of 6 definitions');
    expect(text).toContain('No definitions match the filter');
    expect(text).not.toContain('Widget');
  });

  it('treats an empty kinds array as no kind filter', async () => {
    const root = await project('empty-kinds');
    const text = String((await outline(portContext(root), { kinds: [] })).data);
    expect(text).toContain('render()');
    expect(text).toContain('Shape');
    expect(text).not.toContain('filter');
  });

  it('rejects maxDepth values that are not positive integers', async () => {
    const root = await project('bad-depth');
    for (const maxDepth of [0, -1, 1.5, '2']) {
      const result = await handleCode(
        'outline',
        { path: 'src/big.ts', maxDepth },
        portContext(root)
      );
      expect(result.ok, `maxDepth=${String(maxDepth)}`).toBe(false);
      expect(result.error).toContain('code.outline maxDepth must be a positive integer');
    }
  });

  it('rejects kinds outside the declared enum or not given as an array', async () => {
    const root = await project('bad-kinds');
    const unknownKind = await handleCode(
      'outline',
      { path: 'src/big.ts', kinds: ['variable'] },
      portContext(root)
    );
    expect(unknownKind.ok).toBe(false);
    expect(unknownKind.error).toContain('code.outline kinds');
    expect(unknownKind.error).toContain('variable');

    const notArray = await handleCode(
      'outline',
      { path: 'src/big.ts', kinds: 'class' },
      portContext(root)
    );
    expect(notArray.ok).toBe(false);
    expect(notArray.error).toContain('code.outline kinds');
  });

  it('never filters the code.read outline', async () => {
    const root = await project('read-unfiltered');
    const result = await handleCode(
      'read',
      { path: 'src/big.ts', kinds: ['class'], maxDepth: 1 },
      portContext(root)
    );
    const text = String(result.data);
    expect(text).toContain('deepMethod [70-80]');
    expect(text).not.toContain('filter');
  });
});

describe('code.outline availability follows the outlineFile port (I16)', () => {
  const reasonFor = (snapshot: ReturnType<typeof ToolRouter.describeAvailability>) =>
    snapshot.unavailable?.find((entry) => entry.tool === 'code' && entry.action === 'outline')
      ?.reason;

  it('advertises code.outline when outlineFile is bound', () => {
    const snapshot = ToolRouter.describeAvailability({ outlineFile: async () => null } as never);
    expect(snapshot.actions.code).toContain('outline');
    expect(reasonFor(snapshot)).toBeUndefined();
  });

  it('does not advertise code.outline on the deprecated astAnalyzer duck type alone', () => {
    const snapshot = ToolRouter.describeAvailability({
      astAnalyzer: { analyzeFile: async () => null },
    });
    expect(snapshot.actions.code).not.toContain('outline');
    expect(snapshot.actions.code).toContain('read');
    const reason = reasonFor(snapshot);
    expect(reason).toContain('outlineFile is unavailable');
    expect(reason).toContain('legacy astAnalyzer.analyzeFile');
  });

  it('names the missing outlineFile port when nothing is bound', () => {
    const snapshot = ToolRouter.describeAvailability({});
    expect(snapshot.actions.code).not.toContain('outline');
    expect(reasonFor(snapshot)).toBe('outlineFile is unavailable');
  });
});
