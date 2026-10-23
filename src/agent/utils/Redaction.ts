/**
 * 开发者文本与台账内容的脱敏入口。只处理已知凭据形态/敏感键的值，业务回执不在此改写。
 * 保留非敏感字节及换行；台账 freshness 使用同一入口，不能为了清理JSON而重排整个文档。
 *
 * 本函数事实上是证据台账哈希规范的一部分：EvidenceLedgerStore 落盘与 checkFreshness 重算都经过这里。
 * 规则变更后，升级时在途 job 中受影响的旧条目会被判 stale（EVIDENCE_STALE 提示重采），不会丢数据。
 *
 * 零回退底线（设计 redaction-design-2026-10-19，用户决定 D1/D2/D3）：redactDeveloperText 只是门面。
 * 阶段 4 起规则不再在这里演进：HEAD 现行规则（b60a61e）已原样冻结为 redaction/frozenBaselines.ts 的 v3，
 * 门面流程是 redaction/legacyFloor.ts 的 Floor（四个历史版本 246055e、1b394ce、d113986、b60a61e 的追踪重放
 * 遮蔽位置之并，运行时自检）→ redaction/render.ts 按位置渲染一次 → 不动点。任一历史版本遮住的非结构字符
 * 在这里仍被遮住，所以现行规则为减少误伤而放行的写法（比较运算、箭头函数、类型注解、case 标签、三元
 * 表达式等）只要历史版本遮过，输出里仍会被遮（D2 接受的代价）；需要逐字源码的消费者由阶段 2、3 改走回读
 * 或见证通道，而不是放宽这里的检测。检测器通过 legacyFloor 的检测器挂点在原文上追加区间，与 Floor 取并集，
 * 不串接：阶段 4b 起默认挂上 redaction/detectors.ts 的 T1 高置信格式层（带固定前缀的 token、JWT、认证头与
 * Cookie、URL userinfo 口令段、Azure SAS 签名），只会多遮（不变量 A），标记沿用封闭词表；底线已遮住的区间
 * 不再并入，检测器只在它真正多遮的地方改变输出；底线没遮住的 v0/v1 级联触发前缀（关键字 + 分隔符）不并入
 * 检测区间，不动点轮里的级联遮蔽照常发生，所以不变量 A 在门面层（多轮之后）也成立。后续包（4c–4e）只往
 * 默认检测器表里追加。门面签名与调用点不变，不从任何 index 转出。
 *
 * 按来源追加（阶段 4e，T3）：redactDeveloperText 是未知来源（开发者事件、诊断、stderr 共 16 个调用点）；
 * 证据台账经 redactDeveloperTextInContext 带上条目来源（tool/file），在未知来源底线（含 T1 默认检测器）之上追加
 * T3 规则（redaction/sourcePolicy.ts）。两条入口共用 unknownSourceFloorOptions，所以任何来源下的遮蔽都 ⊇ 未知
 * 来源下的遮蔽（不变量 A）；source、config、no-file 来源没有 T3 规则，输出与 redactDeveloperText 逐字相同。
 */

import {
  applyRedactionFloor,
  type FloorReport,
  type RedactionFloorOptions,
} from './redaction/legacyFloor.js';
import {
  applySourcePolicyFloor,
  applySourcePolicyFloorWithProvenance,
  type RedactionSourceContext,
  type SourcePolicyProvenanceResult,
  type SourcePolicyResult,
} from './redaction/sourcePolicy.js';

/**
 * 未知来源的底线选项：redactDeveloperText 与按来源入口共用的唯一一处。空选项即 legacyFloor 的默认检测器表
 * DEFAULT_FLOOR_DETECTORS（阶段 4b 的 T1；与来源无关的检测器 4c–4d 只往默认表追加），按来源入口原样继承、
 * 不替换它，所以不变量 A 的比较对象一致。
 */
function unknownSourceFloorOptions(): RedactionFloorOptions {
  return {};
}

/** 开发者文本脱敏（签名不变）：四个历史版本的追踪重放底线 ∪ T1 检测器区间 + 按位置渲染，迭代到不动点。 */
export function redactDeveloperText(text: string): string {
  return applyRedactionFloor(text, unknownSourceFloorOptions()).text;
}

/**
 * 内部纯函数：返回脱敏文本与底线报告。报告只含计数与事件种类（各版本遮住的字符数、缺口复用与新标记的区间数、
 * 放回的换行记号数、自检失败即关的 [redacted-unaligned] 行、不动点触顶、各检测规则的命中数与否决、引用跳过、
 * 花括号失配回退、截断命中、已遮与底线已覆盖的跳过等），不含任何正文，供有日志通道的调用方记录诊断。不从任何
 * index 转出。
 */
export function redactDeveloperTextWithReport(text: string): {
  text: string;
  report: FloorReport;
} {
  return applyRedactionFloor(text, unknownSourceFloorOptions());
}

/**
 * 台账内容脱敏（内部，供 ProductionEvidenceLedgerAuthority 注入默认 profile）：未知来源底线之上按条目来源追加 T3。
 * context 缺省或来源没有 T3 规则时与 redactDeveloperText 逐字相同。不从任何 index 转出。
 */
export function redactDeveloperTextInContext(
  text: string,
  context?: RedactionSourceContext
): string {
  return applySourcePolicyFloor(text, context, unknownSourceFloorOptions()).text;
}

/** 同 redactDeveloperTextInContext，另返回底线报告与来源策略报告（只含计数与种类，不含正文）。 */
export function redactDeveloperTextInContextWithReport(
  text: string,
  context?: RedactionSourceContext
): SourcePolicyResult {
  return applySourcePolicyFloor(text, context, unknownSourceFloorOptions());
}

/** 测试期 oracle 用：同上，另返回最终输出到原始输入的逐字符来源。 */
export function redactDeveloperTextInContextWithProvenance(
  text: string,
  context?: RedactionSourceContext
): SourcePolicyProvenanceResult {
  return applySourcePolicyFloorWithProvenance(text, context, unknownSourceFloorOptions());
}
