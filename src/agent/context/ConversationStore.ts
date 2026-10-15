/**
 * ConversationStore — 对话持久化 + 上下文窗口管理
 *
 * 设计:
 * - 每个对话一个 JSONL 文件: .asd/conversations/{id}.jsonl
 * - 索引文件: .asd/conversations/index.json
 * - 按 category 隔离: 'user'(Dashboard) / 'system'(agent runtime)
 * - Token 预算: load 超限时只做截断——保留开头的 [对话摘要]（如有且放得下）与最新消息
 *   （最新一条本身超预算时按预算截断其内容），丢弃中间旧消息并在预算放得下时插入一条
 *   [上下文截断] 标记；不会自动生成摘要。
 *   摘要只在显式调用 summarize() 时生成（需要 AI Provider，当前无生产调用方，已标废弃）：
 *   最近 4 条之外的待摘要消息从最新往前按整条装入 4000 字符提示预算，放不下的较早消息原样保留在
 *   摘要之前并记 info；最新一条待摘要消息本身就超预算时不调用模型、不改写文件并记 warn
 * - 公开面（L6-P25 / 待决事项②）：宿主生产只用 create / append / load；summarize、list、delete、
 *   cleanup、estimateTokens 无生产消费者，已标废弃（deprecated 标签），随事项②“公开面收窄”批次处理
 * - 降级不中断: 持久化失败不影响核心功能，但每条降级路径都必须留下 warn/info 日志
 *   （读取失败、删除失败、索引不可解析、索引条目被过滤、索引写入失败），便于定位“历史为空”的原因
 * - 索引顺序 = 最近活跃优先（LRU）: create 与 append 都把条目移到头部；超过
 *   MAX_CONVERSATIONS 时淘汰 updatedAt 最旧的条目并删除其 JSONL，每次淘汰记 info
 * - 未登记的 conversationId: append 会自动登记（category 'user'），使其受同一容量上限约束，
 *   不再产生索引外、永不清理的孤儿文件
 * - 索引写入: 无 WriteZone 时先写同目录临时文件再 rename，进程中途被杀也不会留下半截索引
 *
 * Token 计算策略:
 *   估算口径以 shared/tokenUtils.estimateTokens 为准（码位高于 U+2E80 的字符，含 CJK，
 *   每字符 0.5 token；其余字符 0.25 token，即约 2 / 4 字符一个 token），本文件不另设比例
 *
 * 文件结构:
 *   .asd/conversations/
 *     index.json   — 对话元数据索引
 *     {id}.jsonl   — 每行一条消息 {role, content, ts}
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WriteZone } from '@alembic/core/io';
import { pathGuard } from '@alembic/core/io';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import {
  estimateTokens as _estimateTokens,
  truncateToTokenBudget,
} from '../../shared/tokenUtils.js';

/** 对话索引中的条目 */
interface ConversationEntry {
  id: string;
  category: 'user' | 'system';
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** 历史中是否含 summarize 写入的 [对话摘要] 消息（摘要前可能有原样保留的较早消息，不一定是首条） */
  hasSummary: boolean;
}

/** 单条对话消息 */
interface ConversationMessage {
  role: string;
  content: string;
}

