/**
 * terminal.exec 的两道静态检查：
 *
 * 1. checkTerminalCommandSafety —— 危险命令黑名单。它是启发式纵深防御，不是写边界：
 *    真正限制写入范围的是宿主注入的 sandbox profile（project-write 沙箱）；rm -r、find -delete、
 *    git clean 等删除按设计不归这里拦截。DENIED_BINS 与 eval 走双重判定，任一命中即拒绝（L4-P8c）：
 *    (a) 不依赖词法器的兜底：把每一层命令串的原始文本按空白、; & | ( ) < > 与反引号切成块（反斜杠连同其后
 *        一个字符不切开，续行同样不切开），每块按宽松的去引号读法还原（删去引号与转义反斜杠、解码 $'...'），
 *        还原值再按空白、换行与上述运算符切片，逐片按命令名规范化（取最后一个 '/' 之后的名字、小写、GNU g 前缀、
 *        mkfs.<fstype>、提权程序名族的显式清单）后与 DENIED_BINS/eval 比较（W-SEC1；W-SEC1r1 起名字族不按后缀
 *        泛化，'npm run su-check' 不算命中）。所以路径写法（/usr/bin/sudo、
 *        ../bin/sudo）、转义写法（\sudo、s\udo、su\<换行>do）、引号拼接（s''udo、"/sbin/"reboot）、ANSI-C 引号
 *        （$'\x73udo'）、名字族变体（sudo-rs、sudo.ws）以及被转义的分隔符连起来的名字（'sh -c id\;sudo'、
 *        'ssh host sudo\ reboot'、$'id\x3bsudo'：交给 sh -c、ssh 再切词时分隔符重新生效）都命中。命中后只有
 *        token 判定确认它是只读取证命令（rg/grep/git log 等，以及只查手册页的 man）的参数、查询类 wrapper 的
 *        操作数、注释，或已在嵌套层单独检查过的 shell 命令串时才放行并记诊断；命令替换体里的命中按承载替换的
 *        外层词判定，放行的命中词还要求其输出（管道、进程替换、coproc、同一命令里写出的文件）只流向惰性程序，
 *        不流向会执行它的命令；
 *    (b) token 级判定：命令位置（含已知执行 wrapper、引导命令的保留字、shell 命令串、find -exec 动作、
 *        命令替换体）上的 DENIED_BINS、eval 与 rm 递归强删；命令名经同一规范化，路径写法与名字族变体同样识别。
 *    别名、脚本文件内容、node -e/python -c/awk system() 这类解释器内代码、不在 EXEC_WRAPPERS 里的 wrapper
 *    都不求值，属于 (b) 的已知盲区，其中字面出现（含上述路径、转义、引号与名字族写法）的 DENIED_BINS/eval
 *    由 (a) 兜底。运行时才拼出的名字不在兜底范围内：参数展开（su${E}do）、花括号展开（s{u,}do）、路径名通配
 *    （/usr/bin/su?o）与命令替换的输出（$(printf ...)）都不求值，选项值粘连写法（--pre=sudo、-Psudo）也不切开。
 *    命令替换的输出决定执行身份、wrapper 结构、rm 选项、shell 命令串或 find 表达式时静态无法判定，
 *    一律 fail-closed；参数展开（$VAR、"$@"、${VAR}）出现在命令位置、wrapper 结构或 -c 命令串里时同样
 *    fail-closed（展开为空或多个词会改变执行身份与切分）。shell（及 source/.）从 stdin 或运行时描述符读程序
 *    （管道、进程替换、/dev/stdin）而不是 here-string 时、-c 命令串缺失或是 find/xargs 占位时、xargs 的目标
 *    是 shell/解释器/find 或没有静态目标（输入项成为命令）时、xargs 的非取证目标的参数里出现解释器/find/执行
 *    wrapper 的名字或运行时值（目标可能是 caffeinate、flock 这类未知 wrapper）时同样 fail-closed。
 *    xargs 的目标每层只解包一次，嵌套 xargs 的检查成本与层数成线性。
 *    词法上无法可靠切分的结构（任意层级的 heredoc '<<'/'<<-'、
 *    未闭合的替换、替换内的 case/注释、带嵌套引号或替换的 ${...}）同样 fail-closed。续行（反斜杠+换行）
 *    在切词前删除，'$\<换行>(' 与 '<\<换行><' 分别按 '$(' 与 '<<' 处理；'2>x cmd' 的 2 是描述符不是命令；
 *    '&>' 在 POSIX sh 里是 '&' 加 '>'，两种读法都检查（POSIX 读法按 '&>' 线性切段）。词首 '#' 注释是否生效
 *    取决于 shell，出现时“注释到行尾”与“'#' 是字面量”两种读法都检查，任一读法命中或无法切分即拦截。
 *    超过 MAX_TERMINAL_COMMAND_LENGTH 的命令不做切分，直接 fail-closed（同步检查不能长时间占住事件循环）。
 * 2. checkTerminalCommandAllowlist —— 只读能力（Evolution）的 bin 白名单与写类参数/子命令约束。
 *    宿主只读沙箱启用前，会执行仓库代码的命令（node、npm/pnpm/yarn、npx、vitest、jest、eslint）由
 *    EVOLUTION_CODE_EXECUTION_ENABLED 整体关闭（L4-P7d），以 allowlist-code-execution-disabled 拒绝；
 *    调用方告知工作目录不在项目根时 git 以 allowlist-git-cwd 拒绝（见 TerminalAllowlistCallContext）。
 */
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';

/**
 * 被禁程序的规范名。提权类（sudo、su、doas、pkexec、run0）另按名字族的显式清单识别（sudo-rs、sudo.ws、
 * sudoedit 等确有其物的提权程序，见 PRIVILEGE_FAMILY_ROOTS；W-SEC1r1 起不按任意后缀泛化）；mkfs 覆盖
 * mkfs.<fstype>。命令名先经 normalizeBinName 规范化再比较。
 */
export const DENIED_BINS = new Set([
  'sudo',
  'su',
  'doas',
  'pkexec',
  'run0',
  'shutdown',
  'reboot',
  'halt',
  'mkfs',
  'dd',
  'passwd',
  'killall',
]);

export interface TerminalSafetyBlock {
  rule: string;
  reason: string;
}

const READONLY_GIT_SUBCOMMANDS = new Set([
  'log',
  'blame',
  'diff',
  'status',
  'show',
  'rev-parse',
  'ls-files',
]);

const READONLY_PACKAGE_SCRIPTS = new Set(['test', 'lint', 'build:check', 'typecheck']);
const READONLY_BIOME_COMMANDS = new Set(['check', 'ci']);

/*
 * Evolution 代码执行开关（L4-P7d，用户决定 2026-10-18，负责方：AlembicAgent 窗口）
 *
 * 为什么关闭：只读 allowlist 是 Evolution 唯一的只读屏障——宿主 SandboxExecutorBridge 目前不读
 * opts.intent，仍按固定的可写项目目录 profile 执行。测试运行器、包管理器脚本与 eslint 本身就会执行仓库代码，
 * 静态参数检查已三次被审计找到绕过，最近一次确认的两条见下方“恢复前必须先修”。所以在宿主真正提供只读
 * 文件系统之前，这类命令整体不运行，而不是继续追加参数规则。
 *
 * 关闭时拒绝（规则 allowlist-code-execution-disabled，不看参数）：
 * - node 的任何形式（含 node --test、直接运行脚本、-e、--version）；
 * - npm/pnpm/yarn 的全部子命令（只读 allowlist 原本只放行 test 与 run，二者连同 '--' 透传都会执行仓库脚本）；
 * - npx（运行项目安装的或现下载的任意包）；
 * - vitest、jest（加载并执行测试文件与配置）；
 * - eslint（加载 eslint.config.js 等 JS 配置时就执行仓库代码）。
 * 仍放行：git 只读子命令（只在项目根运行，见 TerminalAllowlistCallContext）、rg、grep、ls、cat、head、tail、
 * wc、find（写类/执行类参数黑名单不变）、tsc --noEmit、biome check/ci —— 它们只读取文件，不加载仓库里的 JS。
 *
 * 恢复条件：宿主 SandboxExecutorBridge 按 intent 为 Evolution 启用只读文件系统并验收通过（L4-P38 / I47）。
 * 恢复前必须先修掉两条已确认的绕过（规则代码保留在 checkNodeSubcommand 与 checkPackageManagerSubcommand /
 * checkRunnerPassthrough，开关恢复后仍要用）：
 * 1.（高）'node --test --test-name-pattern scripts/* test/a.test.mjs'：空格写法的需值选项把紧随的 token
 *    当作值，但宿主 /bin/sh 先做路径名展开，未加引号的 scripts/* 展开成多个词，第一个成为 pattern 值，其余成为
 *    --test 的位置参数被执行；
 * 2.（中）'npm run typecheck -- test/a.test.ts'：透传的文件参数让 tsc 忽略 tsconfig（含 noEmit）并写出 JS。
 * 恢复时把本常量改回 true，并把测试里按“已禁用”断言的用例改回放行断言。
 */
const EVOLUTION_CODE_EXECUTION_ENABLED: boolean = false;

/** 开关关闭时整体拒绝的 bin：运行它们就会执行被分析仓库里的代码（见上）。 */
const CODE_EXECUTING_BINS = new Set([
  'node',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'vitest',
  'jest',
  'eslint',
]);

/*
 * 只读 allowlist 的选项判定（L4-P07 → L4-P7a）
 *
 * 7ac8836 只按字面拼写比较黑名单，审计用同一 bin 的等价拼写全部绕过：tsc 的单横线长选项
 * （-incremental）、jest 的 kebab/camel 互换（--cache-directory）、biome/rg/npm 未登记的写盘或执行选项。
 * 这里改成结构化判定：
 * 1. parseOption 按 bin 无关的规则规范化选项名：去掉前导一或两个横线，去掉 '=' 之后的值与 '.' 之后的
 *    子键，再把 kebab/snake/camel 折叠成无分隔小写（--cache-directory、--cacheDirectory、-cacheDirectory
 *    都得到 cachedirectory）；黑名单与白名单都按规范化后的名字比较。
 *    eslint 的 optionator 另有一套切名规则：选项名只取 [A-Za-z][-A-Za-z0-9]*，名字之后的 '_'、'/'、':' 等
 *    字符在没有 '=' 紧随时被静默丢弃（--fix_x 即 --fix，--format/x 等于 --format 并取下一个 token 为值）。
 *    所以黑名单同时按“名字段”（stem）比较；其它 bin 的解析器（rg、biome、git、tsc 实测）会把这类 token
 *    当未知选项报错退出，多拦一次不损失只读能力。值类选项（reporter/formatter 等）只接受规整写法，
 *    空格写法的值取紧随其后的 token，不论它是否以 '-' 开头（optionator 把 -/..、--/..、-1/.. 都当值）。
 * 2. BIN_DASH_SYNTAX 记录每个 bin 怎样解释单横线多字符 token：tsc/find/node 当长选项名
 *    （tsc -incremental、find -delete），其余 getopt/yargs/cac/optionator 风格的 bin 当短选项簇逐字母比较
 *    （ls -fls、grep -in、rg -uu 不会被当成某个长选项名误判）。未知 bin 两种解释都查。
 * 3. 写盘/执行类条目按 bin 分表（BIN_OPTION_TABLES），跨 bin 同名但含义不同的参数不再进共享表：
 *    git blame --incremental、ls -fls、grep -i、rg -u 都是只读参数。
 * 4. 测试运行器（vitest/jest/node --test）与包管理器自身选项改为白名单；包管理器 '--' 之后交给
 *    运行器无关的透传规则：运行器未知，所以取 vitest/jest/node --test 以及 lint/typecheck 脚本的并集从严判定。
 * 5. 宿主经 '/bin/sh -c' 执行命令，shell 层变换会让真实 argv 偏离本检查看到的词：未加引号的花括号展开
 *    （按 bash 的配对规则判定：HEAD@{1}、x{a}y 原样保留，{a,b}、{1..3}、{a}b,c} 会展开，见 findBraceExpansion）、
 *    词首 '#' 注释（丢掉其后的词）、空格/制表符以外的空白（本检查切词、sh 不切）、NUL 等控制字符（NUL 截断
 *    交给 sh 的 C 字符串）、能展开成以 '-' 开头的文件名的未加引号 glob（仓库里名为 '--pre=sh' 的文件让
 *    'rg Recipe *' 多出一个执行选项），以及测试路径里以 '.' 开头的 glob 段（展开成 '..'）。
 *    这些写法一律拒绝，而不是尝试模拟 shell 展开结果。
 * 这些都只是静态 literal 检查；npm test 等命令仍会执行仓库自身代码，真正只读要靠宿主只读沙箱（L4-P38）。
 * 在那之前这类命令由 EVOLUTION_CODE_EXECUTION_ENABLED 整体关闭，第 4 条的运行器/透传规则保留待恢复时使用。
 */

/** 选项风险类别：写盘、加载/执行模型挑选的模块或可执行文件、开端口/起服务。类别决定拒绝规则 id。 */
type OptionRisk = 'write' | 'exec' | 'network';

const OPTION_RISK_RULES: Readonly<Record<OptionRisk, string>> = {
  write: 'allowlist-write-like-arg',
  exec: 'allowlist-exec-like-arg',
  network: 'allowlist-network-like-arg',
};

const OPTION_RISK_LABELS: Readonly<Record<OptionRisk, string>> = {
  write: 'Write-like',
  exec: 'Module/executable-loading',
  network: 'Network/server',
};

/** 值需要校验的选项：返回 null 表示该值只读安全，否则返回风险类别。 */
type OptionValueCheck = (value: string) => OptionRisk | null;

interface OptionTable {
  /** 规范化名 → 风险。单字母条目在短选项簇语法下逐字母比较（不区分大小写，BSD sed -I 与 -i 同义）。 */
  names: ReadonlyMap<string, OptionRisk>;
  /** 规范化名前缀族，例如 --coverage* 与 eslint --cache* / --suppress*。 */
  prefixes: ReadonlyArray<readonly [string, OptionRisk]>;
  /** 规范化点号全路径，例如 vitest --typecheck.checker（只封子键，--typecheck.only 仍放行）。 */
  paths: ReadonlyMap<string, OptionRisk>;
  /** 值需要校验的选项（reporter、formatter、environment 等可以是模块路径）。 */
  values: ReadonlyMap<string, OptionValueCheck>;
  /**
   * GNU getopt_long 接受无歧义的长选项前缀：[完整规范化名, 最短无歧义前缀长度, 风险]。
   * 例如 GNU sed 的 --in、--in-pl 都等于 --in-place。
   */
  abbreviations: ReadonlyArray<readonly [string, number, OptionRisk]>;
}

/** 单横线多字符 token 的解释方式：cluster=短选项簇，long=长选项名，unknown=两种都查。 */
type DashSyntax = 'cluster' | 'long' | 'unknown';

const BIN_DASH_SYNTAX = new Map<string, DashSyntax>([
  ['tsc', 'long'],
  ['find', 'long'],
  ['node', 'long'],
  ...[
    'git',
    'rg',
    'grep',
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'jest',
    'vitest',
    'eslint',
    'biome',
    'npm',
    'pnpm',
    'yarn',
    'sed',
    'man',
  ].map((bin) => [bin, 'cluster'] as const),
]);

function riskOptionTable(spec: {
  names?: Record<OptionRisk, readonly string[]>;
  prefixes?: ReadonlyArray<readonly [string, OptionRisk]>;
  paths?: ReadonlyArray<readonly [string, OptionRisk]>;
  values?: ReadonlyArray<readonly [string, OptionValueCheck]>;
  abbreviations?: ReadonlyArray<readonly [string, number, OptionRisk]>;
}): OptionTable {
  const names = new Map<string, OptionRisk>();
  for (const risk of ['write', 'exec', 'network'] as const) {
    for (const name of spec.names?.[risk] ?? []) {
      names.set(name, risk);
    }
  }
  return {
    names,
    prefixes: spec.prefixes ?? [],
    paths: new Map(spec.paths ?? []),
    values: new Map(spec.values ?? []),
    abbreviations: spec.abbreviations ?? [],
  };
}

/** 多张表合并成一张（先出现的条目优先），用于运行器未知的透传规则。 */
function mergeOptionTables(tables: readonly OptionTable[]): OptionTable {
  const names = new Map<string, OptionRisk>();
  const paths = new Map<string, OptionRisk>();
  const values = new Map<string, OptionValueCheck>();
  const prefixes: Array<readonly [string, OptionRisk]> = [];
  const abbreviations: Array<readonly [string, number, OptionRisk]> = [];
  for (const table of tables) {
    for (const [key, risk] of table.names) {
      if (!names.has(key)) {
        names.set(key, risk);
      }
    }
    for (const [key, risk] of table.paths) {
      if (!paths.has(key)) {
        paths.set(key, risk);
      }
    }
    for (const [key, check] of table.values) {
      if (!values.has(key)) {
        values.set(key, check);
      }
    }
    prefixes.push(...table.prefixes);
    abbreviations.push(...table.abbreviations);
  }
  return { names, prefixes, paths, values, abbreviations };
}

function builtinValueCheck(
  allowed: ReadonlySet<string>,
  overrides: ReadonlyMap<string, OptionRisk> = new Map()
): OptionValueCheck {
  // 非内置名会被当作包名或模块路径加载执行；比较保持大小写敏感，与各工具的解析一致。
  return (value) => overrides.get(value) ?? (allowed.has(value) ? null : 'exec');
}

// vitest 内置 reporter，按已安装的 vitest 4.1.6 源码核对（dist/chunks/index.*.js 的 ReportersMap：default、
// agent、minimal、blob、verbose、dot、json、tap、tap-flat、junit、tree、hanging-process、github-actions；
// html 由 createReporters 单独加载 @vitest/ui）。不在表里的名字（包括 vitest 3 才有、4.x 已移除的 basic）
// 会被 loadCustomReporterModule 当作模块从项目根解析并 import 执行，所以这里只列表内名字。
// blob/html 不带 --outputFile 也会落盘，github-actions 在 CI 下写 job summary，三者按写盘拒绝。
// 升级 vitest 时以测试里对 vitest/node 导出的 ReportersMap 的同步断言为准。
const VITEST_READONLY_REPORTERS = new Set([
  'default',
  'agent',
  'minimal',
  'verbose',
  'dot',
  'json',
  'tap',
  'tap-flat',
  'junit',
  'tree',
  'hanging-process',
]);
const VITEST_WRITING_REPORTERS = new Map<string, OptionRisk>([
  ['blob', 'write'],
  ['html', 'write'],
  ['github-actions', 'write'],
]);
const VITEST_BUILTIN_ENVIRONMENTS = new Set(['node', 'jsdom', 'happy-dom', 'edge-runtime']);
const VITEST_BUILTIN_POOLS = new Set(['threads', 'forks', 'vmThreads', 'vmForks']);
// ESLint 8/9 的内置 formatter；其余名字会解析成 eslint-formatter-* 包或路径并加载执行。
// ESLint 9 对这些名字同样先尝试项目 node_modules 里的 eslint-formatter-<name> 包，那属于项目已安装的代码
// （与配置文件加载插件同类），不是模型挑选的文件；真正隔离仍靠宿主只读沙箱（L4-P38）。
const ESLINT_BUILTIN_FORMATTERS = new Set([
  'stylish',
  'json',
  'json-with-metadata',
  'html',
  'checkstyle',
  'compact',
  'jslint-xml',
  'junit',
  'tap',
  'unix',
  'visualstudio',
]);
// 自定义 reporter 是模块路径或包名，node 会加载并执行它；只放行 Node 内置 reporter 名。
const NODE_TEST_BUILTIN_REPORTERS = new Set(['tap', 'spec', 'dot', 'junit', 'lcov']);

const vitestReporterCheck = builtinValueCheck(VITEST_READONLY_REPORTERS, VITEST_WRITING_REPORTERS);

/** 对所有 bin 生效的写类选项：这些名字在任何只读 bin 上都没有只读含义。 */
const GENERIC_OPTION_TABLE = riskOptionTable({
  names: {
    write: [
      'fix',
      'write',
      'output',
      'outputfile',
      'update',
      'updatesnapshot',
      'inplace',
      'init',
      'cachedirectory',
      'clearcache',
    ],
    exec: [],
    network: [],
  },
  // jest/vitest 的 --coverage*、jest 的 collectCoverage（官方描述为 --coverage 的别名）都会写覆盖率报告；
  // --coverage=false 这类显式关闭写法也一并拒绝（默认即不开覆盖率）。
  prefixes: [
    ['coverage', 'write'],
    ['collectcoverage', 'write'],
  ],
});

const TSC_OPTION_TABLE = riskOptionTable({
  // tsc：-b/--build 与 -i/--incremental/--tsBuildInfoFile/--composite 即使带 --noEmit 也写 tsbuildinfo，
  // --generateTrace/--generateCpuProfile 写诊断文件（--init 在通用表里）。tsc 选项名大小写不敏感。
  names: {
    write: [
      'build',
      'b',
      'incremental',
      'i',
      'tsbuildinfofile',
      'generatetrace',
      'generatecpuprofile',
      'composite',
    ],
    exec: [],
    network: [],
  },
});

const FIND_OPTION_TABLE = riskOptionTable({
  // find：-delete 删除、-fprint*/-fls 把结果写进文件，-exec*/-ok* 执行任意命令。
  names: {
    write: ['delete', 'fprint', 'fprint0', 'fprintf', 'fls'],
    exec: ['exec', 'execdir', 'ok', 'okdir'],
    network: [],
  },
});

const GIT_OPTION_TABLE = riskOptionTable({
  // git diff/log/show：--ext-diff 与 --textconv 运行仓库配置的外部程序（--output 在通用表里）。
  // 只读的 blame --incremental 只是输出格式，不在任何表里。
  names: { write: [], exec: ['extdiff', 'textconv'], network: [] },
});

const RG_OPTION_TABLE = riskOptionTable({
  // ripgrep：--pre 对每个文件执行预处理程序；≥14 的 --hostname-bin 配合 --hyperlink-format 无参执行任意可执行文件。
  names: { write: [], exec: ['pre', 'hostnamebin'], network: [] },
});

const ESLINT_OPTION_TABLE = riskOptionTable({
  // eslint：-o/--output-file 写报告，--cache* 写缓存，--suppress*/--prune-suppressions 写 suppressions 文件；
  // -c/--config、--plugin、--parser、--rulesdir 与非内置 -f/--format 都会加载执行模块。
  names: {
    write: ['o', 'prunesuppressions'],
    exec: ['c', 'config', 'plugin', 'parser', 'rulesdir', 'resolvepluginsrelativeto', 'mcp'],
    network: ['inspectconfig'],
  },
  prefixes: [
    ['cache', 'write'],
    ['suppress', 'write'],
  ],
  values: [
    ['f', builtinValueCheck(ESLINT_BUILTIN_FORMATTERS)],
    ['format', builtinValueCheck(ESLINT_BUILTIN_FORMATTERS)],
  ],
});

const BIOME_OPTION_TABLE = riskOptionTable({
  // biome 2.x check/ci：--reporter-file/--log-file/--log-path 写任意路径；--write/--fix（通用表）、
  // --unsafe 与 biome 1.x 的 --apply/--apply-unsafe 写回修复。
  names: {
    write: ['unsafe', 'apply', 'applyunsafe', 'reporterfile', 'logfile', 'logpath'],
    exec: [],
    network: [],
  },
});

const SED_OPTION_TABLE = riskOptionTable({
  // sed 不在 Evolution allowlist，但本函数对调用方给出的 bins 通用：-i/-I 原地改写（含 -i.bak、-Ei 簇）。
  // sed 脚本里的 w/e 命令不在这里解析，sed 本身不应进入只读 allowlist。
  names: { write: ['i'], exec: [], network: [] },
  // GNU sed 的长选项里只有 --in-place 以 i 开头，--i、--in、--in-pl … 都是它的无歧义缩写。
  abbreviations: [['inplace', 1, 'write']],
});

const MAN_OPTION_TABLE = riskOptionTable({
  // man 不在 Evolution allowlist，只供危险命令黑名单 (a) 兜底判定“只查手册页”（W-SEC1，见 isManualPageLookup）。
  // macOS 的 man 是 shell 脚本：-P 分页器与 -C 配置文件里的变量都交给 eval，-M 换手册路径后找到的页面路径同样
  // 进 eval；man-db 的 -P/--pager、-H/--html（浏览器）、-X/--gxditview 运行外部程序，-C/--config-file 可改分页器，
  // -l/--local-file 格式化任意文件，-p/--preprocessor 选预处理器，-c/--catman 与 -u/--update 写缓存。
  // 单字母按短选项簇逐字母、不区分大小写比较，-h 帮助、-L 语言、-m 其它系统手册也一并拒绝，不损失取证能力。
  names: {
    write: ['u', 'catman'],
    exec: [
      'p',
      'c',
      'm',
      'h',
      'x',
      'l',
      'pager',
      'html',
      'gxditview',
      'configfile',
      'manpath',
      'localfile',
      'preprocessor',
    ],
    network: [],
  },
  // man-db 用 argp，接受无歧义的长选项前缀（--pa 即 --pager；--pr 与 --prompt 有歧义，--pre 才是 --preprocessor）。
  abbreviations: [
    ['pager', 2, 'exec'],
    ['preprocessor', 3, 'exec'],
    ['html', 2, 'exec'],
    ['gxditview', 1, 'exec'],
    ['configfile', 2, 'exec'],
    ['catman', 2, 'write'],
    ['manpath', 3, 'exec'],
    ['localfile', 6, 'exec'],
  ],
});

const VITEST_OPTION_TABLE = riskOptionTable({
  // vitest 4.1 的 --help 全量核对：-u 更新快照、--attachmentsDir 写附件；-c/--config、--execArgv、--diff、
  // --root/--dir（可指向项目外的配置或测试集）、--experimental（含自定义 vcsProvider 与模块缓存）会加载执行
  // 或改写执行范围；--ui/--api/--browser/--inspect 开端口或浏览器。reporter/environment/pool 只放行内置名。
  names: {
    write: ['u', 'attachmentsdir'],
    exec: ['c', 'config', 'execargv', 'diff', 'root', 'r', 'dir', 'experimental'],
    network: ['ui', 'open', 'api', 'browser', 'inspect', 'inspectbrk', 'standalone'],
  },
  paths: [
    ['typecheck.checker', 'exec'],
    ['typecheck.tsconfig', 'exec'],
  ],
  values: [
    ['reporter', vitestReporterCheck],
    ['environment', builtinValueCheck(VITEST_BUILTIN_ENVIRONMENTS)],
    ['pool', builtinValueCheck(VITEST_BUILTIN_POOLS)],
  ],
});

