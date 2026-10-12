import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OutputCompressor,
  parseGitDiffOutput,
  parseGitStatusOutput,
  parseLintOutput,
  parsePackageOutput,
  parseTestOutput,
  parseTreeOutput,
  ToolRouterAdapter,
  truncateOutput,
} from '../src/tools/runtime/index.js';

/** 真实 terminal → compressor → adapter；宿主只提供受控进程输出，不运行 shell。 */
async function terminalOutput(command: string, stdout: string, stderr = '', budget = 4000) {
  const adapter = new ToolRouterAdapter({
    contextFactory: {
      create: () => ({
        projectRoot: process.cwd(),
        tokenBudget: budget,
        compressor: new OutputCompressor(),
        sandboxExecutor: {
          exec: async () => ({ stdout, stderr, exitCode: stderr ? 1 : 0 }),
        },
      }),
    },
  });
  return adapter.execute({
    toolId: 'terminal',
    args: { action: 'exec', params: { command } },
    surface: 'runtime',
    actor: { role: 'agent' },
    source: { kind: 'runtime', name: 'compression-fixture' },
  });
}

/**
 * 专用解析器摘要的期望文本：首行固定为 '[summarized by <parser>; raw <N> chars]'，N 是被摘要的
 * stdout 字符数。terminal 装配时会 trimEnd stdout，所以按 trimEnd 后的长度计算。
 */
function summarized(parser: string, stdout: string, body: string): string {
  return `[summarized by ${parser}; raw ${stdout.trimEnd().length} chars]\n${body}`;
}

describe('terminal output fidelity and budgets', () => {
  it('keeps stderr when a native parser summarizes stdout', async () => {
    const result = await terminalOutput('git status', '?? fresh.ts', 'fatal: fixture failure');
    expect(result.text).toContain('fresh.ts');
    expect(result.text).toContain('[stderr]');
    expect(result.text).toContain('fatal: fixture failure');
  });

  it.each([
    'git status && npm test',
    'git status; npm test',
    'git status | cat',
  ])('does not apply a single-command parser to %s', async (command) => {
    const stdout = '?? fresh.ts\nTests  1 failed (1)\nAssertionError: fixture failure';
    const result = await terminalOutput(command, stdout);
    expect(result.text).toContain('Tests  1 failed (1)');
    expect(result.text).toContain('AssertionError: fixture failure');
  });

  it('keeps useful head and tail of an over-budget single line', async () => {
    const result = await terminalOutput('fixture-command', `HEAD_${'x'.repeat(3000)}_TAIL`, '', 40);
    expect(result.text).toContain('HEAD_');
    expect(result.text).toContain('_TAIL');
    expect(result.text).toContain('truncated');
    expect(result.text.length).toBeLessThanOrEqual(160);
  });

  it.each([
    0, 1, 8, 24, 160,
  ])('counts the truncation marker within a %i character budget', (budget) => {
    const output = truncateOutput('line\n'.repeat(100), budget);
    expect(output.length).toBeLessThanOrEqual(budget);
  });
});

describe('package output facts', () => {
  it.each([
    ['yarn install', '➤ YN0000: Yarn 4\n➤ YN0035: Package not found\n➤ YN0000: Failed with errors'],
    ['yarn install', '➤ YN0000: Resolution step'],
    ['npm install', 'added 2 packages in 1s\nnpm ERR! code ERESOLVE'],
    ['pnpm install', 'Packages: +2\nERR_PNPM_FETCH_404: package not found'],
  ])('preserves failed or incomplete %s output instead of inventing an install summary', async (command, stdout) => {
    const result = await terminalOutput(command, stdout);
    expect(result.text).toContain(stdout);
    expect(result.text).not.toContain('added 0 packages, removed 0, 0 warnings');
  });

  it.each([
    [
      'npm install',
      'added 3 packages, removed 1 package, and changed 2 packages in 1s',
      'added 3 packages, removed 1',
    ],
    [
      'pnpm install',
      'Packages: +3 -1\nProgress: resolved 3, reused 3, downloaded 0, added 3, done',
      'added 3 packages, removed 1',
    ],
  ])('keeps known %s counts', async (command, stdout, expected) => {
    expect((await terminalOutput(command, stdout)).text).toContain(expected);
  });

  // npm 只有一种严重级别时输出 'N <level> severity vulnerabilities'，多级别时带括号明细。
  it.each([
    ['2 moderate severity vulnerabilities', '2 moderate severity vulnerabilities'],
    ['1 high severity vulnerability', '1 high severity vulnerability'],
    ['3 vulnerabilities (1 low, 2 high)', '3 vulnerabilities (1 low, 2 high)'],
    ['found 0 vulnerabilities', '0 vulnerabilities'],
  ])('keeps the npm audit line "%s" next to the install counts', async (auditLine, expected) => {
    const stdout = [
      'added 3 packages, and audited 4 packages in 1s',
      '',
      auditLine,
      '',
      'To address all issues, run:',
      '  npm audit fix',
      '',
      'Run `npm audit` for details.',
    ].join('\n');
    const text = (await terminalOutput('npm install lodash', stdout)).text;
    expect(text).toContain('added 3 packages, removed 0, 0 warnings');
    expect(text).toContain(expected);
  });

  it('keeps raw npm output when a vulnerability line is not a recognized audit summary', async () => {
    const stdout = 'added 3 packages in 1s\n\nvulnerabilities: 2 (moderate)';
    expect(parsePackageOutput(stdout)).toBeNull();
    expect((await terminalOutput('npm install', stdout)).text).toContain(stdout);
  });

  it('does not treat a deprecation warning that mentions a vulnerability as an audit summary', () => {
    const stdout =
      'npm WARN deprecated request@2.88.2: older versions have a known vulnerability\n\nadded 3 packages in 1s';
    expect(parsePackageOutput(stdout)).toBe(
      'added 3 packages, removed 0, 1 warnings\n\nWarnings:\n  deprecated request@2.88.2: older versions have a known vulnerability'
    );
  });
});

