/**
 * 脱敏阶段 4e：台账入口的第一轮版本部分复用（总控裁定的台账入口性能口径第 (c) 项，2026-10-22）。
 *
 * redactDeveloperTextInContext 走合并路径时，未知来源底线与合并底线都从同一原文开始；合并底线的第一轮四个版本的
 * 冻结输出、追踪重放、位掩码、缺口与结构分析经 legacyFloor 的 replayShare 复用，不重做整轮。这里在模块边界计数
 * frozenRedact 与 replayTracked 在原文上的调用次数，确定性地钉住：带来源入口在原文上的整轮重放次数与门面相同
 * （每个版本至多一次），合并路径与“补跑带来源表的未知来源底线”都不再在原文上重放。计时口径另见
 * redaction-source-policy-performance。
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const counters = vi.hoisted(() => ({
  target: '',
  frozenOnTarget: 0,
  replayOnTarget: 0,
}));

vi.mock('../src/agent/utils/redaction/trackedReplay.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/agent/utils/redaction/trackedReplay.js')>();
  return {
    ...actual,
    frozenRedact: (...args: Parameters<typeof actual.frozenRedact>) => {
      if (args[1] === counters.target) {
        counters.frozenOnTarget++;
      }
      return actual.frozenRedact(...args);
    },
    replayTracked: (...args: Parameters<typeof actual.replayTracked>) => {
      if (args[1].text === counters.target) {
        counters.replayOnTarget++;
      }
      return actual.replayTracked(...args);
    },
  };
});

const { redactDeveloperText, redactDeveloperTextInContextWithReport } = await import(
  '../src/agent/utils/Redaction.js'
);
const { adversarialInputs } = await import('./fixtures/redaction-catalog/fuzzCorpus.js');

const TERMINAL = { tool: 'terminal.exec' } as const;
const SECRET_BEARING = { tool: 'code.read', file: 'deploy/.env' } as const;

/** 在 run 期间统计原文 input 上的 frozenRedact / replayTracked 调用次数。 */
function countOnInput(input: string, run: () => void): { frozen: number; replay: number } {
  counters.target = input;
  counters.frozenOnTarget = 0;
  counters.replayOnTarget = 0;
  run();
  const result = { frozen: counters.frozenOnTarget, replay: counters.replayOnTarget };
  counters.target = '';
  return result;
}

describe('ledger entry reuses the first round on the original text (merged path does not redo it)', () => {
  beforeEach(() => {
    counters.target = '';
  });

  test('merged path: the original text is replayed exactly as often as by the facade', () => {
    const input =
      'MY_SERVICE_PASS_HINT=SYNTHETIChint42\n> X-Session-Id: SYNTHETICsess1on\npassword=x';
    const facade = countOnInput(input, () => {
      redactDeveloperText(input);
    });
    // 门面在原文上每个版本恰好一次冻结输出（第一轮），改动了文本的版本各重放一次。
    expect(facade.frozen).toBe(4);
    expect(facade.replay).toBeGreaterThan(0);
    expect(facade.replay).toBeLessThanOrEqual(4);
    let path = '';
    const ledger = countOnInput(input, () => {
      path = redactDeveloperTextInContextWithReport(input, TERMINAL).source.path;
    });
    expect(path).toBe('merged');
    expect(ledger).toEqual(facade);
  });

  test('every path on adversarial and dense inputs replays the original at most once per version', () => {
    const inputs = [
      ...adversarialInputs(150, 0x5e7a),
      'KEY_1=value1\nKEY_2=value2',
      '  k0: "v0\n  k1: "v1\n  k2: "v2',
      '> Authorization: Bearer t0\n< Set-Cookie: s=1; Path=/',
    ];
    const paths = new Map<string, number>();
    for (const input of inputs) {
      for (const context of [TERMINAL, SECRET_BEARING]) {
        const facade = countOnInput(input, () => {
          redactDeveloperText(input);
        });
        let path = '';
        const ledger = countOnInput(input, () => {
          path = redactDeveloperTextInContextWithReport(input, context).source.path;
        });
        paths.set(path, (paths.get(path) ?? 0) + 1);
        expect(ledger, `${path}: ${JSON.stringify(input)}`).toEqual(facade);
      }
    }
    // 不能空转：合并路径与快路径都要被覆盖到。
    expect(paths.get('merged') ?? 0).toBeGreaterThan(20);
    expect((paths.get('no-span') ?? 0) + (paths.get('covered') ?? 0)).toBeGreaterThan(20);
  });
});