const JEST_OPTION_TABLE = riskOptionTable({
  // jest（yargs）：-u 更新快照；以下选项加载执行模块，或改写测试文件集合/模块解析，让任意文件被当作测试执行。
  // 其余未进白名单的选项由 JEST_ALLOWED_OPTIONS 兜底拒绝。
  names: {
    write: ['u'],
    exec: [
      'c',
      'config',
      'globalsetup',
      'globalteardown',
      'testenvironment',
      'env',
      'testrunner',
      'runner',
      'reporters',
      'transform',
      'resolver',
      'testsequencer',
      'snapshotserializers',
      'snapshotresolver',
      'prettierpath',
      'filter',
      'testresultsprocessor',
      'preset',
      'projects',
      'rootdir',
      'roots',
      'modulenamemapper',
      'modulepaths',
      'moduledirectories',
      'testmatch',
      'testregex',
      'haste',
      'watchplugins',
      'dependencyextractor',
    ],
    network: [],
  },
  prefixes: [['setupfiles', 'exec']],
});

const BIN_OPTION_TABLES = new Map<string, OptionTable>([
  ['tsc', TSC_OPTION_TABLE],
  ['find', FIND_OPTION_TABLE],
  ['git', GIT_OPTION_TABLE],
  ['rg', RG_OPTION_TABLE],
  ['eslint', ESLINT_OPTION_TABLE],
  ['biome', BIOME_OPTION_TABLE],
  ['sed', SED_OPTION_TABLE],
  ['man', MAN_OPTION_TABLE],
  ['vitest', VITEST_OPTION_TABLE],
  ['jest', JEST_OPTION_TABLE],
]);

// node 在只读 allowlist 中只允许 test runner 模式，并且选项采用白名单（名字按 parseOption 规范化，
// Node 本身接受 '_' 与 '-' 互换，其余拼写 node 会直接报 bad option，不会放大能力）：
// - 标志选项：--test、--test-only
// - 需要值的只读选项：--test-name-pattern / --test-skip-pattern（进程内正则）、
//   --test-concurrency / --test-timeout（数字）、--test-reporter（仅内置 reporter 名）
// 其余 node 选项一律拒绝；其中 eval/print 与预加载类单独归类，便于诊断定位。
const NODE_TEST_FLAG_OPTIONS = new Set(['test', 'testonly']);
const NODE_TEST_VALUE_OPTIONS = new Set([
  'testnamepattern',
  'testskippattern',
  'testconcurrency',
  'testtimeout',
  'testreporter',
]);
const NODE_EVAL_OPTIONS = new Set(['e', 'p', 'pe', 'eval', 'print']);
// 预加载/导入类选项会在任何测试文件之前执行模型自写（data: URL）或仓库内的任意模块。
const NODE_PRELOAD_OPTIONS = new Set([
  'r',
  'require',
  'import',
  'loader',
  'experimentalloader',
  'envfile',
  'envfileifexists',
]);

const NODE_PASSTHROUGH_TABLE = riskOptionTable({
  // 透传给 node --test 时：eval/预加载与 --run（实测 node --test --run build 会改跑 package.json 脚本）执行代码，
  // --test-global-setup 加载模块；reporter destination、覆盖率、快照更新与失败重跑状态写盘。
  names: {
    write: [
      'testreporterdestination',
      'experimentaltestcoverage',
      'testupdatesnapshots',
      'testrerunfailures',
    ],
    exec: [...NODE_EVAL_OPTIONS, ...NODE_PRELOAD_OPTIONS, 'run', 'testglobalsetup'],
    network: [],
  },
  values: [['testreporter', builtinValueCheck(NODE_TEST_BUILTIN_REPORTERS)]],
});

// 包管理器 '--' 之后的参数会原样交给 test/lint/typecheck 脚本里的工具，脚本内容在这里不可见：
// 拒绝表取通用表与 vitest/jest/node --test、eslint/tsc/biome 的并集（按“未知 bin”语法同时查长名与短选项簇，
// 因为 tsc/node 把 -incremental 当长名，而 jest/vitest 把 -iu 当簇）。
const PASSTHROUGH_OPTION_TABLE = mergeOptionTables([
  GENERIC_OPTION_TABLE,
  VITEST_OPTION_TABLE,
  JEST_OPTION_TABLE,
  NODE_PASSTHROUGH_TABLE,
  ESLINT_OPTION_TABLE,
  TSC_OPTION_TABLE,
  BIOME_OPTION_TABLE,
]);

/** 白名单条目：value 决定透传时下一个 token 是否被当作值；subkeys 是允许的点号子键。 */
interface AllowedOption {
  value: 'none' | 'number' | 'enum' | 'pattern';
  subkeys?: ReadonlySet<string>;
}

function allowedOptions(spec: {
  none?: readonly string[];
  number?: readonly string[];
  enum?: readonly string[];
  pattern?: readonly string[];
  subkeys?: ReadonlyArray<readonly [string, ReadonlySet<string>]>;
}): ReadonlyMap<string, AllowedOption> {
  const result = new Map<string, AllowedOption>();
  for (const value of ['none', 'number', 'enum', 'pattern'] as const) {
    for (const name of spec[value] ?? []) {
      result.set(name, { value });
    }
  }
  for (const [name, subkeys] of spec.subkeys ?? []) {
    result.set(name, { value: result.get(name)?.value ?? 'none', subkeys });
  }
  return result;
}

const VITEST_TYPECHECK_SUBKEYS = new Set([
  'enabled',
  'only',
  'allowjs',
  'ignoresourceerrors',
  'spawntimeout',
]);
const VITEST_RETRY_SUBKEYS = new Set(['count', 'delay', 'condition']);
// 只放行 vitest 4.1 CLI 声明过的子键：cac 不校验未声明的点号子键，--sequence.sequencer=./x.mjs 会原样
// 进入配置（今天只会让 new Sequencer 抛 TypeError），不能让白名单依赖这种偶然。
const VITEST_SEQUENCE_SUBKEYS = new Set(['shuffle', 'concurrent', 'seed', 'hooks', 'setupfiles']);
const VITEST_EXPECT_SUBKEYS = new Set(['requireassertions', 'poll']);

// vitest 直接调用时的选项白名单（位置参数是过滤器，只会选中 include 匹配的测试文件，不受限）。
const VITEST_ALLOWED_OPTIONS = allowedOptions({
  none: [
    'run',
    'silent',
    'hideskippedtests',
    'passwithnotests',
    'logheapusage',
    'detectasyncleaks',
    'allowonly',
    'dangerouslyignoreunhandlederrors',
    'expandsnapshotdiff',
    'disableconsoleintercept',
    'printconsoletrace',
    'includetasklocation',
    'globals',
    'dom',
    'isolate',
    'noisolate',
    'fileparallelism',
    'nofileparallelism',
    'clearscreen',
    'noclearscreen',
    'color',
    'nocolor',
    'stricttags',
    'nostricttags',
    'listtags',
    'changed',
    'help',
    'h',
    'version',
    'v',
  ],
  number: [
    'bail',
    'shard',
    'testtimeout',
    'hooktimeout',
    'teardowntimeout',
    'slowtestthreshold',
    'maxconcurrency',
    'maxworkers',
    'vmmemorylimit',
  ],
  enum: ['reporter', 'environment', 'pool', 'configloader'],
  pattern: ['t', 'testnamepattern', 'project', 'mode', 'tagsfilter'],
  subkeys: [
    ['typecheck', VITEST_TYPECHECK_SUBKEYS],
    ['sequence', VITEST_SEQUENCE_SUBKEYS],
    ['expect', VITEST_EXPECT_SUBKEYS],
    ['retry', VITEST_RETRY_SUBKEYS],
  ],
});
const VITEST_SHORT_OPTIONS = new Set(['t', 'v', 'h']);
// vitest 的这些子命令不跑测试或会写文件（init 生成配置、list --json 写结果、bench 跑基准并可落盘）。
const VITEST_NON_RUN_SUBCOMMANDS = new Set(['init', 'bench', 'list', 'dev', 'watch', 'serve']);

// jest 直接调用时的选项白名单：只收只读的选测/输出/诊断参数，加载模块或改写测试集合的参数一律不在内。
const JEST_ALLOWED_OPTIONS = allowedOptions({
  none: [
    'ci',
    'json',
    'verbose',
    'silent',
    'b',
    'runinband',
    'i',
    'o',
    'onlychanged',
    'f',
    'onlyfailures',
    'lastcommit',
    'findrelatedtests',
    'listtests',
    'passwithnotests',
    'detectopenhandles',
    'detectleaks',
    'forceexit',
    'nostacktrace',
    'errorondeprecated',
    'e',
    'expand',
    'colors',
    'color',
    'showconfig',
    'clearmocks',
    'resetmocks',
    'restoremocks',
    'showseed',
    'randomize',
    'debug',
    'usestderr',
    'testlocationinresults',
    'nocache',
    'nowatchman',
    'injectglobals',
    'runtestsbypath',
    'all',
    'logheapusage',
    'help',
    'h',
    'version',
    'v',
  ],
  number: [
    'bail',
    'w',
    'maxworkers',
    'testtimeout',
    'seed',
    'shard',
    'maxconcurrency',
    'workeridlememorylimit',
    'openhandlestimeout',
    'testfailureexitcode',
  ],
  pattern: [
    't',
    'testnamepattern',
    'testpathpattern',
    'testpathpatterns',
    'testpathignorepatterns',
    'changedsince',
    'selectprojects',
    'ignoreprojects',
  ],
});
const JEST_SHORT_OPTIONS = new Set(['t', 'b', 'i', 'o', 'f', 'e', 'w', 'v', 'h']);

// 包管理器 '--' 之后（以及之前的位置参数）的运行器无关白名单：每一项在 vitest、jest、node --test 以及
// eslint/tsc/biome 下都是只读含义。free-form 值（pattern）必须用 '=' 内联，否则无法区分它是值还是会被
// 某个运行器当作文件执行的位置参数；数字/枚举值可以用空格写法。
const PASSTHROUGH_ALLOWED_OPTIONS = allowedOptions({
  none: [
    'silent',
    'ci',
    'json',
    'verbose',
    'passwithnotests',
    'logheapusage',
    'allowonly',
    'hideskippedtests',
    'detectopenhandles',
    'forceexit',
    'nostacktrace',
    'errorondeprecated',
    'expand',
    'color',
    'colors',
    'nocolor',
    'nocolors',
    'listtests',
    'showconfig',
    'clearmocks',
    'resetmocks',
    'restoremocks',
    'randomize',
    'showseed',
    'usestderr',
    'runinband',
    'onlychanged',
    'lastcommit',
    'detectasyncleaks',
    'expandsnapshotdiff',
    'disableconsoleintercept',
    'printconsoletrace',
    'includetasklocation',
    'isolate',
    'noisolate',
    'fileparallelism',
    'nofileparallelism',
    'globals',
    'dom',
    'nocache',
    'testonly',
    'help',
    'h',
    'version',
    'v',
  ],
  number: [
    'testtimeout',
    'hooktimeout',
    'teardowntimeout',
    'slowtestthreshold',
    'maxworkers',
    'maxconcurrency',
    'bail',
    'retry',
    'seed',
    'testconcurrency',
    'shard',
  ],
  enum: ['reporter', 'environment', 'testreporter'],
  pattern: [
    't',
    'testnamepattern',
    'testskippattern',
    'testpathpattern',
    'testpathpatterns',
    'testpathignorepatterns',
    'tagsfilter',
  ],
  subkeys: [
    ['typecheck', VITEST_TYPECHECK_SUBKEYS],
    ['sequence', VITEST_SEQUENCE_SUBKEYS],
  ],
});
const PASSTHROUGH_SHORT_OPTIONS = new Set(['t', 'v', 'h']);
const PASSTHROUGH_NUMBER_VALUE = /^(?:\d+(?:\.\d+)?%?|\d+\/\d+)$/;

// 包管理器在 '--' 之前的自身选项：npm/pnpm/yarn 的配置项（--script-shell、--node-options、--userconfig、
// --globalconfig、yarn --use-yarnrc …）会换掉执行脚本的 shell 或注入预加载模块；npm 的 nopt 还接受前缀缩写
// 与短选项簇，所以只放行这张小白名单，其余一律拒绝。
const PACKAGE_MANAGER_LONG_OPTIONS = new Set(['silent', 'ifpresent']);
const PACKAGE_MANAGER_SHORT_OPTIONS = new Set(['s']);

// tsc 里确定不取值的常见布尔选项：--noEmit 紧跟在这些选项之后才算真实生效。其它选项（--outDir、--locale、
// 未来新增的字符串选项）会把下一个 token 当作值吞掉，`tsc --outDir --noEmit` 实际照常产出 JS。
const TSC_FLAG_OPTIONS = new Set([
  'noemit',
  'pretty',
  'strict',
  'skiplibcheck',
  'skipdefaultlibcheck',
  'listfiles',
  'listfilesonly',
  'listemittedfiles',
  'explainfiles',
  'traceresolution',
  'diagnostics',
  'extendeddiagnostics',
  'noerrortruncation',
  'preservewatchoutput',
  'watch',
  'w',
  'showconfig',
  'all',
  'help',
  'h',
  'version',
  'v',
  'allowjs',
  'checkjs',
  'declaration',
  'd',
  'declarationmap',
  'sourcemap',
  'nocheck',
  'noimplicitany',
  'strictnullchecks',
  'noemitonerror',
  'nounusedlocals',
  'nounusedparameters',
  'noimplicitreturns',
  'nouncheckedindexedaccess',
  'esmoduleinterop',
  'isolatedmodules',
  'resolvejsonmodule',
  'experimentaldecorators',
  'emitdecoratormetadata',
  'forceconsistentcasinginfilenames',
  'exactoptionalpropertytypes',
  'verbatimmodulesyntax',
]);

// 测试文件位置参数（node --test 与包管理器透传）：文件名含 .test. / .spec.，或位于 test/、tests/、__tests__/ 目录。
const TEST_DIRECTORY_SEGMENTS = new Set(['test', 'tests', '__tests__']);
const TEST_FILE_NAME = /\.(?:test|spec)\./i;
// node --test 的位置参数是 glob：花括号/extglob/字符类可以把字面 .test. 变成可选，反斜杠是转义；
// 这些字符一律拒绝，只保留不会删除字面字符的 * 与 ?（以 '.' 开头的段除外，见 describeTestPathViolation）。
const TEST_PATH_GLOB_ALTERNATION = /[{}()[\]!\\]/;
// 以 '.' 开头且含 * / ? 的路径段：sh 的路径名展开要求显式写出前导 '.'，写出之后 '.?'、'.*'、'..*'
// 就能匹配 '.' 与 '..'（macOS /bin/sh 即 bash 3.2 实测 test/.?/scripts/release.mjs 执行了 scripts/release.mjs）。
const TEST_PATH_DOT_GLOB_SEGMENT = /^\.[^/]*[*?]/;

type SafetyVerdict = { safe: true } | { safe: false; block: TerminalSafetyBlock };

/** shell -c、命令替换、find -exec 等递归检查的嵌套上限；超过即 fail-closed。 */
const MAX_INSPECTION_DEPTH = 8;
/** wrapper 链（timeout nice env ... cmd）逐层解包的上限，防御异常输入。 */
const MAX_UNWRAP_DEPTH = 16;
/** 规格外选项按“带值/不带值”分叉后，一条命令最多检查的候选目标命令数。 */
const MAX_COMMAND_CANDIDATES = 32;
/** 单个 wrapper 选项解析允许访问的参数位置数。 */
const MAX_WRAPPER_PARSE_STATES = 64;
/**
 * 危险命令检查接受的最长命令（字符数）。检查全程同步执行，切词、wrapper 解包与 '&>' 双读法都随长度增长；
 * 正常的取证/构建命令远短于此，超限直接 fail-closed，而不是让一条超长命令占住事件循环。
 */
const MAX_TERMINAL_COMMAND_LENGTH = 32_768;

/**
 * 正则预检只保留 token 化无法表达、且命中即拒绝的模式：
 * - rm 合并旗标（rm -rf）出现在任意位置，包括解释器代码与引号内（awk/perl/python 里的 system 调用）；
 * - curl/wget 输出经管道交给 shell；
 * - fork bomb 函数定义。
 * sudo/su/dd 等 DENIED_BINS 与 eval 的原始文本兜底（findDeniedNameHits）不在这里：它命中后还要用 token
 * 判定排除 'rg -n sudo src'、'git log --grep su'、'ls dd' 这类取证命令，见 checkDeniedNameFallback。
 */
export function detectDangerousShellPayload(payload: string): TerminalSafetyBlock | null {
  const checks: Array<{ rule: string; reason: string; pattern: RegExp }> = [
    {
      rule: 'shell-rm-recursive-force',
      reason: 'Recursive force remove is blocked in terminal.exec',
      pattern:
        /\brm\s+["']?-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*["']?\b|\brm\s+["']?-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*["']?\b/im,
    },
    {
      rule: 'shell-remote-shell-pipe',
      reason: 'Piping remote content into a shell is blocked in terminal.exec',
      pattern: /\b(curl|wget)\b[^\n|]*\|\s*["']?(sh|bash|zsh|fish)["']?\b/im,
    },
    {
      rule: 'shell-fork-bomb',
      reason: 'Fork-bomb-like shell function syntax is blocked in terminal.exec',
      pattern: /:\s*\(\s*\)\s*\{/m,
    },
  ];

  for (const check of checks) {
    if (check.pattern.test(payload)) {
      return { rule: check.rule, reason: check.reason };
    }
  }
  return null;
}

export function checkTerminalCommandSafety(
  command: string
): { safe: true } | { safe: false; block: TerminalSafetyBlock } {
  if (command.length > MAX_TERMINAL_COMMAND_LENGTH) {
    // 只记录长度，不记录命令本身。超限命令不切词也不跑正则，直接拒绝。
    logSafetyDecision(
      `command length ${command.length} exceeds the ${MAX_TERMINAL_COMMAND_LENGTH}-character inspection limit; failing closed`
    );
    return readonlyBlock(
      'shell-command-too-long',
      `Command longer than ${MAX_TERMINAL_COMMAND_LENGTH} characters cannot be inspected in terminal.exec`
    );
  }
  return inspectLiteralShellCommand(command, 0);
}

function inspectLiteralShellCommand(command: string, depth: number): SafetyVerdict {
  const dangerousPayload = detectDangerousShellPayload(command);
  if (dangerousPayload) {
    return { safe: false, block: dangerousPayload };
  }

  const readings = lexShellReadings(command);
  if ('block' in readings) {
    return { safe: false, block: readings.block };
  }
  // shell 先执行命令替换再执行外层命令，所以每个替换体（反引号、$(...)，含双引号内的）都按独立命令串递归检查。
  // 两种读法切出的替换体大多相同，去重后只检查一次。
  const substitutions = new Set(readings.flatMap((reading) => reading.substitutions));
  for (const inner of substitutions) {
    const nested = inspectNestedCommandString(inner, depth);
    if (!nested.safe) {
      return nested;
    }
  }
  // (b) token 级判定：这里只检查静态 literal 形态，不求值变量/别名/脚本。实际隔离仍由宿主 sandbox 提供。
  // 仅命令位置及已知 wrapper 链有执行身份；cat ./docs/sudo 等普通参数不是可执行文件。
  for (const tokens of readings.flatMap((reading) => reading.commands)) {
    for (const { words, hereStrings } of commandWordReadings(tokens)) {
      const verdict = inspectCommandWords(words, depth, hereStrings);
      if (!verdict.safe) {
        return verdict;
      }
    }
  }
  // (a) 正则兜底放在 (b) 之后：两者任一命中都拒绝，(b) 先命中时报告它更精确的规则。
  return checkDeniedNameFallback(command, readings, depth);
}

/**
 * 一条命令 token 序列的全部词表读法。bash/zsh 把 '&>' 读成 stdout+stderr 重定向；POSIX sh（dash 等）
 * 把它读成后台运算符 '&' 加 '>'，'ls &>/dev/null sudo reboot' 在那里以重定向开头另起一条命令
 * sudo reboot。两种读法都检查：第一种是整条命令；第二种按每个 '&>' 把 token 切成互不重叠的段
 * （'&>' 的目标是下一段的重定向目标，不是命令词）。同一个 shell 对所有 '&>' 的解释一致，
 * 所以逐段切分就是完整的 POSIX 读法，总工作量与 token 数成线性（此前每个 '&>' 都复制并重查剩余全部 token）。
 */
function commandWordReadings(
  tokens: ShellWord[],
  log = true
): Array<{ words: ShellWord[]; hereStrings: ShellWord[] }> {
  const readings = [collectCommandWords(tokens)];
  let segmentStart = 0;
  let split = false;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].redirection && tokens[index].value.startsWith('&')) {
      split = true;
      readings.push(collectCommandWords(tokens.slice(segmentStart, index)));
      segmentStart = index + 2;
      index++;
    }
  }
  if (split) {
    readings.push(collectCommandWords(tokens.slice(segmentStart)));
    if (log) {
      logSafetyDecision(
        "'&>' found; also inspecting the POSIX reading where each '&' ends a command and the rest starts a new one"
      );
    }
  }
  return readings;
}

function collectCommandWords(tokens: ShellWord[]): {
  words: ShellWord[];
  hereStrings: ShellWord[];
} {
  const words: ShellWord[] = [];
  const hereStrings: ShellWord[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.redirection) {
      // 重定向不开始新命令，其目标也不是 rm 参数；引号内的 > 仍是普通 literal。
      // here-string（<<<）的内容会成为 stdin：交给 shell 时等价于命令串，单独收集。
      const target = tokens[index + 1];
      if (token.value === '<<<' && target && !target.redirection) {
        hereStrings.push(target);
      }
      index++;
    } else {
      words.push(token);
    }
  }
  return { words, hereStrings };
}

interface ShellReading {
  commands: ShellWord[][];
  substitutions: string[];
  /** commands[k] 之后的分隔符，供正则兜底找出管道下游的命令。 */
  separators: readonly string[];
  /** 这一读法是否把词首 '#' 当注释（注释内容不产生词）。 */
  commentsApplied: boolean;
}

/**
 * 把一段命令串切成需要检查的全部读法。词首 '#' 是否开始注释取决于执行它的 shell
 * （非交互 shell 认注释，关闭 interactive_comments 的交互 shell 不认），而两种读法切出的命令
 * 可能完全不同：注释里的未闭合引号在不认注释的读法里会把换行后的真实命令吞成字面量。
 * 所以出现词首 '#' 时两种读法都检查，任一读法无法切分即 fail-closed；没有词首 '#' 时两者相同，只切一次。
 */
function lexShellReadings(command: string): ShellReading[] | { block: TerminalSafetyBlock } {
  const literal = parseSimpleShellWords(command, true, { comments: false });
  if (!literal.ok) {
    // 只记录归类原因（固定文案），不记录命令本身。
    logSafetyDecision(`command cannot be split statically; failing closed: ${literal.error}`);
    return { block: { rule: 'shell-unparseable-command', reason: literal.error } };
  }
  if (!literal.sawCommentStart) {
    return [{ ...literal, commentsApplied: false }];
  }
  const commented = parseSimpleShellWords(command, true, { comments: true });
  if (!commented.ok) {
    logSafetyDecision(
      'shell comment reading cannot be split statically; failing closed (comment-blind reading parsed)'
    );
    return {
      block: {
        rule: 'shell-unparseable-command',
        reason: `Command with a shell comment cannot be split statically: ${commented.error}`,
      },
    };
  }
  logSafetyDecision(
    'word-start # found; inspecting both the comment and the literal-# readings of the command'
  );
  return [
    { ...literal, commentsApplied: false },
    { ...commented, commentsApplied: true },
  ];
}

/*
 * (a) DENIED_BINS/eval 的原始文本兜底（L4-P8c；W-SEC1 改为切块还原）
 *
 * token 级判定曾被连续绕过（heredoc、注释、参数展开前缀、xargs 运行时参数），所以对每一层命令串的原始文本
 * 再做一次不依赖词法器的匹配。L4-P8c 的词边界正则只认名字前是行首、空白、; | & ( ) 或反引号（可带一个引号），
 * 审计（W-SEC1）确认 '/usr/bin/sudo'、'\sudo'、's\udo' 都不命中，未知 wrapper 承载时（'caffeinate /usr/bin/sudo -i'、
 * 'flock /tmp/l /bin/dd ...'）(b) 不解包、(a) 又不命中，生产路径放行。现在改为：
 * 1. 切块：按空白、; & | ( ) < > 与反引号切开原始文本；反斜杠连同其后一个字符属于同一块（'\ '、'\;' 不切开，
 *    与 shell 一致），续行（反斜杠+换行）同样不切开。这与旧正则的边界并不一致：旧正则只看名字前一个字符，
 *    '\;sudo' 里的 ';' 算边界，块却把 'id\;sudo' 留在一起，所以第 3 步要在还原后再切片。引号内的空白照样切开，
 *    所以 'ssh host "sudo reboot"' 这类会被再次切词的引号串里的名字也能命中。
 * 2. 还原（decodeRawChunk）：宽松的去引号读法——删去单双引号与转义反斜杠（引号内的反斜杠也删，经 ssh、
 *    su -c 再切词时它就是转义）、删去续行、解码 $'...'（未闭合时解码到块尾）、$"..." 去掉 '$'。
 * 3. 切片（collectChunkHits，W-SEC1 返工）：还原值再按同一组分隔符（空白、换行、; & | ( ) < > 与反引号）切片。
 *    被转义的分隔符（'id\;sudo'、'sudo\ -i'、'true\&\&dd'）与 $'...' 解码出的分隔符（$'id\x3bsudo'）在外层
 *    shell 里不切词，但这个词交给 sh -c、ssh、su -c 这类会再切词的宿主时就重新生效。
 * 4. 规范化（normalizeBinName）：逐片取最后一个 '/' 之后的名字（任意目录前缀）、小写、GNU g 前缀、mkfs.<fstype>、
 *    提权程序名族（sudo-rs、sudo.ws 等显式清单，见 privilegeFamilyRoot），再与 DENIED_BINS 比较；形似名字族但不在
 *    清单里的词（su-check、sudo-lint）不算命中，只记一条放行诊断（W-SEC1r1）。eval 沿用 L4-P8 之前
 *    的口径，只在其后还跟着参数时才算命中（单独的 eval 什么也不执行，'npm run eval' 不该被拦）；片在还原值中间时
 *    看还原值里其后的文本，片在块尾时看原始文本里块之后的文本（evalArgumentFollows）。
 * '=sudo'、'--pre=sudo' 这类名字前没有 '/' 的粘连写法、'sudoers' 这类更长的单词、'sudo.md' 这类文件名不算命中。
 * 为了不回到 I31 的误拦（'rg -n sudo src'），命中后用 token 判定逐个确认，全部确认才放行并记诊断：
 * - 命中词是只读取证命令（EVIDENCE_COMMAND_BINS，且没有执行/写盘类选项、git 只认只读子命令）的参数，
 *   包括 wrapper 解包后的目标与 find -exec 动作里的命令；只查手册页的 man（isManualPageLookup）同样放行；
 * - 命中词是查询类 wrapper（command -v、--help）的操作数，整条命令不执行任何目标；
 * - 命中落在注释读法的注释里，或落在 shell/source/trap 的参数（含交给 shell 的 here-string）里：
 *   这些文本已作为独立命令串在嵌套层递归检查，嵌套层同样跑本兜底；
 * - 命中落在命令替换体里时，替换体同样在嵌套层递归检查，而替换的输出成为外层词，所以还要按外层词
 *   判定（L4-P8c 返工：'caffeinate $(echo sudo) ls' 的外层词是未知程序的参数）。
 * 放行之外还要看输出去向（explainOutputFlow，L4-P8c 返工）：命中所在命令的输出经管道、进程替换、coproc
 * 或同一命令里写出的文件交给非惰性程序时拒绝（'echo "sudo reboot" | xargs caffeinate'）。
 * 其余位置（命令名、wrapper 选项值、赋值前缀、env -S 串、重定向目标、非取证命令的参数）一律拒绝。
 * 任一解读（'&>' 两种读法、注释两种读法、规格外选项的多个候选）里无法确认都拒绝。
 * 块的起点必然落在词法器切出的某个词的区间里（块边界是词边界的超集，只多切了引号内的空白与运算符），
 * 同一块切出的各片命中都记在块起点上，所以 findWordAt 能把命中映射回承载它的词，归属判定不因切片而变；
 * 切块、还原、切片与规范化都与块长成线性，整条命令的成本与长度成线性。
 */