describe('test run summaries', () => {
  it.each([
    ['vitest', 'Tests 5 passed (5)\nTests 1 failed (1)'],
    ['jest', 'Tests: 5 passed, 5 total\nTests: 1 failed, 1 total'],
    ['pytest', '=== 5 passed in 1s ===\n=== 1 failed in 1s ==='],
    ['pytest', '=== 1 xpassed in 1s ==='],
    ['mocha', '5 passing (1s)\n0 passing (1s)\n1 failing'],
    ['vitest', 'Test Files 1 failed (1)\nTests 5 passed (5)'],
    ['vitest', 'Tests 1 failed | 1 passed (5)'],
  ])('keeps ambiguous or incomplete %s facts as raw output', async (command, stdout) => {
    expect((await terminalOutput(command, stdout)).text).toContain(stdout);
  });

  it.each([
    ['Tests 2 failed (2)', 'Tests: 0 passed, 2 failed, 2 total'],
    ['Tests 1 failed | 2 passed | 1 skipped (4)', 'Tests: 2 passed, 1 failed, 1 skipped, 4 total'],
  ])('summarizes a single complete Vitest outcome: %s', async (stdout, summary) => {
    expect((await terminalOutput('vitest', stdout)).text).toContain(summary);
  });
});

/** 真实形态的 pytest / mocha 输出：失败明细写在 stdout，摘要必须带上失败名，否则交回原文。 */
describe('test failure details in stdout', () => {
  const PYTEST_FULL = [
    '============================= test session starts ==============================',
    'platform linux -- Python 3.12.0, pytest-8.3.3, pluggy-1.5.0',
    'rootdir: /repo',
    'collected 4 items',
    '',
    'test_a.py .F.F                                                           [100%]',
    '',
    '=================================== FAILURES ===================================',
    '____________________________________ test_x ____________________________________',
    '',
    '    def test_x():',
    '>       assert 1 == 2',
    'E       assert 1 == 2',
    '',
    'test_a.py:4: AssertionError',
    '____________________________________ test_y ____________________________________',
    '',
    '    def test_y():',
    ">       {}['k']",
    "E       KeyError: 'k'",
    '',
    'test_a.py:7: KeyError',
    '=========================== short test summary info ============================',
    'FAILED test_a.py::test_x - assert 1 == 2',
    "FAILED test_a.py::test_y - KeyError: 'k'",
    '========================= 2 failed, 2 passed in 0.03s ==========================',
  ].join('\n');

  it('names every pytest failure from the short test summary', async () => {
    expect((await terminalOutput('pytest', PYTEST_FULL)).text).toBe(
      summarized(
        'test-output',
        PYTEST_FULL,
        [
          'Tests: 2 passed, 2 failed, 4 total',
          '',
          '[failures]',
          'FAIL test_a.py::test_x: assert 1 == 2',
          "FAIL test_a.py::test_y: KeyError: 'k'",
        ].join('\n')
      )
    );
  });

  it('labels a pytest setup error separately and keeps parametrized ids with spaces', () => {
    const stdout = [
      '=========================== short test summary info ============================',
      'FAILED test_p.py::test_case[a b] - assert False',
      'ERROR test_p.py::test_db - RuntimeError: no database',
      '==================== 1 failed, 3 passed, 1 error in 0.20s =====================',
    ].join('\n');
    expect(parseTestOutput(stdout)).toBe(
      [
        'Tests: 3 passed, 2 failed, 5 total',
        '',
        '[failures]',
        'FAIL test_p.py::test_case[a b]: assert False',
        'ERROR test_p.py::test_db: RuntimeError: no database',
      ].join('\n')
    );
  });

  it.each([
    [
      'no short test summary',
      '============================= test session starts ==============================\ncollected 3 items\n\ntest_a.py .F.                                                            [100%]\n========================= 1 failed, 2 passed in 0.10s ==========================',
    ],
    [
      'fewer summary lines than failures',
      '=========================== short test summary info ============================\nFAILED test_a.py::test_x - assert 1 == 2\n========================= 2 failed, 2 passed in 0.10s ==========================',
    ],
  ])('keeps raw pytest output when failures are counted but not named (%s)', async (_label, stdout) => {
    expect(parseTestOutput(stdout)).toBeNull();
    expect((await terminalOutput('pytest', stdout)).text).toContain(stdout);
  });

  const MOCHA_SPEC = [
    '',
    '',
    '  suite',
    '    ✔ good',
    '    - pending one',
    '    1) bad',
    '    2) worse',
    '',
    '',
    '  1 passing (8ms)',
    '  1 pending',
    '  2 failing',
    '',
    '  1) suite',
    '       bad:',
    '     Error: boom',
    '      at Context.<anonymous> (test/a.test.js:5:11)',
    '      at process.processImmediate (node:internal/timers:476:21)',
    '',
    '  2) suite',
    '       worse:',
    '',
    '      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '',
    '1 !== 2',
    '',
    '      + expected - actual',
    '',
    '      -1',
    '      +2',
    '      ',
    '      at Context.<anonymous> (test/a.test.js:8:12)',
  ].join('\n');

  it('names every numbered mocha failure and counts pending tests', async () => {
    expect((await terminalOutput('mocha', MOCHA_SPEC)).text).toBe(
      summarized(
        'test-output',
        MOCHA_SPEC,
        [
          'Tests: 1 passed, 2 failed, 1 skipped, 4 total',
          '',
          '[failures]',
          'FAIL suite bad: Error: boom',
          'FAIL suite worse: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 1 !== 2 | + expected - actual',
        ].join('\n')
      )
    );
  });

  it('counts mocha pending tests in the total', () => {
    const stdout = [
      '  3 passing (10ms)',
      '  1 pending',
      '  1 failing',
      '',
      '  1) top-level failure:',
      '     Error: boom',
      '      at Context.<anonymous> (test/a.test.js:5:11)',
    ].join('\n');
    expect(parseTestOutput(stdout)).toBe(
      'Tests: 3 passed, 1 failed, 1 skipped, 5 total\n\n[failures]\nFAIL top-level failure: Error: boom'
    );
  });

  it.each([
    ['no numbered block', '  3 passing (10ms)\n  1 failing'],
    ['a duplicated pending summary', '  3 passing (10ms)\n  1 pending\n  2 pending'],
    [
      'fewer numbered blocks than failures',
      '  3 passing (10ms)\n  2 failing\n\n  1) suite\n       bad:\n     Error: boom',
    ],
  ])('keeps raw mocha output for %s', async (_label, stdout) => {
    expect(parseTestOutput(stdout)).toBeNull();
    expect((await terminalOutput('mocha', stdout)).text).toContain(stdout.trim());
  });
});

