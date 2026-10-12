/**
 * @module tools/runtime/compressor/parsers/TestOutputParser
 * 解析 vitest/jest/mocha/pytest 测试输出为紧凑结构化格式。
 */

interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  failures: FailureInfo[];
  /**
   * 失败明细写在哪条流：pytest/mocha 把失败名与断言写在 stdout，摘要必须带上它们；
   * vitest/jest 把失败详情写在 stderr，OutputCompressor 会原样保留 stderr，stdout 只剩计数不算丢失。
   */
  failureDetails: 'stdout' | 'stderr';
}

interface FailureInfo {
  /** pytest 的 setup/teardown/收集错误单独标 ERROR，其余失败标 FAIL。 */
  label: 'FAIL' | 'ERROR';
  name: string;
  message: string;
}

const VITEST_SUMMARY_RE =
  /^\s*Tests\s+(\d+)\s+failed\s*(?:\|\s*(\d+)\s+passed\s*)?(?:\|\s*(\d+)\s+skipped\s*)?\(\s*(\d+)\s*\)\s*$/m;
const VITEST_SUMMARY_PASS_RE =
  /^\s*Tests\s+(\d+)\s+passed\s*(?:\|\s*(\d+)\s+skipped\s*)?\(\s*(\d+)\s*\)\s*$/m;

const JEST_SUMMARY_RE =
  /Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/;

const PYTEST_SUMMARY_RE =
  /^=+\s+((?:\d+\s+(?:passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)(?:,\s*|\s+))+).*?=+$/gm;

const MOCHA_PASSING_RE = /^\s*(\d+)\s+passing\b/m;
const MOCHA_FAILING_RE = /^\s*(\d+)\s+failing\b/m;
const MOCHA_PENDING_RE = /^\s*(\d+)\s+pending\b/m;
/** mocha 在 'N failing' 之后按 '  1) 标题' 编号列出失败块；标题跨多行，最后一行以 ':' 结尾。 */
const MOCHA_FAILURE_HEADER_RE = /^\s+(\d+)\) (.+)$/;
const MAX_FAILURE_DETAIL_LINES = 3;

/**
 * pytest short test summary 行：'FAILED <nodeid> - <message>' 或 'ERROR <nodeid> - <message>'。
 * nodeid 可能含空格（参数化 id），以第一个 ' - ' 为界；要求关键字后紧跟非空白，
 * 避免把捕获日志里的 'ERROR    root:...' 当成失败。
 */
const PYTEST_FAILURE_LINE_RE = /^(FAILED|ERROR) (\S.*?)(?: - (.*))?$/;

const FAIL_BLOCK_RE =
  /(?:FAIL|✕|✗|×|FAILED)\s+(.+?)(?:\n|\r\n)([\s\S]*?)(?=\n(?:FAIL|✕|✗|×|FAILED|Tests:|Test Suites:|$))/g;

const VITEST_FAIL_RE = /(?:❌|×|✕)\s+(.+?)(?:\n|\r\n)([\s\S]*?)(?=\n(?:❌|×|✕|Tests\s|$))/g;

function extractFailures(raw: string): FailureInfo[] {
  const failures: FailureInfo[] = [];
  const seen = new Set<string>();

  for (const re of [FAIL_BLOCK_RE, VITEST_FAIL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const name = m[1].trim();
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const detail = m[2]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, MAX_FAILURE_DETAIL_LINES)
        .join(' | ');
      failures.push({ label: 'FAIL', name, message: detail || 'unknown error' });
    }
  }

  return failures;
}

/** 逐行读取 pytest short test summary；每条 FAILED/ERROR 都保留（同一节点的 call 失败与 teardown 错误分别计数）。 */
function extractPytestFailures(raw: string): FailureInfo[] {
  const failures: FailureInfo[] = [];
  for (const line of raw.split('\n')) {
    const m = PYTEST_FAILURE_LINE_RE.exec(line.trimEnd());
    if (m) {
      failures.push({
        label: m[1] === 'ERROR' ? 'ERROR' : 'FAIL',
        name: m[2].trim(),
        message: m[3]?.trim() || 'unknown error',
      });
    }
  }
  return failures;
}

/**
 * 解析 mocha 'N failing' 之后的编号失败块。
 * 返回 null 表示块结构无法识别（标题没有以 ':' 收尾），调用方应交回原文；
 * 块数是否等于 'N failing' 由 parse 统一核对，不足时同样交回原文。
 */
function extractMochaFailures(raw: string): FailureInfo[] | null {
  const lines = raw.split('\n');
  const failingIndex = lines.findIndex((line) => MOCHA_FAILING_RE.test(line));
  if (failingIndex < 0) {
    return [];
  }

  // 只认从 1 开始连续递增的编号，避免把断言消息或 diff 里的 '2) ...' 当成新的失败块。
  const blocks: string[][] = [];
  for (const line of lines.slice(failingIndex + 1)) {
    const header = MOCHA_FAILURE_HEADER_RE.exec(line);
    if (header && Number(header[1]) === blocks.length + 1) {
      blocks.push([header[2]]);
      continue;
    }
    blocks.at(-1)?.push(line);
  }

  const failures: FailureInfo[] = [];
  for (const block of blocks) {
    // 标题按 titlePath 分行缩进，最后一行以 ':' 结尾；之后是错误消息、diff 与堆栈。
    const titleEnd = block.findIndex((line) => line.trimEnd().endsWith(':'));
    if (titleEnd < 0) {
      return null;
    }
    const name = block
      .slice(0, titleEnd + 1)
      .map((line) => line.trim())
      .join(' ')
      .replace(/:$/, '');
    const detail = block
      .slice(titleEnd + 1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^at\s/.test(line))
      .slice(0, MAX_FAILURE_DETAIL_LINES)
      .join(' | ');
    failures.push({ label: 'FAIL', name, message: detail || 'unknown error' });
  }
  return failures;
}

