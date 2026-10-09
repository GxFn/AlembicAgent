import path from 'node:path';

export const DENIED_BINS = new Set([
  'sudo',
  'su',
  'shutdown',
  'reboot',
  'halt',
  'mkfs',
  'dd',
  'passwd',
  'killall',
]);

export interface TerminalSafetyBlock {
  rule: string;
  reason: string;
}

const READONLY_GIT_SUBCOMMANDS = new Set([
  'log',
  'blame',
  'diff',
  'status',
  'show',
  'rev-parse',
  'ls-files',
]);

const READONLY_PACKAGE_SCRIPTS = new Set(['test', 'lint', 'build:check', 'typecheck']);
const READONLY_BIOME_COMMANDS = new Set(['check', 'ci']);
// 只读 allowlist 的写类参数黑名单。比较前先小写，并按 writeLikeOptionName 取选项名：
// 带 '=' 的写法取 '=' 之前的部分（--output=x、--generatetrace=x 都命中同一条目）；
// cac（vitest）/ yargs（jest）的点号写法再取 '.' 之前的部分，所以 --outputFile.json=x、
// --outputFile.json x 与 --outputFile=x 一样命中 '--outputfile'，不会因为子键写法绕过。
// 这里只放不会与其它只读 bin 的同名只读参数冲突的条目；会冲突的短参数放在 BIN_WRITE_LIKE_ARGS。
const WRITE_LIKE_ARGS = new Set([
  '--fix',
  '--write',
  '-i',
  '--in-place',
  '-u',
  '--update',
  '--updatesnapshot',
  '--update-snapshot',
  // find：-delete/-exec*/-ok* 执行或删除，-fprint*/-fls 把结果写进文件。
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
  '--pre',
  '--output',
  '--ext-diff',
  '--textconv',
  // eslint：-o/--output-file 写报告，--cache* 写 .eslintcache，--init 生成配置并安装依赖。
  '--output-file',
  '--cache',
  '--cache-location',
  '--cache-file',
  '--init',
  // jest/vitest：--outputFile（含 vitest 多 reporter 的 --outputFile.<reporter>=path 点号写法）写结果，
  // --cacheDirectory 写缓存目录，--clearCache 删除缓存。
  '--outputfile',
  '--cachedirectory',
  '--clearcache',
  // tsc：--init 写 tsconfig，-b/--build 与 --incremental/--tsBuildInfoFile 即使带 --noEmit 也写 tsbuildinfo，
  // --generateTrace/--generateCpuProfile 写诊断文件。
  '--build',
  '--incremental',
  '--tsbuildinfofile',
  '--generatetrace',
  '--generatecpuprofile',
  // biome 1.x：--apply/--apply-unsafe 等价于写回修复。
  '--apply',
  '--apply-unsafe',
]);
// 按选项名前缀匹配的写类参数族：jest 的 --coverage、--coverageDirectory、--coverageReporters 等
// 都会把覆盖率报告写进项目目录；--coverage=false 之类的显式关闭写法也一并拒绝（默认即不开覆盖率）。
// vitest 的 --coverage.enabled 等点号写法经 writeLikeOptionName 归一为 '--coverage' 后同样命中。
const WRITE_LIKE_ARG_PREFIXES = ['--coverage'];
// 只对特定 bin 生效的写类短参数：eslint -o 是输出文件，tsc -b 是 build 模式。
// rg/grep -o（only-matching）与 jest -o/-b（onlyChanged/bail）是只读参数，不能被共享黑名单误伤。
const BIN_WRITE_LIKE_ARGS = new Map<string, ReadonlySet<string>>([
  ['eslint', new Set(['-o'])],
  ['tsc', new Set(['-b'])],
]);
// node 在只读 allowlist 中只允许 test runner 模式，并且选项采用白名单：
// - 标志选项：--test、--test-only
// - 需要值的只读选项：--test-name-pattern / --test-skip-pattern（进程内正则）、
//   --test-concurrency / --test-timeout（数字）、--test-reporter（仅内置 reporter 名）
// 其余 node 选项一律拒绝；其中 eval/print 与预加载类单独归类，便于诊断定位。
const NODE_TEST_FLAG_OPTIONS = new Set(['--test', '--test-only']);
const NODE_TEST_VALUE_OPTIONS = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-concurrency',
  '--test-timeout',
  '--test-reporter',
]);
// 自定义 reporter 是模块路径或包名，node 会加载并执行它；只放行 Node 内置 reporter 名。
const NODE_TEST_BUILTIN_REPORTERS = new Set(['tap', 'spec', 'dot', 'junit', 'lcov']);
const NODE_EVAL_OPTIONS = new Set(['-e', '-p', '--eval', '--print']);
// 预加载/导入类选项会在任何测试文件之前执行模型自写（data: URL）或仓库内的任意模块。
const NODE_PRELOAD_OPTIONS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--env-file-if-exists',
]);