describe('lint output counts', () => {
  it.each([
    {
      command: 'eslint .',
      // ESLint 默认 stylish：文件名独占一行，问题行缩进，结尾是 '✖ N problems' 摘要。
      stdout: [
        ...Array.from({ length: 15 }, (_, index) =>
          [
            `/repo/src/file${index}.ts`,
            `  1:1  ${index < 12 ? 'error  ' : 'warning'}  Fixture issue  fixture-rule`,
            '',
          ].join('\n')
        ),
        '✖ 15 problems (12 errors, 3 warnings)',
      ].join('\n'),
      warnings: 3,
    },
    {
      command: 'tsc --noEmit',
      stdout: Array.from(
        { length: 12 },
        (_, index) => `file${index}.ts(1,1): error TS1000: issue`
      ).join('\n'),
      warnings: 0,
    },
  ])('counts every $command issue while showing only ten details', async ({
    command,
    stdout,
    warnings,
  }) => {
    const result = await terminalOutput(command, stdout);
    expect(result.text).toContain(`12 errors, ${warnings} warnings`);
    expect(result.text).toContain('file9.ts');
    expect(result.text).not.toContain('file10.ts');
  });
});

/** 真实 ESLint v9 stylish 输出（路径换成占位根目录）与真实 Biome pretty 输出。 */
describe('lint output from real formatters', () => {
  const ESLINT_STYLISH = [
    '',
    '/repo/src/a.js',
    '  1:1   error    Unexpected var, use let or const instead  no-var',
    "  1:5   warning  'a' is assigned a value but never used    no-unused-vars",
    '  1:10  error    Missing semicolon                         semi',
    '  2:1   error    Unexpected var, use let or const instead  no-var',
    "  2:5   warning  'b' is assigned a value but never used    no-unused-vars",
    '',
    '/repo/src/b.js',
    "  1:7  warning  'unused' is assigned a value but never used  no-unused-vars",
    "  2:7  error    Expected '===' and instead saw '=='          eqeqeq",
    '',
    '✖ 7 problems (4 errors, 3 warnings)',
    '  4 errors and 0 warnings potentially fixable with the `--fix` option.',
  ].join('\n');

  it('keeps file, line and rule details from multi-file ESLint stylish output', async () => {
    expect((await terminalOutput('eslint .', ESLINT_STYLISH)).text).toBe(
      summarized(
        'lint-output',
        ESLINT_STYLISH,
        [
          '4 errors, 3 warnings',
          '',
          'Top issues:',
          '  /repo/src/a.js:1: Unexpected var, use let or const instead (no-var)',
          "  /repo/src/a.js:1: 'a' is assigned a value but never used (no-unused-vars)",
          '  /repo/src/a.js:1: Missing semicolon (semi)',
          '  /repo/src/a.js:2: Unexpected var, use let or const instead (no-var)',
          "  /repo/src/a.js:2: 'b' is assigned a value but never used (no-unused-vars)",
          "  /repo/src/b.js:1: 'unused' is assigned a value but never used (no-unused-vars)",
          "  /repo/src/b.js:2: Expected '===' and instead saw '==' (eqeqeq)",
        ].join('\n')
      )
    );
  });

  it('keeps a rule-less ESLint parsing error under its file', () => {
    const stdout = [
      '',
      '/repo/src/d.js',
      '  1:11  error  Parsing error: Unexpected token ;',
      '',
      '✖ 1 problem (1 error, 0 warnings)',
    ].join('\n');
    expect(parseLintOutput(stdout)).toBe(
      '1 errors, 0 warnings\n\nTop issues:\n  /repo/src/d.js:1: Parsing error: Unexpected token ;'
    );
  });

  it.each([
    [
      'a summary without any recognizable detail',
      '/repo/src/a.js\n  something odd\n\n✖ 3 problems (2 errors, 1 warning)',
    ],
    [
      'details that do not add up to the summary',
      '/repo/src/a.js\n  1:1  error  Unexpected var  no-var\n\n✖ 3 problems (2 errors, 1 warning)',
    ],
    [
      'an issue line outside any file block',
      '  1:1  error  Unexpected var  no-var\n\n✖ 1 problem (1 error, 0 warnings)',
    ],
  ])('keeps raw ESLint output for %s', async (_label, stdout) => {
    expect(parseLintOutput(stdout)).toBeNull();
    expect((await terminalOutput('eslint .', stdout)).text).toContain(stdout);
  });

  it('leaves real Biome pretty output to the generic path', async () => {
    const stdout = 'Checked 1 file in 3ms. No fixes applied.\nFound 2 errors.';
    const stderr = [
      'src/a.ts:2:7 lint/suspicious/noDoubleEquals  FIXABLE  ━━━━━━━━━━━━━━━━━━━━',
      '',
      '  × Using == may be unsafe if you are relying on type coercion.',
      '',
      'src/a.ts:2:15 lint/suspicious/noDebugger  FIXABLE  ━━━━━━━━━━━━━━━━━━━━',
      '',
      '  × This is an unexpected use of the debugger statement.',
    ].join('\n');
    const text = (await terminalOutput('biome check .', stdout, stderr)).text;
    expect(text).toContain(stdout);
    expect(text).toContain('src/a.ts:2:15 lint/suspicious/noDebugger');
  });

  it('no longer recognizes the retired self-made Biome diagnostic shape', async () => {
    const stdout = 'file.ts:1:1 error[fixture] issue';
    expect(parseLintOutput(stdout)).toBeNull();
    expect((await terminalOutput('biome check .', stdout)).text).toBe(stdout);
  });
});

