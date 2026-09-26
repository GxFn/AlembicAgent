import { vi } from 'vitest';
import { AgentRuntime } from '../../src/agent/runtime/AgentRuntime.js';
import type { ProgressEvent } from '../../src/agent/runtime/AgentRuntimeTypes.js';
import type { ToolResultEnvelope } from '../../src/tools/kernel/index.js';
import { RuntimeCapabilityCatalog } from '../../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';

// 凭据形态的字符串和数字均为合成标记；三条真实消费链共用输入，业务返回仍须保持原文。
const marker = 'SYNTHETIC_ONLY_NEVER_A_REAL_CREDENTIAL';
const numberMarker = 314159265;
export const cases = [
  {
    name: 'quoted scalar',
    text: `password="${marker} with spaces"\nnormal=7`,
    values: [marker],
    expected: 'password="[redacted]"\nnormal=7',
  },
  {
    name: 'numeric JSON scalar',
    text: JSON.stringify({ password: numberMarker, normal: 7, totalTokens: 42 }),
    values: [String(numberMarker)],
    expected: JSON.stringify({ password: '[redacted]', normal: 7, totalTokens: 42 }),
  },
  {
    name: 'nested JSON observation',
    text: JSON.stringify({
      output: JSON.stringify({ api_key: `${marker} tail`, normal: 7 }),
      totalTokens: 42,
    }),
    values: [marker],
    expected: JSON.stringify({
      output: JSON.stringify({ api_key: '[redacted]', normal: 7 }),
      totalTokens: 42,
    }),
  },
  {
    name: 'JSON string array',
    text: JSON.stringify([`password="${marker} tail"`, 'ordinary']),
    values: [marker],
    expected: JSON.stringify(['password="[redacted]"', 'ordinary']),
  },
] as const;
export const usage = {
  inputTokens: 11,
  outputTokens: 7,
  reasoningTokens: 3,
  cacheHitTokens: 2,
  cacheWriteTokens: 5,
};

export function envelope(text: string): ToolResultEnvelope {
  return {
    ok: true,
    toolId: 'meta',
    callId: 'fixture-call',
    startedAt: '2026-09-26T00:00:00.000Z',
    durationMs: 3,
    status: 'success',
    text,
    structuredContent: { observation: text, normal: 7 },
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}
export function runtimeFixture(chat: ReturnType<typeof vi.fn>, receipt?: ToolResultEnvelope) {
  const events: ProgressEvent[] = [];
  const execute = vi.fn(async () => receipt);
  // 只替换provider和宿主端口；运行循环、Hook、事件投影及脱敏均执行正式实现。
  // Runtime配置使用具体类类型，夹具仅实现本组调用实际需要的端口，因此在注入点收窄断言。
  const runtime = new AgentRuntime({
    aiProvider: { name: 'fixture', model: 'synthetic-model', chatWithTools: chat } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute } as never,
    container: { get: () => new RuntimeCapabilityCatalog() },
    capabilities: [],
    additionalTools: receipt ? ['meta'] : [],
    strategy: { name: 'unused', execute: vi.fn() } as never,
    onProgress: (event) => events.push(event),
  });
  return { runtime, events, execute };
}
