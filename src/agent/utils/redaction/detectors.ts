/**
 * 脱敏阶段 4b：T1 高置信格式层检测器（设计 redaction-design-2026-10-19 第 4.4 节 T1、第 4.6 节、决定 D10）。
 *
 * 边界：
 * - 检测器只在原文上计算“要遮住的区间 [start, end) 与该区间用的标记”，由 legacyFloor 在 Floor 计算处与四个历史
 *   版本的追踪重放位置取并集，再统一按位置渲染一次（render.ts）。检测器之间、检测器与底线之间都不串接（不在别的
 *   规则输出上继续匹配），所以组合只会多遮（不变量 A），不变量 S 由底线单独保证，与本表无关。
 * - T1 只收高置信形态：带固定前缀的 token（统一 gitleaks 式左右边界）、JWT（三段 base64url，前两段解码为 JSON
 *   对象）、Authorization / Proxy-Authorization / Cookie / Set-Cookie 头的凭据值、URL userinfo 的口令段（花括号
 *   配平，能吸收 ${…:-…}）、Azure SAS 的 sig 签名（同一 URL 片段里有 sv= 版本参数）。无关键字的高熵段不做（D10：
 *   会遮掉 git 哈希）。T1 对所有来源生效，不能按来源收窄（不变量 A：任何来源下的遮蔽 ⊇ 未知来源下的遮蔽）。
 * - 标记沿用封闭词表（设计 4.6）：前缀 token 用 [redacted-api-key]，JWT、认证头与 Cookie 值、SAS 签名用
 *   [redacted-token]，URL userinfo 口令段用 [redacted]。auth-param 列表（Digest、AWS4-HMAC-SHA256 …）与 Cookie 头的
 *   cookie 列表整段一个标记（从第一个凭据对的名字到最后一个凭据值，名字与分隔符一并遮住；Set-Cookie 只遮第一对的
 *   值），密集的短值不会让输出膨胀。区间若已被历史版本全部遮住，挂点不并入它（输出与上一包
 *   逐字相同，不制造无谓的台账哈希变化）；部分遮住时渲染器仍优先沿用历史版本的合成文本（缺口优先级 v3 → v0 →
 *   检测器），只有底线没遮到的部分才落到检测规则的标记上。
 * - 不变量 A 在门面层（不动点多轮）成立的前提是检测区间不吞掉底线级联要用的“关键字 + 分隔符”触发前缀：这由
 *   legacyFloor 的挂点统一保证（底线没遮住的触发前缀位置不并入检测区间），对本表与后续包追加的规则都生效。
 *   本表另在认证头凭据串里遇到紧贴的下一个头名时截断（头名留给自己的候选，并按“紧贴头名”放宽左边界）。
 * - 截断：工具输出常在行中截断，后接 `...`、`…`、`[truncated]`、`[N lines omitted]`。前缀 token 与 URL 口令段
 *   被截断时仍按可见部分遮蔽（前缀之后至少 4 个字符，且紧跟截断标记），否则可见前缀会泄漏大半个秘密。
 *
 * 规则写成数据 {id, tier, kind, sources, marker, prefilter, pattern, locate, examples, negativeExamples}；
 * validateDetectorTable 逐条检查正反例（正例里的秘密必须被本规则的区间完整覆盖，反例不得产生任何区间），由
 * test/redaction-detectors.test.ts 在 CI 里强制执行，并另用完整门面检查“秘密的任何不短于 4 字符的片段都不在输出
 * 里、反例逐字保留”。正反例全部在运行时按片段拼接的合成值（SYNTHETIC），源码文本里不出现连续的 token 形态，
 * 保证本文件被宿主投影或见证闸门扫描时不会命中自己。本表与 evidence/witnessGate.ts 的闸门表各自独立：那是只拒绝
 * 不改写的子集，这里是改写用的检测器，两者不互相导入也不合并。
 *
 * 诊断：候选被否决（长度、形态、解码不符、值里没有字母数字）、纯引用占位被跳过、花括号失配退回不配平扫描、
 * 按截断形态命中、有界窗口触顶（带引号的值找不到闭引号、花括号组超长、scheme 超长）、Cookie 值的引号其实是外层
 * 载体的引号、认证头凭据里未闭合的 ${ 组被丢弃、凭据串在紧贴的头名处截断、区间恰好是已有标记而跳过、预过滤
 * 短路，都经 sink 计数（只含规则 id 与事件种类，不含正文），由 legacyFloor 写进 FloorReport；legacyFloor 另记
 * “区间由多个已有标记拼成”“底线已遮住区间全部位置”与“保留级联触发前缀”的精确跳过。
 *
 * 性能（设计 D13；阶段 1 硬门禁下对抗输入的余量很小，检测器开销要压到噪声以下，并且对任何输入都是线性的）：
 * - 各规则的预过滤（触发形态，以最少见的字符开头、大小写敏感、是候选的必要条件）取并集，从左往右逐次扫出全文
 *   里出现了哪些规则，整体只扫一遍（干净文本只付一次失败的扫描），没出现的规则精确跳过。
 * - 候选正则都以字面量开头且不回溯（JWT 只匹配第一段，后两段手工扫，失败的候选从第一段末尾继续，同一段里的
 *   其他 eyJ 起点不再重扫）；处理完一个候选后从它遮住的最远位置继续找下一个候选。
 * - JWT 段是否解码为 JSON 对象由手写的字节级判定器一遍给出（不抛异常、显式栈），不再用 try/catch 包 JSON.parse
 *   当判定：形似对象却不合法的段（{"xx}、尾逗号）链式排列时，异常路径曾让检测比 v3 慢几十倍。
 * - 带引号的值找闭引号走全文索引（按“引号字符 + 其前反斜杠个数”分组的位置表、换行位置表，二分查找），Cookie
 *   载体引号的分隔字符判定也走位置表：候选再密集、内层再互相重叠，也不逐候选向前扫窗口。
 * - 需要向前看的扫描都按每次调用私有的 DetectorScratch 共享：花括号配平由一遍带栈的扫描给出（每个位置只处理
 *   一次，结论存进按开括号下标的类型数组），URL 授权段的读法按“组之后的接续位置”下标的类型数组记忆，截断标记位置
 *   算一次后二分查找，端口判定按起点记忆化，SAS 版本参数按 URL 片段算一次，闭引号与分隔字符的位置表各建一次。
 *   因此候选再密集也不会反复扫同一个窗口。
 * - 每个花括号组的开销是常数且不分配对象（第四轮复查阻塞：连续的已闭合组曾因逐组的 Map 读写、结论对象与数组
 *   元素分配而超线性）：配平器的查询返回数字编码、栈是类型数组；授权段里不含嵌套与阻断字符的短组（{}、${A}）走
 *   快路径，不进配平器；不含 / 的短组里不可能有候选起点，组之后的接续位置不记忆。
 * - 推迟到 4f 验收（总控裁定 2026-10-22，在用户批准的 D13 内）：每 10–12 个字符就有一个只被检测器遮住的短凭据
 *   时，检测仍是线性的（自身只占 v3 的 1.2–2.9 倍），但不动点轮要在换成带关键字标记的输出上重跑四个冻结版本，
 *   倍数在 8× 上下。本包对这一类只报告倍数、断言线性（性能测试的 DEFERRED_TO_4F 组），≤4× 在 4f 验收；不改用
 *   [redacted] 标记（设计 4.6 的标记分配）、不按密度合并区间（误伤棘轮）。
 * - 底线主导的形态（同日总控裁定，同一原则）：URL 口令由大量 ${A} 引用组成时，无检测器的底线自身已是 v3 的
 *   9–14.7 倍，检测器在其上的增量约 1.3 倍。本包对它只断言线性与“有检测器的门面 ≤ 无检测器底线的 2 倍”（性能
 *   测试的 FLOOR_DOMINATED 与 CLOSED_URL_GROUPS 组），相对 v3 的 ≤8× 与 ≤4× 在 4f 验收。
 *   其余对抗形态断言相对 v3 ≤8× 且线性。
 * 本模块是纯函数：模块级只有不可变的规则表与无状态（非全局、非粘连）的正则；全局正则每次检测都另建实例，跨候选
 * 的缓存只放在每次调用新建的 DetectorScratch 里，调用结束即丢弃。
 */

import { coreMarkerLengthAt } from './render.js';

export type DetectorTier = 'T1';

/** 设计 4.5 节的来源类别。T1 对全部来源生效。 */
export type DetectorSource =
  | 'display'
  | 'ledger-file'
  | 'ledger-derived'
  | 'secret-bearing'
  | 'terminal';

export const ALL_DETECTOR_SOURCES: readonly DetectorSource[] = Object.freeze([
  'display',
  'ledger-file',
  'ledger-derived',
  'secret-bearing',
  'terminal',
]);

export type DetectorKind =
  | 'prefixed-token'
  | 'jwt'
  | 'auth-header'
  | 'cookie-header'
  | 'url-userinfo'
  | 'url-signature';

/** 检测器只用封闭词表里的这三个标记（设计 4.6）。 */
export type DetectorMarker = '[redacted-api-key]' | '[redacted-token]' | '[redacted]';

/**
 * 检测器诊断事件（只计数，不含正文）：
 * - rejected：候选被否决（前缀 token 长度或形态不符且不是截断形态、JWT 段解码不是 JSON 对象、SAS 缺 sv=、认证头的值
 *   只有方案名、值里没有字母数字）；
 * - reference-skip：认证头或 Cookie 的值是纯引用占位（`${NAME}`、`$NAME`、`{{ x }}`），不是凭据字面量，跳过；
 * - unbalanced-fallback：URL userinfo 花括号到行尾（或窗口上限）仍未配平，退回不配平扫描（两种读法的区间取并集）；
 * - truncated：按截断形态命中（可见部分后紧跟截断标记）；
 * - window-exceeded：有界窗口触顶后按降级读法处理——带引号的值在 MAX_VALUE_SCAN 内找不到闭引号（按不带引号的值
 *   读）、花括号组在 MAX_VALUE_SCAN 内没有闭合（URL 退回不配平读法，认证头不吸收该组）、scheme 超过
 *   MAX_SCHEME_LENGTH（不当作 URL 候选）；
 * - carrier-quote：Cookie 值的引号内含空白、分号或逗号，判定为外层载体的引号，按不带引号的值读（值为空，不遮）；
 * - unclosed-quote：认证头参数或 Cookie 值的引号到行尾或文本末尾仍未闭合（多半是截断的输出），按不带引号的值读
 *   （值为空，不遮，后面的参数或 cookie 对不再读）；
 * - unclosed-group：认证头凭据里的 ${ 组到行尾仍未闭合，不吸收该组（凭据串在组前结束）；
 * - glued-header：认证头凭据串遇到紧贴的下一个头名（Authorization、Cookie 等）时截断，头名留给它自己的候选；
 * - trigger-kept：检测区间里有底线没遮住的级联触发前缀（关键字 + 分隔符），挂点不并入这些位置（由 legacyFloor
 *   计数，保证下一轮 v0/v1 的级联遮蔽仍然发生）；
 * - already-masked：区间完全落在输入里已有的完整标记上（例如不动点轮里上一轮写出的 [redacted]），精确跳过（标记
 *   只会原样渲染），只计数：恰好是一个标记的区间在 detectT1Spans 里跳过，由多个标记拼成的区间由 legacyFloor 跳过；
 * - floor-covered：区间的全部位置底线（四个历史版本）都已遮住（或只剩保留的触发前缀），检测器不增加任何遮蔽
 *   位置，由 legacyFloor 精确跳过（不并入缺口，渲染与无检测器时逐字相同）；
 * - prefilter-skip：预过滤短路，全文不含规则的触发字面量，整条规则没有运行（精确，只计数）。
 */
export type DetectorEventKind =
  | 'rejected'
  | 'reference-skip'
  | 'unbalanced-fallback'
  | 'truncated'
  | 'window-exceeded'
  | 'carrier-quote'
  | 'unclosed-quote'
  | 'unclosed-group'
  | 'glued-header'
  | 'trigger-kept'
  | 'already-masked'
  | 'floor-covered'
  | 'prefilter-skip';

export interface DetectorSink {
  event(kind: DetectorEventKind, ruleId: string): void;
}

export interface DetectorSpan {
  readonly start: number;
  readonly end: number;
  readonly marker: DetectorMarker;
  readonly ruleId: string;
}

export interface DetectorExample {
  /** 完整输入（合成值）。 */
  readonly text: string;
  /** 输入里的秘密：必须被本规则的区间完整覆盖；脱敏输出里不得出现其任何不短于 4 字符的片段。 */
  readonly secrets: readonly string[];
}

export interface DetectorRule {
  readonly id: string;
  readonly tier: DetectorTier;
  readonly kind: DetectorKind;
  readonly sources: readonly DetectorSource[];
  readonly marker: DetectorMarker;
  /**
   * 预过滤（触发形态；无任何标志、无捕获组，按 source 并进合并扫描）：全文没有它的命中时整条规则跳过。必须是候选
   * 正则的必要条件（候选命中 ⇒ 候选文本里有预过滤命中），所以跳过是精确的，不是放行；validateDetectorTable 在
   * 构建期逐个候选核对这一点。写法以触发字面量里最少见的字符开头、前文用后行断言核对（例如 JWT 的 J(?<=eyJ)、
   * 头名的 z/k），合并扫描在代码一类文本上能按首字符跳读；大小写不敏感的头名写成显式 ASCII 字符类。
   */
  readonly prefilter: RegExp;
  /** 候选正则（带 g 标志）；detectT1Spans 每次都另建实例迭代，不共享 lastIndex。 */
  readonly pattern: RegExp;
  /**
   * 候选确认与区间计算；返回空数组表示候选被否决或不是凭据位置。scratch 是本次检测调用私有的扫描上下文
   * （跨候选共享的配平、记忆化与缓存），调用结束即丢弃。
   */
  readonly locate: (
    text: string,
    match: RegExpExecArray,
    sink: DetectorSink | undefined,
    scratch: DetectorScratch
  ) => ReadonlyArray<readonly [number, number]>;
  readonly examples: readonly [DetectorExample, ...DetectorExample[]];
  readonly negativeExamples: readonly [string, ...string[]];
}

// =============================================================================================
// 词法辅助
// =============================================================================================

/** gitleaks 式边界里的“词字符”：[A-Za-z0-9_-]。 */
function isWordishCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 45
  );
}

function isHexCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isLineBreakCode(code: number): boolean {
  return code === 10 || code === 13;
}

