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
const WRITE_LIKE_ARGS = new Set([
  '--fix',
  '--write',
  '-i',
  '--in-place',
  '-u',
  '--update',
  '--updatesnapshot',
  '--update-snapshot',
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '--pre',
  '--output',
  '--ext-diff',
  '--textconv',
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
  const bin = path.basename(rawBin ?? '').toLowerCase();
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

  const writeLikeArg = findWriteLikeArg(args);
  if (writeLikeArg) {
    return {
      safe: false,
      block: {
        rule: 'allowlist-write-like-arg',
        reason: `Write-like terminal argument is blocked: ${writeLikeArg}`,
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

function findWriteLikeArg(args: string[]): string | null {
  for (const arg of args) {
    const normalized = arg.toLowerCase();
    if (WRITE_LIKE_ARGS.has(normalized)) {
      return arg;
    }
    if (
      normalized.startsWith('--output=') ||
      normalized.startsWith('--write=') ||
      normalized.startsWith('--pre=')
    ) {
      return arg;
    }
  }
  return null;
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
  if (args.some((arg) => /^(?:-e|-p|--eval|--print)(?:=|$)/u.test(arg.toLowerCase()))) {
    return readonlyBlock('allowlist-node-eval', 'node eval/print modes are blocked');
  }
  if (args.includes('--test')) {
    return { safe: true } as const;
  }
  return readonlyBlock('allowlist-node-test', 'node is only allowed with --test');
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