// 切块与切片共用的分隔符：空白（含换行）、; & | ( ) < > 与反引号。
const RAW_CHUNK_BREAK = /[\s;&|()`<>]/;
// eval 之后紧跟（同一行的）空白与一个参数字符才算命中；粘性正则从块尾开始匹配，只扫描其后的空白。
const EVAL_ARGUMENT_FOLLOWS = /[ \t]+[^\s;&|()<>#]/y;
// 还原值里 eval 之后已有空白时，块之后只需（可选空白加）一个参数字符。
const EVAL_ARGUMENT_AFTER_SPACE = /[ \t]*[^\s;&|()<>#]/y;
// 不算 eval 参数的字符：换行等空白、运算符与注释符。
const EVAL_ARGUMENT_BREAK = /[\s;&|()<>#]/;

/**
 * (a) 兜底放行所需的只读取证命令：只读取或打印、从不把参数当命令执行的程序。是否带写盘/执行类选项
 * （rg --pre、find -delete、git --ext-diff）沿用只读 allowlist 的选项表，git 只认只读子命令。
 * W-SEC1 起路径写法（/usr/bin/sudo）也算 (a) 命中，HEAD 上本是放行的只读查看会被新命中误拦，所以并入一组
 * 只处理路径字符串或读取文件内容、没有任何执行程序类选项的工具：路径工具（readlink、realpath、basename、
 * dirname）、存在性测试（test、[）、体积（du）、校验和与比较（md5、md5sum、shasum、sha*sum、cksum、cmp）与
 * strings。ldd（Linux 上会运行目标程序）、otool/nm/codesign/xattr（会写或平台专有）、sed/awk（能执行内容）、
 * diff/lsof/pgrep 不在其中，路径写法出现在它们的参数里仍按无法确认拒绝。
 */
const EVIDENCE_COMMAND_BINS = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'git',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'printf',
  'find',
  'which',
  'type',
  'file',
  'stat',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'test',
  '[',
  'du',
  'md5',
  'md5sum',
  'shasum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'cksum',
  'cmp',
  'strings',
]);

/**
 * 一次只读取证调用：bin 在 EVIDENCE_COMMAND_BINS 里，没有写盘/执行类选项，git 只认只读子命令。
 * bash 的 'printf -v VAR' 把输出写进变量而不是打印（随后 'caffeinate sh -c "$VAR"' 就执行了它），不算取证。
 */
function isEvidenceInvocation(bin: string, args: readonly ShellWord[]): boolean {
  if (!EVIDENCE_COMMAND_BINS.has(bin)) {
    return false;
  }
  if (bin === 'printf' && args[0]?.value.startsWith('-v')) {
    return false;
  }
  const values = args.map((word) => word.value);
  return findDeniedOption(bin, values) === null && checkReadonlySubcommand(bin, values).safe;
}

/**
 * 只查手册页的 man（W-SEC1）：'man shutdown'、'man 8 reboot'、'man -k sudo' 里的命中词只是页名或检索词。
 * man 不进 EVIDENCE_COMMAND_BINS：man-db 会把 xargs 追加的运行时项当成选项（-P 分页器），所以它不算惰性的
 * 管道消费者，也不享受 xargs 目标的取证豁免，只在 (a) 的归属判定里放行。放行要求：没有执行/写盘类选项
 * （MAN_OPTION_TABLE），且每个操作数都是普通页名或章节号（字母数字与 . _ : + @ -）——macOS 的 man 脚本会把
 * 含 '/' 的页面路径交给 eval（路径里的 $(...) 会执行），man-db 会格式化任意文件。
 */
const MAN_PAGE_OPERAND = /^[\w.:+@-]+$/;

function isManualPageLookup(bin: string, args: readonly ShellWord[]): boolean {
  if (bin !== 'man') {
    return false;
  }
  const values = args.map((word) => word.value);
  return (
    findDeniedOption(bin, values) === null &&
    values.every((value) => value.startsWith('-') || MAN_PAGE_OPERAND.test(value))
  );
}

/**
 * 写法种类，只用于诊断：记录命中是怎么写出来的，不记录原文（审计侧只保存命令哈希）。顺序固定，便于比对。
 */
type SpellingKind =
  | 'path-qualified'
  | 'backslash-escaped'
  | 'line-continuation'
  | 'quoted'
  | 'ansi-c-quoted'
  | 'escaped-separator'
  | 'letter-case'
  | 'name-family-variant';

const SPELLING_KIND_ORDER: readonly SpellingKind[] = [
  'path-qualified',
  'backslash-escaped',
  'line-continuation',
  'quoted',
  'ansi-c-quoted',
  // 名字与别的文本由被转义（或 ANSI-C 解码出）的空白/运算符连在同一个词里：'id\;sudo'、'sudo\ -i'。
  'escaped-separator',
  'letter-case',
  'name-family-variant',
];

/**
 * 补全写法种类：value 是（已去引号的）命令名文本，canonical 是规范名。kinds 里已有的种类（(a) 还原原始文本时
 * 记下的转义、续行、引号、ANSI-C）保留。返回按固定顺序排列的种类，规范写法返回空数组。
 */
function describeSpelling(
  value: string,
  canonical: string,
  kinds: Set<SpellingKind> = new Set()
): SpellingKind[] {
  if (value.includes('/')) {
    kinds.add('path-qualified');
  }
  if (value.includes('\\')) {
    kinds.add('backslash-escaped');
  }
  if (/['"]/.test(value)) {
    kinds.add('quoted');
  }
  const base = path.basename(value.replace(STRIPPED_NAME_CHARS, ''));
  if (base !== base.toLowerCase()) {
    kinds.add('letter-case');
  }
  if (base.toLowerCase() !== canonical) {
    kinds.add('name-family-variant');
  }
  return SPELLING_KIND_ORDER.filter((kind) => kinds.has(kind));
}

function formatSpelling(kinds: readonly SpellingKind[]): string {
  return kinds.length > 0 ? kinds.join('+') : 'plain';
}

interface DeniedNameHit {
  /** 规范名（sudo、dd、mkfs、eval…），诊断只记录它，不记录原始写法。 */
  name: string;
  /**
   * 命中块在命令串里的起点（跳过前导续行），落在词法器切出的某个词的区间里；同一块切出的多片命中共用它。
   */
  index: number;
  block: TerminalSafetyBlock;
  /** 写法种类（path-qualified、backslash-escaped…），只用于诊断。 */
  spelling: SpellingKind[];
}

function findDeniedNameHits(command: string): DeniedNameHit[] {
  const hits: DeniedNameHit[] = [];
  let chunkStart = -1;
  for (let index = 0; index <= command.length; index++) {
    const char = command[index];
    if (char === '\\' && index + 1 < command.length) {
      // 反斜杠连同其后一个字符（含换行，即续行）属于同一块：'\ '、'\;' 在 shell 里不切词。
      // 被转义的分隔符在还原后再切片（collectChunkHits），不会因为留在块里而漏掉其后的名字。
      if (chunkStart < 0) {
        chunkStart = index;
      }
      index++;
      continue;
    }
    if (char === undefined || RAW_CHUNK_BREAK.test(char)) {
      if (chunkStart >= 0) {
        collectChunkHits(command, chunkStart, index, hits);
        chunkStart = -1;
      }
      continue;
    }
    if (chunkStart < 0) {
      chunkStart = index;
    }
  }
  return hits;
}

/**
 * 把一个原始文本块还原后再按空白与 shell 运算符切片，逐片规范化并与 DENIED_BINS/eval 比较，命中记入 hits
 * （W-SEC1 返工）。还原值里出现空白或运算符，只可能来自被转义的分隔符（'id\;sudo'、'sudo\ -i'、'x\&\&reboot'）
 * 或 $'...' 解码出的分隔符（$'id\x3bsudo'）：外层 shell 把它们当成同一个词，但这个词交给 sh -c、ssh、su -c
 * 这类会再切词的宿主时分隔符重新生效，其后的名字就在命令位置上。整块按一个名字比较会漏掉它们——HEAD 的词边界
 * 正则只看名字前一个字符（'\;sudo' 里 ';' 算边界）反而能拦住，所以必须切片。
 * 一块里的全部命中都记在块起点上（跳过前导续行），findWordAt 把它映射回承载它的词，归属判定不变；同一块里的
 * 同名命中只记一次（归属结果相同），所以命中数不超过块数乘规范名数，整条命令仍是线性。
 */
function collectChunkHits(
  command: string,
  start: number,
  end: number,
  hits: DeniedNameHit[]
): void {
  const decoded = decodeRawChunk(command.slice(start, end));
  const { value } = decoded;
  // 词法器把续行当作词间空白：'\<换行>sudo' 的词从 s 开始，命中起点也要跳过前导续行才能映射回词。
  let index = start;
  while (command[index] === '\\' && command[index + 1] === '\n') {
    index += 2;
  }
  const seen = new Set<string>();
  let pieceStart = -1;
  for (let offset = 0; offset <= value.length; offset++) {
    const char = value[offset];
    if (char !== undefined && !RAW_CHUNK_BREAK.test(char)) {
      if (pieceStart < 0) {
        pieceStart = offset;
      }
      continue;
    }
    if (pieceStart < 0) {
      continue;
    }
    const piece = value.slice(pieceStart, offset);
    // 片不是整个还原值：名字与别的文本由被转义（或 ANSI-C 解码出）的分隔符连在同一个词里。
    const joined = pieceStart > 0 || offset < value.length;
    pieceStart = -1;
    const name = normalizeBinName(piece);
    if (seen.has(name)) {
      continue;
    }
    if (
      !DENIED_BINS.has(name) &&
      !(name === 'eval' && evalArgumentFollows(value, offset, command, end))
    ) {
      const lookalike = privilegeFamilyLookalikeRoot(name);
      if (lookalike) {
        // 形似提权程序名族、但不在显式清单里（su-check、sudo-lint 这类脚本名或目标名）：不算命中，放行这一片
        // （W-SEC1r1）。只记它像哪个根名，不记原词与命令原文；同一块里同名只记一次。
        seen.add(name);
        logSafetyDecision(
          `denied-name fallback saw a ${lookalike}-family lookalike that is not a known privilege program; not treating it as a denied bin`
        );
      }
      continue;
    }
    seen.add(name);
    const kinds = new Set(decoded.kinds);
    if (joined) {
      kinds.add('escaped-separator');
    }
    hits.push({
      name,
      index,
      block: deniedNameBlock(name),
      spelling: describeSpelling(piece, name, kinds),
    });
  }
}

/**
 * eval 只在其后（同一行）还跟着参数时才算命中（L4-P8 之前的口径）。片在还原值中间时看还原值里其后的文本；
 * 其后只剩空白或什么都没有（片在块尾，'eval\ '）时接着看原始文本里块之后的文本，与 HEAD 的
 * 'id\;eval ls' 口径一致。扫描的都是片后与块后的空白段，各段互不重叠，整条命令仍是线性。
 */
function evalArgumentFollows(
  value: string,
  pieceEnd: number,
  command: string,
  chunkEnd: number
): boolean {
  let offset = pieceEnd;
  while (value[offset] === ' ' || value[offset] === '\t') {
    offset++;
  }
  if (offset < value.length) {
    return offset > pieceEnd && !EVAL_ARGUMENT_BREAK.test(value[offset]);
  }
  // 还原值里片后已有空白时，块之后的空白可有可无；否则块之后至少要有一个空白。
  const follows = offset > pieceEnd ? EVAL_ARGUMENT_AFTER_SPACE : EVAL_ARGUMENT_FOLLOWS;
  follows.lastIndex = chunkEnd;
  return follows.test(command);
}

/**
 * 原始文本块的宽松去引号读法（只服务 (a) 兜底，不是 shell 的精确语义）：删去单双引号、转义反斜杠与续行，
 * 解码 $'...'（未闭合时解码到块尾），$"..." 去掉 '$'。宽松是有意的：引号内的反斜杠在本 shell 里是字面量，
 * 但这段文本经 ssh、su -c 这类再切词的程序转交时就是转义；多命中只会让归属判定多确认一次。
 */
function decodeRawChunk(raw: string): { value: string; kinds: Set<SpellingKind> } {
  const kinds = new Set<SpellingKind>();
  let value = '';
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    const next = raw[index + 1];
    if (char === '\\' && next !== undefined) {
      index++;
      if (next === '\n') {
        kinds.add('line-continuation');
      } else {
        kinds.add('backslash-escaped');
        value += next;
      }
      continue;
    }
    if (char === '$' && next === "'") {
      // 块在 $'...' 内部的空白处被切开时没有闭引号：补一个闭引号解码到块尾。
      const decoded = decodeAnsiCQuote(raw, index + 2) ?? decodeAnsiCQuote(`${raw}'`, index + 2);
      if (decoded) {
        kinds.add('ansi-c-quoted');
        value += decoded.value;
        index = decoded.end;
        continue;
      }
    }
    if (char === '$' && next === '"') {
      // $"..." 是本地化字符串，'$' 不出现在词值里；引号在下一轮删去。
      continue;
    }
    if (char === "'" || char === '"') {
      kinds.add('quoted');
      continue;
    }
    value += char;
  }
  return { value, kinds };
}

/** 提权类被禁程序：(a) 命中时按提权规则报告。 */
const PRIVILEGE_ESCALATION_BINS = new Set(['sudo', 'su', 'doas', 'pkexec', 'run0']);

function deniedNameBlock(bin: string): TerminalSafetyBlock {
  if (bin === 'eval') {
    return { rule: 'shell-eval', reason: 'eval is blocked in terminal.exec' };
  }
  if (PRIVILEGE_ESCALATION_BINS.has(bin)) {
    return {
      rule: 'shell-privilege-escalation',
      reason: 'Privilege escalation commands are blocked in terminal.exec',
    };
  }
  return {
    rule: 'shell-destructive-bin',
    reason: 'Destructive system executables are blocked in terminal.exec',
  };
}

/** 一个词在某种解读下能否放行：blocker 为空表示可放行，bins 是确认它时用到的取证命令。 */
interface WordAttribution {
  blocker?: string;
  bins: string[];
}

const UNATTRIBUTED =
  'it is not an argument of a resolved command (wrapper option value, assignment prefix, env -S string or redirection target)';

function mergeAttribution(
  target: Map<number, WordAttribution>,
  start: number,
  entry: WordAttribution
): void {
  const existing = target.get(start);
  if (!existing) {
    target.set(start, { blocker: entry.blocker, bins: [...entry.bins] });
    return;
  }
  existing.blocker ??= entry.blocker;
  existing.bins.push(...entry.bins);
}

function checkDeniedNameFallback(
  command: string,
  readings: readonly ShellReading[],
  depth: number
): SafetyVerdict {
  const hits = findDeniedNameHits(command);
  if (hits.length === 0) {
    return { safe: true };
  }
  const contexts = readings.map(
    (reading): FallbackContext => ({
      reading,
      words: indexReadingWords(reading),
      attributions: new Map<ShellWord[], Map<number, WordAttribution>>(),
    })
  );
  const evidenceBins = new Set<string>();
  for (const hit of hits) {
    for (const context of contexts) {
      const blocker = explainHit(hit, context, depth, evidenceBins);
      if (blocker) {
        // 只记录规范名、写法种类（路径、转义、引号、名字族变体等）与归类原因，不记录命令文本或原始写法。
        logSafetyDecision(
          `denied-name fallback matched ${hit.name} (${formatSpelling(hit.spelling)}) but ${blocker}; failing closed`
        );
        return { safe: false, block: hit.block };
      }
    }
  }
  const names = [
    ...new Set(hits.map((hit) => `${hit.name} (${formatSpelling(hit.spelling)})`)),
  ].join(', ');
  const bins = [...evidenceBins].map(truncateForReason).join(', ');
  const detail = bins
    ? `arguments of read-only evidence commands (${bins}) or other inert positions`
    : 'query operands, comments or nested code inspected separately';
  logSafetyDecision(
    `denied-name fallback matched ${names}; token analysis confirmed as ${detail}; allowing`
  );
  return { safe: true };
}

interface LocatedWord {
  tokens: ShellWord[];
  word: ShellWord;
}

/** 读法里全部带偏移的词（含重定向目标），按起点升序（词法器按顺序产出）。 */
function indexReadingWords(reading: ShellReading): LocatedWord[] {
  const located: LocatedWord[] = [];
  for (const tokens of reading.commands) {
    for (const word of tokens) {
      if (!word.redirection && word.start !== undefined) {
        located.push({ tokens, word });
      }
    }
  }
  return located;
}

function findWordAt(words: readonly LocatedWord[], offset: number): LocatedWord | null {
  let low = 0;
  let high = words.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const { word } = words[middle];
    if ((word.end ?? 0) <= offset) {
      low = middle + 1;
    } else if ((word.start ?? 0) > offset) {
      high = middle - 1;
    } else {
      return words[middle];
    }
  }
  return null;
}

interface FallbackContext {
  reading: ShellReading;
  words: LocatedWord[];
  attributions: Map<ShellWord[], Map<number, WordAttribution>>;
  /** 惰性计算的输出去向（管道、进程替换、coproc、写文件）；出现可放行的命中时才计算。 */
  flow?: ReadingFlow;
}

/**
 * 返回命中在这一读法里无法确认的原因；可以放行时返回 null。
 * 命中落在命令替换体里时不再一律放行（L4-P8c 返工）：替换体的输出会成为外层词，'caffeinate $(echo sudo) ls'
 * 里外层词是未知程序的参数。替换体本身已按独立命令串递归检查，这里再按承载替换的外层词判定——外层词
 * 的区间覆盖整个替换体，findWordAt 找到的就是它。
 */
function explainHit(
  hit: DeniedNameHit,
  context: FallbackContext,
  depth: number,
  evidenceBins: Set<string>
): string | null {
  const { reading } = context;
  const located = findWordAt(context.words, hit.index);
  if (!located) {
    // 注释读法里注释内容不产生词：命中落在注释里，这一读法不会执行它。
    return reading.commentsApplied ? null : 'the match is not inside a command word';
  }
  if (located.word.start === undefined) {
    return UNATTRIBUTED;
  }
  let attribution = context.attributions.get(located.tokens);
  if (!attribution) {
    attribution = attributeTokenList(located.tokens, depth);
    context.attributions.set(located.tokens, attribution);
  }
  const entry = attribution.get(located.word.start);
  if (!entry) {
    return UNATTRIBUTED;
  }
  if (entry.blocker) {
    return entry.blocker;
  }
  const flowBlocker = explainOutputFlow(context, located.tokens);
  if (flowBlocker) {
    return flowBlocker;
  }
  for (const bin of entry.bins) {
    evidenceBins.add(bin);
  }
  return null;
}

/*
 * 放行的前提是命中词只是数据：取证命令的参数、查询操作数、交给 shell 的命令串都会出现在输出里
 * （echo/printf 原样打印，rg -r、git log --format、command -v 也能打印参数），输出再交给会执行它的命令时
 * 就不是数据了（L4-P8c 返工）：'echo "sudo reboot" | xargs caffeinate'、'printf "sudo reboot" | caffeinate -i sh'、
 * 'caffeinate sh <(echo "sudo reboot")'、'echo "sudo reboot" > x.sh && caffeinate sh x.sh'。
 * 所以在同一读法里检查输出的去向，消费者必须都是惰性程序（文本过滤器、取证命令、xargs 的取证目标）：
 * - 管道（|、|&，可跨换行与子 shell 边界）下游的命令；
 * - 出现进程替换（<(...)、>(...)）、coproc 或管道接入命令组/子 shell 时，数据流向无法按段确定，读法里每条命令；
 * - 命中所在命令或其管道下游把输出写进文件（重定向、tee 的文件操作数）时，同一读法里每条命令
 *   （文件可能被随后的命令当脚本执行；跨 terminal.exec 调用的文件仍是脚本内容盲区）。
 * 这是读法级的保守近似：同一条命令里另有不相关的管道时也会参与判定。
 */
interface ReadingFlow {
  /** 进程替换、coproc 或管道接入命令组：读法里每条命令都按消费者处理。 */
  allConsume: boolean;
  /** 管道下游命令里的非惰性者，按出现顺序。 */
  nonInertConsumers: NonInertCommand[];
  /** 管道下游是否有命令写文件。 */
  consumersWriteFile: boolean;
  /** 读法里全部命令中的非惰性者；只在需要“每条命令”时才计算。 */
  nonInertCommands?: NonInertCommand[];
  /** 每条命令的惰性判定与写文件判定缓存：每条命令只解包一次，总工作量与命令数成线性。 */
  verdicts: Map<ShellWord[], string | null>;
  writers: Map<ShellWord[], boolean>;
}

interface NonInertCommand {
  tokens: ShellWord[];
  /** 诊断用的程序名（不含参数）。 */
  name: string;
}

// 管道接入这些复合命令时，其后续命令同样读这条管道（'| { true; sh; }'、'| while read l; do ...; done'）。
const PIPE_GROUP_OPENERS = new Set(['{', 'while', 'until', 'if', 'for', 'case', 'select']);

/**
 * 不执行输入、也不把参数当命令执行的文本过滤器。sort 的 --compress-program 会执行程序，单独排除；
 * sed（e 命令、s///e）、awk（system()、print | "cmd"）、less/more（! 命令）都可能执行内容，不在这里。
 * 复合命令的结束保留字只在“读法里每条命令”模式下出现，按惰性处理。
 */
const INERT_CONSUMER_BINS = new Set([
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'column',
  'tee',
  'jq',
  'diff',
  'comm',
  'fold',
  'fmt',
  'rev',
  'tac',
  'paste',
  'expand',
  'unexpand',
  'od',
  'xxd',
  'hexdump',
  'base64',
  'md5',
  'md5sum',
  'shasum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'cksum',
  'true',
  'false',
  'cd',
  'pwd',
  '}',
  'fi',
  'done',
  'esac',
]);

// 不落盘的输出目标：空设备与标准流。'>&2'、'>&-' 这类描述符复制/关闭在 writesFile 里单独识别。
const NON_FILE_OUTPUT_TARGET = /^\/dev\/(?:null|stdout|stderr|tty|fd\/[0-2])$/;

function explainOutputFlow(context: FallbackContext, holder: ShellWord[]): string | null {
  context.flow ??= analyzeReadingFlow(context.reading);
  const { flow } = context;
  const writes = flow.consumersWriteFile || cachedWritesFile(flow, holder);
  let offenders: readonly NonInertCommand[] = flow.nonInertConsumers;
  let via = 'a pipe';
  if (flow.allConsume || writes) {
    flow.nonInertCommands ??= collectNonInertCommands(flow, context.reading.commands);
    offenders = flow.nonInertCommands;
    via = flow.allConsume
      ? 'a process substitution, coproc or piped command group'
      : 'a file written in the same command';
  }
  // 命中所在命令自身已由归属判定确认（取证命令、查询或已递归检查的 shell 命令串），跳过它；
  // 它在列表里至多出现一次，所以这里至多看两项。
  const offender = offenders.find((entry) => entry.tokens !== holder);
  return offender
    ? `its output reaches ${offender.name}, which is not a known inert consumer (via ${via})`
    : null;
}

function collectNonInertCommands(
  flow: ReadingFlow,
  commands: readonly ShellWord[][]
): NonInertCommand[] {
  const offenders: NonInertCommand[] = [];
  for (const tokens of commands) {
    let name = flow.verdicts.get(tokens);
    if (name === undefined) {
      name = explainConsumer(tokens);
      flow.verdicts.set(tokens, name);
    }
    if (name) {
      offenders.push({ tokens, name });
    }
  }
  return offenders;
}

function cachedWritesFile(flow: ReadingFlow, tokens: ShellWord[]): boolean {
  let writes = flow.writers.get(tokens);
  if (writes === undefined) {
    writes = writesFile(tokens);
    flow.writers.set(tokens, writes);
  }
  return writes;
}

/** 读法里的管道下游命令，以及是否出现了无法按段确定流向的结构。 */
function analyzeReadingFlow(reading: ShellReading): ReadingFlow {
  const consumers: ShellWord[][] = [];
  let allConsume = false;
  let pending = '';
  reading.commands.forEach((tokens, index) => {
    if (tokens.length > 0) {
      // 两条非空命令之间的分隔符序列：'||' 是逻辑或，其余出现 '|' 即管道（'|&'、'|\n'、')|'、'|('）。
      const pipe = pending.replaceAll('||', '');
      const pipeAt = pipe.lastIndexOf('|');
      const first = tokens.find((token) => !token.redirection)?.value ?? '';
      if (pipeAt >= 0) {
        consumers.push(tokens);
        if (pipe.slice(pipeAt).includes('(') || PIPE_GROUP_OPENERS.has(first)) {
          allConsume = true;
        }
      }
      if (normalizeBinName(first) === 'coproc' || hasDanglingRedirection(tokens)) {
        allConsume = true;
      }
      pending = '';
    }
    pending += reading.separators[index] ?? '';
  });
  if (allConsume) {
    logSafetyDecision(
      'process substitution, coproc or piped command group found; treating every command in the reading as an output consumer'
    );
  }
  const flow: ReadingFlow = {
    allConsume,
    nonInertConsumers: [],
    consumersWriteFile: false,
    verdicts: new Map(),
    writers: new Map(),
  };
  flow.nonInertConsumers = collectNonInertCommands(flow, consumers);
  flow.consumersWriteFile = consumers.some((tokens) => cachedWritesFile(flow, tokens));
  return flow;
}

