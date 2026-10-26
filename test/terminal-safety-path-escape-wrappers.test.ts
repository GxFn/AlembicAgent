/**
 * W-SEC1（L4-P08 后续，2026-10-23 总控判定）：terminal.exec 危险命令黑名单 (a) 兜底认路径写法与反斜杠转义，
 * 以及提权程序名族。
 *
 * 审计确认：文件头承诺“不在 EXEC_WRAPPERS 里的 wrapper 不求值，其中字面出现的 DENIED_BINS/eval 由 (a) 兜底”，
 * 但 (a) 的词边界正则只认名字前是行首、空白、; | & ( ) 或反引号（可带一个引号），'/usr/bin/sudo'、'\sudo'、
 * 's\udo' 都不命中，未知 wrapper 承载时生产路径放行；不加 wrapper 的 'sudo-rs'、'sudo.ws' 也放行。
 * 本文件锁住：
 * 1. 审计列出的全部形态，以及 30 种 wrapper × 10 个目标 × 多种写法的组合一律拦截；
 * 2. 拼写模糊（大小写、引号、转义位置、续行、ANSI-C 引号、名字族变体）一律拦截；
 * 3. 只读查看与取证写法（含路径写法与转义写法的取证参数）仍然放行；
 * 4. 新增拦截分支的诊断只含规范化名字与写法种类，不含命令原文；
 * 5. 接近 MAX_TERMINAL_COMMAND_LENGTH 的命令检查成本仍与长度成线性；
 * 6. 提权名字族只认显式清单里的提权程序（W-SEC1r1）：'npm run su-check' 这类脚本名、目标名放行，清单内程序的
 *    各种写法照旧拦截。
 */
import Logger from '@alembic/core/logging';
import { describe, expect, it, vi } from 'vitest';
import { checkTerminalCommandSafety } from '../src/tools/runtime/handlers/terminalSafety.js';

const DENIED = 'shell-denied-bin';
const PRIV = 'shell-privilege-escalation';
const DESTRUCTIVE = 'shell-destructive-bin';
const EVAL = 'shell-eval';
/** 黑名单对被禁程序的四种拒绝规则：(b) 的命令位置判定与 (a) 的兜底判定。 */
const DENIAL_RULES = new Set([DENIED, PRIV, DESTRUCTIVE, EVAL]);

function blockedRule(command: string): string | null {
  const result = checkTerminalCommandSafety(command);
  return result.safe ? null : result.block.rule;
}

