/**
 * 证据来源文件分类表（脱敏阶段 2 / 方案 C，设计 redaction-design-2026-10-19 第 4.5 节）。
 *
 * 用途：决定循环台账里哪些条目允许在 evidence.get 时回读文件原文。
 * - secret-bearing：凭据类文件。循环采集时丢弃 range（EvidenceCapture），evidence.get 一律不回读；
 * - source：源码。带 range 的 code.read 条目在 fresh 时回读原文；
 * - config 与其他：其余全部（含无扩展名、无法识别的文件）。方案 C 下同样允许回读——落盘仍脱敏，
 *   回读只把模型本来就能经 code.read 看到的当前原文交回模型通道，不新增静态副本。
 *
 * 分类只依据可信元数据：code.read 已在项目根内解析过的路径、code.search 的匹配文件。terminal 条目
 * 的 file 取自命令 token（EvidenceCapture 兜底分支的词法猜测），不可信，一律按终端处理。
 *
 * 优先级从高到低：secret-bearing（名称优先）> source（扩展名表）> config 与其他。名称优先指基名
 * 按分词含 secret(s)/credential(s)/password(s)/passwd 时不论扩展名都归 secret-bearing（例如
 * `secrets.ts`）；`token(s)` 只对非源码扩展名生效，避免 `TokenBudget.ts` 这类源码被误归。
 *
 * 规则写成数据，每条带正例与反例，由 test/evidence-file-class.test.ts 逐条校验。判定全部按小写
 * 比较：secret-bearing 是从严方向，大小写不敏感的文件系统上 `.ENV` 就是 `.env`。
 * 本模块是纯函数与只读常量，没有模块级可变状态。
 */
import path from 'node:path';

export type EvidenceFileClass = 'secret-bearing' | 'source' | 'config';

/** 条目来源类别：terminal 条目与没有 file 的条目不进入文件分类表。 */
export type EvidenceSourceClass = EvidenceFileClass | 'terminal' | 'no-file';

interface SecretBearingRuleBase {
  readonly id: string;
  readonly description: string;
  /** 必须归入 secret-bearing 且由本规则命中的路径 */
  readonly examples: readonly string[];
  /** 必须不归入 secret-bearing 的路径（也不被本规则命中） */
  readonly negativeExamples: readonly string[];
}

/** 规则的五种形态；pattern 一律作用于小写基名，不带 g/y 标志（test() 不依赖 lastIndex）。 */
export type SecretBearingFileRule =
  | (SecretBearingRuleBase & { readonly kind: 'basename'; readonly pattern: RegExp })
  | (SecretBearingRuleBase & { readonly kind: 'extension'; readonly values: readonly string[] })
  | (SecretBearingRuleBase & {
      readonly kind: 'directory-segment';
      readonly values: readonly string[];
    })
  | (SecretBearingRuleBase & { readonly kind: 'name-token'; readonly values: readonly string[] })
  | (SecretBearingRuleBase & {
      /** 只在扩展名不属于源码表时生效（设计：token 只对配置类扩展名生效） */
      readonly kind: 'config-name-token';
      readonly values: readonly string[];
    });