function tryVitest(raw: string): TestResult | null {
  let m = VITEST_SUMMARY_RE.exec(raw);
  if (m) {
    return {
      failed: parseInt(m[1], 10),
      passed: m[2] ? parseInt(m[2], 10) : 0,
      skipped: m[3] ? parseInt(m[3], 10) : 0,
      total: parseInt(m[4], 10),
      failures: extractFailures(raw),
      failureDetails: 'stderr',
    };
  }

  m = VITEST_SUMMARY_PASS_RE.exec(raw);
  if (m) {
    return {
      passed: parseInt(m[1], 10),
      failed: 0,
      skipped: m[2] ? parseInt(m[2], 10) : 0,
      total: parseInt(m[3], 10),
      failures: [],
      failureDetails: 'stderr',
    };
  }

  return null;
}

function tryJest(raw: string): TestResult | null {
  const m = JEST_SUMMARY_RE.exec(raw);
  if (!m) {
    return null;
  }

  const failed = m[1] ? parseInt(m[1], 10) : 0;
  const skipped = m[2] ? parseInt(m[2], 10) : 0;
  const passed = m[3] ? parseInt(m[3], 10) : 0;
  const total = parseInt(m[4], 10);

  return {
    passed,
    failed,
    skipped,
    total,
    failures: extractFailures(raw),
    failureDetails: 'stderr',
  };
}

function tryPytest(raw: string): TestResult | null {
  // 标题行不是结果；多个运行的摘要无法当成一次完整结果，交回原文。
  const summaries = [...raw.matchAll(PYTEST_SUMMARY_RE)];
  const m = summaries[0];
  if (!m || summaries.length !== 1) {
    return null;
  }

  const counts = new Map(
    [...m[1].matchAll(/(\d+)\s+(\w+)/g)].map((match) => [match[2], Number(match[1])])
  );
  const passed = counts.get('passed') ?? 0;
  const failed = counts.get('failed') ?? 0;
  const skipped = (counts.get('skipped') ?? 0) + (counts.get('xfailed') ?? 0);
  const errors = (counts.get('error') ?? 0) + (counts.get('errors') ?? 0);
  // XPASS 的结论受 pytest strict 配置影响，不能丢掉它后声称“0 tests”。
  if ((counts.get('xpassed') ?? 0) > 0 || passed + failed + skipped + errors === 0) {
    return null;
  }

  return {
    passed,
    failed: failed + errors,
    skipped,
    total: passed + failed + skipped + errors,
    failures: extractPytestFailures(raw),
    failureDetails: 'stdout',
  };
}

function tryMocha(raw: string): TestResult | null {
  const passingMatch = MOCHA_PASSING_RE.exec(raw);
  if (!passingMatch) {
    return null;
  }

  const passed = parseInt(passingMatch[1], 10);
  const failingMatch = MOCHA_FAILING_RE.exec(raw);
  const failed = failingMatch ? parseInt(failingMatch[1], 10) : 0;
  // pending（it.skip / 无实现的 it）不计入 passing/failing，必须单独计入 skipped 与 total。
  const pendingMatch = MOCHA_PENDING_RE.exec(raw);
  const skipped = pendingMatch ? parseInt(pendingMatch[1], 10) : 0;
  const failures = extractMochaFailures(raw);
  if (failures === null) {
    return null;
  }

  return {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    failures,
    failureDetails: 'stdout',
  };
}

function formatResult(result: TestResult): string {
  const counts = [`${result.passed} passed`, `${result.failed} failed`];
  // skipped 非零时必须列出，否则 total 与 passed+failed 的差额无从解释；为零时省略，保持原摘要文本。
  if (result.skipped > 0) {
    counts.push(`${result.skipped} skipped`);
  }
  const parts: string[] = [`Tests: ${counts.join(', ')}, ${result.total} total`];

  if (result.failures.length > 0) {
    parts.push('');
    parts.push('[failures]');
    for (const f of result.failures) {
      parts.push(`${f.label} ${f.name}: ${f.message}`);
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

  // watch/多项目输出的先后结果不能互相覆盖，也不能猜测它们应该累加还是取最后一次。
  if (
    (raw.match(/^\s*Tests(?:\s|:)/gm)?.length ?? 0) > 1 ||
    (raw.match(/^\s*\d+\s+passing\b/gm)?.length ?? 0) > 1 ||
    (raw.match(/^\s*\d+\s+failing\b/gm)?.length ?? 0) > 1 ||
    (raw.match(/^\s*\d+\s+pending\b/gm)?.length ?? 0) > 1 ||
    /^\s*Errors\s+[1-9]\d*\s+errors?\b/m.test(raw)
  ) {
    return null;
  }

  const result = tryVitest(raw) ?? tryJest(raw) ?? tryPytest(raw) ?? tryMocha(raw);

  if (
    !result ||
    ![result.passed, result.failed, result.skipped, result.total].every(Number.isSafeInteger) ||
    result.passed + result.failed + result.skipped !== result.total ||
    (result.failed === 0 && /^\s*Test (?:Files|Suites:).*\bfailed\b/m.test(raw))
  ) {
    return null;
  }
  // 失败明细写在 stdout 的框架：计数里有失败却没提取到同样多的失败名，只给计数会让调用方
  // 以为信息完整；统一交回原文（OutputCompressor 记录 unrecognized-output 回退）。
  if (result.failureDetails === 'stdout' && result.failures.length !== result.failed) {
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
