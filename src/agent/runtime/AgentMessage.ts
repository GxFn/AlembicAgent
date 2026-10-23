/**
 * AgentMessage — 统一消息信封
 *
 * 核心抽象: Agent 只处理 AgentMessage，不关心消息来自哪个渠道。
 * 宿主在自己的边界内完成鉴权与形状归一化后，用 `new AgentMessage({ content, sender, session, ... })`
 * 显式构造消息；运行结束后由宿主读取 `AgentResult.reply` 自行投递，Agent 不回写渠道。
 * Agent 间的子消息用 `AgentMessage.internal()` 构造。
 *
 * W2a-05（L5-P42 / I41）已退役 transport 工厂 fromHttp/fromCli/fromMcp 与 replyFn 回写：
 * 它们没有任何调用方；fromHttp 把请求体 userId 当身份，可伪造 SafetyPolicy 白名单；replyFn 在执行期限与
 * 取消之外被 await，挂起会让 execute 永不返回。`Channel` 的键集合按批准范围保留（其中 CLI 已无生产者）。
 *
 * 具体 Codex MCP server、marketplace/channel 和 host-agent route 由 AlembicPlugin 或其它宿主实现。
 *
 * @module AgentMessage
 */

import { randomUUID } from 'node:crypto';
import Logger from '@alembic/core/logging';

/** Sender identity */
interface Sender {
  id: string;
  name?: string;
  type: 'user' | 'system' | 'agent';
}

/** Session context */
interface Session {
  id: string;
  history?: Array<{ role: string; content: string }>;
}

/** AgentMessage constructor options */
interface AgentMessageOptions {
  content?: string;
  channel?: string;
  session?: Session;
  sender?: Sender;
  metadata?: Record<string, unknown>;
}

/** Internal message options */
interface InternalMessageOptions {
  session?: Session;
  sessionId?: string;
  history?: Array<{ role: string; content: string }>;
  sourceAgentId?: string;
  parentAgentId?: string;
  dimension?: string;
  phase?: string;
  /** 附加元数据；与 parentAgentId/dimension/phase 同名的键会被显式且非 undefined 的选项覆盖 */
  metadata?: Record<string, unknown>;
  /** Extra pass-through keys (e.g. 'source') */
  [key: string]: unknown;
}

/** internal() 中可由调用方显式传入、并优先于 opts.metadata 同名键的字段 */
const INTERNAL_EXPLICIT_METADATA_KEYS = ['parentAgentId', 'dimension', 'phase'] as const;

/** 只描述值的类型，诊断日志里不输出 metadata 原值（可能很大或含用户内容）。 */
function describeValueType(value: unknown) {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * 合并 internal() 的 metadata：先展开 opts.metadata，再由显式且非 undefined 的选项覆盖。
 *
 * 旧顺序让 opts.metadata 覆盖显式字段：已删除的 FanOutStrategy（W2a-06）子消息曾同时传 dimension: item.id
 * 与 metadata.dimension: item，结果 metadata.dimension 变成整个 item 对象，而
 * AgentRunCoordinator.resolveDimensionId 与 AgentService 只接受字符串维度，维度归属因此丢失。
 * 显式值为 undefined（未传）时保留 metadata 中的同名值，避免“未传”抹掉调用方元数据。
 * 三个键先以 undefined 占位，保持与旧实现一致的键集合与顺序。
 */
function mergeInternalMetadata(opts: InternalMessageOptions): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    parentAgentId: undefined,
    dimension: undefined,
    phase: undefined,
    ...opts.metadata,
  };
  const overridden: string[] = [];
  for (const key of INTERNAL_EXPLICIT_METADATA_KEYS) {
    const explicit = opts[key];
    if (explicit === undefined) {
      continue;
    }
    const previous = metadata[key];
    if (previous !== undefined && previous !== explicit) {
      overridden.push(
        `${key} (metadata ${describeValueType(previous)} -> explicit ${describeValueType(explicit)})`
      );
    }
    metadata[key] = explicit;
  }
  if (overridden.length > 0) {
    // 冲突覆盖是确定的合并规则而非错误；记 debug 诊断，便于追查哪个调用方传入了冲突元数据。
    Logger.getInstance().debug(
      `[AgentMessage] internal(): explicit options override conflicting metadata keys: ${overridden.join(', ')}`
    );
  }
  return metadata;
}

/**
 * 通信渠道枚举：只是宿主构造消息时写入的渠道标签（AgentService 按运行来源产出 http/mcp/internal，internal() 产出 internal）。
 * 键集合是公开契约，transport 工厂退役后 CLI 已无 Agent 内生产者，但收窄未获授权，保持不变。
 */
export const Channel = Object.freeze({
  HTTP: 'http',
  CLI: 'cli',
  MCP: 'mcp',
  INTERNAL: 'internal', // Agent 间通信
});

export class AgentMessage {
  /** 消息唯一 ID */
  id;
  /** 用户输入内容 */
  content;
  /** 通信渠道 */
  channel;
  /** 会话信息 */
  session;
  /** 发送者 */
  sender;
  /** 渠道特定元数据 */
  metadata;
  /** 时间戳 */
  timestamp;

  /**
   * @param opts.content 用户输入
   * @param [opts.channel='http'] 渠道
   * @param [opts.session] 会话
   * @param [opts.sender] 发送者
   * @param [opts.metadata] 元数据
   */
  constructor({
    content,
    channel = Channel.HTTP,
    session,
    sender,
    metadata,
  }: AgentMessageOptions = {}) {
    this.id = randomUUID();
    this.content = content || '';
    this.channel = channel;
    this.session = session || { id: randomUUID(), history: [] };
    this.sender = sender || { id: 'anonymous', type: 'user' };
    this.metadata = metadata || {};
    this.timestamp = Date.now();
  }

  /** 对话历史 (快捷访问) */
  get history() {
    return this.session.history || [];
  }

  /**
   * Agent 间内部消息
   *
   * metadata 合并顺序：先展开 opts.metadata，再由显式且非 undefined 的
   * parentAgentId/dimension/phase 覆盖（见 mergeInternalMetadata）。
   * @param content 消息内容
   */
  static internal(content: string, opts: InternalMessageOptions = {}) {
    return new AgentMessage({
      content,
      channel: Channel.INTERNAL,
      session: opts.session || { id: opts.sessionId || randomUUID(), history: opts.history || [] },
      sender: {
        id: opts.sourceAgentId || 'system',
        type: 'agent',
      },
      metadata: mergeInternalMetadata(opts),
    });
  }

  /** 序列化 */
  toJSON() {
    return {
      id: this.id,
      content: this.content,
      channel: this.channel,
      session: { id: this.session.id, historyLength: this.history.length },
      sender: this.sender,
      metadata: this.metadata,
      timestamp: this.timestamp,
    };
  }
}

export default AgentMessage;