/** 重定向运算符后面没有目标词：进程替换 '<(...)'/'>(...)' 的括号被切成了新命令（或运算符缺目标）。 */
function hasDanglingRedirection(tokens: readonly ShellWord[]): boolean {
  return tokens.some(
    (token, index) =>
      token.redirection === true &&
      (tokens[index + 1] === undefined || tokens[index + 1].redirection === true)
  );
}

/** 命令是否把输出写进文件：输出重定向到普通文件，或 tee 的文件操作数。 */
function writesFile(tokens: readonly ShellWord[]): boolean {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.redirection || !token.value.includes('>')) {
      continue;
    }
    const target = tokens[index + 1];
    if (!target || target.redirection) {
      return true;
    }
    if (token.value.endsWith('&') && /^(?:\d+|-)$/.test(target.value)) {
      continue;
    }
    if (!NON_FILE_OUTPUT_TARGET.test(target.value)) {
      return true;
    }
  }
  for (const { words } of commandWordReadings([...tokens], false)) {
    const unwrapped = unwrapLiteralCommand(words, 0);
    if ('block' in unwrapped) {
      // token 级判定 (b) 已对每条命令解包并在这里先行拒绝；保守起见按写文件处理。
      return true;
    }
    for (const [head, ...args] of unwrapped.candidates) {
      if (
        head &&
        normalizeBinName(head.value) === 'tee' &&
        args.some((arg) => !arg.value.startsWith('-') && !NON_FILE_OUTPUT_TARGET.test(arg.value))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 一条命令作为输出消费者是否惰性：解开已知 wrapper（含 xargs）后每个候选目标都是惰性程序时返回 null，
 * 否则返回第一个非惰性程序名（诊断用，只含程序名）。无法解包（运行时值、歧义）按非惰性处理。
 */
function explainConsumer(tokens: ShellWord[]): string | null {
  for (const { words } of commandWordReadings(tokens, false)) {
    if (words.length === 0) {
      continue;
    }
    const unwrapped = unwrapLiteralCommand(words, 0);
    if ('block' in unwrapped) {
      return 'a command whose wrapper structure cannot be resolved';
    }
    for (const [head, ...args] of unwrapped.candidates) {
      if (!head) {
        // 只有赋值，或 xargs 自身没有目标（运行 echo）：不执行任何程序。
        continue;
      }
      const bin = normalizeBinName(head.value);
      if (INERT_CONSUMER_BINS.has(bin)) {
        if (bin === 'sort' && args.some((arg) => arg.value.startsWith('--compress'))) {
          return 'sort --compress-program';
        }
        continue;
      }
      if (bin !== 'find' && isEvidenceInvocation(bin, args)) {
        continue;
      }
      return truncateForReason(bin);
    }
  }
  return null;
}

/** 一条命令 token 序列在 bash 与 POSIX 两种 '&>' 读法下每个词的放行判定（合取）。 */
function attributeTokenList(tokens: ShellWord[], depth: number): Map<number, WordAttribution> {
  const combined = new Map<number, WordAttribution>();
  for (const variant of commandWordReadings(tokens, false)) {
    const roles = attributeWords(variant.words, variant.hereStrings, depth);
    for (const word of [...variant.words, ...variant.hereStrings]) {
      if (word.start !== undefined) {
        mergeAttribution(
          combined,
          word.start,
          roles.get(word.start) ?? { blocker: UNATTRIBUTED, bins: [] }
        );
      }
    }
  }
  return combined;
}

/**
 * 一组命令词（不经 shell 直接执行）在全部解包候选下每个词的放行判定。词必须在每个候选里都出现且角色
 * 可放行；在某个候选里没出现（被 wrapper 选项、赋值前缀或 env -S 消耗）也不放行。
 */
function attributeWords(
  words: ShellWord[],
  hereStrings: readonly ShellWord[],
  depth: number
): Map<number, WordAttribution> {
  const result = new Map<number, WordAttribution>();
  const all = [...words, ...hereStrings];
  const blockAll = (blocker: string) => {
    for (const word of all) {
      if (word.start !== undefined) {
        result.set(word.start, { blocker, bins: [] });
      }
    }
    return result;
  };
  if (depth >= MAX_INSPECTION_DEPTH) {
    return blockAll('the nesting limit was reached');
  }
  const unwrapped = unwrapLiteralCommand(words, 0);
  if ('block' in unwrapped) {
    return blockAll('the wrapper structure cannot be resolved');
  }
  if (unwrapped.candidates.length === 0) {
    // 只有查询类 wrapper（command -v、--help）会让候选为空：不执行任何目标，其余词只是被打印的操作数。
    for (const word of all) {
      if (word.start !== undefined) {
        result.set(word.start, { bins: [] });
      }
    }
    return result;
  }
  const perCandidate = unwrapped.candidates.map((candidate) =>
    attributeCandidate(candidate, hereStrings, depth)
  );
  const keys = new Set(perCandidate.flatMap((roles) => [...roles.keys()]));
  for (const key of keys) {
    const merged: WordAttribution = { bins: [] };
    for (const roles of perCandidate) {
      const entry = roles.get(key);
      if (!entry) {
        merged.blocker ??= UNATTRIBUTED;
        continue;
      }
      merged.blocker ??= entry.blocker;
      merged.bins.push(...entry.bins);
    }
    result.set(key, merged);
  }
  return result;
}

function attributeCandidate(
  candidate: ShellWord[],
  hereStrings: readonly ShellWord[],
  depth: number
): Map<number, WordAttribution> {
  const roles = new Map<number, WordAttribution>();
  const [head, ...args] = candidate;
  if (!head) {
    return roles;
  }
  const set = (word: ShellWord, entry: WordAttribution) => {
    if (word.start !== undefined) {
      mergeAttribution(roles, word.start, entry);
    }
  };
  set(head, { blocker: 'it is in command position', bins: [] });
  if (head.value.startsWith('#')) {
    // 词首 '#' 开头的“命令”只出现在注释不生效的读法里（'# check eval usage'）：那里它是一个不存在的
    // 程序名，其参数不会被执行；注释读法里这些词根本不存在。
    for (const arg of args) {
      set(arg, { bins: [] });
    }
    return roles;
  }
  const bin = normalizeBinName(head.value);
  if (SHELL_BINS.has(bin) || bin === 'source' || bin === '.' || bin === 'trap') {
    // inspectShellCodeArguments 已把这些参数（及交给 shell/source 的 here-string）按命令串递归检查，
    // 嵌套层同样跑本兜底；这里不重复判定。
    for (const arg of args) {
      set(arg, { bins: [] });
    }
    if (bin !== 'trap') {
      for (const hereString of hereStrings) {
        set(hereString, { bins: [] });
      }
    }
    return roles;
  }
  let own = args;
  if (bin === 'find') {
    // find -exec 动作里的词归属动作命令本身（rg/grep 的参数可放行，find 自身的表达式按 find 判定）。
    const split = splitFindExecSegments(args);
    own = split.own;
    for (const segment of split.segments) {
      const nested = attributeWords(markExecPlaceholders(segment, ['{}']), hereStrings, depth + 1);
      for (const word of segment) {
        if (word.start !== undefined) {
          set(word, nested.get(word.start) ?? { blocker: UNATTRIBUTED, bins: [] });
        }
      }
    }
  }
  const entry: WordAttribution =
    isEvidenceInvocation(bin, own) || isManualPageLookup(bin, own)
      ? { bins: [bin] }
      : {
          blocker: `it is an argument of ${truncateForReason(bin)}, which is not a read-only evidence command in this form`,
          bins: [],
        };
  for (const word of own) {
    set(word, entry);
  }
  return roles;
}

/** 递归检查一段命令串（shell -c 载荷、命令替换体、trap 动作），带嵌套上限。 */
function inspectNestedCommandString(payload: string, depth: number): SafetyVerdict {
  if (depth >= MAX_INSPECTION_DEPTH) {
    return nestingLimitVerdict();
  }
  return inspectLiteralShellCommand(payload, depth + 1);
}

/** 递归检查一组不经 shell 直接执行的参数（find -exec 动作），带嵌套上限。 */
function inspectNestedCommandWords(
  words: ShellWord[],
  depth: number,
  hereStrings: readonly ShellWord[]
): SafetyVerdict {
  if (depth >= MAX_INSPECTION_DEPTH) {
    return nestingLimitVerdict();
  }
  return inspectCommandWords(words, depth + 1, hereStrings);
}

function nestingLimitVerdict(): { safe: false; block: TerminalSafetyBlock } {
  return readonlyBlock(
    'shell-nesting-limit',
    'Nested shell command exceeds the safety inspection limit'
  );
}

/** 解开 wrapper 与引导保留字，对每个可能的目标命令做命令位置判定。 */
function inspectCommandWords(
  words: ShellWord[],
  depth: number,
  hereStrings: readonly ShellWord[]
): SafetyVerdict {
  const unwrapped = unwrapLiteralCommand(words, 0);
  if ('block' in unwrapped) {
    return { safe: false, block: unwrapped.block };
  }
  for (const commandWords of unwrapped.candidates) {
    const verdict = inspectResolvedCommand(commandWords, depth, hereStrings);
    if (!verdict.safe) {
      return verdict;
    }
  }
  return { safe: true };
}

const SHELL_BINS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'mksh',
  'pdksh',
  'oksh',
  'ash',
  'yash',
  'posh',
  'rbash',
  'hush',
  'csh',
  'tcsh',
]);
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/**
 * 把参数当代码执行的程序：shell、source/.、eval 与常见脚本解释器。xargs 把运行时输入项交给它们时，
 * 输入项就是 -c 命令串、-e 代码或脚本，静态无法检查（L4-P8c）。带版本号的名字（python3.12、ruby3.3）
 * 由 VERSIONED_INTERPRETER 覆盖。
 */
const CODE_INTERPRETER_BINS = new Set([
  ...SHELL_BINS,
  'source',
  '.',
  'eval',
  'node',
  'nodejs',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'python',
  'pypy',
  'ruby',
  'perl',
  'php',
  'lua',
  'luajit',
  'tclsh',
  'wish',
  'expect',
  'osascript',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'rscript',
  'julia',
  'pwsh',
  'powershell',
  'groovy',
  'jshell',
]);
const VERSIONED_INTERPRETER = /^(?:python|pypy|ruby|perl|php|lua|node|tclsh|wish)[\d.]+$/;

function isCodeInterpreterBin(bin: string): boolean {
  return CODE_INTERPRETER_BINS.has(bin) || VERSIONED_INTERPRETER.test(bin);
}

/** 对解包后的目标命令做命令位置判定；unwrapLiteralCommand 已保证头部不是运行时才确定的词。 */
function inspectResolvedCommand(
  commandWords: ShellWord[],
  depth: number,
  hereStrings: readonly ShellWord[]
): SafetyVerdict {
  const head = commandWords[0];
  if (!head) {
    return { safe: true };
  }
  const bin = normalizeBinName(head.value);
  if (DENIED_BINS.has(bin)) {
    const spelling = describeSpelling(head.value, bin);
    if (spelling.length > 0) {
      // 路径写法、残留引号/反斜杠、大小写或名字族变体（sudo-rs、sudo.ws）经规范化识别（W-SEC1）：
      // 只记录规范名与写法种类，不记录原始写法。
      logSafetyDecision(
        `command-position denied bin ${bin} recognized from a ${formatSpelling(spelling)} spelling; blocking`
      );
    }
    return readonlyBlock('shell-denied-bin', `Blocked executable in terminal.exec: ${bin}`);
  }
  if (bin === 'eval') {
    return readonlyBlock('shell-eval', 'eval is blocked in terminal.exec');
  }
  const args = commandWords.slice(1);
  if (bin === 'rm') {
    return checkRemoveArguments(args);
  }
  if (SHELL_BINS.has(bin) || bin === 'source' || bin === '.') {
    // source/. 在当前 shell 里执行脚本：'. /dev/stdin <<< "..."' 与 'bash <<< "..."' 等价。
    const payloads = inspectShellCodeArguments(bin, args, depth, hereStrings);
    if (!payloads.safe) {
      return payloads;
    }
    return checkShellProgramSource(bin, args, hereStrings);
  }
  if (bin === 'trap') {
    // trap 的动作参数在信号到达或退出时按 shell 代码执行，与 eval 同类；它不读 stdin。
    return inspectShellCodeArguments(bin, args, depth, []);
  }
  if (bin === 'find') {
    return inspectFindActions(args, depth, hereStrings);
  }
  return { safe: true };
}

/**
 * rm 递归强删判定。GNU rm 会重排选项，所以检查 '--' 之前的全部参数；长选项接受无歧义前缀
 * （--rec、--r 即 --recursive，--for、--f 即 --force）。'--' 之前出现命令替换时，替换结果
 * 可能就是 -rf，静态无法判定，fail-closed。
 */
function checkRemoveArguments(args: ShellWord[]): SafetyVerdict {
  let recursive = false;
  let force = false;
  let substituted = false;
  for (const arg of args) {
    if (arg.dynamic === 'command-substitution') {
      substituted = true;
      continue;
    }
    const value = arg.value;
    if (value === '--') {
      break;
    }
    if (value.startsWith('--')) {
      const name = value.slice(2);
      recursive ||= 'recursive'.startsWith(name);
      force ||= 'force'.startsWith(name);
      continue;
    }
    if (/^-[^-]/.test(value)) {
      recursive ||= /[rR]/.test(value.slice(1));
      force ||= value.slice(1).includes('f');
    }
  }
  if (recursive && force) {
    return readonlyBlock(
      'shell-rm-recursive-force',
      'Recursive force remove is blocked in terminal.exec'
    );
  }
  if (substituted) {
    return readonlyBlock(
      'shell-rm-dynamic-args',
      'rm options produced by command substitution cannot be inspected statically'
    );
  }
  return { safe: true };
}

/**
 * shell（及 trap）参数里可能承载命令串的位置：-c 之后的第一个非选项（bash/sh 允许 -c 与命令串之间
 * 再夹其它选项）、--command=…、fish/zsh getopt 风格的 -c 粘连写法、here-string。这里不精确定位，
 * 而是把每个可能的位置都按命令串递归检查：多检查只会让脚本路径、位置参数这类普通词经过一次
 * 无害检查，少检查才是绕过。参数由命令替换产生时内容未知，fail-closed。
 */
function inspectShellCodeArguments(
  bin: string,
  args: ShellWord[],
  depth: number,
  hereStrings: readonly ShellWord[]
): SafetyVerdict {
  const dynamicArgument = readonlyBlock(
    'shell-dynamic-command',
    `${bin} argument produced by command substitution cannot be inspected statically`
  );
  const payloads: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (arg.dynamic === 'command-substitution') {
      return dynamicArgument;
    }
    // find/xargs 的 {} 占位与参数展开在这里按静态文本递归检查（它们也可能只是位置参数，如 sh -c '...' _ {}）；
    // 真正的 -c 命令串本身是占位、参数展开或缺失时，由 checkShellProgramSource fail-closed。
    const value = arg.value;
    if (optionsEnded || value.length < 2 || !/^[-+]/.test(value)) {
      payloads.push(value);
      continue;
    }
    if (value === '--') {
      // '--' 之后即使以 '-' 开头也是命令串（zsh -c -- '- rm ...' 会执行 rm）。
      optionsEnded = true;
      continue;
    }
    if (value.startsWith('--')) {
      const equalsIndex = value.indexOf('=');
      if (equalsIndex >= 0) {
        payloads.push(value.slice(equalsIndex + 1));
      }
      if (!/^--[A-Za-z][-A-Za-z0-9]*(?:=|$)/.test(value)) {
        payloads.push(value);
      }
      continue;
    }
    const commandLetter = value.slice(1).search(/[cC]/);
    if (commandLetter >= 0 && commandLetter + 2 < value.length) {
      payloads.push(value.slice(commandLetter + 2));
    }
    // 不是纯选项簇（含空白等）时整体也当命令串检查，不依赖各 shell 对畸形选项的具体报错行为。
    if (!/^[-+][A-Za-z]+$/.test(value)) {
      payloads.push(value);
    }
  }
  for (const hereString of hereStrings) {
    if (hereString.dynamic === 'command-substitution') {
      return dynamicArgument;
    }
    payloads.push(hereString.value);
  }
  for (const payload of payloads) {
    const nested = inspectNestedCommandString(payload, depth);
    if (!nested.safe) {
      return nested;
    }
  }
  return { safe: true };
}

// shell 自身带值的短选项：其后一个词（或簇内剩余字符）是选项值，不是脚本路径。宁可把脚本路径误当成
// 选项值（结论变成“从 stdin 读程序”而多拦），也不能把选项值误当成脚本路径而漏拦。
// fish：-C 初始化命令、-d/-D 调试、-f 特性、-o 调试输出、-p 性能剖析输出；其余 shell：-o/-O 选项名，
// ksh 系的 -R 文件与 -T 终端。
const FISH_VALUE_SHORT_OPTIONS = new Set(['C', 'd', 'D', 'f', 'o', 'p']);
const SHELL_VALUE_SHORT_OPTIONS = new Set(['o', 'O', 'R', 'T']);
const SHELL_VALUE_LONG_OPTIONS = [
  'rcfile',
  'init-file',
  'init-command',
  'debug',
  'debug-output',
  'debug-stack-frames',
  'features',
  'profile',
  'profile-startup',
];
// 等价于 stdin（或由运行时提供内容的描述符，如进程替换）的脚本路径；先按 POSIX 规范化（//dev/./stdin）。
const STDIN_SCRIPT_PATH = /(?:^|\/)dev\/(?:stdin|fd(?:\/\d+)?)$|(?:^|\/)proc\/[^/]+\/fd\/\d+$/i;

type ShellProgramSource =
  | { kind: 'command-string' }
  /** -c 命令串缺失（只能由 xargs 等在运行时追加）或本身是占位/参数展开/命令替换：程序文本运行时才确定。 */
  | { kind: 'runtime-command-string'; detail: string }
  | { kind: 'query' }
  | { kind: 'script'; path: string }
  | { kind: 'stdin' };

/**
 * shell（及 source/.）的程序从哪里来。没有 -c 命令串也没有脚本路径（或带 -s、脚本是 /dev/stdin、
 * 进程替换 <(...) 被切走后不剩操作数）时，shell 从 stdin 读程序：'echo "sudo reboot" | sh'、
 * 'bash <(curl ...)'、'cat x | bash -s'。stdin 的内容由管道上游或运行时决定，静态无法检查，fail-closed；
 * 只有 here-string 提供的静态程序（已在 inspectShellCodeArguments 里按命令串检查）放行。
 * 脚本文件路径仍是已知盲区（不读文件内容）。
 */
function checkShellProgramSource(
  bin: string,
  args: ShellWord[],
  hereStrings: readonly ShellWord[]
): SafetyVerdict {
  if (hereStrings.length > 0) {
    return { safe: true };
  }
  const source =
    bin === 'source' || bin === '.' ? sourcedScriptSource(args) : shellProgramSource(bin, args);
  if (source.kind === 'command-string' || source.kind === 'query') {
    return { safe: true };
  }
  if (source.kind === 'runtime-command-string') {
    // 'xargs sh -c'、'find . -exec sh -c {} \;'、'sh -c "echo $X"'：程序文本由输入项、文件名或变量值拼成。
    logSafetyDecision(
      `${bin} command string is supplied at run time (${source.detail}); failing closed`
    );
    return readonlyBlock(
      'shell-dynamic-command',
      `${bin} -c command string is missing or holds a run-time value (find/xargs placeholder, parameter expansion or command substitution) and cannot be inspected statically`
    );
  }
  if (source.kind === 'script' && !STDIN_SCRIPT_PATH.test(path.posix.normalize(source.path))) {
    return { safe: true };
  }
  logSafetyDecision(
    `${bin} reads its program from stdin (${source.kind === 'script' ? 'stdin-like script path' : 'no command string or script operand'}); failing closed`
  );
  return readonlyBlock(
    'shell-dynamic-command',
    `${bin} reads its commands from stdin or a runtime file descriptor, which cannot be inspected statically`
  );
}

function shellProgramSource(bin: string, args: ShellWord[]): ShellProgramSource {
  const valueLetters = bin === 'fish' ? FISH_VALUE_SHORT_OPTIONS : SHELL_VALUE_SHORT_OPTIONS;
  let forcedStdin = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index].value;
    if (value === '--' || value === '-') {
      // 选项结束；bash 里单独的 '-' 等价于 '--'。
      const operand = args[index + 1];
      return operand && !forcedStdin ? { kind: 'script', path: operand.value } : { kind: 'stdin' };
    }
    if (value.startsWith('--')) {
      const equalsIndex = value.indexOf('=');
      const name = value.slice(2, equalsIndex < 0 ? undefined : equalsIndex);
      if ((name === 'help' || name === 'version') && index === 0) {
        // 只认第一个参数位置：bash 的长选项必须写在短选项之前，'bash -s --help' 里的 --help
        // 只是位置参数，shell 仍从 stdin 读程序。
        return { kind: 'query' };
      }
      if (name.length > 0 && 'command'.startsWith(name) && !forcedStdin) {
        // fish --command（getopt_long 接受前缀）。已出现 -s 时不再当命令串，按 stdin 处理。
        // '=' 写法的命令串在选项词自身里，否则是下一个词。
        return commandStringSource(equalsIndex >= 0 ? [args[index]] : [args[index + 1]]);
      }
      if (
        equalsIndex < 0 &&
        name.length > 0 &&
        SHELL_VALUE_LONG_OPTIONS.some((option) => option.startsWith(name))
      ) {
        index++;
      }
      continue;
    }
    if (/^[-+]./.test(value)) {
      const letters = value.slice(1);
      if (value.startsWith('-') && letters.includes('c')) {
        // bash 逐字母解析选项簇，带值字母（-o）之后的 c 仍然生效（'bash -oc errexit "$X"' 执行 $X），
        // 所以簇里任意位置出现 c 都按 -c 处理；把它当命令串只会让判定更严（脚本路径本就是已知盲区）。
        return clusterCommandStringSource(args, index, letters, valueLetters);
      }
      for (let position = 0; position < letters.length; position++) {
        const letter = letters[position];
        if (letter === 's') {
          // -s：即使给了操作数也从 stdin 读程序，操作数只是位置参数。
          forcedStdin = true;
        }
        if (valueLetters.has(letter)) {
          if (position === letters.length - 1) {
            index++;
          }
          break;
        }
      }
      continue;
    }
    return forcedStdin ? { kind: 'stdin' } : { kind: 'script', path: value };
  }
  return { kind: 'stdin' };
}

/**
 * -c 命令串的来源判定。sources 是可能承载命令串的词（undefined 表示该位置不存在）：
 * - 一个都不存在：单独的 'sh -c' 会报错，能执行任何东西的唯一途径是 xargs 等在运行时追加命令串；
 * - 任一是运行时值（find/xargs 的 {} 占位、参数展开、命令替换）：程序文本运行时才确定，'echo $X' 里的
 *   $X 可以带 ';' 拼出第二条命令，与命令替换同样 fail-closed。
 */
function commandStringSource(sources: ReadonlyArray<ShellWord | undefined>): ShellProgramSource {
  const present = sources.filter((word): word is ShellWord => word !== undefined);
  if (present.length === 0) {
    return { kind: 'runtime-command-string', detail: 'no command string operand' };
  }
  const dynamic = present.find((word) => word.dynamic !== undefined);
  if (dynamic?.dynamic) {
    return {
      kind: 'runtime-command-string',
      detail: `command string is a ${dynamicLabel(dynamic.dynamic)}`,
    };
  }
  return { kind: 'command-string' };
}

/**
 * 含 c 的选项簇的命令串候选，全部交给 commandStringSource 判定：
 * - fish/zsh 的粘连写法（-c'cmd'）：c 之后的簇内剩余字符就是命令串，即选项词自身；
 * - bash 的写法：命令串是其后第一个非选项参数，但簇里每个带值字母（-oc errexit）先按顺序消耗一个参数。
 *   不同 shell 对簇的解析不同，所以“不跳过”到“跳过全部带值字母的值”的每种切分都作为候选。
 */
function clusterCommandStringSource(
  args: ShellWord[],
  index: number,
  letters: string,
  valueLetters: ReadonlySet<string>
): ShellProgramSource {
  const candidates: Array<ShellWord | undefined> = [];
  if (letters.indexOf('c') < letters.length - 1) {
    candidates.push(args[index]);
  }
  const consumed = Math.min([...letters].filter((letter) => valueLetters.has(letter)).length, 4);
  for (let skip = 0; skip <= consumed; skip++) {
    const operand = findCommandStringOperand(args, index + 1 + skip, valueLetters);
    candidates.push(operand >= 0 ? args[operand] : undefined);
  }
  return commandStringSource(candidates);
}

/** -c 之后第一个非选项参数的下标（跳过带值选项的值，'--'/'-' 结束选项）；不存在返回 -1。 */
function findCommandStringOperand(
  args: ShellWord[],
  start: number,
  valueLetters: ReadonlySet<string>
): number {
  for (let index = start; index < args.length; index++) {
    const value = args[index].value;
    if (value === '--' || value === '-') {
      return index + 1 < args.length ? index + 1 : -1;
    }
    if (value.startsWith('--')) {
      const name = value.slice(2);
      if (
        !name.includes('=') &&
        name.length > 0 &&
        SHELL_VALUE_LONG_OPTIONS.some((option) => option.startsWith(name))
      ) {
        index++;
      }
      continue;
    }
    if (/^[-+]./.test(value)) {
      const letters = value.slice(1);
      const valueLetter = [...letters].findIndex((letter) => valueLetters.has(letter));
      if (valueLetter === letters.length - 1) {
        index++;
      }
      continue;
    }
    return index;
  }
  return -1;
}

/** source/. 的脚本操作数；bash 5.3 起 source 支持 -p PATH，其余实现没有选项。缺操作数按 stdin 处理。 */
function sourcedScriptSource(args: ShellWord[]): ShellProgramSource {
  let index = 0;
  while (index < args.length) {
    const value = args[index].value;
    if (value === '--') {
      index++;
      break;
    }
    if (value === '-p') {
      index += 2;
      continue;
    }
    break;
  }
  const operand = args[index];
  return operand ? { kind: 'script', path: operand.value } : { kind: 'stdin' };
}

/**
 * find 的 -exec/-execdir/-ok/-okdir 动作不经 shell 直接执行：动作参数直到 ';'（命令行里写成 \; 或
 * ';'）或紧跟在 {} 之后的 '+'；缺终止符时 find 会报错，这里仍检查到末尾。{} 出现在命令位置时
 * 执行身份由找到的文件决定，按运行时值处理。find 表达式本身含命令替换时，替换结果可能就是一个
 * -exec 动作，静态无法判定，fail-closed。
 */
