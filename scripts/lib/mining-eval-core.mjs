/**
 * mining-eval 确定性核心(P0-2 挖掘质量升级)：候选↔期望匹配、指标聚合、报告构建。
 * 与 LLM/fs/运行时零耦合——纯函数，单测直测(test/mining-eval-harness.test.ts)。
 * 判据刻意保守：启发式匹配只做方向性 P/R(报告显式标注)；语义正确性由 --judge 模式补位。
 */

/** 候选的可匹配文本面(title/doClause/markdown/rationale 拼接，小写)。 */
export function candidateText(candidate) {
  const content =
    candidate?.content && typeof candidate.content === 'object' ? candidate.content : {};
  return [
    candidate?.title,
    candidate?.doClause,
    candidate?.dontClause,
    content.markdown,
    content.rationale,
  ]
    .filter((part) => typeof part === 'string')
    .join('\n')
    .toLowerCase();
}

/** 候选 cited 文件集合(reasoning.sources 去行号)。 */
export function candidateCitedFiles(candidate) {
  const reasoning =
    candidate?.reasoning && typeof candidate.reasoning === 'object' ? candidate.reasoning : {};
  const sources = Array.isArray(reasoning.sources) ? reasoning.sources : [];
  return new Set(
    sources
      .filter((source) => typeof source === 'string')
      .map((source) => source.split(':')[0].trim())
      .filter(Boolean)
  );
}

/**
 * 启发式匹配：≥⌈keywords/2⌉ 关键词命中 且 mustCiteFiles(若给)全被 cited。
 * 这是方向性判据，不是语义判定——报告里 precision/recall 标注 heuristic。
 */
export function matchesExpected(candidate, expected) {
  const text = candidateText(candidate);
  const keywords = Array.isArray(expected.keywords) ? expected.keywords : [];
  const hit = keywords.filter((keyword) => text.includes(String(keyword).toLowerCase())).length;
  if (keywords.length > 0 && hit < Math.ceil(keywords.length / 2)) {
    return false;
  }
  const cited = candidateCitedFiles(candidate);
  const mustCite = Array.isArray(expected.mustCiteFiles) ? expected.mustCiteFiles : [];
  return mustCite.every((file) => cited.has(file));
}

/** notExpected(平凡项)命中：任一关键词出现在 title/doClause(收窄面，防误伤正文举例)。 */
export function matchesNotExpected(candidate, notExpected) {
  const narrow = [candidate?.title, candidate?.doClause]
    .filter((part) => typeof part === 'string')
    .join('\n')
    .toLowerCase();
  const keywords = Array.isArray(notExpected.keywords) ? notExpected.keywords : [];
  return keywords.some((keyword) => narrow.includes(String(keyword).toLowerCase()));
}

/**
 * 单 fixture 评分：候选集 × (expected/notExpected) → 匹配明细 + 方向性 P/R。
 * judgeVerdicts(可选)按候选下标对齐；给出时 precision 采用 judge 口径(uphold 占比)。
 */
export function scoreFixture({ fixture, candidates, judgeVerdicts = null }) {
  const expected = Array.isArray(fixture.expected) ? fixture.expected : [];
  const notExpected = Array.isArray(fixture.notExpected) ? fixture.notExpected : [];

  const expectedHits = expected.map((exp) => ({
    key: exp.key,
    matchedBy: candidates
      .map((candidate, index) => (matchesExpected(candidate, exp) ? index : -1))
      .filter((index) => index >= 0),
  }));
  const trivialHits = candidates
    .map((candidate, index) => ({
      index,
      keys: notExpected.filter((ne) => matchesNotExpected(candidate, ne)).map((ne) => ne.key),
    }))
    .filter((entry) => entry.keys.length > 0);

  const matchedCandidateIndexes = new Set(expectedHits.flatMap((hit) => hit.matchedBy));
  const recall =
    expected.length > 0
      ? expectedHits.filter((hit) => hit.matchedBy.length > 0).length / expected.length
      : null;
  const heuristicPrecision =
    candidates.length > 0 ? matchedCandidateIndexes.size / candidates.length : null;

  let judgePrecision = null;
  if (Array.isArray(judgeVerdicts) && judgeVerdicts.length === candidates.length) {
    // invalidCitation=无效裁决(judge 引用未过区间机械校验),不计入分母——与
    // computeJudgeCalibration 同口径。门0 真跑曾在 5/5 全 void 下仍算出 40%(误导)。
    const judged = judgeVerdicts.filter((verdict) => verdict?.verdict && !verdict.invalidCitation);
    judgePrecision =
      judged.length > 0
        ? judged.filter((verdict) => verdict.verdict === 'uphold').length / judged.length
        : null;
  }

  return {
    fixtureId: fixture.id,
    candidateCount: candidates.length,
    expectedHits,
    trivialHits,
    recall,
    heuristicPrecision,
    judgePrecision,
    trivialityRate: candidates.length > 0 ? trivialHits.length / candidates.length : null,
  };
}

