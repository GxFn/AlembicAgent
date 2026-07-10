/**
 * P0-1(挖掘质量升级)：E2E fixture 挖掘管线测试 — 真实组合链路。
 *
 * 此前挖掘 run 测试全 stub(runtimeBuilder 直接返回 mined:${id})，analyze→gate→produce→submit
 * 从未被组合验证。本测试用【脚本化 mock provider】走【真实管线】：
 *   coordinator fan-out → module-mining-dimension pipeline(insight 4 阶段) → 真 ToolRouter
 *   → 真 EvidenceLedger(采集/标注/哈希) → memory.note_finding(ledger-id 校验)
 *   → 真 insight 质量门 → produce → knowledge.submit(机械展开/新鲜度/in-process Core 授权门
 *   在 fixture 真实文件上做 fs 逐字校验) → gateway(fake，只记录 created)。
 *
 * mock 边界(仓规:AI 测试不依赖真实 key)：AI provider 是脚本(按可见工具面分辨 analyst/producer
 * 阶段，并从工具返回尾部解析真实 [evidence] E-n 标注再引用——复现真实数据流)；gateway 持久化为
 * 内存 fake。其余全为真实生产代码路径。
 *
 * 三个案例：
 *   1) 健康模块：3 handler 文件同约定 → 1 条 rule 候选 created(证据 refs/coreCode 逐字回填)。
 *   2) EVIDENCE_STALE 负例：produce 首调前改写被引用文件 → 新鲜度重哈希拒绝，零候选。
 *   3) 弱模块：analyst 零工具零发现 → record_repair 救不回 → degraded_no_findings →
 *      父结果 phases.abandonedModules 一等可见(P0-4 契约)。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import type { FunctionCall, LLMResult } from '../src/agent/runtime/AgentRuntimeTypes.js';
import { createSystemRunContext } from '../src/agent/runtime/SystemRunContext.js';
import type { AgentRunResult } from '../src/agent/service/AgentRunContracts.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import { AgentService } from '../src/agent/service/AgentService.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';

const FIXTURE_SOURCE = resolve(import.meta.dirname, 'fixtures', 'mining-e2e');
const HANDLER_FILES = [
  'src/handlers/user-handler.ts',
  'src/handlers/order-handler.ts',
  'src/handlers/billing-handler.ts',
];
const SHARED_FILE = 'src/shared/result.ts';
const E2E_TIMEOUT = 60_000;

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

/** 每个案例独立的 fixture 副本(EVIDENCE_STALE 案例要改写文件，绝不动仓内 fixture)。 */
function materializeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'alembic-mining-e2e-'));
  cpSync(FIXTURE_SOURCE, root, { recursive: true });
  tempRoots.push(root);
  return root;
}

interface RecordedCreate {
  items: Array<Record<string, unknown>>;
}

/** 内存 fake gateway：记录 items、全部 created。Core gateway 语义由 Core 自测；本测试聚焦 Agent 链。 */
function createFakeGateway() {
  const created: RecordedCreate[] = [];
  return {
    created,
    gateway: {
      async create(input: { items: Array<Record<string, unknown>> }) {
        created.push({ items: input.items });
        return {
          created: input.items.map((item, index) => ({
            id: `e2e-recipe-${created.length}-${index}`,
            title: String(item.title ?? ''),
          })),
          duplicates: [],
          rejected: [],
          blocked: [],
        };
      },
    },
  };
}

/**
 * 从 provider 可见消息里解析台账条目(真实数据流：模型只能引用它看到的)。
 * 双格式：① 工具返回尾部 `[evidence] E-1=path:1-20` 标注(可能被 head+tail 截断吞掉——
 * 真机同样发生)；② `evidence.search` 的 JSON items(`{"id":"E-2","file":"..."}`)——
 * 这是截断不敏感的生产设计发现路径，本 provider 与真模型一样依赖它兜底。
 */
