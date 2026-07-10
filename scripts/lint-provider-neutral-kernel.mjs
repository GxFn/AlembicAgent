#!/usr/bin/env node
// lint:provider-neutral-kernel — P1-B-3(挖掘质量升级)内核 provider 中立门。
//
// 契约:src/agent/{runtime,evaluation,strategies}(内核)不得出现 provider 名的【代码级】
// 引用——所有行为特化经 src/ai/registry/ModelQuirks.ts 的单一查询面消费。
// 规则:
//   - 注释(行注释/块注释)不计——历史语境与设计说明允许提及 provider;
//   - 含 `provider-name-ok:` 标记的行放行(既有记录形状字段等声明过的兼容保留,
//     标记必须带原因,新增须在 review 中说明);
//   - 其余代码行命中 /deepseek|gemini|openai|claude|ollama|anthropic|gpt-/i 即失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const KERNEL_DIRS = ['src/agent/runtime', 'src/agent/evaluation', 'src/agent/strategies'];
const PROVIDER_RE = /deepseek|gemini|openai|claude|ollama|anthropic|gpt-/i;
const MARKER = 'provider-name-ok';

const violations = [];
for (const dir of KERNEL_DIRS) {
  walk(path.join(root, dir));
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith('.ts')) {
      scanFile(full);
    }
  }
}

function scanFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inBlockComment = false;
  lines.forEach((raw, index) => {
    let line = raw;
    // 标记放行优先(标记通常在注释里,先于剥注释判断)。
    if (line.includes(MARKER)) {
      return;
    }
    // 块注释状态机(不处理字符串内 /* 的病态形态——内核代码风格下不存在)。
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) {
        return;
      }
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    let start = line.indexOf('/*');
    while (start >= 0) {
      const end = line.indexOf('*/', start + 2);
      if (end < 0) {
        line = line.slice(0, start);
        inBlockComment = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
      start = line.indexOf('/*');
    }
    const lineComment = line.indexOf('//');
    if (lineComment >= 0) {
      line = line.slice(0, lineComment);
    }
    if (PROVIDER_RE.test(line)) {
      violations.push(`${path.relative(root, file)}:${index + 1}: ${raw.trim().slice(0, 120)}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    `provider-neutral kernel lint failed (${violations.length} code-level provider reference(s) in src/agent/{runtime,evaluation,strategies}; use ModelQuirks or add a justified 'provider-name-ok:' marker):`
  );
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}
console.log(
  'provider-neutral kernel lint passed (runtime/evaluation/strategies code paths are provider-name free).'
);