/** AI Provider 最小接口（用于 summarize） */
interface AiProvider {
  chat(prompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string>;
}

const DEFAULT_TOKEN_BUDGET = 12000; // ~12K tokens 留给历史, 其余给系统提示词和当前消息
const MAX_CONVERSATIONS = 100; // 索引最多保留 100 个对话
const TITLE_MAX_CHARS = 60; // 标题取首条 user 消息的前 60 个字符
const SUMMARY_MIN_MESSAGES = 6; // 少于 6 条不值得摘要
const SUMMARY_KEEP_RECENT = 4; // 最近 4 条原样保留，不进入摘要
const SUMMARY_PROMPT_CHAR_BUDGET = 4000; // 交给模型的待摘要消息块上限（字符，含行间换行）

/** 待摘要消息在提示中的单行表示 */
function summaryLine(message: ConversationMessage): string {
  return `[${message.role}] ${message.content}`;
}

/** summarize 写入的摘要消息（system + `[对话摘要]` 前缀） */
function isSummaryMessage(message: ConversationMessage): boolean {
  return message.role === 'system' && message.content.startsWith('[对话摘要]');
}

/** 把 unknown 错误归一成可打印的 "Name: message"，避免 `(err as Error)` 强转 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    // Node 文件系统错误带 code（ENOENT/EACCES/EISDIR…），一并打印以区分“丢失”与“无权限”
    const code = 'code' in err && typeof err.code === 'string' ? `[${err.code}]` : '';
    return `${err.name}${code}: ${err.message}`;
  }
  return String(err);
}

/** updatedAt 转成可比较的毫秒数；无法解析的时间按最旧处理，使其优先被淘汰 */
function activityTime(entry: ConversationEntry): number {
  const time = Date.parse(entry.updatedAt);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

export class ConversationStore {
  #dir;
  #indexPath;
  #logger;
  readonly #wz: WriteZone | null;

  /** @param projectRoot 用户项目根目录 */
  constructor(projectRoot: string, wz?: WriteZone) {
    this.#dir =
      wz?.runtime('conversations').absolute ?? path.join(projectRoot, '.asd', 'conversations');
    this.#indexPath = path.join(this.#dir, 'index.json');
    this.#logger = Logger.getInstance();
    this.#wz = wz ?? null;
    // 路径安全检查
    pathGuard.assertProjectWriteSafe(this.#dir);
  }

  // ═══════════════════════════════════════════════════════
  //  公共 API
  // ═══════════════════════════════════════════════════════

  /**
   * 创建新对话
   * @param opts.category 对话类别
   * @param [opts.title] 对话标题
   * @returns conversationId
   */
  create({ category = 'user', title = '' }: { category?: 'user' | 'system'; title?: string } = {}) {
    const id = crypto.randomUUID();
    const entry = {
      id,
      category,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      hasSummary: false,
    };

    const index = this.#loadIndex();
    index.unshift(entry);
    this.#evictOverflow(index, 'create');
    this.#saveIndex(index);
    return id;
  }

  /**
   * 追加消息到对话
   *
   * 索引维护（LRU）：已登记的条目更新 updatedAt / messageCount 后移到索引头部；
   * 未登记的 id（宿主把请求体里的 conversationId 原样传入，可能已被淘汰、删除或由客户端生成）
   * 自动登记为 category 'user' 的新条目，同样放到头部并受 MAX_CONVERSATIONS 淘汰约束。
   * id 本身已由 #conversationPath 做路径字符校验，非法 id 在写文件前就被拒绝。
   * @param message
   */
  append(conversationId: string, message: ConversationMessage) {
    try {
      const filePath = this.#conversationPath(conversationId);
      const now = new Date().toISOString();
      const line = JSON.stringify({
        role: message.role,
        content: message.content,
        ts: now,
      });
      if (this.#wz) {
        this.#wz.appendFile(this.#wz.runtime(`conversations/${conversationId}.jsonl`), `${line}\n`);
      } else {
        fs.mkdirSync(this.#dir, { recursive: true });
        fs.appendFileSync(filePath, `${line}\n`, 'utf-8');
      }

      // 更新索引
      const index = this.#loadIndex();
      const position = index.findIndex((e: ConversationEntry) => e.id === conversationId);
      let entry: ConversationEntry;
      if (position >= 0) {
        // 已登记：从原位置取出，稍后放回头部，使索引保持“最近活跃优先”
        [entry] = index.splice(position, 1);
        entry.updatedAt = now;
        entry.messageCount = (entry.messageCount || 0) + 1;
        // 用首条用户消息作为标题
        if (!entry.title && message.role === 'user') {
          entry.title = message.content.substring(0, TITLE_MAX_CHARS);
        }
      } else {
        entry = this.#registerUnknown(conversationId, filePath, message, now);
      }
      index.unshift(entry);
      this.#evictOverflow(index, position >= 0 ? 'append' : 'append-register');
      this.#saveIndex(index);
    } catch (err: unknown) {
      this.#log(
        'warn',
        `[ConversationStore] append failed for conversation ${conversationId}: ${describeError(err)}`
      );
    }
  }

  /**
   * 加载对话历史（带 token 预算控制）
   *
   * 如果历史超出 tokenBudget:
   *   - 保留开头的摘要（如有）
   *   - 截断中间的旧消息
   *   - 保留最新的消息
   *
   * @param [opts.tokenBudget] token 预算
   * @returns 预算内的消息列表 { role, content }[]；文件不存在、为空或读取失败时返回空数组
   */
  load(conversationId: string, { tokenBudget = DEFAULT_TOKEN_BUDGET } = {}) {
    try {
      const filePath = this.#conversationPath(conversationId);
      if (!fs.existsSync(filePath)) {
        // 新对话或已被淘汰/删除：记 info 以便与下方“读取失败”的 warn 区分
        this.#log(
          'info',
          `[ConversationStore] no history file for conversation ${conversationId}; starting with empty history`
        );
        return [];
      }

      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) {
        return [];
      }

      const messages = this.#parseMessages(raw).map(({ role, content }) => ({ role, content }));

      return this.#fitWithinBudget(messages, tokenBudget);
    } catch (err: unknown) {
      // 非法 id、权限不足（EACCES）、路径是目录（EISDIR）等：降级为空历史，但必须留痕
      this.#log(
        'warn',
        `[ConversationStore] history read failed for conversation ${conversationId}; returning empty history: ${describeError(err)}`
      );
      return [];
    }
  }

