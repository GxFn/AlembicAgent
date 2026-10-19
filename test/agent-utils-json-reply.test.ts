import { describe, expect, it } from 'vitest';
import { parseJsonObjectWithDiagnostics } from '../src/agent/utils/jsonReply.js';

// L8-P10 / L8-C07：关系发现与翻译共用的 JSON 对象解析器。级联顺序固定为
// 代码块 → 全文 → 从首个 { 括号配平；失败时只给出策略与错误类别，不回显回复正文。
describe('parseJsonObjectWithDiagnostics (L8-P10)', () => {
  it('parses a fenced code block first', () => {
    const reply = '说明如下：\n```json\n{"analyzed":1,"relations":[]}\n```\n以上。';
    expect(parseJsonObjectWithDiagnostics(reply)).toEqual({
      value: { analyzed: 1, relations: [] },
      strategy: 'code-block',
      replyLength: reply.length,
    });
  });

  it('accepts a fence without a language tag and skips an invalid earlier fence', () => {
    const reply = '```\nnot json\n```\n然后\n```\n{"ok":true}\n```';
    expect(parseJsonObjectWithDiagnostics(reply)).toMatchObject({
      value: { ok: true },
      strategy: 'code-block',
      recoveredFrom: 'code-block=SyntaxError',
    });
  });

  it('parses the whole trimmed reply when there is no fence', () => {
    const outcome = parseJsonObjectWithDiagnostics('  {"summaryEn":"s"}\n');
    expect(outcome).toMatchObject({ value: { summaryEn: 's' }, strategy: 'full-text' });
    expect(outcome).not.toHaveProperty('recoveredFrom');
  });

  it('extracts the first balanced object when prose and later braces surround it', () => {
    const reply =
      '结果：{"analyzed":2,"relations":[{"from":"A","to":"B","type":"uses","evidence":"x { y"}]} 备注 {注}';
    const outcome = parseJsonObjectWithDiagnostics(reply);
    expect(outcome.strategy).toBe('balanced-object');
    expect(outcome.parseError).toBeUndefined();
    // 级联回退命中：记录被跳过的失败尝试，供调用方记 info 日志。
    expect(outcome.recoveredFrom).toBe('full-text=SyntaxError');
    expect(outcome.value).toEqual({
      analyzed: 2,
      relations: [{ from: 'A', to: 'B', type: 'uses', evidence: 'x { y' }],
    });
  });

  it('handles escaped quotes and closing braces inside string values', () => {
    const reply = 'prefix {"text":"a \\"}\\" b","n":1} suffix';
    expect(parseJsonObjectWithDiagnostics(reply)).toMatchObject({
      value: { text: 'a "}" b', n: 1 },
      strategy: 'balanced-object',
    });
  });

  it('reports a truncated object as unbalanced without echoing the reply', () => {
    const reply = '{"analyzed":2,"relations":[{"from":"SECRET-BODY","to":"B"';
    const outcome = parseJsonObjectWithDiagnostics(reply);
    expect(outcome.value).toBeNull();
    expect(outcome.strategy).toBe('none');
    expect(outcome.replyLength).toBe(reply.length);
    expect(outcome.parseError).toContain('full-text=SyntaxError');
    expect(outcome.parseError).toContain('balanced-object=unbalanced');
    expect(outcome.parseError).not.toContain('SECRET-BODY');
  });

  it('reports invalid groups of braces as a failure from the first open brace', () => {
    const reply = '先看 {analyzed: 2} 再看 {relations: none} 结束';
    const outcome = parseJsonObjectWithDiagnostics(reply);
    expect(outcome.value).toBeNull();
    expect(outcome.strategy).toBe('none');
    expect(outcome.parseError).toContain('balanced-object=SyntaxError');
    expect(outcome.parseError).not.toContain('analyzed');
  });

  it.each([
    ['null', 'full-text=not_object:null'],
    ['[]', 'full-text=not_object:array'],
    ['"text"', 'full-text=not_object:string'],
    ['```json\n[1]\n```', 'code-block=not_object:array'],
  ])('rejects non-object JSON %s', (reply, fragment) => {
    const outcome = parseJsonObjectWithDiagnostics(reply);
    expect(outcome.value).toBeNull();
    expect(outcome.strategy).toBe('none');
    expect(outcome.parseError).toContain(fragment);
  });

  it.each([null, undefined, '', '   \n'])('reports an empty reply for %j', (reply) => {
    expect(parseJsonObjectWithDiagnostics(reply)).toEqual({
      value: null,
      strategy: 'none',
      parseError: 'empty_reply',
      replyLength: typeof reply === 'string' ? reply.length : 0,
    });
  });

  it('reports a reply without any open brace', () => {
    expect(parseJsonObjectWithDiagnostics('no structured output')).toMatchObject({
      value: null,
      strategy: 'none',
      parseError: 'full-text=SyntaxError; balanced-object=no_open_brace',
    });
  });
});
