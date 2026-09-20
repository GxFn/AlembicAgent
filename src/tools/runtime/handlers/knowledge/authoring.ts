/** 提交前的证据展开、Core authoring 校验与有限风格修复；不持有生产写口。 */

import {
  applyStyleWaiver,
  getImperativeVerbAllowlist,
  isSoftAuthoringViolation,
  STYLE_WAIVER_SESSION_LIMIT,
} from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { fail, type ToolContext, type ToolResult } from '#tools/kernel/registry.js';
import { formatRecipeAuthoringViolations } from '../recipeAuthoringGate.js';
import { prepareRecipeProductionItem } from '../recipeProductionAdapter.js';
import {
  buildEvidenceCandidatesHint,
  buildViolationRepairTemplates,
  expandEvidenceRefsForSubmit,
  inferEvidenceRefsFromSources,
  isStyleRepairable,
  repairStyleViolations,
  sanitizeSubmissionEvidence,
} from '../submitEvidenceExpansion.js';
import { buildSubmissionInput, pickString, recordValue } from './input.js';
import { abortedKnowledgeResult } from './operation.js';
import {
  bumpSubmitRepairStat,
  readTitleAttempt,
  sessionCounterBox,
  writeTitleAttempt,
} from './sessionState.js';
import {
  buildSnippetRepairHint,
  evaluatePreparedItem,
  normalizeBareSourceRefs,
} from './sources.js';

type SubmissionInput = ReturnType<typeof buildSubmissionInput>;
type SubmissionPreparation =
  | { status: 'rejected'; result: ToolResult }
  | {
      status: 'ready';
      item: SubmissionInput['item'];
      effectiveItem: Record<string, unknown>;
      preparedProduction: ReturnType<typeof prepareRecipeProductionItem>;
      effectiveDimensionId: string | undefined;
      isBootstrap: boolean;
    };