/**
 * gitleaks 式左边界：前一字符不是 [A-Za-z0-9_-]。另外三种情形也算边界（都只会多遮）：
 * 1. 紧跟在载体的字面转义 \n、\r、\t 之后（字符串里 "line\nghp_…" 的前一字符是字母 n）；
 * 2. 紧跟在 \uXXXX 转义之后；
 * 3. 单独的 `-`（`+` 本来就不是词字符）：它前面不是词字符（行首、空白、引号），或是载体里的转义换行——
 *    diff 删除行、CLI 短横线，而不是 x-ghp_… 这样的标识符。
 */
export function leftBoundaryAt(text: string, start: number): boolean {
  if (start <= 0) {
    return true;
  }
  const previous = text.charCodeAt(start - 1);
  if (!isWordishCode(previous)) {
    return true;
  }
  if (
    (previous === 110 || previous === 114 || previous === 116) &&
    text.charCodeAt(start - 2) === 92
  ) {
    return true;
  }
  if (
    start >= 6 &&
    text.charCodeAt(start - 6) === 92 &&
    text.charCodeAt(start - 5) === 117 &&
    isHexCode(text.charCodeAt(start - 4)) &&
    isHexCode(text.charCodeAt(start - 3)) &&
    isHexCode(text.charCodeAt(start - 2)) &&
    isHexCode(previous)
  ) {
    return true;
  }
  if (previous === 45) {
    // 单独的 `-`（前面不是词字符，或是行首、载体里的转义换行）不是标识符的一部分：diff 删除行、CLI 短横线。
    const before = start - 2;
    if (before < 0) {
      return true;
    }
    const code = text.charCodeAt(before);
    if (!isWordishCode(code)) {
      return true;
    }
    if ((code === 110 || code === 114) && text.charCodeAt(before - 1) === 92) {
      return true;
    }
  }
  return false;
}

/** gitleaks 式右边界：后一字符不是 [A-Za-z0-9_-]（文本末尾也算）。 */
export function rightBoundaryAt(text: string, end: number): boolean {
  return end >= text.length || !isWordishCode(text.charCodeAt(end));
}

/** 截断标记的词法（不含前导空白）。只看位置之后有限的窗口，开销与输入长度无关。 */
const TRUNCATION_MARKER_SOURCE = String.raw`(?:\.{3}|\u2026|\[\s*truncated\b[^\]\r\n]{0,40}\]|\[\s*\d+\s+(?:more\s+)?(?:lines?|chars?|characters?|bytes?)\s+(?:omitted|truncated|elided)[^\]\r\n]{0,20}\]|\(truncated\))`;
const TRUNCATION_HERE = new RegExp(`^${TRUNCATION_MARKER_SOURCE}`, 'i');
const TRUNCATION_WINDOW = 96;

function isAsciiBlankCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/**
 * at 处是否开始一个截断标记，与 TRUNCATION_HERE 在 [at, windowEnd) 窗口上的判定逐位相同（windowEnd 缺省为
 * at + 96）。截断标记只能以 `.`、`…`、`[`、`(` 开头，其余字符直接否定；`...` 与 `…` 按字符判定（须完整落在窗口
 * 内），`[`、`(` 先做便宜的首字符预检（`[` 之后跳过 ASCII 空白必须是 t/T、数字或可能是 Unicode 空白的非 ASCII
 * 字符，`(` 之后必须是 t/T），通过后才切窗口跑正则。
 */
function truncationStartsAt(text: string, at: number, windowEnd = at + TRUNCATION_WINDOW): boolean {
  const limit = Math.min(text.length, windowEnd);
  if (at >= limit) {
    return false;
  }
  const code = text.charCodeAt(at);
  if (code === 46) {
    return at + 2 < limit && text.charCodeAt(at + 1) === 46 && text.charCodeAt(at + 2) === 46;
  }
  if (code === 0x2026) {
    return true;
  }
  if (code === 40) {
    const next = text.charCodeAt(at + 1);
    return (next === 116 || next === 84) && TRUNCATION_HERE.test(text.slice(at, limit));
  }
  if (code !== 91) {
    return false;
  }
  let cursor = at + 1;
  while (cursor < limit && isAsciiBlankCode(text.charCodeAt(cursor))) {
    cursor++;
  }
  if (cursor >= limit) {
    return false;
  }
  const next = text.charCodeAt(cursor);
  if (next === 116 || next === 84 || (next >= 48 && next <= 57) || next >= 128) {
    return TRUNCATION_HERE.test(text.slice(at, limit));
  }
  return false;
}

/**
 * at 处（可先有空格、制表符）是否紧跟截断标记：与 `^[ \t]*` 加截断标记在 96 字符窗口上的正则判定相同（标记不以
 * 空白开头，跳过前导空格与制表符后在同一窗口里判定标记，回溯不会给出别的结论）。每个 URL 候选都会问一次，所以
 * 先做逐字符预检，不切片。
 */
export function truncationFollows(text: string, at: number): boolean {
  const windowEnd = at + TRUNCATION_WINDOW;
  const limit = Math.min(text.length, windowEnd);
  let cursor = at;
  while (cursor < limit) {
    const code = text.charCodeAt(cursor);
    if (code !== 32 && code !== 9) {
      break;
    }
    cursor++;
  }
  return truncationStartsAt(text, cursor, windowEnd);
}

/** 截断形态的前缀 token：前缀之后至少要有这么多个可见字符，才把“前缀 + 片段 + 截断标记”当作凭据。 */
export const TRUNCATED_TOKEN_MIN_BODY = 4;

/**
 * 纯引用占位：整个值只是一个变量或模板引用（`$NAME`、`${NAME}`、`${{ secrets.X }}`、`{{ .Values.x }}`、
 * `{name}`、`%s`），不是凭据字面量。只用于认证头与 Cookie 值（URL 口令段沿用 v3 的口径一律遮，不跳过）。
 * 带默认值的 `${NAME:-literal}` 不是纯引用：默认值本身可能就是口令。
 */
const PURE_REFERENCE =
  /^(?:\$[A-Za-z_]\w*|\$\{[A-Za-z_][\w.]*\}|\$\{\{\s*[\w.-]+\s*\}\}|\{\{\s*[\w.|-]+\s*\}\}|\{[A-Za-z_][\w.]*\}|%[sdv])$/;

function isPureReference(value: string): boolean {
  return PURE_REFERENCE.test(value);
}

/**
 * 有界窗口：单个带引号的值找闭引号、单个花括号组找闭合时最多看这么多字符（组从开括号算起）。触顶按降级读法处理
 * 并计入 window-exceeded。逐字符前进的凭据串、参数列表、Cookie 对与 URL 授权段不设总长上限（线性，超长的值也要
 * 整段遮住），它们的跨候选共享由 DetectorScratch 保证。
 */
const MAX_VALUE_SCAN = 4096;

// =============================================================================================
// 每次检测调用私有的扫描上下文
// =============================================================================================

/**
 * 花括号组的配平结果：closed 时 end 是配对的 `}`；否则 end 是扫描停止处——阻断位置（line：换行或转义换行；
 * truncation：截断标记）、窗口上限（window：开括号 + MAX_VALUE_SCAN）或文本末尾（end）。
 */
type GroupStop = 'closed' | 'line' | 'truncation' | 'window' | 'end';

interface GroupResolution {
  readonly stop: GroupStop;
  readonly end: number;
}

/**
 * 结论种类的数字编码（热路径不分配对象、不比较字符串）：BraceResolver.settle 返回它，GROUP_STOP_CODES[编码 - 1]
 * 是对应的 GroupStop。0 只用作“尚无结论 / 不阻断”。
 */
const STOP_CLOSED = 1;
const STOP_LINE = 2;
const STOP_TRUNCATION = 3;
const STOP_WINDOW = 4;
const STOP_END = 5;

const GROUP_STOP_CODES: readonly GroupStop[] = Object.freeze([
  'closed',
  'line',
  'truncation',
  'window',
  'end',
]);

/** 组内阻断：在某个位置结束所有未闭合的组，返回阻断种类的编码（STOP_LINE / STOP_TRUNCATION），不阻断返回 0。 */
type GroupBlock = (text: string, at: number) => number;

/** URL 授权段的组：换行、转义换行（\n、\r 字面序列）与截断标记都结束组。 */
function urlGroupBlock(text: string, at: number): number {
  const code = text.charCodeAt(at);
  if (isLineBreakCode(code)) {
    return STOP_LINE;
  }
  if (code === 92) {
    const next = text.charCodeAt(at + 1);
    return next === 110 || next === 114 ? STOP_LINE : 0;
  }
  return truncationStartsAt(text, at) ? STOP_TRUNCATION : 0;
}

/** URL 授权段组的快路径最多看这么多个字符（远小于 MAX_VALUE_SCAN，组一定在窗口内闭合）。 */
const SIMPLE_GROUP_SCAN = 64;

/**
 * URL 授权段里“简单组”的闭括号：从开括号 open 起 SIMPLE_GROUP_SCAN 个字符内，先遇到 `}`、且之前没有 `{`、换行、
 * 反斜杠或截断标记可能的首字符（`.`、`…`、`[`、`(`）时，这个 `}` 就是配对的闭括号，与配平器（urlGroupBlock 口径）
 * 的结论相同——配平器只会在这些字符上给出别的结论（嵌套、阻断）。否则返回 -1，由调用方交给共享的配平器。
 * 连续的 {}、${A} 一类短组因此不进配平器，每组只是几次字符比较。与配平器结论的逐例等价由
 * test/redaction-detectors.test.ts 在随机输入上校验（因此导出；不经任何 index 转出）。
 */
export function simpleGroupEnd(text: string, open: number): number {
  const limit = Math.min(text.length, open + SIMPLE_GROUP_SCAN);
  for (let probe = open + 1; probe < limit; probe++) {
    const code = text.charCodeAt(probe);
    if (code === 125) {
      return probe;
    }
    if (
      code === 123 ||
      code === 10 ||
      code === 13 ||
      code === 92 ||
      code === 46 ||
      code === 0x2026 ||
      code === 91 ||
      code === 40
    ) {
      return -1;
    }
  }
  return -1;
}

/** [from, to) 里有没有 `/`（只用于不长于 SIMPLE_GROUP_SCAN 的简单组）。 */
function hasSlashBetween(text: string, from: number, to: number): boolean {
  for (let probe = from; probe < to; probe++) {
    if (text.charCodeAt(probe) === 47) {
      return true;
    }
  }
  return false;
}

/** 认证头凭据里的 ${…} 组：只有换行结束组（组内允许引号、空白与转义）。 */
function headerGroupBlock(text: string, at: number): number {
  return isLineBreakCode(text.charCodeAt(at)) ? STOP_LINE : 0;
}

/**
 * 花括号配平器：一遍带栈的从左往右扫描，每个位置只处理一次，栈上的组在配对的 `}`、阻断位置或文本末尾得到结论；
 * 结论按开括号位置存进类型数组。查询的开括号在游标之后时从它开始新的一段扫描（游标与它之间的位置不含会被查询的
 * 组：认证头按位置递增查询；URL 授权段的组要么在已扫过的段里，要么在游标之后，见 DetectorScratch.authorityChain），
 * 所以同一调用里无论候选多密集，配平的总开销都是线性的。窗口：组从开括号起 MAX_VALUE_SCAN 个字符内没有闭合或
 * 阻断，结论是 window（end = 开括号 + MAX_VALUE_SCAN），与逐组有界扫描的结论相同。
 * 热路径用 settle（返回结论编码）加 endOf（结论的 end），每组只是几次类型数组读写，不分配对象：URL 授权段里成千上万
 * 个相邻的已闭合组曾因逐组分配结论对象而超出性能门禁（第四轮复查阻塞）。resolve 是返回对象的便利写法，只给测试与
 * 冷路径用。
 */
class BraceResolver {
  private cursor = -1;
  /**
   * 当前扫描段的开括号栈：类型数组加栈顶下标（按需翻倍）。重置只是把栈顶归零——每个已闭合组都可能开始新的一段
   * 扫描，数组的 length = 0 与 for…of 在这里是每组几十纳秒的运行时调用，连续闭合组上比扫描本身还贵。
   */
  private stack = new Int32Array(16);
  private top = 0;
  /**
   * 按开括号位置保存结论：stops[p] 是结论编码（0 = 尚无结论），ends[p] 是结论的 end。pending[p] = 1 表示 p 在当前
   * 扫描段的栈上。都是首次查询时按全文长度分配的类型数组（Map/Set 的逐项开销在密集候选上比扫描本身还大）。
   */
  private readonly stops: Uint8Array;
  private readonly ends: Int32Array;
  private readonly pending: Uint8Array;

  constructor(
    private readonly text: string,
    private readonly block: GroupBlock
  ) {
    this.stops = new Uint8Array(text.length);
    this.ends = new Int32Array(text.length);
    this.pending = new Uint8Array(text.length);
  }

  /** 开括号 open 的结论（对象形式；测试与冷路径用，热路径用 settle + endOf）。 */
  resolve(open: number): GroupResolution {
    const code = this.settle(open);
    return { stop: GROUP_STOP_CODES[code - 1] ?? 'end', end: this.ends[open] ?? this.text.length };
  }

  /** 开括号 open 的结论编码（STOP_CLOSED … STOP_END），结论的 end 由 endOf(open) 读出。不分配对象。 */
  settle(open: number): number {
    const known = this.stops[open] ?? 0;
    if (known !== 0) {
      return known;
    }
    if (open >= this.cursor) {
      // 新的一段扫描：游标之前仍在栈上的组不会再被查询，清掉，从 open 起扫。
      for (let slot = 0; slot < this.top; slot++) {
        this.pending[this.stack[slot] ?? 0] = 0;
      }
      this.top = 0;
      this.cursor = open;
    } else if (this.pending[open] !== 1) {
      // 防御：游标之前、从未入栈的开括号（按上面的查询顺序不会出现）。退回逐组有界扫描，结论相同、只是不共享。
      this.settleAlone(open);
      return this.stops[open] ?? STOP_END;
    }
    const text = this.text;
    const length = text.length;
    for (;;) {
      const result = this.stops[open] ?? 0;
      if (result !== 0) {
        return result;
      }
      if (this.cursor >= length) {
        this.terminateAll(length, STOP_END);
        const settled = this.stops[open] ?? 0;
        if (settled === 0) {
          // 防御：open 必然在栈上（扫描从它起步），terminateAll 之后不会没有结论；保守按文本末尾处理。
          this.stops[open] = STOP_END;
          this.ends[open] = length;
          return STOP_END;
        }
        return settled;
      }
      // 逐位置推进（原 step）：栈非空时先看阻断，再处理花括号。
      const at = this.cursor;
      this.cursor = at + 1;
      if (this.top > 0) {
        const blocked = this.block(text, at);
        if (blocked !== 0) {
          this.terminateAll(at, blocked);
          continue;
        }
      }
      const code = text.charCodeAt(at);
      if (code === 123) {
        this.push(at);
        this.pending[at] = 1;
      } else if (code === 125 && this.top > 0) {
        this.top--;
        this.conclude(this.stack[this.top] ?? 0, at, STOP_CLOSED);
      }
    }
  }

