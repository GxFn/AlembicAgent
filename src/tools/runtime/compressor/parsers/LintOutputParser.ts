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
 * 第 3 组是级别列之后的全部文本（消息加可选规则列），规则由 renderStylishMessage 从消息最后一行拆出。
 */
const ESLINT_STYLISH_ISSUE_RE = /^\s+(\d+):\d+\s+(error|warning)\s+(.+)$/;
/**
 * stylish 的规则列跟在消息最后一行之后，列间至少两个空格；解析错误等致命问题没有规则列，消息直接到行尾。
 * 多行消息（如 @typescript-eslint/no-empty-object-type 用 '\n' 拼接的消息）的规则只出现在最后一条续行末尾。
 */
const STYLISH_RULE_COLUMN_RE = /^(.+?)\s{2,}(\S+)$/;
/**
 * stylish 文件头就是 ESLint 结果的 filePath：lintFiles 给出绝对路径，lintText 不带文件名时是 '<text>'。
 * 绝对路径覆盖 POSIX（'/...'）、Windows 盘符（'C:\...'、'C:/...'）与 UNC（'\\server\...'）。
 */
const STYLISH_FILE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)|^<text>$/;

const TSC_LINE_RE = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.+)$/;
const TSC_LINE_ALT_RE = /^(.+?):(\d+):\d+\s+-\s+error\s+(TS\d+):\s+(.+)$/;

/**
 * 把 stylish 问题行的消息文本渲染成单行：除最后一行外都是消息正文，规则列只从最后一行拆出；
 * 续行之间用空格连接，避免摘要里出现不缩进、看起来像文件头的行。
 */
function renderStylishMessage(messageLines: readonly string[]): string {
  const last = messageLines[messageLines.length - 1] ?? '';
  const ruleColumn = STYLISH_RULE_COLUMN_RE.exec(last);
  const body = [...messageLines.slice(0, -1), ruleColumn ? ruleColumn[1] : last].join(' ');
  return ruleColumn ? `${body} (${ruleColumn[2]})` : body;
}

/** 当前文件块里最近一条 stylish 问题：后续续行要并回它的消息并重新拆出规则列。 */
interface OpenStylishIssue {
  issue: LintIssue;
  messageLines: string[];
}

/**
 * 一条不缩进、又不是问题行的非空行该怎样处理。
 * stylish 文件头之后紧接表格第一行（中间没有空行），而多行消息（React Compiler 规则的说明段落、
 * typescript-eslint 的分条说明）的续行同样不缩进，有的落在空行之后，有的还紧挨下一条问题行；
 * 只凭“不缩进”认文件头，会把消息续行当成文件名、后续问题挂到假文件下，而计数照样对得上、校验拦不住。
 * - header：下一行是问题行，且本行是 ESLint 会打印的文件路径、末尾没有规则列（调用方还要求它处在块首）。
 * - continuation：下一行不是问题行（文件头不可能出现在这里），或本行带规则列且不是文件路径
 *   （紧挨下一条问题行的是消息最后一行，规则列就跟在它后面），属于上一条消息。
 * - ambiguous：紧挨问题行、却既不像文件路径也不带规则列（相对路径、无规则 id 的消息段落），
 *   或像文件路径却带规则列，无法确认归属，由调用方整体交回原文。
 */
type StylishLineKind = 'header' | 'continuation' | 'ambiguous';

function classifyStylishLine(line: string, nextLine: string | undefined): StylishLineKind {
  if (nextLine === undefined || !ESLINT_STYLISH_ISSUE_RE.test(nextLine)) {
    return 'continuation';
  }
  const candidate = line.trim();
  const looksLikePath = STYLISH_FILE_PATH_RE.test(candidate);
  const hasRuleColumn = STYLISH_RULE_COLUMN_RE.test(candidate);
  if (looksLikePath && !hasRuleColumn) {
    return 'header';
  }
  if (!looksLikePath && hasRuleColumn) {
    return 'continuation';
  }
  return 'ambiguous';
}

