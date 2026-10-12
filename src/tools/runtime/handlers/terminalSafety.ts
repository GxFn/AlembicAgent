/**
 * terminal.exec 的两道静态检查：
 *
 * 1. checkTerminalCommandSafety —— 危险命令黑名单。它是启发式纵深防御，不是写边界：
 *    真正限制写入范围的是宿主注入的 sandbox profile（project-write 沙箱）；rm -r、find -delete、
 *    git clean 等删除按设计不归这里拦截。检查只看命令的静态 literal：命令位置（含已知执行 wrapper、
 *    引导命令的保留字、shell 命令串、find -exec 动作、命令替换体）上的 DENIED_BINS、eval 与 rm 递归强删。
 *    变量/参数展开、别名、脚本文件内容、node -e/python -c/awk system() 这类解释器内代码、
 *    不在 EXEC_WRAPPERS 里的 wrapper 都不求值，属于已知盲区。
 *    命令替换的输出决定执行身份、wrapper 结构、rm 选项、shell 命令串或 find 表达式时静态无法判定，
 *    一律 fail-closed；shell（及 source/.）从 stdin 或运行时描述符读程序（管道、进程替换、/dev/stdin）
 *    而不是 here-string 时同样 fail-closed。词法上无法可靠切分的结构（任意层级的 heredoc '<<'/'<<-'、
 *    未闭合的替换、替换内的 case/注释、带嵌套引号或替换的 ${...}）同样 fail-closed。续行（反斜杠+换行）
 *    在切词前删除，'$\<换行>(' 与 '<\<换行><' 分别按 '$(' 与 '<<' 处理；'2>x cmd' 的 2 是描述符不是命令；
 *    '&>' 在 POSIX sh 里是 '&' 加 '>'，两种读法都检查。词首 '#' 注释是否生效取决于 shell，
 *    出现时“注释到行尾”与“'#' 是字面量”两种读法都检查，任一读法命中或无法切分即拦截。
 * 2. checkTerminalCommandAllowlist —— 只读能力（Evolution）的 bin 白名单与写类参数/子命令约束。
 */
import path from 'node:path';
import Logger from '@alembic/core/logging';

