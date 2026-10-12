/**
 * L1-P2（module-review-2026-10-01 L1-I1 / U01-F1）：运行/阶段期限经 runOperation 到达 code.search。
 *
 * runOperation 的期限分支以 TimeoutError 原因中止内层 signal（与 AbortSignal.timeout 同名），
 * code.search 通过共享的 isDeadlineAbort 判断取消来源：
 * - 期限到达 → 回执 resultStatus 为 timeout（此前不带原因时被记成 aborted，与运行层 runtime_timeout 矛盾）；
 * - 父取消（用户/宿主停止）→ 回执仍为 aborted，原因原样透传。
 * 两种场景都不再执行剩余 pattern，并在诊断里点名被跳过的 pattern。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOperation } from '../src/shared/operation.js';
import type { ToolResult } from '../src/tools/kernel/registry.js';
import { handle as handleCode } from '../src/tools/runtime/handlers/code.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-code-search-deadline-'));
  await writeFile(join(root, 'small.ts'), 'one\ntwo\nthree');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('code.search under a runOperation deadline', () => {
  it.each([
    { label: 'its runOperation deadline expires', parentCancel: false, status: 'timeout' },
    { label: 'the parent cancels the operation', parentCancel: true, status: 'aborted' },
  ])('reports $status when the search stops because $label', async ({ parentCancel, status }) => {
    const parent = new AbortController();
    const operationStarted = Promise.withResolvers<void>();
    let searchRun: Promise<ToolResult> | undefined;
    const pending = runOperation(
      (signal) => {
        operationStarted.resolve();
        // 模拟工具调用在取消到达时恰好进入 code.search：等内层 signal 中止后再执行搜索，
        // 让 handler 在第一个 pattern 之前就观察到取消原因，避免依赖 ripgrep 的计时。
        searchRun = new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }).then(() =>
          handleCode(
            'search',
            { patterns: ['two', 'three'] },
            { projectRoot: root, tokenBudget: 8000, abortSignal: signal }
          )
        );
        return searchRun;
      },
      { abortSignal: parent.signal, timeoutMs: parentCancel ? 60_000 : 30 }
    );
    await operationStarted.promise;
    if (parentCancel) {
      parent.abort(new Error('host stopped the run'));
    }

    expect(await pending).toEqual({ status });
    const result = await searchRun;
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain(`code.search ${status}:`);
    expect(result?._meta).toMatchObject({ resultStatus: status, degraded: true });
    const warning = result?._meta?.diagnosticWarnings?.find(
      (entry) => entry.code === 'code_search_incomplete'
    );
    expect(warning?.message).toContain(
      `Search ${status}: Search cancelled before the next pattern.`
    );
    expect(warning?.message).toContain('Skipped pattern(s) "two", "three".');
  });
});
