/**
 * 复查攻击夹具 assertNoLegacyRegression(input)：把任意输入交给四个历史版本与新实现，按精确 oracle 机械判定
 * 是否违反不变量 S（任一历史版本遮住的非结构字符，新输出必须遮住）。设计第 6 节“门禁与复查口径”。
 *
 * 判定互相独立的四层：
 * 1. 追踪重放（本目录 trackedReplay.ts，逐字符来源数组的独立实现，不是运行时用的分段实现）：四个版本各自的
 *    精确被遮位置；新输出的逐字符来源由运行时渲染器的来源表给出。二者相交即为露出。
 * 2. 唯一字符：输入里只出现一次的字符，某版本输出里没有它即被遮；新输出里出现就是露出（输入含 \u 转义时
 *    跳过，因为解码后可能生成同一字符）。
 * 3. 哨兵：输入中的 SYNTH… / Synth… 片段，任一版本输出里不含它时，新输出也不得含它。
 * 4. 结构：幂等、裸换行序列守恒、新写出的标记都在封闭词表内、生产入口与夹具入口输出一致。
 * 另外报告两类自检：对齐器（超集 ⊇ 精确被遮、子集 ⊆ 精确被遮；阶段 4 起对齐只是测试期对照与回退路径）
 * 与运行时分段重放（必须与本目录的逐字符重放给出相同的被遮位置），用于定位实现缺陷。
 *
 * 信息等价的豁免（设计 4.2 节“遮住”的口径）：结构位置（裸换行，以及可解析 JSON 字面量内解码后是换行的转义
 * 序列，D3 阶段 4 子项——只暴露换行个数）、引号字符及转义引号的反斜杠、输入里原本就有的标记文字。这一口径
 * 与运行时 trackedReplay.structurePositions 相同，由测试钉住。
 */
import { redactDeveloperText } from '../../../src/agent/utils/Redaction.js';
import {
  hiddenSubset,
  hiddenSuperset,
  REDACTION_MARKERS,
} from '../../../src/agent/utils/redaction/hiddenSpans.js';
import { applyRedactionFloorWithProvenance } from '../../../src/agent/utils/redaction/legacyFloor.js';
import {
  exactHidden as runtimeExactHidden,
  structurePositions,
} from '../../../src/agent/utils/redaction/trackedReplay.js';
import {
  BASELINE_REVISIONS,
  type BaselineRevision,
  exactHidden,
  frozenRedact,
} from './trackedReplay.js';

export interface Exposure {
  oracle: 'replay' | 'unique-char' | 'sentinel';
  baseline: BaselineRevision;
  /** 输入位置（replay/unique-char）或 -1。 */
  position: number;
  fragment: string;
}

export interface LegacyRegressionReport {
  input: string;
  output: string;
  exposures: Exposure[];
  alignerViolations: string[];
  structuralViolations: string[];
  rounds: number;
}

const CORE_PATTERN =
  /\[redacted(?:-nested-value|-private-key|-google-api-key|-api-key|-token|-unaligned)?\]/g;
const MARKER_ALPHABET = new Set(REDACTION_MARKERS.join(''));

function isNewline(char: string | undefined): boolean {
  return char === '\n' || char === '\r';
}

/** 信息等价、不计入 S 的输入位置。 */
export function exemptPositions(x: string): Uint8Array {
  const exempt = structurePositions(x);
  for (let index = 0; index < x.length; index++) {
    const char = x[index];
    if (isNewline(char) || char === '"' || char === "'") {
      exempt[index] = 1;
    }
  }
  // 紧贴引号的一串反斜杠是该引号的转义，与引号一起视为结构。
  for (let index = 0; index < x.length; index++) {
    if (x[index] !== '\\') {
      continue;
    }
    let end = index;
    while (x[end] === '\\') {
      end++;
    }
    if (x[end] === '"' || x[end] === "'") {
      exempt.fill(1, index, end);
    }
    index = end - 1;
  }
  for (const match of x.matchAll(CORE_PATTERN)) {
    exempt.fill(1, match.index, match.index + match[0].length);
  }
  return exempt;
}

/** 新输出的逐字符来源：运行时渲染器在每一轮都记录输出字符取自哪个输入位置，跨轮组合后得到到原始输入的映射。 */
function traceOutput(x: string): { output: string; origin: Int32Array; rounds: number } {
  const result = applyRedactionFloorWithProvenance(x);
  if (result.origin.length !== result.text.length) {
    throw new Error('oracle: provenance length does not match the output');
  }
  for (let index = 0; index < result.text.length; index++) {
    const from = result.origin[index] ?? -1;
    if (from >= 0 && x[from] !== result.text[index]) {
      throw new Error('oracle: output character does not match its recorded source');
    }
  }
  return { output: result.text, origin: result.origin, rounds: result.report.rounds };
}

function newlineSkeleton(text: string): string {
  return text.replace(/[^\r\n]/g, '');
}