describe('directory output structure', () => {
  it.each([
    [
      'tree .',
      '.\n├── package.json\n└── src\n    ├── a.ts\n    └── nested\n        └── b.ts\n\n2 directories, 3 files',
    ],
    ['find . -type f', './package.json\n./src/a.ts\n./src/nested/b.ts'],
    ['ls -R .', '.:\npackage.json\nsrc\n\n./src:\na.ts\nnested\n\n./src/nested:\nb.ts'],
  ])('retains the real hierarchy from %s', async (command, stdout) => {
    expect((await terminalOutput(command, stdout)).text).toBe(
      summarized('tree', stdout, 'package.json\nsrc/\n  a.ts\n  nested/\n    b.ts')
    );
  });

  it.each([
    ['tree .', '.\n└── src\nNOTICE: incomplete listing'],
    ['find .', './src/a.ts\nfind: Permission denied'],
  ])('falls back instead of inventing paths from malformed %s output', async (command, stdout) => {
    expect((await terminalOutput(command, stdout)).text).toContain(stdout);
  });

  // ls 长格式里的权限列、'total N' 与符号链接 '->' 不是路径，按 '/' 切分会打乱并伪造子节点。
  it.each([
    [
      'ls -la',
      [
        'total 16',
        'drwxr-xr-x  5 user  staff  160 Jan  1 12:00 .',
        'drwxr-xr-x  9 user  staff  288 Jan  1 12:00 ..',
        '-rw-r--r--  1 user  staff   12 Jan  1 12:00 a.ts',
        'lrwxr-xr-x  1 user  staff   12 Jan  1 12:00 link -> ../target',
        'drwxr-xr-x  3 user  staff   96 Jan  1 12:00 src',
      ].join('\n'),
    ],
    [
      'ls -l',
      '-rw-r--r--  1 user  staff  12 Jan  1 12:00 a.ts\nlrwxr-xr-x  1 user  staff  8 Jan  1 12:00 lib -> /usr/lib',
    ],
    [
      'ls -laR',
      '.:\ntotal 8\n-rw-r--r--  1 user  staff  12 Jan  1 12:00 a.ts\n\n./src:\ntotal 8\nlrwxr-xr-x  1 user  staff  9 Jan  1 12:00 link -> ../a.ts',
    ],
  ])('keeps %s long-format output in its original order', async (command, stdout) => {
    expect(parseTreeOutput(stdout)).toBeNull();
    expect((await terminalOutput(command, stdout)).text).toContain(stdout);
  });

  it.each([
    ['ls -p', 'a.ts\nsrc/\nlib/', 'a.ts\nlib/\nsrc/'],
    ['ls -d */', 'lib/\nsrc/\ntest/', 'lib/\nsrc/\ntest/'],
    [
      'ls -R -p .',
      '.:\na.ts\nempty/\nsrc/\n\n./empty:\n\n./src:\nb.ts',
      'a.ts\nempty/\nsrc/\n  b.ts',
    ],
  ])('keeps the directory marker of empty entries listed by %s', async (command, stdout, expected) => {
    expect((await terminalOutput(command, stdout)).text).toBe(summarized('tree', stdout, expected));
  });

  it.each([
    [
      "find . -name '*.json'",
      './package.json\n./.vscode/settings.json\n./dist/meta.json',
      'package.json\n(2 entries under .vscode, dist omitted)',
    ],
    [
      'ls -R .',
      '.:\ndist\nsrc\n\n./dist:\nx.js\n\n./src:\na.ts',
      'src/\n  a.ts\n(2 entries under dist omitted)',
    ],
    [
      'tree .',
      '.\n├── dist\n│   └── x.js\n└── src\n    └── a.ts\n\n2 directories, 2 files',
      'src/\n  a.ts\n(2 entries under dist omitted)',
    ],
  ])('announces entries filtered out of %s', async (command, stdout, expected) => {
    expect((await terminalOutput(command, stdout)).text).toBe(summarized('tree', stdout, expected));
  });

  it.each([
    ['find dist -type f', 'dist/a.js\ndist/sub/b.js', 'dist/\n  a.js\n  sub/\n    b.js'],
    [
      "find . -path '*/.vscode/*'",
      './.vscode/settings.json\n./.vscode/launch.json',
      '.vscode/\n  launch.json\n  settings.json',
    ],
    [
      'find node_modules/x -maxdepth 1',
      'node_modules/x\nnode_modules/x/index.js\nnode_modules/x/package.json',
      'node_modules/\n  x/\n    index.js\n    package.json',
    ],
  ])('stops filtering when %s names an ignored directory', async (command, stdout, expected) => {
    expect((await terminalOutput(command, stdout)).text).toBe(summarized('tree', stdout, expected));
  });
});

/** 被过滤条目与关闭过滤都要留下诊断：只记录固定忽略名与计数，不记录命令原文。 */
describe('directory filter diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the omitted entry count and ignored names', async () => {
    const info = vi
      .spyOn(Logger.getInstance(), 'info')
      .mockImplementation(() => Logger.getInstance());
    const output = await new OutputCompressor().compress(
      './package.json\n./.vscode/settings.json\n./dist/meta.json',
      { command: "find . -name '*.json'" }
    );
    expect(output).toContain('(2 entries under .vscode, dist omitted)');
    const messages = info.mock.calls.map(([message]) => String(message));
    expect(messages).toContain('[OutputCompressor] parser=tree; omitted=2; names=.vscode,dist');
    expect(messages.join('\n')).not.toContain('*.json');
  });

  it('logs when an explicit ignored target turns the filter off', async () => {
    const info = vi
      .spyOn(Logger.getInstance(), 'info')
      .mockImplementation(() => Logger.getInstance());
    await new OutputCompressor().compress('dist/a.js\ndist/b.js', { command: 'find dist -type f' });
    const messages = info.mock.calls.map(([message]) => String(message));
    expect(messages).toContain(
      '[OutputCompressor] parser=tree; ignored-name-filter=off; reason=command-targets-ignored-name'
    );
  });

  it('records why an all-ignored listing falls back to raw output', async () => {
    const info = vi
      .spyOn(Logger.getInstance(), 'info')
      .mockImplementation(() => Logger.getInstance());
    const warn = vi
      .spyOn(Logger.getInstance(), 'warn')
      .mockImplementation(() => Logger.getInstance());
    const stdout = './dist/a.js\n./dist/b.js';
    expect(await new OutputCompressor().compress(stdout, { command: "find . -name '*.js'" })).toBe(
      stdout
    );
    // 全部条目被忽略名过滤是预期路径，不是故障：记 info，warn 只留给 parser-error 与加载失败。
    const messages = info.mock.calls.map(([message]) => String(message));
    expect(messages).toContain(
      '[OutputCompressor] parser=tree; fallback=generic; reason=all-entries-ignored'
    );
    expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).not.toContain(
      'all-entries-ignored'
    );
  });
});

