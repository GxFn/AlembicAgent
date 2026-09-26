/**
 * 开发者文本的已知凭据脱敏边界：完整值、JSON载体与换行保真。
 * 样本均为显式合成值，非真实凭据；实际Runtime与台账调用另由各自测试入口覆盖。
 */
import { describe, expect, test } from 'vitest';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';

describe('redactDeveloperText scalar secret boundaries', () => {
  test.each([
    'api_key',
    'token',
    'secret',
    'password',
    'authorization',
  ])('redacts JSON-encoded %s values', (key) => {
    const input = JSON.stringify({ [key]: 'synthetic-sensitive-value', normal: 'kept' });
    expect(JSON.parse(redactDeveloperText(input))).toEqual({ [key]: '[redacted]', normal: 'kept' });
  });
  test.each([
    'with space',
    'synthetic sensitive value',
    'synthetic"secret-tail',
    'synthetic\\secret-tail',
  ])('preserves valid JSON while redacting %s', (password) => {
    expect(JSON.parse(redactDeveloperText(JSON.stringify({ password })))).toEqual({
      password: '[redacted]',
    });
  });
  test('OpenAI 形态 key 打码', () => {
    // sk- 规则先于键值对规则执行；'key' 不含 api 前缀故不触发第四条规则
    expect(redactDeveloperText('key=sk-xxxxxxxxxxxxxxxx end')).toBe('key=[redacted-api-key] end');
    expect(redactDeveloperText('sk-proj-xxxxxxxxxxxxxxxx')).toBe('[redacted-api-key]');
  });

  test('Google 形态 key 打码', () => {
    expect(redactDeveloperText('AIzaxxxxxxxxxxxxxxxxxxxx')).toBe('[redacted-google-api-key]');
  });

  test('Bearer token 打码保留前缀', () => {
    expect(redactDeveloperText('Authorization: Bearer abcdefghijkl')).toBe(
      'Authorization: Bearer [redacted-token]'
    );
  });

  test('键值对形态 secret 打码保留键名', () => {
    expect(redactDeveloperText('api_key: verysecretvalue')).toBe('api_key: [redacted]');
    expect(redactDeveloperText('password=hunter2hunter2')).toBe('password=[redacted]');
  });

  test('普通文本原样通过', () => {
    const text = '类型导入使用 import type 严格隔离：lib/types/graph-shared.ts:1-3';
    expect(redactDeveloperText(text)).toBe(text);
  });
});

test.each([
  'password="SYNTHETIC head SYNTHETIC_TAIL_NEVER_REAL"',
  "api_key='SYNTHETIC head SYNTHETIC_TAIL_NEVER_REAL'",
  'password="SYNTHETIC \\"quoted\\" SYNTHETIC_TAIL_NEVER_REAL"',
])('redacts a complete quoted value: %s', (input) => {
  const output = redactDeveloperText(input);
  expect(output).not.toContain('SYNTHETIC');
  expect(output).toContain('[redacted]');
  expect(redactDeveloperText(output)).toBe(output);
});

test('preserves numeric JSON syntax and unrelated formatting', () => {
  const input = '{\n  "password": 123456789,\n  "normal": 7\n}';
  const output = redactDeveloperText(input);
  expect(JSON.parse(output)).toEqual({ password: '[redacted]', normal: 7 });
  expect(output).toBe('{\n  "password": "[redacted]",\n  "normal": 7\n}');
});

test('redacts quoted assignment text inside a serialized tool result with its evidence annotation', () => {
  const payload = JSON.stringify(
    { stdout: 'password="SYNTHETIC head SYNTHETIC_TAIL_NEVER_REAL"', status: 'success' },
    null,
    2
  );
  const output = redactDeveloperText(`${payload}\n\n[evidence] E-1`);
  expect(output).not.toContain('SYNTHETIC');
  expect(JSON.parse(output.slice(0, output.indexOf('\n\n[evidence]')))).toEqual({
    stdout: 'password="[redacted]"',
    status: 'success',
  });
  expect(output).toContain('[evidence] E-1');
});

test.each([
  'password=p@55',
  'Authorization: Bearer demo',
])('does not disclose short supported values: %s', (input) => {
  const output = redactDeveloperText(input);
  expect(output).not.toContain(input.split(' ').at(-1)?.split('=').at(-1) ?? '__not_a_value__');
  expect(output).toContain('[redacted');
});

