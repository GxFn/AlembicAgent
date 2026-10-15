import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** 评估专用内存端口：记录 pending 候选，不连接真实知识库，也不宣称可发布。 */
export function createEvaluationRecipeGateway(created, fixtureId) {
  return {
    async createOrStage({ items }) {
      created.push(...items);
      return {
        created: items.map((item, index) => ({
          id: `eval-${fixtureId}-${created.length}-${index}`,
          title: String(item.title ?? ''),
          lifecycle: 'pending',
          raw: item,
        })),
        duplicates: [],
        rejected: [],
        merged: [],
        blocked: [],
        supersedeProposal: null,
        production: { capability: 'knowledge-submit', source: 'alembic-agent' },
      };
    },
    async evaluateReadiness() {
      return {
        ready: false,
        schemaVersion: '1',
        profileHash: null,
        documentSetHash: null,
        violations: [
          {
            code: 'evaluation.in-memory-only',
            message: 'Evaluation candidates are recorded in memory and are not published.',
          },
        ],
        warnings: [],
      };
    },
  };
}

/** 缺失/越界证据也留下收据，使评估报告完整记录失败，而不是最后写报告时整批丢失。 */
export function collectSourceFileReceipts(samples, sourceInputPath) {
  const rows = new Map();
  for (const sample of samples) {
    const projectRoot = path.resolve(path.dirname(sourceInputPath), sample.projectRoot || '.');
    const sources = sample.candidate?.reasoning?.sources;
    for (const source of Array.isArray(sources) ? sources : []) {
      // 与 MiningJudge.sliceEvidenceForJudge 同一正则（L7-P24 / C17）：file:N 单行来源与 file:start-end
      // 区间都合法，否则 judge 切到的文件没有对应收据；修改时两处同步。
      const match =
        typeof source === 'string' ? /^(.+?):(\d+)(?:-(\d+))?$/u.exec(source.trim()) : null;
      if (!match) {
        continue;
      }
      const relativePath = match[1];
      let receipt;
      try {
        const root = realpathSync(projectRoot);
        const file = realpathSync(path.resolve(projectRoot, relativePath));
        const relative = path.relative(root, file);
        if (
          path.isAbsolute(relativePath) ||
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          throw Object.assign(new Error('Evidence outside project root'), {
            code: 'EVIDENCE_OUTSIDE_PROJECT',
          });
        }
        receipt = { sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
      } catch (error) {
        receipt = {
          sha256: null,
          error:
            error instanceof Error && 'code' in error ? String(error.code) : 'EVIDENCE_UNREADABLE',
        };
      }
      rows.set(`${sample.projectRoot || '.'}/${relativePath}`, {
        projectRoot: sample.projectRoot || '.',
        relativePath,
        ...receipt,
      });
    }
  }
  return [...rows.values()].sort((a, b) =>
    `${a.projectRoot}/${a.relativePath}`.localeCompare(`${b.projectRoot}/${b.relativePath}`)
  );
}

/**
 * 把 judgeCandidate 的 onDiagnostic 事件渲染成单行日志（L7-P24 / C44）。eval:mining 与
 * eval:judge-calibration 共用，保证两份报告里“被跳过的来源 / 无可读切片 / 裁决解析失败”口径一致；
 * 'no-readable-slices' 明确标出该候选的裁决来自缺证据，而不是证据被驳倒。
 */
export function formatJudgeDiagnostic(diagnostic) {
  switch (diagnostic?.kind) {
    case 'slice-skipped':
      return `slice-skipped reason=${diagnostic.reasonCode} source=${JSON.stringify(diagnostic.source)} detail=${JSON.stringify(diagnostic.detail)}`;
    case 'no-readable-slices':
      return `no-readable-slices declaredSources=${diagnostic.sourceCount} (verdict reflects missing evidence, not refuted evidence)`;
    case 'verdict-parse-failed':
      return `verdict-parse-failed reason=${diagnostic.reasonCode} detail=${JSON.stringify(diagnostic.detail)}`;
    default:
      // 未知事件原样输出，避免新增诊断种类在旧脚本里被静默吞掉。
      return `unknown-diagnostic ${safeJson(diagnostic)}`;
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (error) {
    return `<unserializable: ${error instanceof Error ? error.name : 'unknown error'}>`;
  }
}