describe('grep output completeness', () => {
  const match = JSON.stringify({
    type: 'match',
    data: { path: { text: 'a.ts' }, line_number: 1, lines: { text: 'fixture\n' } },
  });
  const summary = JSON.stringify({ type: 'summary', data: { stats: { matched_lines: 1 } } });

  it.each([
    `${match}\n{broken json`,
    `${match}\nnot-json\n${summary}`,
    match,
    'a.ts:1: fixture\nrg: search interrupted',
  ])('keeps malformed or incomplete grep output intact', async (stdout) => {
    expect((await terminalOutput('rg fixture --json', stdout)).text).toContain(stdout);
  });

  it.each([
    `${match}\n${summary}`,
    'a.ts:1: fixture',
  ])('summarizes a complete supported match format', async (stdout) => {
    const result = await terminalOutput('rg fixture', stdout);
    expect(result.text).toContain('1 matches in 1 files');
    expect(result.text).toContain('a.ts:1: fixture');
  });
});

describe('git status facts', () => {
  it('retains copied, type-changed and ignored entries alongside modified files', async () => {
    const result = await terminalOutput(
      'git status --short --ignored',
      ' M tracked.ts\nC  original.ts -> copy.ts\n T kind.ts\n!! ignored/'
    );
    expect(result.text).toContain('modified(1): tracked.ts');
    expect(result.text).toContain('copied(1): original.ts -> copy.ts');
    expect(result.text).toContain('typechanged(1): kind.ts');
    expect(result.text).toContain('ignored(1): ignored/');
  });

  it('does not turn a human status footer into an untracked filename', async () => {
    const stdout =
      'On branch main\nUntracked files:\n\tnew.ts\n\nnothing added to commit but untracked files present (use "git add" to track)';
    expect((await terminalOutput('git status', stdout)).text).toBe(
      summarized('git-status', stdout, 'branch: main\nuntracked(1): new.ts')
    );
  });

  it('keeps an unknown status line instead of reporting a partial file list as complete', async () => {
    const stdout = ' M tracked.ts\nunexpected: incomplete status';
    expect((await terminalOutput('git status', stdout)).text).toContain(stdout);
  });

  it('reports an unstaged human-format deletion as deleted and keeps the branch line', async () => {
    const stdout = [
      'On branch main',
      "Your branch is ahead of 'origin/main' by 1 commit.",
      '  (use "git push" to publish your local commits)',
      '',
      'Changes not staged for commit:',
      '  (use "git add/rm <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes in working directory)',
      '\tdeleted:    src/old.ts',
      '\tmodified:   src/kept.ts',
      '',
      'no changes added to commit (use "git add" and/or "git commit -a")',
    ].join('\n');
    expect((await terminalOutput('git status', stdout)).text).toBe(
      summarized(
        'git-status',
        stdout,
        "branch: main; Your branch is ahead of 'origin/main' by 1 commit.\nmodified(1): src/kept.ts\ndeleted(1): src/old.ts"
      )
    );
  });

  it('buckets staged human-format changes by change type like the porcelain format', async () => {
    const human = [
      'On branch main',
      'Changes to be committed:',
      '  (use "git restore --staged <file>..." to unstage)',
      '\tnew file:   d.ts',
      '\trenamed:    a.ts -> b.ts',
      '\tdeleted:    c.ts',
      '\tcopied:     e.ts -> f.ts',
      '\ttypechange: link.ts',
      '\tmodified:   g.ts',
      '',
    ].join('\n');
    const porcelain = 'A  d.ts\nR  a.ts -> b.ts\nD  c.ts\nC  e.ts -> f.ts\nT  link.ts\nM  g.ts';
    const expected =
      'staged(2): d.ts, g.ts\ndeleted(1): c.ts\nrenamed(1): a.ts -> b.ts\ncopied(1): e.ts -> f.ts\ntypechanged(1): link.ts';
    expect(parseGitStatusOutput(porcelain)).toBe(expected);
    expect((await terminalOutput('git status', human)).text).toBe(
      summarized('git-status', human, `branch: main\n${expected}`)
    );
  });

  it('recognizes a detached HEAD instead of falling back for the whole status', async () => {
    const stdout = [
      'HEAD detached at abc1234',
      'Changes not staged for commit:',
      '\tmodified:   a.ts',
      '',
      'no changes added to commit (use "git add" and/or "git commit -a")',
    ].join('\n');
    expect((await terminalOutput('git status', stdout)).text).toBe(
      summarized('git-status', stdout, 'branch: HEAD detached at abc1234\nmodified(1): a.ts')
    );
  });

  it('keeps both lines of a diverged branch notice', () => {
    const stdout = [
      'On branch main',
      "Your branch and 'origin/main' have diverged,",
      'and have 1 and 2 different commits each, respectively.',
      '  (use "git pull" if you want to integrate the remote branch with yours)',
      '',
      'Untracked files:',
      '\tnew.ts',
    ].join('\n');
    expect(parseGitStatusOutput(stdout)).toBe(
      "branch: main; Your branch and 'origin/main' have diverged, and have 1 and 2 different commits each, respectively.\nuntracked(1): new.ts"
    );
  });

  it('keeps the porcelain branch header requested with --branch', () => {
    expect(parseGitStatusOutput('## main...origin/main [ahead 1]\n M a.ts')).toBe(
      'branch: main...origin/main [ahead 1]\nmodified(1): a.ts'
    );
  });

  it('reports a lone intent-to-add entry instead of an empty summary', async () => {
    const result = await terminalOutput('git status --short', ' A new.ts');
    expect(result.status).toBe('success');
    expect(result.text).toBe(summarized('git-status', ' A new.ts', 'intent-to-add(1): new.ts'));
  });

  it('keeps an intent-to-add entry next to other worktree changes', async () => {
    expect((await terminalOutput('git status --short', ' A new.ts\n M b.ts')).text).toBe(
      summarized('git-status', ' A new.ts\n M b.ts', 'modified(1): b.ts\nintent-to-add(1): new.ts')
    );
    expect(parseGitStatusOutput('## main\n A new.ts')).toBe(
      'branch: main\nintent-to-add(1): new.ts'
    );
  });

  it('reports a human-format unstaged new file as intent-to-add', () => {
    const stdout = [
      'On branch main',
      'Changes not staged for commit:',
      '  (use "git add <file>..." to update what will be committed)',
      '\tnew file:   new.ts',
      '\tmodified:   b.ts',
    ].join('\n');
    expect(parseGitStatusOutput(stdout)).toBe(
      'branch: main\nmodified(1): b.ts\nintent-to-add(1): new.ts'
    );
  });

  it.each([
    [
      'an unmerged section',
      'On branch main\nYou have unmerged paths.\n  (fix conflicts and run "git commit")\n\nUnmerged paths:\n  (use "git add <file>..." to mark resolution)\n\tboth modified:   a.ts',
    ],
    [
      'a branch notice without any file entry',
      'On branch main\nnothing to commit, working tree clean',
    ],
    [
      'an unknown change type',
      'On branch main\nChanges not staged for commit:\n\tunknown:    a.ts',
    ],
    [
      'an indented entry outside any section',
      'On branch main\nUntracked files:\n\ta.ts\n\nnothing added to commit but untracked files present\n\tstray.ts',
    ],
  ])('falls back to the raw status for %s', (_label, stdout) => {
    expect(parseGitStatusOutput(stdout)).toBeNull();
  });
});

