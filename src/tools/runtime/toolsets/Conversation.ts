/**
 * 对话 — 用户与 Alembic 知识助手的交互。
 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { PACKAGE_ROOT } from '../../../shared/packageAssets.js';
import { RECIPE_PRODUCTION_PROFILE_PROMPT } from '../recipeProductionContract.js';
import { RuntimeCapability } from './RuntimeCapability.js';

interface ConversationOpts {
  soulPath?: string;
  projectBriefing?: string | null;
  [key: string]: unknown;
}

interface ContextInput {
  projectBriefing?: string | null;
  [key: string]: unknown;
}

/**
 * 读取 SOUL 人格资源；缺失或读取失败时返回 null，并留下一条可定位的诊断。
 *
 * soulPath 来源分两种：option（调用方显式传入）与 default（Agent 包根下的 SOUL.md）。
 * 当前 Agent 包根没有 SOUL.md、宿主也不传 soulPath，资源归属仍待决定，所以默认路径
 * 缺失是已知状态，只记 info；显式路径缺失或任何读取失败属于配置/环境问题，记 warn。
 * 诊断只含来源、路径、是否存在与错误类别，绝不记录文件内容。
 */
function loadSoulContent(optionPath: unknown): string | null {
  // 外部选项先归一化：非字符串或空串按未传处理，与历史 `opts.soulPath ||` 语义一致。
  const explicit = typeof optionPath === 'string' && optionPath.length > 0 ? optionPath : null;
  const source = explicit ? 'option' : 'default';
  const soulPath = explicit ?? path.resolve(PACKAGE_ROOT, 'SOUL.md');
  const exists = fs.existsSync(soulPath);
  if (!exists) {
    const message = `[Conversation] SOUL persona not loaded: source=${source} exists=false soulPath=${soulPath}`;
    const meta = { source, exists, soulPath };
    if (source === 'option') {
      Logger.getInstance().warn(message, meta);
    } else {
      Logger.getInstance().info(message, meta);
    }
    return null;
  }
  try {
    return fs.readFileSync(soulPath, 'utf-8').trim();
  } catch (err: unknown) {
    const errorKind =
      err instanceof Error
        ? 'code' in err && typeof err.code === 'string'
          ? err.code
          : err.name
        : typeof err;
    Logger.getInstance().warn(
      `[Conversation] SOUL persona read failed: source=${source} exists=true soulPath=${soulPath} error=${errorKind}`,
      { source, exists, soulPath, error: errorKind }
    );
    return null;
  }
}

/**
 * 对话能力只提供工具集与静态上下文（生产契约、SOUL、项目概况）。
 *
 * 它不持有记忆协调器：记忆注入与工具观察缓存由运行循环按「本次运行」的协调器负责
 * （buildDynamicMemoryPrompt / recordObservation）。能力实例由 builder 跨运行复用，
 * 在这里持有协调器会让不同会话共用同一份记忆。
 */
export class Conversation extends RuntimeCapability {
  #soulContent: string | null;
  #projectBriefing: string | null;

  constructor(opts: ConversationOpts = {}) {
    super();
    this.#projectBriefing = (opts.projectBriefing as string) || null;

    this.#soulContent = loadSoulContent(opts.soulPath);
  }

  get name() {
    return 'conversation';
  }
  get description() {
    return 'User conversation with knowledge assistant';
  }

  get allowedTools() {
    return {
      code: ['search', 'read', 'outline', 'structure'],
      knowledge: ['search', 'detail', 'submit'],
      graph: ['overview', 'query'],
      memory: ['save', 'recall'],
      meta: ['tools'],
    };
  }

  buildContext(context: ContextInput) {
    const parts: string[] = [];

    parts.push(RECIPE_PRODUCTION_PROFILE_PROMPT);

    if (this.#soulContent) {
      parts.push(this.#soulContent);
    }

    const briefing = (context.projectBriefing as string) || this.#projectBriefing;
    if (briefing) {
      parts.push(`## 项目概况\n${briefing}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }
}
