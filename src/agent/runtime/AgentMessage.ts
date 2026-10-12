/**
 * AgentMessage — 统一消息信封
 *
 * 核心抽象: Agent 永远不需要知道消息来自哪个渠道。
 * Transport 适配器负责将渠道特定格式转换为 AgentMessage,
 * Agent 只处理 AgentMessage, 通过 replyFn 返回结果。
 *
 *   - HTTP/SSE (Dashboard)  → AgentMessage { channel: 'http', ... }
 *   - CLI (终端)             → AgentMessage { channel: 'cli',  ... }
 *   - MCP (host adapter)     → AgentMessage { channel: 'mcp',  ... }
 *
 * 这里只保留 Agent 内部的消息归一化能力；具体 Codex MCP server、
 * marketplace/channel 和 host-agent route 由 AlembicPlugin 或其它宿主实现。
 *
 * @module AgentMessage
 */

import { randomUUID } from 'node:crypto';
import Logger from '@alembic/core/logging';

/** Reply callback type */
type ReplyFn = (text: string) => Promise<void>;

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
  replyFn?: ReplyFn | null;
}

/** HTTP request body shape */
interface HttpRequestBody {
  prompt?: string;
  message?: string;
  content?: string;
  conversationId?: string;
  sessionId?: string;
  history?: Array<{ role: string; content: string }>;
  userId?: string;
  userName?: string;
  lang?: string;
  mode?: string;
  context?: unknown;
  stream?: boolean;
}

/** Minimal Express-like request */
interface HttpRequest {
  body?: HttpRequestBody;
  ip?: string;
}

/** CLI options */
interface CliOptions {
  sessionId?: string;
  history?: Array<{ role: string; content: string }>;
  cwd?: string;
  mode?: string;
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

/** Normalized MCP-like request shape supplied by a host/plugin adapter. */
interface McpRequest {
  prompt?: string;
  content?: string;
  arguments?: Record<string, unknown> & { prompt?: string };
  sessionId?: string;
  history?: Array<{ role: string; content: string }>;
  clientId?: string;
  clientName?: string;
  toolName?: string;
  mode?: string;
  metadata?: Record<string, unknown>;
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
 * 旧顺序让 opts.metadata 覆盖显式字段：FanOutStrategy 子消息同时传 dimension: item.id 与
 * metadata.dimension: item，结果 metadata.dimension 变成整个 FanOutItem 对象，而
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

/** 通信渠道枚举 */
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
  /** 回复函数 (text: string) => Promise<void> */
  replyFn;
  /** 时间戳 */
  timestamp;

  /**
   * @param opts.content 用户输入
   * @param [opts.channel='http'] 渠道
   * @param [opts.session] 会话
   * @param [opts.sender] 发送者
   * @param [opts.metadata] 元数据
   * @param [opts.replyFn] 回复函数
   */
  constructor({
    content,
    channel = Channel.HTTP,
    session,
    sender,
    metadata,
    replyFn,
  }: AgentMessageOptions = {}) {
    this.id = randomUUID();
    this.content = content || '';
    this.channel = channel;
    this.session = session || { id: randomUUID(), history: [] };
    this.sender = sender || { id: 'anonymous', type: 'user' };
    this.metadata = metadata || {};
    this.replyFn = replyFn || null;
    this.timestamp = Date.now();
  }

  /** 对话历史 (快捷访问) */
  get history() {
    return this.session.history || [];
  }

  /** 向发送方回复 */
  async reply(text: string) {
    if (this.replyFn) {
      await this.replyFn(text);
    }
  }

  // ─── Transport 工厂方法 ─────────────────────

  /**
   * 从 HTTP 请求构建
   * @param req Express request
   * @param [replyFn] SSE 或 JSON 回复
   */
  static fromHttp(req: HttpRequest, replyFn?: ReplyFn) {
    const body = req.body || ({} as HttpRequestBody);
    return new AgentMessage({
      content: body.prompt || body.message || body.content || '',
      channel: Channel.HTTP,
      session: {
        id: body.conversationId || body.sessionId || randomUUID(),
        history: body.history || [],
      },
      sender: {
        id: body.userId || req.ip || 'http-user',
        name: body.userName,
        type: 'user',
      },
      metadata: {
        lang: body.lang,
        mode: body.mode, // 手动指定 preset
        context: body.context, // 额外上下文
        stream: body.stream ?? true,
      },
      replyFn,
    });
  }

  /**
   * 从 CLI 输入构建
   * @param input 命令行输入
   */
  static fromCli(input: string, opts: CliOptions = {}) {
    return new AgentMessage({
      content: input,
      channel: Channel.CLI,
      session: { id: opts.sessionId || 'cli-session', history: opts.history || [] },
      sender: { id: 'cli-user', type: 'user' },
      metadata: {
        cwd: opts.cwd || process.cwd(),
        mode: opts.mode,
        ...opts.metadata,
      },
    });
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

  /**
   * 从宿主注入的 MCP-like 请求构建；不实现 Codex MCP server 或插件路由。
   * @param mcpReq normalized tool call request
   * @param [replyFn] 回复函数
   */
  static fromMcp(mcpReq: McpRequest, replyFn?: ReplyFn) {
    return new AgentMessage({
      content: mcpReq.prompt || mcpReq.content || mcpReq.arguments?.prompt || '',
      channel: Channel.MCP,
      session: {
        id: mcpReq.sessionId || randomUUID(),
        history: mcpReq.history || [],
      },
      sender: {
        id: mcpReq.clientId || 'mcp-client',
        name: mcpReq.clientName,
        type: 'user',
      },
      metadata: {
        toolName: mcpReq.toolName,
        arguments: mcpReq.arguments,
        mode: mcpReq.mode,
        ...mcpReq.metadata,
      },
      replyFn,
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