export async function prepareSubmission(
  params: Record<string, unknown>,
  ctx: Pick<ToolContext, 'projectRoot' | 'runtime' | 'abortSignal'>
): Promise<SubmissionPreparation> {
  const {
    item: initialItem,
    effectiveDimensionId,
    isBootstrap,
  } = buildSubmissionInput(params, ctx);
  let item = initialItem;

  // P1.4b in-process flatten (CG-4)：在 Core production port 之前，把 in-process 提交
  // 接到与 host-agent 路径同一套权威门禁 validateAgainst。档位由 resolveAuthoringProfile 从上下文
  // 解析：携带 bootstrap dimension 的冷启动提交 → cold-start（完整门禁，含 3-file 证据下限）；
  // 运行期机会式 in-process AI 开发（无 session / 无 dimension）→ opportunistic（保留全部内容门禁
  // + 廉价 fs 来源接地，但不强制 3-file 下限与 session-scope）。上面的 validateSubmitParams 仅作
  // 廉价 presence/length fast-fail，本门禁是被其 supersede 的权威裁决；命中即按既有 in-process 拒绝
  // 信封形状（fail 字符串）返回，门禁输出字节不变、只改 in-process AI 看到的门槛。
  // F4f 预处理：裸路径 sourceRefs（无行号）用 Analyst 真实接地范围规范化——裸路径候选
  // 此前没有任何自动化通路（F4b/F4d 都需要可解析行号）。范围来自 evidenceMap 投影
  // （sharedState._analystGroundedRanges），即 Analyst 真实读过/锚点补齐过的行，非任意指派。
  // H1(2026-07-02 数量专项)：同题硬止损——真机同一候选被拒后模型无视 STOP 软指令连提 6 次,
  // 烧掉 60% 提交名额。同 title 已尝试 3 次后直接 terminal 拒绝(不跑门禁不给修复提示)。
  const sharedStateForSubmit = (ctx.runtime?.sharedState ?? null) as Record<string, unknown> | null;
  const titleKey = String(item.title ?? '').trim();
  const submitCounters = sessionCounterBox(ctx.runtime);
  if (submitCounters && titleKey) {
    // 从第一轮起都可能拿到 {...base}：字典归属稳定盒，不能在临时顶层懒创建。
    // 旧宿主的顶层字典按原引用接入一次；顶层继续作为兼容别名，不复制或重置预算。
    const attempts = (recordValue(submitCounters._submitTitleAttempts) ??
      recordValue(sharedStateForSubmit?._submitTitleAttempts) ??
      {}) as Record<string, number>;
    submitCounters._submitTitleAttempts = attempts;
    if (sharedStateForSubmit) {
      sharedStateForSubmit._submitTitleAttempts = attempts;
    }
    const tried = readTitleAttempt(attempts, titleKey);
    if (tried >= 3) {
      Logger.getInstance().warn(
        `[knowledge.submit] hard stop-loss: "${titleKey}" already attempted ${tried} times (dim=${String(effectiveDimensionId ?? '')})`
      );
      return {
        status: 'rejected',
        result: fail(
          `🛑 候选 "${titleKey}" 已尝试 ${tried} 次未通过——本会话禁止再提交该标题。立即换一个【不同的】发现提交，或输出最终总结并把它列为 blocker。`
        ),
      };
    }
    writeTitleAttempt(attempts, titleKey, tried + 1);
  }

  // E5（证据保真）：reasoning.evidenceRefs 台账机械展开——sources 由程序从台账
  // 条目生成（模型不再手写 file:line），并做新鲜度终检（run 中途文件变更→EVIDENCE_STALE
  // 拒并提示重采）。发生在权威门禁之前的 Agent 层；Core gateRules 与九拒因语义不动。
  let expansion = expandEvidenceRefsForSubmit(item, {
    ledger: ctx.runtime?.evidenceLedger,
    projectRoot: ctx.projectRoot,
  });
  // 拒收治理（2026-07-05）：refs 缺席但手写 sources 命中台账同文件条目→机械回填后重展开。
  // 只映射真实条目（事实面零发明）；回填后照走新鲜度/标签全链，失败仍按原语义拒。
  if (expansion.ok && expansion.resolvedRefs === 0 && ctx.runtime?.evidenceLedger) {
    const inferred = inferEvidenceRefsFromSources(item, ctx.runtime.evidenceLedger);
    if (inferred.length > 0) {
      bumpSubmitRepairStat(ctx.runtime, 'evidence_refs_inferred');
      Logger.getInstance().info(
        `[knowledge.submit] evidenceRefs auto-inferred from cited sources (${inferred.length} refs) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')})`
      );
      const reasoningObj = (item.reasoning ?? {}) as Record<string, unknown>;
      item = {
        ...item,
        reasoning: {
          ...reasoningObj,
          evidenceRefs: inferred,
        } as unknown as typeof item.reasoning,
      };
      expansion = expandEvidenceRefsForSubmit(item, {
        ledger: ctx.runtime?.evidenceLedger,
        projectRoot: ctx.projectRoot,
      });
    }
  }
  if (!expansion.ok) {
    Logger.getInstance().warn(
      `[knowledge.submit] rejected "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${expansion.error}`
    );
    return { status: 'rejected', result: fail(expansion.error) };
  }
  if (expansion.expandedSources.length > 0) {
    Logger.getInstance().info(
      `[knowledge.submit] evidence refs expanded (${expansion.expandedSources.length} sources) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')})`
    );
  }

  // 核心保证（2026-07-04 用户裁定）：维度运行的 Recipe 必须经关键证据产出——
  // 台账在场时 reasoning.evidenceRefs 为必填（引用 analyst findings 携带的 [E-x] 条目）；
  // 纯手写 sources 不再被接受为唯一证据（那正是捏造通道）。非维度运行（无台账）不受此限。
  // 判定用 resolvedRefs 而非 expandedSources：search/structure/terminal 类条目无 file 字段、
  // 展不出 file:line 标签，但它们是真实采集证据——run-6 曾按 expandedSources=0 误杀这类
  // 忠实引用（重试三连拒到止损）。source 数量下限仍由下游 INSUFFICIENT_EVIDENCE 把守。
  if (ctx.runtime?.evidenceLedger && expansion.resolvedRefs === 0) {
    const hint = buildEvidenceCandidatesHint(ctx.runtime.evidenceLedger);
    Logger.getInstance().warn(
      `[knowledge.submit] rejected "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): EVIDENCE_REFS_REQUIRED`
    );
    return {
      status: 'rejected',
      result: fail(
        `Validation failed: EVIDENCE_REFS_REQUIRED: 维度运行的候选必须以 reasoning.evidenceRefs 引用台账条目 id（先 memory.recall 查看 findings 携带的 [E-x] 标注，优先引用带文件区间的条目）——手写 sources 不能作为唯一证据。改标题重提同一断言不会通过：补上 evidenceRefs，或该断言没有台账证据支撑时直接放弃。${hint}`
      ),
    };
  }
  if (
    ctx.runtime?.evidenceLedger &&
    expansion.resolvedRefs > 0 &&
    expansion.expandedSources.length === 0
  ) {
    // 引用全为无 file 条目（search/terminal 类）：证据在场但机械展开不出 sources——
    // 放行进门禁，手写 sources 照常走 fs 校验+自动矫正；留痕以便真机复盘该形态占比。
    Logger.getInstance().info(
      `[knowledge.submit] evidence refs valid but label-less (${expansion.resolvedRefs} refs, search/terminal 类) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')})`
    );
  }

  // E7（接受率治理）：手写路径自动矫正（basename 唯一匹配台账真实形态，多仓前缀陷阱机械解）
  // + 证据驱动 scope 收窄（rule/pattern 证据 <3 文件自动 narrow——门禁本就接受该通道）。
  const sanitized = sanitizeSubmissionEvidence(expansion.item, {
    ledger: ctx.runtime?.evidenceLedger,
    projectRoot: ctx.projectRoot,
  });
  if (sanitized.corrected.length > 0 || sanitized.dropped.length > 0 || sanitized.scopedNarrow) {
    bumpSubmitRepairStat(ctx.runtime, 'evidence_sanitized');
    Logger.getInstance().info(
      `[knowledge.submit] evidence sanitized for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): corrected=[${sanitized.corrected.join(', ')}] dropped=[${sanitized.dropped.join(', ')}] scopedNarrow=${sanitized.scopedNarrow}`
    );
  }

  let effectiveItem: Record<string, unknown> = normalizeBareSourceRefs(
    sanitized.item,
    sharedStateForSubmit
  );
  let preparedProduction = prepareRecipeProductionItem(effectiveItem, ctx.projectRoot);
  effectiveItem = preparedProduction.item as Record<string, unknown>;
  if (!preparedProduction.codeEvidence.accepted) {
    bumpSubmitRepairStat(ctx.runtime, 'unsafe_core_code_removed');
    Logger.getInstance().warn(
      `[knowledge.submit] unsafe coreCode removed with diagnostic=${preparedProduction.codeEvidence.reason}; retrieval profile remains independently evaluated for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')})`
    );
  }
  let gateViolations = evaluatePreparedItem(preparedProduction, ctx, effectiveDimensionId);
  // F4e：GRAPH_REF_INVALID 且 Analyst 真有 graph 查询证据时，自动注入 reasoning.graphRefs
  // （替模型完成「复制」动作——graphEvidence 来自真实 graph 调用，非编造；为空则保持拒绝）。
  if (gateViolations.some((v) => v.code === 'GRAPH_REF_INVALID')) {
    const sharedState = (ctx.runtime?.sharedState ?? null) as Record<string, unknown> | null;
    const analystGraphEvidence = Array.isArray(sharedState?._analystGraphEvidence)
      ? (sharedState._analystGraphEvidence as unknown[]).filter(
          (r): r is string => typeof r === 'string' && r.length > 0
        )
      : [];
    if (analystGraphEvidence.length > 0) {
      const reasoning = (effectiveItem.reasoning ?? {}) as Record<string, unknown>;
      const withGraphRefs: Record<string, unknown> = {
        ...effectiveItem,
        reasoning: { ...reasoning, graphRefs: analystGraphEvidence },
      };
      // 只补图谱证据，不复活已移除 coreCode；与初次/风格修复共享同一 prepared 裁决。
      const graphProduction = { ...preparedProduction, item: withGraphRefs };
      const reVerified = evaluatePreparedItem(graphProduction, ctx, effectiveDimensionId);
      if (!reVerified.some((v) => v.code === 'GRAPH_REF_INVALID')) {
        bumpSubmitRepairStat(ctx.runtime, 'graph_refs_injected');
        Logger.getInstance().info(
          `[knowledge.submit] graph refs injected from analyst evidence (${analystGraphEvidence.length} refs) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}), remaining violations=${reVerified.length}`
        );
        preparedProduction = graphProduction;
        effectiveItem = withGraphRefs;
        gateViolations = reVerified;
      }
    }
  }
  // 软规则一次申辩制(2026-07-02 用户决策)：门禁规则分两性——硬规则是事实与接地
  // (伪造锚点/重复/必填结构，放行即污染知识库，不可申辩)；软规则是写作风格判断
  // (祈使动词白名单/对比示例/标题泛化/长度)，LLM 可能有正当理由(如项目惯用语)。
  // 软规则全拒时反复猜措辞是最长的提交回合尾巴；改为：LLM 带 ≥20 字 waiverJustification
  // 重新提交即放行，理由随 reasoning.styleWaiver 落库，由 Dashboard 人工审核终裁。
  // 每会话 waiver 上限 5 次防滥用；混有硬违规时申辩无效(先修事实错误)。
  if (gateViolations.length > 0) {
    // waiver 每会话上限的累计宿主必须跨调用稳定(sessionCounterBox)——挂 ctx.runtime 时
    // 每次调用都从 0 起算,上限 5 形同虚设(与修复层计数同因,门0 真跑后根修)。
    const waiverBox = sessionCounterBox(ctx.runtime);
    const waiverTotal = Number(waiverBox?.styleWaiverTotal) || 0;
    const waiver = applyStyleWaiver({
      violations: gateViolations,
      justification: pickString(params.waiverJustification),
      sessionWaiverTotal: waiverTotal,
      item: effectiveItem,
    });
    if (waiver.waived) {
      effectiveItem = waiver.item;
      bumpSubmitRepairStat(ctx.runtime, 'style_waiver');
      if (waiverBox) {
        waiverBox.styleWaiverTotal = waiverTotal + 1;
      }
      Logger.getInstance().warn(
        `[knowledge.submit] style waiver accepted (${waiver.waivedCodes.join(', ')}) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}), session waivers=${waiverTotal + 1}/${STYLE_WAIVER_SESSION_LIMIT} — pending human review`
      );
      gateViolations = [];
    }
  }
  // E7-R（接受率 100% 最后一级）：纯风格类拒绝→一次 schema 收窄的修复子调用后重跑门禁
  // （每 title 限 2 次；任何失败零影响走原拒绝路径）。证据类违规不修——那是事实问题不是写法问题。
  if (gateViolations.length > 0 && isStyleRepairable(gateViolations)) {
    // runtime 是逐调用投影；嵌套会话盒在阶段浅拷贝后仍保留相同预算。
    const repairState = sessionCounterBox(ctx.runtime);
    const repairAttempts = (repairState?._styleRepairAttempts ?? {}) as Record<string, number>;
    const tried = readTitleAttempt(repairAttempts, titleKey);
    if (tried < 2) {
      writeTitleAttempt(repairAttempts, titleKey, tried + 1);
      if (repairState) {
        repairState._styleRepairAttempts = repairAttempts;
      }
      const repaired = await repairStyleViolations(
        effectiveItem,
        gateViolations,
        ctx.runtime?.aiProvider,
        getImperativeVerbAllowlist(),
        { abortSignal: ctx.abortSignal }
      );
      const aborted = abortedKnowledgeResult(ctx, 'submit style repair');
      if (aborted) {
        return { status: 'rejected', result: aborted };
      }
      if (repaired) {
        const refreshed = prepareRecipeProductionItem(repaired, ctx.projectRoot);
        const repairedProduction = {
          ...refreshed,
          // 不复活已移除片段，也不让二次 prepare 的 absent 覆盖首次不安全输入诊断。
          codeEvidence: preparedProduction.codeEvidence.accepted
            ? refreshed.codeEvidence
            : preparedProduction.codeEvidence,
        };
        const reVerified = evaluatePreparedItem(repairedProduction, ctx, effectiveDimensionId);
        if (reVerified.length < gateViolations.length) {
          bumpSubmitRepairStat(ctx.runtime, 'style_repair_subcall');
          Logger.getInstance().info(
            `[knowledge.submit] style repair sub-call fixed "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): violations ${gateViolations.length}→${reVerified.length}`
          );
          preparedProduction = repairedProduction;
          effectiveItem = repairedProduction.item as Record<string, unknown>;
          gateViolations = reVerified;
        } else {
          // 降级必须可观测：修复产物未减少违规（run-5 静默分支补钉）
          Logger.getInstance().warn(
            `[style-repair] no improvement for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${gateViolations.length}→${reVerified.length}`
          );
        }
      }
    } else {
      Logger.getInstance().info(
        `[style-repair] skipped: per-title budget exhausted for "${titleKey}"`
      );
    }
  }
  // 门禁分层（2026-07-04 用户裁定：要证据/价值/深度，不强制格式）：
  // 硬门=证据接地类（伪造/引用/逐字/重复/必填结构）→ 拒绝，力度不减；
  // 软门=写作风格类（祈使动词/对比示例/标题泛化/长度）→ 不再阻断——一次修复子调用尝试
  // 真修后，剩余软违规降为 style advisory 随候选入库（reasoning.styleAdvisories，
  // Dashboard 人工复核），价值/深度由既有 C4 深度裁判+C8 质量评分继续评判。
  if (gateViolations.length > 0 && gateViolations.every((v) => isSoftAuthoringViolation(v.code))) {
    const advisories = gateViolations.map((v) => `${v.code}: ${v.message}`);
    const reasoningObj = (effectiveItem.reasoning ?? {}) as Record<string, unknown>;
    effectiveItem = {
      ...effectiveItem,
      reasoning: { ...reasoningObj, styleAdvisories: advisories },
    };
    bumpSubmitRepairStat(ctx.runtime, 'style_advisories');
    Logger.getInstance().info(
      `[knowledge.submit] style advisories attached (non-blocking) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${gateViolations.map((v) => v.code).join(', ')}`
    );
    gateViolations = [];
  }
  if (gateViolations.length > 0) {
    const detail = formatRecipeAuthoringViolations(gateViolations);
    // F4b 诊断反馈：代码/引用类违规可附一个真实 bounded range，帮助模型判断引用是否相关。
    // 提示不会修改候选，也不会把首个来源、无界范围或整文件自动提升为 coreCode。
    const snippetRepair = gateViolations.some((v) =>
      ['SNIPPET_MISMATCH', 'SOURCE_REF_LINE_OUT_OF_RANGE', 'SOURCE_REF_LINE_MISSING'].includes(
        v.code
      )
    )
      ? buildSnippetRepairHint(effectiveItem.sourceRefs, ctx.projectRoot)
      : '';
    // E5/E6-F1 反馈增强：INSUFFICIENT_EVIDENCE 与 SOURCE_REF_NOT_FOUND 都附台账内真实
    // 可引用的 distinct 文件——E6 真机显示 NOT_FOUND 全部来自 producer 手写路径
    // （多仓前缀陷阱），台账条目本身就是正确形态，引导改用 evidenceRefs。
    const evidenceHint = gateViolations.some(
      (v) => v.code === 'INSUFFICIENT_EVIDENCE' || v.code === 'SOURCE_REF_NOT_FOUND'
    )
      ? buildEvidenceCandidatesHint(ctx.runtime?.evidenceLedger)
      : '';
    // 全软违规已在上方转为 advisory；这里必含硬违规，只给证据修复与止损反馈。
    // 可见化:门禁拒绝是冷启动候选不落库的最可能真因(如冷启动档位的 3-file 证据下限、祈使动词、
    // snippet 匹配、source-ref 接地)。打日志带标题+违规明细，便于定位是 DeepSeek 候选质量还是门禁校准。
    Logger.getInstance().warn(
      `[knowledge.submit] rejected "${String((item as { title?: unknown }).title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${detail}`
    );
    // F3 拒绝止损：真机 ts-js-module 曾因「拒绝→重试」循环烧穿 produce 阶段 900s（stage_timeout
    // 连坐 session abort 下游 8 维度）。在 runtime 上维护连续/累计拒绝计数，按档位在拒绝消息里
    // 附加 STOP 指令，让模型跳过修不动的候选、及时收束——预算换覆盖，而不是死磕单条。
    // 止损计数宿主同 waiver:必须用 sessionCounterBox——此前挂 ctx.runtime(每调用一次性
    // 投影对象),streak/total 每次从 0 起算,3/12 档位从未触发,900s 烧穿护栏实际失效。
    const stopLossBox = sessionCounterBox(ctx.runtime);
    let stopDirective = '';
    if (stopLossBox) {
      const streak = (Number(stopLossBox.gateRejectStreak) || 0) + 1;
      const total = (Number(stopLossBox.gateRejectTotal) || 0) + 1;
      stopLossBox.gateRejectStreak = streak;
      stopLossBox.gateRejectTotal = total;
      if (total >= 12) {
        stopDirective =
          ' 🛑 STOP: 本会话门禁拒绝已达预算上限——禁止再调用 knowledge submit，立即输出最终总结，把未通过的候选列为 blocker（这不算失败）。';
      } else if (streak >= 3) {
        stopDirective =
          ' 🛑 STOP: 已连续多次被拒——立即放弃当前候选（不要再改写重试它），换下一条【不同】候选继续提交；若没有其他候选，直接输出最终总结并把本条列为 blocker。';
      }
      if (stopDirective) {
        Logger.getInstance().warn(
          `[knowledge.submit] reject stop-loss engaged (dim=${String(effectiveDimensionId ?? '')}): streak=${streak}, total=${total}`
        );
      }
    }
    // E7：风格/措辞类违规附「照抄即过」修复模板（动词白名单来自 Core 单源）
    const repairTemplates = buildViolationRepairTemplates(
      gateViolations,
      getImperativeVerbAllowlist()
    );
    return {
      status: 'rejected',
      result: fail(
        `Validation failed: ${detail}${snippetRepair}${evidenceHint}${repairTemplates}${stopDirective}`
      ),
    };
  }
  // 门禁通过即中断连续拒绝计数（提交成败由下游 gateway 判定，与门禁止损无关）。
  {
    const passBox = sessionCounterBox(ctx.runtime);
    if (passBox) {
      passBox.gateRejectStreak = 0;
    }
  }

  const aborted = abortedKnowledgeResult(ctx, 'submit');
  if (aborted) {
    return { status: 'rejected', result: aborted };
  }
  return {
    status: 'ready',
    item,
    effectiveItem,
    preparedProduction,
    effectiveDimensionId,
    isBootstrap,
  };
}