function inspectFindActions(
  args: ShellWord[],
  depth: number,
  hereStrings: readonly ShellWord[]
): SafetyVerdict {
  if (args.some((arg) => arg.dynamic === 'command-substitution')) {
    return readonlyBlock(
      'shell-dynamic-command',
      'find expression produced by command substitution cannot be inspected statically'
    );
  }
  for (const segment of splitFindExecSegments(args).segments) {
    const nested = inspectNestedCommandWords(
      markExecPlaceholders(segment, ['{}']),
      depth,
      hereStrings
    );
    if (!nested.safe) {
      return nested;
    }
  }
  return { safe: true };
}

/**
 * 把 find 的参数切成 find 自身的表达式词（own，不含动作关键字与终止符）和各个 -exec/-execdir/-ok/-okdir
 * 动作的命令词段。终止符是 ';'（命令行里写成 \; 或 ';'）或紧跟在 {} 之后的 '+'；缺终止符时取到末尾。
 */
function splitFindExecSegments(args: ShellWord[]): { own: ShellWord[]; segments: ShellWord[][] } {
  const own: ShellWord[] = [];
  const segments: ShellWord[][] = [];
  for (let index = 0; index < args.length; index++) {
    if (!FIND_EXEC_ACTIONS.has(args[index].value)) {
      own.push(args[index]);
      continue;
    }
    const segment: ShellWord[] = [];
    let end = index + 1;
    for (; end < args.length; end++) {
      const value = args[end].value;
      if (value === ';' || (value === '+' && segment[segment.length - 1]?.value === '{}')) {
        break;
      }
      segment.push(args[end]);
    }
    segments.push(segment);
    index = end;
  }
  return { own, segments };
}

// GNU coreutils/findutils 在 macOS（Homebrew）上以 g 前缀安装，与无前缀名是同一个程序。
const GNU_PREFIXED_ALIASES = new Map([
  ['grm', 'rm'],
  ['gdd', 'dd'],
  ['genv', 'env'],
  ['gnohup', 'nohup'],
  ['gtimeout', 'timeout'],
  ['gnice', 'nice'],
  ['gstdbuf', 'stdbuf'],
  ['gtime', 'time'],
  ['gxargs', 'xargs'],
  ['gfind', 'find'],
]);

// 命令名里删去的字符：引号与反斜杠。词法器已按 shell 规则去引号，残留的只来自引号内的字面反斜杠/引号
// （"\sudo"）或 (a) 的宽松还原；shell 直接执行时那是另一个（几乎不存在的）程序名，但经 ssh、su -c 这类会再切词的
// 程序转交时就是 sudo，所以从严当作同名程序（W-SEC1）。
const STRIPPED_NAME_CHARS = /[\\'"]/g;

/**
 * 命令名规范化（(a) 与 (b) 共用，W-SEC1 起同步覆盖路径与转义写法）：删去残留的引号与反斜杠，取 basename
 * （任意目录前缀：/usr/bin/sudo、../bin/sudo、HEAD:docs/sudo）、小写（macOS 默认大小写不敏感的文件系统上
 * RM 就是 rm）、折叠 GNU g 前缀别名，mkfs.ext4 等 mkfs.<fstype> 变体归为 mkfs，显式清单里的提权程序（sudo-rs、
 * sudo.ws、sudoedit、su-rs …）归为根名（见 privilegeFamilyRoot；W-SEC1r1 起不按后缀泛化）。
 */
function normalizeBinName(raw: string): string {
  const base = path.basename(raw.replace(STRIPPED_NAME_CHARS, '')).toLowerCase();
  const alias = GNU_PREFIXED_ALIASES.get(base);
  if (alias) {
    return alias;
  }
  if (base.startsWith('mkfs.')) {
    return 'mkfs';
  }
  return privilegeFamilyRoot(base) ?? base;
}

/*
 * 提权程序名族（W-SEC1 引入；W-SEC1r1 收窄为显式清单）
 *
 * 族成员只认下表列出、确有其物的提权程序，按（已小写的）basename 精确比较后归为 DENIED_BINS 里的根名；
 * 大小写、目录前缀、残留引号与反斜杠由 normalizeBinName 先行规整，所以 /usr/bin/SUDO-RS、\sudo.ws、
 * s''u-rs 照旧识别。W-SEC1 曾把“根名 + 任意 '-'/'.' 字母数字后缀”都归入提权族，'npm run su-check'、
 * 'make sudo-lint' 这类脚本名、目标名因此被误拦；现在不再按后缀泛化，新出现的提权程序改名要逐个补进下表，
 * 并在旁边写明它是什么程序。fb8686c 注释里举过的 sudo-rs.real 查不到出处（没有发行版或上游以此名安装），
 * 不列入。下划线写法（sudo_logsrvd 是日志服务）与破坏类程序（dd-trace 这类常见包名）同样不做族扩展；
 * mkfs.<fstype> 另有专门规则。
 */
const PRIVILEGE_FAMILY_ROOTS = new Map([
  // sudo：通用提权程序（sudo.ws 项目的原版 C 实现）。
  ['sudo', 'sudo'],
  // sudoedit：sudo -e 的另一个入口（原版 sudo 安装的同一程序），以目标用户身份编辑文件。
  ['sudoedit', 'sudo'],
  // sudo-rs：Trifecta Tech 基金会的 Rust 版 sudo；Ubuntu 25.10 起成为默认 sudo（/usr/bin/sudo-rs），
  // Arch、Fedora、Debian 的 sudo-rs 包也以此名安装。
  ['sudo-rs', 'sudo'],
  // sudoedit-rs：sudo-rs 的 sudoedit（Arch 的 sudo-rs 包与 FreeBSD 的 sudo-rs-coexist 包以此名安装）。
  ['sudoedit-rs', 'sudo'],
  // sudo.ws：Ubuntu 25.10 起原版 C sudo 改用的名字（/usr/bin/sudo.ws，经 update-alternatives 切换回去）。
  ['sudo.ws', 'sudo'],
  // su：切换用户身份执行 shell 或命令的程序（util-linux、shadow 实现）。
  ['su', 'su'],
  // su-rs：sudo-rs 包附带的 Rust 版 su（util-linux su 的重新实现；Arch、Fedora、Debian/Ubuntu 以此名安装）。
  ['su-rs', 'su'],
  // su-exec：Alpine 的 su-exec 包（上游 ncopa/su-exec），切换用户与组 id 后 exec 目标程序，容器入口脚本里
  // 常用作 gosu 的替代；以 root 运行时可换成任意身份执行命令。
  ['su-exec', 'su'],
  // doas：OpenBSD 的提权程序，Linux 上有 OpenDoas 移植。
  ['doas', 'doas'],
  // pkexec：polkit 的提权执行程序，以另一用户（默认 root）身份执行命令。
  ['pkexec', 'pkexec'],
  // run0：systemd 256 起附带的提权程序（经 polkit 授权、以另一用户身份执行命令）。
  ['run0', 'run0'],
]);

/**
 * 只用于诊断：名字形如“根名 + '-'/'.' + 字母数字”、但不在 PRIVILEGE_FAMILY_ROOTS 清单里（su-check、sudo-lint、
 * sudo.md）。这正是 W-SEC1 曾泛化归族、W-SEC1r1 起不再拦截的那类词，命中时记一条放行诊断。sudoedit 写在 sudo
 * 前面，让 'sudoedit-x' 报 sudo 族时取到最长的根名。
 */
const PRIVILEGE_FAMILY_LOOKALIKE = /^(sudoedit|sudo|su|doas|pkexec|run0)[-.][a-z0-9]/;

/** base 是已小写的 basename；是清单里的提权程序时返回根名，否则返回 null（不按后缀泛化，W-SEC1r1）。 */
function privilegeFamilyRoot(base: string): string | null {
  return PRIVILEGE_FAMILY_ROOTS.get(base) ?? null;
}

/**
 * name 是 normalizeBinName 的结果且不是被禁名：形似提权程序名族但不在清单里时返回它像的根名（只给诊断用），
 * 否则返回 null。
 */
function privilegeFamilyLookalikeRoot(name: string): string | null {
  const match = PRIVILEGE_FAMILY_LOOKALIKE.exec(name);
  if (!match) {
    return null;
  }
  return PRIVILEGE_FAMILY_ROOTS.get(match[1]) ?? null;
}

// 赋值前缀（A=1、A+=1、A[0]=1）不是命令，真正的命令在其后。
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
// 引导命令的保留字：其后的词回到命令位置（{ cmd; }、if/then/elif/else、while/until/do、! cmd）。
// 单独的 '-' 是 zsh 的前置修饰符（'- rm' 以 argv[0]=-rm 执行 rm）；bash 里它只是找不到的命令，多检查无害。
const COMMAND_PREFIX_KEYWORDS = new Set([
  '-',
  '!',
  '{',
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
]);

type WrapperOptionKind = 'flag' | 'value' | 'optional-value' | 'query' | 'split';

/**
 * 执行型 wrapper 的选项规格（GNU 与 BSD 实现取并集）。这些 wrapper 都用 '+' 模式的 getopt：
 * 在第一个非选项处停止解析，所以“选项 → 位置操作数 → 目标命令”的切分是确定的。
 * - flag：不带值；value：值可粘连（-n5）、'='（--adjustment=5）或下一个词；
 * - optional-value：值只能粘连或写在 '=' 后（xargs -i、--replace）；
 * - query：只打印信息，不执行目标命令（--help、command -v）；
 * - split：env -S，把值按 shell 风格拆成参数后继续解析 env 自身的选项。
 */
interface ExecWrapperSpec {
  short?: ReadonlyMap<string, WrapperOptionKind>;
  long?: ReadonlyMap<string, WrapperOptionKind>;
  /** 选项结束后、目标命令之前的位置操作数个数（timeout 的 DURATION）。 */
  operands?: number;
  /** nice 的旧式调整值写法：-5、--5、-+5。 */
  legacyNumericOption?: boolean;
  /** env 中单独的 '-' 等价于 -i，是选项而不是目标命令。 */
  loneDashIsOption?: boolean;
  /** xargs 的替换串选项；值（或缺省的 {}）会被替换成输入项。 */
  replaceOptions?: ReadonlySet<string>;
}

function optionTable(
  entries: Record<string, WrapperOptionKind>
): ReadonlyMap<string, WrapperOptionKind> {
  return new Map(Object.entries(entries));
}

const HELP_AND_VERSION = optionTable({ help: 'query', version: 'query' });

const EXEC_WRAPPERS = new Map<string, ExecWrapperSpec>([
  [
    'env',
    {
      // GNU env 9.x 与 macOS/FreeBSD env 的并集：BSD 的 -P altpath、-L/-U user，GNU 的 -a/--argv0。
      short: optionTable({
        i: 'flag',
        '0': 'flag',
        v: 'flag',
        u: 'value',
        C: 'value',
        P: 'value',
        L: 'value',
        U: 'value',
        a: 'value',
        S: 'split',
      }),
      long: optionTable({
        'ignore-environment': 'flag',
        null: 'flag',
        unset: 'value',
        chdir: 'value',
        argv0: 'value',
        'split-string': 'split',
        'block-signal': 'optional-value',
        'default-signal': 'optional-value',
        'ignore-signal': 'optional-value',
        'list-signal-handling': 'flag',
        debug: 'flag',
        help: 'query',
        version: 'query',
      }),
      loneDashIsOption: true,
    },
  ],
  [
    'command',
    {
      // command -v/-V 只查询命令路径，不执行目标；例如 sudo 的路径在这里只是查询参数。
      short: optionTable({ p: 'flag', v: 'query', V: 'query' }),
      long: optionTable({ help: 'query' }),
    },
  ],
  [
    'exec',
    {
      short: optionTable({ c: 'flag', l: 'flag', a: 'value' }),
      long: optionTable({ help: 'query' }),
    },
  ],
  ['builtin', { long: optionTable({ help: 'query' }) }],
  ['nohup', { long: HELP_AND_VERSION }],
  // zsh 的前置修饰符（zsh -c 载荷里会出现）。
  ['noglob', {}],
  ['nocorrect', {}],
  // 多调用二进制：busybox rm、toybox sh 的第一个参数就是被执行的 applet。
  [
    'busybox',
    {
      long: optionTable({ help: 'query', list: 'query', 'list-full': 'query', install: 'query' }),
    },
  ],
  ['toybox', { long: HELP_AND_VERSION }],
  [
    'timeout',
    {
      short: optionTable({ f: 'flag', k: 'value', p: 'flag', s: 'value', v: 'flag' }),
      long: optionTable({
        foreground: 'flag',
        'kill-after': 'value',
        'preserve-status': 'flag',
        signal: 'value',
        verbose: 'flag',
        help: 'query',
        version: 'query',
      }),
      operands: 1,
    },
  ],
  [
    'nice',
    {
      short: optionTable({ n: 'value' }),
      long: optionTable({ adjustment: 'value', help: 'query', version: 'query' }),
      legacyNumericOption: true,
    },
  ],
  [
    'ionice',
    {
      short: optionTable({
        c: 'value',
        n: 'value',
        p: 'value',
        P: 'value',
        t: 'flag',
        u: 'value',
        h: 'query',
        V: 'query',
      }),
      long: optionTable({
        class: 'value',
        classdata: 'value',
        pid: 'value',
        pgid: 'value',
        ignore: 'flag',
        uid: 'value',
        help: 'query',
        version: 'query',
      }),
    },
  ],
  [
    'time',
    {
      // bash 关键字 time -p、GNU time（-o/-f 带值）与 macOS /usr/bin/time（-a/-h/-l/-p，-h 是人类可读格式）。
      short: optionTable({
        a: 'flag',
        f: 'value',
        h: 'flag',
        l: 'flag',
        o: 'value',
        p: 'flag',
        q: 'flag',
        v: 'flag',
        V: 'query',
      }),
      long: optionTable({
        append: 'flag',
        format: 'value',
        output: 'value',
        portability: 'flag',
        quiet: 'flag',
        verbose: 'flag',
        help: 'query',
        version: 'query',
      }),
    },
  ],
  [
    'stdbuf',
    {
      short: optionTable({ i: 'value', o: 'value', e: 'value' }),
      long: optionTable({
        input: 'value',
        output: 'value',
        error: 'value',
        help: 'query',
        version: 'query',
      }),
    },
  ],
  [
    'setsid',
    {
      short: optionTable({ c: 'flag', f: 'flag', w: 'flag', h: 'query', V: 'query' }),
      long: optionTable({
        ctty: 'flag',
        fork: 'flag',
        wait: 'flag',
        help: 'query',
        version: 'query',
      }),
    },
  ],
  [
    'xargs',
    {
      // GNU findutils 与 BSD xargs 的并集：BSD 的 -J/-R/-S，GNU 的 -a/-d 与可选粘连值 -e/-i/-l。
      short: optionTable({
        '0': 'flag',
        a: 'value',
        d: 'value',
        E: 'value',
        e: 'optional-value',
        I: 'value',
        i: 'optional-value',
        J: 'value',
        L: 'value',
        l: 'optional-value',
        n: 'value',
        o: 'flag',
        P: 'value',
        p: 'flag',
        R: 'value',
        r: 'flag',
        S: 'value',
        s: 'value',
        t: 'flag',
        x: 'flag',
      }),
      long: optionTable({
        null: 'flag',
        'arg-file': 'value',
        delimiter: 'value',
        eof: 'optional-value',
        replace: 'optional-value',
        'max-lines': 'optional-value',
        'max-args': 'value',
        'open-tty': 'flag',
        'max-procs': 'value',
        interactive: 'flag',
        'process-slot-var': 'value',
        'no-run-if-empty': 'flag',
        'max-chars': 'value',
        'show-limits': 'flag',
        verbose: 'flag',
        exit: 'flag',
        help: 'query',
        version: 'query',
      }),
      replaceOptions: new Set(['I', 'J', 'i', 'replace']),
    },
  ],
]);

type UnwrapResult = { candidates: ShellWord[][] } | { block: TerminalSafetyBlock };

/**
 * 只解开明确的执行 wrapper 与引导保留字；未知程序的参数仍由程序解释，不能擅当 shell 命令。
 * 返回目标命令的候选（规格外选项会产生多个候选，全部检查）。wrapper 结构或命令位置上的词
 * 来自命令替换（或 find/xargs 占位）时，真实执行身份静态无法判定，fail-closed。
 */
function unwrapLiteralCommand(input: ShellWord[], depth: number): UnwrapResult {
  if (depth > MAX_UNWRAP_DEPTH) {
    return { block: nestingLimitVerdict().block };
  }
  let index = 0;
  while (index < input.length) {
    const word = input[index];
    if (ASSIGNMENT_WORD.test(word.value)) {
      index++;
      continue;
    }
    if (word.dynamic) {
      return { block: dynamicCommandBlock(word) };
    }
    if (COMMAND_PREFIX_KEYWORDS.has(word.value)) {
      index++;
      continue;
    }
    if (word.value === 'function') {
      // function NAME { ...; }：跳过函数名，花括号由保留字分支处理。
      index += 2;
      continue;
    }
    const bin = normalizeBinName(word.value);
    if (bin === 'coproc') {
      // coproc [NAME] command：NAME 只在复合命令前出现，两种切分都检查。
      return collectUnwrapCandidates(input, [index + 1, index + 2], [], [], depth);
    }
    const spec = EXEC_WRAPPERS.get(bin);
    if (!spec) {
      break;
    }
    const parsed = parseWrapperArguments(bin, spec, input, index + 1);
    if ('block' in parsed) {
      return parsed;
    }
    if (bin === 'xargs') {
      // xargs 没有 split 类选项（rewrites 恒为空）；目标逐个起点只解包一次并就地检查。
      return unwrapXargsTargets(input, parsed.starts, parsed.replaceTokens, depth);
    }
    // env -S 拆出的参数从 env 自身的选项解析继续（GNU env 会重新扫描拆分后的参数表）。
    const rewritten = parsed.rewrites.map((rest) => [word, ...rest]);
    return collectUnwrapCandidates(input, parsed.starts, parsed.replaceTokens, rewritten, depth);
  }
  return { candidates: [input.slice(index)] };
}

/**
 * xargs 的目标解包：每个起点只调用一次 unwrapLiteralCommand，并直接检查它返回的候选（L4-P8c 返工）。
 * 此前先由 collectUnwrapCandidates 解包、再对同一批起点二次解包做 xargs 检查，嵌套 xargs 每层翻倍，
 * 16 层就是 2^16 倍，上限内的长命令能同步占住事件循环十几秒；现在总工作量与嵌套层数成线性。
 * 起点越过参数表末尾表示 xargs 自身没有目标命令：它运行 echo，输入项只是被打印，返回空目标放行。
 */
function unwrapXargsTargets(
  input: ShellWord[],
  starts: readonly number[],
  replaceTokens: readonly string[],
  depth: number
): UnwrapResult {
  const candidates: ShellWord[][] = [];
  for (const start of starts) {
    if (start >= input.length) {
      candidates.push([]);
      continue;
    }
    const nested = unwrapLiteralCommand(
      markExecPlaceholders(input.slice(start), replaceTokens),
      depth + 1
    );
    if ('block' in nested) {
      return nested;
    }
    for (const candidate of nested.candidates) {
      const block = checkXargsTarget(candidate);
      if (block) {
        return { block };
      }
    }
    candidates.push(...nested.candidates);
    if (candidates.length > MAX_COMMAND_CANDIDATES) {
      return {
        block: {
          rule: 'shell-wrapper-ambiguous',
          reason: 'Wrapper options are too ambiguous to inspect the wrapped command statically',
        },
      };
    }
  }
  return { candidates };
}

// 解释器名里的 shell 内建（source、.、eval）不是可执行文件，未知 wrapper 无法 exec 它们；
// 而 '.'、'source' 作为参数通常是目录（cp {} .、mv {} source/），参数扫描不把它们当程序。
const XARGS_ARGUMENT_SCAN_SKIP = new Set(['.', 'source', 'eval']);

/**
 * xargs 把运行时输入项追加到目标命令末尾（-I/-J/-i 时替换进替换串），目标命令的静态 argv 只是一部分。
 * 以下情形真正执行的程序来自输入，静态无法检查，fail-closed：
 * - 目标解包后是 shell/解释器（sh -c、bash、node -e、python3 -c、awk 等）：输入项成为命令串、脚本或代码；
 * - 目标的 wrapper 链没有静态目标（xargs timeout 5、xargs env A=1、xargs nice -n、xargs xargs）：
 *   输入项本身就是被执行的命令；
 * - 目标是 find：输入项可以组成 -exec 动作（echo '-exec cmd ;' | xargs find .）；
 * - 目标不是只读取证命令，而它的静态 argv 里有像程序名的 shell/解释器/find，或有参数展开/命令替换：
 *   目标可能是 EXEC_WRAPPERS 之外的执行 wrapper（caffeinate -i sh -c、flock /tmp/l sh -c、
 *   script -q /dev/null sh -c、chrt 0 sh -c、taskset 1 sh -c），输入项照样成为 shell 的命令串（L4-P8c 返工）。
 *   选项词、目录与 sed 脚本这类不可能被 exec 的写法不当成程序名（见 programNamedInArgument）。
 * xargs 自身没有目标命令时运行 echo，放行。取证命令（rg、grep、wc 等）的参数只是数据；其余目标的参数注入
 * （rg --pre 由取证判定排除、git -c）属于“程序解释自身参数”的已知盲区，与静态写出时相同。
 */
function checkXargsTarget(candidate: ShellWord[]): TerminalSafetyBlock | null {
  const head = candidate[0];
  if (!head) {
    logSafetyDecision(
      'xargs target has no static command; run-time input items become the executed program; failing closed'
    );
    return {
      rule: 'shell-dynamic-command',
      reason:
        'xargs appends run-time input items to a wrapper without a static target command, so the executed program cannot be inspected statically',
    };
  }
  const bin = normalizeBinName(head.value);
  if (isCodeInterpreterBin(bin) || bin === 'find') {
    const label = truncateForReason(bin);
    logSafetyDecision(
      `xargs target ${label} receives run-time input items as code or as its expression; failing closed`
    );
    return {
      rule: 'shell-dynamic-command',
      reason: `xargs passes run-time input items to ${label}, which runs them as code or actions that cannot be inspected statically`,
    };
  }
  const args = candidate.slice(1);
  if (isEvidenceInvocation(bin, args)) {
    return null;
  }
  const label = truncateForReason(bin);
  for (const arg of args) {
    if (arg.dynamic === 'parameter-expansion' || arg.dynamic === 'command-substitution') {
      logSafetyDecision(
        `xargs target ${label} carries a ${dynamicLabel(arg.dynamic)} that may name the program it runs; failing closed`
      );
      return {
        rule: 'shell-dynamic-command',
        reason: `xargs target ${label} is not a read-only evidence command and carries a run-time value (parameter expansion or command substitution) that may name an interpreter for the input items`,
      };
    }
    const named = programNamedInArgument(arg.value);
    if (named) {
      const argLabel = truncateForReason(named);
      logSafetyDecision(
        `xargs target ${label} names ${argLabel} in its arguments and may be an exec wrapper outside the known list; failing closed`
      );
      return {
        rule: 'shell-dynamic-command',
        reason: `xargs target ${label} is not a read-only evidence command and its arguments name ${argLabel}, so it may run the input items as code that cannot be inspected statically`,
      };
    }
  }
  return null;
}

/**
 * 参数词里像“会执行输入项的程序名”的片段：shell/解释器、find 与已知执行 wrapper（env -S 'sh -c'、
 * timeout 5 这类没有静态目标的 wrapper 同样会执行输入项）。按空白与 '=' 切片，覆盖 'sh -c' 这种被引号
 * 合成一个词的 env -S 串与 --shell=sh 这种选项值。以 '-' 开头的片段是选项；以 '/' 结尾的词是目录或
 * sed 脚本（s/x/python/）；含 '/' 却不是绝对路径或 ./、../ 开头的片段（sed 的 's/bash'）不是常见的程序写法，
 * 都跳过。
 */
function programNamedInArgument(value: string): string | null {
  if (value.endsWith('/')) {
    return null;
  }
  for (const piece of value.split(/[\s=]+/)) {
    if (piece === '' || piece.startsWith('-')) {
      continue;
    }
    if (piece.includes('/') && !/^(?:\/|\.\.?\/)/.test(piece)) {
      continue;
    }
    const name = normalizeBinName(piece);
    if (XARGS_ARGUMENT_SCAN_SKIP.has(name)) {
      continue;
    }
    if (isCodeInterpreterBin(name) || name === 'find' || EXEC_WRAPPERS.has(name)) {
      return name;
    }
  }
  return null;
}

function collectUnwrapCandidates(
  input: ShellWord[],
  starts: readonly number[],
  replaceTokens: readonly string[],
  rewritten: readonly ShellWord[][],
  depth: number
): UnwrapResult {
  const targets = [
    ...starts.map((start) => markExecPlaceholders(input.slice(start), replaceTokens)),
    ...rewritten,
  ];
  const candidates: ShellWord[][] = [];
  for (const target of targets) {
    const nested = unwrapLiteralCommand(target, depth + 1);
    if ('block' in nested) {
      return nested;
    }
    candidates.push(...nested.candidates);
    if (candidates.length > MAX_COMMAND_CANDIDATES) {
      return {
        block: {
          rule: 'shell-wrapper-ambiguous',
          reason: 'Wrapper options are too ambiguous to inspect the wrapped command statically',
        },
      };
    }
  }
  return { candidates };
}

/** find {} 与 xargs 替换串会在运行时换成文件名或输入项：标记出来，命令位置上按运行时值处理。 */
function markExecPlaceholders(words: ShellWord[], tokens: readonly string[]): ShellWord[] {
  const active = tokens.filter((token) => token.length > 0);
  if (active.length === 0) {
    return words;
  }
  return words.map((word) =>
    !word.dynamic && active.some((token) => word.value.includes(token))
      ? { ...word, dynamic: 'exec-placeholder' }
      : word
  );
}

const DYNAMIC_COMMAND_REASONS: Readonly<Record<NonNullable<ShellWord['dynamic']>, string>> = {
  'exec-placeholder':
    'Command position is filled by a find/xargs placeholder at run time and cannot be inspected statically',
  'parameter-expansion':
    'Command name or wrapper argument is a parameter expansion ($VAR, "$@" or the braced form) whose run-time value (possibly empty or several words) cannot be inspected statically',
  'command-substitution':
    'Command name or wrapper argument produced by command substitution cannot be inspected statically',
};

function dynamicLabel(kind: NonNullable<ShellWord['dynamic']>): string {
  switch (kind) {
    case 'exec-placeholder':
      return 'find/xargs placeholder';
    case 'parameter-expansion':
      return 'parameter expansion';
    case 'command-substitution':
      return 'command substitution';
  }
}

/**
 * 命令位置或 wrapper 结构（选项、操作数、目标命令）上的运行时值：'$E sudo reboot' 里 $E 展开为空时
 * sudo 才是命令，未加引号时还可能展开成多个词，切分随之改变。命令替换、参数展开与 find/xargs 占位一视同仁。
 */
function dynamicCommandBlock(word: ShellWord): TerminalSafetyBlock {
  const kind = word.dynamic ?? 'command-substitution';
  logSafetyDecision(
    `command position or wrapper structure holds a ${dynamicLabel(kind)}; failing closed`
  );
  return { rule: 'shell-dynamic-command', reason: DYNAMIC_COMMAND_REASONS[kind] };
}

interface WrapperParse {
  /** 目标命令可能的起点下标；规格外选项会产生多个。 */
  starts: number[];
  /** env -S 拆分后的剩余参数表（不含 env 自身）。 */
  rewrites: ShellWord[][];
  /** xargs 替换串。 */
  replaceTokens: string[];
}

type WrapperStep =
  | { kind: 'continue'; next: number[]; replaceToken?: string }
  | { kind: 'command'; start: number }
  | { kind: 'query'; option: string }
  | { kind: 'split'; value: string; restStart: number }
  | { kind: 'block'; block: TerminalSafetyBlock };

/**
 * 按 getopt 规则解析 wrapper 自身的参数，得到目标命令的起点。长选项按 GNU getopt_long 接受
 * 无歧义前缀（--sig 即 --signal）。规格外或有歧义的选项同时按“带值”和“不带值”两种解释继续，
 * 宁可多检查一个候选，也不因版本差异漏掉真正的目标命令。
 */
function parseWrapperArguments(
  bin: string,
  spec: ExecWrapperSpec,
  words: ShellWord[],
  start: number
): WrapperParse | { block: TerminalSafetyBlock } {
  const result: WrapperParse = { starts: [], rewrites: [], replaceTokens: [] };
  const pending = [start];
  const visited = new Set<number>();
  for (let index = pending.pop(); index !== undefined; index = pending.pop()) {
    if (visited.has(index)) {
      continue;
    }
    visited.add(index);
    if (visited.size > MAX_WRAPPER_PARSE_STATES) {
      return {
        block: {
          rule: 'shell-wrapper-ambiguous',
          reason: `Options of ${bin} are too ambiguous to inspect the wrapped command statically`,
        },
      };
    }
    const step = stepWrapperArgument(bin, spec, words, index);
    switch (step.kind) {
      case 'block':
        return { block: step.block };
      case 'command':
        result.starts.push(step.start);
        break;
      case 'query':
        logSafetyDecision(
          `wrapper ${bin} option ${step.option} only prints information; the wrapped command is not executed and is not inspected`
        );
        break;
      case 'split': {
        const split = splitEnvString(step.value);
        if ('block' in split) {
          return split;
        }
        result.rewrites.push([...split.words, ...words.slice(step.restStart)]);
        break;
      }
      case 'continue':
        if (step.replaceToken !== undefined) {
          result.replaceTokens.push(step.replaceToken);
        }
        pending.push(...step.next);
        break;
    }
  }
  return result;
}

function stepWrapperArgument(
  bin: string,
  spec: ExecWrapperSpec,
  words: ShellWord[],
  index: number
): WrapperStep {
  const word = words[index];
  if (!word) {
    // 没有目标命令（如单独的 'timeout 5'）：wrapper 自身报错或不执行任何程序。返回空目标（而不是“无目标”），
    // 与查询类选项区分开：xargs 会把输入项追加到这里，空目标在 xargs 之下就是“输入项成为命令”。
    return { kind: 'command', start: index };
  }
  if (word.dynamic) {
    // 未加引号的替换还可能展开成多个词，选项、操作数与目标命令的切分都随之改变。
    return { kind: 'block', block: dynamicCommandBlock(word) };
  }
  const value = word.value;
  const operands = spec.operands ?? 0;
  if (value === '--') {
    return { kind: 'command', start: index + 1 + operands };
  }
  if (value === '-') {
    return spec.loneDashIsOption
      ? { kind: 'continue', next: [index + 1] }
      : { kind: 'command', start: index + operands };
  }
  if (spec.legacyNumericOption && /^-[-+]?\d/.test(value)) {
    return { kind: 'continue', next: [index + 1] };
  }
  if (value.startsWith('--')) {
    return stepLongOption(bin, spec, words, index);
  }
  if (value.startsWith('-')) {
    return stepShortOptionCluster(bin, spec, words, index);
  }
  return { kind: 'command', start: index + operands };
}

function stepLongOption(
  bin: string,
  spec: ExecWrapperSpec,
  words: ShellWord[],
  index: number
): WrapperStep {
  const value = words[index].value;
  const equalsIndex = value.indexOf('=');
  const name = value.slice(2, equalsIndex < 0 ? undefined : equalsIndex);
  const inline = equalsIndex < 0 ? undefined : value.slice(equalsIndex + 1);
  const resolved = resolveLongOption(spec.long, name);
  if (!resolved) {
    logSafetyDecision(
      `wrapper ${bin} long option --${name} is not in the known option spec; inspecting both the with-value and flag interpretations`
    );
    return { kind: 'continue', next: inline === undefined ? [index + 1, index + 2] : [index + 1] };
  }
  const isReplace = spec.replaceOptions?.has(resolved.name) === true;
  switch (resolved.kind) {
    case 'query':
      return { kind: 'query', option: `--${resolved.name}` };
    case 'flag':
      return { kind: 'continue', next: [index + 1] };
    case 'optional-value':
      return {
        kind: 'continue',
        next: [index + 1],
        replaceToken: isReplace ? (inline ?? '{}') : undefined,
      };
    case 'value':
    case 'split':
      return takeOptionValue(words, index, inline, resolved.kind, isReplace);
  }
}

function stepShortOptionCluster(
  bin: string,
  spec: ExecWrapperSpec,
  words: ShellWord[],
  index: number
): WrapperStep {
  const value = words[index].value;
  for (let position = 1; position < value.length; position++) {
    const letter = value[position];
    const kind = spec.short?.get(letter);
    if (kind === 'flag') {
      continue;
    }
    const rest = value.slice(position + 1);
    const isReplace = spec.replaceOptions?.has(letter) === true;
    if (kind === undefined) {
      logSafetyDecision(
        `wrapper ${bin} short option -${letter} is not in the known option spec; inspecting both the with-value and flag interpretations`
      );
      return { kind: 'continue', next: rest ? [index + 1] : [index + 1, index + 2] };
    }
    if (kind === 'query') {
      return { kind: 'query', option: `-${letter}` };
    }
    if (kind === 'optional-value') {
      return {
        kind: 'continue',
        next: [index + 1],
        replaceToken: isReplace ? rest || '{}' : undefined,
      };
    }
    return takeOptionValue(words, index, rest || undefined, kind, isReplace);
  }
  return { kind: 'continue', next: [index + 1] };
}

/** 取带值选项的值：粘连/'=' 写法用 inline，否则取下一个词。 */
function takeOptionValue(
  words: ShellWord[],
  index: number,
  inline: string | undefined,
  kind: 'value' | 'split',
  isReplace: boolean
): WrapperStep {
  let optionValue = inline;
  let nextIndex = index + 1;
  if (optionValue === undefined) {
    const next = words[index + 1];
    if (!next) {
      // 缺值：wrapper 报错退出，不执行任何程序。同样返回空目标：xargs 之下输入项会补上值与目标命令。
      return { kind: 'command', start: index + 1 };
    }
    if (next.dynamic) {
      return { kind: 'block', block: dynamicCommandBlock(next) };
    }
    optionValue = next.value;
    nextIndex = index + 2;
  }
  if (kind === 'split') {
    return { kind: 'split', value: optionValue, restStart: nextIndex };
  }
  return { kind: 'continue', next: [nextIndex], replaceToken: isReplace ? optionValue : undefined };
}

function resolveLongOption(
  table: ReadonlyMap<string, WrapperOptionKind> | undefined,
  name: string
): { name: string; kind: WrapperOptionKind } | undefined {
  if (!table || name === '') {
    return undefined;
  }
  const exact = table.get(name);
  if (exact) {
    return { name, kind: exact };
  }
  // GNU getopt_long 接受无歧义的前缀缩写；有歧义时真实程序报错，这里按规格外处理（两种解释都检查）。
  const matches = [...table].filter(([option]) => option.startsWith(name));
  if (matches.length !== 1) {
    return undefined;
  }
  const [matchedName, kind] = matches[0];
  return { name: matchedName, kind };
}

/**
 * GNU env -S 的拆分：\_ 在引号外是参数分隔、在双引号内是空格，\c 截断其后内容；先把它们折成
 * 空格/截断，再交给同一词法器拆词。无法拆分时 fail-closed（GNU env 同样会报错不执行）。
 */
function splitEnvString(value: string): { words: ShellWord[] } | { block: TerminalSafetyBlock } {
  let prepared = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const next = value[index + 1];
    if (char === '\\' && next === 'c') {
      break;
    }
    if (char === '\\' && next !== undefined) {
      prepared += next === '_' ? ' ' : `${char}${next}`;
      index++;
      continue;
    }
    prepared += char;
  }
  const parsed = parseSimpleShellWords(prepared);
  if (!parsed.ok) {
    return {
      block: {
        rule: 'shell-unparseable-command',
        reason: `env -S split string cannot be parsed: ${parsed.error}`,
      },
    };
  }
  return { words: parsed.commands[0] ?? [] };
}

