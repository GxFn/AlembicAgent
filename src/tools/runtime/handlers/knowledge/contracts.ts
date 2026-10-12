/** 知识工具内部消费的宿主端口与来源词汇；Core production contract 仍从包入口接入。 */
import type { RecipeProductionPort } from '@alembic/core';
import type { KnowledgeSearchPort, KnowledgeSearchResult } from '#tools/kernel/knowledge.js';

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

export type SearchResult = KnowledgeSearchResult;
export type SearchEngineLike = KnowledgeSearchPort;

export type RecipeGatewayLike = RecipeProductionPort;
