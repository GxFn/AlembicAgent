/**
 * 脱敏阶段 1 模糊测试的确定性生成器（固定种子，写进仓库，失败可复现）。设计第 6 节测试要求 3：
 * - 语法网格：键 × 分隔符 × 值形态 × 上下文，12 × 10 × 25 × 16 = 48,000 例；
 * - 唯一字符网格：值字符换成互不相同的码点，供精确 oracle 逐字符判定；
 * - 对抗模糊：同一载体内多键值三明治、\u 与 \/ 重编码、字面标记、双层载体；
 * - 载体三明治：只有现行规则遮住的值与只有旧版遮住的值放进同一个载体。
 * 所有秘密都是合成值：哨兵片段以 SYNTHETIC 开头，唯一字符取自 CJK 统一表意文字区。
 */

/** mulberry32：32 位种子的确定性伪随机数。 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) {
    throw new Error('fuzz corpus: empty pick');
  }
  return item;
}

export const GRID_KEYS: readonly string[] = [
  'password',
  'PASSWORD',
  'DB_PASSWORD',
  'api_key',
  'apiKey',
  'x-api-key',
  'token',
  'GITHUB_TOKEN',
  'secret',
  'client_secret',
  'authorization',
  'AWS_SECRET_ACCESS_KEY',
];

/** 分隔符含历史回退相关的 ==、=>、::、:=，以及“悬空键”（值在下一行）。 */
export const GRID_SEPARATORS: readonly string[] = [
  '=',
  ': ',
  ' = ',
  '==',
  '=>',
  '::',
  ':=',
  ':',
  ' := ',
  ':\n',
];

const PEM_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';

/** 值形态（S 是秘密片段）：含 ()[]{};、${VAR:-x}、URL userinfo、运算符开头、引号、PEM 等。 */
export const GRID_VALUES: ReadonlyArray<(secret: string) => string> = [
  (s) => s,
  (s) => `!${s}`,
  (s) => `|${s}`,
  (s) => `<${s}>`,
  (s) => `Pa(ss)${s}`,
  (s) => `${s}[1]x`,
  (s) => `{${s}}`,
  (s) => `abc;${s}`,
  (s) => `\${DB_PASS:-${s}}`,
  (s) => `\${X}${s}`,
  (s) => `postgres://u:${s}@db.example.com/app`,
  (s) => `https://${s}@host.example/x`,
  (s) => `this.${s}`,
  (s) => `${s}?`,
  (s) => `${s}|null`,
  (s) => `&${s}`,
  (s) => `"${s} x"`,
  (s) => `'${s}'`,
  (s) => `"${s}`,
  (s) => `Bearer ${s}`,
  (s) => `sk-${s}0123456789`,
  (s) => `${s}\\tail`,
  (s) => `=${s}`,
  (s) => `>${s}`,
  (s) => `-----BEGIN PRIVATE KEY-----\n${PEM_LINE}${s}AAAA`,
];

const PEM_PREFIX = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_LINE}${'SYNTHETICpemBODY'.repeat(2)}\n`;

/** 上下文：行号、grep -n、Markdown 表格、单层与双层载体、悬空键、PEM 后接敏感键等。 */
export const GRID_CONTEXTS: ReadonlyArray<{ name: string; wrap: (kv: string) => string }> = [
  { name: 'bare', wrap: (kv) => kv },
  { name: 'code.read numbered', wrap: (kv) => `12|${kv}` },
  { name: 'cat -n', wrap: (kv) => `    12\t${kv}` },
  { name: 'grep -n', wrap: (kv) => `src/config.ts:12:${kv}` },
  { name: 'markdown table', wrap: (kv) => `| staging | ${kv} | rotated |` },
  { name: 'json carrier', wrap: (kv) => JSON.stringify({ stdout: kv, status: 'success' }) },
  {
    name: 'double carrier',
    wrap: (kv) => JSON.stringify({ message: JSON.stringify({ stdout: kv }) }),
  },
  { name: 'export', wrap: (kv) => `export ${kv}` },
  { name: 'yaml list', wrap: (kv) => `env:\n  - ${kv}\n  - region: eu` },
  { name: 'line comment', wrap: (kv) => `// ${kv}` },
  { name: 'hash comment', wrap: (kv) => `# ${kv}` },
  { name: 'after truncated PEM', wrap: (kv) => `${PEM_PREFIX}${kv}` },
  { name: 'logfmt', wrap: (kv) => `level=warn msg="retry with token: " ${kv}` },
  { name: 'trailing prose', wrap: (kv) => `${kv} ; rotated 2026-10` },
  { name: 'leading prose', wrap: (kv) => `config loaded: ${kv} (ok)` },
  { name: 'code.search group', wrap: (kv) => `src/config.ts\n  11: const a = 1;\n  12: ${kv}` },
];