function parseEvidenceRefs(messages: unknown): Map<string, string> {
  const byFile = new Map<string, string>();
  const scan = (text: string) => {
    for (const match of text.matchAll(/\b(E-\d+)=([^;\s"\\]+)/g)) {
      const id = match[1];
      const fileWithRange = match[2];
      const file = fileWithRange.split(':')[0];
      if (!byFile.has(file)) {
        byFile.set(file, id);
      }
    }
    for (const match of text.matchAll(/"id":\s*"(E-\d+)"\s*,\s*"file":\s*"([^"]+)"/g)) {
      const file = match[2].split(':')[0];
      if (!byFile.has(file)) {
        byFile.set(file, match[1]);
      }
    }
    // JSON.stringify 嵌套转义形态(工具文本被再包一层时 \" 变体)。
    for (const match of text.matchAll(
      /\\"id\\":\s*\\"(E-\d+)\\"\s*,\s*\\"file\\":\s*\\"([^"\\]+)\\"/g
    )) {
      const file = match[2].split(':')[0];
      if (!byFile.has(file)) {
        byFile.set(file, match[1]);
      }
    }
  };
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') {
        scan(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          const textPart = (part as { text?: unknown }).text;
          if (typeof textPart === 'string') {
            scan(textPart);
          }
        }
      }
    }
  }
  return byFile;
}

let callSeq = 0;
function fc(name: string, args: Record<string, unknown>): FunctionCall {
  callSeq += 1;
  return { id: `call-${callSeq}`, name, args };
}

const usage = { inputTokens: 50, outputTokens: 20 };

/**
 * 分析文本：结构化(标题/列表/代码块/file:line 引用/✅❌ 对比)以真实通过 insight 质量门与
 * Core 授权门的 CONTENT_CONTRAST 检查。措辞刻意避开 caller/callee/invoke 等调用链关系词——
 * Core 门禁对"具体调用链声明"要求 graph-backed refs(GRAPH_REF_INVALID)，本候选不做该类声明。
 */
function analystMarkdown(): string {
  return [
    '## Error handling convention',
    '',
    'All three handlers wrap return values with `wrapResult` from `src/shared/result.ts:12-18`:',
    '',
    '- `src/handlers/user-handler.ts:11-19` — getUser wraps lookup + not-found throw',
    '- `src/handlers/order-handler.ts:11-19` — getOrder wraps lookup + not-found throw',
    '- `src/handlers/billing-handler.ts:13-21` — issueInvoice wraps validation + insert',
    '',
    '✅ Correct — wrap the body, consumers receive a Result envelope (来源: src/handlers/user-handler.ts:11-19):',
    '',
    '```ts',
    'export function getUser(id: string): Result<User> {',
    '  return wrapResult(() => {',
    '    const user = users.get(id);',
    '    if (!user) {',
    '      throw new Error(`user not found: ${id}`);',
    '    }',
    '    return user;',
    '  });',
    '}',
    '```',
    '',
    '❌ Forbidden — throwing raw errors outward instead of returning a Result envelope:',
    '',
    '```ts',
    'export function getUser(id: string): User {',
    '  const user = users.get(id);',
    '  if (!user) {',
    '    throw new Error(`user not found: ${id}`);',
    '  }',
    '  return user;',
    '}',
    '```',
    '',
    '## Boundary',
    '',
    'The `Result<T>` envelope (`ok/data/error`) is the only error surface handlers expose;',
    'no handler throws raw errors outward. New handlers must follow the same shape.',
  ].join('\n');
}

/**
 * 脚本化 mining provider — 按可见工具面分辨阶段(比数调用序更稳，record_repair 微阶段天然兼容)：
 *   - 有 knowledge 工具 → producer：首调 submit(引用 analyst 真实台账 refs)，之后收尾文本；
 *   - 有 code 工具(analyst)：round1 批量 read → round2 note_finding(引用解析出的 E-ids) → round3 总结；
 *   - 只有 memory(record_repair 微阶段)：按 note_finding 轮处理(healthy 不会走到)。
 */
class ScriptedMiningProvider {
  readonly name = 'mining-e2e-scripted';
  // 模型名必须能被 ContextWindow.MODEL_CONTEXT_WINDOWS 正则识别——未知模型取保守小窗，
  // per-tool 结果配额会塌到 400 字下限，把工具返回(含台账标注)截成不可用(首跑真坑)。
  readonly model = 'deepseek-chat';
  behavior: 'healthy' | 'no-findings';
  onProducerFirstCall: (() => void) | null = null;
  #analystRound = 0;
  #submitted = false;
  #refsByFile = new Map<string, string>();

  constructor(behavior: 'healthy' | 'no-findings') {
    this.behavior = behavior;
  }

