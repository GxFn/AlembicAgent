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
 * 或见证通道，而不是放宽这里的检测。后续检测器（阶段 4b–4e）通过 legacyFloor 的检测器挂点在原文上追加区间，
 * 与 Floor 取并集，不串接。
 */

import { applyRedactionFloor, type FloorReport } from './redaction/legacyFloor.js';

/** 开发者文本脱敏（签名不变）：四个历史版本的追踪重放底线 + 按位置渲染，迭代到不动点。 */
export function redactDeveloperText(text: string): string {
  return applyRedactionFloor(text).text;
}

/**
 * 内部纯函数：返回脱敏文本与底线报告。报告只含计数与事件种类（各版本遮住的字符数、缺口复用与新标记的区间数、
 * 放回的换行记号数、自检失败即关的 [redacted-unaligned] 行、不动点触顶等），不含任何正文，供有日志通道的
 * 调用方记录诊断。不从任何 index 转出。
 */
export function redactDeveloperTextWithReport(text: string): {
  text: string;
  report: FloorReport;
} {
  return applyRedactionFloor(text);
}
