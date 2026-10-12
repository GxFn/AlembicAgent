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

/**
 * I26：源码文本误伤回归。比较运算、箭头函数、类型注解、case 标签、三元表达式与
 * 非字面量的复合键赋值都不是凭据赋值，台账与 developer 事件必须逐字保留。
 */
describe('redactDeveloperText keeps ordinary source text verbatim', () => {
  test.each([
    'if (token === null) return;',
    'const ok = secret == other;',
    'if (token == "x") {',
    "if (password != 'x') {",
    'if (password !== confirm) {',
    'interface Creds {\n  password: string;\n  token?: string;\n}',
    'const fn = (token) => token;',
    'items.map(token => token.trim());',
    'func login(password: String) -> Bool',
    'def login(password: str) -> bool:',
    'let token: Token | undefined = undefined;',
    'type Session = { token: string|null; secret: Array<string>; password: Token[] };',
    'var token: Token? = nil',
    'fn check(password: &str) -> bool',
    'def load(token: Optional[str]) -> None:',
    'switch (kind) { case token: break; }',
    'const value = useCache ? token : await fetchToken();',
    'use auth::token::Claims;',
    'token := nextToken()',
    'const secretKey = process.env.SECRET_KEY;',
    'const accessKey = getAccessKey();',
    'secret_key = os.environ["SECRET_KEY"]',
    'self.private_key = load_key(path)',
    'const secretKeyword = keyword;',
    "const header = '-----BEGIN PRIVATE KEY-----';",
    'see https://user@example.com/x and http://localhost:3000/a?b=c',
    '{"passwordHash": "kept", "tokenCount": 7, "publicKey": "kept"}',
  ])('keeps %j unchanged', (input) => {
    expect(redactDeveloperText(input)).toBe(input);
  });

  test('keeps a code.read slice with comparisons and annotations byte-for-byte', () => {
    const source = [
      'export function check(token: string | null, password: string): boolean {',
      '  if (token === null) {',
      '    return false;',
      '  }',
      '  return password.length > 0 && token == expected;',
      '}',
    ].join('\n');
    expect(redactDeveloperText(source)).toBe(source);
  });
});