  async chatWithTools(_prompt: string, opts: Record<string, unknown>): Promise<LLMResult> {
    const toolNames = (Array.isArray(opts.toolSchemas) ? opts.toolSchemas : [])
      .map((schema) => String((schema as { name?: unknown }).name ?? ''))
      .filter(Boolean);
    const hasKnowledge = toolNames.includes('knowledge');
    const hasCode = toolNames.includes('code');

    // messages 里持续收集台账条目(工具返回在下一轮可见)。
    for (const [file, id] of parseEvidenceRefs(opts.messages)) {
      if (!this.#refsByFile.has(file)) {
        this.#refsByFile.set(file, id);
      }
    }

    if (hasKnowledge) {
      if (this.behavior === 'no-findings') {
        // 防御：弱模块 degrade 后 produce 应被跳过，不该到达这里。
        return { text: 'no candidates to submit', functionCalls: [], usage };
      }
      if (!this.#submitted) {
        this.#submitted = true;
        this.onProducerFirstCall?.();
        const refs = HANDLER_FILES.map((file) => this.#refsByFile.get(file)).filter(
          (ref): ref is string => typeof ref === 'string'
        );
        return {
          text: null,
          functionCalls: [
            fc('knowledge', {
              action: 'submit',
              params: {
                title: 'Wrap handler return values with wrapResult',
                description:
                  'Every handler function returns Result<T> produced by wrapResult instead of throwing raw errors outward.',
                kind: 'rule',
                trigger: 'adding or changing a handler function return path',
                whenClause: 'When implementing a handler function under src/handlers',
                doClause:
                  'Use wrapResult from src/shared/result.ts to wrap the handler body so consumers always receive a Result envelope',
                dontClause:
                  'Do not throw raw errors outward from handler functions or return bare values without the Result envelope',
                content: {
                  markdown: analystMarkdown(),
                  rationale:
                    'All three existing handlers (user/order/billing) wrap their bodies with wrapResult, so consumers pattern-match on Result instead of catching exceptions; a handler that throws raw errors outward breaks that contract.',
                },
                reasoning: {
                  sources: [
                    'src/handlers/user-handler.ts:11-19',
                    'src/handlers/order-handler.ts:11-19',
                    'src/handlers/billing-handler.ts:13-21',
                  ],
                  evidenceRefs: refs,
                },
              },
            }),
          ],
          usage,
        };
      }
      return { text: 'Production complete: 1 candidate submitted.', functionCalls: [], usage };
    }

    if (hasCode) {
      this.#analystRound += 1;
      if (this.#analystRound === 1) {
        // 批量 read(filePaths)：单 path 返回纯文本，台账采集不到 file 归属；批量返回
        // structuredContent.files[] 才产出带 file+range 的台账条目(真机 analyst 的主形态)。
        return {
          text: null,
          functionCalls: [
            fc('code', {
              action: 'read',
              params: { filePaths: [SHARED_FILE, ...HANDLER_FILES] },
            }),
          ],
          usage,
        };
      }
      if (this.#analystRound === 2) {
        // [evidence] 尾注与宽查询结果都可能被 per-tool 字符配额(压力档最低 400 字)截断吞掉
        // (真机同样发生)——走生产设计的截断不敏感发现路径：每文件一次【窄】evidence.search，
        // 单条结果 ~180 字必然完整。真模型在预算压力下同样会收窄查询。
        return {
          text: null,
          functionCalls: HANDLER_FILES.map((file) =>
            fc('evidence', {
              action: 'search',
              params: { query: file.split('/').pop() ?? file },
            })
          ),
          usage,
        };
      }
      if (this.#analystRound === 3) {
        if (this.behavior === 'no-findings') {
          // 弱模块：分析文本质量高(代理分高)但从不 note_finding —— 质量门按
          // findings 缺失走 record_repair，补写微阶段仍无发现 → degraded_no_findings。
          // (纯低分文本走的是 analysis_retry 耗尽 break，不是 degrade——另一种静默归零形态。)
          return { text: analystMarkdown(), functionCalls: [], usage };
        }
        const findings = HANDLER_FILES.map((file) => {
          const ref = this.#refsByFile.get(file);
          return ref
            ? fc('memory', {
                action: 'note_finding',
                params: {
                  finding: `${file} wraps every return value with wrapResult (Result<T> envelope convention)`,
                  evidenceRefs: [ref],
                  importance: 8,
                },
              })
            : null;
        }).filter((call): call is FunctionCall => call !== null);
        return { text: null, functionCalls: findings, usage };
      }
      return { text: analystMarkdown(), functionCalls: [], usage };
    }

    // record_repair 微阶段(仅 memory)——healthy 脚本不应走到；防御性返回文本。
    return { text: analystMarkdown(), functionCalls: [], usage };
  }
}

