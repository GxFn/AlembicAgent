import type { ToolSchema, UnifiedMessage } from '#ai/AiProvider.js';
import { estimateTokens } from '#shared/tokenUtils.js';
import type { LLMInputAssembly } from './LLMInputAssembly.js';

export interface PromptSectionMeasurement {
  id: string;
  title: string;
  charCount: number;
  estimatedTokens: number;
}

export interface DuplicatePromptBlock {
  normalized: string;
  occurrences: number;
  estimatedDuplicateTokens: number;
  sources: string[];
}

export interface PromptTextMeasurement {
  charCount: number;
  duplicateBlockRatio: number;
  duplicateBlocks: DuplicatePromptBlock[];
  duplicateEstimatedTokens: number;
  estimatedTokens: number;
  measuredBlockTokens: number;
}

export interface LLMInputAssemblyMeasurement extends PromptTextMeasurement {
  inputLayerEstimatedTokens: number;
  providerHistoryEstimatedTokens: number;
  providerMessageEstimatedTokens: number;
  sectionMeasurements: PromptSectionMeasurement[];
  stageProfile: LLMInputAssembly['stageProfile'];
  systemPromptEstimatedTokens: number;
  toolSchemaEstimatedTokens: number;
}

interface MeasureOptions {
  minimumBlockChars?: number;
}

interface PromptBlockOccurrence {
  normalized: string;
  source: string;
}

const DEFAULT_MINIMUM_BLOCK_CHARS = 48;

export function estimatePromptTokens(text: string): number {
  return estimateTokens(text);
}

export function measurePromptText(
  text: string,
  options: MeasureOptions = {}
): PromptTextMeasurement {
  const blocks = collectPromptBlocks([{ source: 'text', text }], options);
  return {
    charCount: text.length,
    estimatedTokens: estimatePromptTokens(text),
    ...measureDuplicateBlocks(blocks),
  };
}

export function measureLlmInputAssembly(
  assembly: LLMInputAssembly,
  options: MeasureOptions = {}
): LLMInputAssemblyMeasurement {
  const sectionMeasurements = assembly.sections.map((section) => ({
    id: section.id,
    title: section.title,
    charCount: section.content.length,
    estimatedTokens: estimatePromptTokens(section.content),
  }));
  const providerHistoryText = assembly.messages.map(formatMessageForMeasurement).join('\n\n');
  const inputLayerText = assembly.inputLayerMessage
    ? formatMessageForMeasurement(assembly.inputLayerMessage)
    : '';
  const providerMessageText = assembly.providerMessages
    .map(formatMessageForMeasurement)
    .join('\n\n');
  const toolSchemaText = assembly.tools?.length
    ? formatToolSchemasForMeasurement(assembly.tools)
    : '';
  const measuredText = [
    assembly.systemPrompt,
    providerMessageText,
    toolSchemaText,
    ...assembly.sections.map((section) => section.content),
  ]
    .filter(Boolean)
    .join('\n\n');
  const blocks = collectPromptBlocks(
    [
      ...assembly.sections.map((section) => ({
        source: `section:${section.id}`,
        text: section.content,
      })),
      ...(toolSchemaText ? [{ source: 'toolSchemas', text: toolSchemaText }] : []),
    ],
    options
  );
  const duplicateMeasurement = measureDuplicateBlocks(blocks);

  return {
    charCount: measuredText.length,
    duplicateBlockRatio: duplicateMeasurement.duplicateBlockRatio,
    duplicateBlocks: duplicateMeasurement.duplicateBlocks,
    duplicateEstimatedTokens: duplicateMeasurement.duplicateEstimatedTokens,
    estimatedTokens: estimatePromptTokens(measuredText),
    inputLayerEstimatedTokens: estimatePromptTokens(inputLayerText),
    measuredBlockTokens: duplicateMeasurement.measuredBlockTokens,
    providerHistoryEstimatedTokens: estimatePromptTokens(providerHistoryText),
    providerMessageEstimatedTokens: estimatePromptTokens(providerMessageText),
    sectionMeasurements,
    stageProfile: assembly.stageProfile,
    systemPromptEstimatedTokens: estimatePromptTokens(assembly.systemPrompt),
    toolSchemaEstimatedTokens: estimatePromptTokens(toolSchemaText),
  };
}

function measureDuplicateBlocks(blocks: PromptBlockOccurrence[]) {
  const occurrences = new Map<string, string[]>();
  for (const block of blocks) {
    const sources = occurrences.get(block.normalized) || [];
    sources.push(block.source);
    occurrences.set(block.normalized, sources);
  }

  const duplicateBlocks = [...occurrences.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([normalized, sources]) => ({
      normalized,
      occurrences: sources.length,
      estimatedDuplicateTokens: estimatePromptTokens(normalized) * (sources.length - 1),
      sources,
    }))
    .sort((a, b) => b.estimatedDuplicateTokens - a.estimatedDuplicateTokens);
  const measuredBlockTokens = blocks.reduce(
    (sum, block) => sum + estimatePromptTokens(block.normalized),
    0
  );
  const duplicateEstimatedTokens = duplicateBlocks.reduce(
    (sum, block) => sum + block.estimatedDuplicateTokens,
    0
  );

  return {
    duplicateBlockRatio:
      measuredBlockTokens > 0 ? duplicateEstimatedTokens / measuredBlockTokens : 0,
    duplicateBlocks,
    duplicateEstimatedTokens,
    measuredBlockTokens,
  };
}

function collectPromptBlocks(
  items: Array<{ source: string; text: string }>,
  options: MeasureOptions
): PromptBlockOccurrence[] {
  const minimumBlockChars = options.minimumBlockChars ?? DEFAULT_MINIMUM_BLOCK_CHARS;
  const blocks: PromptBlockOccurrence[] = [];
  for (const item of items) {
    const candidates = [...item.text.split(/\n{2,}/), ...item.text.split('\n')];
    for (const candidate of candidates) {
      const normalized = normalizePromptBlock(candidate);
      if (normalized.length >= minimumBlockChars) {
        blocks.push({ normalized, source: item.source });
      }
    }
  }
  return blocks;
}

function normalizePromptBlock(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/\s+/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim()
    .toLowerCase();
}

function formatMessageForMeasurement(message: UnifiedMessage): string {
  return [
    `role:${message.role}`,
    message.name ? `name:${message.name}` : null,
    message.content || null,
    message.toolCallId ? `toolCallId:${message.toolCallId}` : null,
    message.toolCalls?.length ? `toolCalls:${JSON.stringify(message.toolCalls)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatToolSchemasForMeasurement(tools: ToolSchema[]): string {
  return tools
    .map((tool) =>
      [
        `tool:${tool.name}`,
        tool.description || null,
        tool.parameters ? JSON.stringify(tool.parameters) : null,
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
}