/** I26：常见凭据形态补全。样本均为合成值，断言原值不再出现、换行不变且结果幂等。 */
describe('redactDeveloperText masks additional credential shapes', () => {
  test.each([
    [
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnSYNTHETICbPxRfiCYEXAMPLEKEY',
      'AWS_SECRET_ACCESS_KEY=[redacted]',
    ],
    ['SECRET_KEY=django-insecure-SYNTHETIC', 'SECRET_KEY=[redacted]'],
    ["SECRET_KEY = 'django-insecure-SYNTHETIC'", "SECRET_KEY = '[redacted]'"],
    ["secretKey: 'SYNTHETIC_SECRET_KEY'", "secretKey: '[redacted]'"],
    ['PRIVATE_KEY=abcdef123456SYNTHETIC', 'PRIVATE_KEY=[redacted]'],
    ['export ACCESS_KEY="SYNTHETIC_ACCESS"', 'export ACCESS_KEY="[redacted]"'],
    ['secret_key: SYNTHETICyaml', 'secret_key: [redacted]'],
    [
      'aws:\n  secret_access_key: SYNTHETICyaml\n  region: us-east-1',
      'aws:\n  secret_access_key: [redacted]\n  region: us-east-1',
    ],
    [
      'curl -H "X-Access-Key: SYNTHETIC123" https://api.example.com',
      'curl -H "X-Access-Key: [redacted]" https://api.example.com',
    ],
    ['--secret-key=SYNTHETIC', '--secret-key=[redacted]'],
    ['password=p', 'password=[redacted]'],
    ['token: abc123', 'token: [redacted]'],
  ])('masks %j', (input, expected) => {
    const output = redactDeveloperText(input);
    expect(output).toBe(expected);
    expect(redactDeveloperText(output)).toBe(output);
  });

  test('masks compound secret keys inside JSON while keeping unrelated fields', () => {
    const input = JSON.stringify({
      secretKey: 'SYNTHETIC_A',
      accessKey: 'AKIASYNTHETIC',
      aws_secret_access_key: 'SYNTHETIC_B',
      SECRET_KEY_BASE: 'SYNTHETIC_C',
      private_key: '-----BEGIN PRIVATE KEY-----SYNTHETIC_D',
      accessKeyId: 12345,
      normal: 'kept',
    });
    const output = redactDeveloperText(input);
    expect(output).not.toContain('SYNTHETIC');
    expect(JSON.parse(output)).toEqual({
      secretKey: '[redacted]',
      accessKey: '[redacted]',
      aws_secret_access_key: '[redacted]',
      SECRET_KEY_BASE: '[redacted]',
      private_key: '[redacted]',
      accessKeyId: '[redacted]',
      normal: 'kept',
    });
  });

  test('masks a PEM private key block while keeping its markers and line count', () => {
    const input = [
      'before',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpSYNTHETICbodyLINEone+/=',
      'SYNTHETICbodyLINEtwo',
      '-----END RSA PRIVATE KEY-----',
      'after',
    ].join('\n');
    const output = redactDeveloperText(input);
    expect(output).not.toContain('SYNTHETIC');
    expect(output.split('\n')).toHaveLength(input.split('\n').length);
    expect(output).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(output).toContain('-----END RSA PRIVATE KEY-----');
    expect(output).toContain('[redacted-private-key]');
    expect(output.startsWith('before\n')).toBe(true);
    expect(output.endsWith('\nafter')).toBe(true);
    expect(redactDeveloperText(output)).toBe(output);
  });

  test('masks encrypted, OpenSSH, truncated and JSON-encoded PEM private keys', () => {
    const encrypted =
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,SYNTHETICIV\n\nSYNTHETICbody\n-----END RSA PRIVATE KEY-----';
    const openssh =
      '-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaSYNTHETIC\r\n-----END OPENSSH PRIVATE KEY-----';
    const truncated = 'log: -----BEGIN PRIVATE KEY-----\nMIIEvSYNTHETICtruncated';
    for (const input of [encrypted, openssh, truncated]) {
      const output = redactDeveloperText(input);
      expect(output).not.toContain('SYNTHETIC');
      expect(output.split('\n')).toHaveLength(input.split('\n').length);
      expect(redactDeveloperText(output)).toBe(output);
    }
    const carried = JSON.stringify({ stdout: encrypted, status: 'success' });
    const output = redactDeveloperText(carried);
    expect(output).not.toContain('SYNTHETIC');
    const parsed = JSON.parse(output) as { stdout: string; status: string };
    expect(parsed.status).toBe('success');
    expect(parsed.stdout.split('\n')).toHaveLength(encrypted.split('\n').length);
  });

  test.each([
    ['https://user:SYNTHETICpass@host.example/x', 'https://user:[redacted]@host.example/x'],
    [
      'DATABASE_URL=postgres://app:hunter2SYNTHETIC@db:5432/x',
      'DATABASE_URL=postgres://app:[redacted]@db:5432/x',
    ],
    ['redis://:SYNTHETICpass@cache:6379', 'redis://:[redacted]@cache:6379'],
    [
      'git clone https://x-access-token:SYNTHETICghp@github.com/o/r.git',
      'git clone https://x-access-token:[redacted]@github.com/o/r.git',
    ],
    ['mongodb://u:p@ssSYNTHETIC@mongo/db', 'mongodb://u:[redacted]@mongo/db'],
  ])('masks URL userinfo password in %j', (input, expected) => {
    const output = redactDeveloperText(input);
    expect(output).toBe(expected);
    expect(redactDeveloperText(output)).toBe(output);
  });

  test('replaces array and object values under sensitive JSON keys as a whole', () => {
    expect(JSON.parse(redactDeveloperText('{"password":["a"]}'))).toEqual({
      password: '[redacted]',
    });
    const input = JSON.stringify({
      token: { value: 'SYNTHETIC_A', nested: ['SYNTHETIC_B', 1, { deep: 'SYNTHETIC_C' }] },
      secretKey: ['SYNTHETIC_D]', '{SYNTHETIC_E'],
      normal: ['kept', { ok: 1 }],
    });
    const output = redactDeveloperText(input);
    expect(output).not.toContain('SYNTHETIC');
    expect(JSON.parse(output)).toEqual({
      token: '[redacted]',
      secretKey: '[redacted]',
      normal: ['kept', { ok: 1 }],
    });
    expect(redactDeveloperText(output)).toBe(output);
  });

  test('keeps line count and JSON validity for a pretty-printed sensitive array', () => {
    const input = JSON.stringify({ password: ['SYNTHETIC_A', 'SYNTHETIC_B'], normal: 7 }, null, 2);
    const output = redactDeveloperText(input);
    expect(output).not.toContain('SYNTHETIC');
    expect(output.split('\n')).toHaveLength(input.split('\n').length);
    expect(JSON.parse(output)).toEqual({ password: '[redacted]', normal: 7 });
  });

  test('masks a sensitive array nested in a serialized tool result', () => {
    const input = JSON.stringify({ stdout: JSON.stringify({ password: ['SYNTHETIC'] }), ok: true });
    const output = redactDeveloperText(input);
    expect(output).not.toContain('SYNTHETIC');
    expect(JSON.parse(JSON.parse(output).stdout)).toEqual({ password: '[redacted]' });
  });

  test('masks a truncated sensitive array instead of exposing its visible prefix', () => {
    const output = redactDeveloperText('{"normal": 1, "password": ["SYNTHETIC_A", "SYNTH');
    expect(output).not.toContain('SYNTH');
    expect(output).toContain('"normal": 1');
    expect(output).toContain('[redacted');
  });
});

describe('redactDeveloperText keeps surrounding structure while masking', () => {
  test('masks a PEM block inside a YAML literal block without moving its indentation', () => {
    const input = [
      'database:',
      '  private_key: |',
      '    -----BEGIN EC PRIVATE KEY-----',
      '    MHcCAQEEIBSYNTHETIConeLINE',
      '    SYNTHETICtwoLINE',
      '    -----END EC PRIVATE KEY-----',
      '  host: db',
    ].join('\n');
    expect(redactDeveloperText(input)).toBe(
      [
        'database:',
        '  private_key: |',
        '    -----BEGIN EC PRIVATE KEY-----',
        '    [redacted-private-key]',
        '',
        '    -----END EC PRIVATE KEY-----',
        '  host: db',
      ].join('\n')
    );
  });

  test('does not let a non-secret key swallow a following credential assignment', () => {
    expect(redactDeveloperText('tokenizer:password=SYNTHETIC_TAIL')).toBe(
      'tokenizer:password=[redacted]'
    );
    expect(redactDeveloperText('secretKeyword: "password=SYNTHETIC_TAIL"')).not.toContain(
      'SYNTHETIC_TAIL'
    );
  });

  test.each([
    ['dash separated run', `${'a-'.repeat(100_000)}password(`],
    ['repeated compound key phrase', `${'secretkey'.repeat(20_000)}(`],
    ['camel case run', `${'aB'.repeat(100_000)}secretKey=1`],
    ['unterminated PEM body', `-----BEGIN PRIVATE KEY-----\n${'A \n'.repeat(60_000)}!`],
  ])('stays linear on a long %s', (_name, input) => {
    const started = performance.now();
    redactDeveloperText(input);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
