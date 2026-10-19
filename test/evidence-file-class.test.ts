/**
 * 证据来源文件分类表（脱敏阶段 2 / 方案 C，设计 4.5 节）。
 *
 * 覆盖：
 * - 分类表是数据：每条 secret-bearing 规则的正例必须归入 secret-bearing，反例必须不归入；
 * - 优先级：secret-bearing（名称优先）> source（扩展名表）> config 与其他；
 * - `token` 只对非源码扩展名生效（`TokenBudget.ts` 仍是 source）；
 * - 路径段、大小写、Windows 分隔符；
 * - terminal 条目一律按终端处理（file 取自命令 token，不可信）。
 */
import { describe, expect, test } from 'vitest';
import {
  classifyEvidenceFile,
  classifyEvidenceSource,
  EVIDENCE_SOURCE_FILE_EXTENSIONS,
  explainEvidenceFileClass,
  SECRET_BEARING_FILE_RULES,
} from '../src/agent/evidence/evidenceFileClass.js';

describe('secret-bearing 规则表（数据 + 正反例）', () => {
  test('规则 id 唯一，且每条规则都带正例与反例', () => {
    const ids = SECRET_BEARING_FILE_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of SECRET_BEARING_FILE_RULES) {
      expect(rule.examples.length, rule.id).toBeGreaterThan(0);
      expect(rule.negativeExamples.length, rule.id).toBeGreaterThan(0);
    }
  });

  test('每条规则的正例都归入 secret-bearing，并由该规则命中', () => {
    for (const rule of SECRET_BEARING_FILE_RULES) {
      for (const example of rule.examples) {
        const explained = explainEvidenceFileClass(example);
        expect(explained.fileClass, `${rule.id}: ${example}`).toBe('secret-bearing');
        expect(explained.matchedRuleIds, `${rule.id}: ${example}`).toContain(rule.id);
      }
    }
  });

  test('每条规则的反例都不归入 secret-bearing', () => {
    for (const rule of SECRET_BEARING_FILE_RULES) {
      for (const example of rule.negativeExamples) {
        const explained = explainEvidenceFileClass(example);
        expect(explained.fileClass, `${rule.id}: ${example}`).not.toBe('secret-bearing');
        expect(explained.matchedRuleIds, `${rule.id}: ${example}`).not.toContain(rule.id);
      }
    }
  });

  test('设计 4.5 节列出的基名、扩展名与路径段全部覆盖', () => {
    const expectedSecretBearing = [
      '.env',
      'apps/web/.env.local',
      '.env.example',
      '.npmrc',
      '.pypirc',
      '.netrc',
      '_netrc',
      '.pgpass',
      '.htpasswd',
      '.git-credentials',
      'credentials',
      'config/credentials.json',
      'id_rsa',
      'id_dsa',
      'id_ecdsa',
      'id_ed25519.pub',
      'kubeconfig',
      'infra/terraform.tfstate',
      'infra/terraform.tfstate.backup',
      'infra/prod.tfvars',
      'certs/server.pem',
      'tls/server.key',
      'AuthKey_SYNTHETIC.p8',
      'client.p12',
      'store.pfx',
      'app.jks',
      'android/release.keystore',
      'keys/putty.ppk',
      '.ssh/config',
      'home/.aws/config',
      'deploy/secrets/app.yml',
      '.secrets/value.txt',
    ];
    for (const file of expectedSecretBearing) {
      expect(classifyEvidenceFile(file), file).toBe('secret-bearing');
    }
  });
});

