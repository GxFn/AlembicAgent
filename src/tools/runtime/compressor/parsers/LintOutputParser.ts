/**
 * @module tools/runtime/compressor/parsers/LintOutputParser
 * 解析 eslint/tsc 输出为紧凑结构化格式。
 *
 * Biome 的真实 pretty 输出把严重级别放在标题行之后的框线块里，且诊断写在 stderr；
 * 这里不再维护 Biome 专用解析，biome 命令由 OutputCompressor 交给 generic 路径保留原文。
 */

interface LintResult {
  errors: number;
  warnings: number;
  issues: LintIssue[];
}

interface LintIssue {
  file: string;
  line: string;
  message: string;
  severity: 'error' | 'warning';
}

const MAX_ISSUES = 10;

const ESLINT_SUMMARY_RE = /(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/;
const ESLINT_LINE_RE = /^\s*(.+?):(\d+):\d+\s+(error|warning)\s+(.+?)(?:\s{2,}|\t)(.+)$/;
/**
 * ESLint 默认 stylish 的问题行：缩进的 `行:列  级别  消息  规则`。
 * 列之间至少两个空格；解析错误等致命问题没有规则列，消息直接到行尾。
 */
const ESLINT_STYLISH_ISSUE_RE = /^\s+(\d+):\d+\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/;

const TSC_LINE_RE = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.+)$/;
const TSC_LINE_ALT_RE = /^(.+?):(\d+):\d+\s+-\s+error\s+(TS\d+):\s+(.+)$/;

function tryEslint(raw: string): LintResult | null {
  const summaryMatch = ESLINT_SUMMARY_RE.exec(raw);
  const issues: LintIssue[] = [];
  let errors = 0;
  let warnings = 0;

  // 展示只存十条，计数必须遍历完整输入。
  const record = (file: string, line: string, severity: 'error' | 'warning', message: string) => {
    if (severity === 'error') {
      errors++;
    } else {
      warnings++;
    }
    if (issues.length < MAX_ISSUES) {
      issues.push({ file, line, severity, message });
    }
  };

  // stylish 状态机：不缩进的非空行是文件头，其后缩进的问题行归属该文件；
  // 空行结束当前文件块，摘要行之后（如 --fix 提示、--max-warnings 提示）不再解析。
  let currentFile: string | null = null;
  let afterSummary = false;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      currentFile = null;
      continue;
    }
    if (afterSummary) {
      continue;
    }
    if (ESLINT_SUMMARY_RE.test(line)) {
      afterSummary = true;
      currentFile = null;
      continue;
    }

    const stylish = ESLINT_STYLISH_ISSUE_RE.exec(line);
    if (stylish) {
      // 没有文件头的问题行无法归属文件，说明不是可识别的 stylish 结构，整体交回原文。
      if (currentFile === null) {
        return null;
      }
      const severity = stylish[2] === 'error' ? 'error' : 'warning';
      const message = stylish[4] ? `${stylish[3]} (${stylish[4]})` : stylish[3];
      record(currentFile, stylish[1], severity, message);
      continue;
    }

    // 既有的单行 'file:line:col 级别 消息  规则' 形态继续支持；它自带文件名，不依赖文件头。
    const single = ESLINT_LINE_RE.exec(line);
    if (single) {
      record(
        single[1],
        single[2],
        single[3] === 'error' ? 'error' : 'warning',
        `${single[4]} (${single[5]})`
      );
      continue;
    }

    if (!/^\s/.test(line)) {
      currentFile = line.trim();
    }
  }

  if (summaryMatch) {
    const summaryErrors = parseInt(summaryMatch[2], 10);
    const summaryWarnings = parseInt(summaryMatch[3], 10);
    // 摘要命中却没有明细，或明细与摘要计数对不上：只给计数会让调用方以为信息完整，交回原文。
    if (errors + warnings === 0 || errors !== summaryErrors || warnings !== summaryWarnings) {
      return null;
    }
    return { errors: summaryErrors, warnings: summaryWarnings, issues };
  }

  if (issues.length > 0) {
    return {
      errors,
      warnings,
      issues,
    };
  }

  return null;
}

function tryTsc(raw: string): LintResult | null {
  const issues: LintIssue[] = [];

  for (const line of raw.split('\n')) {
    if (issues.length >= MAX_ISSUES) {
      break;
    }
    let m = TSC_LINE_RE.exec(line);
    if (!m) {
      m = TSC_LINE_ALT_RE.exec(line);
    }
    if (m) {
      issues.push({
        file: m[1],
        line: m[2],
        severity: 'error',
        message: `${m[3]}: ${m[4]}`,
      });
    }
  }

  if (issues.length === 0) {
    return null;
  }

  const errorCount = raw
    .split('\n')
    .filter((l) => TSC_LINE_RE.test(l) || TSC_LINE_ALT_RE.test(l)).length;

  return { errors: errorCount, warnings: 0, issues };
}

function formatResult(result: LintResult): string {
  const parts: string[] = [`${result.errors} errors, ${result.warnings} warnings`];

  if (result.issues.length > 0) {
    parts.push('');
    parts.push('Top issues:');
    for (const issue of result.issues.slice(0, MAX_ISSUES)) {
      parts.push(`  ${issue.file}:${issue.line}: ${issue.message}`);
    }
    const omitted = result.errors + result.warnings - result.issues.length;
    if (omitted > 0) {
      parts.push(`  ... ${omitted} more issues not shown`);
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

    const result = tryEslint(raw) ?? tryTsc(raw);
    if (!result) {
      return null;
    }

    return formatResult(result);
  } catch (err: unknown) {
    void err;
    return null;
  }
}
