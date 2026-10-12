/**
 * Final answer cleanup helpers for AgentRuntime text replies.
 *
 * 清理边界（I12）：cleanFinalAnswer 作用于宿主对话的每次文字答复、tracker 终结文本与 analyst
 * 强制摘要，因此只允许删除“可证明是 Runtime 注入内容回显”的文本，宁可残留也不误删正常答复：
 *   - 开头的 Final Answer / 最终回答 / Answer 前缀；
 *   - [MEMORY:x] … [/MEMORY] 记忆块；
 *   - 指令回显行：整行（去掉粗体、警示符、引用符后）逐句都属于 NUDGE_DIRECTIVE_TEXTS 登记的注入原句；
 *   - dimensionDigest 回显块之后紧跟的 blockquote 字段行（> remainingTasks: … 等模板说明）；
 *   - 轮次预算提示与进度行（注意：到达第 N 轮时… / 第 N/M 轮 | …）。
 * 围栏代码块内部一律不动。发生删除时记一条 debug 日志（规则与计数，不含被删文本）。
 */

import Logger from '@alembic/core/logging';
import { NUDGE_DIRECTIVE_TEXTS } from '../context/exploration/NudgeGenerator.js';

/** 删除规则名，用于 debug 日志计数 */
type CleanupRule =
  | 'finalAnswerPrefix'
  | 'memoryBlock'
  | 'directiveEcho'
  | 'digestFieldLine'
  | 'roundBudgetNote'
  | 'progressLine';

type RemovalCounts = Record<CleanupRule, number>;

const FINAL_ANSWER_PREFIX_RE = /^(Final Answer|最终回答|Answer)\s*[:：]\s*/i;
const MEMORY_BLOCK_RE = /\[MEMORY:\w+\]\s*[\s\S]*?\s*\[\/MEMORY\]/g;
/** dimensionDigest 模板里的 blockquote 字段说明行 */
const DIGEST_FIELD_LINE_RE =
  /^>\s*(?:searchHints|remainingTasks|candidateCount|crossRefs|keyFindings|gaps)\s*[:：]/;
/** JSON 中的 dimensionDigest 键，用于判定一个代码块/单行 JSON 是 digest 回显 */
const DIGEST_KEY_RE = /"dimensionDigest"\s*:/;
const ROUND_BUDGET_NOTE_RE = /^注意[：:]\s*到达第\s*\d+\s*轮时.*$/;
const PROGRESS_LINE_RE = /^第\s*\d+\/\d+\s*轮\s*\|.*$/;
/** 围栏代码块的开/闭围栏（CommonMark：最多 3 个前导空格，3 个以上 ` 或 ~） */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
/** 注入指令行可能带的装饰：引用符、警示符（⚠️ / ⛔ / 📌） */
const LEADING_DECORATION_RE = /^\s*(?:>\s*)?(?:(?:⚠️?|⛔|\u{1F4CC})\s*)?/u;
/** 中文/英文句末与分句标点；逗号不切分，保证匹配的是完整分句 */
const SENTENCE_SPLIT_RE = /[。！？!?；;]/;
const TRAILING_PUNCTUATION_RE = /[\s，,：:.]+$/;

export function cleanFinalAnswer(response: string) {
  if (!response) {
    return '';
  }
  const removed: RemovalCounts = {
    finalAnswerPrefix: 0,
    memoryBlock: 0,
    directiveEcho: 0,
    digestFieldLine: 0,
    roundBudgetNote: 0,
    progressLine: 0,
  };
  const withoutPrefix = response.replace(FINAL_ANSWER_PREFIX_RE, () => {
    removed.finalAnswerPrefix++;
    return '';
  });
  const withoutMemory = withoutPrefix.replace(MEMORY_BLOCK_RE, () => {
    removed.memoryBlock++;
    return '';
  });
  const cleaned = stripInjectedEchoLines(withoutMemory, removed)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  logRemovals(removed, response.length, cleaned.length);
  return cleaned;
}