/** 从父 run 结果聚合运行观测(abandonment/repairs/usage/工具分布)。 */
export function collectRunObservations(runResult) {
  const phases = runResult?.phases && typeof runResult.phases === 'object' ? runResult.phases : {};
  const abandoned = Array.isArray(phases.abandonedModules) ? phases.abandonedModules : [];
  const moduleResults =
    phases.moduleResults && typeof phases.moduleResults === 'object' ? phases.moduleResults : {};
  const submitRepairs = {};
  for (const child of Object.values(moduleResults)) {
    const outcome = child?.phases?._pipelineOutcome;
    const repairs = outcome && typeof outcome === 'object' ? outcome.submitRepairs : null;
    if (repairs && typeof repairs === 'object') {
      for (const [key, count] of Object.entries(repairs)) {
        submitRepairs[key] = (submitRepairs[key] || 0) + Number(count || 0);
      }
    }
  }
  const toolCalls = Array.isArray(runResult?.toolCalls) ? runResult.toolCalls : [];
  const toolDistribution = {};
  for (const call of toolCalls) {
    const tool = String(call?.tool || 'unknown');
    toolDistribution[tool] = (toolDistribution[tool] || 0) + 1;
  }
  return {
    status: runResult?.status ?? 'unknown',
    abandonedModules: abandoned,
    submitRepairs,
    toolDistribution,
    usage: runResult?.usage ?? null,
  };
}

/** 汇总报告(JSON 形状)；渲染为 Markdown 由 renderReportMarkdown 承担。 */
export function buildReport({ startedAt, provider, judgeProvider, fixtureResults, notes = [] }) {
  const totals = fixtureResults.reduce(
    (acc, entry) => {
      acc.candidates += entry.score.candidateCount;
      acc.inputTokens += entry.observations.usage?.inputTokens || 0;
      acc.outputTokens += entry.observations.usage?.outputTokens || 0;
      acc.abandoned += entry.observations.abandonedModules.length;
      return acc;
    },
    { candidates: 0, inputTokens: 0, outputTokens: 0, abandoned: 0 }
  );
  return {
    kind: 'MiningEvalReport',
    version: 1,
    startedAt,
    provider,
    judgeProvider: judgeProvider || null,
    totals,
    fixtures: fixtureResults,
    notes,
  };
}

export function renderReportMarkdown(report) {
  const lines = [
    '# Mining Eval Report',
    '',
    `- startedAt: ${report.startedAt}`,
    `- provider: ${report.provider}${report.judgeProvider ? ` | judge: ${report.judgeProvider}` : ''}`,
    `- totals: candidates=${report.totals.candidates}, abandonedModules=${report.totals.abandoned}, tokens=${report.totals.inputTokens}in/${report.totals.outputTokens}out`,
    '',
  ];
  for (const entry of report.fixtures) {
    const score = entry.score;
    lines.push(`## ${score.fixtureId}`);
    lines.push('');
    lines.push(
      `- candidates: ${score.candidateCount} | recall(heuristic): ${fmt(score.recall)} | precision(heuristic): ${fmt(score.heuristicPrecision)}${score.judgePrecision !== null ? ` | precision(judge): ${fmt(score.judgePrecision)}` : ''} | triviality: ${fmt(score.trivialityRate)}`
    );
    for (const hit of score.expectedHits) {
      lines.push(
        `- expected \`${hit.key}\`: ${hit.matchedBy.length > 0 ? `✅ matched by candidate #${hit.matchedBy.join(', #')}` : '❌ missed'}`
      );
    }
    for (const trivial of score.trivialHits) {
      lines.push(`- ⚠️ trivial candidate #${trivial.index}: ${trivial.keys.join(', ')}`);
    }
    const abandoned = entry.observations.abandonedModules;
    if (abandoned.length > 0) {
      lines.push(`- abandoned: ${abandoned.map((a) => `${a.unitId}(${a.action})`).join(', ')}`);
    }
    const repairs = Object.entries(entry.observations.submitRepairs);
    if (repairs.length > 0) {
      lines.push(`- submitRepairs: ${repairs.map(([key, count]) => `${key}=${count}`).join(', ')}`);
    }
    lines.push(`- toolDistribution: ${JSON.stringify(entry.observations.toolDistribution)}`);
    if (Array.isArray(entry.judgeVerdicts) && entry.judgeVerdicts.length > 0) {
      lines.push('');
      lines.push('### Judge verdicts');
      entry.judgeVerdicts.forEach((verdict, index) => {
        if (!verdict) {
          return;
        }
        lines.push(
          `- candidate #${index}: **${verdict.verdict}** (entailment=${verdict.entailment ?? '?'}, trivial=${verdict.trivial ?? '?'})${verdict.invalidCitation ? ' ⚠️ judge 引用未通过区间校验，按无效裁决处理' : ''} — ${String(verdict.reason ?? '').slice(0, 160)}`
        );
      });
    }
    lines.push('');
  }
  if (report.notes.length > 0) {
    lines.push('## Notes');
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
  }
  return lines.join('\n');
}

function fmt(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}