export const DENIED_BINS = new Set([
  'sudo',
  'su',
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
// 只读 allowlist 的写类参数黑名单。比较前先小写，并按 writeLikeOptionName 取选项名：
// 带 '=' 的写法取 '=' 之前的部分（--output=x、--generatetrace=x 都命中同一条目）；
// cac（vitest）/ yargs（jest）的点号写法再取 '.' 之前的部分，所以 --outputFile.json=x、
// --outputFile.json x 与 --outputFile=x 一样命中 '--outputfile'，不会因为子键写法绕过。
// 这里只放不会与其它只读 bin 的同名只读参数冲突的条目；会冲突的短参数放在 BIN_WRITE_LIKE_ARGS。
const WRITE_LIKE_ARGS = new Set([
  '--fix',
  '--write',
  '-i',
  '--in-place',
  '-u',
  '--update',
  '--updatesnapshot',
  '--update-snapshot',
  // find：-delete/-exec*/-ok* 执行或删除，-fprint*/-fls 把结果写进文件。
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
  '--pre',
  '--output',
  '--ext-diff',
  '--textconv',
  // eslint：-o/--output-file 写报告，--cache* 写 .eslintcache，--init 生成配置并安装依赖。
  '--output-file',
  '--cache',
  '--cache-location',
  '--cache-file',
  '--init',
  // jest/vitest：--outputFile（含 vitest 多 reporter 的 --outputFile.<reporter>=path 点号写法）写结果，
  // --cacheDirectory 写缓存目录，--clearCache 删除缓存。
  '--outputfile',
  '--cachedirectory',
  '--clearcache',
  // tsc：--init 写 tsconfig，-b/--build 与 --incremental/--tsBuildInfoFile 即使带 --noEmit 也写 tsbuildinfo，
  // --generateTrace/--generateCpuProfile 写诊断文件。
  '--build',
  '--incremental',
  '--tsbuildinfofile',
  '--generatetrace',
  '--generatecpuprofile',
  // biome 1.x：--apply/--apply-unsafe 等价于写回修复。
  '--apply',
  '--apply-unsafe',
]);
// 按选项名前缀匹配的写类参数族：jest 的 --coverage、--coverageDirectory、--coverageReporters 等
// 都会把覆盖率报告写进项目目录；--coverage=false 之类的显式关闭写法也一并拒绝（默认即不开覆盖率）。
// vitest 的 --coverage.enabled 等点号写法经 writeLikeOptionName 归一为 '--coverage' 后同样命中。
const WRITE_LIKE_ARG_PREFIXES = ['--coverage'];
// 只对特定 bin 生效的写类短参数：eslint -o 是输出文件，tsc -b 是 build 模式。
// rg/grep -o（only-matching）与 jest -o/-b（onlyChanged/bail）是只读参数，不能被共享黑名单误伤。
const BIN_WRITE_LIKE_ARGS = new Map<string, ReadonlySet<string>>([
  ['eslint', new Set(['-o'])],
  ['tsc', new Set(['-b'])],
]);
// node 在只读 allowlist 中只允许 test runner 模式，并且选项采用白名单：
// - 标志选项：--test、--test-only
// - 需要值的只读选项：--test-name-pattern / --test-skip-pattern（进程内正则）、
//   --test-concurrency / --test-timeout（数字）、--test-reporter（仅内置 reporter 名）
// 其余 node 选项一律拒绝；其中 eval/print 与预加载类单独归类，便于诊断定位。
const NODE_TEST_FLAG_OPTIONS = new Set(['--test', '--test-only']);
const NODE_TEST_VALUE_OPTIONS = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-concurrency',
  '--test-timeout',
  '--test-reporter',
]);
// 自定义 reporter 是模块路径或包名，node 会加载并执行它；只放行 Node 内置 reporter 名。
const NODE_TEST_BUILTIN_REPORTERS = new Set(['tap', 'spec', 'dot', 'junit', 'lcov']);
const NODE_EVAL_OPTIONS = new Set(['-e', '-p', '--eval', '--print']);
// 预加载/导入类选项会在任何测试文件之前执行模型自写（data: URL）或仓库内的任意模块。
const NODE_PRELOAD_OPTIONS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--env-file-if-exists',
]);

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
 * 正则预检只保留 token 化无法表达的模式：
 * - rm 合并旗标（rm -rf）出现在任意位置，包括解释器代码与引号内（awk/perl/python 里的 system 调用）；
 * - curl/wget 输出经管道交给 shell；
 * - fork bomb 函数定义。
 * sudo/su/dd 等 DENIED_BINS 与 eval 只在命令位置才有执行身份，交给 token 级检查：
 * 'rg -n sudo src'、'git log --grep su'、'ls dd' 这类取证命令不应被当成提权或破坏命令。
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
  // 这里只检查静态 literal 形态，不求值变量/别名/脚本。实际隔离仍由宿主 sandbox 提供。
  // 仅命令位置及已知 wrapper 链有执行身份；cat ./docs/sudo 等普通参数不是可执行文件。
  for (const tokens of readings.flatMap((reading) => reading.commands)) {
    for (const { words, hereStrings } of commandWordReadings(tokens)) {
      const verdict = inspectCommandWords(words, depth, hereStrings);
      if (!verdict.safe) {
        return verdict;
      }
    }
  }
  return { safe: true };
}

/**
 * 一条命令 token 序列的全部词表读法。bash/zsh 把 '&>' 读成 stdout+stderr 重定向；POSIX sh（dash 等）
 * 把它读成后台运算符 '&' 加 '>'，'ls &>/dev/null sudo reboot' 在那里以重定向开头另起一条命令
 * sudo reboot。两种读法都检查：第一种是整条命令，第二种是每个 '&>' 目标之后的剩余 token。
 */