function tryEslint(raw: string): LintResult | null {
  const summaryMatch = ESLINT_SUMMARY_RE.exec(raw);
  const issues: LintIssue[] = [];
  let errors = 0;
  let warnings = 0;

  // 展示只存十条，计数必须遍历完整输入；超出十条的问题对象仍返回给调用方承接续行，只是不展示。
  const record = (
    file: string,
    line: string,
    severity: 'error' | 'warning',
    message: string
  ): LintIssue => {
    if (severity === 'error') {
      errors++;
    } else {
      warnings++;
    }
    const issue: LintIssue = { file, line, severity, message };
    if (issues.length < MAX_ISSUES) {
      issues.push(issue);
    }
    return issue;
  };

  // stylish 状态机：文件头只出现在块首（输入开头或空行之后），并且必须通过 classifyStylishLine 校验；
  // 其后缩进的问题行归属该文件。已有问题行之后，任何既不是问题行、也不是通过校验的文件头的非空行，
  // 都是上一条消息的续行——包括多行消息里空行之后的段落和 code frame（缩进的、以 '>' 开头的都算）。
  // 空行因此不再结束当前消息，只标记“下一行处在块首”。摘要行之后（--fix、--max-warnings 提示）不再解析。
  const lines = raw.split('\n');
  let currentFile: string | null = null;
  let openIssue: OpenStylishIssue | null = null;
  let atBlockStart = true;
  let afterSummary = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim().length === 0) {
      atBlockStart = true;
      continue;
    }
    if (afterSummary) {
      continue;
    }
    if (ESLINT_SUMMARY_RE.test(line)) {
      afterSummary = true;
      continue;
    }

    const blockStart = atBlockStart;
    atBlockStart = false;

    const stylish = ESLINT_STYLISH_ISSUE_RE.exec(line);
    if (stylish) {
      // 没有文件头的问题行无法归属文件，说明不是可识别的 stylish 结构，整体交回原文。
      // 空行之后没经过文件头就直接出现的问题行同样交回原文：stylish 表格内部只有多行消息里才有空行，
      // 这样的问题行属于哪张表无法确认。
      if (currentFile === null || blockStart) {
        return null;
      }
      const severity = stylish[2] === 'error' ? 'error' : 'warning';
      const messageLines = [stylish[3]];
      const issue = record(currentFile, stylish[1], severity, renderStylishMessage(messageLines));
      openIssue = { issue, messageLines };
      continue;
    }

    if (!/^\s/.test(line)) {
      const kind = classifyStylishLine(line, lines[index + 1]);
      if (kind === 'header' && blockStart) {
        currentFile = line.trim();
        openIssue = null;
        continue;
      }
      if (kind !== 'continuation') {
        // 紧挨问题行却认不出是文件头还是消息续行，或形似文件头却不在块首（stylish 文件头前总有空行）：
        // 猜错会让后续问题挂到错误的文件下而计数照样对得上，整体交回原文。
        return null;
      }
    }

    if (openIssue !== null) {
      // 多行消息的续行：并回上一条问题，规则列改从最新的最后一行拆出（首行里形似规则的文本回归正文）。
      openIssue.messageLines.push(line.trim());
      openIssue.issue.message = renderStylishMessage(openIssue.messageLines);
      continue;
    }

    // 既有的单行 'file:line:col 级别 消息  规则' 形态继续支持；它自带文件名，不依赖文件头。
    // 不匹配的其余行（文件头之前的杂项文本等）不属于任何问题，不参与解析；之后若出现无主问题行会整体交回原文。
    const single = ESLINT_LINE_RE.exec(line);
    if (single) {
      record(
        single[1],
        single[2],
        single[3] === 'error' ? 'error' : 'warning',
        `${single[4]} (${single[5]})`
      );
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

/**
 * 严格入口：格式不符返回 null，解析器自身缺陷（异常）直接抛出。
 * 只供 OutputCompressor 使用（不经 parsers/index.ts 公开），由压缩器经 reportParserError 归类为 parser-error；
 * 解析器模块按分层契约没有运行时依赖、不能自己写日志，所以异常必须交给压缩器记录。
 */
export function parseStrict(raw: string): string | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  const result = tryEslint(raw) ?? tryTsc(raw);
  if (!result) {
    return null;
  }

  return formatResult(result);
}

/**
 * 尝试解析 raw 输出，失败返回 null。
 * 公开契约：从不抛错，内部异常同样返回 null；需要区分“格式不符”与“解析器缺陷”的调用方使用 parseStrict。
 */
export function parse(raw: string): string | null {
  try {
    return parseStrict(raw);
  } catch (err: unknown) {
    // 公开 parse* 没有诊断通道（解析器不能依赖日志模块）；经 OutputCompressor 调用时走 parseStrict，异常会被记录为 parser-error。
    void err;
    return null;
  }
}
