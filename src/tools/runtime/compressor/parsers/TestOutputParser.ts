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
}

interface FailureInfo {
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

const MOCHA_PASSING_RE = /(\d+)\s+passing/;
const MOCHA_FAILING_RE = /(\d+)\s+failing/;

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
        .slice(0, 3)
        .join(' | ');
      failures.push({ name, message: detail || 'unknown error' });
    }
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

  return { passed, failed, skipped, total, failures: extractFailures(raw) };
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
    failures: extractFailures(raw),
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

  return {
    passed,
    failed,
    skipped: 0,
    total: passed + failed,
    failures: extractFailures(raw),
  };
}

function formatResult(result: TestResult): string {
  const parts: string[] = [
    `Tests: ${result.passed} passed, ${result.failed} failed, ${result.total} total`,
  ];

  if (result.failures.length > 0) {
    parts.push('');
    parts.push('[failures]');
    for (const f of result.failures) {
      parts.push(`FAIL ${f.name}: ${f.message}`);
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

    // watch/多项目输出的先后结果不能互相覆盖，也不能猜测它们应该累加还是取最后一次。
    if (
      (raw.match(/^\s*Tests(?:\s|:)/gm)?.length ?? 0) > 1 ||
      (raw.match(/^\s*\d+\s+passing\b/gm)?.length ?? 0) > 1 ||
      (raw.match(/^\s*\d+\s+failing\b/gm)?.length ?? 0) > 1 ||
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
    return formatResult(result);
  } catch (err: unknown) {
    void err;
    return null;
  }
}