  /** settle 之后开括号 open 的结论 end。 */
  endOf(open: number): number {
    return this.ends[open] ?? this.text.length;
  }

  private push(open: number): void {
    if (this.top >= this.stack.length) {
      const grown = new Int32Array(this.stack.length * 2);
      grown.set(this.stack);
      this.stack = grown;
    }
    this.stack[this.top] = open;
    this.top++;
  }

  private terminateAll(at: number, stop: number): void {
    for (let slot = 0; slot < this.top; slot++) {
      this.conclude(this.stack[slot] ?? 0, at, stop);
    }
    this.top = 0;
  }

  /** 结论落在开括号 MAX_VALUE_SCAN 个字符之外时，以窗口上限为准（逐组有界扫描在那里就停了）。 */
  private conclude(open: number, at: number, stop: number): void {
    this.pending[open] = 0;
    if (at - open < MAX_VALUE_SCAN) {
      this.stops[open] = stop;
      this.ends[open] = at;
    } else {
      this.stops[open] = STOP_WINDOW;
      this.ends[open] = open + MAX_VALUE_SCAN;
    }
  }

  /** 逐组有界扫描（防御路径），结论写进同一张表。 */
  private settleAlone(open: number): void {
    let depth = 1;
    const limit = Math.min(this.text.length, open + MAX_VALUE_SCAN);
    for (let at = open + 1; at < limit; at++) {
      const blocked = this.block(this.text, at);
      if (blocked !== 0) {
        this.stops[open] = blocked;
        this.ends[open] = at;
        return;
      }
      const code = this.text.charCodeAt(at);
      if (code === 123) {
        depth++;
      } else if (code === 125) {
        depth--;
        if (depth === 0) {
          this.stops[open] = STOP_CLOSED;
          this.ends[open] = at;
          return;
        }
      }
    }
    if (limit < open + MAX_VALUE_SCAN) {
      this.stops[open] = STOP_END;
      this.ends[open] = this.text.length;
    } else {
      this.stops[open] = STOP_WINDOW;
      this.ends[open] = limit;
    }
  }
}

/** URL 授权段的一次读法：第一个深度 0 的冒号、最后一个深度 0 的 @、结束位置与结束原因。 */
interface AuthorityScan {
  readonly colon: number;
  readonly at: number;
  readonly end: number;
  /** 以未闭合的花括号组结束（阻断、窗口上限或文本末尾）。 */
  readonly open: boolean;
  /** 在花括号组内遇到截断标记而结束。 */
  readonly truncatedInGroup: boolean;
  /** 花括号组超过窗口上限而结束。 */
  readonly windowExceeded: boolean;
}

/**
 * 授权段读法结束原因的位（DetectorScratch 的读法记忆里与 AuthorityScan 的三个布尔字段一一对应）：以未闭合的组
 * 结束、在组内遇到截断标记而结束、组超过窗口上限而结束。
 */
const CHAIN_OPEN = 1;
const CHAIN_TRUNCATED_IN_GROUP = 2;
const CHAIN_WINDOW_EXCEEDED = 4;

function isAuthorityStop(code: number): boolean {
  // 空白、/ ? # 引号 < > 反引号 反斜杠（载体里的 \/、\" 与转义换行）。
  return (
    code <= 32 ||
    code === 47 ||
    code === 63 ||
    code === 35 ||
    code === 34 ||
    code === 39 ||
    code === 60 ||
    code === 62 ||
    code === 96 ||
    code === 92
  );
}

function isUrlTokenStop(code: number): boolean {
  // 空白、引号、尖括号、反引号、反斜杠（载体里的转义）结束一个 URL 片段。
  return (
    code <= 32 ||
    code === 34 ||
    code === 39 ||
    code === 60 ||
    code === 62 ||
    code === 96 ||
    code === 92
  );
}

/** SAS 版本参数：在 URL 片段开头，或紧跟 ? & ; = 之后的 sv=<四位数字>。 */
const SAS_VERSION = /(?:^|[?&;=])sv=\d{4}/;

/** 截断范围短于这个长度时直接逐位判定；更长时用全文截断位置表二分查找。 */
const SHORT_TRUNCATION_RANGE = 64;

/**
 * 每次检测调用私有的扫描上下文（detectT1Spans / detectWithRule 每次调用新建，调用结束即丢弃；不是模块级状态）。
 * 只缓存“同一段文本上反复要问的问题”，答案与逐候选现算完全相同：
 * - 花括号配平（URL 授权段与认证头各一个 BraceResolver，阻断口径不同）；
 * - URL 授权段的配平读法：按“组之后的接续位置”（闭括号 + 1）下标的类型数组记忆“从这里起的整条读法”，读法走到
 *   深度 0 的 `}` 时看紧随其后的位置有没有记忆（嵌套与相邻候选共享的尾段只走一次），见 authorityChain；
 * - 全文截断标记位置（第一次需要长范围查询时算一次，之后二分查找）；
 * - 端口判定（从某位置起的数字串结束位置，按起点记忆化）；
 * - SAS：最近一个 URL 片段的边界与其中有无 sv= 版本参数（候选按位置递增，同一片段只算一次）；
 * - 认证头凭据串在紧贴头名处截断的位置（这些头名放宽左边界，留给它们自己的候选）。
 */
export class DetectorScratch {
  private urlBraceResolver: BraceResolver | null = null;
  private headerBraceResolver: BraceResolver | null = null;
  /**
   * URL 授权段读法的记忆，按接续位置 m（某个已闭合组的闭括号 + 1）下标，值都存“数值 + 1”（0 = 尚无记忆 / 没有）：
   * chainEnd 是读法结束位置，chainColon 是 m 之后读法里第一个深度 0 的冒号，chainAt 是 m 之后最后一个深度 0 的
   * @，chainFlags 是结束原因的位（CHAIN_*）。第一次有读法经过已闭合的组时按全文长度分配，之后每组只是几次数组
   * 读写，不分配对象、不查 Map（第四轮复查阻塞：逐组的 Map 读写与对象分配让连续闭合组的检测超线性）。
   */
  private chainEnd: Int32Array | null = null;
  private chainColon: Int32Array | null = null;
  private chainAt: Int32Array | null = null;
  private chainFlags: Uint8Array | null = null;
  /** 本次读法经过的接续位置与各自之后的第一个深度 0 冒号（交错存放，倒序回填记忆用；可复用、按需翻倍）。 */
  private continuations = new Int32Array(32);
  private truncationIndex: Int32Array | null = null;
  private readonly digitRunEnds = new Map<number, number>();
  private sasToken: { start: number; end: number; hasVersion: boolean } | null = null;
  private readonly gluedHeaders = new Set<number>();
  private byteBuffer = new Uint8Array(0);
  private stackBuffer = new Uint8Array(0);
  private quoteIndex: Map<number, Int32Array> | null = null;
  private lineBreakIndex: readonly [Int32Array, Int32Array] | null = null;
  private cookieSeparators: Int32Array | null = null;

  constructor(readonly text: string) {}

  headerBraces(): BraceResolver {
    this.headerBraceResolver ??= new BraceResolver(this.text, headerGroupBlock);
    return this.headerBraceResolver;
  }

  private urlBraces(): BraceResolver {
    this.urlBraceResolver ??= new BraceResolver(this.text, urlGroupBlock);
    return this.urlBraceResolver;
  }

  /**
   * scheme:// 之后授权段的配平读法：深度 0 的字符与整体吸收的 {…} 组交替（组内的 / ? # 空白引号都算口令字符，
   * 能吸收 ${DB_PASS:-默认值} 与 ${{ secrets.X }}），组在换行、转义换行、截断标记、窗口上限或文本末尾处未闭合
   * 时整条读法结束。结论是第一个深度 0 的冒号、最后一个深度 0 的 @、结束位置与结束原因。
   *
   * 读法是位置上的确定性后继（普通字符走到下一位，已闭合的组跳到闭括号之后），所以“从位置 m 起的读法”只取决于
   * m。两条读法只会在某个 `}` 之后汇合：一条跳过以它闭合的组，另一条（起点在那个组里）把它当深度 0 的普通字符
   * 走过。因此只在“跳过组之后的接续位置”记忆读法（按位置下标的类型数组），走到深度 0 的 `}` 或跳过一个组之后
   * 查一次记忆，命中就把尾段的结论直接拼上。每个组、每个字符的开销都是常数，读法与候选再密集也只走一遍
   * （嵌套组共享的尾段、相邻候选共享的组链都只走一次）。
   */
  authorityChain(from: number): AuthorityScan {
    const text = this.text;
    const length = text.length;
    let colon = -1;
    let at = -1;
    let index = from;
    // 本次读法经过的接续位置个数，以及其中尚未找到“其后第一个冒号”的接续位置从哪一个起。
    let count = 0;
    let pending = 0;
    let end = length;
    let flags = 0;
    // 读法汇入已有记忆时，尾段的第一个冒号与最后一个 @（-1 = 没有）。
    let tailColon = -1;
    let tailAt = -1;
    for (;;) {
      if (index >= length) {
        end = length;
        break;
      }
      const code = text.charCodeAt(index);
      if (code === 123) {
        let next = simpleGroupEnd(text, index) + 1;
        // 简单组里没有 `/` 时不可能有候选起点（候选起点紧跟在 :// 或 :\/\/ 之后），也就没有读法会把它的 `}` 当深度
        // 0 的普通字符走过，组之后的接续位置不必记忆（记忆只为这种汇合服务，跳过不改变任何结论）。
        let remember = next > 0 && hasSlashBetween(text, index + 1, next - 1);
        if (next === 0) {
          remember = true;
          // 组里有嵌套的花括号或可能阻断的字符：交给本次调用共享的配平器。
          const braces = this.urlBraces();
          const stop = braces.settle(index);
          if (stop !== STOP_CLOSED) {
            end = braces.endOf(index);
            flags =
              CHAIN_OPEN |
              (stop === STOP_TRUNCATION ? CHAIN_TRUNCATED_IN_GROUP : 0) |
              (stop === STOP_WINDOW ? CHAIN_WINDOW_EXCEEDED : 0);
            break;
          }
          next = braces.endOf(index) + 1;
        }
        const memoEnd = this.chainEnd;
        if (memoEnd !== null && (memoEnd[next] ?? 0) !== 0) {
          // 跳过的组之后已有记忆（别的读法跳过过同一个组）：尾段结论直接拼上。
          end = (memoEnd[next] ?? 1) - 1;
          tailColon = (this.chainColon?.[next] ?? 0) - 1;
          tailAt = (this.chainAt?.[next] ?? 0) - 1;
          flags = this.chainFlags?.[next] ?? 0;
          break;
        }
        if (remember) {
          this.pushContinuation(count, next);
          count++;
        }
        index = next;
        continue;
      }
      if (isAuthorityStop(code)) {
        end = index;
        break;
      }
      if (code === 58) {
        if (colon < 0) {
          colon = index;
        }
        // 还没有冒号的接续位置，其后第一个深度 0 的冒号就是这个。
        for (let slot = pending; slot < count; slot++) {
          this.continuations[slot * 2 + 1] = index;
        }
        pending = count;
      } else if (code === 64) {
        at = index;
      } else if (code === 125) {
        // 深度 0 的 `}`：起点在某个组里的读法走出了那个组。跳过那个组的读法若已记忆了紧随其后的位置，汇合。
        const memoEnd = this.chainEnd;
        const next = index + 1;
        if (memoEnd !== null && (memoEnd[next] ?? 0) !== 0) {
          end = (memoEnd[next] ?? 1) - 1;
          tailColon = (this.chainColon?.[next] ?? 0) - 1;
          tailAt = (this.chainAt?.[next] ?? 0) - 1;
          flags = this.chainFlags?.[next] ?? 0;
          break;
        }
      }
      index++;
    }
    const finalColon = colon >= 0 ? colon : tailColon;
    const finalAt = tailAt >= 0 ? tailAt : at;
    if (count > 0) {
      this.rememberContinuations(count, pending, tailColon, finalAt, end, flags);
    }
    return {
      colon: finalColon,
      at: finalAt,
      end,
      open: (flags & CHAIN_OPEN) !== 0,
      truncatedInGroup: (flags & CHAIN_TRUNCATED_IN_GROUP) !== 0,
      windowExceeded: (flags & CHAIN_WINDOW_EXCEEDED) !== 0,
    };
  }

  /** 记下读法经过的第 slot 个接续位置（其后的第一个冒号先记 -1，由 authorityChain 在遇到冒号时补上）。 */
  private pushContinuation(slot: number, position: number): void {
    if (this.continuations.length < (slot + 1) * 2) {
      const grown = new Int32Array(this.continuations.length * 2);
      grown.set(this.continuations);
      this.continuations = grown;
    }
    this.continuations[slot * 2] = position;
    this.continuations[slot * 2 + 1] = -1;
  }

  /**
   * 把本次读法经过的接续位置写进记忆：从接续位置 m 起的读法与本次读法同一个结束位置与结束原因；其后第一个冒号
   * 是读法里 m 之后的第一个深度 0 冒号（读法里没有时取汇入的尾段的冒号）；其后最后一个 @ 是整条读法的最后一个
   * @（它在 m 之后时），否则没有。
   */
  private rememberContinuations(
    count: number,
    pending: number,
    tailColon: number,
    finalAt: number,
    end: number,
    flags: number
  ): void {
    let memoEnd = this.chainEnd;
    let memoColon = this.chainColon;
    let memoAt = this.chainAt;
    let memoFlags = this.chainFlags;
    if (memoEnd === null || memoColon === null || memoAt === null || memoFlags === null) {
      // 第一次有读法需要记忆：四张表一起按全文长度 + 1 分配（接续位置最大是文本末尾）。
      const size = this.text.length + 1;
      memoEnd = new Int32Array(size);
      memoColon = new Int32Array(size);
      memoAt = new Int32Array(size);
      memoFlags = new Uint8Array(size);
      this.chainEnd = memoEnd;
      this.chainColon = memoColon;
      this.chainAt = memoAt;
      this.chainFlags = memoFlags;
    }
    const continuations = this.continuations;
    for (let slot = 0; slot < count; slot++) {
      const position = continuations[slot * 2] ?? 0;
      const colon = slot >= pending ? tailColon : (continuations[slot * 2 + 1] ?? -1);
      memoEnd[position] = end + 1;
      memoColon[position] = colon + 1;
      memoAt[position] = finalAt >= position ? finalAt + 1 : 0;
      memoFlags[position] = flags;
    }
  }

