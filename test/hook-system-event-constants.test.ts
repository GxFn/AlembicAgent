import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// 把 AgentEvents 的桥接常量改成 fixture 值：HookSystem 若仍用字面量发布，就会继续发出旧名，
// 订阅常量的消费者静默收不到事件（L5-P41 / I30 / U20-F8）。只替换桥接相关的两个值，其余保持原样。
vi.mock('../src/agent/runtime/AgentEventBus.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/agent/runtime/AgentEventBus.js')>();
  return {
    ...original,
    AgentEvents: Object.freeze({
      ...original.AgentEvents,
      LLM_CALL_START: 'fixture:llm:start',
      LLM_CALL_END: 'fixture:llm:end',
    }),
  };
});

const { HookSystem, registerDefaultHooks } = await import('../src/agent/runtime/HookSystem.js');

const SRC_ROOT = path.join(process.cwd(), 'src');
const HOOK_SYSTEM_FILE = path.join(SRC_ROOT, 'agent', 'runtime', 'HookSystem.ts');

/** 运行时实际分发的 7 个钩子事件（AgentRuntime 的 emit/emitSync 调用点）。 */
const EMITTED_HOOK_EVENTS = [
  'agent:finalize',
  'agent:iteration:after',
  'agent:iteration:before',
  'llm:call:after',
  'llm:call:before',
  'tool:execute:after',
  'tool:execute:before',
];

/** L5-P41 收窄删除的 5 个从未分发的钩子事件。 */
const REMOVED_HOOK_EVENTS = [
  'agent:exit',
  'context:compact:before',
  'context:compact:after',
  'exploration:phase_transition',
  'exploration:budget_warning',
];

/** src 内有发布方的 10 个 AgentEvents 键（AgentRuntime、策略层与 HookSystem 的 llm:call 桥接）。 */
const PUBLISHED_EVENT_KEYS = {
  AGENT_CREATED: 'agent:created',
  AGENT_STARTED: 'agent:started',
  AGENT_COMPLETED: 'agent:completed',
  AGENT_FAILED: 'agent:failed',
  AGENT_ABORTED: 'agent:aborted',
  TOOL_CALL_START: 'tool:call:start',
  TOOL_CALL_END: 'tool:call:end',
  LLM_CALL_START: 'llm:call:start',
  LLM_CALL_END: 'llm:call:end',
  PROGRESS: 'progress',
};

/** L5-P41 收窄删除的 8 个无发布方常量。 */
const REMOVED_EVENT_KEYS = [
  'STEP_COMPLETED',
  'HANDOFF_REQUEST',
  'HANDOFF_ACCEPT',
  'HANDOFF_RESULT',
  'THINKING',
  'STREAM_DELTA',
  'USER_INPUT',
  'SCAN_REQUEST',
];

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(absolute, files);
    } else if (entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

/** 用 TypeScript AST 读取 HookEvent 联合成员与 HookPayloadMap 属性名（tsconfig 只含 src，vitest 不做类型检查）。 */
function readHookEventContract(): { hookEvents: string[]; payloadKeys: string[] } {
  const sourceFile = ts.createSourceFile(
    HOOK_SYSTEM_FILE,
    readFileSync(HOOK_SYSTEM_FILE, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const hookEvents: string[] = [];
  const payloadKeys: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === 'HookEvent') {
      const members = ts.isUnionTypeNode(statement.type) ? statement.type.types : [statement.type];
      for (const member of members) {
        if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
          hookEvents.push(member.literal.text);
        } else {
          hookEvents.push(`<non-literal:${member.getText(sourceFile)}>`);
        }
      }
    }
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'HookPayloadMap') {
      for (const member of statement.members) {
        if (member.name && (ts.isStringLiteral(member.name) || ts.isIdentifier(member.name))) {
          payloadKeys.push(member.name.text);
        }
      }
    }
  }
  return { hookEvents: hookEvents.sort(), payloadKeys: payloadKeys.sort() };
}

describe('registerDefaultHooks event names follow AgentEvents constants', () => {
  it('bridges only llm:call:* under the AgentEvents constant values', () => {
    const hooks = new HookSystem();
    const published: Array<{ type: string; payload: unknown; source?: string }> = [];
    registerDefaultHooks(hooks, 'agent-fixture', {
      publish(type, payload, opts) {
        published.push({ type, payload, source: opts?.source });
      },
    });

    // 收窄后默认桥接只剩 llm:call:before/after 两个；死的退出桥接已删除。
    expect(hooks.hookCount()).toBe(2);
    expect(hooks.hookCount('llm:call:before')).toBe(1);
    expect(hooks.hookCount('llm:call:after')).toBe(1);

    hooks.emitSync('llm:call:before', { iteration: 1, toolChoice: 'auto' });
    hooks.emitSync('llm:call:after', {
      iteration: 1,
      hasToolCalls: false,
      hasText: true,
      inputTokens: 3,
      outputTokens: 2,
    });
    // 手动分发已删除的退出事件名（绕过类型）也不会再得到 step:completed。
    hooks.emitSync('agent:exit' as never, { reason: 'fixture_exit', iteration: 1 } as never);

    expect(published.map((event) => event.type)).toEqual(['fixture:llm:start', 'fixture:llm:end']);
    expect(published.map((event) => event.type)).not.toContain('step:completed');
    expect(published.every((event) => event.source === 'agent-fixture')).toBe(true);
  });

  it('registers no bridge without a bus', () => {
    const hooks = new HookSystem();
    registerDefaultHooks(hooks, 'agent-fixture', null);
    expect(hooks.hookCount()).toBe(0);
  });
});

describe('hook and event contract narrowing (L5-P41)', () => {
  it('keeps only the dispatched events in HookEvent and HookPayloadMap', () => {
    const { hookEvents, payloadKeys } = readHookEventContract();
    expect(hookEvents).toEqual([...EMITTED_HOOK_EVENTS].sort());
    expect(payloadKeys).toEqual([...EMITTED_HOOK_EVENTS].sort());
  });

  it('leaves no source reference to the removed hook events or the step:completed topic', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const literal of [...REMOVED_HOOK_EVENTS, 'step:completed']) {
        if (text.includes(literal)) {
          offenders.push(`${path.relative(process.cwd(), file)}: ${literal}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('drops the eight unpublished AgentEvents keys and keeps the published ones frozen', async () => {
    // 本文件 mock 了 AgentEventBus；这里读取真实模块校验常量表本身。
    const { AgentEvents } = await vi.importActual<
      typeof import('../src/agent/runtime/AgentEventBus.js')
    >('../src/agent/runtime/AgentEventBus.js');
    expect(Object.isFrozen(AgentEvents)).toBe(true);
    for (const key of REMOVED_EVENT_KEYS) {
      expect({ key, present: key in AgentEvents }).toEqual({ key, present: false });
    }
    expect({ ...AgentEvents }).toEqual(PUBLISHED_EVENT_KEYS);
  });
});