/**
 * 分叉/短路路径的诊断：只记录 wrapper 名与选项名，不记录整条命令（审计侧只保存命令哈希）。
 */
function logSafetyDecision(message: string): void {
  Logger.getInstance().debug(`[terminalSafety] ${message}`);
}

/**
 * 只读 allowlist 检查的调用上下文：调用方掌握命令工作目录时传入（terminal handler 与 agent 层 accessGates
 * 都传）。只检查命令文本的调用方不传，此时不做依赖工作目录的检查。
 */
export interface TerminalAllowlistCallContext {
  /**
   * 命令工作目录是否就是项目根。为 false 时 git 被拒绝（allowlist-git-cwd，L4-P7d 复查发现）：项目里形似裸仓库
   * 的目录（HEAD、config、objects/、refs/ 都能作为普通文件被跟踪）会被 git 当作仓库，工作目录落在其中时 git 读取
   * 它的 config，diff.external、textconv 驱动等会让 git diff/log/show 执行仓库提供的程序（实测 git diff --no-index
   * 即可触发）。项目根下 git 找到的是项目自己的 .git，不受仓库内容控制。
   */
  cwdIsProjectRoot?: boolean;
}

export function checkTerminalCommandAllowlist(
  command: string,
  bins: readonly string[],
  context: TerminalAllowlistCallContext = {}
): { safe: true } | { safe: false; block: TerminalSafetyBlock } {
  return checkAllowlistWithPolicy(command, bins, EVOLUTION_CODE_EXECUTION_ENABLED, context);
}

/**
 * 仅供测试（terminalSafety 不在任何公开出口里）：按“代码执行开关已恢复”的策略评估，让保留的运行器、
 * 包管理器透传与 eslint/vitest/jest 规则在开关关闭期间仍有回归保护，恢复时不必重新验证一遍。
 * 生产调用方只能用 checkTerminalCommandAllowlist；这里同样走拒绝日志，便于断言日志不回显原始参数。
 */
export const __testingRetainedCodeExecutionRules = {
  check(
    command: string,
    bins: readonly string[],
    context: TerminalAllowlistCallContext = {}
  ): { safe: true } | { safe: false; block: TerminalSafetyBlock } {
    return checkAllowlistWithPolicy(command, bins, true, context);
  },
};

function checkAllowlistWithPolicy(
  command: string,
  bins: readonly string[],
  codeExecutionEnabled: boolean,
  context: TerminalAllowlistCallContext
): AllowlistResult {
  const evaluation = evaluateTerminalCommandAllowlist(command, bins, codeExecutionEnabled, context);
  if (!evaluation.result.safe) {
    // 每个拒绝分支都在这一处留日志：规则 id + bin + 参数的类别与长度。原因（reason）里可能带模型给出的
    // 原始参数（测试路径、路径限定的可执行文件、tsc 响应文件、git 子命令名、模块值……），只回给模型，不进日志；
    // 日志也不回显整条命令（审计侧只记命令哈希），避免把模型写进参数的凭据或路径带进诊断旁路。
    logAllowlistBlock(command, bins, evaluation);
  }
  return evaluation.result;
}

type AllowlistResult = { safe: true } | { safe: false; block: TerminalSafetyBlock };

interface AllowlistEvaluation {
  /** 规范化后的命令名，或 '[unparsed]'、'[empty]'、'[path-qualified]' 占位；日志再按白名单脱敏。 */
  bin: string;
  /** 切分后命令名之后的参数；命令未能切分时缺省。只用于日志里的计数，不回显内容。 */
  args?: readonly string[];
  result: AllowlistResult;
}

function evaluateTerminalCommandAllowlist(
  command: string,
  bins: readonly string[],
  codeExecutionEnabled: boolean,
  context: TerminalAllowlistCallContext
): AllowlistEvaluation {
  if (containsShellMeta(command)) {
    return {
      bin: '[unparsed]',
      result: readonlyBlock(
        'allowlist-shell-meta',
        'Shell meta characters are blocked for read-only terminal.exec allowlists'
      ),
    };
  }
  if (NON_SHELL_BLANK_WHITESPACE.test(command)) {
    // 本检查的词法器按 JS 的 \s 切词，宿主 sh 只按空格与制表符切词：NBSP、\v、\f、全角空格等在 sh 里
    // 留在同一个词内。'tsc a.ts b.ts<NBSP>--noEmit' 在这里数到一个有效的 --noEmit，sh 却把
    // 'b.ts<NBSP>--noEmit' 当作一个文件名交给 tsc，tsc 照常写出 a.js（实测）。分词结果不一致就无法静态判定，直接拒绝。
    return {
      bin: '[unparsed]',
      result: readonlyBlock(
        'allowlist-shell-whitespace',
        'Whitespace other than spaces and tabs is blocked for read-only terminal.exec allowlists because the host shell does not split words on it'
      ),
    };
  }
  if (hasShellControlChar(command)) {
    // NUL 截断交给 /bin/sh 的 C 字符串：'tsc -p tsconfig.json<NUL> --noEmit' 在这里数到 --noEmit，
    // 真正执行的却只有 'tsc -p tsconfig.json'（Node 的 spawn 今天会拒绝 NUL，但这里不依赖宿主执行器的实现）。
    // 其它 C0 控制字符与 DEL 在 sh 里是普通词字符，取证命令里不会出现，一并拒绝，免得终端回显或日志被控制序列污染。
    return {
      bin: '[unparsed]',
      result: readonlyBlock(
        'allowlist-shell-control-char',
        'Control characters (NUL, escape and other C0 controls) are blocked for read-only terminal.exec allowlists'
      ),
    };
  }

  const words = parseSimpleShellWords(command);
  if (!words.ok) {
    return {
      bin: '[unparsed]',
      result: readonlyBlock('allowlist-unparseable-command', words.error),
    };
  }
  const [rawBin, ...args] = words.words;
  // shell 层拒绝发生在识别命令名之前，bin 只用于日志（logAllowlistBlock 按白名单脱敏）。
  const shellLevelBin = (rawBin ?? '[empty]').toLowerCase();
  const braceExpansion = findBraceExpansion(command);
  if (braceExpansion !== 'none') {
    // 宿主 /bin/sh（macOS 上是 bash）会做花括号展开：`--{hostname-bin=./x.sh,hyperlink-format=file}`
    // 在本检查看来是一个未知选项，执行时却展开成两个独立选项。静态 literal 检查无法跟踪展开结果，直接拒绝；
    // 判定按 bash 的配对规则（见 findBraceExpansion）：HEAD@{1}、stash@{0}、x{a}y、{} 原样传给命令，不受影响，
    // 而 '--{glob=},pre=./x.sh}' 这类先出现 '}' 再出现逗号的写法同样会展开，必须拒绝。
    // 'too-complex' 是单词里候选 '{' 过多时的 fail-closed 短路（避免逐个配对占住事件循环），规则 id 相同、原因不同。
    return {
      bin: shellLevelBin,
      args,
      result: readonlyBlock(
        'allowlist-shell-brace-expansion',
        braceExpansion === 'expands'
          ? 'Unquoted brace expansion ({a,b}, {1..3} or an equivalent form such as {a}b,c}) is blocked for read-only terminal.exec allowlists; quote literal braces'
          : `More than ${MAX_BRACE_CANDIDATES_PER_WORD} unquoted "{" in one word cannot be checked for brace expansion and is blocked for read-only terminal.exec allowlists; quote literal braces`
      ),
    };
  }
  if (hasUnquotedComment(command)) {
    // sh 把未加引号、位于词首的 '#' 当作注释起点，其后的词都不会交给命令：'tsc # --noEmit' 实际执行裸 tsc
    // 并写出 JS，'vitest # run' 实际进入 watch 模式，而静态解析仍会数到 --noEmit / run。
    // 引号内、反斜杠转义或位于词中的 '#'（'#'、\#todo、foo#bar、--grep=#1）是普通 literal，不受影响。
    return {
      bin: shellLevelBin,
      args,
      result: readonlyBlock(
        'allowlist-shell-comment',
        'Unquoted "#" at the start of a word starts a shell comment and is blocked for read-only terminal.exec allowlists; quote a literal "#"'
      ),
    };
  }
  if (hasOptionLikeGlob(command)) {
    // sh 的路径名展开把未加引号的 glob 词换成匹配到的文件名，文件名可以以 '-' 开头：仓库里放一个名为
    // '--pre=sh' 的文件，'rg Recipe *' 实际收到 --pre=sh 并用 sh 执行每个被搜索的文件（rg 15.1.0 实测）。
    // 静态检查看到的只是 '*'，无法判定展开结果，所以凡是展开后可能以 '-' 开头的 glob 词一律拒绝；
    // 加引号交给工具自己的 glob（-g '*.ts'、node --test '**/*.test.mjs'），或加 './' 前缀（./*）即可放行。
    return {
      bin: shellLevelBin,
      args,
      result: readonlyBlock(
        'allowlist-shell-glob-option',
        'Unquoted glob that the host shell may expand into an option-like file name (a word starting with a glob character, or an option word with a glob before "=") is blocked for read-only terminal.exec allowlists; quote the pattern or prefix the path with "./"'
      ),
    };
  }

  if (rawBin !== undefined && /[\\/]/.test(rawBin)) {
    // 只允许裸命令名经 PATH 解析。被分析仓库自带的 scripts/git、bin/cat 之类同名脚本
    // （或先前被写入的文件）会顶替系统命令，绕过 git/node 等子命令的只读约束；
    // node_modules/.bin/<tool> 也一并拒绝，等价入口是 npm run <script> 或裸 <tool>。
    // 原因里回显模型给出的路径（模型自己的输入）；日志只记占位 '[path-qualified]'，不写路径。
    return {
      bin: '[path-qualified]',
      args,
      result: readonlyBlock(
        'allowlist-path-qualified-bin',
        `Path-qualified executable is blocked for read-only terminal allowlists: ${truncateForReason(rawBin)}`
      ),
    };
  }
  const bin = (rawBin ?? '').toLowerCase();
  if (!codeExecutionEnabled && CODE_EXECUTING_BINS.has(bin)) {
    // L4-P7d 开关关闭：不看参数，整条拒绝（含 npx 这类本就不在 allowlist 里的同类入口），给模型一个统一、
    // 不随写法变化的原因，避免换参数反复重试。放在 shell 层检查之后：那些拒绝与命令名无关，规则 id 不变。
    return {
      bin,
      args,
      result: readonlyBlock(
        'allowlist-code-execution-disabled',
        `Evolution does not run commands that execute repository code until the host read-only sandbox is enabled (宿主只读沙箱启用前，Evolution 不运行会执行仓库代码的命令): "${bin}" is disabled, including tests, package scripts and lint (node, npm/pnpm/yarn, npx, vitest, jest, eslint). Gather evidence with read-only commands (git log/blame/diff/show/status, rg, grep, ls, cat, head, tail, wc, find, tsc --noEmit, biome check) or with code.search / code.read; do not retry these commands in another form.`
      ),
    };
  }
  const allowedBins = new Set(bins.map((item) => item.toLowerCase()));
  if (!bin || !allowedBins.has(bin)) {
    return {
      bin: bin || '[empty]',
      args,
      result: readonlyBlock(
        'allowlist-denied-bin',
        `Command "${truncateForReason(bin || '[empty]')}" is not in the read-only terminal allowlist`
      ),
    };
  }

  if (bin === 'git' && context.cwdIsProjectRoot === false) {
    // 只有调用方明确告知“不在项目根”时拒绝（未传上下文的纯文本检查不适用）。git 的仓库发现从工作目录开始：
    // 形似裸仓库的被跟踪目录会被当作 git 目录并读取其 config（diff.external 等执行仓库提供的程序），
    // 选项与子命令检查都看不到这一层，所以只读 allowlist 下 git 一律在项目根运行，用路径参数限定范围。
    return {
      bin,
      args,
      result: readonlyBlock(
        'allowlist-git-cwd',
        'git runs only at the project root under read-only terminal.exec allowlists (a repository directory shaped like a bare git repository would make git load its config and run programs such as diff.external); omit cwd and limit the scope with a path argument, e.g. git log -- src/module'
      ),
    };
  }

  const deniedOption = findDeniedOption(bin, args);
  if (deniedOption) {
    return { bin, args, result: deniedOptionBlock(bin, deniedOption) };
  }

  return { bin, args, result: checkReadonlySubcommand(bin, args) };
}

