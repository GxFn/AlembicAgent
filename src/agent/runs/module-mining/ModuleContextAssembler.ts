/**
 * ModuleContextAssembler — P1-B-1/2(挖掘质量升级)：确定性模块上下文装配。
 *
 * 背景(需求 G4/G5)：跨文件/模块骨架此前 prompt-only——求 LLM 自觉调 graph 才能拿到
 * 模块结构(DeepSeek 实测不肯调,graph-retry 因此被停用)；fan-out 单元是平铺 modules[]，
 * 500 文件模块与 3 文件模块同预算。业界口径(CodeRAG/Cody)：最相关上下文是"目标依赖的
 * 精确符号",由静态装配确定性喂给模型,而不是求模型自取。
 *
 * 本模块三件事(全部纯函数,只消费 ProjectContext facts,不触盘不触网)：
 *   1. buildModuleContextMap — 目录分组文件清单(封顶)+ 兄弟模块概览 + 可选依赖关系
 *      (facts 携带时)→ 注入 child dimConfig.guide。图谱是【导航】不是【证据】：
 *      引用仍必须 code.read 落台账(read-before-cite 协议不变,陈旧图谱不会污染引用)。
 *   2. splitOversizedModule — 超过阈值的模块按顶层子目录贪心分组拆成多个真实 module
 *      条目(id 加 #<group> 后缀)——在 run 入口拆而非 partitioner 拆,merger 的
 *      按下标 1:1 契约不动。依赖簇分块是 P3 候选,此处只做目录拆分。
 *   3. computeModuleAnalystBudget(在 insightAnalyst.ts,与项目档共享 session 数学)
 *      由 run 入口按拆分后每模块规模附着到 moduleRecord.strategyContext._computedBudget
 *      ——partitioner 原样展开,工厂既有的动态预算合并逻辑零改动直接生效。
 */

export interface ModuleLikeRecord {
  moduleId?: string;
  id?: string;
  moduleName?: string;
  name?: string;
  ownedFiles?: string[];
  [key: string]: unknown;
}

const MAX_LISTED_FILES = 40;
const OVERSIZE_THRESHOLD = 60;

function moduleIdOf(module: ModuleLikeRecord, index = 0): string {
  return (
    (typeof module.moduleId === 'string' && module.moduleId) ||
    (typeof module.id === 'string' && module.id) ||
    `module-${index}`
  );
}

function ownedFilesOf(module: ModuleLikeRecord): string[] {
  return Array.isArray(module.ownedFiles)
    ? module.ownedFiles.filter((file): file is string => typeof file === 'string')
    : [];
}

/** 顶层分组键：首段目录(无目录的文件归 "(root)")。 */
function topLevelGroup(file: string): string {
  const idx = file.indexOf('/');
  return idx > 0 ? file.slice(0, idx) : '(root)';
}

/** 依赖关系(可选)：facts/module 携带 dependencies/imports/relations 数组时提取字符串项。 */
function extractRelations(module: ModuleLikeRecord): string[] {
  const out: string[] = [];
  for (const key of ['dependencies', 'imports', 'relations']) {
    const value = module[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          out.push(item.trim());
        } else if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          const target =
            (typeof record.target === 'string' && record.target) ||
            (typeof record.to === 'string' && record.to) ||
            (typeof record.moduleId === 'string' && record.moduleId);
          if (target) {
            out.push(target);
          }
        }
      }
    }
  }
  return [...new Set(out)].slice(0, 10);
}

/**
 * 确定性模块图谱(注入 dimConfig.guide 的文本块)。
 * 内容全部来自 ProjectContext facts——facts 没有的(如 relations)诚实缺席,不编造。
 */
