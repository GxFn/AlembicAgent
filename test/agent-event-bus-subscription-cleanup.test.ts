import { describe, expect, it, vi } from 'vitest';
import { AgentEventBus } from '../src/agent/runtime/AgentEventBus.js';

// getStats().subscriptionTopics 取 Map.size；取消订阅后必须删掉空 topic，否则动态 topic 的
// 订阅/取消会让统计只增不减，泄漏排查得出错误结论。
describe('AgentEventBus subscription cleanup', () => {
  it('drops an empty topic after its only handler unsubscribes', () => {
    const bus = new AgentEventBus();
    const unsubscribe = bus.subscribe('dynamic:topic', () => undefined);
    expect(bus.getStats().subscriptionTopics).toBe(1);
    unsubscribe();
    expect(bus.getStats().subscriptionTopics).toBe(0);
  });

  it('keeps the topic while another handler is still subscribed', () => {
    const bus = new AgentEventBus();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = bus.subscribe('shared', first);
    const unsubscribeSecond = bus.subscribe('shared', second);
    unsubscribeFirst();
    expect(bus.getStats().subscriptionTopics).toBe(1);
    bus.publish('shared', { n: 1 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeSecond();
    expect(bus.getStats().subscriptionTopics).toBe(0);
  });

  it('stays at zero across repeated dynamic subscribe/unsubscribe cycles', () => {
    const bus = new AgentEventBus();
    for (let index = 0; index < 5; index++) {
      const unsubscribe = bus.subscribe(`dynamic:${index}`, () => undefined);
      unsubscribe();
      // 重复调用同一个取消函数必须幂等，不能误删后来者的 topic。
      unsubscribe();
    }
    expect(bus.getStats().subscriptionTopics).toBe(0);
  });

  it('does not let a stale unsubscribe remove a topic re-subscribed afterwards', () => {
    const bus = new AgentEventBus();
    const stale = bus.subscribe('topic', () => undefined);
    stale();
    const handler = vi.fn();
    bus.subscribe('topic', handler);
    stale();
    expect(bus.getStats().subscriptionTopics).toBe(1);
    bus.publish('topic');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
