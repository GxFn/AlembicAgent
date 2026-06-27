import {
  assertPlanSelectionShape,
  type PlanSelection,
  type PlanStageId,
} from '@alembic/core/plans';
import type { AgentService } from '../../service/AgentService.js';

export interface RunPlanAgentInput {
  agentService: Pick<AgentService, 'run'>;
  generationStage: PlanStageId;
  projectContextFacts: unknown;
}

export async function runPlanAgent({
  agentService,
  generationStage,
  projectContextFacts,
}: RunPlanAgentInput): Promise<PlanSelection> {
  const result = await agentService.run({
    profile: { id: 'plan-selection' },
    params: { generationStage, projectContextFacts },
    message: {
      role: 'internal',
      content: buildPlanSelectionPrompt({ generationStage, projectContextFacts }),
      metadata: { task: 'plan-selection', generationStage },
    },
    context: {
      source: 'system-workflow',
      runtimeSource: 'system',
      promptContext: { generationStage, projectContextFacts },
    },
    execution: { toolChoiceOverride: 'none' },
    presentation: { responseShape: 'system-task-result' },
  });

  if (result.status !== 'success') {
    throw new Error(
      `Plan agent failed with status ${result.status}: ${result.reply || 'empty reply'}`
    );
  }

  return parsePlanSelection(result.reply);
}

function buildPlanSelectionPrompt({
  generationStage,
  projectContextFacts,
}: {
  generationStage: PlanStageId;
  projectContextFacts: unknown;
}) {
  return [
    `为 generationStage=${generationStage} 选择本轮 PlanSelection。`,
    '只能输出纯 JSON object，字段必须匹配 @alembic/core/plans 的 PlanSelection。',
    '不要调用工具，不要写入状态，不要回退到全量作为失败掩盖。',
    'ProjectContext facts:',
    JSON.stringify(projectContextFacts, null, 2),
  ].join('\n');
}

export function parsePlanSelection(reply: string | null | undefined): PlanSelection {
  if (!reply || reply.trim().length === 0) {
    throw new Error('Plan agent returned an empty reply');
  }
  const selection = parseJsonObjectFromReply(reply);
  assertPlanSelectionShape(selection);
  return selection;
}

function parseJsonObjectFromReply(reply: string): unknown {
  const trimmed = reply.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (codeBlockMatch) {
    return parseJson(codeBlockMatch[1].trim());
  }
  try {
    return parseJson(trimmed);
  } catch (err: unknown) {
    const objectMatch = trimmed.match(/(\{[\s\S]*\})/u);
    if (objectMatch) {
      return parseJson(objectMatch[1]);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err: unknown) {
    throw new Error(
      `Plan agent returned invalid JSON: ${err instanceof Error ? err.message : err}`
    );
  }
}
