/**
 * 脱敏阶段 4e：T3 按来源追加（设计 redaction-design-2026-10-19 第 4.4 节 T3、第 4.5 节通道表、不变量 A）。
 *
 * 作用范围：只在带来源的台账条目上生效。生产接线是 ProductionEvidenceLedgerAuthority 为默认 profile 注入的
 * 带上下文 redactor（EvidenceLedgerStore#transform 推出 tool/file/range）；开发者事件、诊断、stderr 仍走
 * redactDeveloperText（未知来源），见证 profile 不注入任何 redactor。
 *
 * 来源分类复用 evidence/evidenceFileClass.ts（名称优先规则；terminal 条目一律按终端处理，因为它的 file 取自命令
 * token，不可信）。T3 只对两类来源有规则：
 * - secret-bearing：文件里每个取值都遮（键名、注释结构、空值与纯容器开符保留）；.netrc 形态的 password v。
 * - terminal：env 形态 KEY=VALUE 中键里任意位置出现敏感词的值；curl -v 的 `> Authorization:` 一类认证头；
 *   kubectl get secret -o yaml 中 data:/stringData: 下的值；.netrc 形态的 password v（D10：只在这两类来源生效）。
 * source、config、no-file 与未知来源没有 T3 规则，输出与 redactDeveloperText 逐字相同。
 *
 * 只增（不变量 A）：同一文本在任何来源上下文下的遮蔽都 ⊇ 未知来源下的遮蔽。实现是构造性的：
 * 1. T3 区间在原文上计算（禁止串接）；该来源有 T3 规则时跑一遍未知来源底线（T3 在原文上有命中时带逐字符来源），
 *    得到它遮住的输入位置 hidden_u（快路径判定与合并路径的种子共用这一遍；没有命中却要走合并路径的罕见情形再带
 *    来源补跑一遍，第一轮经共享复用，结果逐位相同）；
 * 2. 合并路径：T3 区间与底线、检测器挂点取并集，hidden_u 作为第一轮的“种子”区间一并并入，之后每轮只会遮得更多，
 *    所以最终遮蔽 ⊇ hidden_u，无论多轮不动点的组合是否单调；
 * 3. 两条精确的快路径（直接返回未知来源结果，不跑第二遍）：T3 在原文上没有命中（no-span），或命中的区间都已被
 *    未知来源遮住（covered）；两者都要求未知来源一轮收敛、T3 在未知来源输出上只落在已有标记内，此时带来源的
 *    运行与未知来源运行每一轮的遮蔽集合相同，输出逐字相同。
 * 规则表没有任何“减规则”的分支：规则只产出要遮的区间，不产出放行区间。
 * 合并路径与未知来源底线从同一原文开始，第一轮的版本部分（四个版本的重放、位掩码、缺口、失配行、结构分析）经
 * legacyFloor 的 replayShare 只算一次（按次新建，不是模块级状态），所以带来源的调用相对未知来源门面只多出：原文上
 * 一遍 T3 扫描、一次按位置渲染，以及对合并输出的一次不动点确认（四个冻结版本各一遍、T3 再一遍；这是幂等的保证）。
 * 未知来源底线本身（即门面）必须完整跑完，A 的种子要它的最终遮蔽，所以台账入口的耗时下限是“门面 + 上述额外开销”。
 *
 * 每条规则是数据 {id, tier:'T3', sources, pattern, examples[], negativeExamples[]}，由
 * test/redaction-source-policy.test.ts 逐条校验（正例中秘密的任何不短于 4 字符的片段不得出现在输出里，反例逐字
 * 保留）。规则只产出值区间：不遮键名、分隔符和包围值的引号，所以渲染沿用现有标记词表、不写新标记。
 * 全部是纯函数与只读常量，没有模块级可变状态；模块级带 g 标志的正则只经 String#matchAll 使用（不改写 lastIndex）。
 * env 与 HTTP 头两条终端规则的匹配不再用正则逐位置试探（复查实测它们是终端扫描的主要开销），改为按 = 与 < > 的
 * 出现位置线性定位（nextEnvAssignment、verboseHeaderMatches），与声明的 pattern 逐个匹配相同，由测试用模糊语料比对。
 * 跳过（未知来源、该来源没有规则、规则没有命中、命中但已被底线覆盖）与合并路径都写进 SourcePolicyReport（只含
 * 计数与种类，不含正文），由有日志通道的调用方记录。预过滤只决定某条规则是否运行，跳过只意味着不追加。
 *
 * 线性：病态长行不回溯；同一行上大量匹配复用终点缓存、行尾缓存与双引号闭合表，每个字符只扫常数次；各规则的
 * 区间排序合并成互不相交的并集后才交给下游（底线检测器挂点、标记过滤、新增字符计数）逐字符消费。
 * 性能口径（总控裁定 2026-10-22，在 D13 内）：4f 之前台账入口断言 T3 密集形态线性、相对门面的额外开销
 * ≤5 个 HEAD（test/redaction-source-policy-performance.test.ts），第一轮版本部分复用由
 * test/redaction-source-policy-replay-share.test.ts 计数钉住；门面本身已近 8 倍的形态只报告台账入口总倍数，
 * D13 的 ≤4× 在 4f 对门面与台账入口一并验收。
 *
 * 与 T1 检测器（阶段 4b，legacyFloor 的默认检测器表）的组合：未知来源底线就是门面，含 T1；合并路径原样保留未知来源
 * 的检测器表，T3 区间与种子经 legacyFloor 的 sourceDetectors 并入——同轮并入、不串接，且不按 v0/v1 级联触发前缀
 * 切开（T1 为门面层的 A 保留触发前缀；这里的 A 由第一轮整段并入的种子构造性保证）。
 */
import {
  classifyEvidenceSource,
  type EvidenceSourceClass,
} from '../../evidence/evidenceFileClass.js';
import {
  applyRedactionFloor,
  applyRedactionFloorWithProvenance,
  createFloorReplayShare,
  type FloorDetector,
  type FloorResult,
  type ProvenanceResult,
  type RedactionFloorOptions,
} from './legacyFloor.js';
import { markerCores } from './render.js';

/** 条目来源上下文：取自台账草稿或条目的可信元数据（EvidenceRedactionContext 可直接赋值）。 */
export interface RedactionSourceContext {
  readonly tool?: string;
  readonly file?: string;
}

/** 来源类别：台账来源分类表的类别，另加没有任何上下文的 unknown（开发者事件通道）。 */
export type RedactionSourceClass = EvidenceSourceClass | 'unknown';

/** T3 规则可以声明的来源。 */
export type SourcePolicySource = 'terminal' | 'secret-bearing';

export interface SourcePolicyExample {
  readonly text: string;
  /** 必须被完全遮住的合成秘密（任何不短于 4 字符的片段都不得出现在输出里）。 */
  readonly secrets: readonly string[];
  /** 正例需要的工具上下文（例如 code.search 的 `NN: ` 代理前缀）；缺省按来源的代表上下文。 */
  readonly tool?: string;
}

/** 扫描器种类：每种对应一个只产出值区间的纯函数。 */
type SourcePolicyMatcher =
  | 'secret-bearing-values'
  | 'env-assignment'
  | 'verbose-http-header'
  | 'kubernetes-secret-data'
  | 'netrc-password';