export interface GridCase {
  input: string;
  secret: string;
}

/** 某个上下文下的全部网格用例（12 × 10 × 25 = 3,000 例）。 */
export function grammarGridFor(contextIndex: number): GridCase[] {
  const context = GRID_CONTEXTS[contextIndex];
  if (context === undefined) {
    throw new Error(`fuzz corpus: no context ${contextIndex}`);
  }
  const cases: GridCase[] = [];
  let counter = 0;
  for (const key of GRID_KEYS) {
    for (const separator of GRID_SEPARATORS) {
      for (const value of GRID_VALUES) {
        const secret = `SYNTHETIC${contextIndex}q${counter++}Z`;
        cases.push({ input: context.wrap(`${key}${separator}${value(secret)}`), secret });
      }
    }
  }
  return cases;
}

/** 唯一字符网格用的值形态（U 是 8 个互不相同的 CJK 字符）。 */
const UNIQUE_VALUES: ReadonlyArray<(unique: string) => string> = [
  (u) => u,
  (u) => `!${u}`,
  (u) => `Pa(ss)${u}`,
  (u) => `abc;${u}`,
  (u) => `\${DB_PASS:-${u}}`,
  (u) => `postgres://u:${u}@db/app`,
  (u) => `"${u}"`,
  (u) => `'${u}'`,
  (u) => `${u}|null`,
  (u) => `<${u}>`,
  (u) => `${u}[1]`,
  (u) => `{${u}}`,
  (u) => `this.${u}`,
  (u) => `=${u}`,
  (u) => `${u}?`,
];

const UNIQUE_CONTEXTS: ReadonlyArray<(kv: string) => string> = [
  (kv) => kv,
  (kv) => JSON.stringify({ stdout: kv }),
  (kv) => JSON.stringify({ message: JSON.stringify({ stdout: kv }) }),
  (kv) => `12|${kv}`,
  (kv) => `| a | ${kv} | b |`,
  (kv) => `${PEM_PREFIX}${kv}`,
];

export interface UniqueCase {
  input: string;
  /** 值里的唯一字符（每个在输入中只出现一次）。 */
  uniques: string[];
}

/** 12 × 10 × 15 × 6 = 10,800 个唯一字符用例。 */
export function uniqueCharGrid(): UniqueCase[] {
  const cases: UniqueCase[] = [];
  let codePoint = 0x4e00;
  for (const key of GRID_KEYS) {
    for (const separator of GRID_SEPARATORS) {
      for (const value of UNIQUE_VALUES) {
        for (const context of UNIQUE_CONTEXTS) {
          const uniques: string[] = [];
          for (let index = 0; index < 8; index++) {
            uniques.push(String.fromCodePoint(codePoint++));
            if (codePoint > 0x9fa5) {
              codePoint = 0x4e00;
            }
          }
          cases.push({ input: context(`${key}${separator}${value(uniques.join(''))}`), uniques });
        }
      }
    }
  }
  return cases;
}

const EXTRA_KEYS: readonly string[] = [
  'JWT_SECRET',
  'SECRET_KEY',
  'secretKey',
  'PRIVATE_KEY',
  'accessKey',
  'refresh_token',
  'Authorization',
  'X-Api-Key',
];

const SOURCE_SNIPPETS: readonly string[] = [
  'if (token === null) return;',
  'interface Creds {\n  password: string;\n}',
  'const fn = (token) => token;',
  'let token: Token | undefined = undefined;',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
  'const url = `postgres://${user}:${password}@${host}/db`;',
  'MasterUserPassword: !Ref DBPassword',
  'def login(password: str) -> bool:',
  'secret_key = os.environ["SECRET_KEY"]',
];

const LINE_PREFIXES: readonly string[] = [
  '',
  '// ',
  '# ',
  '12|',
  '    3\t',
  'key.pem:3:',
  '+',
  'INFO ',
  ' * ',
];

const MARKER_LITERALS: readonly string[] = [
  '[redacted]',
  '"[redacted]"',
  '[redacted-unaligned]',
  '\\"[redacted]\\"',
  '[redacted-private-key]',
];

function secretToken(random: () => number): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let tail = '';
  const length = 4 + Math.floor(random() * 6);
  for (let index = 0; index < length; index++) {
    tail += pick(random, [...alphabet]);
  }
  return `SYNTHETIC${tail}`;
}

