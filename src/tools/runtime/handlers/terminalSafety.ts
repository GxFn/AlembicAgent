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
  const dangerousPayload = detectDangerousShellPayload(command);
  if (dangerousPayload) {
    return { safe: false, block: dangerousPayload };
  }

  const firstExecutable = firstShellWord(command);
  const executableName = firstExecutable ? path.basename(firstExecutable).toLowerCase() : '';
  if (DENIED_BINS.has(executableName)) {
    return {
      safe: false,
      block: {
        rule: 'shell-denied-bin',
        reason: `Blocked executable in terminal.exec: ${executableName}`,
      },
    };
  }

  return { safe: true };
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
  return /[;&|<>`]|\$\(/.test(value);
}

function firstShellWord(command: string): string | null {
  const input = command.trim();
  if (!input) {
    return null;
  }

  let word = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (!quote && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      continue;
    }
    if (!quote && /[\s;&|<>()]/.test(char)) {
      break;
    }
    word += char;
  }

  return word || null;
}

function parseSimpleShellWords(
  command: string
): { ok: true; words: string[] } | { ok: false; error: string } {
  const input = command.trim();
  if (!input) {
    return { ok: true, words: [] };
  }

  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (!quote && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaped || quote) {
    return { ok: false, error: 'Unable to parse read-only terminal command' };
  }
  if (current) {
    words.push(current);
  }
  return { ok: true, words };
}

function findWriteLikeArg(args: string[]): string | null {
  for (const arg of args) {
    const normalized = arg.toLowerCase();
    if (WRITE_LIKE_ARGS.has(normalized)) {
      return arg;
    }
    if (normalized.startsWith('--output=') || normalized.startsWith('--write=')) {
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
      return args.some((arg) => arg === '--noEmit' || arg.startsWith('--noEmit='))
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
  if (args.some((arg) => ['-e', '--eval', '-p', '--print'].includes(arg.toLowerCase()))) {
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
