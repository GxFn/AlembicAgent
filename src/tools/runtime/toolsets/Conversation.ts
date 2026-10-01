/**
 * 对话 — 用户与 Alembic 知识助手的交互。
 */

import fs from 'node:fs';
import path from 'node:path';
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

    const soulPath = opts.soulPath || path.resolve(PACKAGE_ROOT, 'SOUL.md');
    try {
      this.#soulContent = fs.existsSync(soulPath)
        ? fs.readFileSync(soulPath, 'utf-8').trim()
        : null;
    } catch {
      this.#soulContent = null;
    }
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