export function buildModuleContextMap(
  module: ModuleLikeRecord,
  allModules: ModuleLikeRecord[]
): string {
  const files = ownedFilesOf(module);
  const lines: string[] = ['【模块图谱(静态装配,导航用)】'];

  // 1) 目录分组文件清单(封顶 MAX_LISTED_FILES,超出按目录汇总)
  const byGroup = new Map<string, string[]>();
  for (const file of files) {
    const group = topLevelGroup(file);
    const bucket = byGroup.get(group) ?? [];
    bucket.push(file);
    byGroup.set(group, bucket);
  }
  let listed = 0;
  for (const [group, bucket] of byGroup) {
    if (listed >= MAX_LISTED_FILES) {
      lines.push(`- ${group}/: ${bucket.length} 文件(超出清单预算,按需 code.search 定位)`);
      continue;
    }
    const shown = bucket.slice(0, Math.max(1, MAX_LISTED_FILES - listed));
    lines.push(`- ${group}/ (${bucket.length} 文件):`);
    for (const file of shown) {
      lines.push(`  - ${file}`);
    }
    if (shown.length < bucket.length) {
      lines.push(`  - …另 ${bucket.length - shown.length} 文件`);
    }
    listed += shown.length;
  }

  // 2) 依赖关系(facts 携带时)
  const relations = extractRelations(module);
  if (relations.length > 0) {
    lines.push(`依赖/关联模块: ${relations.join(', ')}`);
  }

  // 3) 兄弟模块概览(项目定位,防把全局约定误判为模块私有)
  const selfId = moduleIdOf(module);
  const siblings = allModules
    .filter((candidate) => moduleIdOf(candidate) !== selfId)
    .slice(0, 12)
    .map((candidate) => `${moduleIdOf(candidate)}(${ownedFilesOf(candidate).length})`);
  if (siblings.length > 0) {
    lines.push(`兄弟模块: ${siblings.join(', ')}`);
  }

  lines.push(
    '图谱仅供导航；任何将被引用的代码必须先 code.read 采集台账证据(read-before-cite 不变)。'
  );
  return lines.join('\n');
}

/**
 * 超大模块拆分：ownedFiles > OVERSIZE_THRESHOLD 时按顶层子目录贪心分组,每组 ≤ 阈值。
 * 拆出的条目是真实 module 条目(moduleId#<group>),下游 partitioner/merger 契约不变。
 */
export function splitOversizedModule(
  module: ModuleLikeRecord,
  threshold = OVERSIZE_THRESHOLD
): ModuleLikeRecord[] {
  const files = ownedFilesOf(module);
  if (files.length <= threshold) {
    return [module];
  }
  const baseId = moduleIdOf(module);
  const baseName =
    (typeof module.moduleName === 'string' && module.moduleName) ||
    (typeof module.name === 'string' && module.name) ||
    baseId;

  const byGroup = new Map<string, string[]>();
  for (const file of files) {
    const group = topLevelGroup(file);
    const bucket = byGroup.get(group) ?? [];
    bucket.push(file);
    byGroup.set(group, bucket);
  }

  // 贪心装箱：目录为最小单元(不拆目录),按大小降序填充,箱容=threshold。
  // 单目录超阈值时独立成箱(目录内聚优先于严格容量)。
  const groups = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length);
  const bins: Array<{ label: string[]; files: string[] }> = [];
  for (const [group, bucket] of groups) {
    const target = bins.find((bin) => bin.files.length + bucket.length <= threshold);
    if (target) {
      target.label.push(group);
      target.files.push(...bucket);
    } else {
      bins.push({ label: [group], files: [...bucket] });
    }
  }
  if (bins.length <= 1) {
    return [module];
  }
  return bins.map((bin, index) => {
    const suffix = bin.label.slice(0, 2).join('+') || `part-${index + 1}`;
    return {
      ...module,
      moduleId: `${baseId}#${suffix}`,
      id: `${baseId}#${suffix}`,
      moduleName: `${baseName}#${suffix}`,
      name: `${baseName}#${suffix}`,
      ownedFiles: bin.files,
      files: bin.files,
    };
  });
}
