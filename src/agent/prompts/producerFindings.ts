/** 冷启动与扫描共用的发现投影；候选义务来自已确认记录，展示降级不生成新发现。 */
export function buildProducerFindingsSection(
  findings: readonly { finding: string; evidence?: string; importance?: number }[]
): string | null {
  if (findings.length === 0) {
    return null;
  }
  const unverified = (finding: { evidence?: string }) =>
    /[[(]unverified:/i.test(finding.evidence || '');
  const confirmed = findings
    .filter((finding) => !unverified(finding))
    .sort((a, b) => (b.importance ?? 5) - (a.importance ?? 5));
  const pending = findings.filter(unverified);
  const lines = ['## 关键发现 (Analyst 已确认)'];
  const seen = new Set<string>();
  for (const finding of confirmed) {
    const key = JSON.stringify([finding.finding, finding.evidence]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const importance = finding.importance ?? 5;
    lines.push(`${importance >= 8 ? '⚠️' : '📋'} **[${importance}/10]** ${finding.finding}`);
    if (finding.evidence && finding.evidence !== finding.finding) {
      lines.push(`  证据: ${finding.evidence}`);
    }
  }
  if (pending.length > 0) {
    lines.push('', '### ⚠️ 未核实线索（不得作为候选的唯一证据）');
    for (const finding of pending) {
      lines.push(`- [${finding.importance ?? 5}/10] ${finding.finding}`);
    }
    lines.push(
      '只能使用本阶段实际开放的工具核实已有线索；仍无法核实则放弃，不把未核实内容变成候选义务，也不伪造引用。'
    );
  }
  lines.push(
    '',
    '☝️ 上述已确认的结构化发现是唯一候选义务；最终 Markdown 摘要只作背景，不要从摘要里新增候选主题。',
    '📐 已确认发现中的为何这样选、边界、违反后果与取舍必须进入 content.markdown，关键理由进入 content.rationale；保留真实来源及 evidenceRefs，不泛化为一句空话。'
  );
  return lines.join('\n');
}