export const SECRET_BEARING_FILE_RULES: readonly SecretBearingFileRule[] = Object.freeze([
  {
    id: 'env-file',
    kind: 'basename',
    pattern: /^\.env(?:\..+)?$/u,
    description: '.env 与 .env.*（含 .env.example 等模板，从严）',
    examples: ['.env', 'apps/web/.env.local', '.env.production.local', '.env.example'],
    negativeExamples: ['src/env.ts', 'docs/environment.md', 'config/.envoy.yaml'],
  },
  {
    id: 'npmrc',
    kind: 'basename',
    pattern: /^\.npmrc$/u,
    description: 'npm 认证配置',
    examples: ['.npmrc', 'packages/app/.npmrc'],
    negativeExamples: ['docs/npmrc-guide.md'],
  },
  {
    id: 'pypirc',
    kind: 'basename',
    pattern: /^\.pypirc$/u,
    description: 'PyPI 上传凭据',
    examples: ['.pypirc'],
    negativeExamples: ['docs/pypirc-guide.md'],
  },
  {
    id: 'netrc',
    kind: 'basename',
    pattern: /^[._]netrc$/u,
    description: '.netrc / _netrc',
    examples: ['.netrc', '_netrc'],
    negativeExamples: ['src/netrc_parser.py'],
  },
  {
    id: 'pgpass',
    kind: 'basename',
    pattern: /^\.pgpass$/u,
    description: 'PostgreSQL 口令文件',
    examples: ['.pgpass'],
    negativeExamples: ['docs/pgpass.md'],
  },
  {
    id: 'htpasswd',
    kind: 'basename',
    pattern: /^\.htpasswd$/u,
    description: 'HTTP basic auth 口令文件',
    examples: ['.htpasswd', 'deploy/nginx/.htpasswd'],
    negativeExamples: ['docs/htpasswd.md'],
  },
  {
    id: 'git-credentials',
    kind: 'basename',
    pattern: /^\.git-credentials$/u,
    description: 'git credential store',
    examples: ['.git-credentials'],
    negativeExamples: ['.gitconfig'],
  },
  {
    id: 'credentials-file',
    kind: 'basename',
    pattern: /^credentials/u,
    description: 'credentials*',
    examples: ['credentials', 'config/credentials.json', 'config/credentials.yml.enc'],
    negativeExamples: ['src/credentialing.ts'],
  },
  {
    id: 'ssh-key-name',
    kind: 'basename',
    pattern: /^id_(?:rsa|dsa|ecdsa|ed25519)/u,
    description: 'id_rsa* / id_dsa* / id_ecdsa* / id_ed25519*',
    examples: ['id_rsa', 'deploy/id_ed25519', 'id_rsa.pub', 'id_ecdsa_sk', 'id_dsa'],
    negativeExamples: ['src/ids.ts', 'src/identity.ts'],
  },
  {
    id: 'kubeconfig',
    kind: 'basename',
    pattern: /^kubeconfig$/u,
    description: 'kubeconfig',
    examples: ['kubeconfig', 'deploy/kubeconfig'],
    negativeExamples: ['docs/kubeconfig-setup.md'],
  },
  {
    id: 'terraform-state',
    kind: 'basename',
    pattern: /\.tfstate/u,
    description: '*.tfstate*',
    examples: ['terraform.tfstate', 'infra/terraform.tfstate.backup'],
    negativeExamples: ['infra/main.tf'],
  },
  {
    id: 'terraform-vars',
    kind: 'basename',
    pattern: /\.tfvars$/u,
    description: '*.tfvars',
    examples: ['prod.tfvars', 'infra/staging.auto.tfvars'],
    negativeExamples: ['infra/variables.tf'],
  },
  {
    id: 'key-material-extension',
    kind: 'extension',
    values: ['.pem', '.key', '.p8', '.p12', '.pfx', '.jks', '.keystore', '.ppk'],
    description: '私钥、证书库与密钥容器扩展名',
    examples: [
      'certs/server.pem',
      'tls/server.key',
      'AuthKey_SYNTHETIC.p8',
      'client.p12',
      'store.pfx',
      'app.jks',
      'android/release.keystore',
      'keys/putty.ppk',
    ],
    negativeExamples: ['src/keyboard.ts', 'docs/keys.md', 'src/key.ts'],
  },
  {
    id: 'credential-directory',
    kind: 'directory-segment',
    values: ['.ssh', '.aws', 'secrets', '.secrets'],
    description: '路径中含 .ssh/、.aws/、secrets/、.secrets/ 目录段',
    examples: ['.ssh/config', 'home/.aws/config', 'deploy/secrets/app.yml', '.secrets/value.txt'],
    negativeExamples: ['src/secret/a.ts', 'src/ssh/client.ts', 'src/aws/client.ts'],
  },
  {
    id: 'credential-name-token',
    kind: 'name-token',
    values: ['secret', 'secrets', 'credential', 'credentials', 'password', 'passwords', 'passwd'],
    description: '名称优先：基名分词含 secret(s)/credential(s)/password(s)/passwd，不论扩展名',
    examples: [
      'src/secrets.ts',
      'lib/secret_key.rb',
      'app/ui/PasswordField.tsx',
      'config/db-passwords.yaml',
      'etc/passwd',
    ],
    negativeExamples: ['src/passwordless.ts', 'src/secretariat.ts', 'src/agent/utils/Redaction.ts'],
  },
  {
    id: 'token-config-name',
    kind: 'config-name-token',
    values: ['token', 'tokens'],
    description: '基名分词含 token(s) 且扩展名不在源码表',
    examples: ['config/token.json', '.token', 'deploy/api-tokens.yaml', 'scripts/refresh-token.sh'],
    negativeExamples: ['src/TokenBudget.ts', 'lib/tokenizer.py', 'src/tokens.ts'],
  },
] satisfies readonly SecretBearingFileRule[]);

