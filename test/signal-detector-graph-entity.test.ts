import { describe, expect, it } from 'vitest';
import { SignalDetector } from '../src/agent/context/exploration/SignalDetector.js';

// module-review L6 C20：graph 信号只按 action + type + entity 去重。
// graph handler 只认字符串 params.entity（graph.query 缺 entity 直接失败，失败观察不计信号），
// 没有任何写入方产生 className/protocolName/name 别名；graph.overview 不接受 entity，
// 按文件头参数契约只按 action + type 去重。这里锁住"别名不再参与去重键"。

function makeDetector() {
  const metrics = {
    uniqueFiles: new Set<string>(),
    uniquePatterns: new Set<string>(),
    uniqueQueries: new Set<string>(),
  };
  return { detector: new SignalDetector(metrics), metrics };
}

const OVERVIEW_RESULT = { totalFiles: 12, languages: ['ts'] };

function queryResult(type: string, entity: string) {
  return { type, entity, result: { name: entity } };
}

describe('SignalDetector graph signal (entity only)', () => {
  it('keys graph.query signals by the string entity the handler actually consumes', () => {
    const { detector, metrics } = makeDetector();
    expect(
      detector.detect(
        'graph',
        { action: 'query', type: 'class', entity: 'Foo' },
        queryResult('class', 'Foo')
      )
    ).toBe(true);
    expect(
      detector.detect(
        'graph',
        { action: 'query', type: 'class', entity: 'Bar' },
        queryResult('class', 'Bar')
      )
    ).toBe(true);
    // 同一 type + entity 再查一次不是新信息。
    expect(
      detector.detect(
        'graph',
        { action: 'query', type: 'class', entity: 'Foo' },
        queryResult('class', 'Foo')
      )
    ).toBe(false);
    expect([...metrics.uniqueQueries].sort()).toEqual([
      'graph:query:class:Bar',
      'graph:query:class:Foo',
    ]);
  });

  it('ignores retired className/protocolName/name aliases when building the dedupe key', () => {
    const { detector, metrics } = makeDetector();
    expect(detector.detect('graph', { action: 'overview' }, OVERVIEW_RESULT)).toBe(true);
    // overview 不接受 entity；模型夹带的旧别名参数不会改变 handler 结果，也不能制造"新信号"。
    for (const stray of [{ className: 'Foo' }, { protocolName: 'FooDelegate' }, { name: 'Bar' }]) {
      expect(detector.detect('graph', { action: 'overview', ...stray }, OVERVIEW_RESULT)).toBe(
        false
      );
    }
    expect([...metrics.uniqueQueries]).toEqual(['graph:overview::']);
  });

  it('does not stringify a non-string entity into a dedupe key', () => {
    const { detector, metrics } = makeDetector();
    // handler 对非字符串 entity 视为缺失；信号键同样只接受字符串 entity。
    detector.detect('graph', { action: 'overview', entity: 42 }, OVERVIEW_RESULT);
    expect([...metrics.uniqueQueries]).toEqual(['graph:overview::']);
  });

  it('counts no signal for a failed graph call even when an alias is present', () => {
    const { detector, metrics } = makeDetector();
    expect(
      detector.detect(
        'graph',
        { action: 'query', type: 'class', className: 'Foo' },
        { ok: false, error: 'graph.query(class) requires entity' }
      )
    ).toBe(false);
    expect(metrics.uniqueQueries.size).toBe(0);
  });
});
