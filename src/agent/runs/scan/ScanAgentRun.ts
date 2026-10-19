import { SCAN_TASK_CONFIGS } from '../../prompts/scanPrompts.js';
import type { FileCacheEntry } from '../../runtime/AgentRuntimeTypes.js';
import type { AgentRunSource } from '../../service/AgentRunContracts.js';
import type { AgentService } from '../../service/AgentService.js';
import type { SystemRunContextFactory } from '../../service/SystemRunContextFactory.js';
import { buildSystemTaskRunInput, type SystemTaskRunSignals } from '../systemTaskRunInput.js';
import { projectScanRunResult, type ScanKnowledgeProjection } from './ScanRunProjection.js';

interface ScanTaskConfig {
  fallback: (label: string) => Record<string, unknown>;
  analyzeMaxIterations: number;
}

export interface ScanAgentFileInput {
  name?: string;
  relativePath?: string;
  content?: string;
  language?: string;
}

/** abortSignal / shouldAbort / timeoutMs：宿主可选的取消与期限信号（L8-C01），只在传入时并入 execution。 */
export interface RunScanAgentTaskOptions extends SystemTaskRunSignals {
  agentService: AgentService;
  systemRunContextFactory: SystemRunContextFactory;
  label?: string;
  files?: ScanAgentFileInput[] | null;
  task?: 'extract' | 'summarize';
  lang?: string | null;
  comprehensive?: boolean;
  source?: AgentRunSource;
  onParseError?: (err: unknown) => void;
}

export async function runScanAgentTask({
  agentService,
  systemRunContextFactory,
  label,
  files,
  task = 'extract',
  lang,
  comprehensive = false,
  source = 'system-workflow',
  onParseError,
  abortSignal,
  shouldAbort,
  timeoutMs,
}: RunScanAgentTaskOptions): Promise<ScanKnowledgeProjection> {
  const taskConfig = Object.hasOwn(SCAN_TASK_CONFIGS, task)
    ? (SCAN_TASK_CONFIGS as Record<string, ScanTaskConfig>)[task]
    : undefined;
  if (!taskConfig) {
    throw new Error(
      `Unknown scan task: "${task}". Available: ${Object.keys(SCAN_TASK_CONFIGS).join(', ')}`
    );
  }

  const runLabel = label || 'code';
  const fileCache = toScanFileCache(files);
  // tracker 预算与 scanPipeline 的 analyze 阶段预算共用 SCAN_TASK_CONFIGS 中的同一上限，避免两处漂移。
  const analyzeMaxIter = taskConfig.analyzeMaxIterations;
  const systemCtx = systemRunContextFactory.createSystemContext({
    budget: { maxIterations: analyzeMaxIter },
    trackerStrategy: 'analyst',
    label: `${task}:${runLabel}`,
    lang: lang || undefined,
  });

  // 中止/超时后的 run 状态不是 success，由 projectScanRunResult 投影成带 error 的结果，不冒充成功。
  const runResult = await agentService.run(
    buildSystemTaskRunInput({
      profileId: task === 'summarize' ? 'scan-summarize' : 'scan-extract',
      params: { task, label: runLabel, comprehensive, files: fileCache },
      message: {
        role: 'internal',
        content: `分析 "${runLabel}" 的 ${fileCache?.length || 0} 个源文件。${comprehensive ? '请进行深度分析。' : ''}`,
        metadata: { label: runLabel, task },
      },
      context: {
        source,
        runtimeSource: 'system',
        lang: lang || null,
        fileCache,
        // createSystemContext 返回 SystemRunContextProjection：systemRunContext 与 scopeId 带具体类型，
        // 字段改名或不再写入时这里直接编译失败，而不是把 undefined 传进运行上下文丢失维度 scope。
        systemRunContext: systemCtx.systemRunContext,
        strategyContext: systemCtx,
        promptContext: { dimensionScopeId: systemCtx.scopeId },
      },
      signals: { abortSignal, shouldAbort, timeoutMs },
    })
  );

  return projectScanRunResult({
    label: runLabel,
    task,
    result: runResult,
    fallback: taskConfig.fallback,
    onParseError,
  });
}

export function toScanFileCache(files?: ScanAgentFileInput[] | null): FileCacheEntry[] | null {
  if (!files?.length) {
    return null;
  }
  return files.map((file, index) => {
    const name = file.name || file.relativePath || `file-${index + 1}`;
    return {
      relativePath: file.relativePath || name,
      name,
      content: file.content || '',
    };
  });
}