describe('git diff facts', () => {
  it('counts +++ and --- as changed content inside a hunk, not file headers', async () => {
    const stdout =
      'diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n---previous;\n+++next;\n unchanged';
    // 预算内 git diff 保留补丁原文；计数摘要只在超预算时出现，这里用 25 token（100 字符）的预算触发。
    expect(stdout.length).toBeGreaterThan(100);
    expect((await terminalOutput('git diff', stdout, '', 25)).text).toBe(
      summarized('git-diff', stdout, '1 files changed, +1/-1 lines\n\na.ts: +1/-1')
    );
    expect((await terminalOutput('git diff', stdout)).text).toBe(stdout);
  });

  it.each([
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n+incomplete',
    'diff --git a/a.bin b/a.bin\nindex 1111111..2222222 100644\nBinary files a/a.bin and b/a.bin differ',
  ])('keeps incomplete or non-text patches as raw output', async (stdout) => {
    expect((await terminalOutput('git diff', stdout)).text).toContain(stdout);
  });

  it('keeps every per-file line of git diff --stat next to the summary', async () => {
    const stdout = [
      ' src/a.ts         |  3 ++-',
      ' src/b.ts         | 10 ++++++++++',
      ' assets/logo.png  | Bin 0 -> 1234 bytes',
      ' src/{old => new}.ts | 0',
      ' 4 files changed, 12 insertions(+), 1 deletion(-)',
      '',
    ].join('\n');
    expect(parseGitDiffOutput(stdout)).toBe(
      [
        '4 files changed, 12 insertions(+), 1 deletion(-)',
        '',
        'src/a.ts | 3 ++-',
        'src/b.ts | 10 ++++++++++',
        'assets/logo.png | Bin 0 -> 1234 bytes',
        'src/{old => new}.ts | 0',
      ].join('\n')
    );
    // 预算内 terminal 原样保留 --stat 输出（git-diff 属于预算内保留原文的解析器）。
    expect((await terminalOutput('git diff --stat main', stdout)).text).toBe(stdout.trimEnd());
  });

  it('keeps the git diff --shortstat summary unchanged', async () => {
    const stdout = ' 2 files changed, 3 insertions(+), 1 deletion(-)\n';
    expect(parseGitDiffOutput(stdout)).toBe('2 files changed, 3 insertions(+), 1 deletion(-)');
    expect((await terminalOutput('git diff --shortstat', stdout)).text).toBe(stdout.trimEnd());
  });

  it.each([
    [
      'a per-file count that disagrees with the summary',
      ' src/a.ts | 3 ++-\n 2 files changed, 3 insertions(+), 1 deletion(-)',
    ],
    [
      'an unrecognized line around the stat block',
      ' src/a.ts | 3 ++-\n ...\n 2 files changed, 3 insertions(+), 1 deletion(-)',
    ],
    [
      'text after the summary line',
      ' src/a.ts | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)\n create mode 100644 src/a.ts',
    ],
  ])('keeps git diff --stat raw output for %s', async (_label, stdout) => {
    expect((await terminalOutput('git diff --stat', stdout)).text).toContain(stdout);
  });
});

describe('git log facts', () => {
  it('does not interpret an indented commit message as another commit header', async () => {
    const stdout =
      'commit 1234567890abcdef1234567890abcdef12345678\nAuthor: Actual Author <fixture@example.invalid>\nDate: Mon Sep 21 12:00:00 2026 +0000\n\n    Actual subject\n\n    commit abcdef1234567890abcdef1234567890abcdef12\n    Author: quoted text only';
    const result = await terminalOutput('git log', stdout);
    expect(result.text).toContain('Actual Author: Actual subject');
    expect(result.text).not.toContain('abcdef1');
    // 首行是摘要标记，其后只有一条提交。
    const lines = result.text.split('\n');
    expect(lines[0]).toBe(`[summarized by git-log; raw ${stdout.length} chars]`);
    expect(lines).toHaveLength(2);
  });

  it('announces omitted entries after the twenty-commit display cap', async () => {
    const stdout = Array.from(
      { length: 21 },
      (_, index) => `${(index + 1).toString(16).padStart(7, '0')} Subject-${index + 1}`
    ).join('\n');
    const result = await terminalOutput('git log --oneline', stdout);
    expect(result.text).toContain('Subject-20');
    expect(result.text).not.toContain('Subject-21');
    expect(result.text).toContain('1 commit omitted');
  });

  it('preserves an incomplete full-format commit instead of inventing a usable entry', async () => {
    const stdout = 'commit 1234567890abcdef1234567890abcdef12345678\nAuthor: Partial Author';
    expect((await terminalOutput('git log', stdout)).text).toContain(stdout);
  });
});

