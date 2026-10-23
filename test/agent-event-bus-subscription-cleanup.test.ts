import { describe, expect, it, vi } from 'vitest';
import { AgentEventBus } from '../src/agent/runtime/AgentEventBus.js';

// L5-P41 收窄：subscribe()/request() 与它们的订阅表、挂起应答表已删除，订阅统一走继承的
// EventEmitter（`bus.on` / `'*'` 通配 / `bus.off`）。getStats() 只保留 totalEvents。
describe('AgentEventBus narrowed subscription surface', () => {
  it('exposes no subscribe/request entry points', () => {
    const bus = new AgentEventBus();
    expect('subscribe' in AgentEventBus.prototype).toBe(false);
    expect('request' in AgentEventBus.prototype).toBe(false);
    expect('subscribe' in bus).toBe(false);
    expect('request' in bus).toBe(false);
  });

  it('reports only the published event count from getStats', () => {
    const bus = new AgentEventBus();
    expect(Object.keys(bus.getStats())).toEqual(['totalEvents']);
    expect(bus.getStats()).toEqual({ totalEvents: 0 });
    bus.publish('fixture');
    bus.publish('other', { n: 1 });
    expect(bus.getStats()).toEqual({ totalEvents: 2 });
  });

  it('keeps target and correlationId on the published envelope without a reply side channel', () => {
    const bus = new AgentEventBus();
    const seen = vi.fn();
    bus.on('*', seen);
    bus.publish('fixture', { n: 1 }, { source: 'a', target: 'b', correlationId: 'corr-1' });
    bus.publish('fixture:reply', { n: 2 }, { correlationId: 'corr-1' });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls[0][0]).toMatchObject({
      type: 'fixture',
      source: 'a',
      target: 'b',
      correlationId: 'corr-1',
      payload: { n: 1 },
    });
    expect(seen.mock.calls[1][0]).toMatchObject({
      type: 'fixture:reply',
      source: 'system',
      target: null,
      correlationId: 'corr-1',
    });
  });

  it('drops a dynamic topic after its only listener is removed with off', () => {
    const bus = new AgentEventBus();
    const listener = vi.fn();
    bus.on('dynamic:topic', listener);
    expect(bus.listenerCount('dynamic:topic')).toBe(1);
    bus.off('dynamic:topic', listener);
    expect(bus.listenerCount('dynamic:topic')).toBe(0);
    expect(bus.eventNames()).toEqual([]);
    bus.publish('dynamic:topic');
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the topic while another listener is still attached', () => {
    const bus = new AgentEventBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.on('shared', first);
    bus.on('shared', second);
    bus.off('shared', first);
    expect(bus.listenerCount('shared')).toBe(1);
    bus.publish('shared', { n: 1 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    bus.off('shared', second);
    expect(bus.eventNames()).toEqual([]);
  });

  it('stays empty across repeated dynamic on/off cycles', () => {
    const bus = new AgentEventBus();
    for (let index = 0; index < 5; index++) {
      const listener = () => undefined;
      bus.on(`dynamic:${index}`, listener);
      bus.off(`dynamic:${index}`, listener);
      // 重复移除同一监听器必须幂等。
      bus.off(`dynamic:${index}`, listener);
    }
    expect(bus.eventNames()).toEqual([]);
  });
});
