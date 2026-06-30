/**
 * @module tools/runtime/handlers/recipeAuthoringGate
 *
 * P1.4b in-process flatten (CG-4)：把 AlembicAgent 的 in-process 知识提交接到与 host-agent 路径
 * 同一套权威门禁 —— Core 的 `@alembic/core/knowledge` `validateAgainst`（统一 validateAgainst +
 * renderGuidance「全打平」）。本模块只承载 Agent 作为 in-process 宿主时需要注入的运行时端口与
 * 编排，门禁规则本身（纯谓词 / 阈值 / 文案）全部来自 Core 权威 spec，不在本仓库二次实现。
 *
 * 两路打平的语义：
 *   - host-agent 路径（AlembicPlugin tool-router）已在 P1.4 接到 validateAgainst；
 *   - in-process 路径（本仓库 handleSubmit）此前只跑 length-only 的 validateSubmitParams +
 *     Core stage-3，stage-1/stage-2 从不在 in-process 执行（CG-4 gap）。
 *
 * profile 轴（§12.3，Core 8771524 已上线）：
 *   - cold-start：完整门禁，逐字节等同 host-agent 冷启动（含 3-distinct-files 证据下限 +
 *     session-scope），是携带 bootstrap dimension 的 in-process 提交所走的档位；
 *   - opportunistic：运行期机会式 in-process AI 开发（无 session / 无 dimension）的「声明式更轻
 *     门槛」 —— 保留全部内容门禁（verb 白名单、✅❌ 对比、markdown 下限）+ 廉价来源接地
 *     （source-ref 行号格式、fs 解析 NOT_FOUND / LINE_OUT_OF_RANGE、placeholder、snippet、graph），
 *     仅关闭 3-distinct-files 证据下限与 session-scope，不是对 cold-start 的放松。
 *
 * §C.11 端口边界：Core domain spec 保持纯（零 node:fs / node:path），把两处运行时耦合留给宿主注入。
 * 在 in-process 路径里：
 *   - sourceRefResolver：由本模块用 node:fs / node:path 实现，逐字节复刻 host 侧
 *     createSourceRefResolver 的分支与文案，保证「同一来源引用在 in-process 与 host 得到一致裁决」；
 *   - sessionScope：in-process **不注入** —— 与 P1-Plugin「session-scope 留 host 侧前置」的决策一致；
 *     opportunistic 本就关闭 session-scope，故无冲突；cold-start in-process 也只做 fs 接地，不做
 *     session 作用域（in-process 无 bootstrap session 对象可校验）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type RecipeAuthoringViolation,
  type RecipeSourceRefResolver,
  resolveAuthoringProfile,
  validateAgainst,
} from '@alembic/core/knowledge';

/**
 * in-process fs 来源接地端口。逐字节复刻 host 侧 §C.11 resolver 的归一化、越界判定与文案，
 * 让 in-process 与 host-agent 对同一 `path:line` / `path:start-end` 引用产出完全一致的
 * SOURCE_REF_INVALID / SOURCE_REF_NOT_FOUND / SOURCE_REF_LINE_OUT_OF_RANGE，或同样的
 * `{ rangeText, sourcePath }`，供 Core 纯 snippet / floor 谓词消费（两路打平的接地一致性基础）。
 */
export function createInProcessSourceRefResolver(): RecipeSourceRefResolver {
  return ({
    projectRoot,
    sourcePath: rawPath,
    startLine,
    endLine,
    sourceRef,
    itemIndex,
    title,
  }) => {
    const sourcePath = path.posix.normalize(rawPath.replaceAll('\\', '/'));
    if (path.isAbsolute(sourcePath) || sourcePath.startsWith('..')) {
      return {
        violation: {
          code: 'SOURCE_REF_INVALID',
          itemIndex,
          sourceRef,
          title,
          message: 'Source ref must stay inside the project source root.',
          nextAction: 'Use a repo-relative source path under the current project.',
        },
      };
    }

    const absolutePath = path.resolve(projectRoot, sourcePath);
    if (!isInsideRoot(projectRoot, absolutePath)) {
      return {
        violation: {
          code: 'SOURCE_REF_INVALID',
          itemIndex,
          path: sourcePath,
          sourceRef,
          title,
          message: 'Source ref resolves outside the project source root.',
          nextAction: 'Use a source path under the current project root.',
        },
      };
    }
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return {
        violation: {
          code: 'SOURCE_REF_NOT_FOUND',
          itemIndex,
          path: sourcePath,
          sourceRef,
          title,
          message: 'Source ref file does not exist.',
          nextAction: 'Check the repo-relative path and cite an existing source file.',
        },
      };
    }
    const lines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
    if (startLine < 1 || endLine < startLine || endLine > lines.length) {
      return {
        violation: {
          code: 'SOURCE_REF_LINE_OUT_OF_RANGE',
          itemIndex,
          path: sourcePath,
          sourceRef,
          title,
          message: 'Source ref line range is outside the file.',
          nextAction: 'Use a valid line range from the current source file.',
        },
      };
    }

    return {
      evidence: {
        filePath: absolutePath,
        raw: sourceRef,
        rangeText: lines.slice(startLine - 1, endLine).join('\n'),
        sourcePath,
      },
    };
  };
}

/** 与 host 侧 isInsideRoot 同实现：判定 target 是否在 root 内（含 root 自身）。 */
function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 运行 in-process 权威门禁：先用 Core 的 resolveAuthoringProfile 从上下文解析档位
 * （携带 dimensionId 的提交 → cold-start；否则 → opportunistic），再调用同一个 validateAgainst
 * （stage:'all', path:'in-process'）并注入 in-process fs resolver。返回 Core 原样的违规对象数组
 * （空数组表示通过）。
 *
 * 注意：本门禁是 gateway.create（Core stage-3 UnifiedValidator）之前的前置统一裁决；stage:'all'
 * 会包含 stage-3，与 gateway 内的 Core stage-3 同源（P1.3 已 re-point），结论一致、只是更早短路。
 */
export function runInProcessRecipeAuthoringGate(
  item: Record<string, unknown>,
  opts: { projectRoot: string; dimensionId?: string }
): RecipeAuthoringViolation[] {
  const profile = resolveAuthoringProfile({
    args: { dimensionId: opts.dimensionId },
    items: [item],
  });
  return validateAgainst([item], {
    stage: 'all',
    path: 'in-process',
    profile,
    sourceRefResolver: createInProcessSourceRefResolver(),
    projectRoot: opts.projectRoot,
    dimensionId: opts.dimensionId,
  });
}

/**
 * 把 Core 违规对象格式化为 in-process 拒绝信封（fail 字符串）所需的文本，保留 code / 定位 /
 * message / nextAction，便于 in-process Producer 直接据此修复，而不是反向猜测门禁。
 */
export function formatRecipeAuthoringViolations(violations: RecipeAuthoringViolation[]): string {
  return violations
    .map((violation) => {
      const locator = violation.field ?? violation.title ?? violation.sourceRef ?? violation.path;
      const head = locator ? `${violation.code} (${locator})` : violation.code;
      return `${head}: ${violation.message} ${violation.nextAction}`.trim();
    })
    .join('; ');
}