  /** [from, to) 里第一个截断标记的起点，没有为 -1。 */
  firstTruncationIn(from: number, to: number): number {
    if (to - from <= SHORT_TRUNCATION_RANGE) {
      for (let index = from; index < to; index++) {
        if (truncationStartsAt(this.text, index)) {
          return index;
        }
      }
      return -1;
    }
    const starts = this.truncationStarts();
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((starts[middle] ?? 0) < from) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const first = starts[low];
    return first !== undefined && first < to ? first : -1;
  }

  private truncationStarts(): Int32Array {
    if (this.truncationIndex === null) {
      const starts: number[] = [];
      const finder = /[.\u2026[(]/g;
      for (let match = finder.exec(this.text); match !== null; match = finder.exec(this.text)) {
        if (truncationStartsAt(this.text, match.index)) {
          starts.push(match.index);
        }
      }
      this.truncationIndex = Int32Array.from(starts);
    }
    return this.truncationIndex;
  }

  /** [from, to) 非空且全是数字（端口）。按起点记忆化数字串的结束位置。 */
  isDigitRun(from: number, to: number): boolean {
    if (to <= from) {
      return false;
    }
    let end = this.digitRunEnds.get(from);
    if (end === undefined) {
      end = from;
      while (end < this.text.length) {
        const code = this.text.charCodeAt(end);
        if (code < 48 || code > 57) {
          break;
        }
        end++;
      }
      this.digitRunEnds.set(from, end);
    }
    return end >= to;
  }

  /** 包含位置 at 的 URL 片段里有没有 SAS 版本参数（sv=<四位数字>）。候选按位置递增，同一片段只算一次。 */
  sasVersionAround(at: number): boolean {
    const cached = this.sasToken;
    if (cached !== null && at >= cached.start && at < cached.end) {
      return cached.hasVersion;
    }
    const text = this.text;
    let start = at;
    while (start > 0 && !isUrlTokenStop(text.charCodeAt(start - 1))) {
      start--;
    }
    let end = at;
    while (end < text.length && !isUrlTokenStop(text.charCodeAt(end))) {
      end++;
    }
    const token = { start, end, hasVersion: SAS_VERSION.test(text.slice(start, end)) };
    this.sasToken = token;
    return token.hasVersion;
  }

  markGluedHeader(at: number): void {
    this.gluedHeaders.add(at);
  }

  isGluedHeader(at: number): boolean {
    return this.gluedHeaders.has(at);
  }

  /**
   * 把 text[start, end)（base64url）解码进共享的字节缓冲 bytes，返回字节数；遇到非 base64url 字符返回 -1（调用方
   * 只传 base64url 串，这是防御）。与 Buffer.from(段, 'base64url') 逐字节相同：每 4 个字符 3 个字节，余 2 个字符
   * 1 个字节、余 3 个字符 2 个字节，余 1 个字符（不足一个字节）丢弃，末尾多出的位丢弃。缓冲只增不减、按需扩容。
   */
  decodeBase64Url(start: number, end: number): number {
    const needed = Math.floor(((end - start) * 6) / 8);
    if (this.byteBuffer.length < needed) {
      this.byteBuffer = new Uint8Array(Math.max(needed, this.byteBuffer.length * 2));
    }
    const bytes = this.byteBuffer;
    let length = 0;
    let bits = 0;
    let count = 0;
    for (let index = start; index < end; index++) {
      const sextet = base64UrlSextet(this.text.charCodeAt(index));
      if (sextet < 0) {
        return -1;
      }
      bits = ((bits << 6) | sextet) & 0xffffff;
      count += 6;
      if (count >= 8) {
        count -= 8;
        bytes[length++] = (bits >> count) & 0xff;
      }
    }
    return length;
  }

  /** decodeBase64Url 写入的字节缓冲（只读其前 length 个字节）。 */
  get bytes(): Uint8Array {
    return this.byteBuffer;
  }

  /** JSON 判定器的显式栈（至少 length 字节，按需扩容）。 */
  jsonStack(length: number): Uint8Array {
    if (this.stackBuffer.length < length) {
      this.stackBuffer = new Uint8Array(Math.max(length, this.stackBuffer.length * 2));
    }
    return this.stackBuffer;
  }

  /**
   * 带引号的值找闭引号（与逐字符有界扫描逐例相同）：innerStart 是开引号之后的位置，开引号前有 slashes 个反斜杠，
   * 闭合须是紧跟在恰好 slashes 个反斜杠之后的同一引号字符。从 innerStart 起、窗口上限（innerStart + MAX_VALUE_SCAN）
   * 之前，先遇到换行就是 line，先遇到闭合就是 closed（at 是闭引号位置）；都没有时窗口在文本末尾之前触顶为 window，
   * 否则为 end。闭引号前的反斜杠串不会越过 innerStart（innerStart - 1 是开引号，不是反斜杠），所以“紧跟恰好
   * slashes 个反斜杠”可以用全文预建的索引判定：按“引号字符 + 其前反斜杠个数”分组的位置表、换行位置表，各二分
   * 查找一次。索引在本次调用里第一次需要时建一次（每个引号前的反斜杠串只回数一次），之后候选再密集、开引号的
   * 反斜杠个数再多变，每次查找都是对数开销，不再逐候选向前扫窗口（第三轮复查阻塞）。
   */
  quoteClose(innerStart: number, quote: number, slashes: number): QuoteClose {
    const limit = Math.min(this.text.length, innerStart + MAX_VALUE_SCAN);
    const group = this.quotePositions().get(quoteKey(quote, slashes));
    const close = group === undefined ? -1 : firstAtOrAfter(group, innerStart);
    const lineBreaks = this.lineBreakPositions();
    const lineFeed = firstAtOrAfter(lineBreaks[0], innerStart);
    const carriageReturn = firstAtOrAfter(lineBreaks[1], innerStart);
    let line = lineFeed;
    if (carriageReturn >= 0 && (line < 0 || carriageReturn < line)) {
      line = carriageReturn;
    }
    if (close >= 0 && close < limit && (line < 0 || close < line)) {
      return { stop: 'closed', at: close };
    }
    if (line >= 0 && line < limit) {
      return { stop: 'line', at: line };
    }
    return limit < this.text.length
      ? { stop: 'window', at: limit }
      : { stop: 'end', at: this.text.length };
  }

  /**
   * [from, to) 里有没有 Cookie 值的分隔字符（与 /[\s;,]/ 相同：分号、逗号与正则 \s 的全部空白）。全文的分隔字符
   * 位置在第一次需要时建一次、二分查找，载体引号的判定不再逐候选扫内层（候选的内层可以互相重叠）。
   */
  hasCookieSeparator(from: number, to: number): boolean {
    if (this.cookieSeparators === null) {
      const positions: number[] = [];
      const text = this.text;
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code === 59 || code === 44 || isRegexSpaceCode(code)) {
          positions.push(index);
        }
      }
      this.cookieSeparators = Int32Array.from(positions);
    }
    const first = firstAtOrAfter(this.cookieSeparators, from);
    return first >= 0 && first < to;
  }

  /** 引号位置表：键为 quoteKey(引号字符, 其前反斜杠个数)，值为升序位置。用 indexOf 找引号，反斜杠串只回数一次。 */
  private quotePositions(): Map<number, Int32Array> {
    if (this.quoteIndex === null) {
      const groups = new Map<number, number[]>();
      const text = this.text;
      for (const quote of [34, 39]) {
        const char = String.fromCharCode(quote);
        for (let at = text.indexOf(char); at >= 0; at = text.indexOf(char, at + 1)) {
          let run = 0;
          while (at - run - 1 >= 0 && text.charCodeAt(at - run - 1) === 92) {
            run++;
          }
          const key = quoteKey(quote, run);
          const group = groups.get(key);
          if (group === undefined) {
            groups.set(key, [at]);
          } else {
            group.push(at);
          }
        }
      }
      const index = new Map<number, Int32Array>();
      for (const [key, positions] of groups) {
        index.set(key, Int32Array.from(positions));
      }
      this.quoteIndex = index;
    }
    return this.quoteIndex;
  }

  /** \n 与 \r 的升序位置表（各一张）。 */
  private lineBreakPositions(): readonly [Int32Array, Int32Array] {
    if (this.lineBreakIndex === null) {
      const collect = (char: string): Int32Array => {
        const positions: number[] = [];
        for (let at = this.text.indexOf(char); at >= 0; at = this.text.indexOf(char, at + 1)) {
          positions.push(at);
        }
        return Int32Array.from(positions);
      };
      this.lineBreakIndex = [collect('\n'), collect('\r')];
    }
    return this.lineBreakIndex;
  }
}

/** 带引号的值找闭引号的结论；at 是闭引号、换行、窗口上限或文本末尾的位置。 */
export interface QuoteClose {
  readonly stop: 'closed' | 'line' | 'window' | 'end';
  readonly at: number;
}

function quoteKey(quote: number, slashes: number): number {
  return slashes * 2 + (quote === 39 ? 1 : 0);
}

/** 升序位置表里第一个不小于 from 的值，没有为 -1。 */
function firstAtOrAfter(positions: Int32Array, from: number): number {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((positions[middle] ?? 0) < from) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < positions.length ? (positions[low] ?? -1) : -1;
}

// =============================================================================================
// 合成正反例（运行时按片段拼接，源码文本里不出现连续的 token 形态）
// =============================================================================================

