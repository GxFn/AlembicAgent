import DOMPurify from 'dompurify';
import { marked } from 'marked';
import rawBootstrap from '../evidence/live/bootstrap.json';
import { docRoute, embeddedEvidenceKey } from '../scripts/relations.mjs';
import { renderInputKey } from '../scripts/render-contract.mjs';
import { DiagramScope, verifyDiagrams } from './diagrams';
import { AtlasAssetLoader, digestText, LatestSelection } from './loader';
import {
  type AtlasDocument,
  type Bootstrap,
  type Catalog,
  escapeHtml as h,
  parseRoute,
  pilotEvidence,
  type RenderAttempt,
  readingFreshness,
  renderMatches,
  required,
  type Snapshot,
  scopedEvidence,
  searchCatalog,
} from './model';
import { sectionIdentities } from './sections';
import './styles.css';
const loader = new AtlasAssetLoader(rawBootstrap as Bootstrap);
const navigation = new LatestSelection();
let catalog: Catalog;
const app = required(document.querySelector<HTMLDivElement>('#app'));
let scope = new DiagramScope();
let activeDocument: AtlasDocument | undefined;
let snapshot: Snapshot | undefined;
let direction: 'both' | 'out' | 'in' = 'both',
  includeTypes = true,
  includeExternal = false;
const viewNames: Record<string, string> = {
  architecture: '职责与边界',
  'file-dependency': '直接依赖',
  'call-flow': '真实调用',
  recovery: '回执与恢复',
  state: '状态分支',
  guide: '阅读指南',
  evidence: '证据',
  'vertical-slice': '完整时序',
};
const truthNames: Record<string, string> = {
  'in-progress-worktree': '工作树实况',
  'current-code': '当前提交',
  historical: '历史记录',
  stale: '待复核',
  'target-design': '目标设计',
};
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
const topics = () => snapshot?.config?.topics ?? catalog.config.topics;
const documents = () => snapshot?.documents ?? catalog.documents;
const inventory = () => snapshot?.inventory ?? catalog.inventory;
const renderReceipt = () => snapshot?.renderReceipt ?? (snapshot ? null : catalog.renderReceipt);
const badge = (text: string, kind = 'neutral') => `<span class="badge ${kind}">${h(text)}</span>`;
const anchor = (doc: AtlasDocument, label?: string) =>
  `<a href="#/doc/${doc.id}">${h(label ?? doc.metadata.title)}</a>`;
function selectedPilot() {
  return snapshot ? snapshot.pilot : catalog.pilot;
}
function selectedRenderer() {
  return snapshot
    ? (snapshot.rendererVersion ?? snapshot.renderReceipt?.rendererVersion ?? 'unknown')
    : catalog.rendererVersion;
}
async function navigate() {
  if (!catalog) {
    return;
  }
  scope.dispose();
  verification?.abort();
  const id = new URL(location.href).searchParams.get('snapshot');
  if (!id) {
    navigation.cancel();
    snapshot = undefined;
    render();
    return;
  }
  if (snapshot?.id === id) {
    navigation.cancel();
    render();
    return;
  }
  const main = required(document.querySelector<HTMLElement>('#main-content'));
  main.innerHTML = '<div class="empty" role="status">正在读取所选历史快照…</div>';
  required(document.querySelector('#evidence')).innerHTML =
    '<p class="empty">等待该快照自己的证据。</p>';
  await navigation.run(
    () => loader.snapshot(id),
    (value) => {
      snapshot = value;
      render();
    },
    (error) => {
      const target = required(document.querySelector<HTMLElement>('#main-content'));
      target.innerHTML = `<div class="error-panel"><h1>所选快照无法读取</h1><p>${h(error instanceof Error ? error.message : error)}</p><button id="retry-snapshot">重试当前选择</button> <a href="./">返回当前采样</a></div>`;
      required(document.querySelector('#retry-snapshot')).addEventListener('click', () => {
        void navigate();
      });
    },
  );
}
let verification: AbortController | null = null;

