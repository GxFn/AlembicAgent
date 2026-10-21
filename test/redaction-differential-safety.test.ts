/**
 * Redaction 差分安全网（脱敏设计阶段 1 测试要求 2；语料复用自 L5-P4d 差分测试）。
 *
 * 对照四个历史版本（test/fixtures/redaction-baselines/ 下与 git blob 逐字节相同的 246055e、1b394ce、
 * d113986、b60a61e）：
 * - (A) 凭据形态：只要任一历史版本的输出里已不含某个合成秘密，新版输出也必须不含（单调安全，零回退）。
 *   这是阶段 1 的门禁；同一输入另交给攻击夹具 assertNoLegacyRegression 按精确 oracle 判定。
 *   P4d 原有的“(A) 必遮”断言（四个版本都漏的覆盖缺口，如带前缀的 PEM）属于阶段 4 的验收，这里不作断言。
 * - (B) 源码形态：只作代价报告，不作断言（用户决定 D2：阶段 1 接受仍走脱敏的出口里误伤回到四版并集水平）。
 * 两类都检查幂等，并对 JSON 载体（工具结果常见的序列化外壳）再跑一遍。
 *
 * 所有秘密都是显式合成标记（SYNTHETIC… / Synthetic…），不是真实凭据；PEM 正文用 base64 字符集里的
 * 合成标记，保证它在私钥正文规则下仍是“正文”。
 */
import { describe, expect, test } from 'vitest';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';
import { redactDeveloperText as redactAt1b394ce } from './fixtures/redaction-baselines/redaction-at-1b394ce.js';
import { redactDeveloperText as redactAt246055e } from './fixtures/redaction-baselines/redaction-at-246055e.js';
import { redactDeveloperText as redactAtB60a61e } from './fixtures/redaction-baselines/redaction-at-b60a61e.js';
import { redactDeveloperText as redactAtD113986 } from './fixtures/redaction-baselines/redaction-at-d113986.js';
import { assertNoLegacyRegression } from './fixtures/redaction-catalog/legacyRegressionOracle.js';

interface CredentialCase {
  name: string;
  input: string;
  /** 输入里出现、输出里必须消失的合成秘密片段。 */
  secrets: string[];
}

interface SourceCase {
  name: string;
  input: string;
}

const BASELINES: ReadonlyArray<{ revision: string; redact: (text: string) => string }> = [
  { revision: '246055e', redact: redactAt246055e },
  { revision: '1b394ce', redact: redactAt1b394ce },
  { revision: 'd113986', redact: redactAtD113986 },
  { revision: 'b60a61e', redact: redactAtB60a61e },
];

const PEM_LINE_ONE = `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCSYNTHETICPEMONE${'A'.repeat(17)}`;
const PEM_LINE_TWO = `SYNTHETICPEMTWO${'B'.repeat(49)}`;
const PEM_SECRETS = ['SYNTHETICPEMONE', 'SYNTHETICPEMTWO'];

/** 按行加前缀拼一个私钥块；end=false 表示截断（没有 END 行）。 */
function pemBlock(prefix: (line: number) => string, end: boolean, label = ''): string {
  const lines = [
    `-----BEGIN ${label}PRIVATE KEY-----`,
    PEM_LINE_ONE,
    PEM_LINE_TWO,
    ...(end ? [`-----END ${label}PRIVATE KEY-----`] : []),
  ];
  return lines.map((line, index) => `${prefix(index + 1)}${line}`).join('\n');
}