/** 完整装配：真 AgentRuntimeBuilder + 真 ToolRouterAdapter + fixture projectRoot + fake gateway。 */
function assembleMiningRun(input: {
  provider: ScriptedMiningProvider;
  fixtureRoot: string;
  moduleId: string;
  /** P1-A F4 测试用：故意不接 capabilityCatalog，复现宿主接线错误形态。 */
  omitCatalog?: boolean;
}) {
  const { gateway, created } = createFakeGateway();
  const memoryCoordinator = new MemoryCoordinator();
  const scopeId = 'e2e-module:analyst';
  memoryCoordinator.createDimensionScope(scopeId);
  const systemRunContext = createSystemRunContext({
    scopeId,
    memoryCoordinator,
    dimensionMeta: { id: 'e2e-module' },
    dimensionId: 'e2e-module',
    dimId: 'e2e-module',
    outputType: 'candidate',
    source: 'system',
  });

  const dataRoot = mkdtempSync(join(tmpdir(), 'alembic-mining-e2e-data-'));
  tempRoots.push(dataRoot);

  // capabilityCatalog 是 runtime schema 投影的容器服务(container.get('capabilityCatalog'))——
  // 缺席时 toolSchemaCount=0、toolChoice=none，工具面整体静默失效(首跑踩过的真坑)。
  const capabilityCatalog = new RuntimeCapabilityCatalog();
  const agentService = new AgentService({
    runtimeBuilder: new AgentRuntimeBuilder({
      aiProvider: input.provider as never,
      container: input.omitCatalog
        ? {}
        : {
            get: (name: string) => (name === 'capabilityCatalog' ? capabilityCatalog : undefined),
          },
      projectRoot: input.fixtureRoot,
      dataRoot,
      toolRegistry: {
        getRouter: () =>
          new ToolRouterAdapter({
            contextFactory: {
              // 生产宿主的 ToolContextFactory 职责：服务注入 + request.runtime 透传(台账/维度元)。
              create: (request) => ({
                projectRoot: input.fixtureRoot,
                tokenBudget: 8000,
                recipeGateway: gateway,
                memoryCoordinator:
                  ((request as { runtime?: { memoryCoordinator?: unknown } }).runtime
                    ?.memoryCoordinator as never) ?? (memoryCoordinator as never),
                runtime: (request as { runtime?: never }).runtime,
              }),
            },
          }) as never,
      },
    }),
  });

  const runInput = {
    profile: { id: 'module-mining-session' },
    params: {
      modules: [
        {
          moduleId: input.moduleId,
          moduleName: input.moduleId,
          ownedFiles: [...HANDLER_FILES, SHARED_FILE],
        },
      ],
      projectFacts: { project: 'mining-e2e-fixture', lang: 'TypeScript', fileCount: 4 },
    },
    message: {
      role: 'internal' as const,
      content: 'Mine the fixture project for conventions.',
      metadata: { task: 'module-mining' },
    },
    context: {
      source: 'system-workflow' as const,
      runtimeSource: 'system' as const,
      childContexts: {
        [input.moduleId]: { systemRunContext },
      },
    },
  };

  return { agentService, runInput, created };
}

function childOutcome(result: AgentRunResult, moduleId: string): Record<string, unknown> {
  const phases = (result.phases ?? {}) as Record<string, unknown>;
  const moduleResults = (phases.moduleResults ?? {}) as Record<string, unknown>;
  const child = (moduleResults[moduleId] ?? {}) as Record<string, unknown>;
  const childPhases = (child.phases ?? {}) as Record<string, unknown>;
  return (childPhases._pipelineOutcome ?? {}) as Record<string, unknown>;
}

