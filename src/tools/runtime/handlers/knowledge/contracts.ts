/** 知识工具内部消费的宿主端口与来源词汇；Core production contract 仍从包入口接入。 */
import type { RecipeProductionPort } from '@alembic/core';

export const AGENT_RUNTIME_SOURCE = 'alembic-agent';

export const LEGACY_IDE_AGENT_SOURCE = 'ide-agent';

export interface DimensionMetaLike {
  id: string;
  outputType?: unknown;
  allowedKnowledgeTypes?: unknown;
}

/* ================================================================== */
/*  DI Interface Types                                                 */
/* ================================================================== */

export interface SearchResult {
  id: string;
  title: string;
  kind?: string;
  score: number;
  content?: string;
  description?: string;
}

export interface SearchEngineLike {
  search(
    query: string,
    opts: { limit: number; kind?: string; category?: string }
  ): Promise<SearchResult[]>;
}

export type RecipeGatewayLike = RecipeProductionPort;

export interface KnowledgeRepoLike {
  getById(id: string): Promise<Record<string, unknown> | null>;
  reject(id: string, reason: string): Promise<void>;
  update(id: string, data: Record<string, unknown>): Promise<void>;
  score(id: string, score: number): Promise<void>;
  validate(id: string): Promise<unknown>;
}