/** 按全部 oracle 检查一个输入，返回报告（不抛错）。 */
export function checkNoLegacyRegression(input: string): LegacyRegressionReport {
  const exposures: Exposure[] = [];
  const alignerViolations: string[] = [];
  const structuralViolations: string[] = [];
  const { output, origin, rounds } = traceOutput(input);
  const production = redactDeveloperText(input);
  if (production !== output) {
    structuralViolations.push('production entry and traced floor disagree');
  }

  const visible = new Uint8Array(input.length);
  for (let index = 0; index < origin.length; index++) {
    const from = origin[index] ?? -1;
    if (from >= 0 && from < input.length) {
      visible[from] = 1;
    }
  }
  const exempt = exemptPositions(input);
  const outputs = new Map<BaselineRevision, string>();
  for (const revision of BASELINE_REVISIONS) {
    const baselineOutput = frozenRedact(revision, input);
    outputs.set(revision, baselineOutput);
    const hidden = exactHidden(revision, input);
    // 运行时的分段重放必须与本目录的逐字符重放给出完全相同的被遮位置（两套独立实现互为对照）。
    const runtimeHidden = runtimeExactHidden(revision, input);
    if (runtimeHidden === null) {
      alignerViolations.push(`runtime replay of ${revision} failed its self-check`);
    } else {
      for (let index = 0; index < input.length; index++) {
        if (runtimeHidden[index] !== hidden[index]) {
          alignerViolations.push(`runtime replay of ${revision} disagrees at ${index}`);
          break;
        }
      }
    }
    for (let index = 0; index < input.length; index++) {
      if (hidden[index] === 1 && visible[index] === 1 && exempt[index] !== 1) {
        exposures.push({
          oracle: 'replay',
          baseline: revision,
          position: index,
          fragment: input.slice(Math.max(0, index - 8), index + 8),
        });
      }
    }
    // 对齐器自检：历史版本用超集（必须覆盖精确被遮），现行规则用子集（不得多于精确被遮）。
    if (revision === 'b60a61e') {
      const subset = hiddenSubset(input, baselineOutput, { reencodes: true }).marks;
      for (let index = 0; index < input.length; index++) {
        if (subset[index] === 1 && hidden[index] !== 1 && exempt[index] !== 1) {
          alignerViolations.push(`subset over-claims ${revision}@${index}`);
        }
      }
    } else {
      const superset = hiddenSuperset(input, baselineOutput, {
        reencodes: revision === 'd113986',
      }).marks;
      for (let index = 0; index < input.length; index++) {
        if (hidden[index] === 1 && superset[index] !== 1 && exempt[index] !== 1) {
          alignerViolations.push(`superset misses ${revision}@${index}`);
        }
      }
    }
  }

  if (!/\\u/.test(input)) {
    const counts = new Map<string, number>();
    for (const char of input) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    for (const [char, count] of counts) {
      if (
        count !== 1 ||
        isNewline(char) ||
        char === '"' ||
        char === "'" ||
        char === '\\' ||
        MARKER_ALPHABET.has(char)
      ) {
        continue;
      }
      for (const [revision, baselineOutput] of outputs) {
        if (!baselineOutput.includes(char) && output.includes(char)) {
          exposures.push({
            oracle: 'unique-char',
            baseline: revision,
            position: input.indexOf(char),
            fragment: char,
          });
        }
      }
    }
  }

  for (const fragment of new Set(input.match(/SYNTH\w*|Synth\w*/g) ?? [])) {
    for (const [revision, baselineOutput] of outputs) {
      if (!baselineOutput.includes(fragment) && output.includes(fragment)) {
        exposures.push({ oracle: 'sentinel', baseline: revision, position: -1, fragment });
      }
    }
  }

  if (redactDeveloperText(output) !== output) {
    structuralViolations.push('not idempotent');
  }
  if (newlineSkeleton(output) !== newlineSkeleton(input)) {
    structuralViolations.push('bare newline sequence changed');
  }
  for (const match of output.matchAll(/\[redacted[^\]\s]*\]/g)) {
    const synthetic = (origin[match.index] ?? -1) < 0;
    if (synthetic && !REDACTION_MARKERS.includes(match[0])) {
      structuralViolations.push(`marker outside the closed vocabulary: ${match[0]}`);
    }
  }
  return { input, output, exposures, alignerViolations, structuralViolations, rounds };
}

/**
 * 攻击夹具：违反 S（任何 oracle 报出露出）、幂等、换行守恒或标记词表时抛 Error，附可复现的细节。
 * 对齐器自检违规同样抛出：它们是底线实现缺陷的前兆，即使这一输入恰好没有露出。
 */
export function assertNoLegacyRegression(input: string): LegacyRegressionReport {
  const report = checkNoLegacyRegression(input);
  const problems = [
    ...report.exposures.map(
      (exposure) =>
        `${exposure.oracle} exposure vs ${exposure.baseline} at ${exposure.position}: ${JSON.stringify(exposure.fragment)}`
    ),
    ...report.alignerViolations,
    ...report.structuralViolations,
  ];
  if (problems.length > 0) {
    throw new Error(
      `assertNoLegacyRegression failed for ${JSON.stringify(input)} → ${JSON.stringify(report.output)}:\n${problems.slice(0, 20).join('\n')}`
    );
  }
  return report;
}
