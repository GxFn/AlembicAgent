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
