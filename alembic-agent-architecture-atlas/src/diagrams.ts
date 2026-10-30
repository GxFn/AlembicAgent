let mermaidModule: Promise<typeof import('mermaid')['default']> | undefined;
function getMermaid() {
  mermaidModule ??= import('mermaid')
    .then(({ default: mermaid }) => {
      configureMermaid(mermaid);
      return mermaid;
    })
    .catch((error: unknown) => {
      mermaidModule = undefined;
      throw error;
    });
  return mermaidModule;
}

import {
  type Diagram,
  escapeHtml,
  type Inventory,
  type RenderReceipt,
  required,
  selectDependencyGraph,
} from './model';

function configureMermaid(mermaid: typeof import('mermaid')['default']) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: 'Arial, PingFang SC, Microsoft YaHei, sans-serif',
    themeVariables: {
      primaryColor: '#e6f0ec',
      primaryTextColor: '#193b32',
      primaryBorderColor: '#75998b',
      lineColor: '#6b7d75',
      fontSize: '14px',
      edgeLabelBackground: '#faf9f5',
    },
    flowchart: { htmlLabels: false, curve: 'basis', nodeSpacing: 26, rankSpacing: 40, padding: 18 },
    suppressErrorRendering: true,
  });
}
let serial = 0;
/** 一页所有图共享释放集合；generation 防止迟到渲染写入下一页。 */
export class DiagramScope {
  private active = true;
  private disposers: (() => void)[] = [];
  dispose() {
    this.active = false;
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
  }
  async mermaid(host: HTMLElement, diagram: Diagram, select: (value: string) => void) {
    try {
      const mermaid = await getMermaid();
      if (!this.active || !host.isConnected) {
        return;
      }
      const result = await mermaid.render(`atlas-graph-${++serial}`, diagram.source);
      if (!this.active || !host.isConnected) {
        return;
      }
      host.innerHTML = `<div class="graph-toolbar"><span>拖动平移 · 滚轮缩放</span><button data-zoom="in" aria-label="放大图">＋</button><button data-zoom="out" aria-label="缩小图">−</button><button data-zoom="reset">适应</button><button data-zoom="full">全屏</button></div><div class="graph-viewport" tabindex="0" aria-label="${escapeHtml(diagram.title)}"><div class="graph-canvas">${result.svg}</div></div><p class="graph-hint">选择节点查看来源，选择 E- 编号定位证据。键盘可使用图下节点与边列表。</p><details class="graph-source"><summary>节点与边／图源</summary><div class="graph-index"></div><pre><code>${escapeHtml(diagram.source)}</code></pre></details>`;
      const viewport = required(host.querySelector<HTMLElement>('.graph-viewport'));
      const canvas = required(host.querySelector<HTMLElement>('.graph-canvas'));
      const svg = required(canvas.querySelector('svg'));
      svg.style.maxWidth = 'none';
      svg.style.width = '100%';
      svg.style.height = 'auto';
      let scale = 1,
        x = 0,
        y = 0,
        drag: {
          x: number;
          y: number;
        } | null = null,
        moved = false;
      const apply = () => {
        canvas.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
      };
      const zoom = (delta: number) => {
        scale = Math.min(3.5, Math.max(0.35, scale + delta));
        apply();
      };
      viewport.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          zoom(event.deltaY < 0 ? 0.12 : -0.12);
        },
        { passive: false },
      );
      viewport.addEventListener('pointerdown', (event) => {
        drag = { x: event.clientX - x, y: event.clientY - y };
        moved = false;
      });
      viewport.addEventListener('pointermove', (event) => {
        if (!drag) {
          return;
        }
        const nextX = event.clientX - drag.x,
          nextY = event.clientY - drag.y;
        if (!moved && Math.abs(nextX - x) + Math.abs(nextY - y) < 4) {
          return;
        }
        viewport.setPointerCapture(event.pointerId);
        x = nextX;
        y = nextY;
        moved = true;
        apply();
      });
      viewport.addEventListener('pointerup', () => {
        drag = null;
      });
      viewport.addEventListener('keydown', (event) => {
        if (event.key === '+' || event.key === '=') {
          zoom(0.15);
        }
        if (event.key === '-') {
          zoom(-0.15);
        }
        if (event.key === '0') {
          scale = 1;
          x = 0;
          y = 0;
          apply();
        }
      });
      host.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((button) => {
        button.addEventListener('click', () => {
          switch (button.dataset.zoom) {
            case 'in':
              zoom(0.2);
              break;
            case 'out':
              zoom(-0.2);
              break;
            case 'reset':
              scale = 1;
              x = 0;
              y = 0;
              apply();
              break;
            case 'full':
              if (document.fullscreenElement === host) {
                void document.exitFullscreen();
              } else {
                void host.requestFullscreen().catch(() => {
                  host.classList.toggle('expanded');
                  button.textContent = host.classList.contains('expanded') ? '退出全屏' : '全屏';
                });
              }
              break;
          }
        });
      });
      const labels = new Set<string>();
      for (const element of svg.querySelectorAll<SVGElement>(
        '.node,.edgeLabel,.actor,.messageText',
      )) {
        const text = element.textContent?.trim() ?? '';
        if (!text) {
          continue;
        }
        labels.add(text);
        element.style.cursor = 'pointer';
        element.addEventListener('click', () => {
          if (!moved) {
            select(text);
          }
        });
      }
      const index = required(host.querySelector('.graph-index'));
      for (const label of labels) {
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', () => select(label));
        index.append(button);
      }
      this.disposers.push(() => {
        host.replaceChildren();
      });
    } catch (error: unknown) {
      if (this.active) {
        host.innerHTML = `<div class="error-panel">图未能渲染：${escapeHtml(error instanceof Error ? error.message : error)}<pre>${escapeHtml(diagram.source)}</pre></div>`;
      }
    }
  }
  async dependency(
    host: HTMLElement,
    inventory: Inventory,
    focus: string,
    direction: 'both' | 'out' | 'in',
    types: boolean,
    external: boolean,
    select: (file: string) => void,
  ) {
    if (!this.active) {
      return;
    }
    const [{ default: cytoscape }, { default: ELK }] = await Promise.all([
      import('cytoscape'),
      import('elkjs/lib/elk.bundled.js'),
    ]);
    if (!this.active || !host.isConnected) {
      return;
    }
    const graph = selectDependencyGraph(inventory, focus, direction, types, external);
    const internal = new Set(inventory.files.map((f) => f.path));
    const elements = [
      ...graph.nodes.map((p) => ({
        data: {
          id: p,
          label: p.split('/').slice(-2).join('/'),
          kind: internal.has(p) ? 'internal' : 'external',
          focus: p === focus ? 'yes' : 'no',
        },
      })),
      ...graph.edges.map((e, i) => ({
        data: {
          id: `edge-${i}`,
          source: e.from,
          target: e.to,
          label: e.typeOnly ? '类型' : e.kind === 're-export' ? '再导出' : '导入',
          typeOnly: e.typeOnly ? 'yes' : 'no',
        },
      })),
    ];
    const cy = cytoscape({
      container: host,
      elements,
      layout: { name: 'preset' },
      minZoom: 0.15,
      maxZoom: 3.5,
      wheelSensitivity: 0.2,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            shape: 'roundrectangle',
            'background-color': '#e8f0ec',
            'border-width': 1,
            'border-color': '#b4cabf',
            color: '#234236',
            width: 180,
            height: 44,
            'font-size': 11,
            'text-wrap': 'wrap',
            'text-max-width': '165px',
            'text-valign': 'center',
            'text-halign': 'center',
          },
        },
        {
          selector: 'node[focus="yes"]',
          style: { 'background-color': '#234e40', color: '#ffffff', 'border-color': '#234e40' },
        },
        {
          selector: 'node[kind="external"]',
          style: { 'background-color': '#f5ead7', 'border-style': 'dashed' },
        },
        {
          selector: 'edge',
          style: {
            width: 1.4,
            'line-color': '#9cb2a6',
            'target-arrow-color': '#9cb2a6',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': 9,
            'text-background-color': '#faf9f5',
            'text-background-opacity': 1,
          },
        },
        { selector: 'edge[typeOnly="yes"]', style: { 'line-style': 'dashed' } },
        { selector: ':selected', style: { 'border-color': '#bc7747', 'border-width': 3 } },
      ],
    });
    cy.on('tap', 'node', (event) => select(event.target.id()));
    // 直接持有异步 ELK 计算；第三方 cy 插件的 stop 不取消 then 中的节点写入，快速切页会
    // 向已销毁的 canvas 写布局。这里先检查页面世代，再把纯坐标交给仍存活的 cy。
    const engine = new ELK();
    void engine
      .layout({
        id: 'dependency-root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.spacing.nodeNode': '30',
        },
        children: graph.nodes.map((id) => ({ id, width: 180, height: 44 })),
        edges: graph.edges.map((edge, i) => ({
          id: `edge-${i}`,
          sources: [edge.from],
          targets: [edge.to],
        })),
      })
      .then((layout) => {
        if (!this.active || cy.destroyed() || !host.isConnected) {
          return;
        }
        cy.batch(() => {
          for (const node of layout.children ?? []) {
            cy.getElementById(node.id).position({ x: (node.x ?? 0) + 90, y: (node.y ?? 0) + 22 });
          }
        });
        cy.fit(undefined, 24);
      })
      .catch((error: unknown) => {
        if (!this.active || !host.isConnected) {
          return;
        }
        host.insertAdjacentHTML(
          'beforeend',
          `<p class="error-panel">ELK 布局失败：${escapeHtml(error instanceof Error ? error.message : error)}</p>`,
        );
      });
    const resize = new ResizeObserver(() => {
      if (!this.active) {
        return;
      }
      cy.resize();
      cy.fit(undefined, 24);
    });
    resize.observe(host);
    this.disposers.push(() => {
      resize.disconnect();
      // bundled ELK 在此使用进程内的有限任务代理，没有原生 Worker.terminate。
      // 切页立即释放画布；尚未完成的最多32节点布局由上面的 active 检查丢弃。
      cy.destroy();
    });
    return { cy, graph };
  }
}
export async function verifyDiagrams(
  diagrams: Diagram[],
  version: string,
  host: HTMLElement,
  progress: (text: string) => void,
  signal?: AbortSignal,
): Promise<RenderReceipt> {
  const mermaid = await getMermaid();
  const receipt: RenderReceipt = {
    renderer: 'mermaid',
    rendererVersion: version,
    checkedAt: new Date().toISOString(),
    results: [],
  };
  for (const [index, diagram] of diagrams.entries()) {
    signal?.throwIfAborted();
    if (!host.isConnected) {
      throw new Error('验证页面已离开');
    }
    progress(`${index + 1} / ${diagrams.length} · ${diagram.title}`);
    try {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(diagram.source),
      );
      const hex =
        'sha256:' +
        Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      if (hex !== diagram.digest) {
        throw new Error('图源摘要与采样不一致');
      }
      const rendered = await mermaid.render(`verify-${++serial}`, diagram.source);
      signal?.throwIfAborted();
      if (!host.isConnected) {
        throw new Error('验证页面已离开');
      }
      host.innerHTML = rendered.svg;
      const svg = host.querySelector('svg');
      if (!svg) {
        throw new Error('SVG missing');
      }
      const size = svg.getBoundingClientRect();
      if (size.width <= 0 || size.height <= 0 || !Number.isFinite(size.height)) {
        throw new Error('SVG dimensions invalid');
      }
      receipt.results.push({
        id: diagram.id,
        digest: hex,
        status: 'pass',
        width: size.width,
        height: size.height,
      });
    } catch (error: unknown) {
      receipt.results.push({
        id: diagram.id,
        digest: diagram.digest,
        status: 'fail',
        width: 0,
        height: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return receipt;
}