/** 按字母表循环拼出指定长度的合成串。 */
function synthetic(
  length: number,
  alphabet = 'SYNTHETIC0123456789abcdefghijkmnpqrstuvwxyz'
): string {
  let out = '';
  for (let index = 0; out.length < length; index += 1) {
    out += alphabet[index % alphabet.length];
  }
  return out;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

const join = (...parts: string[]): string => parts.join('');

const ghToken = (letter: string): string => join('gh', letter, '_', synthetic(36));
const fineGrainedPat = join(
  'github',
  '_pat_',
  synthetic(22),
  '_',
  synthetic(59, 'SYNTHETICfine0123456789')
);
const gitlabPat = join('glpat', '-', synthetic(20, 'SYNTHETIClab_0123456789-'));
const slackBot = join('xox', 'b-', '1234567890', '-', '1234567890123', '-', synthetic(24));
const slackUser = join('xox', 'p-', '123456789012-123456789012-123456789012', '-', synthetic(32));
const stripeLive = join('sk', '_live_', synthetic(24));
const stripeTest = join('sk', '_test_', synthetic(24, 'SYNTHETICtest0123456789'));
const stripeRestricted = join('rk', '_live_', synthetic(24, 'SYNTHETICrest0123456789'));
const npmToken = join('npm', '_', synthetic(36, 'SYNTHETICnpm0123456789'));
const anthropicKey = join('sk', '-ant-', 'api03-', synthetic(93, 'SYNTHETICant_0123456789-'), 'AA');
const googleKey = join('AI', 'za', synthetic(35, 'SYNTHETICgoo_0123456789-'));
const awsKeyId = join('AK', 'IA', 'SYNTHETIC234567A');
const awsTempKeyId = join('AS', 'IA', 'SYNTHETICQRSTUVW');

const jwtHeader = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
const jwtPayload = base64UrlJson({ sub: 'SYNTHETIC', iat: 0 });
const jwtSignature = synthetic(43, 'SYNTHETICsig_0123456789-');
const jwtToken = [jwtHeader, jwtPayload, jwtSignature].join('.');

const credential = synthetic(32, 'SYNTHETICcred0123456789');
const basicCredential = Buffer.from(join('svc:', synthetic(16)), 'utf8').toString('base64');
const urlPassword = synthetic(18, 'SYNTHETICpw0123456789');
const sasSignature = join(synthetic(20, 'SYNTHETICsas0123456789'), '%2B', synthetic(8), '%3D');

// =============================================================================================
// 前缀 token（数据驱动：前缀、正文字符类、完整长度范围、可选形态）
// =============================================================================================

interface PrefixedTokenSpec {
  readonly id: string;
  /** 前缀的正则源（不含捕获组）。 */
  readonly prefix: string;
  /** 正文的单字符类正则源。 */
  readonly body: string;
  readonly minBody: number;
  readonly maxBody: number;
  /** 完整形态的二次确认（作用在正文上）；缺省表示长度合格即命中。 */
  readonly shape?: RegExp;
  readonly prefilter: RegExp;
  readonly examples: readonly [DetectorExample, ...DetectorExample[]];
  readonly negativeExamples: readonly [string, ...string[]];
}

function prefixedTokenRule(spec: PrefixedTokenSpec): DetectorRule {
  return {
    id: spec.id,
    tier: 'T1',
    kind: 'prefixed-token',
    sources: ALL_DETECTOR_SOURCES,
    marker: '[redacted-api-key]',
    prefilter: spec.prefilter,
    // 正文贪婪匹配到第一个非正文字符；左右边界在 locate 里手工判断，正则以字面前缀开头，扫描是线性的。
    pattern: new RegExp(`(?:${spec.prefix})(${spec.body}*)`, 'g'),
    locate(text, match, sink) {
      const start = match.index;
      const end = start + match[0].length;
      if (!leftBoundaryAt(text, start) || !rightBoundaryAt(text, end)) {
        // 嵌在更长的标识符里（例如 xghp_…、ghp_…_suffix）：不是独立 token，不算候选。
        return [];
      }
      const body = match[1] ?? '';
      if (
        body.length >= spec.minBody &&
        body.length <= spec.maxBody &&
        (spec.shape === undefined || spec.shape.test(body))
      ) {
        return [[start, end]];
      }
      if (
        body.length >= TRUNCATED_TOKEN_MIN_BODY &&
        body.length <= spec.maxBody &&
        truncationFollows(text, end)
      ) {
        // 行中截断：可见部分不满足完整形态（太短，或 Slack 这类带结构的正文被截在中间），但紧跟截断标记，
        // 按可见部分遮蔽，并计入截断事件。比完整形态还长的正文不是截断的 token，不在此列。
        sink?.event('truncated', spec.id);
        return [[start, end]];
      }
      sink?.event('rejected', spec.id);
      return [];
    },
    examples: spec.examples,
    negativeExamples: spec.negativeExamples,
  };
}

const PREFIXED_TOKEN_SPECS: readonly PrefixedTokenSpec[] = [
  {
    id: 'github-token',
    prefix: 'gh[pousr]_',
    body: '[A-Za-z0-9]',
    minBody: 36,
    maxBody: 255,
    prefilter: /_(?<=gh[pousr]_)/,
    examples: [
      { text: `{"stdout":"line\\n${ghToken('p')}\\n"}`, secrets: [ghToken('p')] },
      ...['p', 'o', 'u', 's', 'r'].map((letter) => ({
        text: `deploy ${ghToken(letter)} rotated`,
        secrets: [ghToken(letter)],
      })),
      { text: `-${ghToken('s')}\n+next`, secrets: [ghToken('s')] },
      {
        text: join('git remote add origin https://bot:', ghToken('s'), '@github.com/o/r.git'),
        secrets: [ghToken('s')],
      },
      // 行中截断：前缀之后只剩一段可见字符，紧跟截断标记。
      {
        text: `token prefix ${ghToken('p').slice(0, 14)}... [truncated]`,
        secrets: [ghToken('p').slice(0, 14)],
      },
      { text: `${ghToken('o').slice(0, 20)}\u2026`, secrets: [ghToken('o').slice(0, 20)] },
    ],
    negativeExamples: [
      'const prefix = "ghp_";',
      join('gh', 'p_', synthetic(12), ' is a placeholder'),
      join('x', ghToken('p')),
      join(ghToken('p'), '_suffix'),
      join('gh', 'x_', synthetic(36)),
    ],
  },
  {
    id: 'github-fine-grained-pat',
    prefix: 'github_pat_',
    body: '[A-Za-z0-9_]',
    minBody: 50,
    maxBody: 255,
    prefilter: /_pat_(?<=github_pat_)/,
    examples: [
      { text: `GH_PAT=${fineGrainedPat}`, secrets: [fineGrainedPat] },
      { text: `"auth": "${fineGrainedPat}"`, secrets: [fineGrainedPat] },
    ],
    negativeExamples: [
      'const kind = "github_pat_placeholder";',
      join('github', '_pat_', synthetic(22), ' too short'),
    ],
  },
  {
    id: 'gitlab-pat',
    prefix: 'glpat-',
    body: '[A-Za-z0-9_-]',
    minBody: 20,
    maxBody: 255,
    prefilter: /-(?<=glpat-)/,
    examples: [
      { text: `CI_PUSH=${gitlabPat}`, secrets: [gitlabPat] },
      { text: `svc,${gitlabPat},2026-10-21`, secrets: [gitlabPat] },
    ],
    negativeExamples: ['const prefix = "glpat-";', join('glpat', '-', synthetic(8), ' docs')],
  },
  {
    id: 'slack-token',
    prefix: 'xox[abposr]-',
    body: '[A-Za-z0-9-]',
    minBody: 10,
    maxBody: 255,
    shape: /^(?:[0-9]{1,13}-){1,3}[A-Za-z0-9][A-Za-z0-9-]{7,}$/,
    prefilter: /-(?<=xox[abposr]-)/,
    examples: [
      { text: `notify ${slackBot}`, secrets: [slackBot] },
      { text: `# ${slackUser}`, secrets: [slackUser] },
    ],
    negativeExamples: [
      'const slack = "xoxb-your-token-here";',
      'const prefix = "xoxp-";',
      join('xox', 'z-', '1234567890-', synthetic(24)),
    ],
  },
  {
    id: 'stripe-secret-key',
    // D10：Stripe 测试 key（sk_test_、rk_test_）同样遮蔽。
    prefix: '[sr]k_(?:live|test)_',
    body: '[A-Za-z0-9]',
    minBody: 16,
    maxBody: 255,
    prefilter: /_(?<=[sr]k_(?:live|test)_)/,
    examples: [
      { text: `stripe ${stripeLive}`, secrets: [stripeLive] },
      { text: `"key": "${stripeTest}"`, secrets: [stripeTest] },
      { text: `* ${stripeRestricted}`, secrets: [stripeRestricted] },
    ],
    negativeExamples: [
      join('pk', '_live_', synthetic(24)),
      join('sk', '_test_', 'short'),
      'const mode = "sk_live_";',
    ],
  },
  {
    id: 'npm-token',
    prefix: 'npm_',
    body: '[A-Za-z0-9]',
    minBody: 36,
    maxBody: 255,
    prefilter: /_(?<=npm_)/,
    examples: [{ text: `//registry.npmjs.org/:_auth ${npmToken}`, secrets: [npmToken] }],
    negativeExamples: [
      'process.env.npm_package_version',
      'process.env.npm_config_registry',
      join('npm', '_', synthetic(35)),
    ],
  },
  {
    id: 'anthropic-api-key',
    prefix: 'sk-ant-',
    body: '[A-Za-z0-9_-]',
    minBody: 32,
    maxBody: 255,
    prefilter: /-(?<=sk-ant-)/,
    examples: [{ text: `ANTHROPIC=${anthropicKey}`, secrets: [anthropicKey] }],
    negativeExamples: ['const prefix = "sk-ant-";'],
  },
  {
    id: 'google-api-key',
    prefix: 'AIza',
    body: '[A-Za-z0-9_-]',
    minBody: 35,
    maxBody: 35,
    prefilter: /za(?<=AIza)/,
    examples: [{ text: `maps ${googleKey}`, secrets: [googleKey] }],
    negativeExamples: ['const googlePrefix = "AIza";'],
  },
  {
    id: 'aws-access-key-id',
    // D10：AWS 访问密钥 ID 也遮（误伤低）；临时凭据 ASIA、A3T… 同一形态。
    prefix: 'A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA',
    body: '[A-Z2-7]',
    minBody: 16,
    maxBody: 16,
    prefilter: /A(?:3T|KIA|SIA|BIA|CCA)/,
    examples: [
      { text: `aws_access_key_id ${awsKeyId}`, secrets: [awsKeyId] },
      { text: `id=${awsTempKeyId}`, secrets: [awsTempKeyId] },
    ],
    negativeExamples: ['const AKIA_PREFIX = 1;', 'ASIAN markets', join('AK', 'IA', 'SHORT')],
  },
];

// =============================================================================================
// JWT
// =============================================================================================

/**
 * text[start, end)（一段 base64url）解码后是否为 JSON 对象（JWT 的 header 与 payload 都是 JSON 对象）。判定与
 * “Buffer.from(段, 'base64url').toString('utf8') 以 { 开头且 JSON.parse 成功”逐例相同（随机差分测试钉住），但不抛
 * 异常、不建字符串：解码进本次调用共享的字节缓冲，再由 isJsonObjectBytes 一遍判定。以前用 try/catch 包 JSON.parse
 * 当判定，形似对象却不合法的段（例如解码为 {"xx} 的 eyJ4eH0、尾逗号对象）每个候选都要走一次抛异常加捕获，链式
 * 排列时比 v3 慢几十倍（第三轮复查阻塞）。
 */
export function decodesToJsonObject(
  text: string,
  start: number,
  end: number,
  scratch: DetectorScratch
): boolean {
  const length = scratch.decodeBase64Url(start, end);
  return length >= 0 && isJsonObjectBytes(scratch.bytes, length, scratch.jsonStack(length));
}

/** base64url 字母表的 6 位值；不是 base64url 字符时返回 -1。 */
function base64UrlSextet(code: number): number {
  if (code >= 65 && code <= 90) {
    return code - 65;
  }
  if (code >= 97 && code <= 122) {
    return code - 71;
  }
  if (code >= 48 && code <= 57) {
    return code + 4;
  }
  if (code === 45) {
    return 62;
  }
  if (code === 95) {
    return 63;
  }
  return -1;
}

const JSON_OBJECT_FRAME = 1;
const JSON_ARRAY_FRAME = 2;

/** JSON 空白（只有空格、\t、\n、\r；ECMAScript JSON.parse 的口径）之后的位置。 */
function skipJsonSpace(bytes: Uint8Array, from: number, length: number): number {
  let index = from;
  while (index < length) {
    const byte = bytes[index];
    if (byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      break;
    }
    index++;
  }
  return index;
}

function isHexByte(byte: number | undefined): boolean {
  return (
    byte !== undefined &&
    ((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102))
  );
}

function isDigitByte(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 48 && byte <= 57;
}

/**
 * from 处（开引号之后）的 JSON 字符串到闭引号之后的位置；不合法返回 -1。字符串里小于 0x20 的字节不合法；非 ASCII
 * 字节（合法的 UTF-8 多字节序列，或非法序列——解码成 U+FFFD）都是不小于 0x20 的字符，合法；转义只有 \" \\ \/ \b
 * \f \n \r \t 与 \u 加 4 位十六进制（孤立代理项也合法，与 JSON.parse 相同）。
 */
function jsonStringEnd(bytes: Uint8Array, from: number, length: number): number {
  let index = from;
  while (index < length) {
    const byte = bytes[index] ?? 0;
    if (byte === 34) {
      return index + 1;
    }
    if (byte < 32) {
      return -1;
    }
    if (byte === 92) {
      const escaped = bytes[index + 1];
      if (
        escaped === 34 ||
        escaped === 92 ||
        escaped === 47 ||
        escaped === 98 ||
        escaped === 102 ||
        escaped === 110 ||
        escaped === 114 ||
        escaped === 116
      ) {
        index += 2;
        continue;
      }
      if (
        escaped === 117 &&
        isHexByte(bytes[index + 2]) &&
        isHexByte(bytes[index + 3]) &&
        isHexByte(bytes[index + 4]) &&
        isHexByte(bytes[index + 5])
      ) {
        index += 6;
        continue;
      }
      return -1;
    }
    index++;
  }
  return -1;
}

/** from 处 JSON 数字（-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?）之后的位置；不合法返回 -1。 */
function jsonNumberEnd(bytes: Uint8Array, from: number, length: number): number {
  let index = from;
  if (bytes[index] === 45) {
    index++;
  }
  if (bytes[index] === 48) {
    index++;
  } else if (isDigitByte(bytes[index])) {
    while (index < length && isDigitByte(bytes[index])) {
      index++;
    }
  } else {
    return -1;
  }
  if (index < length && bytes[index] === 46) {
    index++;
    if (!(index < length && isDigitByte(bytes[index]))) {
      return -1;
    }
    while (index < length && isDigitByte(bytes[index])) {
      index++;
    }
  }
  if (index < length && (bytes[index] === 101 || bytes[index] === 69)) {
    index++;
    if (index < length && (bytes[index] === 43 || bytes[index] === 45)) {
      index++;
    }
    if (!(index < length && isDigitByte(bytes[index]))) {
      return -1;
    }
    while (index < length && isDigitByte(bytes[index])) {
      index++;
    }
  }
  return index;
}

/** from 处是否是字面量 word（true、false、null 的 ASCII 字节）。 */
function jsonLiteralAt(bytes: Uint8Array, from: number, length: number, word: string): boolean {
  if (from + word.length > length) {
    return false;
  }
  for (let offset = 0; offset < word.length; offset++) {
    if (bytes[from + offset] !== word.charCodeAt(offset)) {
      return false;
    }
  }
  return true;
}

/** 判定器的状态：期待值、期待值或 ]（刚过 [）、期待键、期待键或 }（刚过 {）、值之后。 */
const JSON_EXPECT_VALUE = 0;
const JSON_EXPECT_VALUE_OR_CLOSE = 1;
const JSON_EXPECT_KEY = 2;
const JSON_EXPECT_KEY_OR_CLOSE = 3;
const JSON_AFTER_VALUE = 4;

/**
 * bytes[0, length) 是否是以 { 开头、整段合法的 JSON 文本（与“UTF-8 解码后以 { 开头且 JSON.parse 成功”逐例相同）：
 * - 结构字符、字面量、数字与 JSON 空白全是 ASCII；非 ASCII 字节只可能在字符串里合法。UTF-8 解码遇到非法序列时
 *   替换为 U+FFFD，但不会吞掉其后的 ASCII 字节（WHATWG 口径），所以按字节判定与按解码后的字符判定逐例相同；
 * - 开头必须就是 {（不允许前导空白，沿用原判定的形状预检），对象之后只允许 JSON 空白；
 * - 显式栈（stack 至少 length 字节，由调用方提供）、一遍扫描，不递归、不抛异常，嵌套再深也是线性。
 */
export function isJsonObjectBytes(bytes: Uint8Array, length: number, stack: Uint8Array): boolean {
  if (length === 0 || bytes[0] !== 123) {
    return false;
  }
  let depth = 0;
  let index = 0;
  let state = JSON_EXPECT_VALUE;
  for (;;) {
    index = skipJsonSpace(bytes, index, length);
    if (state === JSON_AFTER_VALUE) {
      if (depth === 0) {
        return index === length;
      }
      const byte = bytes[index];
      const frame = stack[depth - 1];
      if (byte === 44) {
        index++;
        state = frame === JSON_OBJECT_FRAME ? JSON_EXPECT_KEY : JSON_EXPECT_VALUE;
        continue;
      }
      if (
        (byte === 125 && frame === JSON_OBJECT_FRAME) ||
        (byte === 93 && frame === JSON_ARRAY_FRAME)
      ) {
        index++;
        depth--;
        continue;
      }
      return false;
    }
    if (index >= length) {
      return false;
    }
    const byte = bytes[index];
    if (
      (state === JSON_EXPECT_KEY_OR_CLOSE && byte === 125) ||
      (state === JSON_EXPECT_VALUE_OR_CLOSE && byte === 93)
    ) {
      index++;
      depth--;
      state = JSON_AFTER_VALUE;
      continue;
    }
    if (state === JSON_EXPECT_KEY || state === JSON_EXPECT_KEY_OR_CLOSE) {
      if (byte !== 34) {
        return false;
      }
      index = jsonStringEnd(bytes, index + 1, length);
      if (index < 0) {
        return false;
      }
      index = skipJsonSpace(bytes, index, length);
      if (bytes[index] !== 58 || index >= length) {
        return false;
      }
      index++;
      state = JSON_EXPECT_VALUE;
      continue;
    }
    // 期待一个值。
    if (byte === 123 || byte === 91) {
      stack[depth++] = byte === 123 ? JSON_OBJECT_FRAME : JSON_ARRAY_FRAME;
      index++;
      state = byte === 123 ? JSON_EXPECT_KEY_OR_CLOSE : JSON_EXPECT_VALUE_OR_CLOSE;
      continue;
    }
    if (byte === 34) {
      index = jsonStringEnd(bytes, index + 1, length);
    } else if (byte === 45 || isDigitByte(byte)) {
      index = jsonNumberEnd(bytes, index, length);
    } else if (byte === 116 && jsonLiteralAt(bytes, index, length, 'true')) {
      index += 4;
    } else if (byte === 102 && jsonLiteralAt(bytes, index, length, 'false')) {
      index += 5;
    } else if (byte === 110 && jsonLiteralAt(bytes, index, length, 'null')) {
      index += 4;
    } else {
      return false;
    }
    if (index < 0) {
      return false;
    }
    state = JSON_AFTER_VALUE;
  }
}

/** from 起最长的 base64url 串（[A-Za-z0-9_-]）的结束位置。 */
function base64UrlRunEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length && isWordishCode(text.charCodeAt(index))) {
    index++;
  }
  return index;
}