function pemBlock(random: () => number, secret: string): string {
  const label = pick(random, ['', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ']);
  const prefix = pick(random, LINE_PREFIXES);
  const lines = [
    `-----BEGIN ${label}PRIVATE KEY-----`,
    `${PEM_LINE}${secret}${'A'.repeat(1 + Math.floor(random() * 20))}`,
  ];
  if (random() < 0.3) {
    lines.push('... [12 lines omitted] ...');
  }
  lines.push(`${secret}${'B'.repeat(8 + Math.floor(random() * 40))}`);
  if (random() < 0.5) {
    lines.push(`-----END ${label}PRIVATE KEY-----`);
  }
  return lines.map((line) => `${prefix}${line}`).join('\n');
}

function block(random: () => number): string {
  const secret = secretToken(random);
  const roll = random();
  if (roll < 0.45) {
    const key = random() < 0.7 ? pick(random, GRID_KEYS) : pick(random, EXTRA_KEYS);
    return `${key}${pick(random, GRID_SEPARATORS)}${pick(random, GRID_VALUES)(secret)}`;
  }
  if (roll < 0.55) {
    return pemBlock(random, secret);
  }
  if (roll < 0.65) {
    const scheme = pick(random, ['https', 'postgres', 'redis', 'mongodb', 'mysql']);
    return `${scheme}://${pick(random, ['u', '', 'app', 'x-access-token'])}:${secret}@db.example.com/${pick(random, ['app', `c?sv=2022&sig=${secretToken(random)}`, 'x'])}`;
  }
  if (roll < 0.72) {
    return `Authorization: ${pick(random, ['Bearer', 'Basic', 'bearer'])} ${secret}`;
  }
  if (roll < 0.8) {
    return pick(random, MARKER_LITERALS);
  }
  if (roll < 0.9) {
    return pick(random, SOURCE_SNIPPETS);
  }
  return pick(random, [
    'ok',
    'status=200',
    'see docs/a.md',
    'rotated',
    `id=${secretToken(random)}`,
  ]);
}

/** 把载体 JSON 字符串里的部分字符换成等价但不规范的编码（\/、\u00XX），模拟其他语言的编码器。 */
function perturbEncoding(random: () => number, json: string): string {
  let output = '';
  for (const char of json) {
    if (char === '/' && random() < 0.5) {
      output += '\\/';
    } else if (/[a-z]/.test(char) && random() < 0.03) {
      output += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    } else {
      output += char;
    }
  }
  // 只在字符串内部才是合法转义；不合法时退回原样，避免把载体改坏成不可解析的形状。
  try {
    JSON.parse(output);
    return output;
  } catch (err: unknown) {
    void err;
    return json;
  }
}

/** 对抗模糊：count 个输入，固定种子。 */
export function adversarialInputs(count: number, seed: number): string[] {
  const random = seededRandom(seed);
  const inputs: string[] = [];
  for (let index = 0; index < count; index++) {
    const lines: string[] = [];
    const lineCount = 1 + Math.floor(random() * 4);
    for (let line = 0; line < lineCount; line++) {
      const parts: string[] = [];
      const partCount = 1 + Math.floor(random() * 3);
      for (let part = 0; part < partCount; part++) {
        parts.push(block(random));
      }
      lines.push(parts.join(pick(random, [' ', ', ', '; ', ' && '])));
    }
    const doc = lines.join(random() < 0.15 ? '\r\n' : '\n');
    const layout = random();
    let input: string;
    if (layout < 0.25) {
      input = doc;
    } else if (layout < 0.5) {
      input = JSON.stringify({ stdout: doc, status: 'success' });
    } else if (layout < 0.62) {
      input = JSON.stringify({ message: JSON.stringify({ stdout: doc }) });
    } else if (layout < 0.8) {
      input = JSON.stringify({ a: doc, b: block(random), c: 7, d: [block(random), 'kept'] });
    } else if (layout < 0.9) {
      input = JSON.stringify([doc, block(random)], null, random() < 0.5 ? 2 : undefined);
    } else {
      input = `${JSON.stringify({ stdout: doc })}\n\n[evidence] E-1=src/a.ts:1-${2 + Math.floor(random() * 9)}`;
    }
    if (layout >= 0.25 && random() < 0.35) {
      input = perturbEncoding(random, input);
    }
    inputs.push(input);
  }
  return inputs;
}

/** 只有现行规则（b60a61e）遮住的写法。 */
export const HEAD_ONLY_SHAPES: ReadonlyArray<(secret: string) => string> = [
  (s) => `-----BEGIN RSA PRIVATE KEY-----\n${PEM_LINE}${s}\n-----END RSA PRIVATE KEY-----`,
  (s) => `-----BEGIN EC PRIVATE KEY-----\n${PEM_LINE}${s}AAAA`,
  (s) => `-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNz${s}\r\n-----END OPENSSH PRIVATE KEY-----`,
  (s) =>
    `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,${s}\n\n${PEM_LINE}\n-----END RSA PRIVATE KEY-----`,
  (s) => `log: -----BEGIN PRIVATE KEY-----\n${PEM_LINE}${s}`,
  (s) =>
    `  private_key: |\n    -----BEGIN EC PRIVATE KEY-----\n    MHcCAQEEIB${s}\n    -----END EC PRIVATE KEY-----`,
  (s) => `https://user:${s}@host.example/x`,
  (s) => `postgres://app:${s}@db:5432/x`,
  (s) => `redis://:${s}@cache:6379`,
  (s) => `mongodb://u:p@${s}@mongo/db`,
  (s) => `ftp://anon:${s}@files.example.com/pub`,
  (s) => `git clone https://x-access-token:${s}@github.com/o/r.git`,
  (s) => `AWS_SECRET_ACCESS_KEY=${s}`,
  (s) => `secretKey: '${s}'`,
  (s) => `PRIVATE_KEY=${s}`,
  (s) => `export ACCESS_KEY="${s}"`,
  (s) => `--secret-key=${s}`,
  (s) => `curl -H "X-Access-Key: ${s}" https://api.example.com`,
  (s) => `{"password":["${s}"]}`,
  (s) => `{"token":{"value":"${s}"}}`,
  (s) => `{"secretKey":["${s}]"]}`,
  (s) => `{"api_key":[1,"${s}"]}`,
  (s) => `{"authorization":{"a":["${s}"]}}`,
  (s) => `{"normal":1,"password":["${s}"`,
  (s) => `Authorization: Bearer ${s.slice(0, 6)}`,
  (s) => `authorization: Basic ${s}==`,
  (s) => `aws:\n  secret_access_key: ${s}\n  region: us-east-1`,
  (s) => `{"accessKeyId": 12345, "note": "${s}", "private_key": "-----BEGIN PRIVATE KEY-----${s}"}`,
  (s) => `SECRET_KEY = 'django-insecure-${s}'`,
  (s) => `secret_key: ${s}yaml`,
];

/** 只有早期版本（d113986 / 1b394ce / 246055e）遮住的写法。 */
export const LEGACY_ONLY_SHAPES: ReadonlyArray<(secret: string) => string> = [
  (s) => `JWT_SECRET=!${s}`,
  (s) => `DB_PASSWORD=!${s}`,
  (s) => `export API_TOKEN=|${s}`,
  (s) => `password = <${s}>`,
  (s) => `password: ${s}?`,
  (s) => `password: abc|${s}`,
  (s) => `token: ${s}<1`,
  (s) => `password: ?x${s}`,
  (s) => `secret: &${s}`,
  (s) => `password: ${s}[1]`,
  (s) => `password=Pa(ss)${s}`,
  (s) => `DB_PASSWORD=abc;${s}`,
  (s) => `PASSWORD=\${DB_PASS:-${s}}`,
  (s) => `password==${s}`,
  (s) => `token=>${s}`,
  (s) => `password::${s}`,
  (s) => `level=warn msg="retry with token: " token="${s}"`,
  (s) => `| staging | password: ${s} | rotated |`,
  (s) => `api_key: <${s}>`,
  (s) => `password: ${s}.Horse?`,
  (s) => `PASSWORD=self.${s}`,
  (s) => `my %cfg = (api_key=>${s});`,
];

export const SANDWICH_LAYOUTS: ReadonlyArray<{
  name: string;
  build: (head: string, legacy: string) => string;
}> = [
  { name: 'same literal, newline', build: (h, l) => JSON.stringify({ stdout: `${h}\n${l}` }) },
  { name: 'same literal, space', build: (h, l) => JSON.stringify({ stdout: `${h} ${l}` }) },
  { name: 'sibling fields', build: (h, l) => JSON.stringify({ a: h, b: l, status: 'success' }) },
  { name: 'array items', build: (h, l) => JSON.stringify([h, l]) },
  {
    name: 'double carrier',
    build: (h, l) => JSON.stringify({ message: JSON.stringify({ stdout: `${h}\n${l}` }) }),
  },
];

/** 30 × 22 × 5 = 3,300 个载体三明治。 */
export function carrierSandwiches(): Array<{ name: string; input: string }> {
  const cases: Array<{ name: string; input: string }> = [];
  for (const [headIndex, head] of HEAD_ONLY_SHAPES.entries()) {
    for (const [legacyIndex, legacy] of LEGACY_ONLY_SHAPES.entries()) {
      for (const layout of SANDWICH_LAYOUTS) {
        cases.push({
          name: `h${headIndex}/l${legacyIndex}/${layout.name}`,
          input: layout.build(
            head(`SYNTHETICh${headIndex}x${legacyIndex}`),
            legacy(`SYNTHETICl${legacyIndex}x${headIndex}`)
          ),
        });
      }
    }
  }
  return cases;
}
