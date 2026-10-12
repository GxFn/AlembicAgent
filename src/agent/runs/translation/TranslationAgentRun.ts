import { observeSafely } from '#shared/observers.js';
import type { AgentService } from '../../service/AgentService.js';
import { buildSystemTaskRunInput, type SystemTaskRunSignals } from '../systemTaskRunInput.js';

export interface TranslationJsonResult {
  summaryEn: string;
  usageGuideEn: string;
  error?: string;
}

export async function runTranslationJson({
  agentService,
  summary,
  usageGuide,
  onParseError,
  abortSignal,
  shouldAbort,
  timeoutMs,
}: {
  agentService: AgentService;
  summary?: string | null;
  usageGuide?: string | null;
  onParseError?: (err: unknown) => void;
} & SystemTaskRunSignals): Promise<TranslationJsonResult> {
  if (!summary && !usageGuide) {
    return { summaryEn: '', usageGuideEn: '' };
  }

  // 宿主取消/期限信号（L8-C01，例如 /translate 请求断开）只在传入时并入 execution；
  // 中止后的 run 走下方既有的非 success 分支：返回原文并在 error 中带出中止状态。
  const result = await agentService.run(
    buildSystemTaskRunInput({
      profileId: 'translation-json',
      params: { summary: summary || '', usageGuide: usageGuide || '' },
      message: {
        role: 'internal',
        content: `翻译以下内容为英文，输出纯 JSON：\nsummary: ${summary || '(空)'}\nusageGuide: ${usageGuide || '(空)'}`,
        metadata: { task: 'translation-json' },
      },
      context: {
        source: 'system-workflow',
        runtimeSource: 'system',
        lang: 'en',
      },
      signals: { abortSignal, shouldAbort, timeoutMs },
    })
  );

  if (result.status !== 'success') {
    return {
      summaryEn: summary || '',
      usageGuideEn: usageGuide || '',
      error: result.reply || `Translation failed with status: ${result.status}`,
    };
  }

  return parseTranslationJson(
    result.reply,
    {
      summaryEn: summary || '',
      usageGuideEn: usageGuide || '',
    },
    onParseError
  );
}

function parseTranslationJson(
  text: string | null | undefined,
  fallback: TranslationJsonResult,
  onParseError?: (err: unknown) => void
): TranslationJsonResult {
  if (!text) {
    return fallback;
  }
  try {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return normalizeTranslation(JSON.parse(codeBlockMatch[1].trim()), fallback);
    }
    const objMatch = text.match(/(\{[\s\S]*\})/);
    if (objMatch) {
      return normalizeTranslation(JSON.parse(objMatch[1].trim()), fallback);
    }
    return normalizeTranslation(JSON.parse(text.trim()), fallback);
  } catch (err: unknown) {
    observeSafely(
      () => onParseError?.(err),
      () => undefined
    );
    return fallback;
  }
}

function normalizeTranslation(
  value: unknown,
  fallback: TranslationJsonResult
): TranslationJsonResult {
  if (!value || typeof value !== 'object') {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  return {
    summaryEn: typeof record.summaryEn === 'string' ? record.summaryEn : fallback.summaryEn,
    usageGuideEn:
      typeof record.usageGuideEn === 'string' ? record.usageGuideEn : fallback.usageGuideEn,
  };
}