const CREDENTIAL_CASES: CredentialCase[] = [
  // KEY=value 紧凑形式与 env/shell/CLI 写法
  {
    name: 'env password',
    input: 'password=SYNTHETIC-SECRET-a001',
    secrets: ['SYNTHETIC-SECRET-a001'],
  },
  {
    name: 'env DB_PASSWORD',
    input: 'DB_PASSWORD=SYNTHETIC-SECRET-a002',
    secrets: ['SYNTHETIC-SECRET-a002'],
  },
  {
    name: 'exported token',
    input: 'export API_TOKEN=SYNTHETIC-SECRET-a003',
    secrets: ['SYNTHETIC-SECRET-a003'],
  },
  {
    name: 'GitHub token',
    input: 'GITHUB_TOKEN=ghp_SYNTHETICSECRETa004xxxxxxxxxxxxxxxx',
    secrets: ['SYNTHETICSECRETa004'],
  },
  {
    name: 'AWS secret access key',
    input: 'AWS_SECRET_ACCESS_KEY=SYNTHETICSECRETa005/xyz+abc',
    secrets: ['SYNTHETICSECRETa005'],
  },
  {
    name: 'Django SECRET_KEY',
    input: 'SECRET_KEY=django-insecure-SYNTHETIC-SECRET-a006',
    secrets: ['SYNTHETIC-SECRET-a006'],
  },
  {
    name: 'docker -e flag',
    input: 'docker run -e DB_PASSWORD=SYNTHETIC-SECRET-a007 app',
    secrets: ['SYNTHETIC-SECRET-a007'],
  },
  {
    name: 'inline env before a command',
    input: 'PGPASSWORD=SYNTHETIC-SECRET-a008 psql -h db',
    secrets: ['SYNTHETIC-SECRET-a008'],
  },
  {
    name: 'query-string client secret',
    input: 'client_secret=SYNTHETIC-SECRET-a009&grant_type=client_credentials',
    secrets: ['SYNTHETIC-SECRET-a009'],
  },
  {
    name: 'CLI flag',
    input: '--password=SYNTHETIC-SECRET-a010',
    secrets: ['SYNTHETIC-SECRET-a010'],
  },
  {
    name: 'HTTP header',
    input: 'x-api-key: SYNTHETIC-SECRET-a011',
    secrets: ['SYNTHETIC-SECRET-a011'],
  },
  {
    name: 'Basic authorization',
    input: 'Authorization: Basic U1lOVEhFVElDU0VDUkVUYTAxMg==',
    secrets: ['U1lOVEhFVElDU0VDUkVUYTAxMg'],
  },
  {
    name: 'Bearer authorization',
    input: 'Authorization: Bearer SYNTHETIC-SECRET-a013',
    secrets: ['SYNTHETIC-SECRET-a013'],
  },
  {
    name: 'spaced INI assignment',
    input: 'password = SYNTHETIC-SECRET-a014',
    secrets: ['SYNTHETIC-SECRET-a014'],
  },
  {
    name: 'walrus-like assignment',
    input: 'token :=SYNTHETIC-SECRET-a015',
    secrets: ['SYNTHETIC-SECRET-a015'],
  },
  {
    name: 'OpenAI key shape',
    input: 'export KEY=sk-proj-SYNTHETICSECRETa016abcdef',
    secrets: ['SYNTHETICSECRETa016'],
  },
  {
    name: 'Google key shape',
    input: 'key AIzaSYNTHETICSECRETa017xxxxxxxx',
    secrets: ['SYNTHETICSECRETa017'],
  },
  {
    name: 'assignment after a long line prefix',
    input: `${'x'.repeat(300)} password=SYNTHETIC-SECRET-a018`,
    secrets: ['SYNTHETIC-SECRET-a018'],
  },
  // 带 | < > ! ? & 的值
  {
    name: 'value led by !',
    input: 'password=!SYNTHETIC-SECRET-b001',
    secrets: ['SYNTHETIC-SECRET-b001'],
  },
  {
    name: 'env value led by !',
    input: 'DB_PASSWORD=!SYNTHETIC-SECRET-b002',
    secrets: ['SYNTHETIC-SECRET-b002'],
  },
  {
    name: 'exported value led by |',
    input: 'export API_TOKEN=|SYNTHETIC-SECRET-b003',
    secrets: ['SYNTHETIC-SECRET-b003'],
  },
  {
    name: 'value led by <',
    input: 'API_TOKEN=<SYNTHETIC-SECRET-b004',
    secrets: ['SYNTHETIC-SECRET-b004'],
  },
  {
    name: 'value ending in ?',
    input: 'password: SYNTHETIC-SECRET-b005?',
    secrets: ['SYNTHETIC-SECRET-b005'],
  },
  {
    name: 'value with an inner |',
    input: 'password: abc|SYNTHETIC-SECRET-b006',
    secrets: ['SYNTHETIC-SECRET-b006'],
  },
  {
    name: 'value with an inner <',
    input: 'token: Passw0rd<SYNTHETIC-SECRET-b007',
    secrets: ['SYNTHETIC-SECRET-b007'],
  },
  {
    name: 'value led by ?',
    input: 'password: ?SYNTHETIC-SECRET-b008',
    secrets: ['SYNTHETIC-SECRET-b008'],
  },
  {
    name: 'value led by &',
    input: 'secret: &SYNTHETIC-SECRET-b009',
    secrets: ['SYNTHETIC-SECRET-b009'],
  },
  {
    name: 'angle-bracketed value',
    input: 'password = <SYNTHETIC-SECRET-b010>',
    secrets: ['SYNTHETIC-SECRET-b010'],
  },
  {
    name: 'value glued as KEY==value',
    input: 'PASSWORD==SYNTHETIC-SECRET-b011',
    secrets: ['SYNTHETIC-SECRET-b011'],
  },
  {
    name: 'value glued as KEY=>value',
    input: 'export API_TOKEN=>SYNTHETIC-SECRET-b012',
    secrets: ['SYNTHETIC-SECRET-b012'],
  },
  {
    name: 'value led by >',
    input: 'password: >SYNTHETIC-SECRET-b013',
    secrets: ['SYNTHETIC-SECRET-b013'],
  },
  {
    name: 'YAML value led by !',
    input: 'token: !SYNTHETIC-SECRET-b014',
    secrets: ['SYNTHETIC-SECRET-b014'],
  },
  {
    name: 'PascalCase with an inner |',
    input: 'password: SyntheticSecret|Other',
    secrets: ['SyntheticSecret'],
  },
  {
    name: 'value led by | in YAML',
    input: 'token: |SYNTHETIC-SECRET-b016',
    secrets: ['SYNTHETIC-SECRET-b016'],
  },
  // URL userinfo
  {
    name: 'postgres URL',
    input: 'DATABASE_URL=postgres://app:SYNTHETIC-SECRET-c001@db:5432/app',
    secrets: ['SYNTHETIC-SECRET-c001'],
  },
  {
    name: 'redis URL without user',
    input: 'redis://:SYNTHETIC-SECRET-c002@cache:6379/0',
    secrets: ['SYNTHETIC-SECRET-c002'],
  },
  {
    name: 'git clone with token',
    input: 'git clone https://x-access-token:SYNTHETIC-SECRET-c003@github.com/o/r.git',
    secrets: ['SYNTHETIC-SECRET-c003'],
  },
  {
    name: 'mongodb+srv URL',
    input: 'mongodb+srv://user:SYNTHETIC-SECRET-c004@cluster0.example.net/db',
    secrets: ['SYNTHETIC-SECRET-c004'],
  },
  {
    name: 'amqp URL',
    input: 'amqp://guest:SYNTHETIC-SECRET-c005@rabbit:5672/',
    secrets: ['SYNTHETIC-SECRET-c005'],
  },
  {
    name: 'quoted URL in Python',
    input: 'url = "postgresql://app:SYNTHETIC-SECRET-c006@db/app"',
    secrets: ['SYNTHETIC-SECRET-c006'],
  },
  {
    name: 'literal password beside an interpolated host',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
    input: 'const url = `postgres://app:SYNTHETIC-SECRET-c007@${host}/db`;',
    secrets: ['SYNTHETIC-SECRET-c007'],
  },
  {
    name: 'placeholder mixed with a literal',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
    input: 'postgres://app:pre${x}SYNTHETIC-SECRET-c008@db',
    secrets: ['SYNTHETIC-SECRET-c008'],
  },
  {
    name: 'percent-encoded password',
    input: 'https://user:SYNTHETIC%40SECRET-c009@host/x',
    secrets: ['SYNTHETIC%40SECRET-c009'],
  },
  {
    name: 'dollar literal that is not an env var',
    input: 'mysql://root:$SYNTHETIC-SECRET-c010@db/x',
    secrets: ['SYNTHETIC-SECRET-c010'],
  },
  // URL userinfo 里带字面默认值/替代值的展开：花括号里的字面量就是口令（docker-compose、.env.example、CI）
  {
    name: 'compose default expansion',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的配置文本里的 shell 参数展开，不是模板串。
    input: 'DATABASE_URL: postgresql://postgres:${DB_PASS:-SYNTHETIC-SECRET-c011}@db:5432/app',
    secrets: ['SYNTHETIC-SECRET-c011'],
  },
  {
    name: 'env default expansion without user',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的配置文本里的 shell 参数展开，不是模板串。
    input: 'REDIS_URL=redis://:${REDIS_PW:-SYNTHETIC-SECRET-c012}@cache:6379/0',
    secrets: ['SYNTHETIC-SECRET-c012'],
  },
  {
    name: 'default expansion beside a pure user reference',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的配置文本里的 shell 参数展开，不是模板串。
    input: 'amqp://${RABBIT_USER}:${RABBIT_PASS:-SYNTHETIC-SECRET-c013}@rabbit:5672',
    secrets: ['SYNTHETIC-SECRET-c013'],
  },
  {
    name: 'unset-only default expansion',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的配置文本里的 shell 参数展开，不是模板串。
    input: 'DATABASE_URL=postgres://app:${DB_PASSWORD-SYNTHETIC-SECRET-c014}@db/app',
    secrets: ['SYNTHETIC-SECRET-c014'],
  },
  {
    name: 'assign-default expansion',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的配置文本里的 shell 参数展开，不是模板串。
    input: 'postgres://app:${DB_PASS:=SYNTHETIC-SECRET-c015}@db/app',
    secrets: ['SYNTHETIC-SECRET-c015'],
  },
  {
    name: 'alternate-value expansion',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的配置文本里的 shell 参数展开，不是模板串。
    input: 'postgres://app:${DB_PASS:+SYNTHETIC-SECRET-c016}@db/app',
    secrets: ['SYNTHETIC-SECRET-c016'],
  },
  {
    name: 'logical-or fallback in a template',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值表达式，不是模板串。
    input: 'const url = `postgres://app:${pw||SyntheticSecretC017}@db/app`;',
    secrets: ['SyntheticSecretC017'],
  },
  {
    name: 'template filter with a literal argument',
    input: 'url: postgres://app:{{pw|default:31415926C018}}@db/app',
    secrets: ['31415926C018'],
  },
  // PEM：完整块、截断块，以及每行带前缀（注释符、引用符、行号列）的写法
  { name: 'PEM complete', input: pemBlock(() => '', true), secrets: PEM_SECRETS },
  { name: 'PEM complete RSA', input: pemBlock(() => '', true, 'RSA '), secrets: PEM_SECRETS },
  { name: 'PEM truncated', input: pemBlock(() => '', false), secrets: PEM_SECRETS },
  {
    name: 'PEM truncated before a note',
    input: `${pemBlock(() => '', false)}\n... [output truncated]`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM inside a YAML literal block',
    input: `private_key: |\n${pemBlock(() => '    ', true, 'EC ')}\nhost: db`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated with // prefix',
    input: pemBlock(() => '// ', false),
    secrets: PEM_SECRETS,
  },
  { name: 'PEM complete with // prefix', input: pemBlock(() => '// ', true), secrets: PEM_SECRETS },
  { name: 'PEM truncated with # prefix', input: pemBlock(() => '# ', false), secrets: PEM_SECRETS },
  { name: 'PEM complete with # prefix', input: pemBlock(() => '# ', true), secrets: PEM_SECRETS },
  {
    name: 'PEM truncated with * prefix',
    input: pemBlock(() => ' * ', false),
    secrets: PEM_SECRETS,
  },
  { name: 'PEM truncated with > prefix', input: pemBlock(() => '> ', false), secrets: PEM_SECRETS },
  {
    name: 'PEM truncated with cat -n numbers',
    input: `${pemBlock((line) => `${String(line).padStart(6)}\t`, false)}\n... (output truncated)`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM complete with nl numbers',
    input: pemBlock((line) => `${String(line).padStart(6)}\t`, true),
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated with code.read numbers',
    input: pemBlock((line) => `${line}|`, false),
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM complete with code.read numbers',
    input: pemBlock((line) => `${line + 40}|`, true),
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated with grep -n numbers',
    input: pemBlock((line) => `${line}:`, false),
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated with less -N numbers',
    input: pemBlock((line) => `${String(line).padStart(7)} `, false),
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM removed in a diff',
    input: pemBlock(() => '-', true),
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM added in a diff',
    input: pemBlock(() => '+', true),
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM with escaped line breaks',
    input: `PEM="-----BEGIN PRIVATE KEY-----\\n${PEM_LINE_ONE}\\n${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM flattened onto one line',
    input: `KEY_DUMP -----BEGIN PRIVATE KEY----- ${PEM_LINE_ONE} ${PEM_LINE_TWO} -----END PRIVATE KEY----- done`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM flattened and truncated',
    input: `KEY_DUMP -----BEGIN PRIVATE KEY----- ${PEM_LINE_ONE} ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM body glued to the marker',
    input: '-----BEGIN PRIVATE KEY-----SYNTHETICPEMGLUED',
    secrets: ['SYNTHETICPEMGLUED'],
  },
  {
    name: 'PEM encrypted and truncated',
    input: `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,SYNTHETICIV\n\n${PEM_LINE_TWO}\n[truncated]`,
    secrets: ['SYNTHETICPEMTWO'],
  },
  {
    name: 'OpenSSH key with CRLF',
    input: `-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUSYNTHETICOPENSSH\r\n-----END OPENSSH PRIVATE KEY-----`,
    secrets: ['SYNTHETICOPENSSH'],
  },
  {
    name: 'PEM truncated mid-line',
    input: `-----BEGIN PRIVATE KEY-----\n${PEM_LINE_ONE}\nSYNTHETICPEMPARTIAL... [truncated]`,
    secrets: ['SYNTHETICPEMONE', 'SYNTHETICPEMPARTIAL'],
  },
  // PEM 截断块：正文行前缀与 BEGIN 行前导不同形（L5-P4d 第四轮复查）。b60a61e 的正文字符类接受
  // `/`、`+`、数字与空白，这些写法在它下面都被遮住，新版必须单调安全。
  {
    name: 'PEM truncated, // body lines under a labelled BEGIN comment',
    input: `// Example key: -----BEGIN PRIVATE KEY-----\n// ${PEM_LINE_ONE}\n// ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated, /// doc comment lines',
    input: `/// Example: -----BEGIN PRIVATE KEY-----\n/// ${PEM_LINE_ONE}\n/// ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated, comment lines added in a diff',
    input: `+// key: -----BEGIN PRIVATE KEY-----\n+// ${PEM_LINE_ONE}\n+// ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated, BEGIN in a trailing comment',
    input: `var k = 1 // -----BEGIN PRIVATE KEY-----\n// ${PEM_LINE_ONE}\n// ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated, escaped breaks with // lines',
    input: `const x = '// -----BEGIN PRIVATE KEY-----\\n// ${PEM_LINE_ONE}\\n// ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated, BEGIN leader longer than 80 characters',
    input: `${'x'.repeat(90)} -----BEGIN PRIVATE KEY-----\n// ${PEM_LINE_ONE}\n// ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated, numbered // lines under a labelled BEGIN line',
    input: `12|// key: -----BEGIN PRIVATE KEY-----\n13|// ${PEM_LINE_ONE}\n14|// ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated, # lines under a labelled BEGIN comment',
    input: `# Example: -----BEGIN PRIVATE KEY-----\n# ${PEM_LINE_ONE}\n# ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated, log tag differs from the BEGIN line',
    input: `INFO key: -----BEGIN PRIVATE KEY-----\nINFO ${PEM_LINE_ONE}\nINFO ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated, short word after the marker',
    input: `-----BEGIN PRIVATE KEY----- header\n${PEM_LINE_ONE}\n${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM truncated, prose comment line before the body',
    input: `// -----BEGIN PRIVATE KEY-----\n// returns the parsed key object\n// ${PEM_LINE_ONE}\n// ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  {
    name: 'PEM complete with a short single-line body',
    input: '-----BEGIN PRIVATE KEY-----\nSYNTHETICshort\n-----END PRIVATE KEY-----',
    secrets: ['SYNTHETICshort'],
  },
  {
    name: 'PEM truncated, two body lines on one line',
    input: `-----BEGIN PRIVATE KEY-----\n${PEM_LINE_ONE} ${PEM_LINE_TWO}`,
    secrets: PEM_SECRETS,
  },
  // HOCON / YAML / INI / .env / properties / TOML
  {
    name: 'HOCON block',
    input: 'db.default {\n  user: admin\n  password: SyntheticSecretStaple\n}',
    secrets: ['SyntheticSecretStaple'],
  },
  {
    name: 'YAML mapping',
    input: 'database:\n  password: SYNTHETIC-SECRET-d002\n  host: db',
    secrets: ['SYNTHETIC-SECRET-d002'],
  },
  {
    name: 'YAML PascalCase password',
    input: 'database:\n  password: SyntheticSecretWelcome',
    secrets: ['SyntheticSecretWelcome'],
  },
  {
    name: 'INI section',
    input: '[database]\npassword = SYNTHETIC-SECRET-d004',
    secrets: ['SYNTHETIC-SECRET-d004'],
  },
  {
    name: '.env quoted values',
    input: 'API_TOKEN="SYNTHETIC-SECRET-d005"\nSECRET_KEY=\'SYNTHETIC-SECRET-d006\'',
    secrets: ['SYNTHETIC-SECRET-d005', 'SYNTHETIC-SECRET-d006'],
  },
  {
    name: 'YAML flow mapping across lines',
    input: 'env: {\n    API_TOKEN: SyntheticSecretFlow\n  }',
    secrets: ['SyntheticSecretFlow'],
  },
  {
    name: 'Spring properties',
    input: 'spring.datasource.password=SYNTHETIC-SECRET-d008',
    secrets: ['SYNTHETIC-SECRET-d008'],
  },
  { name: 'TOML', input: 'password = "SYNTHETIC-SECRET-d009"', secrets: ['SYNTHETIC-SECRET-d009'] },
  {
    name: 'k8s stringData',
    input: 'stringData:\n  password: SYNTHETIC-SECRET-d010',
    secrets: ['SYNTHETIC-SECRET-d010'],
  },
  {
    name: 'compose environment list',
    input: 'environment:\n  - POSTGRES_PASSWORD=SYNTHETIC-SECRET-d011',
    secrets: ['SYNTHETIC-SECRET-d011'],
  },
  {
    name: 'YAML value on the next line',
    input: 'secret_key:\n  SYNTHETIC-SECRET-d012',
    secrets: ['SYNTHETIC-SECRET-d012'],
  },
  {
    name: 'compound key with a PascalCase value',
    input: 'private_key: SyntheticSecretPascal',
    secrets: ['SyntheticSecretPascal'],
  },
  {
    name: 'nested compound key',
    input: 'jwt:\n  secretKey: SyntheticSecretJwt',
    secrets: ['SyntheticSecretJwt'],
  },
  {
    name: 'credentials file',
    input: '[default]\naws_secret_access_key = SYNTHETIC-SECRET-d015',
    secrets: ['SYNTHETIC-SECRET-d015'],
  },
  // JSON 与 JS/Python 对象字面量
  {
    name: 'JSON string',
    input: '{"password": "SYNTHETIC-SECRET-e001", "user": "x"}',
    secrets: ['SYNTHETIC-SECRET-e001'],
  },
  { name: 'JSON number', input: '{"token": 987654321012}', secrets: ['987654321012'] },
  {
    name: 'JS object quoted',
    input: "{ apiKey: 'SYNTHETIC-SECRET-e003', baseUrl: 'x' }",
    secrets: ['SYNTHETIC-SECRET-e003'],
  },
  {
    name: 'JS object bare',
    input: '{ password: SYNTHETIC_SECRET_e004 }',
    secrets: ['SYNTHETIC_SECRET_e004'],
  },
  {
    name: 'JSON array under a compound key',
    input: '{"secretKey": ["SYNTHETIC-SECRET-e005", "x"]}',
    secrets: ['SYNTHETIC-SECRET-e005'],
  },
  {
    name: 'JSON nested credentials',
    input: '{"credentials": {"password": "SYNTHETIC-SECRET-e006"}}',
    secrets: ['SYNTHETIC-SECRET-e006'],
  },
  {
    name: 'JSON object under a sensitive key',
    input: '{"token": {"value": "SYNTHETIC-SECRET-e007"}}',
    secrets: ['SYNTHETIC-SECRET-e007'],
  },
  {
    name: 'sensitive container with an apostrophe in a comment',
    input:
      '{\n  "password": {\n    // don\'t commit\n    "value": "SYNTHETIC-SECRET-e008"\n  }\n}\nconst after = 1;',
    secrets: ['SYNTHETIC-SECRET-e008'],
  },
  {
    name: 'sensitive array with a backtick string',
    input: '{"token": [`SYNTHETIC-SECRET-e009]`, "SYNTHETIC-SECRET-e010"]};',
    secrets: ['SYNTHETIC-SECRET-e009', 'SYNTHETIC-SECRET-e010'],
  },
  {
    name: 'truncated sensitive array',
    input: '{"normal": 1, "password": ["SYNTHETIC-SECRET-e011", "SYNTHETIC-SECRET-e',
    secrets: ['SYNTHETIC-SECRET-e011', 'SYNTHETIC-SECRET-e'],
  },
  {
    name: 'Python dict',
    input: "{'password': 'SYNTHETIC-SECRET-e012'}",
    secrets: ['SYNTHETIC-SECRET-e012'],
  },
  {
    name: 'Basic credential in a template literal',
    input: 'headers: { Authorization: `Basic U1lOVEhFVElDU0VDUkVUZTAxMw==` }',
    secrets: ['U1lOVEhFVElDU0VDUkVUZTAxMw'],
  },
  {
    name: 'Ruby hash',
    input: 'password: "SYNTHETIC-SECRET-e014"',
    secrets: ['SYNTHETIC-SECRET-e014'],
  },
  {
    name: 'Python keyword argument',
    input: 'connect(user="x", password="SYNTHETIC-SECRET-e015")',
    secrets: ['SYNTHETIC-SECRET-e015'],
  },
  {
    name: 'escaped quotes inside a JSON tool result',
    input: '{"stdout": "password=\\"SYNTHETIC-SECRET-e016\\""}',
    secrets: ['SYNTHETIC-SECRET-e016'],
  },
  {
    name: 'string constant in source',
    input: 'const apiKey = "SYNTHETIC-SECRET-e017";',
    secrets: ['SYNTHETIC-SECRET-e017'],
  },
  {
    name: 'receiver assignment of a literal',
    input: "this.token = 'SYNTHETIC-SECRET-e018';",
    secrets: ['SYNTHETIC-SECRET-e018'],
  },
  // 引号与反引号混排
  {
    name: 'backtick-quoted value',
    input: 'password = `SYNTHETIC-SECRET-f001`',
    secrets: ['SYNTHETIC-SECRET-f001'],
  },
  {
    name: 'double quotes holding an apostrophe',
    input: 'token: "SYNTHETIC-SECRET-f002\'tail"',
    secrets: ['SYNTHETIC-SECRET-f002'],
  },
  {
    name: 'single quotes holding a double quote',
    input: "password='SYNTHETIC-SECRET-f003\"x'",
    secrets: ['SYNTHETIC-SECRET-f003'],
  },
  {
    name: 'JSON key with a backtick value',
    input: '"password": `SYNTHETIC-SECRET-f004`',
    secrets: ['SYNTHETIC-SECRET-f004'],
  },
  {
    name: 'assignment inside an echoed string',
    input: 'echo "password=\'SYNTHETIC-SECRET-f005\'"',
    secrets: ['SYNTHETIC-SECRET-f005'],
  },
  // 前面有注释、字符串里的落单括号或类代码块时的 PascalCase 口令
  {
    name: 'YAML after a comment with an unclosed paren',
    input: '# Database settings (see docs\ndatabase:\n  password: SyntheticSecretParen',
    secrets: ['SyntheticSecretParen'],
  },
  {
    name: 'YAML after a string holding a lone brace',
    input: 'pattern: "^\\\\{"\ndatabase:\n  password: SyntheticSecretBrace',
    secrets: ['SyntheticSecretBrace'],
  },
  {
    name: 'heredoc YAML in a shell function',
    input: 'setup() {\n  cat > app.yml <<EOF\ndb:\n  password: SyntheticSecretHeredoc\nEOF\n}',
    secrets: ['SyntheticSecretHeredoc'],
  },
  {
    name: 'log line dumping a config block',
    input: 'INFO Loaded config {\n  host: db\n  password: SyntheticSecretLog\n}',
    secrets: ['SyntheticSecretLog'],
  },
  {
    name: 'call arguments in a log line',
    input: 'connect(host: db, password: SyntheticSecretCall)',
    secrets: ['SyntheticSecretCall'],
  },
  {
    name: 'generated toString of a class',
    input: 'class Credentials {\n    username: admin\n    password: SyntheticSecretPet\n}',
    secrets: ['SyntheticSecretPet'],
  },
  {
    name: 'brace in a string keeps an interface open',
    input: 'interface Pattern {\n  re: "{";\n}\ndb:\n  password: SyntheticSecretAfter',
    secrets: ['SyntheticSecretAfter'],
  },
  {
    name: 'JS object with a comment holding an unclosed paren',
    input: 'const config = {\n  // TODO (rotate\n  password: SyntheticSecretCode,\n};',
    secrets: ['SyntheticSecretCode'],
  },
  {
    name: 'markdown table cell',
    input: '| password: SyntheticSecretCell | x |',
    secrets: ['SyntheticSecretCell'],
  },
  {
    name: 'prose with a modifier word',
    input: 'Set the private password: SyntheticSecretProse',
    secrets: ['SyntheticSecretProse'],
  },
  {
    name: 'YAML key starting with a modifier word',
    input: 'private password: SyntheticSecretYaml',
    secrets: ['SyntheticSecretYaml'],
  },
  {
    name: 'initializer without a declaration',
    input: 'password: SyntheticSecretInit = None',
    secrets: ['SyntheticSecretInit'],
  },
  {
    name: 'union-looking tail',
    input: 'password: SyntheticSecretUnion | None',
    secrets: ['SyntheticSecretUnion'],
  },
  {
    name: 'type alias words in prose',
    input: 'Please type password = SyntheticSecretTyped',
    secrets: ['SyntheticSecretTyped'],
  },
];

const SOURCE_CASES: SourceCase[] = [
  // TS 联合/交叉类型别名（名字以 Token/Secret/Password/ApiKey 结尾，Prettier 多行与单行写法）
  {
    name: 'multi-line union Token',
    input: "export type Token =\n  | { kind: 'a' }\n  | { kind: 'b' };",
  },
  {
    name: 'multi-line union GlobToken',
    input: "type GlobToken =\n  | { kind: 'literal'; char: string }\n  | { kind: 'star' };",
  },
  {
    name: 'multi-line union ClientSecret',
    input:
      "export type ClientSecret =\n  | { kind: 'inline'; value: string }\n  | { kind: 'file'; path: string };",
  },
  {
    name: 'multi-line union Password',
    input: 'type Password =\n  | PlainPassword\n  | HashedPassword;',
  },
  {
    name: 'multi-line intersection ApiKey',
    input: 'export type ApiKey =\n  & BaseKey\n  & { scope: string };',
  },
  { name: 'leading-bar single-line union', input: 'type Password = | A | B;' },
  { name: 'nullable alias', input: 'type SessionToken = string | null;' },
  { name: 'opaque alias', input: 'export type RefreshToken = OpaqueToken;' },
  { name: 'branded alias', input: "export type ApiKey = Brand<string, 'ApiKey'>;" },
  { name: 'literal union alias', input: "type AuthToken = 'bearer' | 'basic';" },
  // 变量赋值为标识符、成员链或调用
  { name: 'call initializer', input: 'const token = getToken();' },
  { name: 'member initializer', input: 'const apiKey = config.apiKey;' },
  { name: 'await initializer', input: "let password = await prompt('Pin');" },
  { name: 'receiver assignment', input: 'this.password = password;' },
  { name: 'Python receiver assignment', input: 'self.token = token' },
  { name: 'process.env initializer', input: 'const secretKey = process.env.SECRET_KEY;' },
  { name: 'object property from receiver', input: '      apiKey: this.apiKey,' },
  { name: 'object property from env', input: '  apiKey: process.env.OPENAI_API_KEY,' },
  { name: 'subscript initializer', input: 'const token = tokens[index];' },
  { name: 'destructuring', input: 'const { token, secret } = credentials;' },
  {
    name: 'typeof initializer',
    input: "const token = typeof value === 'number' ? String(value) : undefined;",
  },
  { name: 'new initializer', input: 'const token = new Token();' },
  // 模板字符串插值与 shell 变量引用
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
  { name: 'template URL', input: 'const url = `postgres://${user}:${password}@${host}/db`;' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
  { name: 'template query string', input: 'const url = `${base}?token=${token}`;' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
  { name: 'template Bearer header', input: '      { Authorization: `Bearer ${this.apiKey}` },' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
  { name: 'template message', input: 'const message = `password: ${password}`;' },
  { name: 'f-string URL', input: 'url = f"postgresql://{user}:{password}@{host}:{port}/{db}"' },
  { name: 'shell URL', input: 'DSN="mysql://$DB_USER:$DB_PASS@localhost/app"' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
  { name: 'shell brace reference', input: 'export API_TOKEN=${CI_API_TOKEN}' },
  { name: 'shell command substitution', input: 'PASSWORD=$(cat /run/secrets/db_password)' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
  { name: 'Actions expression', input: 'token: ${{ secrets.GITHUB_TOKEN }}' },
  {
    name: 'shell Bearer reference',
    input: 'curl -H "Authorization: Bearer $API_TOKEN" https://api.example',
  },
  { name: 'shell test', input: 'if [ -z "$PASSWORD" ]; then' },
  { name: 'Jinja URL', input: 'url: https://{{user}}:{{password}}@registry.example/v2' },
  {
    name: 'template URL with a member chain and a suffix',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
    input: 'const dsn = `redis://:${process.env.REDIS_PASSWORD}${suffix}@cache:6379`;',
  },
  {
    name: 'template URL with an encoded reference',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的源码文本里的插值占位符，不是模板串。
    input: 'const url = `postgres://${user}:${encodeURIComponent(password)}@${host}/db`;',
  },
  {
    name: 'compose URL with pure references',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被脱敏的配置文本里的 shell 变量引用，不是模板串。
    input: 'DATABASE_URL: postgres://${DB_USER}:${DB_PASS}@db:5432/app',
  },
  {
    name: 'Helm URL with value references and a bare filter',
    input: 'url: postgres://{{.Values.db.user}}:{{db_password|urlencode}}@db/app',
  },
  // 比较、箭头与作用域运算符
  { name: 'strict comparison', input: 'if (token === null) return;' },
  { name: 'loose comparison', input: 'const isSame = secret == other;' },
  { name: 'negated comparison', input: 'if (password !== confirm) {' },
  { name: 'glued comparison', input: 'if (token==null) {' },
  { name: 'arrow function', input: 'items.map((token) => token.trim());' },
  { name: 'glued arrow function', input: 'items.map(token=>token.trim());' },
  { name: 'relational comparison', input: 'return token >= limit;' },
  { name: 'scope operator', input: 'use auth::token::Claims;' },
  { name: 'Go short declaration', input: 'token := nextToken()' },
  // 类型注解与声明
  {
    name: 'interface members',
    input: 'interface Auth {\n  token: Token;\n  apiKey: ApiKey;\n  password: Password;\n}',
  },
  {
    name: 'function signature',
    input: 'function login(password: Password, token: Token): Session {',
  },
  { name: 'Python signature', input: 'def login(password: str) -> bool:' },
  { name: 'Rust signature', input: 'fn check(password: &str) -> bool' },
  {
    name: 'class private member',
    input: 'class Session {\n  private token: Token\n  readonly secret: Secret\n}',
  },
  { name: 'case label', input: 'switch (kind) { case token: break; }' },
  { name: 'ternary', input: 'const value = useCache ? token : await fetchToken();' },
  // 私钥标记出现在源码与文档里
  { name: 'PEM header constant', input: "const header = '-----BEGIN PRIVATE KEY-----';" },
  {
    name: 'PEM marker in a comment before code',
    input: '# Strip the -----BEGIN PRIVATE KEY----- header\ndef strip(pem):\n    return pem',
  },
  {
    name: 'numbered PEM marker comment before code',
    input: '10|# -----BEGIN PRIVATE KEY-----\n11|def strip(pem):\n12|    return pem',
  },
  {
    name: 'PEM marker docstring',
    input: '"""Load a -----BEGIN RSA PRIVATE KEY----- file\n\n    Returns the key object\n"""',
  },
  {
    name: 'PEM placeholder in docs',
    input: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
  },
  {
    name: 'PEM marker comment followed by prose',
    input: '// -----BEGIN PRIVATE KEY-----\n// returns the parsed key object',
  },
  {
    name: 'labelled PEM marker comment followed by prose and code',
    input:
      '// Example: -----BEGIN PRIVATE KEY-----\n// returns the parsed key object\nexport function parse() {}',
  },
  {
    name: 'docstring naming both PEM markers on different lines',
    input:
      '    """Parse a PEM file.\n\n    The file must start with -----BEGIN PRIVATE KEY-----\n    and end with -----END PRIVATE KEY-----.\n    """',
  },
  {
    name: 'PEM marker comment followed by a banner line',
    input: '# -----BEGIN PRIVATE KEY-----\n# ================\ndef strip(pem):',
  },
  // 非敏感 JSON 与元数据键
  {
    name: 'non-sensitive JSON',
    input: '{"passwordHash": "kept", "tokenCount": 7, "publicKey": "kept"}',
  },
  { name: 'key file path', input: "const PRIVATE_KEY_FILE = 'signing-key.pk8';" },
  {
    name: 'k8s secretKeyRef',
    input:
      'env:\n  - name: AWS_SECRET\n    valueFrom:\n      secretKeyRef:\n        name: aws\n        key: secret',
  },
];

/** JSON 载体：工具结果通常以 JSON 序列化后进入台账，内层文本须得到同样的处理。 */
function inCarrier(input: string): string {
  return JSON.stringify({ stdout: input, status: 'success' });
}

const CARRIERS: ReadonlyArray<{ carrier: string; wrap: (input: string) => string }> = [
  { carrier: 'raw', wrap: (input) => input },
  { carrier: 'JSON carrier', wrap: inCarrier },
];

const credentialRows = CARRIERS.flatMap(({ carrier, wrap }) =>
  CREDENTIAL_CASES.map((entry) => ({ ...entry, carrier, input: wrap(entry.input) }))
);
const sourceRows = CARRIERS.flatMap(({ carrier, wrap }) =>
  SOURCE_CASES.map((entry) => ({ ...entry, carrier, input: wrap(entry.input) }))
);

describe('redaction differential safety: credential shapes (A) — monotonic gate', () => {
  test.each(
    credentialRows
  )('never leaks what any of the four baselines masked: $name ($carrier)', ({ input, secrets }) => {
    const output = redactDeveloperText(input);
    for (const secret of secrets) {
      const maskedBy = BASELINES.filter(({ redact }) => !redact(input).includes(secret)).map(
        ({ revision }) => revision
      );
      if (maskedBy.length > 0) {
        expect(output, `${secret} was masked by ${maskedBy.join(', ')}`).not.toContain(secret);
      }
    }
    expect(redactDeveloperText(output)).toBe(output);
    assertNoLegacyRegression(input);
  });

  test('the monotonic gate is exercised by every baseline', () => {
    // 防止基线导入失效或语料退化成空转：四个版本都必须各自遮住一部分合成秘密，且彼此是不同的实现。
    const pairs = CREDENTIAL_CASES.flatMap(({ input, secrets }) =>
      secrets.map((secret) => ({ input, secret }))
    );
    const maskedCounts = BASELINES.map(
      ({ redact }) => pairs.filter(({ input, secret }) => !redact(input).includes(secret)).length
    );
    for (const [position, { revision }] of BASELINES.entries()) {
      expect(maskedCounts[position], revision).toBeGreaterThan(pairs.length / 5);
    }
    expect(new Set(maskedCounts).size).toBeGreaterThan(1);
    // b60a61e 新增了 PEM 与 URL 规则，覆盖面最大。
    expect(maskedCounts[3]).toBeGreaterThan(maskedCounts[2] ?? 0);
  });
});

describe('redaction differential safety: source shapes (B) — cost report only', () => {
  test('reports which source shapes the phase-1 floor rewrites (D2), without asserting verbatim output', ({
    annotate,
  }) => {
    const rewritten = sourceRows.filter(({ input }) => redactDeveloperText(input) !== input);
    for (const { input } of sourceRows) {
      const output = redactDeveloperText(input);
      // 代价报告只要求结构性质：幂等、换行守恒。是否逐字由 D2 接受为阶段 1 的误伤，不作断言。
      expect(redactDeveloperText(output)).toBe(output);
      expect(output.replace(/[^\r\n]/g, '')).toBe(input.replace(/[^\r\n]/g, ''));
    }
    void annotate(
      `phase-1 floor rewrites ${rewritten.length}/${sourceRows.length} source rows: ${rewritten
        .map(({ name, carrier }) => `${name} (${carrier})`)
        .join('; ')}`
    );
    expect(rewritten.length).toBeLessThanOrEqual(sourceRows.length);
  });
});