/** 公共出口、首次装配及旧回归按行为归位，不复制到运行调度测试。 */
describe('public compression entrypoints and initialization', () => {
  it('awaits parser initialization for all concurrent first compressions', async () => {
    vi.resetModules();
    const { OutputCompressor: FreshCompressor } = await import(
      '../src/tools/runtime/compressor/OutputCompressor.js'
    );
    const compressor = new FreshCompressor();
    const outputs = await Promise.all([
      compressor.compress('?? fresh.ts', { command: 'git status' }),
      compressor.compress('?? fresh.ts', { command: 'git status' }),
    ]);
    const expected = summarized('git-status', '?? fresh.ts', 'untracked(1): fresh.ts');
    expect(outputs).toEqual([expected, expected]);
  });
  it.each([
    'UU',
    'AA',
    'DD',
    'AU',
    'UA',
    'DU',
    'UD',
  ])('preserves git conflict status %s', (status) => {
    expect(parseGitStatusOutput(`${status} conflict.ts`)).toBe('conflicted(1): conflict.ts');
  });

  it.each([
    ['1 failed, 2 passed', 'FAILED test_a.py::test_x - assert 1 == 2'],
    ['2 passed, 1 failed', 'FAILED test_a.py::test_x - assert 1 == 2'],
    ['1 error, 2 passed', 'ERROR test_a.py::test_x - RuntimeError: setup failed'],
  ])('preserves pytest failures in %s', async (summary, failureLine) => {
    const output = `===== test session starts =====\ncollected 3 items\n===== short test summary info =====\n${failureLine}\n===== ${summary} in 0.1s =====`;
    const compressed = await new OutputCompressor().compress(output, { command: 'pytest' });
    expect(compressed).toContain('2 passed, 1 failed, 3 total');
    expect(compressed).toContain('test_a.py::test_x');
  });
  it('exports output compressor and parser utilities', async () => {
    const gitStatus = [
      'On branch main',
      'Changes not staged for commit:',
      '  modified:   src/index.ts',
      '',
    ].join('\n');
    const parsed = parseGitStatusOutput(gitStatus);
    const compressed = await new OutputCompressor().compress(gitStatus, {
      command: 'git status',
      tokenBudget: 200,
    });

    expect(parsed).toContain('modified');
    expect(compressed).toContain('modified');
  });
});

/**
 * 压缩策略（I07）：预算内不改写事实。git-diff 预算内保留补丁原文；generic 路径预算内只去 ANSI，
 * 超预算才折叠重复行；所有专用解析器摘要首行带 '[summarized by <parser>; raw <N> chars]'。
 */
describe('compression policy within and over budget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 约 290 字符的真实单文件补丁：宿主默认 8000 token 预算下必须原样可见。
  const SMALL_PATCH = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' export function total(items: number[]): number {',
    '-  return items.length;',
    '+  // sum the values instead of counting them',
    '+  return items.reduce((sum, item) => sum + item, 0);',
    ' }',
  ].join('\n');

  it('keeps a small git diff patch verbatim under the host budget', async () => {
    expect(SMALL_PATCH.length).toBeGreaterThan(250);
    // 解析器本身能摘要这段补丁；预算内保留原文是压缩策略的选择，不是解析失败的回退。
    expect(parseGitDiffOutput(SMALL_PATCH)).toBe('1 files changed, +2/-1 lines\n\nsrc/a.ts: +2/-1');
    expect((await terminalOutput('git diff src/a.ts', SMALL_PATCH, '', 8000)).text).toBe(
      SMALL_PATCH
    );
  });

  it('records a debug note when git diff keeps the raw patch within budget', async () => {
    const debug = vi
      .spyOn(Logger.getInstance(), 'debug')
      .mockImplementation(() => Logger.getInstance());
    const output = await new OutputCompressor().compress(SMALL_PATCH, {
      command: 'git diff src/a.ts',
      tokenBudget: 8000,
    });
    expect(output).toBe(SMALL_PATCH);
    expect(debug.mock.calls.map(([message]) => String(message))).toContain(
      `[OutputCompressor] parser=git-diff; raw-kept=within-budget; chars=${SMALL_PATCH.length}; budget=32000`
    );
  });

  it('marks an over-budget git diff summary with the parser name and raw size', async () => {
    const bigPatch = [
      'diff --git a/src/big.ts b/src/big.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/big.ts',
      '@@ -0,0 +1,400 @@',
      ...Array.from({ length: 400 }, (_, index) => `+export const value${index} = ${index};`),
    ].join('\n');
    expect(bigPatch.length).toBeGreaterThan(4000);
    const text = (await terminalOutput('git diff', bigPatch, '', 1000)).text;
    expect(text.split('\n')[0]).toBe(`[summarized by git-diff; raw ${bigPatch.length} chars]`);
    expect(text).toBe(
      summarized('git-diff', bigPatch, '1 files changed, +400/-0 lines\n\nsrc/big.ts: +400/-0')
    );
  });

  it('puts the summary marker before the summary and keeps stderr after it', async () => {
    const output = await new OutputCompressor().compress(
      '?? fresh.ts\n\n[stderr]\nwarning: fixture',
      { command: 'git status' }
    );
    expect(output).toBe(
      '[summarized by git-status; raw 11 chars]\nuntracked(1): fresh.ts\n\n[stderr]\nwarning: fixture'
    );
  });

  it.each([
    ['blank-line runs', 'a\n\n\n\n\nb'],
    ['repeated closing braces', 'x\n  }\n  }\n  }\n  }\ny'],
  ])('leaves %s untouched when generic output fits the budget', async (_label, stdout) => {
    expect((await terminalOutput('cat notes.txt', stdout)).text).toBe(stdout);
  });

  it('still collapses repeated lines once generic output exceeds the budget', async () => {
    const stdout = `${'tick\n'.repeat(400)}done`;
    expect((await terminalOutput('cat build.log', stdout, '', 40)).text).toBe(
      'tick\n  (repeated 399 times)\ndone'
    );
  });
});

/**
 * 回退可观测（I12，压缩器部分）：解析器内部异常归类为 parser-error 并带错误类名；空输出跳过解析器且
 * 不记回退；格式不认识和复合命令属于预期路径记 info；warn 只留给 parser-error 与加载失败。
 */
