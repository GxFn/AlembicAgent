import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type { AgentService } from '../../service/AgentService.js';
import {
  type JsonObjectParseOutcome,
  parseJsonObjectWithDiagnostics,
} from '../../utils/jsonReply.js';
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

type TranslationField = 'summaryEn' | 'usageGuideEn';

const TRANSLATION_FIELDS: readonly TranslationField[] = ['summaryEn', 'usageGuideEn'];

/**
 * 三种结果（L8-P10 / L8-C07）：
 * - 完全解析：每个“原文非空”的字段都拿到了字符串译文，不设 error；
 * - 部分字段回退：回复是 JSON 对象，但缺少（或不是字符串）某些必需字段，缺的字段回退为原文，
 *   已译字段保留，error = `translation_fallback: missing <字段>`；
 * - 整体回退：回复为空或不是 JSON 对象，全部回退为原文，
 *   error = `translation_fallback: unparseable reply (<parseError>)`。
 * 后两种都经 observeSafely 通知 onParseError 并记 warn；宿主 /translate 把 error 作为 warning 返回。
 * 原文为空的字段不算必需：没有可译内容时模型省略该键是正常输出，回退值本来就是空串。
 */
function parseTranslationJson(
  text: string | null | undefined,
  fallback: TranslationJsonResult,
  onParseError?: (err: unknown) => void
): TranslationJsonResult {
  const outcome = parseJsonObjectWithDiagnostics(text);
  if (outcome.value === null) {
    const error = `translation_fallback: unparseable reply (${outcome.parseError ?? 'unknown'})`;
    reportTranslationFallback({
      error,
      outcome,
      reasonCode: 'translation-json-whole-fallback',
      missingFields: TRANSLATION_FIELDS.filter((field) => fallback[field].length > 0),
      onParseError,
    });
    return { ...fallback, error };
  }

  if (outcome.recoveredFrom !== undefined) {
    reportTranslationParseRecovery(outcome);
  }
  const record = outcome.value;
  const translated: TranslationJsonResult = { ...fallback };
  const missingFields: TranslationField[] = [];
  for (const field of TRANSLATION_FIELDS) {
    const value = record[field];
    if (typeof value === 'string') {
      translated[field] = value;
    } else if (fallback[field].length > 0) {
      // 键名不同（如 summary_en）、缺键或类型不对都算缺失：该字段保留原文并计入 error。
      missingFields.push(field);
    }
  }
  if (missingFields.length === 0) {
    return translated;
  }
  const error = `translation_fallback: missing ${missingFields.join(', ')}`;
  reportTranslationFallback({
    error,
    outcome,
    reasonCode: 'translation-json-partial-fallback',
    missingFields,
    onParseError,
  });
  return { ...translated, error };
}

/**
 * 回退通知：warn 只含回复长度、解析策略、错误类别与缺失字段名，不记录回复正文或译文；
 * 观察者与日志各自经 observeSafely 隔离，任何一方抛错都不能把回退升级为 reject（R08-RUN-5）。
 */
function reportTranslationFallback({
  error,
  outcome,
  reasonCode,
  missingFields,
  onParseError,
}: {
  error: string;
  outcome: JsonObjectParseOutcome;
  reasonCode: 'translation-json-whole-fallback' | 'translation-json-partial-fallback';
  missingFields: readonly TranslationField[];
  onParseError?: (err: unknown) => void;
}): void {
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[TranslationJson] ${error}; returning original text for missing fields (replyLength=${outcome.replyLength}, strategy=${outcome.strategy})`,
        {
          reasonCode,
          replyLength: outcome.replyLength,
          strategy: outcome.strategy,
          ...(outcome.parseError !== undefined ? { parseError: outcome.parseError } : {}),
          ...(outcome.recoveredFrom !== undefined ? { recoveredFrom: outcome.recoveredFrom } : {}),
          missingFields: [...missingFields],
          resolution: 'fallback-original-text',
        }
      ),
    () => undefined
  );
  observeSafely(
    () => onParseError?.(new Error(error)),
    () => undefined
  );
}

/** 级联回退命中（前序策略失败、后续策略取得对象）：对象可用，只记 info；字段是否齐全另行判定。 */
function reportTranslationParseRecovery(outcome: JsonObjectParseOutcome): void {
  observeSafely(
    () =>
      Logger.getInstance().info(
        `[TranslationJson] reply JSON recovered by parser fallback (replyLength=${outcome.replyLength}, strategy=${outcome.strategy}, recoveredFrom=${outcome.recoveredFrom})`,
        {
          reasonCode: 'translation-json-recovered',
          replyLength: outcome.replyLength,
          strategy: outcome.strategy,
          recoveredFrom: outcome.recoveredFrom,
          resolution: 'use-recovered-object',
        }
      ),
    () => undefined
  );
}