function commandWordReadings(
  tokens: ShellWord[]
): Array<{ words: ShellWord[]; hereStrings: ShellWord[] }> {
  const readings = [collectCommandWords(tokens)];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].redirection && tokens[index].value.startsWith('&')) {
      logSafetyDecision(
        "'&>' found; also inspecting the POSIX reading where '&' ends the command and the rest starts a new one"
      );
      readings.push(collectCommandWords(tokens.slice(index + 2)));
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
    return [literal];
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
  return [literal, commented];
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
    // find/xargs 的 {} 占位只替换成文件名或输入项，命令串的静态部分照常检查。
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
        return { kind: 'command-string' };
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
      for (let position = 0; position < letters.length; position++) {
        const letter = letters[position];
        if (letter === 'c' && value.startsWith('-')) {
          return { kind: 'command-string' };
        }
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
  for (let index = 0; index < args.length; index++) {
    if (!FIND_EXEC_ACTIONS.has(args[index].value)) {
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
    const nested = inspectNestedCommandWords(
      markExecPlaceholders(segment, ['{}']),
      depth,
      hereStrings
    );
    if (!nested.safe) {
      return nested;
    }
    index = end;
  }
  return { safe: true };
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

/**
 * 命令名规范化：取 basename（/usr/bin/sudo）、小写（macOS 默认大小写不敏感的文件系统上 RM 就是 rm）、
 * 折叠 GNU g 前缀别名，mkfs.ext4 等 mkfs.<fstype> 变体归为 mkfs。
 */
function normalizeBinName(raw: string): string {
  const base = path.basename(raw).toLowerCase();
  const alias = GNU_PREFIXED_ALIASES.get(base);
  if (alias) {
    return alias;
  }
  return base.startsWith('mkfs.') ? 'mkfs' : base;
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
    // env -S 拆出的参数从 env 自身的选项解析继续（GNU env 会重新扫描拆分后的参数表）。
    const rewritten = parsed.rewrites.map((rest) => [word, ...rest]);
    return collectUnwrapCandidates(input, parsed.starts, parsed.replaceTokens, rewritten, depth);
  }
  return { candidates: [input.slice(index)] };
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

function dynamicCommandBlock(word: ShellWord): TerminalSafetyBlock {
  return {
    rule: 'shell-dynamic-command',
    reason:
      word.dynamic === 'exec-placeholder'
        ? 'Command position is filled by a find/xargs placeholder at run time and cannot be inspected statically'
        : 'Command name or wrapper argument produced by command substitution cannot be inspected statically',
  };
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
    // 没有目标命令（如单独的 'timeout 5'）：wrapper 自身报错或不执行任何程序。
    return { kind: 'continue', next: [] };
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
      // 缺值：wrapper 报错退出，不执行任何程序。
      return { kind: 'continue', next: [] };
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

export function checkTerminalCommandAllowlist(
  command: string,
  bins: readonly string[]
): { safe: true } | { safe: false; block: TerminalSafetyBlock } {
  if (containsShellMeta(command)) {
    return {
      safe: false,
      block: {
        rule: 'allowlist-shell-meta',
        reason: 'Shell meta characters are blocked for read-only terminal.exec allowlists',
      },
    };
  }

  const words = parseSimpleShellWords(command);
  if (!words.ok) {
    return {
      safe: false,
      block: {
        rule: 'allowlist-unparseable-command',
        reason: words.error,
      },
    };
  }

  const [rawBin, ...args] = words.words;
  if (rawBin !== undefined && /[\\/]/.test(rawBin)) {
    // 只允许裸命令名经 PATH 解析。被分析仓库自带的 scripts/git、bin/cat 之类同名脚本
    // （或先前被写入的文件）会顶替系统命令，绕过 git/node 等子命令的只读约束；
    // node_modules/.bin/<tool> 也一并拒绝，等价入口是 npm run <script> 或裸 <tool>。
    return {
      safe: false,
      block: {
        rule: 'allowlist-path-qualified-bin',
        reason: `Path-qualified executable is blocked for read-only terminal allowlists: ${rawBin}`,
      },
    };
  }
  const bin = (rawBin ?? '').toLowerCase();
  const allowedBins = new Set(bins.map((item) => item.toLowerCase()));
  if (!bin || !allowedBins.has(bin)) {
    return {
      safe: false,
      block: {
        rule: 'allowlist-denied-bin',
        reason: `Command "${bin || '[empty]'}" is not in the read-only terminal allowlist`,
      },
    };
  }

  const writeLikeArg = findWriteLikeArg(bin, args);
  if (writeLikeArg) {
    // 原因里带上归一后的选项名：点号/内联值写法（--outputFile.json=x）与条目（--outputfile）
    // 字面不同，审计日志要能看出是哪条黑名单规则把它折叠过去的。
    const matched =
      writeLikeArg.option === writeLikeArg.arg.toLowerCase()
        ? ''
        : ` (matched option ${writeLikeArg.option})`;
    return {
      safe: false,
      block: {
        rule: 'allowlist-write-like-arg',
        reason: `Write-like terminal argument is blocked: ${writeLikeArg.arg}${matched}`,
      },
    };
  }

  return checkReadonlySubcommand(bin, args);
}

export function containsShellMeta(value: string): boolean {
  // 换行可启动第二条命令；变量展开可拼出被禁止的选项，均不能当普通参数放行。
  return /[\r\n;&|<>`$]/.test(value);
}

/** 词法器给每个词的静态视图。 */
interface ShellWord {
  /** 去引号、解转义后的静态文本；命令替换的位置以 SUBSTITUTION_MARK 占位。 */
  value: string;
  /**
   * 运行时才确定的部分：'command-substitution' 是反引号或 $(...) 的输出；
   * 'exec-placeholder' 是 find -exec / xargs -I 运行时替换成文件名或输入项的占位串。
   */
  dynamic?: 'command-substitution' | 'exec-placeholder';
  /** 重定向运算符；其后一个词是重定向目标而不是命令参数。 */
  redirection?: true;
}

type ShellLexResult =
  | {
      ok: true;
      words: string[];
      commands: ShellWord[][];
      substitutions: string[];
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
    return { ok: true, words: [], commands: [], substitutions: [], sawCommentStart: false };
  }

  const words: string[] = [];
  const commands: ShellWord[][] = [[]];
  const substitutions: string[] = [];
  let current = '';
  let hasWord = false;
  let substituted = false;
  let sawCommentStart = false;
  let quote: '"' | "'" | null = null;
  const flushWord = () => {
    if (hasWord) {
      words.push(current);
      commands[commands.length - 1].push(
        substituted ? { value: current, dynamic: 'command-substitution' } : { value: current }
      );
      current = '';
      hasWord = false;
      substituted = false;
    }
  };
  const fail = (error: string): ShellLexResult => ({ ok: false, error });

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
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
        // 参数展开不求值（静态 literal 边界），去掉续行后原样保留在词里。
        current += `$${input.slice(nextIndex, end + 1)}`;
        hasWord = true;
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
      } else {
        flushWord();
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
      flushWord();
      words.push(char);
      commands.push([]);
      continue;
    }
    if (/\s/.test(char)) {
      flushWord();
      continue;
    }
    current += char;
    hasWord = true;
  }

  if (quote) {
    return fail(UNPARSEABLE_LITERALS);
  }
  flushWord();
  return { ok: true, words, commands, substitutions, sawCommentStart };
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

/**
 * 返回第一个写类参数；匹配结果同时带回归一后的选项名，便于在拒绝原因里看出
 * '=' 内联值与 '.' 点号子键是如何被折叠到黑名单条目上的。
 */
function findWriteLikeArg(bin: string, args: string[]): { arg: string; option: string } | null {
  const binSpecific = BIN_WRITE_LIKE_ARGS.get(bin);
  for (const arg of args) {
    const normalized = arg.toLowerCase();
    if (!normalized.startsWith('-')) {
      // 黑名单条目都是选项；操作数（路径、模式）由各 bin 自己解释，不在这里判定。
      continue;
    }
    const option = writeLikeOptionName(normalized);
    if (WRITE_LIKE_ARGS.has(option) || binSpecific?.has(option)) {
      return { arg, option };
    }
    if (WRITE_LIKE_ARG_PREFIXES.some((prefix) => option.startsWith(prefix))) {
      return { arg, option };
    }
  }
  return null;
}

/**
 * 从已小写的参数里取选项名：先去掉 '=' 之后的内联值，再去掉 '.' 之后的点号子键。
 * cac（vitest 4 实测 --outputFile.tap=./tap.txt）与 yargs（jest）都把 --opt.key 解析成 --opt 的子字段，
 * 对写类选项来说目标文件/目录仍由同一个选项决定，所以按首段判定；--sequence.shuffle、--typecheck.only
 * 这类只读选项的首段不在黑名单里，不会被误伤。先切 '=' 再切 '.'，避免把值里的路径点号当成子键。
 */
function writeLikeOptionName(normalized: string): string {
  const equalsIndex = normalized.indexOf('=');
  const withoutValue = equalsIndex < 0 ? normalized : normalized.slice(0, equalsIndex);
  const dotIndex = withoutValue.indexOf('.');
  return dotIndex < 0 ? withoutValue : withoutValue.slice(0, dotIndex);
}

function checkReadonlySubcommand(
  bin: string,
  args: string[]
): { safe: true } | { safe: false; block: TerminalSafetyBlock } {
  switch (bin) {
    case 'git':
      return checkGitSubcommand(args);
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return checkPackageManagerSubcommand(bin, args);
    case 'tsc':
      return hasEffectiveNoEmit(args)
        ? { safe: true }
        : readonlyBlock('allowlist-tsc-noemit', 'tsc must include --noEmit');
    case 'node':
      return checkNodeSubcommand(args);
    case 'biome':
      return checkBiomeSubcommand(args);
    case 'vitest':
      return args.length === 0 || args.includes('run') || args.includes('--run')
        ? { safe: true }
        : readonlyBlock('allowlist-vitest-run', 'vitest must use run mode');
    default:
      return { safe: true };
  }
}

function hasEffectiveNoEmit(args: string[]): boolean {
  let noEmit = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--noEmit') {
      noEmit = args[index + 1] !== 'false';
      if (args[index + 1] === 'true' || args[index + 1] === 'false') {
        index++;
      }
    } else if (args[index].startsWith('--noEmit=')) {
      return false;
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

function checkPackageManagerSubcommand(bin: string, args: string[]) {
  const first = args[0]?.toLowerCase();
  if (first === 'test') {
    return { safe: true } as const;
  }
  if (first !== 'run') {
    return readonlyBlock(
      'allowlist-package-manager-subcommand',
      `${bin} ${first ?? '[missing]'} is not a read-only test/lint/build command`
    );
  }

  const script = args[1]?.toLowerCase();
  if (
    script &&
    (READONLY_PACKAGE_SCRIPTS.has(script) ||
      script.startsWith('test:') ||
      (script.startsWith('lint:') && !script.includes('fix')))
  ) {
    return { safe: true } as const;
  }
  return readonlyBlock(
    'allowlist-package-manager-script',
    `${bin} run ${script ?? '[missing]'} is not an allowed read-only script`
  );
}

function checkNodeSubcommand(args: string[]) {
  // Node 24 实测：进入 --test 模式后，出现在测试路径之后、甚至 '--' 之后的 node 选项（如 --require）
  // 仍然生效，所以白名单必须覆盖 argv 里每一个以 '-' 开头的 token，而不只是前导选项段。
  // 反过来，--test 本身必须出现在第一个位置参数之前：否则 node 把该位置参数当脚本直接执行，
  // --test 只是脚本收到的 argv（'node scripts/x.mjs --test'）。
  let sawTest = false;
  let sawPositional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      sawPositional = true;
      continue;
    }
    if (arg === '--') {
      // '--' 结束 node 自身的选项解析，其后的 --test 会被当成脚本路径。
      sawPositional = true;
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    const inlineValue = equalsIndex < 0 ? undefined : arg.slice(equalsIndex + 1);
    // Node 接受下划线与连字符互换的拼写（--test_only 等价于 --test-only），归一后再比对白名单。
    // 大小写归一只影响本检查的分类；node 自身对 --TEST 这类拼写会直接报 bad option，不会放大能力。
    const option = (equalsIndex < 0 ? arg : arg.slice(0, equalsIndex))
      .toLowerCase()
      .replace(/_/g, '-');
    if (NODE_EVAL_OPTIONS.has(option)) {
      return readonlyBlock('allowlist-node-eval', 'node eval/print modes are blocked');
    }
    if (NODE_PRELOAD_OPTIONS.has(option)) {
      return readonlyBlock(
        'allowlist-node-preload',
        `node preload/import option is blocked in read-only mode: ${option}`
      );
    }
    if (NODE_TEST_FLAG_OPTIONS.has(option)) {
      if (inlineValue !== undefined) {
        return readonlyBlock(
          'allowlist-node-option',
          `node option ${option} does not take a value`
        );
      }
      if (option === '--test') {
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
    if (NODE_TEST_VALUE_OPTIONS.has(option)) {
      let value = inlineValue;
      if (value === undefined) {
        // 空格写法：值必须是紧随其后、且不以 '-' 开头的 token，避免把下一个选项当成值吞掉。
        const next = args[index + 1];
        if (next === undefined || next.startsWith('-')) {
          return readonlyBlock(
            'allowlist-node-option-value',
            `node option ${option} requires a value`
          );
        }
        value = next;
        index++;
      }
      const valueBlock = checkNodeTestOptionValue(option, value);
      if (valueBlock) {
        return valueBlock;
      }
      continue;
    }
    return readonlyBlock(
      'allowlist-node-option',
      `node option is not in the read-only --test allowlist: ${arg}`
    );
  }
  if (!sawTest) {
    return readonlyBlock('allowlist-node-test', 'node is only allowed with --test');
  }
  return { safe: true } as const;
}

/** 白名单内需要值的 node --test 选项，值本身也要是只读形态。 */
function checkNodeTestOptionValue(
  option: string,
  value: string
): { safe: false; block: TerminalSafetyBlock } | null {
  if (option === '--test-reporter') {
    // 非内置名会被 node 当成模块说明符加载执行；比较保持大小写敏感，与 node 的解析一致。
    return NODE_TEST_BUILTIN_REPORTERS.has(value)
      ? null
      : readonlyBlock(
          'allowlist-node-option-value',
          `node --test-reporter only accepts built-in reporters (${[
            ...NODE_TEST_BUILTIN_REPORTERS,
          ].join(', ')}): ${value}`
        );
  }
  if (option === '--test-concurrency' || option === '--test-timeout') {
    return /^\d+(?:\.\d+)?$/.test(value)
      ? null
      : readonlyBlock(
          'allowlist-node-option-value',
          `node option ${option} requires a non-negative number: ${value}`
        );
  }
  // --test-name-pattern / --test-skip-pattern 是进程内正则，只影响选测，不涉及写文件或加载模块。
  return value.length > 0
    ? null
    : readonlyBlock(
        'allowlist-node-option-value',
        `node option ${option} requires a non-empty value`
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