describe('mining E2E — 真实组合链路(fixture 仓 + 脚本化 provider)', () => {
  it('健康模块：analyze(真台账)→note_finding(ledger-id)→质量门→produce→submit 全链产出 1 条 rule', {
    timeout: E2E_TIMEOUT,
  }, async () => {
    const fixtureRoot = materializeFixture();
    const provider = new ScriptedMiningProvider('healthy');
    const { agentService, runInput, created } = assembleMiningRun({
      provider,
      fixtureRoot,
      moduleId: 'mod-healthy',
    });

    const result = await agentService.run(runInput);

    expect(result.status).toBe('success');
    // 1) 候选真实落到 gateway。
    expect(created).toHaveLength(1);
    const item = created[0].items[0];
    expect(item.title).toBe('Wrap handler return values with wrapResult');
    // 2) 证据链完好：refs 来自真实台账；sources 指向 fixture 真实文件。
    const reasoning = (item.reasoning ?? {}) as Record<string, unknown>;
    expect(Array.isArray(reasoning.evidenceRefs)).toBe(true);
    expect((reasoning.evidenceRefs as string[]).length).toBeGreaterThanOrEqual(3);
    const sources = (reasoning.sources ?? []) as string[];
    expect(sources.some((s) => s.includes('user-handler.ts'))).toBe(true);
    // 3) coreCode 由确定性回填为引用区间的真实文件内容(逐字，含约定标识符)。
    expect(String(item.coreCode ?? '')).toContain('wrapResult');
    // 4) 管线结局一等化：completed；父结果无 abandonedModules。
    expect(childOutcome(result, 'mod-healthy').outcome).toBe('completed');
    expect((result.phases as Record<string, unknown>).abandonedModules).toBeUndefined();
    // 5) 台账真实工作过：analyst 的 read 走了证据采集(工具调用里有 code.read + note_finding)。
    const toolDump = JSON.stringify(result.toolCalls ?? []);
    expect(toolDump).toContain('note_finding');
  });

  it('EVIDENCE_STALE 负例：produce 首调前改写被引用文件 → 新鲜度重哈希拒绝，零候选', {
    timeout: E2E_TIMEOUT,
  }, async () => {
    const fixtureRoot = materializeFixture();
    const provider = new ScriptedMiningProvider('healthy');
    // 关键时序：analyst 已按原始内容采集台账(哈希入账)；produce 提交前文件被改写 →
    // expandEvidenceRefsForSubmit 重切同区间重哈希 → EVIDENCE_STALE。
    // 必须【前插】而非尾部追加：台账区间是行号切片，尾部追加不改变原区间内容(哈希不变)；
    // 前插使全文件行位移，同区间重切内容必变。
    provider.onProducerFirstCall = () => {
      const target = join(fixtureRoot, 'src/handlers/user-handler.ts');
      const original = readFileSync(target, 'utf8');
      writeFileSync(
        target,
        `// mutated mid-run: freshness must reject stale evidence\n${original}`
      );
    };
    const { agentService, runInput, created } = assembleMiningRun({
      provider,
      fixtureRoot,
      moduleId: 'mod-stale',
    });

    const result = await agentService.run(runInput);

    expect(created).toHaveLength(0);
    const toolDump = JSON.stringify(result.toolCalls ?? []);
    expect(toolDump).toContain('EVIDENCE_STALE');
  });

  it('弱模块：零发现 → record_repair 救不回 → degraded_no_findings → 父结果 abandonedModules 一等可见', {
    timeout: E2E_TIMEOUT,
  }, async () => {
    const fixtureRoot = materializeFixture();
    const provider = new ScriptedMiningProvider('no-findings');
    const { agentService, runInput, created } = assembleMiningRun({
      provider,
      fixtureRoot,
      moduleId: 'mod-weak',
    });

    const result = await agentService.run(runInput);

    expect(created).toHaveLength(0);
    const outcome = childOutcome(result, 'mod-weak');
    expect(outcome.outcome).toBe('abandoned');
    const abandoned = (result.phases as Record<string, unknown>).abandonedModules as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(abandoned)).toBe(true);
    expect(abandoned[0]).toMatchObject({
      unitId: 'mod-weak',
      action: expect.stringMatching(/^degraded_|^degrade$/),
    });
  });
});

// ─── P1-A F4：装配契约显性化(capabilityCatalog 缺席不再静默) ───
describe('装配诊断 — capabilityCatalog 缺席', () => {
  it('工具面静默失效时 child diagnostics 带 tool_schema_projection_empty(宿主可定位接线错误)', {
    timeout: E2E_TIMEOUT,
  }, async () => {
    const fixtureRoot = materializeFixture();
    const provider = new ScriptedMiningProvider('no-findings');
    const { agentService, runInput } = assembleMiningRun({
      provider,
      fixtureRoot,
      moduleId: 'mod-miswired',
      omitCatalog: true,
    });

    const result = await agentService.run(runInput);

    const phases = (result.phases ?? {}) as Record<string, unknown>;
    const child = ((phases.moduleResults ?? {}) as Record<string, Record<string, unknown>>)[
      'mod-miswired'
    ];
    expect(JSON.stringify(child?.diagnostics ?? {})).toContain('tool_schema_projection_empty');
  });
});
