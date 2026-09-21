/**
 * @module tools/runtime/compressor/parsers/PackageParser
 * 解析 npm/pnpm 的明确安装计数；未知格式与失败输出交回原文降级。
 */

interface PackageResult {
  added: number;
  removed: number;
  changed: number;
  warnings: string[];
  extra: string[];
}

const NPM_ADDED_RE = /added\s+(\d+)\s+packages?/;
const NPM_REMOVED_RE = /removed\s+(\d+)\s+packages?/;
const NPM_CHANGED_RE = /changed\s+(\d+)\s+packages?/;
const NPM_AUDIT_RE = /(\d+)\s+vulnerabilit(?:y|ies)/;

const PNPM_ADDED_RE = /Packages:\s+\+(\d+)/;
const PNPM_REMOVED_RE = /Packages:.*-(\d+)/;
const PNPM_PROGRESS_RE = /^Progress:.*,\s+done\s*$/m;

const WARN_RE = /(?:npm\s+)?(?:WARN|warn)\s+(.+)/;
const DEPRECATED_RE = /deprecated\s+(.+)/i;

function tryNpm(raw: string): PackageResult | null {
  const added = NPM_ADDED_RE.exec(raw);
  const removed = NPM_REMOVED_RE.exec(raw);
  const changed = NPM_CHANGED_RE.exec(raw);

  if (!added && !removed && !changed) {
    return null;
  }

  const warnings: string[] = [];
  for (const line of raw.split('\n')) {
    const warnMatch = WARN_RE.exec(line);
    if (warnMatch) {
      warnings.push(warnMatch[1].trim());
    }
  }

  const audit = NPM_AUDIT_RE.exec(raw);
  const extra: string[] = [];
  if (audit) {
    extra.push(`${audit[0]}`);
  }

  return {
    added: added ? parseInt(added[1], 10) : 0,
    removed: removed ? parseInt(removed[1], 10) : 0,
    changed: changed ? parseInt(changed[1], 10) : 0,
    warnings,
    extra,
  };
}

function tryPnpm(raw: string): PackageResult | null {
  const added = PNPM_ADDED_RE.exec(raw);
  const removed = PNPM_REMOVED_RE.exec(raw);

  if ((!added && !removed) || (!PNPM_PROGRESS_RE.test(raw) && !/^Done in\s/m.test(raw))) {
    return null;
  }

  const warnings: string[] = [];
  for (const line of raw.split('\n')) {
    const warnMatch = WARN_RE.exec(line);
    if (warnMatch) {
      warnings.push(warnMatch[1].trim());
    }
    const depMatch = DEPRECATED_RE.exec(line);
    if (!warnMatch && depMatch) {
      warnings.push(`deprecated: ${depMatch[1].trim()}`);
    }
  }

  return {
    added: added ? parseInt(added[1], 10) : 0,
    removed: removed ? parseInt(removed[1], 10) : 0,
    changed: 0,
    warnings,
    extra: [],
  };
}

function formatResult(result: PackageResult): string {
  const parts: string[] = [
    `added ${result.added} packages, removed ${result.removed}, ${result.warnings.length} warnings`,
  ];

  if (result.changed > 0) {
    parts[0] += `, changed ${result.changed}`;
  }

  if (result.extra.length > 0) {
    parts.push(result.extra.join(', '));
  }

  if (result.warnings.length > 0) {
    parts.push('');
    parts.push('Warnings:');
    for (const w of result.warnings.slice(0, 10)) {
      parts.push(`  ${w}`);
    }
    if (result.warnings.length > 10) {
      parts.push(`  ... ${result.warnings.length - 10} more warnings`);
    }
  }

  return parts.join('\n');
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    // 计数行可能出现在稍后失败的安装中；不能只摘出早期计数并吞掉失败事实。
    if (/^\s*(?:npm\s+(?:ERR!|error)(?:\s|$)|ERR_PNPM_|error\b)/im.test(raw)) {
      return null;
    }
    // Yarn 的 YN0000 是普通日志级别，Fetched 也不是新增安装数；缺乏明确计数时保留原文。
    const result = tryNpm(raw) ?? tryPnpm(raw);
    if (!result) {
      return null;
    }

    return formatResult(result);
  } catch (err: unknown) {
    void err;
    return null;
  }
}