function shell() {
  const current = catalog.current?.id ?? '尚未封存';
  app.innerHTML = `<a class="skip-link" href="#main-content">跳到正文</a><header class="topbar"><button id="nav-toggle" class="icon-button" aria-label="展开导航">☰</button><a class="brand" href="#/home"><span class="brand-mark">A<span>·</span></span><span>AlembicAgent<small>ARCHITECTURE ATLAS</small></span></a><button class="search-trigger" id="search-open"><span>搜索专题、文件或符号</span><kbd>⌘ K</kbd></button><div class="snapshot-switch"><span class="status-dot"></span><label for="snapshot">阅读版本</label><select id="snapshot"><option value="">当前采样 · ${date(catalog.checkedAt)}</option>${catalog.history.map((s) => `<option value="${h(s.id)}" ${snapshot?.id === s.id ? 'selected' : ''}>历史 · ${h(s.id)}</option>`).join('')}</select></div></header><div class="layout"><aside class="sidebar" id="sidebar"><div class="side-intro"><span class="eyebrow">代码怎样成为行为</span><p>从边界到回执，<br>每条关系都有出处。</p></div><nav aria-label="主要导航"><a class="nav-item" href="#/home"><span>⌂</span> 开始阅读</a><a class="nav-item" href="#/files"><span>⌘</span> 文件与依赖</a><a class="nav-item" href="#/scenarios"><span>↳</span> 从故障出发</a><a class="nav-item" href="#/health"><span>◎</span> 来源与维护</a><a class="nav-item" href="#/doc/01-public-api-and-hosts"><span>↗</span> 宿主接入路线</a><a class="nav-item" href="#/doc/00-diagram-standard"><span>↗</span> 图谱阅读规范</a><div class="nav-heading">13 个专题 <span>SOURCE MAPS</span></div>${topics()
    .map((t) => {
      const doc = documents().find(
        (d) => d.metadata.topic === t.id && d.metadata.viewType === 'architecture',
      );
      return `<a class="topic-link ${doc ? '' : 'unavailable'}" href="#/doc/${doc?.id ?? `${t.slug}-overview`}"><span class="topic-number">${t.id}</span><span>${h(t.title)}</span></a>`;
    })
    .join(
      '',
    )}</nav><div class="sidebar-footer"><span class="tiny-label">SOURCE BASELINE</span><code>${h((snapshot?.baselineCommit ?? catalog.git.commit).slice(0, 10))}</code><p>只读架构文档<br>最近封存：${h(current)}</p></div></aside><main id="main-content" tabindex="-1"></main><aside class="evidence-panel" id="evidence" aria-label="来源与证据"></aside></div><dialog id="search-dialog"><div class="dialog-top"><label for="search-input">搜索图谱</label><button id="search-close" aria-label="关闭搜索">✕</button></div><input id="search-input" type="search" placeholder="例如 AgentRuntime、取消、knowledge.submit" autocomplete="off"><div id="search-results" aria-live="polite"></div></dialog><dialog id="source-dialog"><div class="dialog-top"><strong>来源定位</strong><button id="source-close" aria-label="关闭来源">✕</button></div><div id="source-details"></div></dialog><div class="toast" id="toast" role="status"></div>`;
  required(document.querySelector('#nav-toggle')).addEventListener('click', () =>
    required(document.querySelector('#sidebar')).classList.toggle('is-open'),
  );
  required(document.querySelector<HTMLSelectElement>('#snapshot')).addEventListener(
    'change',
    (event) => {
      const id = (event.target as HTMLSelectElement).value;
      const url = new URL(location.href);
      if (id) {
        url.searchParams.set('snapshot', id);
      } else {
        url.searchParams.delete('snapshot');
      }
      history.pushState({}, '', url);
      void navigate();
    },
  );
  const dialog = required(document.querySelector<HTMLDialogElement>('#search-dialog'));
  required(document.querySelector('#search-open')).addEventListener('click', () => {
    dialog.showModal();
    required(document.querySelector<HTMLInputElement>('#search-input')).focus();
  });
  required(document.querySelector('#search-close')).addEventListener('click', () => dialog.close());
  required(document.querySelector('#source-close')).addEventListener('click', () =>
    required(document.querySelector<HTMLDialogElement>('#source-dialog')).close(),
  );
  required(document.querySelector<HTMLInputElement>('#search-input')).addEventListener(
    'input',
    search,
  );
}
function toast(message: string) {
  const node = required(document.querySelector<HTMLElement>('#toast'));
  node.textContent = message;
  node.classList.add('visible');
  window.setTimeout(() => node.classList.remove('visible'), 2200);
}
function search() {
  const query = required(document.querySelector<HTMLInputElement>('#search-input')).value;
  const result = searchCatalog(documents(), inventory().files, query);
  const host = required(document.querySelector('#search-results'));
  host.innerHTML = query.trim()
    ? `<p class="search-count">${result.totalDocuments} 篇文档 · ${result.totalFiles} 个文件；展示前 ${result.documents.length} 篇／${result.files.length} 个</p>${result.documents.length ? '<h3>专题与说明</h3>' : ''}${result.documents.map((d) => `<a class="search-result" href="${docRoute(d.id, d.section)}"><span>${h(d.metadata.title)}</span><small>${viewNames[d.metadata.viewType]} · ${snapshot ? '历史时点' : h(d.freshness)} · 专题 ${d.metadata.topic}</small><p>${h(d.snippet)}</p></a>`).join('')}${result.files.length ? '<h3>文件与符号</h3>' : ''}${result.files
        .map(
          (f) =>
            `<a class="search-result file-result" href="#/files/${encodeURIComponent(f.path)}"><code>${h(f.path)}</code><small>${
              h(
                f.symbols
                  .filter((s) => s.toLowerCase().includes(query.toLowerCase()))
                  .slice(0, 3)
                  .join(' · '),
              ) || f.kind
            }</small></a>`,
        )
        .join(
          '',
        )}${result.documents.length + result.files.length === 0 ? '<p class="empty">没有匹配结果。可尝试更短的符号名或路径片段。</p>' : ''}`
    : '<p class="empty">输入一个概念、路径或符号，进入对应实现。</p>';
  host.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () =>
      required(document.querySelector<HTMLDialogElement>('#search-dialog')).close(),
    );
  });
}
function sideEvidence(doc?: AtlasDocument, edgeId?: string) {
  const panel = required(document.querySelector('#evidence'));
  const scoped = snapshot ? snapshot.scopedRuns : catalog.scopedRuns;
  const scopedState = scopedEvidence(scoped, Boolean(snapshot));
  const local = doc ? pageEvidence(doc, edgeId) : null;
  const pilotState = pilotEvidence(selectedPilot(), catalog.pilotFreshness, Boolean(snapshot));
  const attempt = snapshot ? snapshot.renderAttempt : catalog.renderAttempt;
  const attemptLabel = snapshot
    ? '历史渲染记录'
    : attempt?.status === 'pass'
      ? catalog.renderFreshness === 'matched'
        ? '最近尝试通过'
        : '当前验证未确认／需重渲染'
      : attempt?.status === 'fail'
        ? '最近尝试失败'
        : attempt?.status === 'running'
          ? '最近尝试进行中'
          : attempt?.status === 'cancelled'
            ? '最近尝试已取消'
            : '尚无本版验证尝试';
  const all = documents(),
    stale = all.filter((d) => d.freshness !== 'matched' || d.errors.length).length;
  const rendered = all
    .flatMap((d) => d.diagrams)
    .filter((d) => renderMatches(renderReceipt(), d, selectedRenderer())).length;
  panel.innerHTML = `<div class="panel-label">READING EVIDENCE <span>↗</span></div><h2>${doc ? '这页的依据' : '当前阅读依据'}</h2>${snapshot && !snapshot.config ? '<p class="muted">旧快照未记录导航配置，导航沿用当前目录；正文与证据仍取历史。</p>' : ''}${!snapshot && catalog.evidenceDiagnostics?.length ? `<div class="warning-panel">${catalog.evidenceDiagnostics.map(h).join('<br>')}</div>` : ''}<div class="evidence-block"><span class="tiny-label">来源身份</span>${badge(snapshot ? '历史快照' : (truthNames[doc?.metadata.truthKind ?? 'in-progress-worktree'] ?? '工作树实况'), snapshot ? 'warning' : 'neutral')}<p>${snapshot ? '历史采样不代表今日源码状态。' : '文档按采样时的源码描述；当前输入是否一致见下方指纹状态。'}</p><code>${h((snapshot?.baselineCommit ?? catalog.git.commit).slice(0, 12))}</code></div><div class="evidence-block"><span class="tiny-label">源码指纹</span>${badge(snapshot ? '历史时点' : doc ? (doc.freshness === 'matched' ? '输入一致' : '来源已变化') : stale ? `${stale} 篇需复核` : '采样输入一致', snapshot ? 'neutral' : (doc ? doc.freshness === 'matched' : stale === 0) ? 'good' : 'warning')}<p>${date(snapshot?.capturedAt ?? catalog.checkedAt)} 采样<br>页面不是实时仓库监控。</p>${doc ? `<span class="mono-caption">${doc.inputFiles.length} 个输入 · ${h(doc.metadata.reviewDepth)} 阅读</span>` : ''}</div><div class="evidence-block"><span class="tiny-label">图形渲染 · 最近成功</span>${badge(attemptLabel, snapshot ? 'neutral' : attempt?.status === 'pass' && catalog.renderFreshness === 'matched' ? 'good' : 'warning')}<strong>${doc ? doc.diagrams.filter((d) => renderMatches(renderReceipt(), d, selectedRenderer())).length : rendered} / ${doc ? doc.diagrams.length : all.flatMap((d) => d.diagrams).length}</strong><p>图源摘要与 ${snapshot ? '历史' : ''} Mermaid ${h(selectedRenderer())} 匹配。<br>渲染通过不代表运行行为通过。</p></div>${!doc || doc.body.includes('alembic-agent-architecture-atlas/test/pilot.test.ts#') ? `<div class="evidence-block"><span class="tiny-label">工具回合样板</span>${badge(pilotState.label, pilotState.tone)}<p>真实 Service → Runtime → Router<br>模型与宿主上下文为可控 fixture。</p><a href="#/doc/13-receipt-and-recovery">查看回执与状态 →</a></div>` : ''}${local ?? `<div class="evidence-block"><span class="tiny-label">全部 Agent 定向执行</span>${badge(scopedState.label, scopedState.tone)}<p>按 case 选择执行，未运行的用例不计入通过。<br>Core 仅为外部公开合同。</p>${documents().some((d) => d.id === '13-knowledge-production') ? '<a href="#/doc/13-knowledge-production">查看知识生产纵切 →</a>' : ''}</div>`}${doc ? `<details open><summary>本页导航</summary><div id="page-toc"></div></details><details><summary>输入文件 ${doc.inputFiles.length}</summary><ul class="source-list">${doc.inputFiles.map((p) => `<li><button data-source="${h(p)}">${h(p)}</button></li>`).join('')}</ul></details>` : `<div class="evidence-block"><span class="tiny-label">解析边界</span><p>${inventory().unresolved.length} 处未解析加载被单列。<br>不猜测动态调用或外部包内部实现。</p></div>`}`;
  panel.querySelectorAll<HTMLElement>('[data-claim]').forEach((n) => {
    n.addEventListener('click', () => selectGraph(n.dataset.claim ?? ''));
  });
  panel.querySelector('[data-page-executions]')?.addEventListener('click', () => {
    const relation = selectedRelations();
    const claims =
      relation?.claims.filter((c) => c.docId === doc?.id && (!edgeId || c.id === edgeId)) ?? [];
    const assertions = edgeId
      ? claims.flatMap((c) => c.assertions)
      : (relation?.pages?.find((p) => p.docId === doc?.id)?.assertions ??
        claims.flatMap((c) => c.assertions));
    const groupIds = new Set(assertions.flatMap((a) => a.executions.map((e) => e.groupId)));
    showAsset('本页精确断言与执行身份', {
      claims,
      assertions,
      groups: scoped?.groups.filter((g) => groupIds.has(g.id)) ?? [],
      meaning: '定位或通过只适用于这些断言；未证明全部分支或真实生产宿主。',
    });
  });
  if (doc) {
    fillToc(doc);
  }
  panel.querySelectorAll<HTMLElement>('[data-source]').forEach((n) => {
    n.addEventListener('click', () => showSource(required(n.dataset.source)));
  });
}
function selectedRelations() {
  return snapshot ? snapshot.relations : catalog.relations;
}
function fillToc(doc: AtlasDocument) {
  const toc = document.querySelector('#page-toc');
  if (!toc) {
    return;
  }
  toc.replaceChildren();
  document.querySelectorAll<HTMLElement>('.prose h2').forEach((heading) => {
    const link = document.createElement('a');
    link.textContent = heading.textContent;
    link.href = docRoute(doc.id, heading.id);
    toc.append(link);
  });
}
function locateRoute() {
  const route = parseRoute(location.hash);
  if (route.kind !== 'doc') {
    return;
  }
  const id = route.edge ? `evidence-${route.edge}` : route.section;
  if (!id) {
    return;
  }
  const target = document.getElementById(id);
  if (target) {
    target.scrollIntoView({ block: 'start' });
    if (route.edge && activeDocument) {
      target.classList.add('evidence-selected');
      sideEvidence(activeDocument, route.edge);
    }
  }
}
function pageEvidence(doc: AtlasDocument, edgeId?: string) {
  const relations = selectedRelations();
  if (!relations) {
    return '<div class="evidence-block"><span class="tiny-label">本页行为证据</span><p>这个历史版本未记录精确关系索引，不能从当前版本借用执行状态。</p></div>';
  }
  const claims = relations.claims.filter((c) => c.docId === doc.id && (!edgeId || c.id === edgeId));
  const assertions = [
    ...new Map(
      (edgeId
        ? claims.flatMap((c) => c.assertions)
        : (relations.pages?.find((p) => p.docId === doc.id)?.assertions ??
          claims.flatMap((c) => c.assertions))
      ).map((a) => [a.ref, a]),
    ).values(),
  ];
  const executions = [
    ...new Map(
      assertions.flatMap((a) => a.executions).map((e) => [`${e.groupId}/${e.caseId}`, e]),
    ).values(),
  ];
  const passed = executions.filter(
    (e) => e.status === 'passed' && e.runStatus === 'pass' && e.inputFreshness === 'matched',
  ).length;
  const pilotBound = [
    ...new Set(assertions.flatMap((a) => (a.pilotScenario ? [a.pilotScenario.id] : []))),
  ].length;
  const pending = assertions.filter((a) => !a.executions.length && !a.pilotScenario).length;
  const stale = executions.length - passed;
  const executionLabel =
    [passed ? `${passed} 次定向执行通过` : '', pilotBound ? `${pilotBound} 个样板场景通过` : '']
      .filter(Boolean)
      .join(' · ') || '尚无精确执行绑定';
  return `<div class="evidence-block"><span class="tiny-label">${edgeId ? h(edgeId) : '本页'} · 精确断言</span>${badge(`${snapshot ? '历史 · ' : ''}${executionLabel}`, (passed > 0 || pilotBound > 0) && !stale ? 'good' : 'neutral')}<p>${assertions.length} 条断言定位，${pilotBound} 个精确样板场景；${pending} 条尚无精确执行绑定${stale ? `；${stale} 次结果待复核` : ''}。<br>只证明对应断言，不能推出本页全部行为已覆盖。</p><button class="text-button" data-page-executions>查看采集身份与命令 →</button>${edgeId ? `<p><a href="${docRoute(doc.id)}">回到整页证据</a></p>` : ''}<details><summary>结论与图边 ${claims.length}</summary>${claims.map((c) => `<p><button class="edge-ref" data-claim="${h(c.id)}">${h(c.id)}</button> · ${c.assertions.length} 条断言</p>`).join('')}</details></div>`;
}
function scenariosPage(main: HTMLElement) {
  const relations = selectedRelations();
  main.innerHTML = `<div class="breadcrumb"><a href="#/home">架构图谱</a><span>/</span> 故障阅读路线</div><h1>从症状走到责任与证据。</h1><p class="page-intro">入口只索引正文；副作用、重试前提和恢复责任以所选版本的原文为准。</p>${relations ? `<label class="scenario-filter">筛选症状或诊断码<input id="scenario-query" type="search" placeholder="例如 timeout、HOST、readiness、T3"></label><div id="scenario-list" class="scenario-list"></div>` : '<div class="empty">这个历史版本没有故障索引；请使用该版本原有专题，不会显示当前场景。</div>'}`;
  sideEvidence();
  if (!relations) {
    return;
  }
  const update = () => {
    const query = required(
      document.querySelector<HTMLInputElement>('#scenario-query'),
    ).value.toLocaleLowerCase();
    const matches = relations.scenarios.filter((s) =>
      `${s.title} ${s.symptoms?.join(' ')} ${s.diagnostics?.join(' ')}`
        .toLocaleLowerCase()
        .includes(query),
    );
    required(document.querySelector('#scenario-list')).innerHTML =
      matches
        .map(
          (s, i) =>
            `<a class="scenario-card" href="${docRoute(s.docId, s.anchor)}"><span class="eyebrow">${String(i + 1).padStart(2, '0')} / ${h(s.id)}</span><h2>${h(s.title)}</h2><p>${h(s.symptoms?.join(' · ') ?? '')}</p><small>${h(s.diagnostics?.join(' · ') ?? '')}</small><span>进入原文与证据 →</span></a>`,
        )
        .join('') || '<p class="empty">没有匹配场景；可以继续搜索全文或文件。</p>';
  };
  required(document.querySelector('#scenario-query')).addEventListener('input', update);
  update();
}
function healthPage(main: HTMLElement) {
  const health = snapshot ? snapshot.health : catalog.health;
  if (!health) {
    main.innerHTML =
      '<h1>来源与维护</h1><p class="empty">该历史版本未封存维护报告；不会套用今天的源码状态。</p>';
    sideEvidence();
    return;
  }
  const counts = health.changes.reduce<Record<string, number>>((out, c) => {
    out[c.status] = (out[c.status] ?? 0) + 1;
    return out;
  }, {});
  main.innerHTML = `<div class="breadcrumb"><a href="#/home">架构图谱</a><span>/</span> 来源与维护</div><h1>先看来源，再决定复核范围。</h1><p class="page-intro">${h(date(health.sampledAt))} 采样，比较基线 ${h(health.baseline ?? '无')}。${snapshot ? '这是封存时报告。' : '静态页面不会监控采样后的外部变化。'}</p><div class="health-grid"><section><h2>来源与阅读</h2><strong>${health.readings.matched} / ${health.sourceCount}</strong><p>源码阅读哈希匹配；${health.readings.stale} 变化、${health.readings.missing} 缺失。阅读深度另见文件记录。</p></section><section><h2>当前说明</h2><strong>${health.documents.matched} / ${health.documents.total}</strong><p>来源与引用检查匹配；${health.documents.needsReview} 篇需复核。</p></section><section><h2>执行与图形</h2><p>六场景：${h(health.pilot)}<br>渲染：${h(health.render)}<br>定向组：${health.executionGroups.filter((g) => g.status === 'pass' && g.freshness === 'matched').length} / ${health.executionGroups.length} 匹配通过</p></section></div><h2>相对基线的变动输入</h2><p>新增 ${counts.added ?? 0} · 变化 ${counts.changed ?? 0} · 删除 ${counts.removed ?? 0}。影响集合基于正文引用与声明输入；未知动态依赖保守失效。${health.renderNeeds.length} 份图源相对基线变化，其当前渲染状态单独判断。</p><label class="scenario-filter">定位路径<input id="impact-query" type="search" placeholder="例如 sourcePolicy、fixture、Runtime"></label><p id="impact-count" class="muted"></p><div id="impact-list"></div><details><summary>诊断分层 ${health.diagnostics.length} 页</summary>${health.diagnostics.map((d) => `<p><a href="${docRoute(d.id)}">${h(d.title)}</a><br>${d.primary.map(h).join('<br>')}<br>另有 ${d.secondaryCount} 条连带诊断。</p>`).join('') || '<p>当前无文档诊断。</p>'}</details><details><summary>定向执行的输入范围</summary>${health.executionGroups.map((g) => `<p><code>${h(g.id)}</code> · ${h(g.status)} / ${h(g.freshness)}<br>${h(g.scope)}</p>`).join('')}</details>`;
  sideEvidence();
  const update = () => {
    const query = required(
      document.querySelector<HTMLInputElement>('#impact-query'),
    ).value.toLocaleLowerCase();
    const matches = health.impacts.filter((i) => i.path.toLocaleLowerCase().includes(query));
    required(document.querySelector('#impact-count')).textContent =
      `${matches.length} 项匹配；展示前 ${Math.min(matches.length, 24)} 项。`;
    required(document.querySelector('#impact-list')).innerHTML = matches
      .slice(0, 24)
      .map(
        (i) =>
          `<details class="impact-item"><summary><code>${h(i.path)}</code> · ${h(i.status)}</summary><a href="#/files/${encodeURIComponent(i.path)}">阅读文件与消费者 →</a><p>${i.documents.length} 篇声明输入关联，${i.executionGroups.length} 个执行组；正文提及优先。</p><ul>${[
            ...i.documents,
          ]
            .sort((a, b) => Number(b.semantic) - Number(a.semantic))
            .map(
              (d) =>
                `<li><a href="${docRoute(d.id)}">${h(d.title)}</a> · ${d.semantic ? '正文提及' : '输入闭包'}</li>`,
            )
            .join(
              '',
            )}</ul><details><summary>受影响执行组</summary>${i.executionGroups.map(h).join('<br>') || '没有声明关联；不推断动态覆盖。'}</details></details>`,
      )
      .join('');
  };
  required(document.querySelector('#impact-query')).addEventListener('input', update);
  update();
}

