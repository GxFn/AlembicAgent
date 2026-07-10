#!/usr/bin/env node
/**
 * eval:mining — 离线挖掘质量评估 harness(P0-2 挖掘质量升级)。
 *
 * 用途：在 golden fixtures 上跑【真实挖掘管线 + 真实 provider】，产出可对比的质量报告
 * (方向性 P/R、triviality、abandonment、repair-hit-rate、成本、工具分布；--judge 叠加
 * 独立 critic 的语义判定)。这是评估脚本不是测试：不进 CI，不阻断，手动按需运行(D4 决策)。
 *
 * 隔离保证(绝不污染真实 KB)：fixture 复制到临时目录、dataRoot 临时目录、gateway 为
 * 内存 fake(只记录 created)——与真实 .asd/知识库零接触。
 *
 * 用法：
 *   npm run build && npm run eval:mining                          # 默认 golden + auto provider
 *   npm run eval:mining -- --judge                                # 叠加 judge 语义判定
 *   npm run eval:mining -- --provider deepseek --judge-provider ollama
 *   npm run eval:mining -- --budget-tokens 500000 --out <dir>
 *
 * key 来源：ALEMBIC_DEEPSEEK_API_KEY(或 autoDetectProvider 支持的其它 env)；ollama 免 key。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReport,
  collectRunObservations,
  renderReportMarkdown,
  scoreFixture,
} from './lib/mining-eval-core.mjs';
import { judgeCandidate } from './lib/mining-judge.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// dist 是运行前提(脚本用构建产物驱动真实管线)。
for (const required of [
  'dist/agent/service/AgentService.js',
  'dist/agent/service/AgentRuntimeBuilder.js',
  'dist/agent/runtime/SystemRunContext.js',
  'dist/agent/memory/MemoryCoordinator.js',
  'dist/tools/runtime/adapter/ToolRouterAdapter.js',
  'dist/tools/runtime/adapter/RuntimeCapabilityCatalog.js',
  'dist/ai/AiFactory.js',
]) {
  try {
    readFileSync(path.join(repoRoot, required));
  } catch {
    console.error(`[eval:mining] missing ${required} — run \`npm run build\` first.`);
    process.exit(1);
  }
}

const { AgentService } = await import(path.join(repoRoot, 'dist/agent/service/AgentService.js'));
const { AgentRuntimeBuilder } = await import(
  path.join(repoRoot, 'dist/agent/service/AgentRuntimeBuilder.js')
);
const { createSystemRunContext } = await import(
  path.join(repoRoot, 'dist/agent/runtime/SystemRunContext.js')
);
const { MemoryCoordinator } = await import(
  path.join(repoRoot, 'dist/agent/memory/MemoryCoordinator.js')
);
const { ToolRouterAdapter } = await import(
  path.join(repoRoot, 'dist/tools/runtime/adapter/ToolRouterAdapter.js')
);
const { RuntimeCapabilityCatalog } = await import(
  path.join(repoRoot, 'dist/tools/runtime/adapter/RuntimeCapabilityCatalog.js')
);
const { createProvider, autoDetectProvider } = await import(
  path.join(repoRoot, 'dist/ai/AiFactory.js')
);

const args = parseArgs(process.argv.slice(2));
const goldenPath = path.resolve(repoRoot, args.golden || 'test/fixtures/mining-eval/golden.json');
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
const budgetTokens = Number(args['budget-tokens'] || 2_000_000);
const startedAt = new Date().toISOString();
const outDir = path.resolve(
  repoRoot,
  args.out || path.join('test-reports', 'mining-eval', startedAt.slice(0, 19).replaceAll(':', '-'))
);

const provider = args.provider ? createProvider({ provider: args.provider }) : autoDetectProvider();
if (!provider) {
  console.error(
    '[eval:mining] no AI provider available — set ALEMBIC_DEEPSEEK_API_KEY (or pass --provider ollama with a local ollama).'
  );
  process.exit(1);
}
const judgeEnabled = args.judge === true || typeof args['judge-provider'] === 'string';
const judgeProvider = judgeEnabled
  ? args['judge-provider']
    ? createProvider({ provider: args['judge-provider'] })
    : provider
  : null;

console.log(
  `[eval:mining] provider=${provider.name}/${provider.model}${judgeEnabled ? ` judge=${judgeProvider.name}/${judgeProvider.model}` : ''} budgetTokens=${budgetTokens}`
);

const tempRoots = [];
const fixtureResults = [];
const notes = [
  'precision/recall(heuristic) 是关键词+引用文件的方向性判据，非语义判定；--judge 的 precision(judge) 才是语义口径。',
  'LLM 有方差：结论看多次运行的区间，不看单点。',
];
let usedTokens = 0;

try {
  for (const fixture of golden.fixtures) {
    if (usedTokens >= budgetTokens) {
      notes.push(
        `budget-tokens 用尽(${usedTokens}/${budgetTokens})，fixture "${fixture.id}" 及之后被跳过。`
      );
      console.warn(`[eval:mining] budget exhausted — skipping ${fixture.id}`);
      continue;
    }
    console.log(`[eval:mining] fixture ${fixture.id} …`);
    const entry = await runFixture(fixture);
    fixtureResults.push(entry);
    usedTokens +=
      (entry.observations.usage?.inputTokens || 0) + (entry.observations.usage?.outputTokens || 0);
  }
} finally {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
}

const report = buildReport({
  startedAt,
  provider: `${provider.name}/${provider.model}`,
  judgeProvider: judgeEnabled ? `${judgeProvider.name}/${judgeProvider.model}` : null,
  fixtureResults,
  notes,
});
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(outDir, 'report.md'), `${renderReportMarkdown(report)}\n`);
console.log(`[eval:mining] report → ${path.relative(repoRoot, outDir)}/report.{json,md}`);
for (const entry of fixtureResults) {
  const s = entry.score;
  console.log(
    `[eval:mining] ${s.fixtureId}: candidates=${s.candidateCount} recall=${pct(s.recall)} precision(h)=${pct(s.heuristicPrecision)}${s.judgePrecision !== null ? ` precision(j)=${pct(s.judgePrecision)}` : ''} triviality=${pct(s.trivialityRate)} abandoned=${entry.observations.abandonedModules.length}`
  );
}

async function runFixture(fixture) {
  // 隔离：fixture 副本 + 临时 dataRoot + 内存 gateway —— 与真实 KB 零接触。
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), `mining-eval-${fixture.id}-`));
  tempRoots.push(fixtureRoot);
  cpSync(path.resolve(path.dirname(goldenPath), fixture.fixturePath), fixtureRoot, {
    recursive: true,
  });
  const dataRoot = mkdtempSync(path.join(tmpdir(), `mining-eval-data-${fixture.id}-`));
  tempRoots.push(dataRoot);

  const created = [];
  const gateway = {
    async create(input) {
      created.push(...input.items);
      return {
        created: input.items.map((item, index) => ({
          id: `eval-${fixture.id}-${created.length}-${index}`,
          title: String(item.title ?? ''),
        })),
        duplicates: [],
        rejected: [],
        blocked: [],
      };
    },
  };

  const memoryCoordinator = new MemoryCoordinator();
  const scopeId = `eval-${fixture.id}:analyst`;
  memoryCoordinator.createDimensionScope(scopeId);
  const systemRunContext = createSystemRunContext({
    scopeId,
    memoryCoordinator,
    dimensionMeta: { id: `eval-${fixture.id}` },
    dimensionId: `eval-${fixture.id}`,
    dimId: `eval-${fixture.id}`,
    outputType: 'candidate',
    source: 'system',
  });
  const capabilityCatalog = new RuntimeCapabilityCatalog();
  const agentService = new AgentService({
    runtimeBuilder: new AgentRuntimeBuilder({
      aiProvider: provider,
      container: {
        get: (name) => (name === 'capabilityCatalog' ? capabilityCatalog : undefined),
      },
      projectRoot: fixtureRoot,
      dataRoot,
      toolRegistry: {
        getRouter: () =>
          new ToolRouterAdapter({
            contextFactory: {
              create: (request) => ({
                projectRoot: fixtureRoot,
                tokenBudget: 8000,
                recipeGateway: gateway,
                memoryCoordinator: request.runtime?.memoryCoordinator ?? memoryCoordinator,
                runtime: request.runtime,
              }),
            },
          }),
      },
    }),
  });

  const childContexts = {};
  for (const moduleInput of fixture.modules) {
    childContexts[moduleInput.moduleId] = { systemRunContext };
  }
  const budget = fixture.budget || { analystTokens: 12_000, totalRecipeBudget: 6 };

  const runResult = await agentService.run({
    profile: { id: 'module-mining-session' },
    params: {
      modules: fixture.modules,
      projectFacts: fixture.projectFacts || { project: fixture.id },
      budget,
    },
    message: {
      role: 'internal',
      content: `Mine fixture ${fixture.id} for real, reusable project knowledge.`,
      metadata: { task: 'module-mining' },
    },
    execution: { budgetOverride: budget },
    context: { source: 'system-workflow', runtimeSource: 'system', childContexts },
  });

  const observations = collectRunObservations(runResult);
  let judgeVerdicts = null;
  if (judgeEnabled && created.length > 0) {
    judgeVerdicts = [];
    for (const candidate of created) {
      try {
        const verdict = await judgeCandidate({
          candidate,
          projectRoot: fixtureRoot,
          chat: async (prompt) => {
            const result = await judgeProvider.chatWithTools(prompt, {
              temperature: 0,
              maxTokens: 800,
            });
            return String(result?.text ?? '');
          },
        });
        judgeVerdicts.push(verdict);
      } catch (err) {
        console.warn(
          `[eval:mining] judge error: ${err instanceof Error ? err.message : String(err)}`
        );
        judgeVerdicts.push(null);
      }
    }
  }

  return {
    fixtureId: fixture.id,
    score: scoreFixture({ fixture, candidates: created, judgeVerdicts }),
    candidates: created,
    judgeVerdicts,
    observations,
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      index++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function pct(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}
