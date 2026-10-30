/** Markdown正文是事实单源；这些索引只保存稳定定位和可核对的关联。浏览器与CLI共用。 */
export function embeddedEvidenceKey(reference) {
  // 这是所选版本内嵌数据的逻辑链接，不要求另存一份同名 JSON 文件。
  if (reference === 'evidence/public-entrypoints.json') {
    return 'publicApi';
  }
  if (reference === 'evidence/scoped-execution.json') {
    return 'scopedRuns';
  }
  return null;
}

export function stableSectionId(title) {
  const text = title.replace(/[`*_]/gu, '').trim();
  let hash = 2166136261;
  for (const character of text) {
    hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  }
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 42);
  return `s-${slug || 'section'}-${(hash >>> 0).toString(36)}`;
}
export function documentSections(body) {
  const sections = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
    }
    const heading = !fenced && line.match(/^#{2,6}\s+(.+)$/u);
    if (heading) {
      sections.push({
        id: stableSectionId(heading[1]),
        title: heading[1].replace(/[`*_]/gu, ''),
        text: '',
      });
    } else if (!fenced && sections.length) {
      sections.at(-1).text += `${line}\n`;
    }
  }
  return sections;
}
export function docRoute(id, section, edge) {
  const params = new URLSearchParams();
  if (section) {
    params.set('section', section);
  }
  if (edge) {
    params.set('edge', edge);
  }
  return `#/doc/${encodeURIComponent(id)}${params.size ? `?${params}` : ''}`;
}
const refs = (value) =>
  [
    ...value.matchAll(
      /`((?:src|test|scripts|config|alembic-agent-architecture-atlas\/test)\/[^`]+)`/gu,
    ),
  ].map((m) => m[1]);
export function bindAssertion(ref, files, report) {
  const [file, encoded] = ref.split('#case:');
  let title;
  try {
    title = decodeURIComponent(encoded ?? '');
  } catch {
    return { ref, state: 'invalid', executions: [] };
  }
  const definitions =
    files.find((f) => f.path === file)?.testDefinitions?.filter((d) => d.title === title) ?? [];
  if (definitions.length !== 1) {
    return { ref, state: definitions.length > 1 ? 'ambiguous' : 'unresolved', executions: [] };
  }
  const executions = [];
  // schema1没有足够的采集身份，不能根据标题将历史记录升级为精确case。
  if (report?.schemaVersion === 2) {
    for (const group of report.groups.filter(
      (g) => g.file === file && g.inputFreshness === 'matched',
    )) {
      for (const item of group.cases) {
        const original = group.collection[item.fileCaseIndex];
        const definition = definitions[0];
        const template = definition.parameterized ?? /%[sdifjoO]|\$[a-zA-Z]/u.test(title);
        const bindingLocation = definition.callLocation ?? definition;
        const sameLine =
          files
            .find((f) => f.path === file)
            ?.testDefinitions?.filter((d) => (d.callLocation ?? d).line === bindingLocation.line) ??
          [];
        const locationMatches =
          original?.location?.line === bindingLocation.line &&
          (!original.location.column ||
            !bindingLocation.column ||
            original.location.column === bindingLocation.column) &&
          (sameLine.length === 1 || (original.location.column && bindingLocation.column));
        const matches = template
          ? locationMatches
          : original?.title === title && (!original.location?.line || locationMatches);
        if (matches) {
          executions.push({
            groupId: group.id,
            caseId: item.caseId,
            fileCaseIndex: item.fileCaseIndex,
            title: item.title,
            status: item.status,
            runStatus: group.status,
            inputFreshness: group.inputFreshness,
          });
        }
      }
    }
  }
  return {
    ref,
    state: executions.length ? 'executed' : 'located',
    line: definitions[0].line,
    executions,
  };
}
export function buildRelations(catalog, scenarios = [], kinds = {}) {
  const bind = (ref) => {
    const ordinary = bindAssertion(ref, catalog.inventory.files, catalog.scopedRuns);
    if (
      !ref.startsWith('alembic-agent-architecture-atlas/test/pilot.test.ts#case:') ||
      catalog.pilotFreshness !== 'matched' ||
      catalog.pilot?.status !== 'pass'
    ) {
      return ordinary;
    }
    const title = decodeURIComponent(ref.split('#case:')[1]);
    const matches = catalog.pilot.scenarios.filter((s) => s.fullName?.endsWith(` ${title}`));
    return matches.length === 1
      ? {
          ...ordinary,
          state: 'pilot-recorded',
          pilotScenario: {
            ...matches[0],
            checkedAt: catalog.pilot.checkedAt,
            sourceFingerprint: catalog.pilot.sourceFingerprint,
          },
        }
      : ordinary;
  };
  return {
    schemaVersion: 1,
    pages: catalog.documents.map((doc) => ({
      docId: doc.id,
      assertions: [...new Set(refs(doc.body).filter((r) => r.includes('#case:')))].map((r) =>
        bind(r),
      ),
    })),
    claims: catalog.documents.flatMap((doc) =>
      doc.rows.map((row) => ({
        id: row.id,
        docId: doc.id,
        anchor: `evidence-${row.id}`,
        kind:
          kinds[`${doc.id}/${row.id}`] ??
          (doc.metadata.viewType === 'file-dependency'
            ? 'import'
            : doc.metadata.viewType === 'state'
              ? 'state-transition'
              : 'documented-relation'),
        sourceRefs: refs(row.code),
        assertions: refs(row.test)
          .filter((r) => r.includes('#case:'))
          .map((r) => bind(r)),
      })),
    ),
    scenarios,
  };
}
export function relationErrors(relations, documents) {
  if (
    !relations ||
    relations.schemaVersion !== 1 ||
    !Array.isArray(relations.scenarios) ||
    !Array.isArray(relations.claims)
  ) {
    return ['Invalid relation index'];
  }
  const errors = [],
    seen = new Set();
  for (const claim of relations.claims) {
    if (
      ![
        'import',
        'call',
        'data-flow',
        'ownership',
        'state-transition',
        'documented-relation',
      ].includes(claim.kind)
    ) {
      errors.push(`Invalid relation kind: ${claim.id}`);
    }
    if (!documents.some((d) => d.id === claim.docId && d.rows.some((r) => r.id === claim.id))) {
      errors.push(`Relation claim missing: ${claim.id}`);
    }
  }
  for (const scenario of relations.scenarios) {
    const doc = documents.find((d) => d.id === scenario.docId);
    if (!scenario.id || seen.has(scenario.id)) {
      errors.push('Duplicate or missing scenario identity');
    }
    seen.add(scenario.id);
    if (!doc) {
      errors.push(`Scenario document missing: ${scenario.id}`);
      continue;
    }
    if (
      !doc.body.includes(`id="${scenario.anchor}"`) &&
      !documentSections(doc.body).some((s) => s.id === scenario.anchor)
    ) {
      errors.push(`Scenario anchor missing: ${scenario.id}`);
    }
    for (const edge of scenario.edgeIds ?? []) {
      if (!relations.claims.some((c) => c.docId === doc.id && c.id === edge)) {
        errors.push(`Scenario claim missing: ${scenario.id}/${edge}`);
      }
    }
  }
  return errors;
}