const JWT_RULE: DetectorRule = {
  id: 'jwt',
  tier: 'T1',
  kind: 'jwt',
  sources: ALL_DETECTOR_SOURCES,
  marker: '[redacted-token]',
  prefilter: /J(?<=eyJ)/,
  // 候选只匹配第一段（以 eyJ 开头的最长 base64url 串，不回溯）；后两段在 locate 里手工扫。三段式正则在很长、
  // 中间没有点号的 base64url 串里会从每个 eyJ 起点吃到串尾再逐字符回退找“.”（平方级）。第一段后面不是“.”时，
  // 同一段里其他 eyJ 起点的结论完全相同（段尾、段后字符都一样），所以候选失败后从第一段末尾继续是精确的。
  pattern: /eyJ[A-Za-z0-9_-]*/g,
  locate(text, match, sink, scratch) {
    const start = match.index;
    const firstEnd = start + match[0].length;
    // 第一段至少 eyJ 加 4 个字符，后接“.”；第二段至少 4 个字符，后接“.”；签名段可以为空（alg=none）或被截断。
    if (match[0].length < 7 || text.charCodeAt(firstEnd) !== 46) {
      return [];
    }
    const secondEnd = base64UrlRunEnd(text, firstEnd + 1);
    if (secondEnd - firstEnd - 1 < 4 || text.charCodeAt(secondEnd) !== 46) {
      return [];
    }
    const end = base64UrlRunEnd(text, secondEnd + 1);
    if (!leftBoundaryAt(text, start)) {
      return [];
    }
    // 前两段必须解码为 JSON 对象才算 JWT（不抛异常的线性判定；每段至多作为第一段、第二段各判一次）。
    if (
      !decodesToJsonObject(text, start, firstEnd, scratch) ||
      !decodesToJsonObject(text, firstEnd + 1, secondEnd, scratch)
    ) {
      sink?.event('rejected', 'jwt');
      return [];
    }
    return [[start, end]];
  },
  examples: [
    { text: `jwt ${jwtToken}`, secrets: [jwtToken] },
    { text: `{"id_token":"${jwtToken}","ok":true}`, secrets: [jwtToken] },
    {
      text: `INFO session ${[jwtHeader, jwtPayload, jwtSignature.slice(0, 9)].join('.')}...`,
      secrets: [[jwtHeader, jwtPayload, jwtSignature.slice(0, 9)].join('.')],
    },
  ],
  negativeExamples: [
    [jwtHeader, Buffer.from('not-json-payload', 'utf8').toString('base64url'), synthetic(43)].join(
      '.'
    ),
    [jwtHeader, jwtPayload].join('.'),
    join('eyJ', 'hbGciOi is a truncated header only'),
  ],
};

// =============================================================================================
// 认证头：Authorization / Proxy-Authorization
// =============================================================================================

/**
 * 认证方案名后跟空白（RFC 7235 token 的常见子集）：[A-Za-z][A-Za-z0-9._~+/-]* 加 [ \t]+。逐字符扫描、不切固定
 * 窗口（超长的“方案名”后面的凭据也要遮住）。返回凭据起点（跳过方案名与空白之后），不是方案名时返回 -1。
 */
function authSchemeEnd(text: string, from: number): number {
  const first = text.charCodeAt(from);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) {
    return -1;
  }
  let index = from + 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 46 ||
      code === 95 ||
      code === 126 ||
      code === 43 ||
      code === 47 ||
      code === 45
    ) {
      index++;
      continue;
    }
    break;
  }
  const nameEnd = index;
  while (index < text.length && (text.charCodeAt(index) === 32 || text.charCodeAt(index) === 9)) {
    index++;
  }
  return index > nameEnd ? index : -1;
}

/** 参数值的首字符不能是这些（与 token68 的 = 填充区分）：空白、= , 引号、反斜杠。 */
const PARAM_VALUE_FORBIDDEN_FIRST = /[\s=,"'\\]/;

/**
 * 方案之后是 auth-param 列表：name=value，值不以 = 开头（区别于 token68 的 = 填充），带引号的值可以有转义反斜杠。
 * 与 /^[A-Za-z][\w-]*[ \t]*=[ \t]*(?:\\*"|[^\s=,"'\\])/ 的判定相同，但逐字符扫描、不切固定窗口（超长参数名
 * 后面的参数值也要遮住）。
 */
function startsAuthParam(text: string, from: number): boolean {
  const nameEnd = paramNameEnd(text, from);
  if (nameEnd === from) {
    return false;
  }
  let index = nameEnd;
  while (index < text.length && (text.charCodeAt(index) === 32 || text.charCodeAt(index) === 9)) {
    index++;
  }
  if (text.charCodeAt(index) !== 61) {
    return false;
  }
  index++;
  while (index < text.length && (text.charCodeAt(index) === 32 || text.charCodeAt(index) === 9)) {
    index++;
  }
  if (index >= text.length) {
    return false;
  }
  let quote = index;
  while (text.charCodeAt(quote) === 92) {
    quote++;
  }
  if (text.charCodeAt(quote) === 34) {
    return true;
  }
  return !PARAM_VALUE_FORBIDDEN_FIRST.test(text[index] ?? '');
}
/** 单独出现、后面没有凭据的方案名不是凭据（例如 'Bearer ' + token 里的 Bearer）。 */
const BARE_SCHEME_WORD =
  /^(?:bearer|basic|digest|token|bot|negotiate|ntlm|oauth|hoba|mutual|apikey|api-key|key|jwt|dpop)$/i;

function isCredentialCode(code: number): boolean {
  // token68 与常见凭据字符：字母数字 . _ ~ + / = : % @ ! * $ -
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 46 ||
    code === 95 ||
    code === 126 ||
    code === 43 ||
    code === 47 ||
    code === 61 ||
    code === 58 ||
    code === 37 ||
    code === 64 ||
    code === 33 ||
    code === 42 ||
    code === 36 ||
    code === 45
  );
}

/**
 * 紧贴的头名：认证头或 Cookie 头的名字（大小写不敏感，可带闭引号）后接冒号与空白（HTTP 头的写法），即
 * /^(?:(?:proxy-)?authorization|(?:set-)?cookie)(?:\\*["'])?[ \t]*:[ \t]/i 的判定。凭据串在这里截断，头名留给
 * 它自己的候选。冒号后必须有空格或制表符：`cookie:secret` 这类 user:pass 形态里的冒号属于凭据本身，不截断（截断
 * 会让冒号后的口令既不在本区间里、也不被 Cookie 候选认领）。凭据串的每个位置都要问一次，所以逐字符比较，不切片、
 * 不跑正则。
 */
const GLUED_HEADER_NAMES: readonly string[] = Object.freeze([
  'proxy-authorization',
  'authorization',
  'set-cookie',
  'cookie',
]);

/** text 在 at 处是否是小写名字 lower（字母按 ASCII 大小写不敏感比较，其余字符逐字相等）。 */
function matchesAsciiIgnoreCase(text: string, at: number, lower: string): boolean {
  if (at + lower.length > text.length) {
    return false;
  }
  for (let offset = 0; offset < lower.length; offset++) {
    const expected = lower.charCodeAt(offset);
    const actual = text.charCodeAt(at + offset);
    if (expected >= 97 && expected <= 122 ? (actual | 32) !== expected : actual !== expected) {
      return false;
    }
  }
  return true;
}

export function startsGluedHeaderName(text: string, at: number): boolean {
  const first = text.charCodeAt(at) | 32;
  if (first !== 97 && first !== 112 && first !== 99 && first !== 115) {
    return false;
  }
  for (const name of GLUED_HEADER_NAMES) {
    if (!matchesAsciiIgnoreCase(text, at, name)) {
      continue;
    }
    // 可选的闭引号（前面可有转义反斜杠）；反斜杠后面不是引号时这一段不算。
    let cursor = at + name.length;
    let quote = cursor;
    while (text.charCodeAt(quote) === 92) {
      quote++;
    }
    const quoteCode = text.charCodeAt(quote);
    if (quoteCode === 34 || quoteCode === 39) {
      cursor = quote + 1;
    }
    while (text.charCodeAt(cursor) === 32 || text.charCodeAt(cursor) === 9) {
      cursor++;
    }
    if (text.charCodeAt(cursor) !== 58) {
      return false;
    }
    const after = text.charCodeAt(cursor + 1);
    return after === 32 || after === 9;
  }
  return false;
}

/**
 * at 处的头名是不是更长头名的后半段（Set-Cookie 里的 Cookie、Proxy-Authorization 里的 Authorization），并且那个
 * 更长的头名起点在凭据串之内（from 起）。这种位置不单独截断：更长头名的起点若在 from 之后，已经在那里截断过了。
 */
function continuesLongerHeaderName(text: string, from: number, at: number): boolean {
  const lower = (start: number, end: number): string => text.slice(start, end).toLowerCase();
  return (
    (at - 4 >= from && lower(at - 4, at) === 'set-' && lower(at, at + 6) === 'cookie') ||
    (at - 6 >= from && lower(at - 6, at) === 'proxy-' && lower(at, at + 13) === 'authorization')
  );
}

/**
 * 从 from 起的凭据 token：token68 字符与紧跟在 $ 之后、配平的 {…} 组（吸收 ${NAME:-默认值}），不跨行。
 * 不跟在 $ 后面的 { 是对象字面量（`Authorization: { scheme: 'bearer' }`），不是凭据，到此为止。返回结束位置。
 * 普通凭据字符逐字符前进、不设上限（超长凭据也要整段遮住）；花括号组的配平交给本次调用共享的配平器（每个位置
 * 只扫一次），组到行尾或窗口上限仍未闭合时不吸收（计入 unclosed-group 或 window-exceeded），凭据串在组前结束。
 * 遇到紧贴的下一个头名（或凭据起点本身就是头名）时截断（计入 glued-header），头名留给它自己的候选。
 */
function credentialRunEnd(
  text: string,
  from: number,
  sink: DetectorSink | undefined,
  scratch: DetectorScratch
): number {
  let index = from;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 123 && index > from && text.charCodeAt(index - 1) === 36) {
      const braces = scratch.headerBraces();
      const stop = braces.settle(index);
      if (stop !== STOP_CLOSED) {
        sink?.event(
          stop === STOP_WINDOW ? 'window-exceeded' : 'unclosed-group',
          'authorization-header'
        );
        break;
      }
      index = braces.endOf(index) + 1;
      continue;
    }
    if (!isCredentialCode(code)) {
      break;
    }
    // 凭据起点本身就是一个头名（值缺失，后面紧跟下一个头）时同样截断：凭据串为空，下一个头由它自己的候选处理。
    if (startsGluedHeaderName(text, index) && !continuesLongerHeaderName(text, from, index)) {
      sink?.event('glued-header', 'authorization-header');
      scratch.markGluedHeader(index);
      break;
    }
    index++;
  }
  return index;
}

/**
 * 带引号的值：opener 是 0 个或多个反斜杠加引号，闭合须是同样多反斜杠加同一引号。返回内层区间；不是引号时返回
 * null；到行尾或文本末尾仍未闭合（计入 unclosed-quote）、在 MAX_VALUE_SCAN 内找不到闭引号（计入 window-exceeded）
 * 时也返回 null，调用方按不带引号的值读（开引号本身结束这个值，值为空，不遮）。闭引号由本次调用共享的索引查找
 * （DetectorScratch.quoteClose，对数开销），候选再密集也不逐个向前扫窗口。
 */
function quotedValue(
  text: string,
  at: number,
  ruleId: string,
  sink: DetectorSink | undefined,
  scratch: DetectorScratch
): { inner: [number, number]; end: number } | null {
  let cursor = at;
  while (text.charCodeAt(cursor) === 92) {
    cursor++;
  }
  const quote = text.charCodeAt(cursor);
  if (quote !== 34 && quote !== 39) {
    return null;
  }
  const slashes = cursor - at;
  const innerStart = cursor + 1;
  const close = scratch.quoteClose(innerStart, quote, slashes);
  if (close.stop === 'closed') {
    return { inner: [innerStart, close.at - slashes], end: close.at + 1 };
  }
  // 到行尾或文本末尾仍未闭合（多半是截断的输出）计入 unclosed-quote；窗口触顶（闭引号可能在窗口之外）计入
  // window-exceeded。两者都按不带引号的值读。
  sink?.event(close.stop === 'window' ? 'window-exceeded' : 'unclosed-quote', ruleId);
  return null;
}

/**
 * 与正则 \s（非 unicode 模式）相同的空白判定，按码元逐个比较、不跑正则：ECMAScript 的 \s 是 WhiteSpace 加
 * LineTerminator——\t、\v、\f、U+FEFF、Unicode Zs 类（空格、U+00A0、U+1680、U+2000–U+200A、U+202F、U+205F、
 * U+3000），以及 \n、\r、U+2028、U+2029。与 /\s/ 在全部 65536 个码元上的逐个等价由测试钉住。非 ASCII 字符不再
 * 逐个跑正则，CJK 一类的长文本上建分隔字符位置表、扫长值都保持便宜。
 */
export function isRegexSpaceCode(code: number): boolean {
  if (code < 128) {
    return code === 32 || (code >= 9 && code <= 13);
  }
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** 不带引号的 auth-param 值的结束字符：与 /[\s,"'\\]/ 相同。 */
function endsParamValue(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return code === 44 || code === 34 || code === 39 || code === 92 || isRegexSpaceCode(code);
}

/** 不带引号的 cookie 值的结束字符：与 /[\s;,"'\\`]/ 相同。 */
function endsCookieValue(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return (
    code === 59 ||
    code === 44 ||
    code === 34 ||
    code === 39 ||
    code === 92 ||
    code === 96 ||
    isRegexSpaceCode(code)
  );
}

function skipBlanks(text: string, from: number): number {
  let index = from;
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) {
    index++;
  }
  return index;
}

/** 值的取舍：空值、纯引用占位（计入 reference-skip）、没有字母数字的值（计入 rejected）不是凭据，其余是。 */
function isCredentialValue(
  text: string,
  start: number,
  end: number,
  ruleId: string,
  sink: DetectorSink | undefined
): boolean {
  if (end <= start) {
    return false;
  }
  // 纯引用占位只能以 $、{、% 开头（PURE_REFERENCE 的全部分支）：其余值不切片、不跑正则，密集短值上省掉逐值分配。
  const first = text.charCodeAt(start);
  if ((first === 36 || first === 123 || first === 37) && isPureReference(text.slice(start, end))) {
    sink?.event('reference-skip', ruleId);
    return false;
  }
  for (let index = start; index < end; index++) {
    const code = text.charCodeAt(index);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      return true;
    }
  }
  // 没有任何字母数字（$、***、...）：不是凭据（多半是占位或已经打码），否决。
  sink?.event('rejected', ruleId);
  return false;
}