/**
 * 逐行清除注入回显。
 *
 * 状态机：
 *   - fence !== null：处于围栏代码块内，原样保留；只记录块内是否出现 dimensionDigest 键；
 *   - afterDigest：刚结束一个 dimensionDigest 回显块（围栏块或单行 JSON）。此状态下空行与其他
 *     已删除的回显行不改变状态，blockquote 字段行被整行删除；任何其他正文行都会结束该状态，
 *     因此正文之后用户引用的 “> gaps: …” 不会被删。
 * 指令回显行与轮次/进度行只清空内容、保留换行（与旧行为一致，避免把上下两段正文拼成一段）；
 * digest 字段行连同换行一起删除（与旧行为一致）。
 */
function stripInjectedEchoLines(text: string, removed: RemovalCounts) {
  const directiveSentences = buildDirectiveSentenceSet();
  const output: string[] = [];
  let fence: string | null = null;
  let fenceHasDigest = false;
  let afterDigest = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (fence !== null) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
        afterDigest = fenceHasDigest;
        fenceHasDigest = false;
      } else if (DIGEST_KEY_RE.test(line)) {
        fenceHasDigest = true;
      }
      output.push(rawLine);
      continue;
    }

    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      fence = open[1];
      fenceHasDigest = false;
      afterDigest = false;
      output.push(rawLine);
      continue;
    }

    if (line.trim() === '') {
      output.push(rawLine);
      continue;
    }

    if (afterDigest && DIGEST_FIELD_LINE_RE.test(line)) {
      removed.digestFieldLine++;
      continue;
    }
    if (isDirectiveEcho(line, directiveSentences)) {
      removed.directiveEcho++;
      output.push('');
      continue;
    }
    if (ROUND_BUDGET_NOTE_RE.test(line)) {
      removed.roundBudgetNote++;
      output.push('');
      continue;
    }
    if (PROGRESS_LINE_RE.test(line)) {
      removed.progressLine++;
      output.push('');
      continue;
    }

    // 普通正文行：只有未加围栏的单行 dimensionDigest JSON 会开启 afterDigest
    afterDigest = isSingleLineDigestJson(line);
    output.push(rawLine);
  }
  return output.join('\n');
}

/** 每次调用现建（表很小），避免模块级可变状态与导入期计算 */
function buildDirectiveSentenceSet() {
  const sentences = new Set<string>();
  for (const text of Object.values(NUDGE_DIRECTIVE_TEXTS)) {
    for (const sentence of splitDirectiveSentences(text)) {
      sentences.add(sentence);
    }
  }
  return sentences;
}

/** 去掉粗体、行首引用符与警示符、多余空白后按句末标点切成分句 */
function splitDirectiveSentences(text: string) {
  const normalized = text
    .replace(/\*\*/g, '')
    .replace(LEADING_DECORATION_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized
    .split(SENTENCE_SPLIT_RE)
    .map((sentence) => sentence.replace(TRAILING_PUNCTUATION_RE, '').trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * 整行的每个分句都是登记过的注入原句才算回显：
 * 只要混入一个非注入分句（例如“现在开始输出你的分析报告，结论如下：…”），整行保留。
 */
function isDirectiveEcho(line: string, directiveSentences: Set<string>) {
  const sentences = splitDirectiveSentences(line);
  return sentences.length > 0 && sentences.every((sentence) => directiveSentences.has(sentence));
}

function isSingleLineDigestJson(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}') && DIGEST_KEY_RE.test(trimmed);
}

function logRemovals(removed: RemovalCounts, inputChars: number, outputChars: number) {
  const rules: Partial<RemovalCounts> = {};
  let total = 0;
  for (const [rule, count] of Object.entries(removed) as Array<[CleanupRule, number]>) {
    if (count > 0) {
      rules[rule] = count;
      total += count;
    }
  }
  if (total === 0) {
    return;
  }
  // 只记录规则与计数，不记录被删文本：答复可能包含用户代码或私有信息。
  // removedLines 统计按行删除/清空的回显；前缀与 MEMORY 块单独计数。
  const removedLines =
    removed.directiveEcho +
    removed.digestFieldLine +
    removed.roundBudgetNote +
    removed.progressLine;
  Logger.getInstance().debug(
    `[FinalAnswer] stripped injected echo from final answer — ${total} item(s)`,
    { rules, removedLines, inputChars, outputChars }
  );
}