/** 源码扩展名（不带点）。shell、Dockerfile、Makefile、SQL、HTML、Markdown、txt 不算源码。 */
export const EVIDENCE_SOURCE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'pyi',
  'java',
  'kt',
  'kts',
  'scala',
  'go',
  'rs',
  'swift',
  'm',
  'mm',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'cs',
  'rb',
  'php',
  'dart',
  'lua',
  'ex',
  'exs',
]);

export interface EvidenceFileClassification {
  readonly fileClass: EvidenceFileClass;
  /** 命中的 secret-bearing 规则 id（按表序）；不是 secret-bearing 时为空，供诊断说明判定依据 */
  readonly matchedRuleIds: readonly string[];
}

interface EvidencePathView {
  readonly lowerBasename: string;
  readonly lowerDirectories: readonly string[];
  /** 小写扩展名，含点（`.ts`）；点文件与无扩展名为 '' */
  readonly extension: string;
  readonly nameTokens: readonly string[];
}

/**
 * 路径归一：反斜杠按分隔符处理（Windows 风格的工具路径），去掉空段与 `.` 段。`..` 段保留——
 * 越出项目根由回读侧的 resolveProjectPath 拒绝，分类表不负责路径安全。
 */
function toPathView(file: string): EvidencePathView | null {
  const segments = file
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.');
  const basename = segments.at(-1);
  if (!basename) {
    return null;
  }
  const lowerBasename = basename.toLowerCase();
  return {
    lowerBasename,
    lowerDirectories: segments.slice(0, -1).map((segment) => segment.toLowerCase()),
    extension: path.posix.extname(lowerBasename),
    nameTokens: splitNameTokens(basename),
  };
}

/**
 * 基名分词：先在驼峰边界（`apiTokens`、`DBPassword`）插入分隔，再按非字母数字切分并转小写。
 * 分词按整词比较，`passwordless`、`secretariat` 不会命中 `password`、`secret`。
 */
function splitNameTokens(basename: string): string[] {
  return basename
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function isSourceExtension(extension: string): boolean {
  return extension.length > 1 && EVIDENCE_SOURCE_FILE_EXTENSIONS.has(extension.slice(1));
}

function ruleMatches(rule: SecretBearingFileRule, view: EvidencePathView): boolean {
  switch (rule.kind) {
    case 'basename':
      return rule.pattern.test(view.lowerBasename);
    case 'extension':
      return rule.values.includes(view.extension);
    case 'directory-segment':
      return view.lowerDirectories.some((segment) => rule.values.includes(segment));
    case 'name-token':
      return view.nameTokens.some((token) => rule.values.includes(token));
    case 'config-name-token':
      return (
        !isSourceExtension(view.extension) &&
        view.nameTokens.some((token) => rule.values.includes(token))
      );
  }
}

/** 分类并给出命中的规则 id；空路径归 config 且不命中任何规则。 */
export function explainEvidenceFileClass(file: string): EvidenceFileClassification {
  const view = toPathView(file);
  if (!view) {
    return { fileClass: 'config', matchedRuleIds: [] };
  }
  const matchedRuleIds = SECRET_BEARING_FILE_RULES.filter((rule) => ruleMatches(rule, view)).map(
    (rule) => rule.id
  );
  if (matchedRuleIds.length > 0) {
    return { fileClass: 'secret-bearing', matchedRuleIds };
  }
  return {
    fileClass: isSourceExtension(view.extension) ? 'source' : 'config',
    matchedRuleIds: [],
  };
}

export function classifyEvidenceFile(file: string): EvidenceFileClass {
  return explainEvidenceFileClass(file).fileClass;
}

/**
 * 条目来源分类：terminal 条目一律按终端处理（file 不可信），没有 file 的条目为 no-file，
 * 其余按文件分类表。tool 缺席时按文件判定（宽进：分类表本身从严）。
 */
export function classifyEvidenceSource(source: {
  readonly tool?: string;
  readonly file?: string;
}): EvidenceSourceClass {
  if (source.tool === 'terminal.exec') {
    return 'terminal';
  }
  if (!source.file) {
    return 'no-file';
  }
  return classifyEvidenceFile(source.file);
}