/** 单个值的区间：是凭据时返回 [[start, end]]，否则为空（事件见 isCredentialValue）。 */
function valueSpan(
  text: string,
  start: number,
  end: number,
  ruleId: string,
  sink: DetectorSink | undefined
): Array<[number, number]> {
  return isCredentialValue(text, start, end, ruleId, sink) ? [[start, end]] : [];
}

/**
 * name=value 列表（auth-param、Cookie）的整段区间：从第一个值是凭据的那一对的名字起，到最后一个值是凭据的那一对的
 * 值末尾（带引号的值含闭引号）止，中间的名字、分隔符与非凭据值一并遮住，整段只写一个标记。逐值打标记时，密集
 * 的短值（a=b; a=b; …）把输出放大到约 4 倍，标记里的关键字又让不动点轮的历史版本在放大后的文本上慢得多（第三轮
 * 复查阻塞）；整段遮住时标记个数与头的个数相同，输出不再膨胀。这只会多遮（不变量 A），名字不是秘密，多遮的代价
 * 只是展示可读性。
 */
class ListCover {
  private first = -1;
  private last = -1;

  add(pairStart: number, valueEnd: number): void {
    if (this.first < 0) {
      this.first = pairStart;
    }
    this.last = valueEnd;
  }

  spans(): Array<[number, number]> {
    return this.first < 0 ? [] : [[this.first, this.last]];
  }
}

/** auth-param 的参数名 [A-Za-z][A-Za-z0-9_-]* 从 from 起的结束位置（不是参数名时等于 from）。 */
function paramNameEnd(text: string, from: number): number {
  const first = text.charCodeAt(from);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) {
    return from;
  }
  let index = from + 1;
  while (index < text.length && isWordishCode(text.charCodeAt(index))) {
    index++;
  }
  return index;
}

/**
 * auth-param 列表（Digest、AWS4-HMAC-SHA256、OAuth 1.0 …）：方案名之后的参数列表整段遮住（见 ListCover：从第一个
 * 值是凭据的参数名起到最后一个凭据值止），方案名保留。
 */
function authParamSpans(
  text: string,
  from: number,
  ruleId: string,
  sink: DetectorSink | undefined,
  scratch: DetectorScratch
): Array<[number, number]> {
  const cover = new ListCover();
  let cursor = from;
  // 参数列表逐个前进（线性），不设总长上限：长参数列表后面的值也要遮住。
  const limit = text.length;
  while (cursor < limit) {
    cursor = skipBlanks(text, cursor);
    const pairStart = cursor;
    // 参数名逐字符扫描（不切固定窗口：超长参数名后面的值也要遮住）。
    const nameEnd = paramNameEnd(text, cursor);
    if (nameEnd === cursor) {
      break;
    }
    cursor = skipBlanks(text, nameEnd);
    if (text[cursor] !== '=') {
      break;
    }
    cursor = skipBlanks(text, cursor + 1);
    const quoted = quotedValue(text, cursor, ruleId, sink, scratch);
    if (quoted !== null) {
      if (isCredentialValue(text, quoted.inner[0], quoted.inner[1], ruleId, sink)) {
        cover.add(pairStart, quoted.end);
      }
      cursor = quoted.end;
    } else {
      // 不带引号的参数值：到空白、逗号、引号或反斜杠为止（允许 ;，例如 SignedHeaders=host;x-amz-date）。
      let end = cursor;
      while (end < limit && !endsParamValue(text, end)) {
        end++;
      }
      if (isCredentialValue(text, cursor, end, ruleId, sink)) {
        cover.add(pairStart, end);
      }
      cursor = end;
    }
    cursor = skipBlanks(text, cursor);
    if (text[cursor] !== ',') {
      break;
    }
    cursor++;
  }
  return cover.spans();
}

/** 头名之后的可选开引号（可带转义反斜杠，或反引号）。返回跳过开引号后的位置。 */
function afterOpener(text: string, from: number): number {
  let cursor = from;
  while (text.charCodeAt(cursor) === 92) {
    cursor++;
  }
  const char = text[cursor];
  if (char === '"' || char === "'" || char === '`') {
    return cursor + 1;
  }
  return from;
}

const AUTH_HEADER_RULE: DetectorRule = {
  id: 'authorization-header',
  tier: 'T1',
  kind: 'auth-header',
  sources: ALL_DETECTOR_SOURCES,
  marker: '[redacted-token]',
  // 候选正则大小写不敏感（/i，非 unicode 模式只折叠 ASCII 大小写），预过滤写成等价的显式字符类。
  prefilter: /[Zz](?<=[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz])[Aa][Tt][Ii][Oo][Nn]/,
  // 头名（可带 JSON / 字典键的闭引号）+ 冒号；值在 locate 里解析。只认 HTTP 头语法的冒号，= 形态由底线的键规则负责。
  pattern: /(?:proxy-)?authorization(?:\\*["'])?[ \t]*:[ \t]*/gi,
  locate(text, match, sink, scratch) {
    // 紧贴在上一个凭据串之后、被截断出来的头名也算左边界（它不是标识符的一部分）。
    if (!leftBoundaryAt(text, match.index) && !scratch.isGluedHeader(match.index)) {
      return [];
    }
    const valueStart = afterOpener(text, match.index + match[0].length);
    const credentialStart = authSchemeEnd(text, valueStart);
    if (credentialStart >= 0) {
      if (startsAuthParam(text, credentialStart)) {
        return authParamSpans(text, credentialStart, 'authorization-header', sink, scratch);
      }
      const end = credentialRunEnd(text, credentialStart, sink, scratch);
      return valueSpan(text, credentialStart, end, 'authorization-header', sink);
    }
    // 没有方案名：整个值就是凭据（例如 GitHub 的 Authorization: <token>）；单独的方案名不是凭据。
    const end = credentialRunEnd(text, valueStart, sink, scratch);
    if (BARE_SCHEME_WORD.test(text.slice(valueStart, end))) {
      // 值只有方案名（后面没有凭据，多半截断在方案名处）：候选被否决，计入 rejected（只计数，不含正文）。
      sink?.event('rejected', 'authorization-header');
      return [];
    }
    return valueSpan(text, valueStart, end, 'authorization-header', sink);
  },
  examples: [
    { text: `Authorization: Token ${credential}`, secrets: [credential] },
    { text: `> Proxy-Authorization: Basic ${basicCredential}`, secrets: [basicCredential] },
    { text: `{"Authorization":"ApiKey ${credential}"}`, secrets: [credential] },
    { text: `authorization: ${credential}`, secrets: [credential] },
    {
      text: join(
        'Authorization',
        ': Digest username="svc", nonce="',
        urlPassword,
        '", response="',
        credential,
        '"'
      ),
      secrets: [urlPassword, credential],
    },
    {
      text: join(
        'Authorization',
        ': AWS4-HMAC-SHA256 Credential=',
        awsKeyId,
        '/20261021/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=',
        credential
      ),
      secrets: [awsKeyId, credential],
    },
    {
      text: join('curl -H "Authorization: Bearer $', '{API_TOKEN:-', credential, '}" https://api'),
      secrets: [credential],
    },
  ],
  negativeExamples: [
    'the Authorization header is required',
    'req.setHeader("Authorization", header);',
    join('curl -H "Authorization: Bearer $', '{API_TOKEN}" https://api.example'),
  ],
};

// =============================================================================================
// Cookie / Set-Cookie
// =============================================================================================

/** RFC 6265 cookie-name 的常见字符：字母数字与 ! # $ % & * + . ^ _ | ~ -。 */
function isCookieNameCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 33 ||
    code === 35 ||
    code === 36 ||
    code === 37 ||
    code === 38 ||
    code === 42 ||
    code === 43 ||
    code === 46 ||
    code === 94 ||
    code === 95 ||
    code === 124 ||
    code === 126 ||
    code === 45
  );
}

const COOKIE_HEADER_RULE: DetectorRule = {
  id: 'cookie-header',
  tier: 'T1',
  kind: 'cookie-header',
  sources: ALL_DETECTOR_SOURCES,
  marker: '[redacted-token]',
  prefilter: /[Kk](?<=[Cc][Oo][Oo][Kk])[Ii][Ee]/,
  pattern: /(?:set-)?cookie(?:\\*["'])?[ \t]*:[ \t]*/gi,
  locate(text, match, sink, scratch) {
    if (!leftBoundaryAt(text, match.index) && !scratch.isGluedHeader(match.index)) {
      return [];
    }
    // Cookie 头的 cookie 列表整段遮住（无法判断哪个 cookie 敏感；见 ListCover：从第一个值是凭据的 cookie 名起到最后
    // 一个凭据值止，整段一个标记）。Set-Cookie 只有第一对是 cookie，只遮它的值，其后的 Path、Expires、HttpOnly
    // 等属性保留。
    // 候选以 set- 或 cookie 开头（大小写不敏感），首字母是 s 即 Set-Cookie。
    const single = (text.charCodeAt(match.index) | 32) === 115;
    const cover = new ListCover();
    const spans: Array<[number, number]> = [];
    let cursor = afterOpener(text, match.index + match[0].length);
    // cookie 对逐个前进（线性），不设总长上限：超长 Cookie 头后面的值也要遮住。
    const limit = text.length;
    while (cursor < limit) {
      cursor = skipBlanks(text, cursor);
      const pairStart = cursor;
      // cookie 名逐字符扫描（不切固定窗口：超长 cookie 名后面的值也要遮住）。
      let nameEnd = cursor;
      while (nameEnd < limit && isCookieNameCode(text.charCodeAt(nameEnd))) {
        nameEnd++;
      }
      if (nameEnd === cursor) {
        break;
      }
      cursor = skipBlanks(text, nameEnd);
      if (text[cursor] !== '=') {
        break;
      }
      cursor = skipBlanks(text, cursor + 1);
      const quoted = quotedValue(text, cursor, 'cookie-header', sink, scratch);
      // 带引号的 cookie 值（RFC 6265 允许 DQUOTE 包裹）：内层只能是 cookie-octet，含空白、分号、逗号时
      // 说明这个引号其实是外层载体的引号，按不带引号的值处理（值为空，不遮），计入 carrier-quote。分隔字符的
      // 判定走本次调用共享的位置索引，不逐候选扫内层。
      const carrierQuote =
        quoted !== null && scratch.hasCookieSeparator(quoted.inner[0], quoted.inner[1]);
      if (carrierQuote) {
        sink?.event('carrier-quote', 'cookie-header');
      }
      let valueStart = cursor;
      let valueEnd: number;
      let pairEnd: number;
      if (quoted !== null && !carrierQuote) {
        [valueStart, valueEnd] = quoted.inner;
        pairEnd = quoted.end;
      } else {
        valueEnd = cursor;
        while (valueEnd < limit && !endsCookieValue(text, valueEnd)) {
          valueEnd++;
        }
        pairEnd = valueEnd;
      }
      cursor = pairEnd;
      if (isCredentialValue(text, valueStart, valueEnd, 'cookie-header', sink)) {
        if (single) {
          spans.push([valueStart, valueEnd]);
        } else {
          cover.add(pairStart, pairEnd);
        }
      }
      if (single) {
        break;
      }
      cursor = skipBlanks(text, cursor);
      if (text[cursor] !== ';') {
        break;
      }
      cursor++;
    }
    return single ? spans : cover.spans();
  },
  examples: [
    {
      text: join('Cookie', ': theme=dark; session=', credential, '; lang=en'),
      secrets: [credential],
    },
    { text: `< Set-Cookie: sid=${urlPassword}; Path=/; HttpOnly`, secrets: [urlPassword] },
    { text: `{"cookie":"sid=${credential}"}`, secrets: [credential] },
  ],
  negativeExamples: [
    'document.cookie = "theme=dark";',
    'Set-Cookie: header is optional',
    join('Cookie: session=$', '{SESSION_ID}'),
  ],
};

// =============================================================================================
// URL userinfo 口令段
// =============================================================================================

/** 不配平读法（花括号组不配平时的退回）：从 from 起到第一个停止字符，{ } 都当普通字符。 */
function plainAuthority(text: string, from: number): AuthorityScan {
  let colon = -1;
  let at = -1;
  let index = from;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (isAuthorityStop(code)) {
      break;
    }
    if (code === 58 && colon < 0) {
      colon = index;
    } else if (code === 64) {
      at = index;
    }
    index++;
  }
  return { colon, at, end: index, open: false, truncatedInGroup: false, windowExceeded: false };
}

/** 截断形态：口令段没有 @，可见部分之内或之后紧跟截断标记；返回可见口令的结束位置，或 -1。 */
function truncatedPasswordEnd(
  text: string,
  from: number,
  end: number,
  scratch: DetectorScratch
): number {
  const inside = scratch.firstTruncationIn(from, end);
  if (inside >= 0) {
    return inside;
  }
  return truncationFollows(text, end) ? end : -1;
}

function userinfoSpans(
  text: string,
  scan: AuthorityScan,
  scratch: DetectorScratch
): Array<[number, number]> {
  if (scan.colon < 0) {
    return [];
  }
  if (scan.at > scan.colon) {
    return scan.at > scan.colon + 1 ? [[scan.colon + 1, scan.at]] : [];
  }
  if (scan.at >= 0) {
    // 冒号在最后一个 @ 之后：那是端口（user@host:8080），不是口令。
    return [];
  }
  const visibleEnd = scan.truncatedInGroup
    ? scan.end
    : truncatedPasswordEnd(text, scan.colon + 1, scan.end, scratch);
  if (visibleEnd <= scan.colon + 1) {
    return [];
  }
  // 纯数字是端口（host:8080…），不是口令。
  if (scratch.isDigitRun(scan.colon + 1, visibleEnd)) {
    return [];
  }
  return [[scan.colon + 1, visibleEnd]];
}

/** scheme 的最大长度：往回找 scheme 起点时最多看这么多字符（避免长标识符退化成平方级）。 */
const MAX_SCHEME_LENGTH = 40;

function isSchemeCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 ||
    code === 46 ||
    code === 45
  );
}