describe('terminal.exec blacklist: path, escape and unknown-wrapper spellings of denied bins (W-SEC1)', () => {
  it.each([
    // 审计（第八轮第四批，W2a-07 范围外线索）列出的放行形态。
    { command: 'caffeinate /usr/bin/sudo -i', rule: PRIV },
    { command: 'caffeinate \\sudo -i', rule: PRIV },
    { command: 'arch -arm64 /usr/bin/sudo -i', rule: PRIV },
    { command: 'flock /tmp/l /bin/dd if=/dev/zero of=/dev/disk2', rule: DESTRUCTIVE },
    { command: 'caffeinate /sbin/shutdown -h now', rule: DESTRUCTIVE },
    { command: 'strace /sbin/reboot', rule: DESTRUCTIVE },
    // doas 本身属于提权程序名族，(b) 在命令位置先命中。
    { command: 'doas /usr/bin/passwd', rule: DENIED },
    { command: 'unshare /sbin/mkfs.ext4 /dev/sda1', rule: DESTRUCTIVE },
    { command: 'caffeinate /usr/bin/killall Finder', rule: DESTRUCTIVE },
    { command: 'sudo-rs whoami', rule: DENIED },
    { command: 'sudo.ws whoami', rule: DENIED },
  ])('blocks the audited form $command with $rule', ({ command, rule }) => {
    expect(blockedRule(command), command).toBe(rule);
  });

  // 30 种 wrapper：多数不在 EXEC_WRAPPERS 里（(b) 不解包，只能靠 (a) 兜底），少数已知 wrapper 与提权 wrapper
  // 一并列出，锁住 (b) 在已知 wrapper 之下同样识别这些写法。
  const WRAPPERS: ReadonlyArray<(target: string) => string> = [
    (target) => `caffeinate ${target}`,
    (target) => `caffeinate -i ${target}`,
    (target) => `arch -arm64 ${target}`,
    (target) => `flock /tmp/l ${target}`,
    (target) => `strace ${target}`,
    (target) => `strace -f -o /dev/null ${target}`,
    (target) => `ltrace ${target}`,
    (target) => `chroot / ${target}`,
    (target) => `doas ${target}`,
    (target) => `pkexec ${target}`,
    (target) => `unshare -r ${target}`,
    (target) => `setsid ${target}`,
    (target) => `stdbuf -o0 ${target}`,
    (target) => `taskset 1 ${target}`,
    (target) => `taskset -c 0 ${target}`,
    (target) => `ionice -c3 ${target}`,
    (target) => `chrt -o 0 ${target}`,
    (target) => `numactl --interleave=all ${target}`,
    (target) => `firejail --quiet ${target}`,
    (target) => `runuser -u root -- ${target}`,
    (target) => `su -c '${target}'`,
    (target) => `script -q /dev/null ${target}`,
    (target) => `watch -n 1 ${target}`,
    (target) => `systemd-run --user ${target}`,
    (target) => `setarch x86_64 ${target}`,
    (target) => `prlimit --nofile=1024 ${target}`,
    (target) => `valgrind -q ${target}`,
    (target) => `nsenter -t 1 -m -- ${target}`,
    (target) => `timeout 5 ${target}`,
    (target) => `nice -n 5 ${target}`,
  ];

  // 10 个目标：W-SEC1 之前 DENIED_BINS 的全部成员（mkfs 取 mkfs.<fstype> 变体）与带参数的 eval；本包新增的
  // doas、pkexec、run0 与名字族变体在下方拼写用例里覆盖。
  const TARGETS: ReadonlyArray<{ name: string; dir: string; args: string }> = [
    { name: 'sudo', dir: '/usr/bin', args: '-i' },
    { name: 'su', dir: '/usr/bin', args: '-' },
    { name: 'dd', dir: '/bin', args: 'if=/dev/zero of=/dev/disk2' },
    { name: 'shutdown', dir: '/sbin', args: '-h now' },
    { name: 'reboot', dir: '/sbin', args: '-f' },
    { name: 'halt', dir: '/sbin', args: '-p' },
    { name: 'passwd', dir: '/usr/bin', args: 'root' },
    { name: 'killall', dir: '/usr/bin', args: 'Finder' },
    { name: 'mkfs.ext4', dir: '/sbin', args: '/dev/sda1' },
    { name: 'eval', dir: '/usr/bin', args: 'ls' },
  ];

  // 写法：绝对路径、相对路径、前导/词中反斜杠、路径里的反斜杠、引号包裹与词中引号。全部是 shell 去引号后
  // 等于目标名（或其路径）的写法。
  const SPELLINGS: ReadonlyArray<readonly [string, (name: string, dir: string) => string]> = [
    ['absolute path', (name, dir) => `${dir}/${name}`],
    ['relative path', (name) => `../../usr/local/bin/${name}`],
    ['leading backslash', (name) => `\\${name}`],
    ['inner backslash', (name) => `${name[0]}\\${name.slice(1)}`],
    ['escaped path', (name, dir) => `${dir}/\\${name}`],
    ['quoted path', (name, dir) => `"${dir}/${name}"`],
    ['inner quotes', (name) => `${name[0]}''${name.slice(1)}`],
  ];

  it.each(
    WRAPPERS.map((wrap) => ({ wrapper: wrap('<target>'), wrap }))
  )('blocks every denied target spelling wrapped by $wrapper', ({ wrap }) => {
    const missed: string[] = [];
    for (const target of TARGETS) {
      for (const [, spell] of SPELLINGS) {
        const command = wrap(`${spell(target.name, target.dir)} ${target.args}`);
        const rule = blockedRule(command);
        if (rule === null || !DENIAL_RULES.has(rule)) {
          missed.push(`${command} => ${rule ?? 'safe'}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });

  it.each([
    // 大小写：macOS 默认大小写不敏感的文件系统上 /USR/BIN/SUDO 就是 sudo。
    { command: 'caffeinate /USR/BIN/SUDO -i', rule: PRIV },
    { command: 'caffeinate \\SUDO -i', rule: PRIV },
    { command: 'caffeinate /usr/bin/SuDo -i', rule: PRIV },
    { command: 'caffeinate /SBIN/MKFS.EXT4 /dev/sda1', rule: DESTRUCTIVE },
    // 引号位置。
    { command: "caffeinate '/usr/bin/'sudo -i", rule: PRIV },
    { command: 'caffeinate /usr/bin/"su"do -i', rule: PRIV },
    { command: 'caffeinate s""udo -i', rule: PRIV },
    { command: 'caffeinate "s"udo -i', rule: PRIV },
    { command: 'caffeinate su""do -i', rule: PRIV },
    { command: 'caffeinate $"sudo" -i', rule: PRIV },
    { command: 'caffeinate "/sbin/"\'reboot\'', rule: DESTRUCTIVE },
    // 转义位置：词首、词中、词尾、逐字转义、路径分隔符转义、路径内转义。
    { command: 'caffeinate su\\do -i', rule: PRIV },
    { command: 'caffeinate sud\\o -i', rule: PRIV },
    { command: 'caffeinate \\s\\u\\d\\o -i', rule: PRIV },
    { command: 'caffeinate \\/usr\\/bin\\/sudo -i', rule: PRIV },
    { command: 'caffeinate /usr/bin\\/sudo -i', rule: PRIV },
    { command: 'caffeinate /sbin/re\\boot', rule: DESTRUCTIVE },
    { command: 'caffeinate \\dd if=/dev/zero of=/dev/disk2', rule: DESTRUCTIVE },
    { command: 'caffeinate \\eval ls', rule: EVAL },
    { command: 'caffeinate e\\val ls', rule: EVAL },
    { command: 'caffeinate /usr/bin/eval ls', rule: EVAL },
    // 续行（反斜杠+换行在切词前删除）。
    { command: 'caffeinate su\\\ndo -i', rule: PRIV },
    { command: 'caffeinate /usr/bin/\\\nsudo -i', rule: PRIV },
    // ANSI-C 引号：十六进制、八进制、\u 与整串。
    { command: "caffeinate $'\\x73udo' -i", rule: PRIV },
    { command: "caffeinate $'\\163udo' -i", rule: PRIV },
    { command: "caffeinate $'\\u0073udo' -i", rule: PRIV },
    { command: "caffeinate $'/usr/bin/sudo' -i", rule: PRIV },
    { command: "caffeinate $'su\\x64o -i'", rule: PRIV },
    // 引号里的反斜杠：shell 直接执行时是另一个程序名，但经 ssh、su -c 这类再切词的宿主转交时就是 sudo。
    { command: "ssh host '\\sudo reboot'", rule: PRIV },
    { command: 'ssh host "/usr/bin/sudo reboot"', rule: PRIV },
    { command: 'caffeinate "\\sudo" -i', rule: PRIV },
    // 名字族：提权程序的实现后缀与同类程序，命令位置由 (b) 拦截，未知 wrapper 之下由 (a) 拦截。
    { command: 'sudo-rs -i', rule: DENIED },
    { command: 'SUDO.WS whoami', rule: DENIED },
    { command: '/usr/lib/cargo/bin/sudo-rs -i', rule: DENIED },
    { command: 'su-rs -', rule: DENIED },
    { command: 'su-exec nobody id', rule: DENIED },
    { command: 'sudoedit /etc/hosts', rule: DENIED },
    { command: 'doas whoami', rule: DENIED },
    { command: 'pkexec whoami', rule: DENIED },
    { command: '/usr/bin/pkexec whoami', rule: DENIED },
    { command: 'run0 whoami', rule: DENIED },
    { command: 'timeout 5 sudo-rs whoami', rule: DENIED },
    { command: 'nice -n 5 /usr/lib/cargo/bin/sudo.ws -i', rule: DENIED },
    { command: 'env SUDO-RS whoami', rule: DENIED },
    { command: 'echo `sudo-rs reboot`', rule: DENIED },
    { command: "bash -c 'sudo.ws -i'", rule: DENIED },
    { command: 'caffeinate sudo-rs -i', rule: PRIV },
    { command: 'caffeinate /usr/bin/sudo.ws -i', rule: PRIV },
    { command: 'caffeinate doas -s', rule: PRIV },
    { command: 'caffeinate \\pkexec id', rule: PRIV },
    { command: 'caffeinate run0 id', rule: PRIV },
    { command: 'caffeinate su-exec nobody id', rule: PRIV },
    // 路径写法出现在非取证命令的参数、wrapper 选项值、赋值前缀与重定向目标里，同样无法确认是数据。
    { command: 'rg --pre=/usr/bin/sudo pattern src', rule: PRIV },
    { command: 'X=/usr/bin/sudo caffeinate', rule: PRIV },
    { command: 'timeout -s /usr/bin/sudo 5 ls', rule: PRIV },
    { command: "git commit -m 'drop /usr/bin/sudo usage'", rule: PRIV },
  ])('blocks the spelling variant $command with $rule', ({ command, rule }) => {
    expect(blockedRule(command), command).toBe(rule);
  });

  it.each([
    // W-SEC1 返工：被反斜杠转义的 shell 分隔符（\; \| \& \> \< \( 与 '\ '）不切块，外层 shell 去掉转义后
    // 'id;sudo'、'sudo reboot' 原样成为 sh -c 的脚本或 ssh 在远端执行的命令串，分隔符重新生效。HEAD 的词边界
    // 正则只看名字前一个字符（'\;sudo' 里 ';' 算边界）能拦住前 12 条，切块还原后整块按一个名字比较就漏掉了；
    // 还原值必须再按空白与运算符切片。
    { command: 'caffeinate sh -c id\\;sudo -i', rule: PRIV },
    { command: 'arch -arm64 sh -c id\\;sudo', rule: PRIV },
    { command: 'flock /tmp/l sh -c true\\;reboot', rule: DESTRUCTIVE },
    { command: 'caffeinate sh -c id\\|\\|reboot', rule: DESTRUCTIVE },
    { command: 'caffeinate sh -c true\\>x\\;sudo -i', rule: PRIV },
    { command: 'caffeinate sh -c :\\;halt', rule: DESTRUCTIVE },
    { command: 'caffeinate sh -c :\\;passwd', rule: DESTRUCTIVE },
    { command: 'unshare -r sh -c :\\;mkfs.ext4 /dev/sda1', rule: DESTRUCTIVE },
    {
      command: 'caffeinate bash -c true\\&\\&dd if=/dev/zero of=/dev/disk2',
      rule: DESTRUCTIVE,
    },
    { command: 'ssh host id\\;sudo -i', rule: PRIV },
    { command: 'ssh host sudo\\ reboot', rule: PRIV },
    { command: 'ssh host x\\ \\&\\&\\ reboot', rule: DESTRUCTIVE },
    // HEAD 同样放行的形态：名字后紧跟被转义的空白或分隔符（HEAD 的正则要求名字后是未转义的边界）。
    { command: 'caffeinate sh -c sudo\\ -i', rule: PRIV },
    { command: 'ssh host sudo\\;reboot', rule: PRIV },
    { command: 'caffeinate sh -c sudo\\\t-i', rule: PRIV },
    { command: 'caffeinate sh -c /usr/bin/sudo\\ -i', rule: PRIV },
    { command: 'caffeinate sh -c id\\;/usr/bin/s\\\\udo\\ -i', rule: PRIV },
    // 其余被转义的运算符：反引号、括号、输入重定向。
    { command: 'caffeinate sh -c id\\`sudo\\`', rule: PRIV },
    { command: 'caffeinate sh -c \\(sudo -i\\)', rule: PRIV },
    { command: 'caffeinate sh -c cat\\<x\\;reboot', rule: DESTRUCTIVE },
    // 引号里的转义分隔符（宽松还原，覆盖 ssh 这类再切词的宿主）。
    { command: 'ssh host "id\\;sudo -i"', rule: PRIV },
    // ANSI-C 引号解码出的分隔符与换行。
    { command: "caffeinate sh -c $'id\\x3bsudo -i'", rule: PRIV },
    { command: "caffeinate sh -c $'true\\nreboot'", rule: DESTRUCTIVE },
    // eval：还原值里 eval 后面跟着参数，或 eval 在块尾而原始文本里块之后跟着参数（与 HEAD 口径一致）。
    { command: 'caffeinate sh -c id\\;eval\\ ls', rule: EVAL },
    { command: 'caffeinate sh -c id\\;eval ls', rule: EVAL },
    { command: 'caffeinate sh -c id\\;eval\\  ls', rule: EVAL },
    // 同一块里多个名字：第一个命中决定拒绝规则。
    { command: 'caffeinate sh -c id\\;reboot\\;sudo', rule: DESTRUCTIVE },
  ])('blocks the denied bin joined by an escaped separator in $command', ({ command, rule }) => {
    expect(blockedRule(command), command).toBe(rule);
  });

  it.each([
    // 转义分隔符出现在取证命令的参数里、或还原值里的 eval 后面没有参数时照常放行。
    'rg -n "sudo\\|reboot" src',
    'grep -E sudo\\|reboot README.md',
    'echo id\\;sudo',
    'echo sudo\\ reboot',
    "find . -name '*.sh' -exec grep -l sudo {} \\;",
    'git log --grep=sudo\\|su',
    'ls My\\ Docs/sudo',
    'echo x\\;eval',
    'echo x\\;eval\\;y',
    'caffeinate sh -c x\\;eval',
    'npm run eval\\;',
  ])('still allows the escaped-separator evidence form %s', (command) => {
    expect(checkTerminalCommandSafety(command), command).toEqual({ safe: true });
  });

  it.each([
    // 任务列出的误伤控制：只读查看与取证。
    'ls -l /usr/bin/sudo',
    'which sudo',
    'file /bin/dd',
    'cat /etc/sudoers',
    'grep -n sudo README.md',
    'rg "\\bsudo\\b" src',
    'rg "\\\\bsudo\\\\b" src',
    'man shutdown',
    'git log -S sudo',
    'echo "use sudo"',
    'ls # sudo',
    'git log --oneline # check sudo usage',
    // man 的常见只读写法：章节号、关键字检索、打印路径。
    'man 8 shutdown',
    'man -k sudo',
    'man -w reboot',
    'man -a passwd',
    // 路径写法与转义写法出现在取证命令的参数里。
    'ls -l /sbin/shutdown /sbin/reboot /sbin/halt',
    'stat /usr/bin/sudo',
    'file /usr/bin/sudo-rs /usr/bin/sudo.ws',
    'cat ./docs/sudo',
    'head -n 5 /etc/sudoers.d/README',
    'which sudo-rs doas pkexec run0',
    'type /usr/bin/sudo',
    'command -v /usr/bin/sudo',
    'rg -n "/usr/bin/sudo" src',
    'rg -n "sudo-rs|sudo.ws|doas|pkexec" docs',
    'grep -rn \\\\sudo src',
    'grep -rn "\\sudo" src',
    'git log -S /usr/bin/sudo',
    'git show HEAD:docs/sudo',
    'git diff -- ./docs/mkfs',
    'echo /usr/bin/sudo',
    'echo \\sudo',
    "printf '%s\\n' /sbin/reboot",
    'find / -name sudo -type f',
    "find /usr/bin -name 'sudo*' -perm -4000",
    'timeout 10 rg -n /usr/bin/sudo src',
    'env FIXTURE=1 cat ./docs/sudo',
    'rg -n /usr/bin/sudo src | head -n 5',
    // 路径工具、存在性测试、体积与校验和：只读取路径或文件内容、从不执行参数。路径写法起算 (a) 命中后，它们在 HEAD
    // 上本是放行的，W-SEC1 把它们并入只读取证命令，避免只读查看被新增的路径命中误拦。
    'readlink -f /usr/bin/sudo',
    'realpath /sbin/reboot',
    'basename /usr/bin/sudo',
    'dirname /usr/lib/cargo/bin/sudo-rs',
    'test -x /usr/bin/sudo',
    '[ -x /usr/bin/sudo ]',
    'if [ -x /usr/bin/sudo ]; then echo yes; fi',
    'du -h /usr/bin/sudo',
    'shasum -a 256 /usr/bin/sudo',
    'md5 /bin/dd',
    'md5sum /bin/dd',
    'sha256sum /sbin/shutdown',
    'cksum /sbin/reboot',
    'strings /usr/bin/sudo | head -n 20',
    'cmp /usr/bin/sudo /tmp/sudo-copy',
    // 文件名不是程序名：文档/源码扩展名、更长的单词、路径片段。
    'ls docs/sudo.md',
    'wc -l docs/sudo-rs.md',
    'sed -n 1,20p docs/sudo.md',
    'npm test -- test/sudo.test.ts',
    'npm run lint:su-check',
    'ls ./dd.txt',
    'rg -n sudoers src',
    'cat /etc/sudoers',
    'ls /usr/share/man/man8/sudo.8.gz',
    // eval 只在其后带参数时才算命中。
    'npm run eval',
    'ls scripts/eval',
  ])('still allows the read-only evidence form %s', (command) => {
    expect(checkTerminalCommandSafety(command), command).toEqual({ safe: true });
  });

  it.each([
    // man 的执行/写盘类选项与路径操作数不算取证：macOS 的 man 脚本把 -P 分页器、-C 配置与页面路径交给 eval，
    // man-db 的 -P/-H/-X 运行外部程序。命中词出现在这些形态里时照常拦截。
    'man -P /usr/bin/sudo ls',
    'man -P sudo ls',
    'man --pager=/usr/bin/sudo ls',
    'man --pager sudo ls',
    'man --pa sudo ls',
    'man -C /tmp/sudo ls',
    'man -M /tmp/x sudo',
    'man -H sudo ls',
    'man ./docs/sudo',
    "man '$(sudo reboot)'",
    // man 作为管道消费者时不算惰性程序：man-db 会把 xargs 追加的运行时选项当成 -P 分页器。
    "echo '-P sudo' | xargs man ls",
  ])('does not treat man as evidence in the executing form %s', (command) => {
    const rule = blockedRule(command);
    expect(rule, command).not.toBeNull();
  });

  it.each([
    // 新并入的只读程序只让“参数里的命中词”放行，不改变执行位置的判定：它们自己被未知 wrapper 承载、或命中词
    // 出现在命令位置与命令替换里时照常拦截。
    { command: 'caffeinate readlink /usr/bin/sudo', rule: PRIV },
    { command: '[ -x /usr/bin/sudo ] && /usr/bin/sudo -i', rule: DENIED },
    { command: 'test -x /sbin/reboot && \\reboot', rule: DENIED },
    { command: 'basename "$(/usr/bin/sudo -n true)"', rule: DENIED },
    { command: 'echo /usr/bin/sudo | xargs -I{} caffeinate {} -i', rule: PRIV },
  ])('keeps blocking $command although the read-only programs are evidence', ({
    command,
    rule,
  }) => {
    expect(blockedRule(command), command).toBe(rule);
  });

  it('logs the normalized name and spelling kind of new blocks without the command text', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    try {
      const commands = [
        'caffeinate /usr/bin/sudo -i',
        'caffeinate \\sudo -i',
        "caffeinate $'\\x73udo' -i",
        'caffeinate su\\\ndo -i',
        'sudo-rs whoami',
        'nice -n 5 /usr/lib/cargo/bin/sudo.ws -i',
        'ls -l /usr/bin/sudo',
      ];
      for (const command of commands) {
        checkTerminalCommandSafety(command);
      }
      const messages = debug.mock.calls.map((call) => String(call[0]));
      expect(messages).toContainEqual(
        expect.stringMatching(
          /denied-name fallback matched sudo \(path-qualified\) but .*failing closed/
        )
      );
      expect(messages).toContainEqual(
        expect.stringMatching(/denied-name fallback matched sudo \(backslash-escaped\) but/)
      );
      expect(messages).toContainEqual(
        expect.stringMatching(/denied-name fallback matched sudo \(ansi-c-quoted\) but/)
      );
      expect(messages).toContainEqual(
        expect.stringMatching(/denied-name fallback matched sudo \(line-continuation\) but/)
      );
      expect(messages).toContainEqual(
        expect.stringContaining(
          'command-position denied bin sudo recognized from a name-family-variant spelling'
        )
      );
      expect(messages).toContainEqual(
        expect.stringContaining(
          'command-position denied bin sudo recognized from a path-qualified+name-family-variant spelling'
        )
      );
      expect(messages).toContainEqual(
        expect.stringMatching(
          /denied-name fallback matched sudo \(path-qualified\); token analysis confirmed/
        )
      );
      // 诊断只含规范化名字与写法种类：不含命令原文、原始路径、转义写法或族变体原名。
      for (const message of messages) {
        for (const command of commands) {
          expect(message).not.toContain(command);
        }
        expect(message).not.toContain('/usr/bin/sudo');
        expect(message).not.toContain('\\sudo');
        expect(message).not.toContain('sudo-rs');
        expect(message).not.toContain('sudo.ws');
        expect(message).not.toContain('x73');
      }
    } finally {
      debug.mockRestore();
    }
  });

  it('logs the escaped-separator spelling kind without the command text', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    try {
      const commands = [
        'caffeinate sh -c id\\;sudo -i',
        'ssh host sudo\\ reboot',
        "caffeinate sh -c $'id\\x3bsudo -i'",
        'echo id\\;reboot',
      ];
      for (const command of commands) {
        checkTerminalCommandSafety(command);
      }
      const messages = debug.mock.calls.map((call) => String(call[0]));
      expect(messages).toContainEqual(
        expect.stringMatching(
          /denied-name fallback matched sudo \(backslash-escaped\+escaped-separator\) but .*failing closed/
        )
      );
      expect(messages).toContainEqual(
        expect.stringMatching(
          /denied-name fallback matched sudo \(ansi-c-quoted\+escaped-separator\) but/
        )
      );
      expect(messages).toContainEqual(
        expect.stringMatching(
          /denied-name fallback matched reboot \(backslash-escaped\+escaped-separator\); token analysis confirmed/
        )
      );
      for (const message of messages) {
        for (const command of commands) {
          expect(message).not.toContain(command);
        }
        expect(message).not.toContain('id;sudo');
        expect(message).not.toContain('\\;');
        expect(message).not.toContain('x3b');
      }
    } finally {
      debug.mockRestore();
    }
  });

  it('keeps inspection linear for escaped-separator chunks near the length limit', () => {
    const limit = 32_768;
    const fill = (unit: string, prefix: string, suffix = '') =>
      `${prefix}${unit.repeat(Math.floor((limit - prefix.length - suffix.length - 1) / unit.length))}${suffix}`;
    const cases: Array<{ command: string; safe: boolean }> = [
      // 一个超长块里反复出现被转义分隔符连起来的名字：同一块的同名命中只记一次。
      { command: fill('id\\;sudo\\;reboot\\;', 'echo '), safe: true },
      { command: fill('sudo\\ ', 'rg -n ', 'src'), safe: true },
      // 还原值里大量不带参数的 eval：每段空白至多扫描一次。
      { command: fill('eval\\;', 'echo '), safe: true },
      { command: fill('eval\\ \\ \\ \\;', 'caffeinate sh -c '), safe: true },
      // 未知 wrapper 之下第一个命中就拒绝。
      { command: fill('id\\;sudo\\;', 'caffeinate sh -c '), safe: false },
      { command: fill('x\\ ', 'ssh host ', 'reboot'), safe: false },
    ];
    for (const { command, safe } of cases) {
      expect(command.length).toBeLessThanOrEqual(limit);
      const started = performance.now();
      const result = checkTerminalCommandSafety(command);
      const elapsed = performance.now() - started;
      expect(result.safe, command.slice(0, 40)).toBe(safe);
      expect(elapsed, command.slice(0, 40)).toBeLessThan(1_000);
    }
  });

  it('keeps inspection linear for path and escape spellings near the length limit', () => {
    const limit = 32_768;
    const fill = (unit: string, prefix: string, suffix = '') =>
      `${prefix}${unit.repeat(Math.floor((limit - prefix.length - suffix.length - 1) / unit.length))}${suffix}`;
    const cases: Array<{ command: string; safe: boolean }> = [
      // 每个词都命中 (a)，逐个按 token 归属确认为取证参数后放行。
      { command: fill('/usr/bin/sudo ', 'rg -n ', 'src'), safe: true },
      { command: fill('\\s\\u\\d\\o ', 'rg -n ', 'src'), safe: true },
      { command: fill("$'\\x73udo' ", 'echo '), safe: true },
      { command: fill('eval x ', 'echo '), safe: true },
      // 一个超长的转义块（反斜杠连接的空格不切块）。
      { command: fill('a\\ ', 'echo ', 'a'), safe: true },
      // 未知 wrapper 之下第一个命中就拒绝。
      { command: fill('/usr/bin/sudo ', 'caffeinate '), safe: false },
      { command: fill('x ', 'caffeinate ', '\\sudo'), safe: false },
    ];
    for (const { command, safe } of cases) {
      expect(command.length).toBeLessThanOrEqual(limit);
      const started = performance.now();
      const result = checkTerminalCommandSafety(command);
      const elapsed = performance.now() - started;
      expect(result.safe, command.slice(0, 40)).toBe(safe);
      expect(elapsed, command.slice(0, 40)).toBeLessThan(1_000);
    }
  });

  it('scales inspection cost linearly with the number of path-spelled hits', () => {
    const timeOf = (units: number) => {
      const command = `rg -n ${'/usr/bin/s\\udo eval x '.repeat(units)}src`;
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 5; attempt++) {
        const started = performance.now();
        expect(checkTerminalCommandSafety(command)).toEqual({ safe: true });
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    timeOf(150);
    const small = timeOf(300);
    const large = timeOf(1_200);
    // 线性时 4 倍输入约 4 倍耗时，二次方约 16 倍；留出噪声余量，只拦截明显的超线性增长。
    expect(large).toBeLessThan(Math.max(small * 10, 40));
  });
});

describe('terminal.exec blacklist: privilege family is an explicit list of known programs (W-SEC1r1)', () => {
  /*
   * W-SEC1r1（2026-10-26 总控判定）：fb8686c 的名字族规则把“根名 + 任意 '-'/'.' 字母数字后缀”都归入提权族，
   * 'npm run su-check' 这类脚本名、目标名由放行变成拦截。提权名字族收窄为显式清单，只认确有其物的提权程序；
   * 清单内程序的大小写、路径、转义、引号写法照旧识别，其余口径（转义空白连起来的被禁名、man 只读查询）不变。
   */
  it.each([
    'npm run su-check',
    'npm run sudo-lint',
    'make su-test',
    'pnpm su-x',
    'yarn sudo.check',
    'npm run doas-config',
    'make pkexec-policy',
    'npm run run0-test',
    'make sudoedit-docs',
    'npm run su-rs-bench',
    'caffeinate npm run su-check',
    'npx turbo run sudo-lint --filter web',
  ])('allows the script or target name %s that merely starts like a privilege program', (command) => {
    expect(checkTerminalCommandSafety(command), command).toEqual({ safe: true });
  });

  // 清单内的全部提权程序：命令位置由 (b) 拦截（shell-denied-bin），未知 wrapper 之下由 (a) 拦截
  // （shell-privilege-escalation）。
  const KNOWN_PRIVILEGE_PROGRAMS = [
    'sudo',
    'sudoedit',
    'sudo-rs',
    'sudoedit-rs',
    'sudo.ws',
    'su',
    'su-rs',
    'su-exec',
    'doas',
    'pkexec',
    'run0',
  ] as const;

  const PROGRAM_SPELLINGS: ReadonlyArray<readonly [string, (name: string) => string]> = [
    ['plain', (name) => name],
    ['upper case', (name) => name.toUpperCase()],
    ['absolute path', (name) => `/usr/bin/${name}`],
    ['cargo path', (name) => `/usr/lib/cargo/bin/${name}`],
    ['leading backslash', (name) => `\\${name}`],
    ['inner backslash', (name) => `${name[0]}\\${name.slice(1)}`],
    ['quoted', (name) => `"${name}"`],
    ['inner quotes', (name) => `${name[0]}''${name.slice(1)}`],
  ];

  it.each(
    KNOWN_PRIVILEGE_PROGRAMS
  )('keeps blocking every spelling of the known program %s', (name) => {
    const missed: string[] = [];
    for (const [kind, spell] of PROGRAM_SPELLINGS) {
      const spelled = spell(name);
      const cases: Array<readonly [string, string]> = [
        [`${spelled} whoami`, DENIED],
        [`timeout 5 ${spelled} whoami`, DENIED],
        [`caffeinate ${spelled} whoami`, PRIV],
        [`flock /tmp/l ${spelled} whoami`, PRIV],
      ];
      for (const [command, rule] of cases) {
        const actual = blockedRule(command);
        if (actual !== rule) {
          missed.push(`${kind}: ${command} => ${actual ?? 'safe'} (expected ${rule})`);
        }
      }
    }
    expect(missed).toEqual([]);
  });

  it.each([
    // 审计列出的绕过写法与 fb8686c 的名字族用例：收窄后全部照旧拦截。
    { command: 'caffeinate /usr/bin/sudo -i', rule: PRIV },
    { command: 'caffeinate \\sudo -i', rule: PRIV },
    { command: 'arch -arm64 /usr/bin/sudo -i', rule: PRIV },
    { command: 'flock /tmp/l /bin/dd if=/dev/zero of=/dev/disk2', rule: DESTRUCTIVE },
    { command: 'strace /sbin/reboot', rule: DESTRUCTIVE },
    { command: 'doas /usr/bin/passwd', rule: DENIED },
    { command: 'unshare /sbin/mkfs.ext4 /dev/sda1', rule: DESTRUCTIVE },
    { command: 'sudo-rs whoami', rule: DENIED },
    { command: 'sudo.ws whoami', rule: DENIED },
    { command: 'doas whoami', rule: DENIED },
    { command: 'SUDO.WS whoami', rule: DENIED },
    { command: 'su-exec nobody id', rule: DENIED },
    { command: 'caffeinate su-exec nobody id', rule: PRIV },
    // 清单内程序的转义、ANSI-C 与转义分隔符写法。
    { command: 'caffeinate sudo\\.ws -i', rule: PRIV },
    { command: 'caffeinate su-ex\\ec nobody id', rule: PRIV },
    { command: "caffeinate 'sudo'-rs -i", rule: PRIV },
    { command: "caffeinate $'\\x73udo-rs' -i", rule: PRIV },
    { command: 'caffeinate sh -c id\\;sudo-rs\\ -i', rule: PRIV },
    { command: 'ssh host sudoedit-rs\\ /etc/hosts', rule: PRIV },
    // fb8686c 的转义空白口径不变：转义空白连起来的被禁名在非取证命令的参数里照常拦截。
    { command: 'npm test -- my\\ su\\ test', rule: PRIV },
    { command: 'git commit -m "fix sudo\\; handling"', rule: PRIV },
    { command: 'git commit -m "fix sudo handling"', rule: PRIV },
  ])('keeps blocking $command after narrowing the privilege family', ({ command, rule }) => {
    expect(blockedRule(command), command).toBe(rule);
  });

  it.each([
    // man 的只读手册页查询照旧放行；文件名与取证参数照旧放行。
    'man sudo',
    'man 8 sudo',
    'man -k sudo',
    'man su-rs',
    'npm run lint:su-check',
    'ls docs/sudo.md',
    'wc -l docs/sudo-rs.md',
    'which sudo-rs doas pkexec run0',
  ])('still allows %s after narrowing the privilege family', (command) => {
    expect(checkTerminalCommandSafety(command), command).toEqual({ safe: true });
  });

  it('logs a lookalike release with the family root only, never the word or the command text', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    try {
      const commands = ['npm run su-check', 'make sudo-lint'];
      for (const command of commands) {
        expect(checkTerminalCommandSafety(command), command).toEqual({ safe: true });
      }
      const messages = debug.mock.calls.map((call) => String(call[0]));
      expect(messages).toContainEqual(
        expect.stringMatching(/su-family lookalike that is not a known privilege program/)
      );
      expect(messages).toContainEqual(
        expect.stringMatching(/sudo-family lookalike that is not a known privilege program/)
      );
      for (const message of messages) {
        for (const command of commands) {
          expect(message).not.toContain(command);
        }
        expect(message).not.toContain('su-check');
        expect(message).not.toContain('sudo-lint');
      }
    } finally {
      debug.mockRestore();
    }
  });
});