export interface SourcePolicyRule {
  readonly id: string;
  readonly tier: 'T3';
  readonly sources: readonly SourcePolicySource[];
  readonly description: string;
  readonly matcher: SourcePolicyMatcher;
  /**
   * 规则的声明形态，供审阅与测试。env、HTTP 头、netrc 扫描器直接用它；secret-bearing 键值行与 kubectl 子行
   * 按同一语义线性解析（parseKeyValueHead），kubectl 的 pattern 是数据块父行。
   */
  readonly pattern: RegExp;
  /** 文档级前提（不带 g/y 标志，只用 test()，全部满足才运行；每条都是线性匹配，不跨行回溯）。 */
  readonly gates: readonly RegExp[];
  /**
   * 预过滤：文本含其中任一子串（区分大小写，与扫描器自身的大小写口径一致）才运行本规则，避免对全文跑无关的
   * 正则；空表示总是运行。不再为预过滤生成整篇小写副本。
   */
  readonly triggers: readonly string[];
  readonly examples: readonly SourcePolicyExample[];
  /** 规则列出的每个来源下都必须逐字保留的文本（四个历史版本也都不改写它们）。 */
  readonly negativeExamples: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// 规则使用的正则（全部只读；g 标志的只经 matchAll 使用，或按次复制成局部正则）
// ---------------------------------------------------------------------------------------------

/**
 * secret-bearing 文件的键值行：可选缩进、可选 YAML 序列标记 `- `，键是双引号串、单引号串或第一个分隔符之前的
 * 任意非空片段（允许空格：`export KEY`、`my key`），分隔符取 `::=`、`:=`、`=`、`:` 中最先出现的一个。
 * 键名保留、只遮分隔符之后的取值，所以 `export`、注释符号等前缀落在键里也不影响安全性。
 * 这条正则是规则的声明形态；扫描器 parseKeyValueHead 按同一语义线性实现（避免病态长行回溯）。
 */
const SECRET_BEARING_KEY_VALUE =
  /^([ \t]*)(?:-[ \t]+)?("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s=:"'][^=:\r\n]*?)[ \t]*(::=|:=|=|:)/;

/** 不含键值分隔符的 YAML 序列项 `- value`：序列项本身就是取值。 */
const SECRET_BEARING_SEQUENCE_ITEM = /^[ \t]*-[ \t]+(\S.*)$/;

/** YAML 块标量指示符（`|`、`>`，可带保留/截断与缩进修饰）：其后更深缩进的行都是取值。 */
const YAML_BLOCK_INDICATOR = /^[|>](?:[+-]?[0-9]?|[0-9][+-])(?:[ \t]+#.*)?$/;

/** 只有容器开符或空容器/空串的取值不含信息，不遮（后续行按各自的形态处理）。 */
const STRUCTURE_ONLY_VALUE = /^(?:\{|\[|\{\}|\[\]|""|'')[ \t]*,?$/;

/**
 * 终端 env 形态：`KEY=VALUE`。KEY 必须位于行首或紧跟空白、`;`、`&`、`|`、`(`、反引号、引号、`=`、`,`、`?`
 * （命令行 `-e KEY=v`、`set -x` 的 `+ export KEY=v`、JSON 数组里的 "KEY=v"、URL 查询串的 `&token=v`）。
 * 前导字符用后行断言、不消耗，所以 `A=TOKEN_B=v` 这类串联写法里后一个键同样会被找到。
 */
const ENV_ASSIGNMENT = /(?<=^|[\s;&|(`'"=,?])([A-Za-z_][A-Za-z0-9_.-]*)=/gm;

/** env 行首前缀：缩进、`set -x` 的 `+ `、export/declare -x/setenv/set/env。只有前缀时取值取到行尾。 */
const ENV_LINE_PREFIX =
  /^[ \t]*(?:\++[ \t]+)?(?:(?:export|setenv|set|env|declare(?:[ \t]+-[A-Za-z]+)*)[ \t]+)?$/;

/** 行首前缀的长度上限（字符）：真实的 env/export/declare 前缀远短于此。 */
const ENV_LINE_PREFIX_MAX = 256;

/** 键里任意位置出现即视为敏感的词（小写子串比较）。 */
const ENV_SENSITIVE_WORDS: readonly string[] = Object.freeze([
  'pass',
  'pwd',
  'secret',
  'token',
  'key',
  'auth',
  'cred',
  'private',
  'cookie',
  'session',
]);

/** curl -v / HTTPie 风格的请求（`>`）与响应（`<`）头行。 */
const VERBOSE_HTTP_HEADER =
  /^[ \t]*[<>][ \t]?([A-Za-z0-9][A-Za-z0-9_-]*)[ \t]*:[ \t]*([^\r\n]*)$/gm;

/** 认证类头名：Authorization、Proxy-Authorization、Cookie、Set-Cookie 以及名字里带凭据词的自定义头。 */
const SENSITIVE_HEADER_NAME = /auth|cookie|token|api-?key|secret|session|password|credential/i;

/** kubectl get secret -o yaml 的文档特征：kind: Secret，或 Secret 专有的 type 取值。 */
const KUBERNETES_SECRET_GATE =
  /^[ \t]*(?:-[ \t]+)?(?:kind:[ \t]*["']?Secret["']?|type:[ \t]*["']?(?:Opaque|kubernetes\.io\/[\w.-]+|bootstrap\.kubernetes\.io\/token)["']?)[ \t]*\r?$/m;

/** KUBERNETES_SECRET_GATE 的必要条件（只含字面量，线性且廉价）：kind: Secret 或 Secret 专有 type 必含其一。 */
const KUBERNETES_SECRET_HINT = /Secret|Opaque|kubernetes\.io\//;

/** Secret 的数据块父行 `data:` / `stringData:`（值在其后更深缩进的子行里）。 */
const KUBERNETES_DATA_PARENT = /^([ \t]*)(?:-[ \t]+)?(?:data|stringData):[ \t]*$/;

/**
 * .netrc 形态的文档特征：同时出现 `machine <host>` 与 login/password 记号。拆成两条各自线性的前提，
 * 不写成一条跨文本的懒惰匹配（那会对“很多 machine、没有 login”的文本产生平方级回溯）。
 */
const NETRC_MACHINE_GATE = /(?:^|\s)machine\s+\S/;
const NETRC_CREDENTIAL_GATE = /(?:^|\s)(?:login|password)\s+\S/;

/** .netrc 的 password 记号（记号之间可以是任意空白，含换行）。 */
const NETRC_PASSWORD = /(?:^|\s)password\s+/g;

/** .netrc 关键字：password 后面紧跟的是关键字时说明口令为空，不遮。 */
const NETRC_KEYWORDS: ReadonlySet<string> = new Set([
  'machine',
  'default',
  'login',
  'password',
  'account',
  'macdef',
]);

/** code.search 分组条目每行的 `NN: ` 代理前缀（EvidenceCapture 按整数行号生成，不含外部字节）。 */
const SEARCH_LINE_PREFIX = /^\d+: /;

// ---------------------------------------------------------------------------------------------
// 规则表（数据）
// ---------------------------------------------------------------------------------------------

export const SOURCE_POLICY_RULES: readonly SourcePolicyRule[] = Object.freeze([
  {
    id: 'secret-bearing-every-value',
    tier: 'T3',
    sources: ['secret-bearing'],
    description:
      'secret-bearing 文件的每个取值都遮：键值行分隔符之后的值（引号内侧）、YAML 块标量与悬空键下更深缩进的行、' +
      '序列项、多行引号值的续行（含续行闭引号之后的取值）、JSON 一行内后续键值与数组元素；键名、空值、纯容器开符与' +
      '块标量指示符保留',
    matcher: 'secret-bearing-values',
    pattern: SECRET_BEARING_KEY_VALUE,
    gates: [],
    triggers: [],
    examples: [
      { text: 'PORT=8080\nREGION=eu-west-1', secrets: ['8080', 'eu-west-1'] },
      {
        text: 'export DB_HOST="db.SYNTHETIC.internal"\nuser = synthadmin',
        secrets: ['db.SYNTHETIC.internal', 'synthadmin'],
      },
      {
        text: 'clusters:\n- name: prod-SYNTHETIC\n  server: https://k8s.SYNTHETIC.example',
        secrets: ['prod-SYNTHETIC', '//k8s.SYNTHETIC.example'],
      },
      {
        text: 'private_key: |\n  SYNTHETICblockline1\n  SYNTHETICblockline2\nnext: ok-value',
        secrets: ['SYNTHETICblockline1', 'SYNTHETICblockline2', 'ok-value'],
      },
      {
        text: 'passwords:\n  - SYNTHETICseqitem1\n  - SYNTHETICseqitem2',
        secrets: ['SYNTHETICseqitem1', 'SYNTHETICseqitem2'],
      },
      {
        text: 'CERT="SYNTHETICmultiA\nSYNTHETICmultiB"\nOTHER=1',
        secrets: ['SYNTHETICmultiA', 'SYNTHETICmultiB'],
      },
      {
        // 连续几行引号都不闭合（RED-P4e2）：续行在下一行的开引号处闭合，闭引号之后的取值同样要遮。
        text: 'a: "SYNTHETICopenA\nb: "SYNTHETICopenB\nc: "SYNTHETICopenC',
        secrets: ['SYNTHETICopenA', 'SYNTHETICopenB', 'SYNTHETICopenC'],
      },
      {
        text: '{"client_id":"SYNTHETICcid9","port":5432,"scopes":["SYNTHETICsc0pe"]}',
        secrets: ['SYNTHETICcid9', '5432', 'SYNTHETICsc0pe'],
      },
      {
        text: '3: PORT=8080\n9: api_secret: SYNTHETICsearch77',
        secrets: ['8080', 'SYNTHETICsearch77'],
        tool: 'code.search',
      },
      {
        text: '//registry.npmjs.org/:_authToken=SYNTHETICnpm7q',
        secrets: ['SYNTHETICnpm7q'],
      },
    ],
    negativeExamples: [
      '# deployment settings',
      '[default]',
      'clusters:',
      'payload: {',
      'items: []',
      '-----BEGIN CERTIFICATE-----',
    ],
  },
  {
    id: 'terminal-env-sensitive-key',
    tier: 'T3',
    sources: ['terminal'],
    description:
      '终端输出里 env 形态的 KEY=VALUE：键里任意位置出现 pass/pwd/secret/token/key/auth/cred/private/cookie/session ' +
      '就遮值（行首形态取到行尾，行内形态取到空白或分隔符，引号内侧；引号未闭合时向后按行遮到闭引号）',
    matcher: 'env-assignment',
    pattern: ENV_ASSIGNMENT,
    gates: [],
    triggers: ['='],
    examples: [
      { text: 'DB_PASS=SYNTHETICdbpass1', secrets: ['SYNTHETICdbpass1'] },
      {
        text: 'API_KEY_PRIMARY=SYNTHETICprimary\nAUTH_TOKEN_2=SYNTHETICtoken2',
        secrets: ['SYNTHETICprimary', 'SYNTHETICtoken2'],
      },
      {
        text: 'declare -x NPM_AUTH="SYNTHETICnpm auth"\n+ export MYSQL_PWD=SYNTHETICmysql',
        secrets: ['SYNTHETICnpm auth', 'SYNTHETICmysql'],
      },
      {
        text: 'docker run -e SESSION_SECRET_V2=SYNTHETICsess -p 80:80 app',
        secrets: ['SYNTHETICsess'],
      },
      {
        text: '"Env": ["PATH=/usr/bin", "SVC_CREDENTIALS=SYNTHETICcred"]',
        secrets: ['SYNTHETICcred'],
      },
      { text: 'BUILD_ARGS=SVC_TOKEN_2=SYNTHETICchain9 make', secrets: ['SYNTHETICchain9'] },
      {
        text: 'export PRIVATE_NOTE="SYNTHETICline1\nSYNTHETICline2"\nNEXT=1',
        secrets: ['SYNTHETICline1', 'SYNTHETICline2'],
      },
    ],
    negativeExamples: [
      'PORT=8080',
      'HOME=/home/app\nNODE_ENV=production',
      'expected value=42',
      'password is required',
    ],
  },
  {
    id: 'terminal-curl-verbose-auth-header',
    tier: 'T3',
    sources: ['terminal'],
    description:
      'curl -v 一类详细输出的请求 `>` 与响应 `<` 头：Authorization、Proxy-Authorization、Cookie、Set-Cookie 及名字带凭据词的头，整值都遮',
    matcher: 'verbose-http-header',
    pattern: VERBOSE_HTTP_HEADER,
    gates: [],
    triggers: ['> ', '< ', '>\t', '<\t'],
    examples: [
      { text: '> Authorization: Token SYNTHETICtok0042', secrets: ['SYNTHETICtok0042'] },
      {
        text: '> Cookie: session=SYNTHETICs3s; theme=dark\n< Set-Cookie: sid=SYNTHETICsid; Path=/',
        secrets: ['SYNTHETICs3s', 'theme=dark', 'SYNTHETICsid'],
      },
      {
        text: '> Proxy-Authorization: Digest username=synthacct, response=SYNTHETICr3sp',
        secrets: ['synthacct', 'SYNTHETICr3sp'],
      },
      { text: '> X-Api-Key: SYNTHETICxapikey', secrets: ['SYNTHETICxapikey'] },
      {
        // 未知来源底线（四个历史版本与 T1）都不覆盖的头名：名字带 session/credential，以及 Set-Cookie 的第二对起。
        text: '> X-Session-Id: SYNTHETICsess1on\n< X-Credential: SYNTHETICcred99',
        secrets: ['SYNTHETICsess1on', 'SYNTHETICcred99'],
      },
      {
        text: '< Set-Cookie: sid=SYNTHETICsid1; Path=/, lang=SYNTHETICsecond2',
        secrets: ['SYNTHETICsid1', 'SYNTHETICsecond2'],
      },
    ],
    negativeExamples: [
      '> Accept: application/json\n< Content-Type: text/html',
      '> GET /v1/items HTTP/1.1',
      '* Connected to example.com (93.184.216.34) port 443',
    ],
  },
  {
    id: 'terminal-kubectl-secret-data',
    tier: 'T3',
    sources: ['terminal'],
    description:
      'kubectl get secret -o yaml：文档是 Secret（kind: Secret 或 Secret 专有 type）时，data:/stringData: 下更深缩进子键的值都遮',
    matcher: 'kubernetes-secret-data',
    pattern: KUBERNETES_DATA_PARENT,
    // 先用 Secret 文档必备的字面量做廉价前提（KUBERNETES_SECRET_GATE 成立时它必然成立），再跑带行首锚点的前提。
    gates: [KUBERNETES_SECRET_HINT, KUBERNETES_SECRET_GATE],
    // KUBERNETES_DATA_PARENT 区分大小写：父行只能是 data: 或 stringData:（后者含 Data:）。
    triggers: ['data:', 'Data:'],
    examples: [
      {
        text: 'apiVersion: v1\ndata:\n  tls.crt: U1lOVEhFVElDY2VydA==\n  username: U1lOVEhFVElDdXNlcg==\nkind: Secret\ntype: kubernetes.io/tls',
        secrets: ['U1lOVEhFVElDY2VydA==', 'U1lOVEhFVElDdXNlcg=='],
      },
      {
        text: 'items:\n- apiVersion: v1\n  stringData:\n    config.json: SYNTHETICcfg8\n  type: Opaque',
        secrets: ['SYNTHETICcfg8'],
      },
    ],
    negativeExamples: [
      'apiVersion: v1\ndata:\n  log_level: debug\nkind: ConfigMap',
      'kind: Secret\nmetadata:\n  name: app-tls',
    ],
  },
  {
    id: 'netrc-password',
    tier: 'T3',
    sources: ['terminal', 'secret-bearing'],
    description:
      '.netrc 形态的 password 记号之后的口令（记号之间可跨行）；文档须同时出现 machine 与 login/password 记号（D10：只在终端与 secret-bearing 来源中生效）',
    matcher: 'netrc-password',
    pattern: NETRC_PASSWORD,
    gates: [NETRC_MACHINE_GATE, NETRC_CREDENTIAL_GATE],
    triggers: ['password'],
    examples: [
      {
        text: 'machine api.example.com login deploy password SYNTHETICnetrc9',
        secrets: ['SYNTHETICnetrc9'],
      },
      {
        text: 'machine git.example.com\n  login synthuser\n  password SYNTHETICnetrc2',
        secrets: ['SYNTHETICnetrc2'],
      },
      {
        text: 'machine h.example.com login u password "SYNTHETIC quoted"',
        secrets: ['SYNTHETIC quoted'],
      },
    ],
    negativeExamples: [
      'password is required for this machine',
      'machine learning pipeline started',
    ],
  },
] satisfies readonly SourcePolicyRule[]);

// ---------------------------------------------------------------------------------------------
// 分类与规则选择
// ---------------------------------------------------------------------------------------------

/** 没有上下文（开发者事件通道）为 unknown；否则按台账来源分类表（terminal 优先，再按文件分类）。 */
export function classifyRedactionSource(context?: RedactionSourceContext): RedactionSourceClass {
  if (!context) {
    return 'unknown';
  }
  return classifyEvidenceSource(context);
}

/** 某类来源生效的 T3 规则（按表序）；source、config、no-file、unknown 恒为空。 */
export function sourcePolicyRulesFor(
  sourceClass: RedactionSourceClass
): readonly SourcePolicyRule[] {
  if (sourceClass !== 'terminal' && sourceClass !== 'secret-bearing') {
    return [];
  }
  return SOURCE_POLICY_RULES.filter((rule) => rule.sources.includes(sourceClass));
}

// ---------------------------------------------------------------------------------------------
// 扫描器：只产出值区间 [start, end)，区间在传入文本上计算
// ---------------------------------------------------------------------------------------------

type Span = readonly [number, number];

/**
 * 扫描器的有界启发式跳过计数（只含种类与次数，不含正文），随检测结果返回、进入 SourcePolicyReport：
 * - env-line-prefix-over-limit：KEY 前的行首前缀超过上限，按行内形态处理（值取到空白，少追加）；
 * - quote-continuation-limit：未闭合引号值在上限行数内找不到闭引号，只遮首行（多半是值里的撇号）；
 * - json-line-unclosed-quote：JSON 风格的一行里引号不闭合，该行的 JSON 扫描停止（其它形态照常）。
 * 跳过只意味着 T3 少追加，底线与其它规则照常生效。
 */
type SkipKind =
  | 'env-line-prefix-over-limit'
  | 'quote-continuation-limit'
  | 'json-line-unclosed-quote';
type SkipCounter = Partial<Record<SkipKind, number>>;

function countSkip(skips: SkipCounter, kind: SkipKind): void {
  skips[kind] = (skips[kind] ?? 0) + 1;
}

interface Line {
  readonly start: number;
  /** 行内容结束（不含换行；行尾的 \r 也排除在外） */
  readonly end: number;
}

function splitTextLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    let newline = text.indexOf('\n', start);
    if (newline < 0) {
      newline = text.length;
    }
    let end = newline;
    if (end > start && text.charCodeAt(end - 1) === 13) {
      end -= 1;
    }
    lines.push({ start, end });
    start = newline + 1;
  }
  return lines;
}

function isBlank(code: number): boolean {
  return code === 32 || code === 9;
}

/** 收窄到首尾非空白字符；空区间返回 null。 */
function trimmed(text: string, start: number, end: number): Span | null {
  let from = start;
  let to = end;
  while (from < to && isBlank(text.charCodeAt(from))) {
    from++;
  }
  while (to > from && isBlank(text.charCodeAt(to - 1))) {
    to--;
  }
  return to > from ? [from, to] : null;
}

function indentOf(text: string, start: number, end: number): number {
  let at = start;
  while (at < end && isBlank(text.charCodeAt(at))) {
    at++;
  }
  return at - start;
}

/** 从 from 起找与 quote 配对的闭引号（双引号识别反斜杠转义）；找不到返回 -1。 */
function closingQuote(text: string, from: number, end: number, quote: string): number {
  for (let at = from; at < end; at++) {
    const char = text[at];
    if (quote === '"' && char === '\\') {
      at++;
      continue;
    }
    if (char === quote) {
      return at;
    }
  }
  return -1;
}

interface ValueScan {
  /** 要遮的区间（引号内侧） */
  readonly span: Span | null;
  /** 引号值在本行没有闭合时的引号字符 */
  readonly openQuote: string | null;
}

/**
 * 取值区间 [start, end) 的遮蔽范围：引号值只遮引号内侧（包围引号保留，与历史版本 `"[redacted]"` 的形态一致）；
 * 引号在本行没有闭合时遮到行尾并报告未闭合，由调用方跟踪续行。
 */
function scanValue(text: string, start: number, end: number, trimJsonComma: boolean): ValueScan {
  const range = trimmed(text, start, end);
  if (!range) {
    return { span: null, openQuote: null };
  }
  const [from, to] = range;
  const first = text[from];
  if (first === '"' || first === "'") {
    const close = closingQuote(text, from + 1, to, first);
    if (close < 0) {
      return { span: to > from + 1 ? [from + 1, to] : null, openQuote: first };
    }
    return { span: close > from + 1 ? [from + 1, close] : null, openQuote: null };
  }
  let stop = to;
  if (trimJsonComma && text[stop - 1] === ',') {
    stop -= 1;
  }
  return { span: stop > from ? [from, stop] : null, openQuote: null };
}

interface KeyValueHead {
  /** 分隔符之后第一个字符的位置（取值从这里开始） */
  readonly valueStart: number;
  readonly keyQuoted: boolean;
}

/**
 * 按 SECRET_BEARING_KEY_VALUE 的语义线性解析一行 [start, end)：可选缩进、可选 `- `，键是闭合的引号串（其后只允许
 * 空白再接分隔符）或第一个分隔符之前的非空片段（首字符不是空白、分隔符或引号）；分隔符取 `::=`、`:=`、`=`、`:`。
 * 不用正则逐行匹配：懒惰键加 `[ \t]*` 在病态长行（大段空白、没有分隔符）上会平方级回溯。
 */
function parseKeyValueHead(text: string, start: number, end: number): KeyValueHead | null {
  let at = start;
  while (at < end && isBlank(text.charCodeAt(at))) {
    at++;
  }
  if (at < end && text[at] === '-' && at + 1 < end && isBlank(text.charCodeAt(at + 1))) {
    at += 1;
    while (at < end && isBlank(text.charCodeAt(at))) {
      at++;
    }
  }
  if (at >= end) {
    return null;
  }
  const first = text[at];
  let separator: number;
  let keyQuoted = false;
  if (first === '"' || first === "'") {
    const close = closingQuote(text, at + 1, end, first);
    if (close < 0) {
      return null;
    }
    separator = close + 1;
    while (separator < end && isBlank(text.charCodeAt(separator))) {
      separator++;
    }
    if (separator >= end || (text[separator] !== '=' && text[separator] !== ':')) {
      return null;
    }
    keyQuoted = first === '"';
  } else {
    if (first === '=' || first === ':') {
      return null;
    }
    separator = -1;
    for (let index = at + 1; index < end; index++) {
      const char = text[index];
      if (char === '=' || char === ':') {
        separator = index;
        break;
      }
    }
    if (separator < 0) {
      return null;
    }
  }
  const length = text.startsWith('::=', separator) ? 3 : text.startsWith(':=', separator) ? 2 : 1;
  return { valueStart: separator + length, keyQuoted };
}

/**
 * [from, to) 是否只由结构标点与空白组成（逗号、分号、右花括号、右方括号）：多行引号值闭合后跟着的这些字符不含
 * 取值信息，不遮。逐字符判断，不切片、不跑正则。
 */
function isTrailingStructure(text: string, from: number, to: number): boolean {
  for (let at = from; at < to; at++) {
    const code = text.charCodeAt(at);
    if (!(isBlank(code) || code === 44 || code === 59 || code === 125 || code === 93)) {
      return false;
    }
  }
  return true;
}

/** secret-bearing 扫描器的续行状态。 */
type Pending =
  | { readonly kind: 'block'; readonly indent: number }
  | { readonly kind: 'nested'; readonly indent: number }
  | { readonly kind: 'quote'; readonly quote: string }
  | null;

/**
 * secret-bearing：每个取值都遮。逐行：
 * - 多行引号值的续行遮到闭引号，闭引号之后除结构标点外的内容也按取值处理（可再开引号续行）；块标量（`|`、`>`）
 *   与悬空键（空值）之下更深缩进的行整行是取值；
 * - 键值行遮分隔符之后的值（引号内侧；JSON 风格的键去掉尾逗号）；纯容器开符、空容器、空串与 base64 补位 `=` 不遮；
 * - 不含分隔符的序列项 `- value` 遮 value；
 * - 另外 JSON 一行内不作键的字符串与 `"键": 原子值` 都遮（一行多个键值对、数组元素）。
 * code.search 分组条目先跳过每行的 `NN: ` 代理前缀，前缀与键名都保留。
 */
function scanSecretBearingValues(
  text: string,
  tool: string | undefined,
  skips: SkipCounter
): Span[] {
  const spans: Span[] = [];
  const push = (span: Span | null) => {
    if (span) {
      spans.push(span);
    }
  };
  let pending: Pending = null;
  // 下一个双引号的位置（按行顺序只前进）：判断“本行有没有双引号”不必切出整行再查找，也不会对没有引号的长尾
  // 反复向后扫（每次查找从本行起点开始，结果在后续各行复用）。
  let nextQuote = -1;
  for (const line of splitTextLines(text)) {
    let start = line.start;
    if (tool === 'code.search') {
      const prefix = SEARCH_LINE_PREFIX.exec(text.slice(line.start, line.end));
      if (prefix) {
        start += prefix[0].length;
      }
    }
    const end = line.end;
    if (pending?.kind === 'quote') {
      const close = closingQuote(text, start, end, pending.quote);
      if (close < 0) {
        push(trimmed(text, start, end));
        continue;
      }
      push(trimmed(text, start, close));
      pending = null;
      // 闭引号之后的内容也是取值（RED-P4e2）：YAML 里连续几行 `kN: "vN` 都不闭合时，上一行的续行会在本行的开引号
      // 处“闭合”，真正的取值 vN 落在闭引号之后；只看到闭引号为止会让每隔一行的值露出。只剩结构标点（逗号、分号、
      // 右括号）时没有取值信息，原样保留；否则按取值处理，以引号开头且本行未闭合时继续跟踪续行。
      const rest = trimmed(text, close + 1, end);
      if (rest !== null && !isTrailingStructure(text, rest[0], rest[1])) {
        const scan = scanValue(text, rest[0], rest[1], false);
        push(scan.span);
        if (scan.openQuote !== null) {
          pending = { kind: 'quote', quote: scan.openQuote };
        }
      }
      continue;
    }
    const indent = indentOf(text, start, end);
    // 空行（与 String#trim 同口径）：跳过空格与制表符后已到行尾，或首个非空白字符不是可打印 ASCII 而整行 trim 后为空。
    const first = start + indent;
    if (first >= end) {
      continue;
    }
    const firstCode = text.charCodeAt(first);
    if (!(firstCode > 32 && firstCode < 127) && text.slice(start, end).trim().length === 0) {
      continue;
    }
    if (pending !== null && indent > pending.indent) {
      if (pending.kind === 'block') {
        push(trimmed(text, start, end));
        continue;
      }
    } else if (pending !== null) {
      pending = null;
    }
    // 悬空键之下的嵌套行：先按自身形态（键值、序列项）处理，都不是时整行作为取值。
    const nested = pending?.kind === 'nested' ? pending : null;
    const keyValue = parseKeyValueHead(text, start, end);
    if (keyValue) {
      const { valueStart, keyQuoted } = keyValue;
      const value = text.slice(valueStart, end).trim();
      // 三条形态正则各有固定的首字符（| >、{ [ " '、=），先比首字符再跑正则。
      const lead = value[0];
      if (value.length === 0) {
        pending = { kind: 'nested', indent };
      } else if ((lead === '|' || lead === '>') && YAML_BLOCK_INDICATOR.test(value)) {
        pending = { kind: 'block', indent };
      } else if (
        ((lead === '{' || lead === '[' || lead === '"' || lead === "'") &&
          STRUCTURE_ONLY_VALUE.test(value)) ||
        (lead === '=' && /^=+$/.test(value))
      ) {
        // 只有容器开符或补位等号：没有取值信息，后续行按各自形态处理。
      } else {
        const scan = scanValue(text, valueStart, end, keyQuoted);
        push(scan.span);
        if (scan.openQuote !== null) {
          pending = { kind: 'quote', quote: scan.openQuote };
        }
      }
    } else {
      // 序列项正则要求行首空白之后就是 -：首字符不是 - 时不可能匹配，不切行。
      const item =
        firstCode === 45 ? SECRET_BEARING_SEQUENCE_ITEM.exec(text.slice(start, end)) : null;
      if (item) {
        const itemStart = end - (item[1] ?? '').length;
        push(scanValue(text, itemStart, end, true).span);
      } else if (nested) {
        push(trimmed(text, start, end));
      }
    }
    if (nextQuote < start) {
      nextQuote = text.indexOf('"', start);
      if (nextQuote < 0) {
        nextQuote = text.length;
      }
    }
    if (nextQuote < end) {
      scanJsonLine(text, start, end, spans, skips);
    }
  }
  return spans;
}

/**
 * JSON 风格的一行（一行多个键值对、数组元素）：按词法从左到右逐个取双引号字符串（识别反斜杠转义），后面紧跟冒号的
 * 是键，其余字符串遮内侧；键的冒号之后不以引号或容器开符开头的原子值（数字、布尔、null）取到 `,`、`}`、`]` 或行尾。
 * 引号在本行不闭合时停止：只是本扫描不再追加，已产出的区间与其它形态照常生效。
 */
function scanJsonLine(
  text: string,
  start: number,
  end: number,
  spans: Span[],
  skips: SkipCounter
): void {
  let at = start;
  while (at < end) {
    const quote = text.indexOf('"', at);
    if (quote < 0 || quote >= end) {
      return;
    }
    const close = closingQuote(text, quote + 1, end, '"');
    if (close < 0) {
      countSkip(skips, 'json-line-unclosed-quote');
      return;
    }
    let after = close + 1;
    while (after < end && isBlank(text.charCodeAt(after))) {
      after++;
    }
    if (after < end && text[after] === ':') {
      let valueStart = after + 1;
      while (valueStart < end && isBlank(text.charCodeAt(valueStart))) {
        valueStart++;
      }
      const first = text[valueStart];
      if (valueStart < end && first !== '"' && first !== '{' && first !== '[') {
        let valueEnd = valueStart;
        while (valueEnd < end && !',}]'.includes(text[valueEnd] ?? ',')) {
          valueEnd++;
        }
        const span = trimmed(text, valueStart, valueEnd);
        if (span) {
          spans.push(span);
        }
        at = valueEnd;
        continue;
      }
      at = after + 1;
      continue;
    }
    if (close > quote + 1) {
      spans.push([quote + 1, close]);
    }
    at = close + 1;
  }
}

/**
 * 敏感词表编译成一条不区分大小写的选择正则（不带 g/y 标志，test() 不读写 lastIndex）：键只由 ASCII 键字符组成，
 * 与“小写后逐词子串比较”等价；同一行上大量键时省掉每个键的小写副本与逐词闭包调用（复查实测这是终端扫描的热点）。
 */
const ENV_SENSITIVE_KEY = new RegExp(ENV_SENSITIVE_WORDS.join('|'), 'i');

function isSensitiveEnvKey(key: string): boolean {
  return ENV_SENSITIVE_KEY.test(key);
}

/**
 * 行内形态的值在这些字符处结束（空白、命令分隔符、引号、反引号、右括号）。逗号不是终止符：`TOKEN=a,b` 整段遮，
 * 宁可多遮相邻的键，也不让逗号之后的口令段露出（`=`、`,`、`?`、`(` 也是键的前导字符，所以同一段里可以有多个
 * 匹配；它们的终点相同，扫描器用终点缓存保证每个字符只扫一次）。
 */
function isInlineValueStop(code: number): boolean {
  return (
    code === 32 ||
    code === 9 ||
    code === 10 ||
    code === 13 ||
    code === 59 || // ;
    code === 38 || // &
    code === 124 || // |
    code === 41 || // )
    code === 34 || // "
    code === 39 || // '
    code === 96 // `
  );
}

function lineEndFrom(text: string, from: number): number {
  let end = text.indexOf('\n', from);
  if (end < 0) {
    end = text.length;
  }
  if (end > from && text.charCodeAt(end - 1) === 13) {
    end -= 1;
  }
  return end;
}

/** 终端里多行引号值向后找闭引号的行数上限：找不到时只遮首行（多半是值里的撇号，不是多行值）。 */
const QUOTED_CONTINUATION_MAX_LINES = 64;

/**
 * 引号在 lineEnd 所在行没有闭合时，按行遮住后续各行直到闭引号（不含换行，渲染会放回结构）。文本在闭引号之前结束
 * （输出被截断）时遮到文末；在 QUOTED_CONTINUATION_MAX_LINES 行内找不到闭引号时不追加（只遮首行，已由调用方
 * 完成），计入 quote-continuation-limit。
 */
function quotedContinuation(
  text: string,
  lineEnd: number,
  quote: string,
  skips: SkipCounter
): Span[] {
  const spans: Span[] = [];
  let next = text.indexOf('\n', lineEnd);
  for (let count = 0; next >= 0; count++) {
    if (count >= QUOTED_CONTINUATION_MAX_LINES) {
      countSkip(skips, 'quote-continuation-limit');
      return [];
    }
    const start = next + 1;
    const end = lineEndFrom(text, start);
    const close = closingQuote(text, start, end, quote);
    if (close >= 0) {
      const last = trimmed(text, start, close);
      if (last) {
        spans.push(last);
      }
      return spans;
    }
    const span = trimmed(text, start, end);
    if (span) {
      spans.push(span);
    }
    next = text.indexOf('\n', end);
  }
  return spans;
}

/**
 * 双引号闭合表：行 [start, end) 内从每个位置 p 起找闭合双引号的结果（与 closingQuote(text, p, end, '"') 同一
 * 语义：反斜杠跳过下一个字符；找不到为 -1），从右向左一次算出。前导引号被转义（`\"KEY=v\"KEY=v…`）时，同一行上
 * 每个键都要越过后面所有转义引号才找到闭引号；逐个查表后整行只扫一遍。转义的相位取决于起点，所以按起点逐个
 * 记录，而不是只记“下一个引号”。
 */
function doubleQuoteCloseTable(text: string, start: number, end: number): Int32Array {
  const table = new Int32Array(end - start + 1).fill(-1);
  for (let at = end - 1; at >= start; at--) {
    const code = text.charCodeAt(at);
    if (code === 92) {
      table[at - start] = at + 2 <= end ? (table[at + 2 - start] ?? -1) : -1;
    } else if (code === 34) {
      table[at - start] = at;
    } else {
      table[at - start] = table[at + 1 - start] ?? -1;
    }
  }
  return table;
}

/**
 * terminal：env 形态 KEY=VALUE，键里任意位置出现敏感词就遮值。
 * - 值以引号开头：遮引号内侧；本行未闭合时向后按行遮到闭引号（至多 QUOTED_CONTINUATION_MAX_LINES 行）；
 * - KEY 前面紧贴引号（JSON 数组里的 "KEY=v"）：值取到同一引号为止；
 * - KEY 前面只有行首前缀（缩进、`+ `、export、declare -x 等）：值取到行尾（env 输出的值可以含空格）；
 * - 其余行内形态：值取到空白或分隔符。
 *
 * 线性（复查意见：同一行上首尾相接的敏感 `KEY=` 曾让每个匹配都扫到行尾）：
 * - 行内终点缓存：[stopFrom, stopAt) 内没有停止字符，从其中任何位置起扫的终点都是 stopAt，同一段里的后续匹配
 *   直接复用，每个字符只扫一次；
 * - 行首前缀只可能出现在一行的第一个匹配前面（之后每个键的前缀都含有前一个匹配的 `=`，ENV_LINE_PREFIX 必然
 *   不成立），所以每行至多切片测试一次；
 * - 双引号闭合按行查表（doubleQuoteCloseTable），单引号没有转义，各次查找的扫描区间互不重叠；
 * - 已整段产出的取值内部不再逐个匹配（见 resumeAfterInlineValue、行首前缀分支的跳行）：那些匹配的区间都被已产出的
 *   区间覆盖，跳过只省掉正则与判定的开销；
 * - 仍会互相重叠的区间（例如转义前导引号的各个键）由 detectSourcePolicySpans 统一排序合并，下游逐字符消费每个
 *   位置至多一次。
 * 这些都是对同一结果的线性实现，产出的遮蔽位置集合与逐匹配扫描相同。
 */
function scanEnvAssignments(text: string, skips: SkipCounter): Span[] {
  const spans: Span[] = [];
  // 匹配用 nextEnvAssignment（与 ENV_ASSIGNMENT 从 from 起 exec 等价，不用后行断言逐位置试探）；from 相当于
  // lastIndex，下面按已产出的区间往前跳。
  let from = 0;
  // 行首按匹配顺序增量维护（游标只前进），行尾在需要时求一次。
  let cursor = 0;
  let lineStart = 0;
  let lineEnd = -1;
  // 最近一个匹配所在行的行首：用来判断当前匹配是不是本行第一个。
  let matchedLine = -1;
  let stopFrom = -1;
  let stopAt = -1;
  // 双引号闭合：一行里第一次直接扫（绝大多数行只有一次，不分配整行大小的表）；同一行第二次起改为查表。
  let quoteLine = -1;
  let quoteTable: Int32Array | null = null;
  const closeQuote = (from: number, quote: string): number => {
    if (quote !== '"') {
      return closingQuote(text, from, lineEnd, quote);
    }
    if (from >= lineEnd) {
      return -1;
    }
    if (quoteLine !== lineStart) {
      quoteLine = lineStart;
      quoteTable = null;
      return closingQuote(text, from, lineEnd, quote);
    }
    quoteTable ??= doubleQuoteCloseTable(text, lineStart, lineEnd);
    return quoteTable[from - lineStart] ?? -1;
  };
  for (
    let match = nextEnvAssignment(text, from);
    match !== null;
    match = nextEnvAssignment(text, from)
  ) {
    const { keyStart, equals } = match;
    from = equals + 1;
    for (; cursor < keyStart; cursor++) {
      if (text.charCodeAt(cursor) === 10) {
        lineStart = cursor + 1;
      }
    }
    const firstOnLine = matchedLine !== lineStart;
    matchedLine = lineStart;
    if (!isSensitiveEnvKey(text.slice(keyStart, equals))) {
      continue;
    }
    const lead = keyStart > 0 ? (text[keyStart - 1] ?? '') : '';
    const valueStart = equals + 1;
    if (lineEnd < valueStart) {
      lineEnd = lineEndFrom(text, valueStart);
    }
    if (valueStart >= lineEnd) {
      continue;
    }
    const first = text[valueStart];
    if (first === '"' || first === "'") {
      const close = closeQuote(valueStart + 1, first);
      const to = close < 0 ? lineEnd : close;
      if (to > valueStart + 1) {
        spans.push([valueStart + 1, to]);
      }
      if (close < 0) {
        for (const span of quotedContinuation(text, lineEnd, first, skips)) {
          spans.push(span);
        }
      }
      continue;
    }
    if (lead === '"' || lead === "'") {
      const close = closeQuote(valueStart, lead);
      const to = close < 0 ? lineEnd : close;
      if (to > valueStart) {
        spans.push([valueStart, to]);
      }
      continue;
    }
    if (firstOnLine) {
      // 行首前缀只可能是缩进、`+ `、export/declare -x 等短前缀；超过上限按行内形态处理（只少追加，不会放行底线）。
      if (keyStart - lineStart > ENV_LINE_PREFIX_MAX) {
        countSkip(skips, 'env-line-prefix-over-limit');
      } else if (ENV_LINE_PREFIX.test(text.slice(lineStart, keyStart))) {
        const span = trimmed(text, valueStart, lineEnd);
        if (span) {
          spans.push(span);
        }
        // 本行余下的匹配只可能在“值以引号开头且本行未闭合”时追加（向后续行遮到闭引号）；余下部分没有引号时
        // 它们的区间都落在刚产出的整行区间内，直接跳到行尾。
        if (!hasQuoteBetween(text, valueStart, lineEnd)) {
          from = Math.max(from, lineEnd);
        }
        continue;
      }
    }
    if (valueStart < stopFrom || valueStart > stopAt) {
      stopFrom = valueStart;
      stopAt = valueStart;
      while (stopAt < lineEnd && !isInlineValueStop(text.charCodeAt(stopAt))) {
        stopAt++;
      }
    }
    if (stopAt > valueStart) {
      spans.push([valueStart, stopAt]);
      from = Math.max(from, resumeAfterInlineValue(text, valueStart, stopAt));
    }
  }
  return spans;
}

/** ENV_ASSIGNMENT 后行断言里的前导字符集合（空白与 \s 同口径）。只对单个字符 test()，不带 g/y 标志。 */
const ENV_KEY_LEAD = /[\s;&|(`'"=,?]/;

function isEnvKeyStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/**
 * 从 from 起找下一个 env 形态的 `KEY=`，结果与 ENV_ASSIGNMENT（lastIndex = from）exec 的匹配逐个相同：
 * 键字符 [A-Za-z0-9_.-] 与前导字符 [\s;&|(`'"=,?] 互不相交，所以正则的合法匹配恰好是“紧跟 = 的极大键字符段”，
 * 段首是字母或下划线、段前是文首或前导字符（`^` 的行首也被 \s 里的换行覆盖），且段首不早于 from。
 * 逐个 = 向回扫键字符段：= 不是键字符，回扫不会越过前一个 =，总开销线性；不再对每个位置先试后行断言
 * （复查实测语料上这条正则是终端规则的主要开销）。test/redaction-source-policy.test.ts 用模糊语料逐个比对两者。
 */
export function nextEnvAssignment(
  text: string,
  from: number
): { readonly keyStart: number; readonly equals: number } | null {
  for (let equals = text.indexOf('=', from); equals >= 0; equals = text.indexOf('=', equals + 1)) {
    let keyStart = equals;
    while (keyStart > from && isEnvKeyChar(text.charCodeAt(keyStart - 1))) {
      keyStart--;
    }
    if (
      keyStart < equals &&
      isEnvKeyStart(text.charCodeAt(keyStart)) &&
      (keyStart === 0 || ENV_KEY_LEAD.test(text[keyStart - 1] ?? ''))
    ) {
      return { keyStart, equals };
    }
  }
  return null;
}

function isEnvKeyChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    (code >= 48 && code <= 57) || // 0-9
    code === 95 || // _
    code === 46 || // .
    code === 45 // -
  );
}

function hasQuoteBetween(text: string, from: number, to: number): boolean {
  for (let at = from; at < to; at++) {
    const code = text.charCodeAt(at);
    if (code === 34 || code === 39) {
      return true;
    }
  }
  return false;
}

/**
 * 行内取值 [valueStart, stopAt) 整段产出之后，下一个还可能追加遮蔽的匹配从哪里找起：段内没有停止字符，所以键在
 * 段内、取值也在段内开始的匹配，其取值必然止于同一个 stopAt（取值首字符与前导字符都不是引号，也不是行首第一个
 * 匹配），区间被刚产出的区间覆盖；只有取值恰好从 stopAt 开始的键（`=` 在 stopAt-1，键是紧挨着它的一段键字符，
 * stopAt 处若是引号会走引号分支）或者 stopAt 之后的键需要处理。停止字符不是键字符，键不可能跨过 stopAt。
 * 往回扫的键字符段落在刚产出的段内，各段互不重叠，总开销线性。
 */
function resumeAfterInlineValue(text: string, valueStart: number, stopAt: number): number {
  if (text.charCodeAt(stopAt - 1) !== 61) {
    return stopAt;
  }
  let at = stopAt - 1;
  while (at > valueStart && isEnvKeyChar(text.charCodeAt(at - 1))) {
    at--;
  }
  return at;
}

export interface VerboseHeaderMatch {
  readonly index: number;
  readonly name: string;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** 行终止符（与正则 m 标志下 ^/$ 的口径相同：\n、\r、\u2028、\u2029）。 */
function isLineTerminator(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

/**
 * 逐个匹配详细 HTTP 输出的头行，结果与 VERBOSE_HTTP_HEADER（g、m 标志）的 matchAll 逐个相同：匹配只能从行首
 * （文首或任一行终止符之后）开始；行首跳过空格与制表符后须是 < 或 >，可选一个空白，头名 [A-Za-z0-9][A-Za-z0-9_-]*，
 * 空白后是冒号，值是冒号后空白之后到第一个 \r 或 \n（或文末）为止的内容（与 [^\r\n]* 加 $ 相同，可以跨过
 * \u2028/\u2029，跨过的行首不再单独匹配）。各段都是确定的，没有回溯。
 * 候选行首由 < 与 > 的出现位置向回跳过空白得到（每段空白只被它后面的一个 < 或 > 回扫一次，线性），不对每个位置
 * 试 ^：源码类终端输出里大量的 `=> `、`< ` 曾让正则逐位置扫描（复查实测语料上这是终端规则的第二大开销）。
 * test/redaction-source-policy.test.ts 用模糊语料逐个比对两者。
 */
export function verboseHeaderMatches(text: string): VerboseHeaderMatch[] {
  const matches: VerboseHeaderMatch[] = [];
  // 上一个匹配的终点（相当于 lastIndex）：其后的行首才参与匹配。
  let resumeAt = 0;
  let nextGreater = text.indexOf('>');
  let nextLess = text.indexOf('<');
  while (nextGreater >= 0 || nextLess >= 0) {
    let at: number;
    if (nextLess < 0 || (nextGreater >= 0 && nextGreater < nextLess)) {
      at = nextGreater;
      nextGreater = text.indexOf('>', at + 1);
    } else {
      at = nextLess;
      nextLess = text.indexOf('<', at + 1);
    }
    let lineStart = at;
    while (lineStart > 0 && isBlank(text.charCodeAt(lineStart - 1))) {
      lineStart--;
    }
    if (
      lineStart < resumeAt ||
      (lineStart > 0 && !isLineTerminator(text.charCodeAt(lineStart - 1)))
    ) {
      continue;
    }
    const found = headerAt(text, lineStart);
    if (found !== null) {
      matches.push(found);
      resumeAt = found.valueEnd;
    }
  }
  return matches;
}

function isAlphaNumeric(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** 行首 lineStart 处的头行匹配（语义见 verboseHeaderMatches）；不是头行返回 null。 */
function headerAt(text: string, lineStart: number): VerboseHeaderMatch | null {
  let at = lineStart;
  while (at < text.length && isBlank(text.charCodeAt(at))) {
    at++;
  }
  const marker = text.charCodeAt(at);
  if (marker !== 60 && marker !== 62) {
    return null;
  }
  let nameStart = at + 1;
  if (nameStart < text.length && isBlank(text.charCodeAt(nameStart))) {
    nameStart++;
  }
  if (!isAlphaNumeric(text.charCodeAt(nameStart))) {
    return null;
  }
  let nameEnd = nameStart + 1;
  while (nameEnd < text.length) {
    const code = text.charCodeAt(nameEnd);
    if (!(isAlphaNumeric(code) || code === 95 || code === 45)) {
      break;
    }
    nameEnd++;
  }
  let colon = nameEnd;
  while (colon < text.length && isBlank(text.charCodeAt(colon))) {
    colon++;
  }
  if (text.charCodeAt(colon) !== 58) {
    return null;
  }
  let valueStart = colon + 1;
  while (valueStart < text.length && isBlank(text.charCodeAt(valueStart))) {
    valueStart++;
  }
  let valueEnd = valueStart;
  while (valueEnd < text.length) {
    const code = text.charCodeAt(valueEnd);
    if (code === 10 || code === 13) {
      break;
    }
    valueEnd++;
  }
  return { index: lineStart, name: text.slice(nameStart, nameEnd), valueStart, valueEnd };
}

/** terminal：详细 HTTP 输出里的认证类头，整值都遮。 */
function scanVerboseHttpHeaders(text: string): Span[] {
  const spans: Span[] = [];
  for (const { name, valueStart, valueEnd } of verboseHeaderMatches(text)) {
    if (!SENSITIVE_HEADER_NAME.test(name) || text.slice(valueStart, valueEnd).trim().length === 0) {
      continue;
    }
    const span = trimmed(text, valueStart, valueEnd);
    if (span) {
      spans.push(span);
    }
  }
  return spans;
}

/**
 * terminal：Secret 文档里 data:/stringData: 之下更深缩进子键的值（引号内侧）。遇到缩进不深于父行的非空行结束；
 * 子键值是块标量指示符时，其下更深缩进的行整行遮住（stringData 的多行值）。
 */
function scanKubernetesSecretData(text: string): Span[] {
  const spans: Span[] = [];
  const lines = splitTextLines(text);
  let parentIndent: number | null = null;
  let blockIndent: number | null = null;
  for (const line of lines) {
    const body = text.slice(line.start, line.end);
    if (body.trim().length === 0) {
      continue;
    }
    const indent = indentOf(text, line.start, line.end);
    if (parentIndent !== null && indent <= parentIndent) {
      parentIndent = null;
      blockIndent = null;
    }
    if (parentIndent === null) {
      const parent = KUBERNETES_DATA_PARENT.exec(body);
      if (parent) {
        parentIndent = (parent[1] ?? '').length;
      }
      continue;
    }
    if (blockIndent !== null) {
      if (indent > blockIndent) {
        const span = trimmed(text, line.start, line.end);
        if (span) {
          spans.push(span);
        }
        continue;
      }
      blockIndent = null;
    }
    // 子键值行与 secret-bearing 用同一个线性解析（键后第一个分隔符之后是值）。
    const child = parseKeyValueHead(text, line.start, line.end);
    if (!child) {
      continue;
    }
    const value = text.slice(child.valueStart, line.end).trim();
    if (value.length === 0) {
      continue;
    }
    if (YAML_BLOCK_INDICATOR.test(value)) {
      blockIndent = indent;
      continue;
    }
    const scan = scanValue(text, child.valueStart, line.end, false);
    if (scan.span) {
      spans.push(scan.span);
    }
  }
  return spans;
}

/**
 * terminal / secret-bearing：.netrc 的 password 记号之后的口令（引号口令遮引号内侧）。
 * 行尾按匹配顺序缓存：同一长行上的大量引号口令不再各自向后找一遍换行（保持线性）；各次闭引号查找都止于下一个
 * 记号的开引号之前（开引号紧跟空白，不可能被转义），扫描区间互不重叠。
 */
function scanNetrcPasswords(text: string): Span[] {
  const spans: Span[] = [];
  let lineEnd = -1;
  for (const match of text.matchAll(NETRC_PASSWORD)) {
    const from = match.index + match[0].length;
    if (from >= text.length) {
      continue;
    }
    if (text[from] === '"') {
      if (lineEnd < from) {
        lineEnd = lineEndFrom(text, from);
      }
      const close = closingQuote(text, from + 1, lineEnd, '"');
      const to = close < 0 ? lineEnd : close;
      if (to > from + 1) {
        spans.push([from + 1, to]);
      }
      continue;
    }
    let to = from;
    while (to < text.length && !/\s/.test(text[to] ?? ' ')) {
      to++;
    }
    if (to > from && !NETRC_KEYWORDS.has(text.slice(from, to))) {
      spans.push([from, to]);
    }
  }
  return spans;
}

function runMatcher(
  rule: SourcePolicyRule,
  text: string,
  tool: string | undefined,
  skips: SkipCounter
): Span[] {
  switch (rule.matcher) {
    case 'secret-bearing-values':
      return scanSecretBearingValues(text, tool, skips);
    case 'env-assignment':
      return scanEnvAssignments(text, skips);
    case 'verbose-http-header':
      return scanVerboseHttpHeaders(text);
    case 'kubernetes-secret-data':
      return scanKubernetesSecretData(text);
    case 'netrc-password':
      return scanNetrcPasswords(text);
  }
}

/**
 * 把区间按起点排序并合并重叠或相接的部分，丢弃空区间。遮住的位置集合不变；合并后下游逐字符消费（底线检测器
 * 挂点、标记过滤、新增字符计数）每个位置至多一次。扫描器产出的区间基本有序，排序是近线性的。
 */
function mergeSpans(spans: readonly Span[]): Array<readonly [number, number]> {
  // 快路径：扫描器按行顺序产出，绝大多数情形已经按起点升序、非空且互不相接，原样复制即可（省掉过滤、排序与重建）。
  let ordered = true;
  let previousEnd = -1;
  for (const [start, end] of spans) {
    if (end <= start || start <= previousEnd) {
      ordered = false;
      break;
    }
    previousEnd = end;
  }
  if (ordered) {
    return spans.slice();
  }
  const sorted = spans
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) {
      if (end > last[1]) {
        last[1] = end;
      }
      continue;
    }
    merged.push([start, end]);
  }
  return merged;
}

export interface SourcePolicyDetection {
  /** 要遮的区间（在传入文本上，各规则区间之并：按起点排序、互不相交、互不相接） */
  readonly spans: ReadonlyArray<readonly [number, number]>;
  /** 各规则命中的区间数（规则自身区间合并后的段数；只含命中的规则） */
  readonly hits: Readonly<Record<string, number>>;
  /** 有界启发式的跳过计数（种类 → 次数）；空对象表示没有跳过 */
  readonly skips: Readonly<Partial<Record<SkipKind, number>>>;
}

/**
 * 在文本上运行给定规则，返回要遮的区间。预过滤（triggers、gates）不满足的规则直接跳过：跳过只意味着本规则不追加，
 * 底线与其它规则照常生效。
 */
export function detectSourcePolicySpans(
  text: string,
  rules: readonly SourcePolicyRule[],
  tool?: string
): SourcePolicyDetection {
  const hits: Record<string, number> = {};
  const skips: SkipCounter = {};
  if (text.length === 0 || rules.length === 0) {
    return { spans: [], hits, skips };
  }
  const found: Array<readonly [number, number]> = [];
  for (const rule of rules) {
    if (rule.triggers.length > 0 && !rule.triggers.some((trigger) => text.includes(trigger))) {
      continue;
    }
    if (!rule.gates.every((gate) => gate.test(text))) {
      continue;
    }
    const ruleSpans = mergeSpans(runMatcher(rule, text, tool, skips));
    if (ruleSpans.length > 0) {
      hits[rule.id] = ruleSpans.length;
      // 逐个追加而不是展开参数：区间数可达数十万，展开会超出调用栈的参数上限。
      for (const span of ruleSpans) {
        found.push(span);
      }
    }
  }
  return { spans: mergeSpans(found), hits, skips };
}

// ---------------------------------------------------------------------------------------------
// 编排：未知来源底线 → T3 区间 + 种子并入 → 渲染 → 不动点
// ---------------------------------------------------------------------------------------------

/**
 * 走了哪条路径：
 * - unknown-source：没有来源上下文（开发者事件通道），等于 redactDeveloperText；
 * - no-source-rules：该来源没有 T3 规则（source、config、no-file），等于 redactDeveloperText；
 * - no-span：T3 规则运行了但在原文上没有命中（预过滤或扫描都没找到形态），输出与未知来源相同（快路径）；
 * - covered：T3 命中了，但区间都已被未知来源底线遮住，输出与未知来源相同（快路径）；
 * - merged：T3 区间与未知来源遮蔽（种子）并入底线后重新渲染。
 */
export type SourcePolicyPath =
  | 'unknown-source'
  | 'no-source-rules'
  | 'no-span'
  | 'covered'
  | 'merged';

export interface SourcePolicyReport {
  readonly sourceClass: RedactionSourceClass;
  readonly path: SourcePolicyPath;
  /** 该来源生效的规则 id（按表序） */
  readonly ruleIds: readonly string[];
  /** 各规则在原文上命中的区间数（只含命中的规则） */
  readonly ruleHits: Readonly<Record<string, number>>;
  /** 原文上扫描器的有界启发式跳过计数（见 SkipKind；只含种类与次数） */
  readonly skips: Readonly<Partial<Record<SkipKind, number>>>;
  /** T3 在原文上新增遮住的字符数（相对未知来源输出；不含换行） */
  readonly sourceChars: number;
  /** merged 路径并入的种子字符数（未知来源输出遮住的输入位置数，保证 ⊇） */
  readonly seedChars: number;
}

export interface SourcePolicyResult extends FloorResult {
  readonly source: SourcePolicyReport;
}

export interface SourcePolicyProvenanceResult extends SourcePolicyResult {
  /** 最终输出每个字符取自原始输入的位置；-1 为合成字符（测试期 oracle 用）。 */
  readonly origin: Int32Array;
}

/** 输入位置是否被遮（不出现在输出里），由逐字符来源表推出。 */
function hiddenFromOrigin(length: number, origin: Int32Array): Uint8Array {
  const hidden = new Uint8Array(length).fill(1);
  // 下标循环：类型化数组的迭代器协议在这里是热点（复查实测混合载体约占 HEAD 的三分之一）。
  for (let index = 0; index < origin.length; index++) {
    const from = origin[index] ?? -1;
    if (from >= 0 && from < length) {
      hidden[from] = 0;
    }
  }
  return hidden;
}

function maskToSpans(mask: Uint8Array): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  let index = 0;
  while (index < mask.length) {
    if (mask[index] !== 1) {
      index++;
      continue;
    }
    const start = index;
    while (index < mask.length && mask[index] === 1) {
      index++;
    }
    spans.push([start, index]);
  }
  return spans;
}

/**
 * 去掉整段落在文本原有完整标记内的区间。这类区间渲染时原样输出（标记是信息等价字符，不计入 S 与 A），
 * 把它们交给底线只会让确认不动点的那一轮白白重渲染整篇文本。
 * spans 按起点升序（detectSourcePolicySpans 的输出），标记核心同样升序、互不重叠：双指针一遍扫完，不分配与
 * 文本等长的位置表；文本里没有标记时原样返回。
 */
function spansOutsideMarkers(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>,
  cores: ReadonlyArray<readonly [number, number]> = markerCores(text)
): Array<readonly [number, number]> {
  if (spans.length === 0) {
    return [];
  }
  if (cores.length === 0) {
    return spans.slice();
  }
  const outside: Array<readonly [number, number]> = [];
  let first = 0;
  for (const span of spans) {
    const [start, end] = span;
    while (first < cores.length && (cores[first]?.[1] ?? 0) <= start) {
      first++;
    }
    // 从 start 起沿相接的标记核心向后推进；推进不到 end 说明区间里有标记之外的字符。
    let at = start;
    for (let index = first; index < cores.length && at < end; index++) {
      const core = cores[index];
      if (core === undefined || core[0] > at) {
        break;
      }
      at = Math.max(at, core[1]);
    }
    if (at < end) {
      outside.push(span);
    }
  }
  return outside;
}

/** 区间里所有字符都落在文本原有的完整标记内（渲染会原样输出，不改变文本）。 */
function spansInsideMarkers(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>
): boolean {
  return spansOutsideMarkers(text, spans).length === 0;
}

/**
 * T3 在原文上新增遮住的字符数（相对未知来源输出）：区间已合并（互不相交），逐区间计数，每个位置只计一次；
 * 换行是结构，渲染会放回；原文里已有的完整标记是信息等价字符（再脱敏已脱敏的内容时，T3 区间正落在这些标记上），
 * 也不计入。hiddenUnknown 为 null 表示未知来源没有遮任何位置。只扫区间内的位置，不扫整篇。
 */
function countSourceChars(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>,
  cores: ReadonlyArray<readonly [number, number]>,
  hiddenUnknown: Uint8Array | null
): number {
  let count = 0;
  let core = 0;
  for (const [start, end] of spans) {
    for (let index = Math.max(0, start); index < Math.min(text.length, end); index++) {
      while (core < cores.length && (cores[core]?.[1] ?? 0) <= index) {
        core++;
      }
      const current = cores[core];
      if (current !== undefined && current[0] <= index) {
        // 落在原有标记内：直接跳到标记末尾（循环自增前减一）。
        index = Math.min(end, current[1]) - 1;
        continue;
      }
      const code = text.charCodeAt(index);
      if (code === 10 || code === 13 || hiddenUnknown?.[index] === 1) {
        continue;
      }
      count++;
    }
  }
  return count;
}

function runSourcePolicyFloor(
  text: string,
  context: RedactionSourceContext | undefined,
  unknownOptions: RedactionFloorOptions,
  wantOrigin: boolean
): SourcePolicyProvenanceResult {
  const sourceClass = classifyRedactionSource(context);
  const rules = sourcePolicyRulesFor(sourceClass);
  const ruleIds = rules.map((rule) => rule.id);
  if (rules.length === 0) {
    // 没有来源上下文或该来源没有 T3 规则：与 redactDeveloperText 同一把尺（同一组未知来源选项）。
    const base: ProvenanceResult = wantOrigin
      ? applyRedactionFloorWithProvenance(text, unknownOptions)
      : { ...applyRedactionFloor(text, unknownOptions), origin: new Int32Array(0) };
    return {
      text: base.text,
      report: base.report,
      origin: base.origin,
      source: {
        sourceClass,
        path: context ? 'no-source-rules' : 'unknown-source',
        ruleIds,
        ruleHits: {},
        skips: {},
        sourceChars: 0,
        seedChars: 0,
      },
    };
  }
  const tool = context?.tool;
  const first = detectSourcePolicySpans(text, rules, tool);
  // 本次调用新建的重放共享：未知来源底线与合并路径的底线都从同一原文开始，第一轮四个版本的冻结输出与追踪重放
  // 只算一次（合并路径原本要整整多跑一遍，复查实测逗号分隔形态因此到了 HEAD 的 8.8–9.9 倍）。
  const share = createFloorReplayShare(text);
  // 未知来源底线跑一次：covered 判定的新增字符计数与合并路径的种子都要它遮住的确切位置（逐字符来源）。
  // T3 在原文上没有命中时只可能走 no-span 快路径，不需要来源表，按门面原样跑（语料上绝大多数调用走这里）；
  // 快路径不成立时再带来源补跑一遍（第一轮经 share 复用），见下方 provenanceRerun。
  const unknownWithOrigin = wantOrigin || first.spans.length > 0;
  let unknown: ProvenanceResult = unknownWithOrigin
    ? applyRedactionFloorWithProvenance(text, { ...unknownOptions, replayShare: share })
    : {
        ...applyRedactionFloor(text, { ...unknownOptions, replayShare: share }),
        origin: new Int32Array(0),
      };
  // 两条快路径共同的精确条件：未知来源一轮收敛（第二轮确认不动点），且 T3 在它的输出上只落在已有标记内。
  // 此时若 T3 在原文上没有命中（no-span），或命中的区间都已被未知来源遮住（covered，sourceChars 为 0），
  // 带来源的运行每一轮的遮蔽集合都与未知来源运行相同，输出逐字相同，不必再跑合并路径。
  // 只在某条快路径可能成立时才在输出上再扫一遍 T3（合并路径用不到它）；未知来源没有改动文本时直接复用原文上的区间。
  const converged = unknown.report.fixpointReached && unknown.report.rounds <= 2;
  let stable: boolean | null = null;
  const stableOnOutput = (): boolean => {
    stable ??=
      converged &&
      spansInsideMarkers(
        unknown.text,
        unknown.text === text
          ? first.spans
          : detectSourcePolicySpans(unknown.text, rules, tool).spans
      );
    return stable;
  };
  if (first.spans.length === 0 && stableOnOutput()) {
    // 最常见的情形（终端输出里没有任何 T3 形态）。
    return {
      text: unknown.text,
      report: unknown.report,
      origin: wantOrigin ? unknown.origin : new Int32Array(0),
      source: {
        sourceClass,
        path: 'no-span',
        ruleIds,
        ruleHits: {},
        skips: first.skips,
        sourceChars: 0,
        seedChars: 0,
      },
    };
  }
  if (!unknownWithOrigin) {
    // provenanceRerun（罕见）：T3 在原文上没有命中，但未知来源没有一轮收敛，或 T3 在它的输出上落到了标记之外，
    // 要走合并路径，而种子需要确切的被遮位置。补跑一遍带来源的未知来源底线：第一轮经 share 复用，底线是确定性的，
    // 输出与报告和第一遍逐位相同（只多出来源表）。这只是性能上的补算，不改变任何判定，所以不单独记入报告。
    unknown = applyRedactionFloorWithProvenance(text, { ...unknownOptions, replayShare: share });
  }
  // 未知来源没有改动文本（第一轮就是不动点）时没有被遮的输入位置，种子为空，不必从来源表推导。
  const hiddenUnknown =
    unknown.text === text ? null : hiddenFromOrigin(text.length, unknown.origin);
  const textCores = markerCores(text);
  const sourceChars = countSourceChars(text, first.spans, textCores, hiddenUnknown);
  if (sourceChars === 0 && stableOnOutput()) {
    return {
      text: unknown.text,
      report: unknown.report,
      origin: wantOrigin ? unknown.origin : new Int32Array(0),
      source: {
        sourceClass,
        path: 'covered',
        ruleIds,
        ruleHits: first.hits,
        skips: first.skips,
        sourceChars: 0,
        seedChars: 0,
      },
    };
  }
  // 合并路径：种子（未知来源最终遮住的输入位置）只在第一轮原文上并入，之后每轮只会遮得更多，
  // 所以最终遮蔽 ⊇ 未知来源遮蔽（不变量 A），与多轮组合是否单调无关。T3 区间每轮都在该轮原文上重算（不串接）；
  // 第一轮的原文就是 text，直接复用上面已经算好的区间。第一轮的版本部分（重放、位掩码、缺口、结构分析）经 share
  // 复用未知来源那一遍的结果，合并路径的第一轮只并入区间并渲染一次。
  const seed = hiddenUnknown === null ? [] : maskToSpans(hiddenUnknown);
  let seedChars = 0;
  for (const [start, end] of seed) {
    seedChars += end - start;
  }
  const firstOutside = spansOutsideMarkers(text, first.spans, textCores);
  const sourceDetector: FloorDetector = (current) =>
    current === text
      ? firstOutside
      : spansOutsideMarkers(current, detectSourcePolicySpans(current, rules, tool).spans);
  // 未知来源的检测器表（unknownOptions.detectors，缺省即默认 T1 表）原样保留，不替换；T3 区间与种子走
  // sourceDetectors：同一轮并入、不串接，且不按级联触发前缀切开（种子要整段并入才保证 ⊇，见 legacyFloor）。
  const sourceDetectors: FloorDetector[] = [sourceDetector];
  if (seed.length > 0) {
    sourceDetectors.push((current) => (current === text ? seed : []));
  }
  const options: RedactionFloorOptions = {
    ...unknownOptions,
    sourceDetectors,
    replayShare: share,
  };
  const merged: ProvenanceResult = wantOrigin
    ? applyRedactionFloorWithProvenance(text, options)
    : { ...applyRedactionFloor(text, options), origin: new Int32Array(0) };
  return {
    text: merged.text,
    report: merged.report,
    origin: merged.origin,
    source: {
      sourceClass,
      path: 'merged',
      ruleIds,
      ruleHits: first.hits,
      skips: first.skips,
      sourceChars,
      seedChars,
    },
  };
}

/**
 * 带来源上下文的底线：未知来源选项（与 redactDeveloperText 相同）之上追加 T3。纯函数，报告只含计数与种类。
 * unknownOptions 必须与门面 redactDeveloperText 使用的选项相同，否则不变量 A 的比较对象不一致。
 */
export function applySourcePolicyFloor(
  text: string,
  context: RedactionSourceContext | undefined,
  unknownOptions: RedactionFloorOptions = {}
): SourcePolicyResult {
  const {
    text: output,
    report,
    source,
  } = runSourcePolicyFloor(text, context, unknownOptions, false);
  return { text: output, report, source };
}

/** 同 applySourcePolicyFloor，另返回最终输出到原始输入的逐字符来源（测试期 oracle 用）。 */
export function applySourcePolicyFloorWithProvenance(
  text: string,
  context: RedactionSourceContext | undefined,
  unknownOptions: RedactionFloorOptions = {}
): SourcePolicyProvenanceResult {
  return runSourcePolicyFloor(text, context, unknownOptions, true);
}