describe('优先级：名称优先 > 源码扩展名 > 配置与其他', () => {
  test('基名分词含 secret(s)/credential(s)/password(s)/passwd 时不论扩展名都是 secret-bearing', () => {
    for (const file of [
      'src/secrets.ts',
      'lib/secret_key.rb',
      'app/ui/PasswordField.tsx',
      'src/userCredentials.py',
      'config/db-passwords.yaml',
      'etc/passwd',
      'src/DBPassword.go',
    ]) {
      expect(classifyEvidenceFile(file), file).toBe('secret-bearing');
    }
  });

  test('分词按整词匹配：含关键词子串但不是独立词的名字不受影响', () => {
    expect(classifyEvidenceFile('src/passwordless.ts')).toBe('source');
    expect(classifyEvidenceFile('src/secretariat.ts')).toBe('source');
    expect(classifyEvidenceFile('src/credentialing.ts')).toBe('source');
    expect(classifyEvidenceFile('src/agent/utils/Redaction.ts')).toBe('source');
  });

  test('token 只对非源码扩展名生效', () => {
    expect(classifyEvidenceFile('src/TokenBudget.ts')).toBe('source');
    expect(classifyEvidenceFile('src/tokens.ts')).toBe('source');
    expect(classifyEvidenceFile('lib/tokenizer.py')).toBe('source');
    expect(classifyEvidenceFile('config/token.json')).toBe('secret-bearing');
    expect(classifyEvidenceFile('deploy/api-tokens.yaml')).toBe('secret-bearing');
    expect(classifyEvidenceFile('.token')).toBe('secret-bearing');
    expect(classifyEvidenceFile('scripts/refresh-token.sh')).toBe('secret-bearing');
  });

  test('源码扩展名表与设计一致；shell、Dockerfile、Makefile、SQL、HTML、Markdown、txt 不算 source', () => {
    expect([...EVIDENCE_SOURCE_FILE_EXTENSIONS].sort()).toEqual(
      [
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
      ].sort()
    );
    for (const extension of EVIDENCE_SOURCE_FILE_EXTENSIONS) {
      expect(classifyEvidenceFile(`src/module.${extension}`), extension).toBe('source');
    }
    for (const file of [
      'scripts/deploy.sh',
      'Dockerfile',
      'Makefile',
      'db/schema.sql',
      'public/index.html',
      'README.md',
      'notes.txt',
      'package.json',
      'config/app.yaml',
      'LICENSE',
      'src/component.vue',
    ]) {
      expect(classifyEvidenceFile(file), file).toBe('config');
    }
  });

  test('单数 secret 目录不在路径段表内，按基名与扩展名判定', () => {
    expect(classifyEvidenceFile('src/secret/a.ts')).toBe('source');
    expect(classifyEvidenceFile('src/ssh/client.ts')).toBe('source');
  });
});

describe('路径形态', () => {
  test('大小写不敏感（secret-bearing 方向从严）', () => {
    expect(classifyEvidenceFile('.ENV')).toBe('secret-bearing');
    expect(classifyEvidenceFile('Deploy/Secrets/app.yml')).toBe('secret-bearing');
    expect(classifyEvidenceFile('certs/SERVER.PEM')).toBe('secret-bearing');
  });

  test('Windows 分隔符与 ./ 前缀按同一路径处理', () => {
    expect(classifyEvidenceFile('config\\.env')).toBe('secret-bearing');
    expect(classifyEvidenceFile('.\\src\\index.ts')).toBe('source');
    expect(classifyEvidenceFile('./src/index.ts')).toBe('source');
  });

  test('空路径不是 secret-bearing，也不是 source', () => {
    expect(classifyEvidenceFile('')).toBe('config');
    expect(explainEvidenceFileClass('').matchedRuleIds).toEqual([]);
  });
});

describe('classifyEvidenceSource：条目来源', () => {
  test('terminal 条目一律按终端处理，不信任其 file', () => {
    expect(classifyEvidenceSource({ tool: 'terminal.exec', file: 'src/a.ts' })).toBe('terminal');
    expect(classifyEvidenceSource({ tool: 'terminal.exec', file: '.env' })).toBe('terminal');
    expect(classifyEvidenceSource({ tool: 'terminal.exec' })).toBe('terminal');
  });

  test('无 file 的条目为 no-file；其余按文件分类表', () => {
    expect(classifyEvidenceSource({ tool: 'graph.query' })).toBe('no-file');
    expect(classifyEvidenceSource({ tool: 'code.read', file: '' })).toBe('no-file');
    expect(classifyEvidenceSource({ tool: 'code.read', file: '.env' })).toBe('secret-bearing');
    expect(classifyEvidenceSource({ tool: 'code.read', file: 'src/a.ts' })).toBe('source');
    expect(classifyEvidenceSource({ tool: 'code.search', file: 'config/app.yaml' })).toBe('config');
    expect(classifyEvidenceSource({ file: 'src/a.ts' })).toBe('source');
  });
});