export function detectDangerousShellPayload(payload: string): TerminalSafetyBlock | null {
  const checks: Array<{ rule: string; reason: string; pattern: RegExp }> = [
    {
      rule: 'shell-privilege-escalation',
      reason: 'Privilege escalation commands are blocked in terminal.exec',
      pattern: /(^|[\s;&|()])["']?(sudo|su)["']?(?=$|[\s;&|()])/im,
    },
    {
      rule: 'shell-destructive-bin',
      reason: 'Destructive system executables are blocked in terminal.exec',
      pattern:
        /(^|[\s;&|()])["']?(dd|mkfs|shutdown|reboot|halt|passwd|killall)["']?(?=$|[\s;&|().])/im,
    },
    {
      rule: 'shell-rm-recursive-force',
      reason: 'Recursive force remove is blocked in terminal.exec',
      pattern:
        /\brm\s+["']?-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*["']?\b|\brm\s+["']?-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*["']?\b/im,
    },
    {
      rule: 'shell-remote-shell-pipe',
      reason: 'Piping remote content into a shell is blocked in terminal.exec',
      pattern: /\b(curl|wget)\b[^\n|]*\|\s*["']?(sh|bash|zsh|fish)["']?\b/im,
    },
    {
      rule: 'shell-eval',
      reason: 'eval is blocked in terminal.exec',
      pattern: /(^|\s)eval\s+/im,
    },
    {
      rule: 'shell-fork-bomb',
      reason: 'Fork-bomb-like shell function syntax is blocked in terminal.exec',
      pattern: /:\s*\(\s*\)\s*\{/m,
    },
  ];

  for (const check of checks) {
    if (check.pattern.test(payload)) {
      return { rule: check.rule, reason: check.reason };
    }
  }
  return null;
}

export function checkTerminalCommandSafety(
  command: string
): { safe: true } | { safe: false; block: TerminalSafetyBlock } {
  return inspectLiteralShellCommand(command, 0);
}

function inspectLiteralShellCommand(
  command: string,
  depth: number
): { safe: true } | { safe: false; block: TerminalSafetyBlock } {
  const dangerousPayload = detectDangerousShellPayload(command);
  if (dangerousPayload) {
    return { safe: false, block: dangerousPayload };
  }

  const parsed = parseSimpleShellWords(command, true);
  if (!parsed.ok) {
    return readonlyBlock('shell-unparseable-command', parsed.error);
  }
  // 这里只检查静态 literal 形态，不求值变量/别名/脚本。实际隔离仍由宿主 sandbox 提供。
  // 仅命令位置及已知 wrapper 链有执行身份；cat ./docs/sudo 等普通参数不是可执行文件。
  for (const tokens of parsed.commands) {
    const words: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].redirection) {
        // 重定向不开始新命令，其目标也不是 rm 参数；引号内的 > 仍是普通 literal。
        index++;
      } else {
        words.push(tokens[index].value);
      }
    }
    const commandWords = unwrapLiteralCommand(words);
    if (commandWords.length > 0) {
      const bin = path.basename(commandWords[0]).toLowerCase();
      if (DENIED_BINS.has(bin)) {
        return readonlyBlock('shell-denied-bin', `Blocked executable in terminal.exec: ${bin}`);
      }
      const isShell = ['sh', 'bash', 'zsh', 'fish'].includes(bin);
      if (bin !== 'rm' && !isShell) {
        continue;
      }
      const args = commandWords.slice(1);
      if (bin === 'rm' && hasRecursiveForceFlags(args)) {
        return readonlyBlock(
          'shell-rm-recursive-force',
          'Recursive force remove is blocked in terminal.exec'
        );
      }
      if (isShell) {
        const commandFlag = args.findIndex(
          (arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg) || arg === '--command'
        );
        const payload = commandFlag < 0 ? undefined : args[commandFlag + 1];
        if (payload !== undefined) {
          // 已知 -c literal 可以复用同一词法器；有界递归避免深嵌套耗尽调用栈。
          if (depth >= 8) {
            return readonlyBlock(
              'shell-nesting-limit',
              'Nested shell command exceeds the safety inspection limit'
            );
          }
          const nested = inspectLiteralShellCommand(payload, depth + 1);
          if (!nested.safe) {
            return nested;
          }
        }
      }
    }
  }
  return { safe: true };
}

/** 只解开明确的执行 wrapper；未知程序的参数仍由程序解释，不能擅当 shell 命令。 */
function unwrapLiteralCommand(input: string[]): string[] {
  let words = input;
  let index = 0;
  while (index < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
      index++;
      continue;
    }
    const bin = path.basename(words[index]).toLowerCase();
    if (!['env', 'command', 'exec', 'nohup'].includes(bin)) {
      break;
    }
    index++;
    while (index < words.length && words[index].startsWith('-')) {
      const option = words[index++];
      if (option === '--') {
        break;
      }
      // command -v/-V 与帮助查询不执行目标；例如 sudo 的路径在这里只是查询参数。
      if (
        option === '--help' ||
        option === '--version' ||
        (bin === 'command' && /^-[p]*[vV]/.test(option))
      ) {
        return [];
      }
      if (
        bin === 'env' &&
        (option === '-S' || option === '--split-string' || option.startsWith('--split-string='))
      ) {
        const value = option.startsWith('--split-string=')
          ? option.slice('--split-string='.length)
          : words[index++];
        const parsed = parseSimpleShellWords(value ?? '');
        if (!parsed.ok) {
          return [];
        }
        words = [...parsed.words, ...words.slice(index)];
        index = 0;
        break;
      }
      if (
        (bin === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(option)) ||
        (bin === 'exec' && option === '-a')
      ) {
        index++;
      }
    }
  }
  return words.slice(index);
}

function hasRecursiveForceFlags(args: string[]): boolean {
  let recursive = false;
  let force = false;
  for (const arg of args) {
    if (arg === '--') {
      break;
    }
    recursive ||= arg === '--recursive' || (/^-[^-]/.test(arg) && /[rR]/.test(arg.slice(1)));
    force ||= arg === '--force' || (/^-[^-]/.test(arg) && arg.slice(1).includes('f'));
  }
  return recursive && force;
}

export function checkTerminalCommandAllowlist(
  command: string,
  bins: readonly string[]
): { safe: true } | { safe: false; block: TerminalSafetyBlock } {
  if (containsShellMeta(command)) {
    return {
      safe: false,
      block: {
        rule: 'allowlist-shell-meta',
        reason: 'Shell meta characters are blocked for read-only terminal.exec allowlists',
      },
    };
  }

  const words = parseSimpleShellWords(command);
  if (!words.ok) {
    return {
      safe: false,
      block: {
        rule: 'allowlist-unparseable-command',
        reason: words.error,
      },
    };
  }

  const [rawBin, ...args] = words.words;
  if (rawBin !== undefined && /[\\/]/.test(rawBin)) {
    // 只允许裸命令名经 PATH 解析。被分析仓库自带的 scripts/git、bin/cat 之类同名脚本
    // （或先前被写入的文件）会顶替系统命令，绕过 git/node 等子命令的只读约束；
    // node_modules/.bin/<tool> 也一并拒绝，等价入口是 npm run <script> 或裸 <tool>。
    return {
      safe: false,
      block: {
        rule: 'allowlist-path-qualified-bin',
        reason: `Path-qualified executable is blocked for read-only terminal allowlists: ${rawBin}`,
      },
    };
  }
  const bin = (rawBin ?? '').toLowerCase();
  const allowedBins = new Set(bins.map((item) => item.toLowerCase()));
  if (!bin || !allowedBins.has(bin)) {
    return {
      safe: false,
      block: {
        rule: 'allowlist-denied-bin',
        reason: `Command "${bin || '[empty]'}" is not in the read-only terminal allowlist`,
      },
    };
  }

  const writeLikeArg = findWriteLikeArg(bin, args);
  if (writeLikeArg) {
    // 原因里带上归一后的选项名：点号/内联值写法（--outputFile.json=x）与条目（--outputfile）
    // 字面不同，审计日志要能看出是哪条黑名单规则把它折叠过去的。
    const matched =
      writeLikeArg.option === writeLikeArg.arg.toLowerCase()
        ? ''
        : ` (matched option ${writeLikeArg.option})`;
    return {
      safe: false,
      block: {
        rule: 'allowlist-write-like-arg',
        reason: `Write-like terminal argument is blocked: ${writeLikeArg.arg}${matched}`,
      },
    };
  }

  return checkReadonlySubcommand(bin, args);
}

export function containsShellMeta(value: string): boolean {
  // 换行可启动第二条命令；变量展开可拼出被禁止的选项，均不能当普通参数放行。
  return /[\r\n;&|<>`$]/.test(value);
}

function parseSimpleShellWords(
  command: string,
  splitCommands = false
):
  | { ok: true; words: string[]; commands: Array<Array<{ value: string; redirection?: true }>> }
  | { ok: false; error: string } {
  const input = command.trim();
  if (!input) {
    return { ok: true, words: [], commands: [] };
  }

  const words: string[] = [];
  const commands: Array<Array<{ value: string; redirection?: true }>> = [[]];
  let current = '';
  let hasWord = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const flushWord = () => {
    if (hasWord) {
      words.push(current);
      commands[commands.length - 1].push({ value: current });
      current = '';
      hasWord = false;
    }
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      if (char !== '\n') {
        current += char;
        hasWord = true;
      }
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (!quote && (char === '"' || char === "'")) {
      quote = char;
      hasWord = true;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      continue;
    }
    if (splitCommands && !quote && (/[<>]/.test(char) || (char === '&' && input[i + 1] === '>'))) {
      flushWord();
      let operator = char;
      while (i + 1 < input.length && /[<>&|]/.test(input[i + 1])) {
        operator += input[++i];
      }
      words.push(operator);
      commands[commands.length - 1].push({ value: operator, redirection: true });
      continue;
    }
    if (splitCommands && !quote && /[\r\n;&|()]/.test(char)) {
      flushWord();
      words.push(char);
      commands.push([]);
      continue;
    }
    if (!quote && /\s/.test(char)) {
      flushWord();
      continue;
    }
    current += char;
    hasWord = true;
  }

  if (escaped || quote) {
    return { ok: false, error: 'Unable to parse terminal command literals' };
  }
  flushWord();
  return { ok: true, words, commands };
}

/**
 * 返回第一个写类参数；匹配结果同时带回归一后的选项名，便于在拒绝原因里看出
 * '=' 内联值与 '.' 点号子键是如何被折叠到黑名单条目上的。
 */
function findWriteLikeArg(bin: string, args: string[]): { arg: string; option: string } | null {
  const binSpecific = BIN_WRITE_LIKE_ARGS.get(bin);
  for (const arg of args) {
    const normalized = arg.toLowerCase();
    if (!normalized.startsWith('-')) {
      // 黑名单条目都是选项；操作数（路径、模式）由各 bin 自己解释，不在这里判定。
      continue;
    }
    const option = writeLikeOptionName(normalized);
    if (WRITE_LIKE_ARGS.has(option) || binSpecific?.has(option)) {
      return { arg, option };
    }
    if (WRITE_LIKE_ARG_PREFIXES.some((prefix) => option.startsWith(prefix))) {
      return { arg, option };
    }
  }
  return null;
}

/**
 * 从已小写的参数里取选项名：先去掉 '=' 之后的内联值，再去掉 '.' 之后的点号子键。
 * cac（vitest 4 实测 --outputFile.tap=./tap.txt）与 yargs（jest）都把 --opt.key 解析成 --opt 的子字段，
 * 对写类选项来说目标文件/目录仍由同一个选项决定，所以按首段判定；--sequence.shuffle、--typecheck.only
 * 这类只读选项的首段不在黑名单里，不会被误伤。先切 '=' 再切 '.'，避免把值里的路径点号当成子键。
 */
function writeLikeOptionName(normalized: string): string {
  const equalsIndex = normalized.indexOf('=');
  const withoutValue = equalsIndex < 0 ? normalized : normalized.slice(0, equalsIndex);
  const dotIndex = withoutValue.indexOf('.');
  return dotIndex < 0 ? withoutValue : withoutValue.slice(0, dotIndex);
}

function checkReadonlySubcommand(
  bin: string,
  args: string[]
): { safe: true } | { safe: false; block: TerminalSafetyBlock } {
  switch (bin) {
    case 'git':
      return checkGitSubcommand(args);
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return checkPackageManagerSubcommand(bin, args);
    case 'tsc':
      return hasEffectiveNoEmit(args)
        ? { safe: true }
        : readonlyBlock('allowlist-tsc-noemit', 'tsc must include --noEmit');
    case 'node':
      return checkNodeSubcommand(args);
    case 'biome':
      return checkBiomeSubcommand(args);
    case 'vitest':
      return args.length === 0 || args.includes('run') || args.includes('--run')
        ? { safe: true }
        : readonlyBlock('allowlist-vitest-run', 'vitest must use run mode');
    default:
      return { safe: true };
  }
}

function hasEffectiveNoEmit(args: string[]): boolean {
  let noEmit = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--noEmit') {
      noEmit = args[index + 1] !== 'false';
      if (args[index + 1] === 'true' || args[index + 1] === 'false') {
        index++;
      }
    } else if (args[index].startsWith('--noEmit=')) {
      return false;
    }
  }
  return noEmit;
}

function checkGitSubcommand(args: string[]) {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand && READONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return { safe: true } as const;
  }
  return readonlyBlock(
    'allowlist-git-subcommand',
    `git ${subcommand ?? '[missing]'} is not a read-only evidence subcommand`
  );
}

function checkPackageManagerSubcommand(bin: string, args: string[]) {
  const first = args[0]?.toLowerCase();
  if (first === 'test') {
    return { safe: true } as const;
  }
  if (first !== 'run') {
    return readonlyBlock(
      'allowlist-package-manager-subcommand',
      `${bin} ${first ?? '[missing]'} is not a read-only test/lint/build command`
    );
  }

  const script = args[1]?.toLowerCase();
  if (
    script &&
    (READONLY_PACKAGE_SCRIPTS.has(script) ||
      script.startsWith('test:') ||
      (script.startsWith('lint:') && !script.includes('fix')))
  ) {
    return { safe: true } as const;
  }
  return readonlyBlock(
    'allowlist-package-manager-script',
    `${bin} run ${script ?? '[missing]'} is not an allowed read-only script`
  );
}

function checkNodeSubcommand(args: string[]) {
  // Node 24 实测：进入 --test 模式后，出现在测试路径之后、甚至 '--' 之后的 node 选项（如 --require）
  // 仍然生效，所以白名单必须覆盖 argv 里每一个以 '-' 开头的 token，而不只是前导选项段。
  // 反过来，--test 本身必须出现在第一个位置参数之前：否则 node 把该位置参数当脚本直接执行，
  // --test 只是脚本收到的 argv（'node scripts/x.mjs --test'）。
  let sawTest = false;
  let sawPositional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      sawPositional = true;
      continue;
    }
    if (arg === '--') {
      // '--' 结束 node 自身的选项解析，其后的 --test 会被当成脚本路径。
      sawPositional = true;
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    const inlineValue = equalsIndex < 0 ? undefined : arg.slice(equalsIndex + 1);
    // Node 接受下划线与连字符互换的拼写（--test_only 等价于 --test-only），归一后再比对白名单。
    // 大小写归一只影响本检查的分类；node 自身对 --TEST 这类拼写会直接报 bad option，不会放大能力。
    const option = (equalsIndex < 0 ? arg : arg.slice(0, equalsIndex))
      .toLowerCase()
      .replace(/_/g, '-');
    if (NODE_EVAL_OPTIONS.has(option)) {
      return readonlyBlock('allowlist-node-eval', 'node eval/print modes are blocked');
    }
    if (NODE_PRELOAD_OPTIONS.has(option)) {
      return readonlyBlock(
        'allowlist-node-preload',
        `node preload/import option is blocked in read-only mode: ${option}`
      );
    }
    if (NODE_TEST_FLAG_OPTIONS.has(option)) {
      if (inlineValue !== undefined) {
        return readonlyBlock(
          'allowlist-node-option',
          `node option ${option} does not take a value`
        );
      }
      if (option === '--test') {
        if (sawPositional) {
          return readonlyBlock(
            'allowlist-node-test',
            'node --test must precede the first script or test path'
          );
        }
        sawTest = true;
      }
      continue;
    }
    if (NODE_TEST_VALUE_OPTIONS.has(option)) {
      let value = inlineValue;
      if (value === undefined) {
        // 空格写法：值必须是紧随其后、且不以 '-' 开头的 token，避免把下一个选项当成值吞掉。
        const next = args[index + 1];
        if (next === undefined || next.startsWith('-')) {
          return readonlyBlock(
            'allowlist-node-option-value',
            `node option ${option} requires a value`
          );
        }
        value = next;
        index++;
      }
      const valueBlock = checkNodeTestOptionValue(option, value);
      if (valueBlock) {
        return valueBlock;
      }
      continue;
    }
    return readonlyBlock(
      'allowlist-node-option',
      `node option is not in the read-only --test allowlist: ${arg}`
    );
  }
  if (!sawTest) {
    return readonlyBlock('allowlist-node-test', 'node is only allowed with --test');
  }
  return { safe: true } as const;
}

/** 白名单内需要值的 node --test 选项，值本身也要是只读形态。 */
function checkNodeTestOptionValue(
  option: string,
  value: string
): { safe: false; block: TerminalSafetyBlock } | null {
  if (option === '--test-reporter') {
    // 非内置名会被 node 当成模块说明符加载执行；比较保持大小写敏感，与 node 的解析一致。
    return NODE_TEST_BUILTIN_REPORTERS.has(value)
      ? null
      : readonlyBlock(
          'allowlist-node-option-value',
          `node --test-reporter only accepts built-in reporters (${[
            ...NODE_TEST_BUILTIN_REPORTERS,
          ].join(', ')}): ${value}`
        );
  }
  if (option === '--test-concurrency' || option === '--test-timeout') {
    return /^\d+(?:\.\d+)?$/.test(value)
      ? null
      : readonlyBlock(
          'allowlist-node-option-value',
          `node option ${option} requires a non-negative number: ${value}`
        );
  }
  // --test-name-pattern / --test-skip-pattern 是进程内正则，只影响选测，不涉及写文件或加载模块。
  return value.length > 0
    ? null
    : readonlyBlock(
        'allowlist-node-option-value',
        `node option ${option} requires a non-empty value`
      );
}

function checkBiomeSubcommand(args: string[]) {
  const command = args.find((arg) => !arg.startsWith('-'))?.toLowerCase();
  if (command && READONLY_BIOME_COMMANDS.has(command)) {
    return { safe: true } as const;
  }
  return readonlyBlock(
    'allowlist-biome-command',
    `biome ${command ?? '[missing]'} is not an allowed read-only command`
  );
}

function readonlyBlock(rule: string, reason: string): { safe: false; block: TerminalSafetyBlock } {
  return { safe: false, block: { rule, reason } };
}