describe('compressor fallback diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const DEFECT_SENTINEL = 'fixture-parser-defect';

  /**
   * 模拟解析器内部缺陷：所有解析器入口第一步都对原文调用 trim()，让含哨兵串的第一次 trim 抛 TypeError。
   * 只抛一次，后续 generic 路径照常运行；不含哨兵的字符串不受影响。
   */
  function armParserDefect(): void {
    const originalTrim = String.prototype.trim;
    let armed = true;
    vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string): string {
      if (armed && String(this).includes(DEFECT_SENTINEL)) {
        armed = false;
        throw new TypeError('fixture parser defect');
      }
      return originalTrim.call(this);
    });
  }

  function spyLogs() {
    const silence = () => Logger.getInstance();
    return {
      warn: vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(silence),
      info: vi.spyOn(Logger.getInstance(), 'info').mockImplementation(silence),
      debug: vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(silence),
    };
  }

  const messagesOf = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map(([message]) => String(message));

  it.each([
    ['git status', 'git-status'],
    ['git diff', 'git-diff'],
    ['git log', 'git-log'],
    ['vitest run', 'test-output'],
    ['eslint .', 'lint-output'],
    ['rg needle', 'grep'],
    ['find .', 'tree'],
    ['npm install', 'package'],
  ])('reports an internal %s parser defect as parser-error', async (command, parser) => {
    const compressor = new OutputCompressor();
    // 先完成解析器加载，确保哨兵只在解析器内部被 trim。
    await compressor.compress('warm-up', { command: 'git status' });
    const logs = spyLogs();
    armParserDefect();
    // 5 token（20 字符）预算让 git-diff 也越过“预算内保留原文”而真正调用解析器。
    const output = await compressor.compress(`${DEFECT_SENTINEL}/a.ts\nsecond line`, {
      command,
      tokenBudget: 5,
    });
    expect(output.length).toBeLessThanOrEqual(20);
    expect(messagesOf(logs.warn)).toContain(
      `[OutputCompressor] parser=${parser}; fallback=generic; reason=parser-error; error=TypeError`
    );
    const all = [...messagesOf(logs.warn), ...messagesOf(logs.info)].join('\n');
    expect(all).not.toContain('unrecognized-output');
    // 诊断只带解析器名与错误类名，不带输出原文或异常消息。
    expect(all).not.toContain(DEFECT_SENTINEL);
    expect(all).not.toContain('fixture parser defect');
  });

  it('keeps the public parse contract of never throwing on an internal defect', () => {
    armParserDefect();
    expect(parseGitStatusOutput(`${DEFECT_SENTINEL}.ts`)).toBeNull();
  });

  it.each([
    ['git status', '[no output]'],
    ['git diff', '[no output]'],
    ['git status', '[stderr]\nfatal: not a git repository'],
    ['rg needle', '[stderr]\nrg: missing.ts: No such file or directory'],
  ])('skips the %s parser for empty stdout without a fallback diagnostic', async (command, raw) => {
    const compressor = new OutputCompressor();
    await compressor.compress('warm-up', { command: 'git status' });
    const logs = spyLogs();
    expect(await compressor.compress(raw, { command })).toBe(raw);
    expect([...messagesOf(logs.warn), ...messagesOf(logs.info)].join('\n')).not.toContain(
      'fallback=generic'
    );
    expect(messagesOf(logs.debug).join('\n')).toContain('parser-skipped=empty-stdout');
  });

  it('logs unrecognized output at info level and keeps warn for real faults', async () => {
    const compressor = new OutputCompressor();
    await compressor.compress('warm-up', { command: 'git status' });
    const logs = spyLogs();
    const stdout = 'On branch main\nnothing to commit, working tree clean';
    expect(await compressor.compress(stdout, { command: 'git status' })).toBe(stdout);
    expect(messagesOf(logs.info)).toContain(
      '[OutputCompressor] parser=git-status; fallback=generic; reason=unrecognized-output'
    );
    expect(messagesOf(logs.warn)).toEqual([]);
  });

  it('logs a compound-command fallback at info level', async () => {
    const compressor = new OutputCompressor();
    await compressor.compress('warm-up', { command: 'git status' });
    const logs = spyLogs();
    expect(await compressor.compress('?? a.ts', { command: 'git status | cat' })).toBe('?? a.ts');
    expect(messagesOf(logs.info)).toContain(
      '[OutputCompressor] parser=git-status; fallback=generic; reason=compound-command'
    );
    expect(messagesOf(logs.warn)).toEqual([]);
  });

  it('records parsers-not-loaded when compressSync runs before loading and recovers after it', async () => {
    vi.resetModules();
    const { OutputCompressor: FreshCompressor } = await import(
      '../src/tools/runtime/compressor/OutputCompressor.js'
    );
    // 重置模块后压缩器拿到的是新的日志模块实例，必须在同一注册表里取 Logger 再打桩。
    const { default: FreshLogger } = await import('@alembic/core/logging');
    const warn = vi
      .spyOn(FreshLogger.getInstance(), 'warn')
      .mockImplementation(() => FreshLogger.getInstance());
    const compressor = new FreshCompressor();
    // 加载前：本次只能走 generic，原文保留，并记一条 parsers-not-loaded。
    expect(compressor.compressSync('?? fresh.ts', { command: 'git status' })).toBe('?? fresh.ts');
    // 不会命中专用解析器的命令不算错过，不记诊断。
    expect(compressor.compressSync('plain text', { command: 'cat notes.txt' })).toBe('plain text');
    const notLoaded = () =>
      warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('parsers-not-loaded'));
    expect(notLoaded()).toEqual([
      '[OutputCompressor] parser=git-status; fallback=generic; reason=parsers-not-loaded',
    ]);
    // 同步入口已顺带启动加载；等同一个加载 Promise 完成后，同步调用恢复专用解析且不再记诊断。
    await compressor.compress('plain text', { command: 'cat notes.txt' });
    expect(compressor.compressSync('?? fresh.ts', { command: 'git status' })).toBe(
      summarized('git-status', '?? fresh.ts', 'untracked(1): fresh.ts')
    );
    expect(notLoaded()).toHaveLength(1);
  });
});