test('retains line breaks while masking a multiline quoted value', () => {
  const input = 'password="SYNTHETIC first\nSYNTHETIC last"\nordinary: kept';
  const output = redactDeveloperText(input);
  expect(output).not.toContain('SYNTHETIC');
  expect(output.split('\n')).toHaveLength(input.split('\n').length);
  expect(output).toContain('ordinary: kept');
});

test('masks serialized string-array observations without changing their JSON container', () => {
  const input = JSON.stringify(['password="SYNTHETIC array tail"', 'normal']);
  expect(JSON.parse(redactDeveloperText(input))).toEqual(['password="[redacted]"', 'normal']);
});

test('masks a truncated quoted value instead of exposing its visible prefix', () => {
  expect(redactDeveloperText('password="SYNTHETIC partial')).toBe('password="[redacted]');
});

test('keeps ordinary JSON escaping and metrics byte-for-byte', () => {
  const input =
    '{\n  "normal": "line\\nwith\\tspaces", "totalTokens": 123456789, "path": "src/runtime.ts"\n}';
  expect(redactDeveloperText(input)).toBe(input);
});

test('keeps authorization scheme and masks the whole Basic credential', () => {
  expect(redactDeveloperText('Authorization: Basic U1lOVEhFVElDLURFTU8=')).toBe(
    'Authorization: Basic [redacted-token]'
  );
});

test('bounds nested serialized output without returning unchecked inner text', () => {
  let input = 'password="SYNTHETIC nested tail"';
  for (let i = 0; i < 10; i++) {
    input = JSON.stringify({ message: input });
  }
  const output = redactDeveloperText(input);
  expect(output).not.toContain('SYNTHETIC');
  expect(output).toContain('[redacted-nested-value]');
  expect(() => JSON.parse(output)).not.toThrow();
});

const rawSingle = "password='SYNTHETIC \\'quoted\\' SYNTHETIC_TAIL_NEVER_REAL'";
test.each([
  { name: 'raw assignment', input: rawSingle, json: false },
  { name: 'JSON object carrier', input: JSON.stringify({ stdout: rawSingle }), json: true },
  { name: 'JSON array carrier', input: JSON.stringify([rawSingle, 'normal']), json: true },
  {
    name: 'twice encoded object',
    input: JSON.stringify({ message: JSON.stringify({ stdout: rawSingle }) }),
    json: true,
  },
])('redacts escaped single-quoted values under $name', ({ input, json }) => {
  const output = redactDeveloperText(input);
  expect(output).not.toContain('SYNTHETIC_TAIL_NEVER_REAL');
  if (json) {
    expect(() => JSON.parse(output)).not.toThrow();
  }
  expect(redactDeveloperText(output)).toBe(output);
});
test('continues to mask multiline Bearer text while preserving the original line separator', () => {
  const input = 'Authorization: Bearer\r\nSYNTHETIC_DEMO_TOKEN_NEVER_REAL';
  const output = redactDeveloperText(input);
  expect(output).not.toContain('SYNTHETIC_DEMO_TOKEN_NEVER_REAL');
  expect(output).toContain('\r\n');
  expect(redactDeveloperText(output)).toBe(output);
});
test('preserves multiline scalar line positions even when the key is quoted', () => {
  const input = '"password": "SYNTHETIC first\nSYNTHETIC last"\nordinary: kept';
  const output = redactDeveloperText(input);
  expect(output).not.toContain('SYNTHETIC');
  expect(output.split('\n')).toHaveLength(input.split('\n').length);
  expect(output).toContain('ordinary: kept');
});
test('does not expose a bare supported password tail separated by a backslash', () => {
  const input = 'password=SYNTHETIC\\SYNTHETIC_TAIL_NEVER_REAL';
  const output = redactDeveloperText(input);
  expect(output).not.toContain('SYNTHETIC_TAIL_NEVER_REAL');
  expect(redactDeveloperText(output)).toBe(output);
});

test('masks the visible prefix of a quoted value truncated after an escape character', () => {
  const input = 'password="SYNTHETIC_TRAILING_ESCAPE\\';
  const output = redactDeveloperText(input);
  expect(output).not.toContain('SYNTHETIC_TRAILING_ESCAPE');
  expect(output).toContain('[redacted]');
  expect(redactDeveloperText(output)).toBe(output);
});