export function containsShellMeta(value: string): boolean {
  // 换行可启动第二条命令；变量展开可拼出被禁止的选项，均不能当普通参数放行。
  return /[\r\n;&|<>`$]/.test(value);
}

// 宿主 sh 只把空格与制表符当作词间空白（换行/回车已由 containsShellMeta 拒绝）；其余被 JS \s 匹配的空白
// （NBSP、\v、\f、U+2000 系列、全角空格、BOM 等）在 sh 里属于词的一部分。
const NON_SHELL_BLANK_WHITESPACE = /[^\S \t]/;

/** 单个词里候选 '{' 的上限；超过即 fail-closed（32 KiB 命令逐个配对的平方开销不可接受）。 */
const MAX_BRACE_CANDIDATES_PER_WORD = 64;

/**
 * 宿主 /bin/sh（macOS 上是 bash 3.2；dash 不做花括号展开，按 bash 从严）的花括号展开判定，逐条对应 bash
 * braces.c 的 brace_gobbler：
 * - 展开按词进行；只有未加引号、未被反斜杠转义的 '{'、'}'、','、'.' 参与（x{'a,b'}y、x{a\,b}y 原样保留）。
 * - 词里每个这样的 '{' 都是候选（某个候选不成立时 bash 接着试后面的 '{'，所以嵌套在内层的也算）。
 * - 候选从 '{' 之后向右扫描：内层 '{' 使层级加一、层级大于 0 时的 '}' 使层级减一；层级 0 的逗号或 '..'
 *   记为分隔符；层级 0 的 '}' 只有在已经出现过分隔符时才闭合本组，否则被当作普通字符跳过。
 *   所以 HEAD@{1}、stash@{0}、x{a}y、{}、HEAD@{1}..HEAD@{0} 都不展开（实测原样输出），而
 *   '{a}b,c}' 展开成 'a}b' 与 'c'、'--{glob=},pre=./x.sh}' 展开成 '--glob=}' 与 '--pre=./x.sh'。
 * - 从严之处（都只会多拒绝、不会漏拒绝）：'..' 后紧跟 '}'（{1..}）与非法序列（{a..bc}）bash 不展开，这里照样
 *   算分隔符；词首 '{}' 后的特殊豁免（'{}a,b}' 不展开）不模拟。
 * 逐个候选向右扫描最坏是平方复杂度，单词里候选超过 MAX_BRACE_CANDIDATES_PER_WORD 时直接返回 'too-complex'
 * （fail-closed），调用方以同一规则拒绝并在原因里写明。
 */
function findBraceExpansion(command: string): 'none' | 'expands' | 'too-complex' {
  for (const word of splitWordsForBraceScan(command)) {
    let candidates = 0;
    for (let index = 0; index < word.length; index++) {
      if (!isActiveBraceChar(word[index], '{')) {
        continue;
      }
      candidates++;
      if (candidates > MAX_BRACE_CANDIDATES_PER_WORD) {
        return 'too-complex';
      }
      if (braceGroupCloses(word, index + 1)) {
        return 'expands';
      }
    }
  }
  return 'none';
}

/** 词里的一个原始字符；active 表示它不在引号内、未被转义，且本身不是引号或转义用的反斜杠。 */
interface BraceScanChar {
  char: string;
  active: boolean;
}

function isActiveBraceChar(entry: BraceScanChar | undefined, char: string): boolean {
  return entry?.active === true && entry.char === char;
}

/**
 * 按 sh 的空格/制表符切词（其他空白、换行与 '$'、'`' 等已在更前面的检查里拒绝），保留每个原始字符，
 * 使 '..' 的相邻判断与 bash 在原文上的判断一致（'.\.'、".'.'" 中间隔着转义符或引号，不算 '..'）。
 */
function splitWordsForBraceScan(command: string): BraceScanChar[][] {
  const words: BraceScanChar[][] = [];
  let current: BraceScanChar[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      escaped = false;
      current.push({ char, active: false });
      continue;
    }
    if (char === '\\' && quote !== "'") {
      // 单引号外的反斜杠转义下一个字符（双引号内同样跳过下一个字符，与 brace_gobbler 一致）。
      escaped = true;
      current.push({ char, active: false });
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      current.push({ char, active: false });
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current.push({ char, active: false });
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (current.length > 0) {
        words.push(current);
        current = [];
      }
      continue;
    }
    current.push({ char, active: true });
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words;
}

/** 从候选 '{' 之后扫描到词尾，判断这一组是否按 bash 规则闭合（闭合即会展开）。 */
function braceGroupCloses(word: readonly BraceScanChar[], from: number): boolean {
  let level = 0;
  let separators = 0;
  for (let index = from; index < word.length; index++) {
    const entry = word[index];
    if (!entry.active) {
      continue;
    }
    if (entry.char === '}' && level === 0 && separators > 0) {
      return true;
    }
    if (entry.char === '{') {
      level++;
    } else if (entry.char === '}') {
      // 层级 0、尚无分隔符的 '}' 不闭合也不改变层级，bash 把它当普通字符。
      if (level > 0) {
        level--;
      }
    } else if (
      level === 0 &&
      (entry.char === ',' || (entry.char === '.' && isActiveBraceChar(word[index + 1], '.')))
    ) {
      separators++;
    }
  }
  return false;
}

/** 只有不在引号内、未被转义、且位于词首的 '#' 会开始 shell 注释；词中的 '#'（foo#bar、''#x）是普通字符。 */
function hasUnquotedComment(command: string): boolean {
  return someUnquotedChar(command, (char, { atWordStart }) => char === '#' && atWordStart);
}

// sh 路径名展开的模式字符；'[' 没有配对的 ']' 时其实是字面量，这里不区分，一律按 glob 处理（从严）。
const SHELL_GLOB_CHARS = new Set(['*', '?', '[']);

/**
 * NUL（截断交给 sh 的 C 字符串）、其余 C0 控制字符与 DEL。0x09-0x0d 不在这里：\t 是 sh 的分词符，
 * \n/\r 由 containsShellMeta 拒绝，\v/\f 由 NON_SHELL_BLANK_WHITESPACE 拒绝。按码点比较而不是写成
 * 含控制字符的正则，避免 lint 的 noControlCharactersInRegex 与不可见字符混进源码。
 */
function hasShellControlChar(command: string): boolean {
  for (let index = 0; index < command.length; index++) {
    const code = command.charCodeAt(index);
    if (code <= 0x08 || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * 路径名展开后可能以 '-' 开头的 glob 词：sh 把整个词换成匹配到的路径，每个结果都以第一个未加引号 glob 字符
 * 之前的字面前缀开头，前缀之后的部分来自目录项名（可以是 '--pre=sh' 这种文件名）。所以：
 * - 前缀为空（*.ts、""*、?eadme.md）：结果可以是任意文件名，包括以 '-' 开头的“选项”；
 * - 前缀以 '-' 开头且不含 '='（-*、--pre*、-u*）：结果仍是选项，但选项名（或短选项簇的字母）
 *   由文件名决定；前缀里已有 '='（--glob=*.ts、--testNamePattern=*）时选项名已固定，只有值随文件名变化。
 * 其余前缀（src/*、./*、README*）展开后以该前缀开头，不会变成选项。引号内与转义的 glob 字符不展开。
 * 双引号内 '\x'（x 非 $ ` " \）在 sh 里保留反斜杠，这里把它当成 x：只会让前缀更像选项，判定更严。
 */
function hasOptionLikeGlob(command: string): boolean {
  return someUnquotedChar(
    command,
    (char, { wordPrefix }) =>
      SHELL_GLOB_CHARS.has(char) &&
      (wordPrefix === '' || (wordPrefix.startsWith('-') && !wordPrefix.includes('=')))
  );
}

interface UnquotedCharContext {
  /** 该字符前面是命令开头或未加引号的空格/制表符（引号与转义字符也会让当前词开始）。 */
  atWordStart: boolean;
  /** 当前词在该字符之前的字面文本：去掉引号、保留引号内与转义的字符。 */
  wordPrefix: string;
}

/**
 * 与 parseSimpleShellWords 相同的引号/转义状态机，逐个检查“不在引号内、未被反斜杠转义”的字符，
 * 并告诉 predicate 该字符是否位于词首，以及当前词在它之前的字面前缀。
 * 引号字符本身与被转义的字符都会让当前词开始，所以 "" # 里的 '#' 位于词首，''#x 里的 '#' 不在词首
 * （但 ''#x 里 '#' 之前的字面前缀仍为空）。
 */
function someUnquotedChar(
  command: string,
  predicate: (char: string, context: UnquotedCharContext) => boolean
): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let atWordStart = true;
  let wordPrefix = '';
  for (const char of command) {
    if (escaped) {
      escaped = false;
      atWordStart = false;
      wordPrefix += char;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (!quote && (char === '"' || char === "'")) {
      quote = char;
      atWordStart = false;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        wordPrefix += char;
      }
      continue;
    }
    if (char === ' ' || char === '\t') {
      atWordStart = true;
      wordPrefix = '';
      continue;
    }
    if (predicate(char, { atWordStart, wordPrefix })) {
      return true;
    }
    atWordStart = false;
    wordPrefix += char;
  }
  return false;
}

/** 词法器给每个词的静态视图。 */
interface ShellWord {
  /** 去引号、解转义后的静态文本；命令替换的位置以 SUBSTITUTION_MARK 占位。 */
  value: string;
  /**
   * 运行时才确定的部分：'command-substitution' 是反引号或 $(...) 的输出；'parameter-expansion' 是
   * $VAR、$1、"$@"、${VAR} 等参数展开（可能为空，未加引号时还会再切词）；
   * 'exec-placeholder' 是 find -exec / xargs -I 运行时替换成文件名或输入项的占位串。
   * 一个词同时含命令替换与参数展开时记为命令替换（两者在命令位置都 fail-closed）。
   */
  dynamic?: 'command-substitution' | 'parameter-expansion' | 'exec-placeholder';
  /** 重定向运算符；其后一个词是重定向目标而不是命令参数。 */
  redirection?: true;
  /** 切分命令模式下词在原始命令串里的区间 [start, end)；正则兜底据此把命中映射回词。 */
  start?: number;
  end?: number;
}

type ShellLexResult =
  | {
      ok: true;
      words: string[];
      commands: ShellWord[][];
      substitutions: string[];
      /**
       * 切分命令模式下 commands[k] 之后的分隔符（; & | ( ) 换行），separators.length === commands.length - 1。
       * 正则兜底据此找出管道下游的命令（'||' 是两个 '|' 之间夹一条空命令）。
       */
      separators: string[];
      /** 切分命令模式下是否遇到过词首未加引号的 '#'（注释是否生效会改变后续切分）。 */
      sawCommentStart: boolean;
    }
  | { ok: false; error: string };

interface ShellLexOptions {
  /**
   * 词首 '#' 是否按注释处理（到行尾为止，不含换行）。非交互 shell（sh -c、bash -c、zsh -c）
   * 都认注释；关闭 interactive_comments 的交互 shell 不认。两种读法由调用方分别检查。
   */
  comments: boolean;
}

// shell 词法里真正的词边界：空格、制表符、换行与运算符字符。'#' 只有紧跟这些字符（或位于串首）
// 才开始注释；\r、\v、\f、NBSP 在 shell 里是普通词字符，'\r#' 不是注释。
const SHELL_TOKEN_BREAK = /[ \t\n;&|()<>]/;

// 命令替换在词值里的占位符：r``m 这类拼接不会被当成 rm 或赋值前缀，并且整个词标记为运行时值。
const SUBSTITUTION_MARK = '\u0000';
const UNPARSEABLE_LITERALS = 'Unable to parse terminal command literals';
const HEREDOC_UNPARSEABLE =
  'Here-document (<< or <<-) cannot be split statically: its body lines would be mistaken for commands or hide the commands after the delimiter';
// POSIX sh：双引号内只有 $ ` " \ 与换行前的反斜杠是转义，其余反斜杠原样传给程序（env -S 的 \_ 依赖这一点）。
const DOUBLE_QUOTE_ESCAPABLE = new Set(['$', '`', '"', '\\']);
// 替换体扫描（$( 套 " 套 $( ...）的递归上限，防止异常深嵌套耗尽调用栈。
const MAX_SCAN_NESTING = 32;
// 未加引号的普通词字符：保留字（case）只有在整个词都由这些字符组成时才生效。
const PLAIN_WORD_CHAR = /[^\s;&|()<>'"`\\$]/;
// '$' 之后开始参数展开的字符：变量名、位置参数与特殊参数（@ * # ? $ ! -）。单引号内不展开。
const PARAMETER_EXPANSION_START = /[A-Za-z0-9_@*#?$!-]/;

/**
 * 静态 shell 词法器。splitCommands=false（只读 allowlist、env -S）只拆词；splitCommands=true
 * （危险命令黑名单）再按 ; & | ( ) 换行切分命令、识别重定向，并把命令替换体（反引号与 $(...)，
 * 含双引号内的）收集到 substitutions 供递归检查。单引号内一律是字面量。切分命令模式下遇到 heredoc
 * 运算符（'<<'、'<<-'，不含 here-string '<<<'）直接返回失败，由调用方 fail-closed。
 * 注释只在切分命令模式下处理：options.comments=false 时词首 '#' 按普通字面量（注释不生效的读法），
 * 为 true 时跳到行尾；两种模式都通过 sawCommentStart 报告是否出现过词首 '#'。
 */
function parseSimpleShellWords(
  command: string,
  splitCommands = false,
  options: ShellLexOptions = { comments: false }
): ShellLexResult {
  const input = command.trim();
  if (!input) {
    return {
      ok: true,
      words: [],
      commands: [],
      substitutions: [],
      separators: [],
      sawCommentStart: false,
    };
  }
  // input 是去掉首尾空白后的串；加上 base 才是原始命令串里的偏移（正则兜底按原始串定位命中）。
  const base = command.length - command.trimStart().length;

  const words: string[] = [];
  const commands: ShellWord[][] = [[]];
  const substitutions: string[] = [];
  const separators: string[] = [];
  let current = '';
  let hasWord = false;
  let substituted = false;
  let expanded = false;
  let wordStart = 0;
  let sawCommentStart = false;
  let quote: '"' | "'" | null = null;
  const flushWord = (end: number) => {
    if (hasWord) {
      words.push(current);
      const word: ShellWord = { value: current };
      if (substituted) {
        word.dynamic = 'command-substitution';
      } else if (expanded) {
        word.dynamic = 'parameter-expansion';
      }
      if (splitCommands) {
        // 只有切分命令模式的偏移才属于原始命令串；env -S 拆分串的偏移另有坐标系，不记录。
        word.start = base + wordStart;
        word.end = base + end;
      }
      commands[commands.length - 1].push(word);
      current = '';
      hasWord = false;
      substituted = false;
      expanded = false;
    }
  };
  const fail = (error: string): ShellLexResult => ({ ok: false, error });

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (!hasWord) {
      // 词从第一个让 hasWord 变真的字符开始；空白、运算符与续行不会让它变真，下一轮再记。
      wordStart = i;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '\\') {
      const next = input[i + 1];
      if (next === undefined) {
        return fail(UNPARSEABLE_LITERALS);
      }
      i++;
      if (next !== '\n') {
        current += quote === '"' && !DOUBLE_QUOTE_ESCAPABLE.has(next) ? `\\${next}` : next;
        hasWord = true;
      }
      continue;
    }
    if (char === '`') {
      const scanned = scanBacktickSubstitution(input, i + 1, quote === '"');
      if (!scanned) {
        return fail('Unterminated backtick command substitution');
      }
      substitutions.push(scanned.inner);
      current += SUBSTITUTION_MARK;
      hasWord = true;
      substituted = true;
      i = scanned.end;
      continue;
    }
    if (char === '$') {
      // 续行（反斜杠紧跟换行）在切词前就被 shell 删掉：'$\<换行>(' 就是 '$('（双引号内同样如此），
      // 所以判断 $ 之后的结构时先跳过续行，否则双引号里的命令替换会被当成字面量藏起来。
      const nextIndex = skipLineContinuations(input, i + 1);
      const next = input[nextIndex];
      if (next === '(') {
        const end = findParenSubstitutionEnd(input, nextIndex + 1, 0);
        if (end < 0) {
          return fail(
            'Command substitution $(...) is unterminated or cannot be split statically (heredoc, case or comment inside)'
          );
        }
        substitutions.push(input.slice(nextIndex + 1, end));
        current += SUBSTITUTION_MARK;
        hasWord = true;
        substituted = true;
        i = end;
        continue;
      }
      if (next === '{') {
        const end = findParameterExpansionEnd(input, nextIndex + 1);
        if (end < 0) {
          return fail(
            'Parameter expansion with nested quoting or substitution cannot be inspected statically'
          );
        }
        // 参数展开不求值（静态 literal 边界），去掉续行后原样保留在词里；整个词标记为运行时值。
        current += `$${input.slice(nextIndex, end + 1)}`;
        hasWord = true;
        expanded = true;
        i = end;
        continue;
      }
      if (quote === null && next === "'") {
        // $'...'：ANSI-C 引号，$'\x72\x6d' 就是 rm，必须按解码后的文本判定。
        const decoded = decodeAnsiCQuote(input, nextIndex + 1);
        if (!decoded) {
          return fail(UNPARSEABLE_LITERALS);
        }
        current += decoded.value;
        hasWord = true;
        i = decoded.end;
        continue;
      }
      if (quote === null && next === '"') {
        // $"..."：本地化字符串，内容按普通双引号处理。
        quote = '"';
        hasWord = true;
        i = nextIndex;
        continue;
      }
      if (next !== undefined && PARAMETER_EXPANSION_START.test(next)) {
        // $NAME、$1、"$@"、$* 等：值运行时才确定。'$' 与名字照常留在词值里，整个词标记为运行时值，
        // 命令位置与 wrapper 结构上遇到它时和命令替换一样 fail-closed。
        expanded = true;
      }
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (
      splitCommands &&
      char === '#' &&
      !hasWord &&
      (i === 0 || SHELL_TOKEN_BREAK.test(input[i - 1]))
    ) {
      // 词首未加引号、未转义的 '#'。注释读法下它和其后直到换行（不含换行）的内容都被丢弃：
      // 注释里的引号不能开启引号串，否则换行后的真实命令会被当成引号内字面量藏起来。
      sawCommentStart = true;
      if (options.comments) {
        const newline = input.indexOf('\n', i);
        i = (newline < 0 ? input.length : newline) - 1;
        continue;
      }
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasWord = true;
      continue;
    }
    if (
      splitCommands &&
      (/[<>]/.test(char) || (char === '&' && input[skipLineContinuations(input, i + 1)] === '>'))
    ) {
      // 紧贴在 < > 前的纯数字词（2>err、0<in）或 {name}（{fd}>out）是重定向的文件描述符，
      // 不是命令或参数：'2>/dev/null sudo reboot' 的命令是 sudo。带引号的 "2" 在 shell 里其实是普通词，
      // 这里一并当成描述符，只会让其后的词多经过一次命令位置检查。
      const fdPrefix =
        hasWord && !substituted && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(current);
      if (fdPrefix) {
        current = '';
        hasWord = false;
        expanded = false;
      } else {
        flushWord(i);
      }
      let operator = char;
      // 运算符字符之间的续行同样先被删掉：'<\<换行><' 就是 '<<'。
      for (
        let next = skipLineContinuations(input, i + 1);
        next < input.length && /[<>&|]/.test(input[next]);
        next = skipLineContinuations(input, i + 1)
      ) {
        operator += input[next];
        i = next;
      }
      if (operator.includes('<<') && operator !== '<<<') {
        // heredoc（<<、<<-，含引号定界符）的正文从下一行起一直到定界符行都是数据，定界符之后
        // 的行才回到命令；正文里的引号、注释与反引号会让按行切分的结果和 shell 完全不同，
        // 未加引号定界符的正文还会做命令替换。静态切分不可靠，直接 fail-closed，与 $(...) 内一致。
        return fail(HEREDOC_UNPARSEABLE);
      }
      words.push(operator);
      commands[commands.length - 1].push({ value: operator, redirection: true });
      continue;
    }
    if (splitCommands && /[\r\n;&|()]/.test(char)) {
      flushWord(i);
      words.push(char);
      separators.push(char);
      commands.push([]);
      continue;
    }
    if (/\s/.test(char)) {
      flushWord(i);
      continue;
    }
    current += char;
    hasWord = true;
  }

  if (quote) {
    return fail(UNPARSEABLE_LITERALS);
  }
  flushWord(input.length);
  return { ok: true, words, commands, substitutions, separators, sawCommentStart };
}

/**
 * 跳过从 index 开始的续行（反斜杠紧跟换行），返回第一个不属于续行的下标。shell 在切词前就删掉
 * 续行，两侧字符直接相连；凡是按“相邻字符”判断结构的地方（'$(', '<<', 词首 '#', 'case'）都要先跳过它。
 * 单引号内与注释里的反斜杠不是续行，调用方只在这两种上下文之外使用。
 */
function skipLineContinuations(input: string, index: number): number {
  let cursor = index;
  while (input[cursor] === '\\' && input[cursor + 1] === '\n') {
    cursor += 2;
  }
  return cursor;
}

/**
 * 反引号命令替换：找第一个未转义的反引号（sh 规定其间的引号不影响边界）。替换体内只有
 * \\、\` 与 \$（双引号内再加 \"）的反斜杠被去掉，其余原样保留；嵌套替换写成 \`...\`，
 * 去转义后交给递归检查。
 */
function scanBacktickSubstitution(
  input: string,
  start: number,
  inDoubleQuotes: boolean
): { inner: string; end: number } | null {
  let inner = '';
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (char === '`') {
      return { inner, end: i };
    }
    if (char === '\\') {
      const next = input[i + 1];
      if (next === undefined) {
        return null;
      }
      i++;
      const unescaped =
        next === '\\' || next === '`' || next === '$' || (inDoubleQuotes && next === '"');
      inner += unescaped ? next : `\\${next}`;
      continue;
    }
    inner += char;
  }
  return null;
}

/**
 * 找到 $( 对应的 )，返回其下标；无法可靠切分时返回 -1（调用方 fail-closed）。
 * 识别嵌套括号、引号、反引号、$(...)、${...}、$'...' 与 here-string。替换体内的 heredoc
 * （正文可含任意括号）、case 语句（模式的 ')' 不成对）与 '#' 注释（可吞掉 ')'）会让 shell 的切分
 * 与这里不同，直接拒绝：若误判边界，双引号内剩余的真实命令会被当成字面量藏起来。
 */
function findParenSubstitutionEnd(input: string, start: number, nesting: number): number {
  if (nesting > MAX_SCAN_NESTING) {
    return -1;
  }
  let depth = 0;
  let wordStart = true;
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (char === '\\') {
      // 续行对切词透明：'a \<换行>#' 里的 '#' 仍在词首（注释），不能因此把注释漏判成普通字符。
      if (input[i + 1] !== '\n') {
        wordStart = false;
      }
      i++;
      continue;
    }
    if (char === "'") {
      const close = input.indexOf("'", i + 1);
      if (close < 0) {
        return -1;
      }
      i = close;
      wordStart = false;
      continue;
    }
    if (char === '"') {
      const close = findDoubleQuoteEnd(input, i + 1, nesting + 1);
      if (close < 0) {
        return -1;
      }
      i = close;
      wordStart = false;
      continue;
    }
    if (char === '`') {
      const scanned = scanBacktickSubstitution(input, i + 1, false);
      if (!scanned) {
        return -1;
      }
      i = scanned.end;
      wordStart = false;
      continue;
    }
    if (char === '$') {
      const end = skipDollarConstruct(input, i, nesting);
      if (end === -1) {
        return -1;
      }
      i = end;
      wordStart = false;
      continue;
    }
    if (char === '(') {
      depth++;
      wordStart = true;
      continue;
    }
    if (char === ')') {
      if (depth === 0) {
        return i;
      }
      depth--;
      wordStart = true;
      continue;
    }
    if (char === '<') {
      // '<<'（含被续行拆开的 '<\<换行><'）是 heredoc，'<<<' 是 here-string。
      const second = skipLineContinuations(input, i + 1);
      if (input[second] === '<') {
        const third = skipLineContinuations(input, second + 1);
        if (input[third] !== '<') {
          return -1;
        }
        i = third;
      }
      wordStart = true;
      continue;
    }
    if (/[\s;&|>]/.test(char)) {
      wordStart = true;
      continue;
    }
    if (wordStart) {
      if (char === '#' || readPlainWord(input, i) === 'case') {
        return -1;
      }
    }
    wordStart = false;
  }
  return -1;
}

/** 从 start 读一个由普通词字符组成的词，跳过其间的续行（'ca\<换行>se' 就是 case）。 */
function readPlainWord(input: string, start: number): string {
  let word = '';
  for (let i = skipLineContinuations(input, start); i < input.length; ) {
    const char = input[i];
    if (!PLAIN_WORD_CHAR.test(char)) {
      break;
    }
    word += char;
    i = skipLineContinuations(input, i + 1);
  }
  return word;
}

/** 双引号串的结束下标；其中的反引号、$(...)、${...} 按各自规则跳过。 */
function findDoubleQuoteEnd(input: string, start: number, nesting: number): number {
  if (nesting > MAX_SCAN_NESTING) {
    return -1;
  }
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '"') {
      return i;
    }
    if (char === '`') {
      const scanned = scanBacktickSubstitution(input, i + 1, true);
      if (!scanned) {
        return -1;
      }
      i = scanned.end;
      continue;
    }
    if (char === '$') {
      // 双引号内的 $' 不是 ANSI-C 引号，只跳过 $( 与 ${（其间可夹续行）。
      const afterDollar = input[skipLineContinuations(input, i + 1)];
      if (afterDollar === '(' || afterDollar === '{') {
        const end = skipDollarConstruct(input, i, nesting);
        if (end === -1) {
          return -1;
        }
        i = end;
      }
    }
  }
  return -1;
}

/**
 * 跳过从 input[index]（'$'）开始的 $(...)、${...}、$'...'，返回其最后一个字符的下标；
 * 普通 $ 返回 index 本身；无法切分返回 -1。
 */
function skipDollarConstruct(input: string, index: number, nesting: number): number {
  // '$' 与其后的 ( { ' 之间可以夹续行。
  const nextIndex = skipLineContinuations(input, index + 1);
  const next = input[nextIndex];
  if (next === '(') {
    return findParenSubstitutionEnd(input, nextIndex + 1, nesting + 1);
  }
  if (next === '{') {
    return findParameterExpansionEnd(input, nextIndex + 1);
  }
  if (next === "'") {
    return decodeAnsiCQuote(input, nextIndex + 1)?.end ?? -1;
  }
  return index;
}

/**
 * ${...} 的结束下标。bash 允许 "${x:-"a"}" 这类嵌套引号与 ${x:-$(cmd)} 嵌套替换，它们会改变
 * '}' 与外层引号的归属；静态无法可靠切分，遇到即返回 -1（fail-closed）。反斜杠转义下一个字符。
 */
function findParameterExpansionEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (char === '}') {
      return i;
    }
    if (char === '\\') {
      i++;
      continue;
    }
    // '$' 与 ( { ' 之间夹续行时同样是嵌套替换或引号。
    if (
      `'"\`{`.includes(char) ||
      (char === '$' && /[({']/.test(input[skipLineContinuations(input, i + 1)] ?? ''))
    ) {
      return -1;
    }
  }
  return -1;
}

const ANSI_C_SIMPLE_ESCAPES = new Map([
  ['a', '\u0007'],
  ['b', '\b'],
  ['e', '\u001b'],
  ['E', '\u001b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
  ['?', '?'],
]);

/** 解码 $'...'（start 指向开引号之后），返回文本与闭引号下标；未闭合返回 null。 */
function decodeAnsiCQuote(input: string, start: number): { value: string; end: number } | null {
  let value = '';
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (char === "'") {
      return { value, end: i };
    }
    if (char !== '\\') {
      value += char;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) {
      return null;
    }
    i++;
    const simple = ANSI_C_SIMPLE_ESCAPES.get(next);
    if (simple !== undefined) {
      value += simple;
      continue;
    }
    if (next === 'c') {
      const control = input[i + 1];
      if (control === undefined) {
        return null;
      }
      i++;
      value += String.fromCharCode(control.charCodeAt(0) & 0x1f);
      continue;
    }
    const numeric = readAnsiCNumericEscape(input, i);
    if (numeric) {
      value += numeric.text;
      i = numeric.end;
      continue;
    }
    // 未知转义：bash 原样保留反斜杠。
    value += `\\${next}`;
  }
  return null;
}

/** $'...' 的数值转义：\nnn 八进制、\xHH、\uHHHH、\UHHHHHHHH；index 指向转义字母或首位八进制数字。 */
function readAnsiCNumericEscape(
  input: string,
  index: number
): { text: string; end: number } | null {
  const kind = input[index];
  if (/[0-7]/.test(kind)) {
    let end = index;
    while (end - index < 2 && /[0-7]/.test(input[end + 1] ?? '')) {
      end++;
    }
    return {
      text: String.fromCharCode(Number.parseInt(input.slice(index, end + 1), 8) & 0xff),
      end,
    };
  }
  const width = kind === 'x' ? 2 : kind === 'u' ? 4 : kind === 'U' ? 8 : 0;
  let end = index;
  while (end - index < width && /[0-9A-Fa-f]/.test(input[end + 1] ?? '')) {
    end++;
  }
  if (end === index) {
    return null;
  }
  const codePoint = Number.parseInt(input.slice(index + 1, end + 1), 16);
  if (codePoint > 0x10ffff) {
    return null;
  }
  return {
    text: kind === 'x' ? String.fromCharCode(codePoint) : String.fromCodePoint(codePoint),
    end,
  };
}

/** 规范化后的选项 token。 */
interface ParsedOption {
  raw: string;
  /** 去掉前导横线、'=' 之后的值与 '.' 之后的子键，再折叠 kebab/snake/camel 后的无分隔小写名。 */
  name: string;
  /**
   * 名字段：'=' 之前开头连续的 [A-Za-z0-9-] 字符，按同样规则折叠。optionator（eslint）只认这一段，
   * 其后的 '_'、'/'、':'、'.' 等字符在没有 '=' 紧随时被丢弃：--fix_x 即 --fix，--output-file_x 即 --output-file。
   */
  stem: string;
  /** '=' 之前只由 [A-Za-z0-9-] 组成：各解析器对它的名字与值归属一致。值即模块的选项只接受这种写法。 */
  plain: boolean;
  /** 按 '.' 分段各自规范化后的全路径（--typecheck.checker → typecheck.checker）。 */
  path: string;
  /** '=' 之后的内联值。 */
  inlineValue: string | undefined;
  /** 单横线 token 在 '=' 之前的原始字符，按短选项簇解释时逐字母比较；双横线 token 为 null。 */
  letters: string[] | null;
}

/**
 * 选项名规范化：去掉前导一或两个横线；先切 '=' 再切 '.'，避免把值里的路径点号当成子键；
 * 每段小写并去掉 '-'/'_'。cac（vitest，实测 --outputFile.tap=./tap.txt）与 yargs（jest）都把 --opt.key
 * 解析成 --opt 的子字段，写类/执行类选项的目标仍由首段决定，所以按 name 判定；--sequence.shuffle、
 * --typecheck.only 这类只读子键由白名单的 subkeys 单独放行。stem/plain 见 ParsedOption。
 */
function parseOption(arg: string): ParsedOption | null {
  if (!arg.startsWith('-') || arg === '-' || arg === '--') {
    return null;
  }
  const singleDash = !arg.startsWith('--');
  const body = arg.replace(/^-+/, '');
  const equalsIndex = body.indexOf('=');
  const key = equalsIndex < 0 ? body : body.slice(0, equalsIndex);
  const segments = key.split('.').map((segment) => segment.toLowerCase().replace(/[-_]/g, ''));
  const stemRun = /^[A-Za-z0-9-]*/.exec(key)?.[0] ?? '';
  return {
    raw: arg,
    name: segments[0] ?? '',
    stem: stemRun.toLowerCase().replace(/-/g, ''),
    plain: stemRun.length > 0 && stemRun === key,
    path: segments.join('.'),
    inlineValue: equalsIndex < 0 ? undefined : body.slice(equalsIndex + 1),
    letters: singleDash ? [...key] : null,
  };
}

/** 黑名单的长名候选：完整规范化名，以及与之不同时的 optionator 名字段；空名不参与比较。 */
function optionNameCandidates(option: ParsedOption): string[] {
  return [option.name, option.stem].filter(
    (candidate, index, all) => candidate !== '' && all.indexOf(candidate) === index
  );
}

interface DeniedOption {
  arg: string;
  matched: string;
  risk: OptionRisk;
  value?: string;
}

/** 通用表 + 本 bin 专属表；返回第一个写盘/执行/联网类选项。操作数（路径、模式）由各 bin 自己解释。 */
function findDeniedOption(bin: string, args: readonly string[]): DeniedOption | null {
  const syntax = BIN_DASH_SYNTAX.get(bin) ?? 'unknown';
  const binTable = BIN_OPTION_TABLES.get(bin);
  const tables = binTable ? [GENERIC_OPTION_TABLE, binTable] : [GENERIC_OPTION_TABLE];
  for (let index = 0; index < args.length; index++) {
    const option = parseOption(args[index]);
    if (!option) {
      continue;
    }
    for (const table of tables) {
      const denied = matchOptionTable(table, option, syntax, args[index + 1]);
      if (denied) {
        return denied;
      }
    }
  }
  return null;
}

function matchOptionTable(
  table: OptionTable,
  option: ParsedOption,
  syntax: DashSyntax,
  next: string | undefined
): DeniedOption | null {
  // 双横线 token 一律按长名比较；单横线 token 在 cluster 语法下只逐字母比较（ls -fls 不是 find 的 -fls），
  // 在 long 语法下只按长名比较（tsc -incremental），未知 bin 两种都查。
  const wholeName = option.letters === null || syntax !== 'cluster';
  const clusterLetters = option.letters !== null && syntax !== 'long' ? option.letters : [];
  // 长名候选：完整规范化名（node 的 '_' 与 '-' 互换、jest 的 kebab/camel）与 optionator 的名字段。
  const candidates = wholeName ? optionNameCandidates(option) : [];
  for (const candidate of candidates) {
    const risk =
      table.names.get(candidate) ??
      table.prefixes.find(([prefix]) => candidate.startsWith(prefix))?.[1] ??
      table.abbreviations.find(
        ([full, minLength]) => candidate.length >= minLength && full.startsWith(candidate)
      )?.[2];
    if (risk) {
      return { arg: option.raw, matched: candidate, risk };
    }
  }
  if (wholeName) {
    const risk = [...table.paths].find(
      ([key]) => option.path === key || option.path.startsWith(`${key}.`)
    )?.[1];
    if (risk) {
      return { arg: option.raw, matched: option.path, risk };
    }
  }
  for (const letter of clusterLetters) {
    const risk = table.names.get(letter.toLowerCase());
    if (risk) {
      return { arg: option.raw, matched: `-${letter}`, risk };
    }
  }
  const valueKey = wholeName
    ? candidates.find((candidate) => table.values.has(candidate))
    : clusterLetters.length === 1
      ? clusterLetters[0].toLowerCase()
      : undefined;
  const check = valueKey === undefined ? undefined : table.values.get(valueKey);
  if (valueKey !== undefined && check) {
    if (!option.plain) {
      // reporter/formatter 这类值即模块的选项只接受规整写法。点号子键、'_' 或其它尾随字符会让解析器之间
      // 对“值在哪里”产生分歧（optionator 把 --format/x=json 的 '=json' 丢掉、改取下一个 token），
      // 值的去向无法静态判定，按执行类拒绝。
      return { arg: option.raw, matched: valueKey, risk: 'exec' };
    }
    // 空格写法：只要还有下一个 token 就按值校验，不论它是否以 '-' 开头。optionator 只把“横线 + 字母”
    // 开头的 token 当选项，-/../x.js、--/../x.js、-1/../x.js 都会成为 formatter 值，path.resolve 再把
    // '-/..' 抵消掉（ESLint 9.39.4 实测执行了 x.js）。下一个 token 真是选项时工具本身会报缺值或把它当布尔，
    // 从严拒绝不损失只读能力；没有下一个 token 时工具自己报缺值，这里不替它补判。
    const value = option.inlineValue ?? next;
    const risk = value === undefined ? null : check(value);
    if (risk) {
      return { arg: option.raw, matched: valueKey, risk, value };
    }
  }
  if (clusterLetters.length > 1) {
    const valueLetter = clusterLetters.find((letter) => table.values.has(letter.toLowerCase()));
    if (valueLetter) {
      // 取值的短选项藏在簇里（eslint -qf x）时值的归属依赖解析器细节，保守拒绝。
      return { arg: option.raw, matched: `-${valueLetter}`, risk: 'exec' };
    }
  }
  return null;
}

function deniedOptionBlock(
  context: string,
  denied: DeniedOption
): { safe: false; block: TerminalSafetyBlock } {
  const value = denied.value === undefined ? '' : ` with value ${truncateForReason(denied.value)}`;
  return readonlyBlock(
    OPTION_RISK_RULES[denied.risk],
    `${OPTION_RISK_LABELS[denied.risk]} terminal argument is blocked for ${context}: ` +
      `${describeOptionToken(denied.arg)} (matched option ${denied.matched}${value})`
  );
}

/** 原因只保留选项名部分：'=' 之后的值可能是路径或凭据，不回显（拒绝日志本身不写原因）。 */
function describeOptionToken(arg: string): string {
  const equalsIndex = arg.indexOf('=');
  return truncateForReason(equalsIndex < 0 ? arg : `${arg.slice(0, equalsIndex + 1)}…`);
}

function truncateForReason(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

function checkReadonlySubcommand(bin: string, args: string[]): AllowlistResult {
  switch (bin) {
    case 'git':
      return checkGitSubcommand(args);
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return checkPackageManagerSubcommand(bin, args);
    case 'tsc':
      return checkTscArguments(args);
    case 'node':
      return checkNodeSubcommand(args);
    case 'biome':
      return checkBiomeSubcommand(args);
    case 'vitest':
      return checkVitestSubcommand(args);
    case 'jest':
      return checkJestArguments(args);
    default:
      return { safe: true };
  }
}

function checkTscArguments(args: string[]): AllowlistResult {
  const responseFile = args.find((arg) => arg.startsWith('@'));
  if (responseFile !== undefined) {
    // tsc 把 @file 展开成文件里的参数，--noEmit false、--outDir 之类在静态检查里不可见。
    return readonlyBlock(
      'allowlist-tsc-response-file',
      `tsc response files are blocked in read-only mode: ${truncateForReason(responseFile)}`
    );
  }
  return hasEffectiveNoEmit(args)
    ? { safe: true }
    : readonlyBlock(
        'allowlist-tsc-noemit',
        'tsc must include an effective --noEmit (not followed by false, not consumed as the value of a preceding option)'
      );
}

/**
 * 模拟 tsc 的布尔选项解析：-noEmit / --noemit 与 --noEmit 同义（tsc 选项名大小写不敏感、单双横线等价），
 * 后跟 true/false 时会消费该值，最后一次出现生效。紧跟在可能取值的选项之后的 --noEmit 会被那个选项吞成值，
 * 不计入；'=' 内联写法 tsc 不支持，保守视为未生效。
 */
function hasEffectiveNoEmit(args: string[]): boolean {
  let noEmit = false;
  for (let index = 0; index < args.length; index++) {
    const option = parseOption(args[index]);
    if (!option || option.path !== 'noemit') {
      continue;
    }
    if (option.inlineValue !== undefined) {
      return false;
    }
    const previous = index > 0 ? parseOption(args[index - 1]) : null;
    if (previous && previous.inlineValue === undefined && !TSC_FLAG_OPTIONS.has(previous.name)) {
      continue;
    }
    const next = args[index + 1];
    noEmit = next !== 'false';
    if (next === 'true' || next === 'false') {
      index++;
    }
  }
  return noEmit;
}

function checkGitSubcommand(args: string[]) {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand && READONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return { safe: true } as const;
  }
  return readonlyBlock(
    'allowlist-git-subcommand',
    `git ${subcommand ?? '[missing]'} is not a read-only evidence subcommand`
  );
}

/*
 * 【L4-P7d 保留待恢复】EVOLUTION_CODE_EXECUTION_ENABLED 关闭期间 npm/pnpm/yarn 在进入这里之前就被拒绝；
 * 本函数与 checkRunnerPassthrough 保留给开关恢复后使用。恢复前必须先修审计确认的（中）绕过：
 * 'npm run typecheck -- test/a.test.ts' 的位置参数按测试文件规则放行，但 typecheck/build:check（以及
 * lint）脚本里的 tsc 收到文件参数就忽略 tsconfig（含 noEmit）并写出 JS——非 test 脚本应拒绝位置参数透传。
 */
function checkPackageManagerSubcommand(bin: string, args: string[]): AllowlistResult {
  const first = args[0]?.toLowerCase();
  let scriptArgsStart = 1;
  if (first === 'run') {
    const script = args[1]?.toLowerCase();
    if (
      !script ||
      !(
        READONLY_PACKAGE_SCRIPTS.has(script) ||
        script.startsWith('test:') ||
        (script.startsWith('lint:') && !script.includes('fix'))
      )
    ) {
      return readonlyBlock(
        'allowlist-package-manager-script',
        `${bin} run ${script ?? '[missing]'} is not an allowed read-only script`
      );
    }
    scriptArgsStart = 2;
  } else if (first !== 'test') {
    return readonlyBlock(
      'allowlist-package-manager-subcommand',
      `${bin} ${first ?? '[missing]'} is not a read-only test/lint/build command`
    );
  }

  const separator = args.indexOf('--', scriptArgsStart);
  const ownEnd = separator < 0 ? args.length : separator;
  for (let index = scriptArgsStart; index < ownEnd; index++) {
    const arg = args[index];
    if (arg.startsWith('-')) {
      const ownOptionBlock = checkPackageManagerOwnOption(bin, arg);
      if (ownOptionBlock) {
        return ownOptionBlock;
      }
      continue;
    }
    // '--' 之前的位置参数同样会被追加给脚本（npm/pnpm/yarn 都如此），与 '--' 之后一样按测试文件规则判定。
    const violation = describeTestPathViolation(arg);
    if (violation) {
      return testPathBlock(`${bin} script`, arg, violation);
    }
  }
  return separator < 0 ? { safe: true } : checkRunnerPassthrough(bin, args.slice(separator + 1));
}

function checkPackageManagerOwnOption(
  bin: string,
  arg: string
): { safe: false; block: TerminalSafetyBlock } | null {
  const option = parseOption(arg);
  if (option && option.path === option.name) {
    if (PACKAGE_MANAGER_LONG_OPTIONS.has(option.name)) {
      return null;
    }
    // nopt 会把单横线 token 拆成短选项簇（-sw = -s -w <value>），所以每个字母都必须在白名单内。
    if (
      option.letters !== null &&
      option.inlineValue === undefined &&
      option.letters.length > 0 &&
      option.letters.every((letter) => PACKAGE_MANAGER_SHORT_OPTIONS.has(letter))
    ) {
      return null;
    }
  }
  return readonlyBlock(
    'allowlist-package-manager-option',
    `${bin} option before "--" is not in the read-only allowlist (--silent, -s, --if-present): ${describeOptionToken(arg)}`
  );
}

/**
 * 包管理器 '--' 之后交给脚本的参数。脚本内容不可见，运行器可能是 vitest、jest、node --test，
 * 也可能是 lint/typecheck 脚本里的 eslint/tsc/biome：拒绝表取它们的并集给出具体规则，
 * 再用运行器无关白名单兜底；位置参数在 node --test / mocha 这类运行器下就是被执行的文件，按测试文件规则判定。
 */
function checkRunnerPassthrough(bin: string, args: string[]): AllowlistResult {
  const context = `${bin} script arguments`;
  // 透传参数里再出现的 '--' 结束运行器自身的选项解析：vitest(mri)、jest(yargs)、node --test 都把其后的
  // token 当位置参数，node --test 会把 '-t'、'--help' 这类名字当测试文件执行，所以其后一律按测试文件规则判定。
  let positionalOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--' && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !arg.startsWith('-')) {
      const violation = describeTestPathViolation(arg);
      if (violation) {
        return testPathBlock(context, arg, violation);
      }
      continue;
    }
    const option = parseOption(arg);
    const denied =
      option && matchOptionTable(PASSTHROUGH_OPTION_TABLE, option, 'unknown', args[index + 1]);
    if (denied) {
      return deniedOptionBlock(context, denied);
    }
    const allowed =
      option &&
      lookupAllowedOption(PASSTHROUGH_ALLOWED_OPTIONS, PASSTHROUGH_SHORT_OPTIONS, option, false);
    if (!option || !allowed) {
      return readonlyBlock(
        'allowlist-runner-option',
        `${context} option is not in the read-only test-runner allowlist: ${describeOptionToken(arg)}`
      );
    }
    const next = args[index + 1];
    if (
      option.inlineValue !== undefined ||
      allowed.value === 'none' ||
      next === undefined ||
      next.startsWith('-')
    ) {
      continue;
    }
    if (allowed.value === 'pattern') {
      // free-form 值用空格写法时，无法区分它是选项值还是会被某个运行器当作文件执行的位置参数。
      return readonlyBlock(
        'allowlist-runner-option-value',
        `${context} option ${option.raw} must pass its value inline (${option.raw}=<value>)`
      );
    }
    if (allowed.value === 'number' && !PASSTHROUGH_NUMBER_VALUE.test(next)) {
      // 不是数字就不当作值消费，下一轮按位置参数（测试文件规则）判定。
      continue;
    }
    // 数字值与已由拒绝表校验过的枚举值（reporter/environment/test-reporter）。
    index++;
  }
  return { safe: true };
}

/** 白名单查找；单横线 token 的每个字母都必须在短选项白名单内（数字视为附带的数值）。 */
function lookupAllowedOption(
  allowed: ReadonlyMap<string, AllowedOption>,
  shorts: ReadonlySet<string>,
  option: ParsedOption,
  allowClusters: boolean
): AllowedOption | null {
  if (option.letters !== null) {
    const letters = option.letters.filter((letter) => !/\d/.test(letter));
    if (letters.length === 0 || (!allowClusters && letters.length !== 1)) {
      return null;
    }
    if (!letters.every((letter) => shorts.has(letter))) {
      return null;
    }
    // yargs/mri 只让簇里最后一个字母消费后续 token。
    return allowed.get(letters[letters.length - 1]) ?? { value: 'none' };
  }
  const entry = allowed.get(option.name);
  if (!entry) {
    return null;
  }
  if (option.path !== option.name) {
    const subkey = option.path.slice(option.name.length + 1).split('.')[0];
    if (!entry.subkeys?.has(subkey)) {
      return null;
    }
  }
  return entry;
}

function checkVitestSubcommand(args: string[]): AllowlistResult {
  let runFlag = false;
  for (const arg of args) {
    if (arg === '--' || !arg.startsWith('-')) {
      // vitest 的位置参数是文件名过滤器，只会选中 include 匹配的测试文件。
      continue;
    }
    const option = parseOption(arg);
    if (
      !option ||
      !lookupAllowedOption(VITEST_ALLOWED_OPTIONS, VITEST_SHORT_OPTIONS, option, true)
    ) {
      return readonlyBlock(
        'allowlist-vitest-option',
        `vitest option is not in the read-only allowlist: ${describeOptionToken(arg)}`
      );
    }
    runFlag ||= option.letters === null && option.path === 'run';
  }
  if (args.length === 0) {
    return { safe: true };
  }
  const first = args[0].toLowerCase();
  const positionals = args.filter((arg) => !arg.startsWith('-')).map((arg) => arg.toLowerCase());
  // 首个 token 是 run 时其后的 init/list 只是过滤器；否则任何非运行子命令名都可能被 cac 当作命令。
  const nonRun =
    first === 'run' ? undefined : positionals.find((arg) => VITEST_NON_RUN_SUBCOMMANDS.has(arg));
  if (nonRun) {
    return readonlyBlock('allowlist-vitest-run', `vitest ${nonRun} is not a read-only test run`);
  }
  if (first === 'related' && !runFlag) {
    return readonlyBlock('allowlist-vitest-run', 'vitest related must use --run');
  }
  return first === 'run' || runFlag || positionals.includes('run')
    ? { safe: true }
    : readonlyBlock('allowlist-vitest-run', 'vitest must use run mode');
}

function checkJestArguments(args: string[]): AllowlistResult {
  for (const arg of args) {
    if (arg === '--' || !arg.startsWith('-')) {
      // jest 的位置参数是测试路径正则，只在 testMatch 选中的测试文件里过滤。
      continue;
    }
    const option = parseOption(arg);
    if (!option || !lookupAllowedOption(JEST_ALLOWED_OPTIONS, JEST_SHORT_OPTIONS, option, true)) {
      return readonlyBlock(
        'allowlist-jest-option',
        `jest option is not in the read-only allowlist: ${describeOptionToken(arg)}`
      );
    }
  }
  return { safe: true };
}

/*
 * 【L4-P7d 保留待恢复】EVOLUTION_CODE_EXECUTION_ENABLED 关闭期间 node 在进入这里之前就被拒绝；本函数保留给
 * 开关恢复后使用。恢复前必须先修审计确认的（高）绕过：需值选项的空格写法把紧随的 token 当作值，但宿主
 * /bin/sh 先做路径名展开——'node --test --test-name-pattern scripts/* test/a.test.mjs' 里未加引号的
 * scripts/* 展开成多个词，第一个成为 pattern 值，其余成为 --test 的位置参数被执行。空格写法的值里出现
 * 未加引号的 glob 字符时应拒绝（或要求这些选项用 '=' 内联取值）。
 */
function checkNodeSubcommand(args: string[]): AllowlistResult {
  // Node 24 实测：进入 --test 模式后，出现在测试路径之后、甚至 '--' 之后的 node 选项（如 --require）
  // 仍然生效，所以白名单必须覆盖 argv 里每一个以 '-' 开头的 token，而不只是前导选项段。
  // 反过来，--test 本身必须出现在第一个位置参数之前：否则 node 把该位置参数当脚本直接执行，
  // --test 只是脚本收到的 argv（'node scripts/x.mjs --test'）。
  let sawTest = false;
  let sawPositional = false;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      sawPositional = true;
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      // '--' 结束 node 自身的选项解析，其后的 --test 会被当成脚本路径。
      sawPositional = true;
      continue;
    }
    // 名字经 parseOption 规范化：node 接受 '_' 与 '-' 互换（--test_only 等价于 --test-only）；
    // 大小写与驼峰归一只影响本检查的分类，node 自身对 --TEST 这类拼写会直接报 bad option，不会放大能力。
    const option = parseOption(arg);
    if (!option || option.name === '' || option.path !== option.name) {
      return readonlyBlock(
        'allowlist-node-option',
        `node option is not in the read-only --test allowlist: ${describeOptionToken(arg)}`
      );
    }
    const name = option.name;
    if (NODE_EVAL_OPTIONS.has(name)) {
      return readonlyBlock('allowlist-node-eval', 'node eval/print modes are blocked');
    }
    if (NODE_PRELOAD_OPTIONS.has(name)) {
      return readonlyBlock(
        'allowlist-node-preload',
        `node preload/import option is blocked in read-only mode: ${describeOptionToken(arg)}`
      );
    }
    if (NODE_TEST_FLAG_OPTIONS.has(name)) {
      if (option.inlineValue !== undefined) {
        return readonlyBlock(
          'allowlist-node-option',
          `node option ${describeOptionToken(arg)} does not take a value`
        );
      }
      if (name === 'test') {
        if (sawPositional) {
          return readonlyBlock(
            'allowlist-node-test',
            'node --test must precede the first script or test path'
          );
        }
        sawTest = true;
      }
      continue;
    }
    if (NODE_TEST_VALUE_OPTIONS.has(name)) {
      let value = option.inlineValue;
      if (value === undefined) {
        // 空格写法：值必须是紧随其后、且不以 '-' 开头的 token，避免把下一个选项当成值吞掉。
        const next = args[index + 1];
        if (next === undefined || next.startsWith('-')) {
          return readonlyBlock(
            'allowlist-node-option-value',
            `node option ${arg} requires a value`
          );
        }
        value = next;
        index++;
      }
      const valueBlock = checkNodeTestOptionValue(name, arg, value);
      if (valueBlock) {
        return valueBlock;
      }
      continue;
    }
    return readonlyBlock(
      'allowlist-node-option',
      `node option is not in the read-only --test allowlist: ${describeOptionToken(arg)}`
    );
  }
  if (!sawTest) {
    return readonlyBlock('allowlist-node-test', 'node is only allowed with --test');
  }
  // --test 模式下位置参数就是被执行的文件（node --test scripts/release.mjs 会运行该脚本顶层代码），
  // 与已拦截的 node scripts/release.mjs --test 是同一向量：只允许测试文件。
  for (const positional of positionals) {
    const violation = describeTestPathViolation(positional);
    if (violation) {
      return testPathBlock('node --test', positional, violation);
    }
  }
  return { safe: true };
}