  /**
   * 对话列表（最近活跃优先：create / append 都会把条目移到头部）
   * @param [opts.category] 按类别过滤
   * @deprecated 无生产消费者（宿主只用 create / append / load）；随待决事项②“公开面收窄”删除，
   *   删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  list({ category, limit = 20 }: { category?: 'user' | 'system'; limit?: number } = {}) {
    const index = this.#loadIndex();
    let results = index;
    if (category) {
      results = results.filter((e: ConversationEntry) => e.category === category);
    }
    return results.slice(0, limit);
  }

  /**
   * 删除对话（历史文件与索引条目）
   * @deprecated 无生产消费者（宿主只用 create / append / load）；随待决事项②“公开面收窄”删除，
   *   删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  delete(conversationId: string) {
    this.#deleteConversationFile(conversationId);
    const index = this.#loadIndex();
    const filtered = index.filter((e: ConversationEntry) => e.id !== conversationId);
    this.#saveIndex(filtered);
  }

  /**
   * 为对话生成压缩摘要（需要 AI）
   *
   * 最近 4 条消息原样保留；其余“待摘要消息”从最新往前按整条装入 4000 字符的提示预算
   * （不截断单条消息），装入的连续一段替换为一条 system 摘要消息。重写后的文件为
   * [未进入提示的较早消息（原样）, 摘要, 最近 4 条]，保持时间顺序：
   *   - 任何消息要么原样留在文件里，要么完整进入了摘要提示，不会未经摘要就被删除；
   *   - 有较早消息因预算未进入提示时记 info（摘要条数 / 待摘要总数 / 原样保留条数）；
   *   - 最新一条待摘要消息本身就超预算时无法摘要：不调用模型、不改写文件，记 warn 并返回 false。
   *
   * @param opts.aiProvider AI Provider 实例
   * @returns 是否成功压缩
   * @deprecated 无生产调用方（MemoryCoordinator 的 conversationLog 自动摘要端口也未被注入）；
   *   保留期间已修复数据丢失，随待决事项②“公开面收窄”决定去留，删除前须附零引用扫描。
   */
  async summarize(conversationId: string, { aiProvider }: { aiProvider: AiProvider }) {
    if (!aiProvider) {
      return false;
    }

    try {
      const filePath = this.#conversationPath(conversationId);
      if (!fs.existsSync(filePath)) {
        return false;
      }

      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) {
        return false;
      }

      const messages = this.#parseMessages(raw);

      if (messages.length < SUMMARY_MIN_MESSAGES) {
        return false; // 太短不需要压缩
      }

      // 保留最近 4 条消息，其余为待摘要消息
      const pending = messages.slice(0, -SUMMARY_KEEP_RECENT);
      const toKeep = messages.slice(-SUMMARY_KEEP_RECENT);
      const { retained, summarized } = this.#selectSummaryWindow(pending);

      if (summarized.length === 0) {
        // 最新一条待摘要消息单条就超出提示预算：截断它会让未进入提示的部分随重写丢失，
        // 因此放弃本次摘要，历史保持原样。
        const newest = pending[pending.length - 1];
        this.#log(
          'warn',
          `[ConversationStore] summary skipped for conversation ${conversationId}: newest pending message (${newest ? summaryLine(newest).length : 0} chars) exceeds the ${SUMMARY_PROMPT_CHAR_BUDGET}-char summary prompt budget; history left unchanged`
        );
        return false;
      }
      if (retained.length > 0) {
        this.#log(
          'info',
          `[ConversationStore] summary prompt budget ${SUMMARY_PROMPT_CHAR_BUDGET} chars for conversation ${conversationId}: summarizing newest ${summarized.length} of ${pending.length} pending message(s); ${retained.length} older message(s) kept verbatim before the summary`
        );
      }

      const summaryPrompt = `请用 2-3 句话总结以下对话的要点（保留关键决策、用户偏好、操作结果）：\n\n${summarized
        .map(summaryLine)
        .join('\n')}`;

      const summary = await aiProvider.chat(summaryPrompt, {
        temperature: 0.3,
        maxTokens: 300,
      });

      if (typeof summary !== 'string' || !summary.trim()) {
        return false;
      }

      // 模型请求期间对话可能追加、删除或被另一次摘要替换；旧快照不能覆盖较新的事实。
      if (fs.readFileSync(filePath, 'utf-8').trim() !== raw) {
        this.#log(
          'info',
          '[ConversationStore] summary skipped: conversation changed during generation'
        );
        return false;
      }

      // 重写对话文件: 未进入提示的较早消息（原样） + 摘要 + 最近消息
      const newMessages = [
        ...retained,
        { role: 'system', content: `[对话摘要] ${summary.trim()}`, ts: new Date().toISOString() },
        ...toKeep,
      ];

      const newContent = `${newMessages.map((m) => JSON.stringify(m)).join('\n')}\n`;
      if (this.#wz) {
        this.#wz.writeFile(this.#wz.runtime(`conversations/${conversationId}.jsonl`), newContent);
      } else {
        fs.writeFileSync(filePath, newContent, 'utf-8');
      }

      // 更新索引
      const index = this.#loadIndex();
      const entry = index.find((e: ConversationEntry) => e.id === conversationId);
      if (entry) {
        entry.hasSummary = true;
        entry.messageCount = newMessages.length;
        this.#saveIndex(index);
      }

      this.#log(
        'info',
        `[ConversationStore] summarized conversation ${conversationId}: ${messages.length} → ${newMessages.length} messages`
      );
      return true;
    } catch (err: unknown) {
      this.#log(
        'warn',
        `[ConversationStore] summarize failed for conversation ${conversationId}: ${describeError(err)}`
      );
      return false;
    }
  }

  /**
   * 清理过期对话
   * @param [opts.maxAgeDays=30] 超过此天数的对话将被删除
   * @param [opts.category] 只清理特定类别
   * @returns 清理结果 { deleted }：本次删除的对话数
   * @deprecated 无生产消费者（容量由 create / append 的 LRU 淘汰负责）；随待决事项②“公开面收窄”删除，
   *   删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  cleanup({
    maxAgeDays = 30,
    category,
  }: {
    maxAgeDays?: number;
    category?: 'user' | 'system';
  } = {}) {
    const index = this.#loadIndex();
    const cutoff = Date.now() - maxAgeDays * 86400000;
    let deleted = 0;

    const kept = index.filter((entry: ConversationEntry) => {
      if (category && entry.category !== category) {
        return true;
      }
      const updatedAt = new Date(entry.updatedAt).getTime();
      if (updatedAt < cutoff) {
        this.#deleteConversationFile(entry.id);
        deleted++;
        return false;
      }
      return true;
    });

    if (deleted > 0) {
      this.#saveIndex(kept);
      this.#log('info', `[ConversationStore] cleaned up ${deleted} old conversations`);
    }

    return { deleted };
  }

  /**
   * 估算 token 数 — 委托给共享 tokenUtils（CJK 感知）
   * @deprecated 无外部消费者，本类内部也直接用 tokenUtils.estimateTokens；随待决事项②“公开面收窄”删除，
   *   删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  estimateTokens(text: string) {
    return _estimateTokens(text);
  }

  // ═══════════════════════════════════════════════════════
  //  内部方法
  // ═══════════════════════════════════════════════════════

  /**
   * 选出本次进入摘要提示的待摘要消息（summarize 专用）
   *
   * 从最新一条往前逐条累加 `[role] content` 的长度（行间换行计 1），装不下下一条即停：
   * 进入提示的是待摘要消息末尾连续的一段，前面的较早消息原样保留，从而保持时间顺序。
   * 单条消息不截断——截断后被删掉的部分既不在提示里也不在文件里，就是数据丢失。
   */
  #selectSummaryWindow(pending: ConversationMessage[]): {
    retained: ConversationMessage[];
    summarized: ConversationMessage[];
  } {
    let used = 0;
    let start = pending.length;
    for (let i = pending.length - 1; i >= 0; i--) {
      const cost = summaryLine(pending[i]).length + (start < pending.length ? 1 : 0);
      if (used + cost > SUMMARY_PROMPT_CHAR_BUDGET) {
        break;
      }
      used += cost;
      start = i;
    }
    return { retained: pending.slice(0, start), summarized: pending.slice(start) };
  }

  /**
   * 将消息列表裁剪到 token 预算内
   * 策略: 保留首条摘要(如有) + 最新消息，丢弃中间旧消息
   */
  #fitWithinBudget(messages: ConversationMessage[], tokenBudget: number) {
    const budget =
      tokenBudget === Infinity
        ? Infinity
        : Number.isFinite(tokenBudget)
          ? Math.max(0, Math.floor(tokenBudget))
          : DEFAULT_TOKEN_BUDGET;
    if (messages.length === 0 || budget === 0) {
      return [];
    }
    const counts = messages.map((message) => _estimateTokens(message.content));
    if (counts.reduce((sum, count) => sum + count, 0) <= budget) {
      return messages;
    }
    const marker = (dropped: number) =>
      `[上下文截断] 省略了 ${dropped} 条较早的消息以适应上下文窗口。`;
    const markerTokens = _estimateTokens(marker(messages.length));
    const reserve = markerTokens < budget / 2 ? markerTokens : 0;
    let remaining = budget - reserve;
    const result: ConversationMessage[] = [];
    const tail: ConversationMessage[] = [];
    let firstIndex = 0;
    // 摘要不能挤掉最近一条消息；不足时先保留最近内容，再用日志说明省略。
    if (isSummaryMessage(messages[0]) && counts[0] + counts[counts.length - 1] <= remaining) {
      result.push(messages[0]);
      remaining -= counts[0];
      firstIndex = 1;
    }
    for (let i = messages.length - 1; i >= firstIndex; i--) {
      if (counts[i] > remaining) {
        if (tail.length === 0 && remaining > 0) {
          tail.unshift({
            ...messages[i],
            content: truncateToTokenBudget(messages[i].content, remaining),
          });
        }
        break;
      }
      tail.unshift(messages[i]);
      remaining -= counts[i];
    }
    const dropped = messages.length - result.length - tail.length;
    if (dropped > 0 && reserve > 0) {
      result.push({ role: 'system', content: marker(dropped) });
    }
    result.push(...tail);
    this.#log(
      'info',
      `[ConversationStore] history budget=${budget}; omitted=${dropped}; kept=${tail.length}`
    );
    return result;
  }

  #parseMessages(raw: string): ConversationMessage[] {
    const messages: ConversationMessage[] = [];
    let invalid = 0;
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          invalid++;
          continue;
        }
        const record = value as Record<string, unknown>;
        if (
          typeof record.role !== 'string' ||
          !record.role.trim() ||
          typeof record.content !== 'string'
        ) {
          invalid++;
          continue;
        }
        messages.push({ ...record, role: record.role, content: record.content });
      } catch (err: unknown) {
        if (!(err instanceof SyntaxError)) {
          this.#log('warn', '[ConversationStore] unreadable message record ignored');
        }
        invalid++;
      }
    }
    if (invalid > 0) {
      this.#log('warn', `[ConversationStore] ignored ${invalid} invalid message record(s)`);
    }
    return messages;
  }

  #log(level: 'info' | 'warn', message: string): void {
    observeSafely(
      () => this.#logger[level](message),
      () => undefined
    );
  }

  #conversationPath(id: string) {
    if (!id || /[/\\\0]/u.test(id) || id === '.' || id === '..') {
      throw new Error('Invalid conversation id');
    }
    return path.join(this.#dir, `${id}.jsonl`);
  }

  /**
   * 容量淘汰（create / append / append 自动登记共用）
   *
   * 调用方已把本次写入的条目放在 index[0]；该条目不参与淘汰，避免一次写入删掉自己刚写的历史。
   * 其余条目按 updatedAt 降序（最近活跃优先）稳定排序，超出 MAX_CONVERSATIONS 的尾部即
   * 最久未活跃的对话：从索引移除并删除 JSONL，每个都记 info（id、updatedAt、触发原因）。
   * 正常情况下 LRU 维护已保证顺序；排序用于兼容旧版按创建顺序写出的索引。
   */
  #evictOverflow(index: ConversationEntry[], trigger: 'create' | 'append' | 'append-register') {
    if (index.length <= MAX_CONVERSATIONS) {
      return;
    }
    const [current, ...rest] = index;
    // Array.prototype.sort 是稳定排序：同一毫秒内写入的条目保持原有 LRU 相对顺序
    rest.sort((a, b) => {
      const left = activityTime(a);
      const right = activityTime(b);
      if (left === right) {
        return 0;
      }
      return right > left ? 1 : -1;
    });
    const evicted = rest.splice(MAX_CONVERSATIONS - 1);
    index.splice(0, index.length, current, ...rest);
    for (const old of evicted) {
      this.#log(
        'info',
        `[ConversationStore] evicted conversation ${old.id} (updatedAt=${old.updatedAt}) on ${trigger}: index exceeded ${MAX_CONVERSATIONS} conversations, least recently active entry removed with its history file`
      );
      this.#deleteConversationFile(old.id);
    }
  }

  /**
   * append 遇到索引外的 id 时构造新条目。
   *
   * 历史文件可能早已存在（旧版本留下的孤儿文件，或被外部写入），因此按文件实际内容
   * 计算 messageCount，并取首条 user 消息前 60 字作为标题；读不到时退回只计本条消息。
   */
  #registerUnknown(
    id: string,
    filePath: string,
    message: ConversationMessage,
    now: string
  ): ConversationEntry {
    let messageCount = 1;
    let title = message.role === 'user' ? message.content.substring(0, TITLE_MAX_CHARS) : '';
    let hasSummary = false;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      const history = raw ? this.#parseMessages(raw) : [];
      if (history.length > 0) {
        messageCount = history.length;
        const firstUser = history.find((m) => m.role === 'user');
        title = firstUser ? firstUser.content.substring(0, TITLE_MAX_CHARS) : '';
        // summarize 在预算放不下时会把较早消息原样保留在摘要之前，摘要不一定是首条，
        // 因此按“历史中是否存在摘要消息”判定，与 summarize 写入的 hasSummary 保持一致。
        hasSummary = history.some(isSummaryMessage);
      }
    } catch (err: unknown) {
      this.#log(
        'warn',
        `[ConversationStore] could not read history of unregistered conversation ${id}; registering with the appended message only: ${describeError(err)}`
      );
    }
    this.#log(
      'info',
      `[ConversationStore] registered unknown conversation ${id} on append (category=user, messageCount=${messageCount}): id was not in the index`
    );
    return {
      id,
      category: 'user',
      title,
      createdAt: now,
      updatedAt: now,
      messageCount,
      hasSummary,
    };
  }

  #deleteConversationFile(id: string) {
    try {
      const filePath = this.#conversationPath(id);
      if (this.#wz) {
        const target = this.#wz.runtime(`conversations/${id}.jsonl`);
        if (fs.existsSync(target.absolute)) {
          this.#wz.remove(target);
        }
      } else {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (err: unknown) {
      // 删除失败不阻断索引更新，但文件会残留在目录里，必须留痕以便人工清理
      this.#log(
        'warn',
        `[ConversationStore] history file delete failed for conversation ${id}; file may remain on disk: ${describeError(err)}`
      );
    }
  }

  #loadIndex(): ConversationEntry[] {
    let value: unknown;
    try {
      if (!fs.existsSync(this.#indexPath)) {
        // 首次使用：没有索引文件是正常状态，不记日志
        return [];
      }
      value = JSON.parse(fs.readFileSync(this.#indexPath, 'utf-8'));
    } catch (err: unknown) {
      // 索引截断/损坏或不可读：只能以空索引继续，下一次写入会覆盖旧索引，旧条目从列表中消失
      // 且其 JSONL 不再受淘汰/cleanup 管理，因此必须 warn 以便定位。
      this.#log(
        'warn',
        `[ConversationStore] index unreadable; continuing with an empty index (existing entries will be dropped on next save): ${describeError(err)}`
      );
      return [];
    }
    if (!Array.isArray(value)) {
      this.#log('warn', '[ConversationStore] invalid index shape; using an empty index');
      return [];
    }
    const entries = value.filter(
      (entry): entry is ConversationEntry =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        !/[/\\\0]/u.test(entry.id) &&
        typeof entry.title === 'string' &&
        typeof entry.createdAt === 'string' &&
        typeof entry.updatedAt === 'string' &&
        (entry.category === 'user' || entry.category === 'system') &&
        Number.isFinite(entry.messageCount) &&
        typeof entry.hasSummary === 'boolean'
    );
    const dropped = value.length - entries.length;
    if (dropped > 0) {
      this.#log(
        'warn',
        `[ConversationStore] dropped ${dropped} invalid index entr${dropped === 1 ? 'y' : 'ies'} (kept ${entries.length}); they will be removed from the index on next save`
      );
    }
    return entries;
  }

  #saveIndex(index: ConversationEntry[]) {
    const payload = JSON.stringify(index, null, 2);
    if (this.#wz) {
      // WriteZone 分支沿用 Core 的写入原语（守卫 + 写文件）；原子性由 Core 侧决定，不在本包范围
      try {
        this.#wz.writeFile(this.#wz.runtime('conversations/index.json'), payload);
      } catch (err: unknown) {
        this.#log('warn', `[ConversationStore] index save failed: ${describeError(err)}`);
      }
      return;
    }
    // 无 WriteZone（宿主生产路径）：先写同目录临时文件再 rename。rename 在同一文件系统内是原子的，
    // 写到一半被杀只会留下临时文件，旧索引保持完整；临时文件名带 pid，避免多进程互相覆盖。
    const tempPath = `${this.#indexPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(this.#dir, { recursive: true });
      fs.writeFileSync(tempPath, payload, 'utf-8');
      fs.renameSync(tempPath, this.#indexPath);
    } catch (err: unknown) {
      this.#log(
        'warn',
        `[ConversationStore] index save failed; previous index left in place: ${describeError(err)}`
      );
      this.#removeTempIndex(tempPath);
    }
  }

  /** 写索引失败后清理临时文件；清理本身失败只记 warn，不影响调用方 */
  #removeTempIndex(tempPath: string) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (err: unknown) {
      this.#log(
        'warn',
        `[ConversationStore] could not remove temporary index file after failed save: ${describeError(err)}`
      );
    }
  }
}

export default ConversationStore;