/**
 * `://` 前面的 scheme：最长的 [A-Za-z0-9+.-] 串，以字母开头（与 v3 的左边界口径一致）。返回 ok、none（不是
 * scheme），或 too-long（超过 MAX_SCHEME_LENGTH，不当作 URL 候选，由调用方计入 window-exceeded）。
 */
function schemeBefore(text: string, colonIndex: number): 'ok' | 'none' | 'too-long' {
  let start = colonIndex;
  while (start > 0 && isSchemeCode(text.charCodeAt(start - 1))) {
    start--;
    if (colonIndex - start > MAX_SCHEME_LENGTH) {
      return 'too-long';
    }
  }
  if (start === colonIndex) {
    return 'none';
  }
  const first = text.charCodeAt(start);
  return (first >= 65 && first <= 90) || (first >= 97 && first <= 122) ? 'ok' : 'none';
}

const URL_USERINFO_RULE: DetectorRule = {
  id: 'url-userinfo',
  tier: 'T1',
  kind: 'url-userinfo',
  sources: ALL_DETECTOR_SOURCES,
  marker: '[redacted]',
  prefilter: /:(?:\\*\/){2}/,
  // 以字面 :// 开头（含载体里的 :\/\/），scheme 在 locate 里往回有界查找，避免对长单词逐位置回溯。
  pattern: /:(?:\\*\/){2}/g,
  locate(text, match, sink, scratch) {
    const scheme = schemeBefore(text, match.index);
    if (scheme !== 'ok') {
      if (scheme === 'too-long') {
        // scheme 超长：不当作 URL 候选（往回查找有上限，保证线性），计入窗口触顶。
        sink?.event('window-exceeded', 'url-userinfo');
      }
      return [];
    }
    const from = match.index + match[0].length;
    const balanced = scratch.authorityChain(from);
    if (balanced.windowExceeded) {
      sink?.event('window-exceeded', 'url-userinfo');
    }
    const spans = userinfoSpans(text, balanced, scratch);
    if (balanced.open && !balanced.truncatedInGroup) {
      // 花括号到行尾（或窗口上限、文本末尾）仍未配平：按不配平读法再扫一次，两种读法的区间取并集（只会多遮）。
      sink?.event('unbalanced-fallback', 'url-userinfo');
      const plain = userinfoSpans(text, plainAuthority(text, from), scratch);
      spans.push(...plain);
      if (plain.length === 0 && balanced.colon >= 0 && balanced.at < 0) {
        // 不配平读法也找不到口令段，而未闭合的组一直延伸到读法结束：冒号之后的整段都可能是口令
        // （例如截断在行尾、没有截断标记的 $\{DB_PASS:-…），整段遮住。
        spans.push([balanced.colon + 1, balanced.end]);
      }
    } else if (balanced.truncatedInGroup || (balanced.at < 0 && spans.length > 0)) {
      sink?.event('truncated', 'url-userinfo');
    }
    return spans;
  },
  examples: [
    { text: `postgres://app:${urlPassword}@db.internal:5432/app`, secrets: [urlPassword] },
    {
      text: join('DATABASE_URL: postgres://app:$', '{DB_PASS:-', urlPassword, '/x?y#z}@db/app'),
      secrets: [join(urlPassword, '/x?y#z')],
    },
    {
      text: join('postgres://$', '{DB_USER:-admin}:$', '{DB_PASS:-', urlPassword, '}@db/app'),
      secrets: [urlPassword],
    },
    {
      text: join(
        'git clone https://x-access-token:$',
        '{{ secrets.GITHUB_TOKEN }}@github.com/o/r.git'
      ),
      secrets: ['secrets.GITHUB_TOKEN'],
    },
    { text: `mongodb+srv://svc:${urlPassword}@cluster0.example.net/db`, secrets: [urlPassword] },
    {
      text: join('{"stdout":"clone https:', '\\/\\/deploy:', urlPassword, '@git.example.com\\/x'),
      secrets: [urlPassword],
    },
    {
      text: join('redis://:', urlPassword.slice(0, 10), '... [truncated]'),
      secrets: [urlPassword.slice(0, 10)],
    },
    {
      text: join('postgres://app:$', '{DB_PASS:-', urlPassword, '@db/app'),
      secrets: [urlPassword],
    },
  ],
  negativeExamples: [
    'see https://user@example.com/x and http://localhost:3000/a?b=c',
    'https://example.com:8080/path',
    'jdbc:postgresql://db.internal:5432/app',
  ],
};

// =============================================================================================
// Azure SAS 签名（无 userinfo 的 sig= 尾段；阶段 1 复查列出的四版共漏写法）
// =============================================================================================

const AZURE_SAS_RULE: DetectorRule = {
  id: 'azure-sas-signature',
  tier: 'T1',
  kind: 'url-signature',
  sources: ALL_DETECTOR_SOURCES,
  marker: '[redacted-token]',
  prefilter: /=(?<=sig=)/,
  pattern: /sig=([A-Za-z0-9%+/=_-]{8,})/g,
  locate(text, match, sink, scratch) {
    const before = text[match.index - 1];
    if (before !== '?' && before !== '&' && before !== ';') {
      return [];
    }
    // 同一 URL 片段（到空白、引号、尖括号、反引号或反斜杠为止）里要有 sv= 版本参数；片段边界与判定按片段缓存，
    // 同一片段里的密集 sig= 候选不再各扫一遍窗口。
    if (!scratch.sasVersionAround(match.index)) {
      // 没有 sv= 版本参数：不是 Azure SAS（普通的 sig 查询参数），否决。
      sink?.event('rejected', 'azure-sas-signature');
      return [];
    }
    return [[match.index + 4, match.index + match[0].length]];
  },
  examples: [
    {
      text: `url https://acct.blob.core.windows.net/c/f.txt?sv=2022-11-02&sp=r&sig=${sasSignature}`,
      secrets: [sasSignature],
    },
    {
      text: `BlobEndpoint=https://acct.blob.core.windows.net/;SharedAccessSignature=sv=2022-11-02&ss=b&sig=${sasSignature}&se=2026-12-31`,
      secrets: [sasSignature],
    },
    { text: `"?sv=2022-11-02&ss=b&srt=sco&sig=${sasSignature}"`, secrets: [sasSignature] },
  ],
  negativeExamples: [
    'https://example.com/api?sig=hello-world-123',
    'https://acct.blob.core.windows.net/c/f.txt?sv=2022-11-02&sp=r',
    'const sig = computeSignature(sv);',
  ],
};

// =============================================================================================
// 规则表与入口
// =============================================================================================

/** T1 检测规则表（只增：新规则追加在后，已有规则不删不放宽）。顺序也是同一区间多条规则时标记的选择顺序。 */
export const T1_DETECTOR_RULES: readonly DetectorRule[] = Object.freeze([
  ...PREFIXED_TOKEN_SPECS.map(prefixedTokenRule),
  JWT_RULE,
  AUTH_HEADER_RULE,
  COOKIE_HEADER_RULE,
  URL_USERINFO_RULE,
  AZURE_SAS_RULE,
]);

/**
 * 合并预过滤：找出全文里有触发形态的规则（其余规则精确跳过）。用“尚未出现的规则的预过滤之并”从左往右扫：每次
 * 得到最左的触发位置与在那里命中的那条规则（并集里每条规则一个捕获组），把它记为出现，再从同一位置起用剩下规则的
 * 并集继续扫（同一位置可能还有别的规则命中）。各次扫描的区间首尾相接，整体只扫一遍全文；干净文本只付一次失败的
 * 扫描。并集正则每次调用另建实例（引擎按 source 缓存编译结果），模块里不留有状态的正则。
 */
function presentRules(text: string): Uint8Array {
  const present = new Uint8Array(T1_DETECTOR_RULES.length);
  let remaining = T1_DETECTOR_RULES.map((_, index) => index);
  let from = 0;
  while (remaining.length > 0) {
    const union = new RegExp(
      remaining
        .map((index) => `(${T1_DETECTOR_RULES[index]?.prefilter.source ?? '(?!)'})`)
        .join('|'),
      'g'
    );
    union.lastIndex = from;
    const match = union.exec(text);
    if (match === null) {
      break;
    }
    let group = 1;
    while (group < match.length && match[group] === undefined) {
      group++;
    }
    const found = remaining[group - 1];
    if (found === undefined) {
      // 不会发生（命中必然来自某个捕获组）；保守起见把剩下的规则都当作出现，只会多跑候选扫描，不会漏。
      for (const index of remaining) {
        present[index] = 1;
      }
      break;
    }
    present[found] = 1;
    remaining = remaining.filter((index) => index !== found);
    from = match.index;
  }
  return present;
}

/**
 * 区间是否恰好是输入里已有的一个完整标记（多半是上一轮写出的，例如不动点轮里 URL 口令段的 [redacted]）。
 * 标记只会原样渲染，遮它不改变输出；在这里跳过，省掉区间对象与挂点的逐位检查（legacyFloor 仍对由多个标记
 * 拼成的区间做同样的精确跳过）。
 */
function isWholeMarker(text: string, start: number, end: number): boolean {
  return text.charCodeAt(start) === 91 && coreMarkerLengthAt(text, start) === end - start;
}

/**
 * T1 检测入口（legacyFloor 的默认检测器）：在原文上返回全部要遮住的区间与标记。区间可能重叠，由调用方取并集。
 * 纯函数；sink 只接收计数事件。
 */
export function detectT1Spans(text: string, sink?: DetectorSink): DetectorSpan[] {
  const spans: DetectorSpan[] = [];
  const present = presentRules(text);
  // 本次调用私有的扫描上下文：跨候选共享配平与记忆化，调用结束即丢弃。
  const scratch = new DetectorScratch(text);
  for (const [ruleIndex, rule] of T1_DETECTOR_RULES.entries()) {
    if (present[ruleIndex] !== 1) {
      // 预过滤短路：全文不含本规则的触发字面量，候选正则不可能命中（精确，不是放行），只计数。
      sink?.event('prefilter-skip', rule.id);
      continue;
    }
    const scanner = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
      let furthest = scanner.lastIndex;
      for (const [start, end] of rule.locate(text, match, sink, scratch)) {
        if (end <= start) {
          continue;
        }
        furthest = Math.max(furthest, end);
        if (isWholeMarker(text, start, end)) {
          sink?.event('already-masked', rule.id);
          continue;
        }
        spans.push({ start, end, marker: rule.marker, ruleId: rule.id });
      }
      // 已遮住的值不再作为同一规则的候选起点重扫（例如超长凭据里又出现头名）：总开销保持线性。
      scanner.lastIndex = match[0].length === 0 ? furthest + 1 : furthest;
    }
  }
  return spans;
}

/** 只跑一条规则（规则表正反例校验用）。 */
export function detectWithRule(
  rule: DetectorRule,
  text: string,
  sink?: DetectorSink
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (!rule.prefilter.test(text)) {
    return spans;
  }
  const scanner = new RegExp(rule.pattern.source, rule.pattern.flags);
  const scratch = new DetectorScratch(text);
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
    let furthest = scanner.lastIndex;
    for (const [start, end] of rule.locate(text, match, sink, scratch)) {
      if (end > start) {
        spans.push([start, end]);
        furthest = Math.max(furthest, end);
      }
    }
    scanner.lastIndex = match[0].length === 0 ? furthest + 1 : furthest;
  }
  return spans;
}

/** 规则表本身的问题描述（空数组表示通过）。由测试在 CI 里强制执行（设计：规则正反例在构建期强制校验）。 */
export function validateDetectorTable(
  rules: readonly DetectorRule[] = T1_DETECTOR_RULES
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) {
      problems.push(`duplicate rule id ${rule.id}`);
    }
    ids.add(rule.id);
    if (!rule.pattern.flags.includes('g')) {
      problems.push(`${rule.id}: candidate pattern must be global`);
    }
    if (rule.prefilter.flags !== '') {
      // 预过滤按 source 并入合并扫描：带标志会改变语义（例如 i），带 g / y 还会读写 lastIndex。
      problems.push(`${rule.id}: prefilter must carry no flags`);
    }
    if ((new RegExp(`${rule.prefilter.source}|`).exec('')?.length ?? 1) !== 1) {
      // 合并扫描按捕获组序号认规则：预过滤自身不能有捕获组。
      problems.push(`${rule.id}: prefilter must have no capturing groups`);
    }
    // 预过滤必须是候选的必要条件：正反例里的每个候选文本都要被它命中，否则短路会漏掉候选。
    for (const text of [
      ...rule.examples.map((example) => example.text),
      ...rule.negativeExamples,
    ]) {
      const scanner = new RegExp(rule.pattern.source, rule.pattern.flags);
      for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
        if (!rule.prefilter.test(match[0])) {
          problems.push(`${rule.id}: a candidate is not admitted by the prefilter`);
        }
        if (match[0].length === 0) {
          scanner.lastIndex++;
        }
      }
    }
    if (ALL_DETECTOR_SOURCES.some((source) => !rule.sources.includes(source))) {
      problems.push(`${rule.id}: T1 rules apply to every source`);
    }
    for (const [index, example] of rule.examples.entries()) {
      if (!rule.prefilter.test(example.text)) {
        problems.push(`${rule.id} example ${index}: prefilter does not admit the example`);
      }
      const covered = new Uint8Array(example.text.length);
      for (const [start, end] of detectWithRule(rule, example.text)) {
        covered.fill(1, start, end);
      }
      if (example.secrets.length === 0) {
        problems.push(`${rule.id} example ${index}: no secret declared`);
      }
      for (const secret of example.secrets) {
        let from = example.text.indexOf(secret);
        if (from < 0) {
          problems.push(`${rule.id} example ${index}: secret not present in the text`);
        }
        while (from >= 0) {
          for (let offset = 0; offset < secret.length; offset++) {
            if (covered[from + offset] !== 1) {
              problems.push(`${rule.id} example ${index}: secret not fully covered`);
              break;
            }
          }
          from = example.text.indexOf(secret, from + 1);
        }
      }
    }
    for (const [index, negative] of rule.negativeExamples.entries()) {
      const hits = detectT1Spans(negative);
      if (hits.length > 0) {
        problems.push(
          `${rule.id} negative ${index}: table produced spans (${hits.map((hit) => hit.ruleId).join(',')})`
        );
      }
    }
  }
  return problems;
}