/** 白名单内需要值的 node --test 选项，值本身也要是只读形态。 */
function checkNodeTestOptionValue(
  name: string,
  arg: string,
  value: string
): { safe: false; block: TerminalSafetyBlock } | null {
  const label = describeOptionToken(arg);
  if (name === 'testreporter') {
    // 非内置名会被 node 当成模块说明符加载执行；比较保持大小写敏感，与 node 的解析一致。
    return NODE_TEST_BUILTIN_REPORTERS.has(value)
      ? null
      : readonlyBlock(
          'allowlist-node-option-value',
          `node --test-reporter only accepts built-in reporters (${[
            ...NODE_TEST_BUILTIN_REPORTERS,
          ].join(', ')}): ${truncateForReason(value)}`
        );
  }
  if (name === 'testconcurrency' || name === 'testtimeout') {
    return /^\d+(?:\.\d+)?$/.test(value)
      ? null
      : readonlyBlock(
          'allowlist-node-option-value',
          `node option ${label} requires a non-negative number: ${truncateForReason(value)}`
        );
  }
  // --test-name-pattern / --test-skip-pattern 是进程内正则，只影响选测，不涉及写文件或加载模块。
  return value.length > 0
    ? null
    : readonlyBlock(
        'allowlist-node-option-value',
        `node option ${label} requires a non-empty value`
      );
}

/**
 * 测试文件位置参数：文件名含 .test. / .spec.，或位于 test/、tests/、__tests__/ 目录（含目录本身）。
 * 只做字面判定，不访问文件系统：拒绝绝对路径/家目录、'..' 段，以及 node glob 中能把字面 .test. 变成
 * 可选的花括号、extglob、字符类与转义；* 与 ? 不能删除字面字符，保留，但以 '.' 开头的段里的 * / ?
 * 能匹配 '.' 与 '..'，与字面 '..' 同样拒绝。
 */
function describeTestPathViolation(value: string): string | null {
  if (TEST_PATH_GLOB_ALTERNATION.test(value)) {
    return 'glob alternation, extglob, character classes and escapes are not allowed';
  }
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) {
    return 'absolute or home-relative paths are not allowed';
  }
  const rawSegments = value.split('/');
  // 宿主 sh（未加引号时）与 node 自身的 glob（加引号时）都可能展开这一段；不推断它会匹配什么，
  // 也不区分是否加了引号，只要能展开成 '.' / '..' 就按父目录段拒绝。
  if (rawSegments.some((segment) => TEST_PATH_DOT_GLOB_SEGMENT.test(segment))) {
    return 'dot-prefixed glob segments (.?, .*) can expand to "." or ".." and are not allowed';
  }
  const segments = rawSegments.filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    return 'parent-directory segments are not allowed';
  }
  const last = segments[segments.length - 1];
  if (last === undefined) {
    return 'not a test file';
  }
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment.toLowerCase()))) {
    return null;
  }
  if (segments.length === 1 && TEST_DIRECTORY_SEGMENTS.has(last.toLowerCase())) {
    return null;
  }
  if (TEST_FILE_NAME.test(last)) {
    return null;
  }
  return 'only *.test.* / *.spec.* files or paths under test/, tests/, __tests__/ are allowed';
}

function testPathBlock(
  context: string,
  arg: string,
  violation: string
): { safe: false; block: TerminalSafetyBlock } {
  return readonlyBlock(
    'allowlist-test-path',
    `${context} positional argument must be a test file: ${truncateForReason(arg)} (${violation})`
  );
}

function checkBiomeSubcommand(args: string[]) {
  const command = args.find((arg) => !arg.startsWith('-'))?.toLowerCase();
  if (command && READONLY_BIOME_COMMANDS.has(command)) {
    return { safe: true } as const;
  }
  return readonlyBlock(
    'allowlist-biome-command',
    `biome ${command ?? '[missing]'} is not an allowed read-only command`
  );
}

function readonlyBlock(rule: string, reason: string): { safe: false; block: TerminalSafetyBlock } {
  return { safe: false, block: { rule, reason } };
}

/**
 * 拒绝日志只记规则 id、脱敏后的 bin 与参数的类别/长度：reason 里可能带模型给出的路径、测试文件名、
 * tsc 响应文件、git 子命令名或模块值（可能是绝对路径或像凭据的字符串），只回给模型，不进日志。
 */
function logAllowlistBlock(
  command: string,
  bins: readonly string[],
  evaluation: AllowlistEvaluation
): void {
  if (evaluation.result.safe) {
    return;
  }
  const { rule } = evaluation.result.block;
  // 日志失败不能改变放行/拒绝结论，也不能把观察失败升级为业务失败。
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[terminalSafety] read-only allowlist blocked command: rule=${rule} bin=${logBinLabel(evaluation.bin, bins)} ${describeArgsForLog(evaluation.args)} chars=${command.length}`
      ),
    () => undefined
  );
}

/** evaluateTerminalCommandAllowlist 自己产生的 bin 占位；模型写的 '[x]' 这类词不在此列。 */
const LOG_BIN_PLACEHOLDERS = new Set(['[unparsed]', '[empty]', '[path-qualified]']);

/**
 * 日志里的 bin：只有调用方 allowlist 里的名字与已知的代码执行类 bin 原样记录，'[unparsed]' 这类占位保留；
 * 其余（模型写在命令位置的任意词，可能是路径或像凭据的字符串）记为 '[unlisted]'。
 */
function logBinLabel(bin: string, bins: readonly string[]): string {
  if (LOG_BIN_PLACEHOLDERS.has(bin) || CODE_EXECUTING_BINS.has(bin)) {
    return bin;
  }
  return bins.some((item) => item.toLowerCase() === bin) ? bin : '[unlisted]';
}

/** 参数只记数量与类别（选项/位置参数），不记内容；命令未能切分时只记占位。 */
function describeArgsForLog(args: readonly string[] | undefined): string {
  if (args === undefined) {
    return 'args=[unparsed]';
  }
  const options = args.filter((arg) => arg.startsWith('-') && arg !== '-').length;
  return `args=${args.length} options=${options} positionals=${args.length - options}`;
}