function home(main: HTMLElement) {
  const pilotState = pilotEvidence(selectedPilot(), catalog.pilotFreshness, Boolean(snapshot));
  const all = documents(),
    sourceCount = inventory().files.filter((f) => f.kind === 'source').length;
  const readyTopics = topics().filter((t) => all.some((d) => d.metadata.topic === t.id));
  const pilot = all.find((d) => d.id === '13-complete-sequence');
  main.innerHTML = `<div class="breadcrumb">工程阅读室 <span>/</span> AlembicAgent</div><section class="hero"><div class="eyebrow"><span class="short-line"></span> FOLLOW THE EXECUTION</div><h1>读懂一次请求，<br>再读懂整个系统<span>。</span></h1><p class="hero-copy">从 Agent 的职责边界出发，沿真实调用走到工具回执。<br>把实现、依赖、失败分支和验证依据放在同一条阅读路线上。</p><div class="hero-actions"><a class="button primary" href="#/doc/${pilot?.id ?? '13-end-to-end-overview'}">开始阅读完整样板 <span>↗</span></a><a class="text-link" href="#/scenarios">按失败症状找路径 →</a><a class="text-link" href="#/files">按文件寻找实现 →</a></div><div class="stats"><div><strong>${String(readyTopics.length).padStart(2, '0')}</strong><span>架构专题</span></div><div><strong>${sourceCount}</strong><span>源码文件</span></div><div><strong>${all.flatMap((d) => d.diagrams).length}</strong><span>有据可查的图</span></div><div><strong>${String(pilotState.count).padStart(2, '0')}</strong><span>记录通过场景</span></div></div></section><section class="pilot-card"><div class="card-overline"><span>01 / FIRST WALKTHROUGH</span>${badge(pilotState.label, pilotState.tone)}</div><h2>一次请求到工具回执</h2><p>不在 handler 处结束：继续追踪信封、模型投影与最终结果。</p><div class="flow-strip"><span><b>01</b>Service<small>编译与装配</small></span><i>→</i><span><b>02</b>Runtime<small>循环与预算</small></span><i>→</i><span><b>03</b>Tool Router<small>准入与执行</small></span><i>→</i><span><b>04</b>Receipt<small>回程与状态</small></span></div><a href="#/doc/13-receipt-and-recovery">查看成功、拒绝、取消、超时与部分结果 <span>→</span></a></section><section class="topic-section"><div class="section-heading"><div><span class="eyebrow">EXPLORE BY QUESTION</span><h2>沿着问题进入架构</h2></div><span>${readyTopics.length} / 13 专题已编目</span></div><div class="topic-grid">${topics()
    .map((t) => {
      const doc = all.find(
        (d) => d.metadata.topic === t.id && d.metadata.viewType === 'architecture',
      );
      return `<a class="topic-card ${doc ? '' : 'unavailable'}" href="#/doc/${doc?.id ?? `${t.slug}-overview`}"><span class="topic-number">${t.id}</span><h3>${h(t.title)}</h3><p>${h(t.question)}</p><span class="card-arrow">↗</span></a>`;
    })
    .join(
      '',
    )}</div></section><div class="bottom-note">文档事实以源码指纹为界，行为结论以执行回执为界。<a href="#/doc/00-diagram-standard">阅读与维护规范 ↗</a></div>`;
  sideEvidence();
}
function markdown(body: string) {
  return DOMPurify.sanitize(marked.parse(body, { async: false, gfm: true }) as string);
}
function docPage(main: HTMLElement, doc: AtlasDocument) {
  activeDocument = doc;
  const order = [
    'architecture',
    'vertical-slice',
    'call-flow',
    'state',
    'recovery',
    'file-dependency',
    'guide',
  ];
  const siblings = documents()
    .filter((d) => d.metadata.topic === doc.metadata.topic)
    .sort((a, b) => order.indexOf(a.metadata.viewType) - order.indexOf(b.metadata.viewType));
  const body = doc.body.replace(
    /```mermaid\r?\n[\s\S]*?```/gu,
    () => '<div class="diagram-placeholder"></div>',
  );
  main.innerHTML = `<div class="breadcrumb"><a href="#/home">架构图谱</a><span>/</span>${h(topics().find((t) => t.id === doc.metadata.topic)?.title ?? '阅读指南')}</div><div class="document-meta">${badge(snapshot ? '历史阅读' : (truthNames[doc.metadata.truthKind] ?? doc.metadata.truthKind))}${badge(snapshot ? '历史时点' : doc.freshness === 'matched' ? '来源一致' : '来源待复核', doc.freshness === 'matched' && !snapshot ? 'good' : 'warning')}<span>${h(doc.metadata.reviewDepth)} · ${h(doc.metadata.verifiedAt)}</span></div><nav class="document-tabs" aria-label="专题视图">${siblings.map((d) => `<a class="${d.id === doc.id ? 'active' : ''}" href="#/doc/${d.id}">${h(d.metadata.viewType === 'guide' || siblings.filter((other) => other.metadata.viewType === d.metadata.viewType).length > 1 ? d.metadata.title : (viewNames[d.metadata.viewType] ?? d.metadata.title))}</a>`).join('')}</nav>${doc.errors.length ? `<div class="warning-panel"><strong>这份说明需要复核</strong><p>${doc.errors.map(h).join('<br>')}</p></div>` : ''}<article class="prose">${markdown(body)}</article><div class="bottom-note">来源和验证范围见右侧证据栏；窄屏位于正文下方。<a href="#/files">查看文件依赖 ↗</a></div>`;
  sideEvidence(doc);
  main.querySelectorAll<HTMLAnchorElement>('.prose a').forEach((link) => {
    const href = link.getAttribute('href') ?? '';
    if (/^https?:/u.test(href)) {
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      return;
    }
    if (href.startsWith('#/')) {
      return;
    }
    const url = new URL(href, `https://atlas.invalid/${doc.path}`);
    const resolved = url.pathname.slice(1);
    const target = documents().find((d) => d.path === resolved);
    if (target) {
      link.href = docRoute(target.id, decodeURIComponent(url.hash.slice(1)) || undefined);
    } else if (resolved === 'evidence/pilot.json') {
      link.href = '#';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        showAsset('组合样板执行回执', selectedPilot());
      });
    } else if (embeddedEvidenceKey(resolved)) {
      link.href = '#';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const key = embeddedEvidenceKey(resolved);
        const value = key ? (snapshot ?? catalog)[key] : null;
        showAsset(
          '当前阅读版本的专题证据',
          value ?? { status: 'unavailable', meaning: '该历史版本没有记录此项证据。' },
        );
      });
    } else {
      link.removeAttribute('href');
      link.title = '静态文档引用，阅读器未提供该资产';
    }
  });
  const headings = [
    ...main.querySelectorAll<HTMLElement>('.prose h2,.prose h3,.prose h4,.prose h5,.prose h6'),
  ];
  const headingIds = sectionIdentities(
    headings.map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      title: heading.textContent ?? '',
    })),
  );
  headings.forEach((heading, index) => {
    heading.id = headingIds[index];
  });
  fillToc(doc);
  main.querySelectorAll<HTMLElement>('.prose code').forEach((code) => {
    if (code.closest('pre')) {
      return;
    }
    const text = code.textContent ?? '';
    if (/^(src|scripts|test|config|docs|alembic-agent-architecture-atlas\/test)\//u.test(text)) {
      const button = document.createElement('button');
      button.className = 'source-ref';
      button.dataset.source = text;
      button.title = text;
      if (text.includes('#case:')) {
        const [p, s] = text.split('#case:');
        let title = s;
        try {
          title = decodeURIComponent(s);
        } catch {
          /*显示原文*/
        }
        button.textContent = `${p} · ${title}`;
      } else {
        button.textContent = text;
      }
      button.addEventListener('click', () => showSource(text));
      code.replaceWith(button);
    }
  });
  main.querySelectorAll<HTMLTableRowElement>('.prose tr').forEach((row) => {
    const id = row.cells[0]?.textContent?.trim();
    if (id && /^E-[A-Z0-9-]+-\d{2}$/u.test(id)) {
      row.id = `evidence-${id}`;
      const button = document.createElement('button');
      button.className = 'edge-ref';
      button.textContent = id;
      button.addEventListener('click', () => selectGraph(id));
      row.cells[0].replaceChildren(button);
    }
  });
  const placeholders = main.querySelectorAll<HTMLElement>('.diagram-placeholder');
  const rendered = [...placeholders].map((host, index) => {
    host.className = 'diagram-host';
    host.innerHTML = '<p class="empty">正在排布图形…</p>';
    const diagram = doc.diagrams[index];
    if (diagram) {
      return scope.mermaid(host, diagram, selectGraph);
    }
    return Promise.resolve();
  });
  const currentScope = scope;
  void Promise.allSettled(rendered).then(() => {
    if (scope === currentScope) {
      locateRoute();
    }
  });
}
function selectGraph(label: string) {
  const id = label.match(/E-[A-Z0-9-]+-\d{2}/u)?.[0];
  if (id) {
    const row = document.getElementById(`evidence-${id}`);
    if (row) {
      document.querySelectorAll('.evidence-selected').forEach((n) => {
        n.classList.remove('evidence-selected');
      });
      row.classList.add('evidence-selected');
      if (activeDocument) {
        sideEvidence(activeDocument, id);
        history.replaceState({}, '', docRoute(activeDocument.id, undefined, id));
      }
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`已定位 ${id}`);
    } else {
      toast('当前页没有对应证据行');
    }
    return;
  }
  const basename = label.split(' · ')[0];
  const matches =
    activeDocument?.inputFiles.filter((p) => p === basename || p.endsWith(`/${basename}`)) ?? [];
  if (matches.length === 1) {
    showSource(matches[0]);
  } else {
    showAsset('节点来源', matches.length ? matches : ['外部端口或概念节点；请参阅本图术语表。']);
  }
}
function showAsset(title: string, value: unknown) {
  const dialog = required(document.querySelector<HTMLDialogElement>('#source-dialog'));
  required(document.querySelector('#source-details')).innerHTML =
    `<h2>${h(title)}</h2><pre class="asset-json">${h(JSON.stringify(value, null, 2))}</pre>`;
  if (!dialog.open) {
    dialog.showModal();
  }
}
function showSource(ref: string) {
  const [file, ...parts] = ref.split('#');
  const symbol = parts.join('#');
  const entry = inventory().files.find((f) => f.path === file);
  const reading = (snapshot ? (snapshot.readings ?? []) : (catalog.readings ?? [])).find(
    (r) => r.path === file,
  );
  const importing = inventory().edges.filter((e) => e.to === file);
  const related = documents()
    .filter((d) => d.inputFiles.includes(file))
    .sort((a, b) => Number(b.body.includes(file)) - Number(a.body.includes(file)));
  const review = documents().find((d) => d.path === reading?.reviewPage);
  const scenarios =
    selectedRelations()?.scenarios.filter((s) =>
      selectedRelations()?.claims.some(
        (c) => c.docId === s.docId && c.sourceRefs.some((r) => r.split('#')[0] === file),
      ),
    ) ?? [];
  let name = symbol;
  if (symbol.startsWith('case:')) {
    try {
      name = decodeURIComponent(symbol.slice(5));
    } catch {
      /*错误锚点原样显示*/
    }
  }
  const dialog = required(document.querySelector<HTMLDialogElement>('#source-dialog'));
  required(document.querySelector('#source-details')).innerHTML =
    `<div class="source-heading"><span class="eyebrow">REPOSITORY RELATIVE REFERENCE</span><h2>${h(file.split('/').at(-1))}</h2><code class="full-path">${h(file)}</code>${name ? `<p class="symbol-name">${h(name)}</p>` : ''}<button class="button primary" id="copy-source">复制路径与锚点</button> <a class="button" id="open-deps" href="#/files/${encodeURIComponent(file)}">查看直接依赖</a></div><div class="source-metrics">${badge(entry?.kind ?? 'Atlas fixture')}${badge(reading ? `${reading.reading} · ${readingFreshness(entry, reading)}` : '未记录语义阅读')}${entry ? `<span>${entry.lines} 行 · ${importing.length} 条被依赖边</span>` : ''}</div><p>${h(reading?.role ?? '此引用在正文证据表中解释，定位不能代替行为覆盖。')}</p><p class="muted">${h(reading?.basis ?? '样板的执行状态由独立回执绑定。')}</p>${entry ? `<code class="digest">${h(entry.sha256)}</code>` : ''}${reading?.flow ? `<h3>行为链</h3><p>${h(reading.flow)}</p>` : ''}${reading?.risks?.length ? `<h3>失败与边界</h3><ul>${reading.risks.map((r) => `<li>${h(r)}</li>`).join('')}</ul>` : ''}${review ? `<p>${anchor(review, '阅读本次复核依据 →')}</p>` : ''}${reading?.tests?.length ? `<details><summary>已定位测试 ${reading.tests.length}（不等于执行通过）</summary>${reading.tests.map((r) => `<p><button class="source-ref" data-reading-test="${h(r)}">${h(r)}</button></p>`).join('')}</details>` : ''}${scenarios.length ? `<h3>相关故障入口</h3>${scenarios.map((s) => `<p><a href="${docRoute(s.docId, s.anchor)}">${h(s.title)}</a></p>`).join('')}` : ''}<h3>引用它的图谱页面 · 正文提及优先</h3><ul>${related.map((d) => `<li>${anchor(d)}</li>`).join('') || '<li>此库存文件尚未被专题引用。</li>'}</ul><p class="muted">这里提供可复制定位；没有配置代码托管地址或编辑器协议。</p>`;
  document.querySelectorAll<HTMLElement>('[data-reading-test]').forEach((n) => {
    n.addEventListener('click', () => showSource(n.dataset.readingTest ?? ''));
  });
  required(document.querySelector('#copy-source')).addEventListener('click', () => {
    void navigator.clipboard
      .writeText(ref)
      .then(() => toast('已复制来源定位'))
      .catch(() => {
        const el = required(document.querySelector('#source-details .full-path'));
        const range = document.createRange();
        range.selectNodeContents(el);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        toast('剪贴板不可用，已选中路径。');
      });
  });
  document.querySelectorAll('#source-details a').forEach((a) => {
    a.addEventListener('click', () => dialog.close());
  });
  if (!dialog.open) {
    dialog.showModal();
  }
}
function filePage(main: HTMLElement, requested: string) {
  const inv = inventory();
  if (requested && !inv.files.some((f) => f.path === requested)) {
    main.innerHTML =
      '<div class="error-panel"><h1>当前库存没有这个文件</h1><p>该路径可能是外部包、历史文件或无效地址；不会替换成另一个实现。</p><a href="#/files">回到文件索引 →</a></div>';
    sideEvidence();
    return;
  }
  const file =
    inv.files.find((f) => f.path === requested) ??
    inv.files.find((f) => f.path === 'src/agent/service/AgentService.ts') ??
    inv.files[0];
  if (!file) {
    main.innerHTML = '<div class="empty">当前快照无文件库存。</div>';
    return;
  }
  main.innerHTML = `<div class="breadcrumb"><a href="#/home">架构图谱</a><span>/</span> 文件与依赖</div><div class="section-heading"><div><span class="eyebrow">CHANGE WITH CONTEXT</span><h1>把一个文件放回关系里。</h1></div></div><p class="page-intro">${inv.files.length} 个库存文件，${inv.edges.length} 条仓内直接依赖。这里显示静态导入，动态调用与装配请回到专题。</p><div class="file-controls"><label>定位文件<input id="file-filter" placeholder="筛选全路径或符号…" type="search"></label><label>文件种类<select id="kind-filter"><option value="all">全部</option><option value="source">源码</option><option value="test">测试</option><option value="tooling">脚本</option><option value="support">配置／文档</option></select></label></div><div class="file-picker" id="file-picker" aria-label="文件选择"></div><section class="dependency-section"><div class="focus-heading"><span class="tiny-label">FOCUSED FILE</span><button class="full-path source-ref" id="focused-file">${h(file.path)}</button></div><div class="graph-controls"><label>关系<select id="direction"><option value="both">依赖与被依赖</option><option value="out">它依赖什么</option><option value="in">谁依赖它</option></select></label><label class="check-label"><input id="types" type="checkbox" ${includeTypes ? 'checked' : ''}>包含类型边</label><label class="check-label"><input id="external" type="checkbox" ${includeExternal ? 'checked' : ''}>显示外部包</label><button id="fit-graph">适应视图</button></div><div id="dependency-graph" aria-label="文件直接依赖关系图"></div><p id="graph-summary" class="graph-hint"></p><details open><summary>可访问的关系列表</summary><div id="dependency-list"></div></details></section><details class="unresolved"><summary>${inv.unresolved.length} 处未解析加载（不猜补）</summary>${inv.unresolved.map((u) => `<p><code>${h(u.from)}</code><br>${h(u.specifier ?? '非字面表达式')} · ${h(u.reason)}</p>`).join('')}</details>`;
  sideEvidence();
  const picker = required(document.querySelector('#file-picker'));
  const updatePicker = () => {
    const q = required(
      document.querySelector<HTMLInputElement>('#file-filter'),
    ).value.toLowerCase();
    const kind = required(document.querySelector<HTMLSelectElement>('#kind-filter')).value;
    const found = inv.files.filter(
      (f) =>
        (kind === 'all' || f.kind === kind) &&
        `${f.path} ${f.symbols.join(' ')}`.toLowerCase().includes(q),
    );
    picker.innerHTML = `<span class="picker-count">${found.length} 个匹配 · 显示前 12 个</span>${found
      .slice(0, 12)
      .map(
        (f) =>
          `<a href="#/files/${encodeURIComponent(f.path)}" class="${f.path === file.path ? 'selected' : ''}"><code>${h(f.path)}</code><span>${h(f.kind)}</span></a>`,
      )
      .join('')}${found.length ? '' : '<p class="empty">没有匹配文件。</p>'}`;
  };
  required(document.querySelector('#file-filter')).addEventListener('input', updatePicker);
  required(document.querySelector('#kind-filter')).addEventListener('change', updatePicker);
  updatePicker();
  required(document.querySelector('#focused-file')).addEventListener('click', () =>
    showSource(file.path),
  );
  required(document.querySelector<HTMLSelectElement>('#direction')).value = direction;
  void scope
    .dependency(
      required(document.querySelector<HTMLElement>('#dependency-graph')),
      inv,
      file.path,
      direction,
      includeTypes,
      includeExternal,
      (p) => {
        if (inv.files.some((f) => f.path === p)) {
          location.hash = `/files/${encodeURIComponent(p)}`;
        } else {
          showAsset('外部依赖端口', { package: p, scope: '只展示包边界，不递归读取外部实现。' });
        }
      },
    )
    .then((result) => {
      if (result && !result.cy.destroyed()) {
        required(document.querySelector('#graph-summary')).textContent =
          `一跳关系 · ${result.graph.nodes.length} 个节点／${result.graph.edges.length} 条边。${result.graph.omittedNodes ? `已省略 ${result.graph.omittedNodes} 个节点和 ${result.graph.omittedEdges} 条边，可收窄关系筛选。` : '当前筛选无省略。'}点击节点聚焦；下方列表提供全路径。`;
        required(document.querySelector('#fit-graph')).addEventListener('click', () =>
          result.cy.fit(undefined, 24),
        );
        required(document.querySelector('#dependency-list')).innerHTML =
          `<table><thead><tr><th>来源</th><th>目标</th><th>类别</th></tr></thead><tbody>${result.graph.edges.map((e) => `<tr><td><button data-source="${h(e.from)}">${h(e.from)}</button></td><td><button data-source="${h(e.to)}">${h(e.to)}</button></td><td>${e.typeOnly ? '类型 · ' : ''}${h(e.kind)}</td></tr>`).join('')}</tbody></table>`;
        document.querySelectorAll<HTMLElement>('#dependency-list [data-source]').forEach((b) => {
          b.addEventListener('click', () => showSource(required(b.dataset.source)));
        });
      }
    })
    .catch((error: unknown) => {
      if (main.isConnected) {
        console.error('Dependency graph load failed', error);
        const target = main.querySelector('#graph-summary');
        if (target) {
          target.textContent = '依赖图加载失败，可切换页面后重试。';
        }
      }
    });
  required(document.querySelector<HTMLSelectElement>('#direction')).addEventListener(
    'change',
    (event) => {
      direction = (event.target as HTMLSelectElement).value as typeof direction;
      render();
    },
  );
  required(document.querySelector<HTMLInputElement>('#types')).addEventListener(
    'change',
    (event) => {
      includeTypes = (event.target as HTMLInputElement).checked;
      render();
    },
  );
  required(document.querySelector<HTMLInputElement>('#external')).addEventListener(
    'change',
    (event) => {
      includeExternal = (event.target as HTMLInputElement).checked;
      render();
    },
  );
}
async function verifyPage(main: HTMLElement) {
  if (snapshot) {
    main.innerHTML =
      '<div class="warning-panel"><h1>历史快照只读</h1><p>历史内容不写入当前渲染回执。请选择当前采样再开始验证。</p><a href="?verify=1">验证当前采样 →</a></div>';
    sideEvidence();
    return;
  }
  const controller = new AbortController();
  verification = controller;
  // 即使开始请求尚未返回，也不能把旧 pass 展示成这次验证已通过。
  catalog.renderFreshness = 'pending';
  const active = () => !controller.signal.aborted && verification === controller;
  main.innerHTML =
    '<div class="breadcrumb">图谱验证 / 浏览器实际渲染</div><h1>逐图生成 SVG</h1><a href="./">返回图谱 →</a><p>逐一渲染本次采样的 Mermaid，保留最近成功回执并另记最近尝试。离开页面会停止未提交的验证；已发送的保存请求以服务端回执为准。</p><p id="verify-progress" role="status">准备中…</p><div id="verify-stage" class="verify-stage"></div><pre id="verify-result"></pre>';
  sideEvidence();
  const progress = required(main.querySelector('#verify-progress'));
  const output = required(main.querySelector('#verify-result'));
  const stage = required(main.querySelector<HTMLElement>('#verify-stage'));
  let id: string | undefined,
    settled = false;
  const post = async (message: unknown) => {
    const response = await fetch('/__atlas-render-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      throw new Error(`验证记录未保存：${await response.text()}`);
    }
    return (await response.json()) as { attempt: RenderAttempt };
  };
  try {
    const diagrams = catalog.documents.flatMap((d) => d.diagrams);
    const inputFingerprint = await digestText(renderInputKey(diagrams, catalog.rendererVersion));
    controller.signal.throwIfAborted();
    let started: { attempt: RenderAttempt } | undefined;
    for (let retry = 0; retry < 3; retry++) {
      controller.signal.throwIfAborted();
      const observed = await post({ action: 'inspect' });
      controller.signal.throwIfAborted();
      try {
        started = await post({
          action: 'begin',
          inputFingerprint,
          expectedAttemptId: observed.attempt?.id ?? null,
        });
        break;
      } catch (error: unknown) {
        if (!String(error).includes('Render authority changed') || retry === 2) {
          throw error;
        }
      }
    }
    if (!started) {
      throw new Error('无法获得验证身份');
    }
    id = started.attempt.id;
    controller.signal.throwIfAborted();
    catalog.renderAttempt = started.attempt;
    catalog.renderFreshness = 'stale';
    sideEvidence();
    const receipt = await verifyDiagrams(
      diagrams,
      catalog.rendererVersion,
      stage,
      (text) => {
        if (active()) {
          progress.textContent = text;
        }
      },
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const result = await post({ action: 'finish', id, receipt });
    settled = true;
    // 保存一经发出就按服务端终态对账；只更新同一 attempt 的数据，不触碰离开后的 DOM。
    if (catalog.renderAttempt?.id === id) {
      catalog.renderAttempt = result.attempt;
      catalog.renderFreshness = result.attempt.status === 'pass' ? 'matched' : 'stale';
      if (result.attempt.status === 'pass') {
        catalog.renderReceipt = receipt;
      }
    }
    if (!active()) {
      return;
    }
    progress.textContent =
      result.attempt.status === 'pass'
        ? `全部 ${receipt.results.length} 张图已实际渲染，回执已保存。`
        : '最近一次渲染失败；旧成功记录仅供参考。';
    output.textContent = JSON.stringify(
      {
        ok: result.attempt.status === 'pass',
        diagrams: receipt.results.length,
        renderer: receipt.rendererVersion,
        checkedAt: receipt.checkedAt,
        errors: result.attempt.errors,
      },
      null,
      2,
    );
    output.setAttribute('data-status', result.attempt.status);
    sideEvidence();
  } catch (error: unknown) {
    if (active()) {
      progress.textContent = `验证未完成：${error instanceof Error ? error.message : String(error)}`;
      output.setAttribute('data-status', 'fail');
    }
  } finally {
    if (id && !settled) {
      try {
        const cancelled = await post({ action: 'cancel', id });
        if (catalog.renderAttempt?.id === id) {
          catalog.renderAttempt = cancelled.attempt;
        }
        if (active()) {
          sideEvidence();
        }
      } catch (error: unknown) {
        console.warn('Render attempt cancellation was superseded or could not be recorded', error);
      }
    }
  }
}

function render() {
  verification?.abort();
  scope.dispose();
  scope = new DiagramScope();
  activeDocument = undefined;
  shell();
  const main = required(document.querySelector<HTMLElement>('#main-content'));
  if (new URL(location.href).searchParams.has('snapshot') && !snapshot) {
    main.innerHTML =
      '<div class="error-panel"><h1>没有找到指定的历史快照</h1><p>这个地址不会冒用当前工作树作为历史记录。</p><a href="/">返回当前图谱 →</a></div>';
    sideEvidence();
    return;
  }
  if (new URL(location.href).searchParams.has('verify')) {
    void verifyPage(main);
    return;
  }
  const route = parseRoute(location.hash);
  if (route.kind === 'home') {
    home(main);
  } else if (route.kind === 'doc') {
    const doc = documents().find((d) => d.id === route.id);
    if (doc) {
      docPage(main, doc);
    } else {
      main.innerHTML =
        '<div class="error-panel"><h1>这份阅读版本没有该文档</h1><p>检查当前／历史版本，或返回起点选择已有专题。</p><a href="#/home">回到阅读起点 →</a></div>';
      sideEvidence();
    }
  } else if (route.kind === 'scenarios') {
    scenariosPage(main);
  } else if (route.kind === 'health') {
    healthPage(main);
  } else if (route.kind === 'files') {
    filePage(main, route.id);
  } else {
    main.innerHTML = '<h1>无法识别这个阅读地址</h1><a href="#/home">回到阅读起点</a>';
    sideEvidence();
  }
  document.querySelectorAll<HTMLAnchorElement>('.sidebar a').forEach((a) => {
    if (a.hash === location.hash) {
      a.classList.add('active');
    }
  });
  if (!route.section && !route.edge) {
    window.scrollTo(0, 0);
  } else {
    locateRoute();
  }
}
window.addEventListener('hashchange', () => {
  void navigate();
});
window.addEventListener('popstate', () => {
  void navigate();
});
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.querySelector<HTMLDialogElement>('#search-dialog')?.showModal();
    document.querySelector<HTMLInputElement>('#search-input')?.focus();
  }
});
window.addEventListener('pagehide', () => {
  scope.dispose();
  navigation.cancel();
  verification?.abort();
});
// 首屏仅载入当前数据，所有历史和图引擎按进入相应视图后读取。
async function boot() {
  app.innerHTML =
    '<main><h1>AlembicAgent · 架构图谱</h1><p role="status">正在读取当前采样…</p></main>';
  try {
    catalog = await loader.current();
    shell();
    await navigate();
  } catch (error: unknown) {
    app.innerHTML = `<main class="error-panel"><h1>图谱数据加载失败</h1><p>${h(error instanceof Error ? error.message : error)}</p><button id="retry-boot">重新读取</button></main>`;
    required(document.querySelector('#retry-boot')).addEventListener('click', () => {
      void boot();
    });
  }
}
void boot();
