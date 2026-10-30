import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { lexer } from 'marked';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import {
  readEvidenceJson,
  readSnapshotHistory,
  validatePilotShape,
  validateScopedExecutionShape,
} from './evidence.mjs';
import {
  buildHealth,
  executionArtifactErrors,
  readingLinkErrors,
  validateReadings,
} from './maintenance.mjs';
import { collectPublicEntrypoints } from './public-entrypoints.mjs';
import { buildRelations, relationErrors } from './relations.mjs';
import { renderEvidenceErrors } from './render-state.mjs';

export const atlasRoot = path.resolve(import.meta.dirname, '..');
export const repositoryRoot = path.dirname(atlasRoot);
export const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const codeTick = String.fromCharCode(96);
const extensions = /\.(?:[cm]?[jt]sx?)$/u;
const ignored = new Set(['node_modules', 'dist', '.git', '.cache', 'coverage']);
export const defaultScan = {
  sourceRoots: ['src', 'scripts'],
  testRoots: ['test'],
  supportPaths: [
    'config',
    'docs',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.github/workflows/ci.yml',
  ],
};

export function safeFile(root, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.split('/').includes('..') ||
    relative.includes('\0')
  ) {
    throw new Error('Expected a repository-relative path; escape rejected');
  }
  const target = path.resolve(root, relative);
  const real = fs.realpathSync(target);
  const realRoot = fs.realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`Source path escapes repository: ${relative}`);
  }
  return target;
}

export function walk(root, prefix) {
  const start = safeFile(root, prefix);
  if (fs.statSync(start).isFile()) {
    return [prefix];
  }
  const found = [];
  for (const entry of fs
    .readdirSync(start, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (ignored.has(entry.name) || entry.name === '.DS_Store') {
      continue;
    }
    const relative = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlink in source inventory: ${relative}`);
    }
    if (entry.isDirectory()) {
      found.push(...walk(root, relative));
    } else if (entry.isFile()) {
      found.push(relative);
    }
  }
  return found;
}

export function gitInfo(root) {
  const run = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trimEnd();
    } catch {
      return null;
    }
  };
  const status = run(['status', '--porcelain', '-uall']) ?? '';
  return {
    commit: run(['rev-parse', 'HEAD']),
    branch: run(['branch', '--show-current']),
    dirtyPaths: status
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^.* -> /u, ''))
      .filter((p) => !p.startsWith('alembic-agent-architecture-atlas/')),
  };
}

/** AST库存不执行被索引代码；直接依赖和运行调用保持不同的证据等级。 */
export function analyzeRepository(root, options = defaultScan) {
  const sourceRoots = options.sourceRoots ?? defaultScan.sourceRoots;
  const testRoots = options.testRoots ?? defaultScan.testRoots;
  const supportPaths = options.supportPaths ?? defaultScan.supportPaths;
  const paths = new Set();
  for (const prefix of [...sourceRoots, ...testRoots, ...supportPaths]) {
    if (fs.existsSync(path.join(root, prefix))) {
      for (const item of walk(root, prefix)) {
        paths.add(item);
      }
    }
  }
  const configPath = path.join(root, 'tsconfig.json');
  const read = fs.existsSync(configPath)
    ? ts.readConfigFile(configPath, ts.sys.readFile).config
    : {};
  const optionsTs = ts.parseJsonConfigFileContent(read ?? {}, ts.sys, root).options;
  optionsTs.moduleResolution ??= ts.ModuleResolutionKind.NodeNext;
  optionsTs.module ??= ts.ModuleKind.NodeNext;
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = [],
    edges = [],
    externalEdges = [],
    unresolved = [];
  for (const relative of [...paths].sort()) {
    const content = fs.readFileSync(safeFile(root, relative), 'utf8');
    const kind = testRoots.some((p) => relative.startsWith(`${p}/`))
      ? 'test'
      : relative.startsWith('src/')
        ? 'source'
        : relative.startsWith('scripts/')
          ? 'tooling'
          : 'support';
    const file = {
      path: relative,
      kind,
      sha256: hash(content),
      lines: content.split('\n').length,
      symbols: [],
      references: [],
      typeReferences: [],
      testCases: [],
    };
    if (extensions.test(relative)) {
      const parsed = parseCode(content, relative);
      Object.assign(file, {
        symbols: parsed.symbols,
        references: parsed.references,
        typeReferences: parsed.typeReferences,
        testCases: parsed.testCases,
        testDefinitions: parsed.testDefinitions,
      });
      for (const declaration of parsed.imports) {
        const edge = { from: relative, ...declaration };
        const spec = declaration.specifier;
        if (!spec) {
          unresolved.push({ ...edge, reason: 'non-literal module request; no inferred target' });
          continue;
        }
        if (
          !spec.startsWith('.') &&
          !spec.startsWith('#') &&
          !(
            packageJson.name &&
            (spec === packageJson.name || spec.startsWith(`${packageJson.name}/`))
          )
        ) {
          externalEdges.push({ ...edge, to: spec });
          continue;
        }
        const resolved = ts.resolveModuleName(
          spec,
          path.join(root, relative),
          optionsTs,
          ts.sys,
          undefined,
          undefined,
          ts.ModuleKind.ESNext,
        ).resolvedModule;
        if (!resolved) {
          unresolved.push({ ...edge, reason: 'module resolution failed' });
          continue;
        }
        const target = path.relative(root, resolved.resolvedFileName).split(path.sep).join('/');
        if (paths.has(target)) {
          edges.push({ ...edge, to: target });
        } else {
          unresolved.push({
            ...edge,
            reason: 'resolved outside declared inventory',
            target: target.startsWith('..') ? '(external boundary)' : target,
          });
        }
      }
    }
    files.push(file);
  }
  const identity = files.map((f) => `${f.path}\0${f.sha256}`).join('\n');
  return { schemaVersion: 1, files, edges, externalEdges, unresolved, fingerprint: hash(identity) };
}

export function parseCode(content, filename) {
  const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
  const symbols = new Set(),
    references = new Set(),
    typeReferences = new Set(),
    imports = [],
    testCases = [],
    testDefinitions = [];
  const aliases = new Map();
  const nameOf = (node) => node?.getText(source).replace(/^#/u, '');
  function collect(node, owner = '') {
    if (
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isInterfaceDeclaration(node)
    ) {
      if (node.name) {
        symbols.add(node.name.text);
        owner = node.name.text;
      }
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      symbols.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      symbols.add(node.name.text);
    }
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertySignature(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      node.name
    ) {
      const name = nameOf(node.name);
      symbols.add(name);
      if (owner) {
        symbols.add(`${owner}.${name}`);
      }
    }
    if (ts.isConstructorDeclaration(node)) {
      symbols.add('constructor');
      if (owner) {
        symbols.add(`${owner}.constructor`);
      }
    }
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const named = ts.isExportDeclaration(node) ? node.exportClause : bindings;
      const inlineOnly =
        named &&
        (ts.isNamedImports(named) || ts.isNamedExports(named)) &&
        named.elements.length > 0 &&
        named.elements.every((e) => e.isTypeOnly) &&
        !clause?.name;
      imports.push({
        specifier: ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null,
        kind: ts.isExportDeclaration(node) ? 're-export' : 'import',
        typeOnly: Boolean(node.isTypeOnly || clause?.isTypeOnly || inlineOnly),
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          aliases.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
        }
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      imports.push({
        specifier: ts.isStringLiteralLike(node.argument.literal)
          ? node.argument.literal.text
          : null,
        kind: 'type-query',
        typeOnly: true,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      imports.push({
        specifier: node.moduleReference.expression?.text ?? null,
        kind: 'import-equals',
        typeOnly: node.isTypeOnly,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ) {
        imports.push({
          specifier:
            node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
              ? node.arguments[0].text
              : null,
          kind: node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require',
          typeOnly: false,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      }
      const callee = node.expression.getText(source);
      if (
        /^(?:it|test|describe)(?:\.|$)/u.test(callee) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        testCases.push(node.arguments[0].text);
        if (/^(?:it|test)(?:\.|$)/u.test(callee)) {
          testDefinitions.push({
            title: node.arguments[0].text,
            parameterized: /\.each/u.test(callee),
            callLocation: (() => {
              const position = source.getLineAndCharacterOfPosition(
                /\.each/u.test(callee) ? node.expression.getEnd() - 1 : node.getStart(),
              );
              return { line: position.line + 1, column: position.character + 1 };
            })(),
            column: source.getLineAndCharacterOfPosition(node.getStart()).character + 1,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, (child) => collect(child, owner));
  }
  collect(source);
  function usage(node, inType = false) {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      return;
    }
    const type = inType || ts.isTypeNode(node);
    const target = type ? typeReferences : references;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const declarationName =
        parent?.name === node &&
        (ts.isVariableDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isParameter(parent));
      if (!declarationName) {
        target.add(node.text);
        if (aliases.has(node.text)) {
          target.add(aliases.get(node.text));
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      target.add(node.getText(source));
    }
    ts.forEachChild(node, (child) => usage(child, type));
  }
  usage(source);
  return {
    symbols: [...symbols].sort(),
    references: [...references].sort(),
    typeReferences: [...typeReferences].sort(),
    imports,
    testCases,
    testDefinitions,
  };
}

export function fingerprint(root, patterns, { allowMissing = false } = {}) {
  const found = new Set();
  const missing = [];
  for (const pattern of patterns) {
    if (
      typeof pattern !== 'string' ||
      path.isAbsolute(pattern) ||
      pattern.includes('\\') ||
      pattern.split('/').includes('..')
    ) {
      throw new Error('Fingerprint input must be relative; escape rejected');
    }
    const matches = fs
      .globSync(pattern, { cwd: root })
      .filter((file) => fs.statSync(safeFile(root, file)).isFile());
    if (!matches.length) {
      if (allowMissing) {
        missing.push(pattern);
        continue;
      }
      throw new Error(`Unmatched/missing fingerprint input: ${pattern}`);
    }
    for (const file of matches) {
      found.add(file);
    }
  }
  const files = [...found].sort();
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file);
    digest.update('\0');
    digest.update(fs.readFileSync(safeFile(root, file)));
    digest.update('\0');
  }
  return { files, missing, digest: `sha256:${digest.digest('hex')}` };
}

export function documentParts(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw);
  if (!match) {
    throw new Error('Document requires frontmatter');
  }
  const metadata = parseYaml(match[1]);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid metadata object');
  }
  return { metadata, body: match[2] };
}

// 元数据规则只有这一份声明；人工文档、校验器和后续编辑器集成共用。
export const metadataSchema = JSON.parse(
  fs.readFileSync(path.join(atlasRoot, 'metadata.schema.json'), 'utf8'),
);
const metadataValidator = new Ajv({ allErrors: true }).compile(metadataSchema);

export function diagrams(body, docId = '') {
  const fence = codeTick.repeat(3);
  const regex = new RegExp(`${fence}mermaid\\r?\\n([\\s\\S]*?)${fence}`, 'gu');
  const matches = [...body.matchAll(regex)];
  return matches.map((m, i) => ({
    id: `${docId}#${i + 1}`,
    source: m[1],
    digest: hash(m[1]),
    title: m[1].match(/accTitle:\s*([^\n]+)/u)?.[1] ?? '',
    after: body.slice(m.index + m[0].length, matches[i + 1]?.index ?? body.length),
  }));
}

export function evidenceRows(body) {
  const rows = [];
  for (const token of lexer(body, { gfm: true })) {
    if (token.type !== 'table') {
      continue;
    }
    const idColumn = token.header.findIndex((c) => /编号/u.test(c.text));
    const codeColumn = token.header.findIndex((c) => /代码/u.test(c.text));
    const testColumn = token.header.findIndex((c) => /测试/u.test(c.text));
    if (idColumn < 0) {
      continue;
    }
    for (const cells of token.rows) {
      const id = cells[idColumn]?.text.replaceAll(codeTick, '').trim();
      if (/^E-[A-Z0-9-]+-\d{2}$/u.test(id ?? '')) {
        rows.push({
          id,
          code: cells[codeColumn]?.text ?? '',
          test: cells[testColumn]?.text ?? '',
          claim: cells.at(-1)?.text ?? '',
        });
      }
    }
  }
  return rows;
}

export function references(text) {
  const regex = new RegExp(
    codeTick +
      '((?:src|test|scripts|config|docs|alembic-agent-architecture-atlas/test)/[^' +
      codeTick +
      '\\s]+)' +
      codeTick,
    'gu',
  );
  return [...text.matchAll(regex)].map((m) => {
    const i = m[1].indexOf('#');
    return {
      path: i < 0 ? m[1] : m[1].slice(0, i),
      symbol: i < 0 ? null : m[1].slice(i + 1).replaceAll('#', ''),
    };
  });
}

/** 有界作者语法：不把未知 Mermaid 语法静默当作“没有边”。真实排版仍由浏览器验证。 */
export function validateGraphGrammar(source) {
  const lines = source
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('%%'));
  const kind = lines.shift();
  const errors = [],
    nodes = new Set(),
    links = [];
  function declare(id) {
    if (nodes.has(id)) {
      errors.push(`duplicate graph node: ${id}`);
    }
    nodes.add(id);
  }
  for (const line of lines) {
    if (/^acc(?:Title|Descr):/u.test(line)) {
      continue;
    }
    if (kind.startsWith('flowchart ')) {
      const decl = /^([A-Za-z][\w-]*)\["[^"\n]+"\]$/u.exec(line);
      if (decl) {
        declare(decl[1]);
        continue;
      }
      const edge =
        /^([A-Za-z][\w-]*)(\["[^"\n]+"\])? -->\|"[^"\n]+"\| ([A-Za-z][\w-]*)(\["[^"\n]+"\])?$/u.exec(
          line,
        );
      if (edge) {
        if (edge[2]) {
          declare(edge[1]);
        }
        if (edge[4]) {
          declare(edge[3]);
        }
        links.push([edge[1], edge[3]]);
        continue;
      }
    } else if (kind === 'sequenceDiagram') {
      const participant = /^participant ([A-Za-z][\w-]*) as .+$/u.exec(line);
      if (participant) {
        declare(participant[1]);
        continue;
      }
      const edge = /^([A-Za-z][\w-]*?)(?:-->>|->>)\+?([A-Za-z][\w-]*): .+$/u.exec(line);
      if (edge) {
        links.push([edge[1], edge[2]]);
        continue;
      }
    } else if (kind === 'stateDiagram-v2') {
      const state = /^state "[^"\n]+" as ([A-Za-z][\w-]*)$/u.exec(line);
      if (state) {
        declare(state[1]);
        continue;
      }
      const edge = /^([A-Za-z][\w-]*|\[\*\]) --> ([A-Za-z][\w-]*|\[\*\]): .+$/u.exec(line);
      if (edge) {
        links.push([edge[1], edge[2]]);
        continue;
      }
    }
    errors.push(`unsupported graph syntax: ${line}`);
  }
  for (const [from, to] of links) {
    for (const id of [from, to]) {
      if (id !== '[*]' && !nodes.has(id)) {
        errors.push(`unknown graph node: ${id}`);
      }
    }
  }
  return errors;
}

export function validateDocument(
  doc,
  root,
  inventory,
  { requireCurrent = false, dirtyPaths = [] } = {},
) {
  const errors = [];
  const { metadata: m, body } = doc;
  if (!metadataValidator(m)) {
    return {
      errors: metadataValidator.errors.map((e) => `metadata ${e.instancePath} ${e.message}`),
      freshness: 'unavailable',
      inputFiles: [],
      expectedFingerprint: null,
      diagrams: [],
      rows: [],
    };
  }
  if (
    !Number.isFinite(Date.parse(m.verifiedAt)) ||
    new Date(m.verifiedAt).toISOString().slice(0, 10) !== m.verifiedAt
  ) {
    errors.push('metadata invalid verifiedAt');
  }
  let fp = { files: [], digest: '' };
  try {
    fp = fingerprint(
      root,
      [...m.sourcePaths, ...m.testPaths, ...m.contractPaths, ...m.refreshTriggers],
      { allowMissing: true },
    );
    for (const missing of fp.missing) {
      errors.push(`Unmatched/missing fingerprint input: ${missing}`);
    }
  } catch (error) {
    errors.push(error.message);
  }
  const freshness = fp.digest === m.sourceFingerprint ? 'matched' : 'stale';
  if (
    freshness === 'stale' &&
    (requireCurrent || !['stale', 'historical', 'target-design'].includes(m.truthKind))
  ) {
    errors.push('source fingerprint drift');
  }
  if (m.truthKind === 'current-code' && dirtyPaths.some((p) => fp.files.includes(p))) {
    errors.push('current-code document includes uncommitted inputs');
  }
  const lookup = new Map(inventory.files.map((f) => [f.path, f]));
  // 明文路径也属于证据，不能通过省略反引号绕开输入闭包。
  for (const file of inventory.files) {
    if (body.includes(file.path) && !fp.files.includes(file.path)) {
      errors.push(`mentioned path not in fingerprint inputs: ${file.path}`);
    }
  }
  for (const ref of references(body)) {
    if (!fs.existsSync(path.join(root, ref.path))) {
      errors.push(`missing reference ${ref.path}`);
      continue;
    }
    if (!fp.files.includes(ref.path)) {
      errors.push(`reference not in fingerprint inputs: ${ref.path}`);
    }
    if (ref.symbol) {
      const isTest =
        ref.path.startsWith('test/') ||
        ref.path.startsWith('alembic-agent-architecture-atlas/test/');
      const entry =
        lookup.get(ref.path) ??
        (isTest ? parseCode(fs.readFileSync(safeFile(root, ref.path), 'utf8'), ref.path) : null);
      const symbols = isTest ? entry?.references : entry?.symbols;
      if (isTest && ref.symbol.startsWith('case:')) {
        let title = '';
        try {
          title = decodeURIComponent(ref.symbol.slice(5));
        } catch {
          /* 非法编码也必须失败。 */
        }
        if (!entry?.testCases.includes(title)) {
          errors.push(`test case missing: ${ref.path}#${ref.symbol}`);
        }
      } else if (!symbols?.includes(ref.symbol)) {
        errors.push(
          (ref.path.startsWith('test/') ? 'test anchor' : 'source symbol') +
            ' missing/unreferenced: ' +
            ref.path +
            '#' +
            ref.symbol,
        );
      }
    }
  }
  const blocks = diagrams(body, m.diagramId);
  const allRows = evidenceRows(body);
  const edgeIds = [];
  for (const block of blocks) {
    errors.push(...validateGraphGrammar(block.source).map((e) => `${block.id}: ${e}`));
    if (!/^flowchart\s|^sequenceDiagram\s|^stateDiagram-v2\s/u.test(block.source.trim())) {
      errors.push(`unsupported diagram grammar: ${block.id}`);
    }
    if (
      !/accTitle:.*[\u4e00-\u9fff]/u.test(block.source) ||
      !/accDescr:.*[\u4e00-\u9fff]/u.test(block.source)
    ) {
      errors.push(`Chinese accTitle/accDescr required: ${block.id}`);
    }
    if (!/^\s*### 本图术语说明/u.test(block.after)) {
      errors.push(`adjacent terminology required: ${block.id}`);
    }
    const rows = evidenceRows(block.after);
    for (const line of block.source.split('\n')) {
      if (!/(?:-->|-\.(?:-)?->|-->>|->>|--x)/u.test(line) || /^\s*acc/u.test(line)) {
        continue;
      }
      const ids = [...line.matchAll(/\bE-[A-Z0-9-]+-\d{2}\b/gu)].map((v) => v[0]);
      if (ids.length !== 1) {
        errors.push(`edge must have one evidence id: ${line.trim()}`);
        continue;
      }
      const id = ids[0];
      edgeIds.push(id);
      if (rows.filter((row) => row.id === id).length !== 1) {
        errors.push(`${id}: expected exactly one adjacent evidence row`);
      }
    }
  }
  if (new Set(edgeIds).size !== edgeIds.length) {
    errors.push('duplicate edge id');
  }
  for (const row of allRows) {
    if (!edgeIds.includes(row.id)) {
      errors.push(`orphan evidence row: ${row.id}`);
    }
    if (!row.code || !references(row.code).length) {
      errors.push(`code evidence required: ${row.id}`);
    }
    if (row.test.startsWith('未覆盖：')) {
      if (references(row.test).length || row.test.slice(4).trim().length < 5) {
        errors.push(`uncovered reason required: ${row.id}`);
      }
    } else {
      const refs = references(row.test).filter(
        (r) =>
          r.path.startsWith('test/') || r.path.startsWith('alembic-agent-architecture-atlas/test/'),
      );
      if (!refs.length || refs.some((r) => !r.symbol)) {
        errors.push(`anchored test evidence required: ${row.id}`);
      }
      if (
        row.test.startsWith('间接覆盖：') &&
        row.test
          .replace(new RegExp(`${codeTick}[^${codeTick}]*${codeTick}`, 'gu'), '')
          .slice(5)
          .trim().length < 5
      ) {
        errors.push(`indirect coverage reason required: ${row.id}`);
      }
    }
    if (m.viewType === 'file-dependency') {
      const refs = references(row.code);
      if (
        refs.length !== 2 ||
        !inventory.edges.some((e) => e.from === refs[0].path && e.to === refs[1].path)
      ) {
        errors.push(`absent direct import: ${row.id}`);
      }
    }
  }
  if (/(?:\/Users\/|\/home\/[a-z]|[A-Z]:\\Users\\)/u.test(body)) {
    errors.push('machine-specific absolute path');
  }
  return {
    errors,
    freshness,
    inputFiles: fp.files,
    expectedFingerprint: fp.digest,
    diagrams: blocks.map(({ after, ...b }) => b),
    rows: allRows,
  };
}

export { validateRenderReceipt } from './render-contract.mjs';

export function loadAtlas(root = repositoryRoot) {
  const configPath = path.join(atlasRoot, 'atlas.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const inventory = analyzeRepository(root, config.scan ?? defaultScan),
    git = gitInfo(root);
  const publicApi = collectPublicEntrypoints(root, inventory);
  const evidenceDiagnostics = publicApi.errors.map((error) => `public API: ${error}`);
  const read = (relative, validate) => {
    const result = readEvidenceJson(path.join(atlasRoot, relative), validate);
    if (result.status === 'invalid') {
      evidenceDiagnostics.push(`${relative}: ${result.errors.join('; ')}`);
    }
    return result.value;
  };
  const documents = [];
  for (const relative of walk(atlasRoot, 'maps').filter((p) => p.endsWith('.md'))) {
    try {
      const parts = documentParts(fs.readFileSync(path.join(atlasRoot, relative), 'utf8'));
      const validation = validateDocument({ ...parts, path: relative }, root, inventory, {
        dirtyPaths: git.dirtyPaths,
      });
      if (!metadataValidator(parts.metadata)) {
        throw new Error(validation.errors.join('; '));
      }
      if (!validation.inputFiles) {
        validation.inputFiles = [];
      }
      documents.push({
        id: parts.metadata.diagramId ?? relative.replace(/[^a-z0-9]/gu, '-'),
        path: relative,
        ...parts,
        ...validation,
      });
    } catch (error) {
      const id = `invalid-${relative.replace(/[^a-z0-9]/gu, '-')}`;
      documents.push({
        id,
        path: relative,
        metadata: {
          diagramId: id,
          title: `无效文档：${relative}`,
          topic: '00',
          viewType: 'guide',
          truthKind: 'stale',
          reviewDepth: 'L0',
          verifiedAt: 'unknown',
          baselineCommit: git.commit,
          sourcePaths: [],
          testPaths: [],
        },
        body: '# 文档无法读取\n\n元数据或来源无效，请先修复文档。',
        errors: [error.message],
        freshness: 'unavailable',
        inputFiles: [],
        diagrams: [],
        rows: [],
      });
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(atlasRoot, 'package.json'), 'utf8'));
  const current = read('evidence/current.json', (value) =>
    value && typeof value.id === 'string' && typeof value.capturedAt === 'string'
      ? []
      : ['Invalid current snapshot pointer'],
  );
  let history = [];
  try {
    const loaded = readSnapshotHistory(safeFile(atlasRoot, 'evidence/snapshots'));
    history = loaded.history;
    evidenceDiagnostics.push(...loaded.errors);
  } catch {
    evidenceDiagnostics.push('Snapshot root is unavailable or outside the Atlas boundary');
  }
  const duplicateIds = new Set(
    history
      .filter((s, i) => history.findIndex((other) => other.id === s.id) !== i)
      .map((s) => s.id),
  );
  for (const id of duplicateIds) {
    evidenceDiagnostics.push(`Duplicate snapshot identity: ${id}`);
  }
  const validHistory = history.filter((s) => !duplicateIds.has(s.id));
  const renderReceipt = read('evidence/render/current.json', (value) =>
    value &&
    value.renderer === 'mermaid' &&
    Array.isArray(value.results) &&
    value.results.every((r) => r && typeof r.id === 'string')
      ? []
      : ['Invalid renderer receipt'],
  );
  const renderAttempt = read('evidence/render/latest-attempt.json', (value) =>
    value &&
    typeof value.id === 'string' &&
    ['running', 'pass', 'fail', 'cancelled'].includes(value.status) &&
    typeof value.inputFingerprint === 'string'
      ? []
      : ['Invalid render attempt'],
  );
  const pilot = read('evidence/pilot.json', validatePilotShape);
  let pilotFreshness = 'unavailable';
  if (pilot) {
    try {
      pilotFreshness =
        pilot.status !== 'pass'
          ? `latest-attempt-${pilot.status}`
          : fingerprint(root, pilot.sourcePatterns).digest === pilot.sourceFingerprint &&
              hash(fs.readFileSync(path.join(atlasRoot, 'test/pilot.test.ts'))) ===
                pilot.testFingerprint &&
              fingerprint(atlasRoot, pilot.harnessPatterns).digest === pilot.harnessFingerprint
            ? 'matched'
            : 'stale';
    } catch {
      pilotFreshness = 'stale';
    }
  }
  const readingRecord = read('evidence/readings.json', validateReadings);
  const readings = readingRecord?.files ?? [];
  const reviewRecords = {};
  if (readingRecord?.schemaVersion === 2) {
    for (const file of new Set(readings.map((f) => f.reviewRecord).filter(Boolean))) {
      try {
        reviewRecords[file] = JSON.parse(fs.readFileSync(safeFile(atlasRoot, file), 'utf8'));
      } catch {
        evidenceDiagnostics.push(`Unreadable review evidence: ${file}`);
      }
    }
    evidenceDiagnostics.push(
      ...readingLinkErrors(readings, inventory, documents, validHistory, reviewRecords),
    );
  }
  const scopedRuns = read('evidence/scoped-execution.json', validateScopedExecutionShape);
  if (scopedRuns) {
    for (const group of scopedRuns.groups) {
      try {
        if (scopedRuns.schemaVersion === 2) {
          const artifactErrors = executionArtifactErrors(group);
          evidenceDiagnostics.push(...artifactErrors);
          if (artifactErrors.length) {
            group.inputFreshness = 'invalid';
            continue;
          }
        }

        group.inputFreshness =
          fingerprint(root, group.sourcePatterns).digest === group.sourceFingerprint &&
          (scopedRuns.schemaVersion !== 2 ||
            fingerprint(atlasRoot, group.harnessPatterns).digest === group.harnessFingerprint)
            ? 'matched'
            : 'stale';
      } catch {
        group.inputFreshness = 'unavailable';
        evidenceDiagnostics.push(`Execution inputs unavailable: ${group.id}`);
      }
    }
  }

  const catalog = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    git,
    config,
    inventory,
    publicApi,
    scopedRuns,
    documents,
    current,
    history: validHistory,
    rendererVersion: pkg.dependencies.mermaid,
    renderReceipt,
    renderAttempt,
    renderFreshness: renderEvidenceErrors(
      renderAttempt,
      renderReceipt,
      documents.flatMap((d) => d.diagrams),
      pkg.dependencies.mermaid,
    ).length
      ? 'stale'
      : 'matched',
    pilot,
    pilotFreshness,
    readings,
    readingSchemaVersion: readingRecord?.schemaVersion ?? 1,
    reviewRecords,
    evidenceDiagnostics,
  };
  const scenarioRecord = read('evidence/scenarios.json', (value) =>
    value?.schemaVersion === 1 && Array.isArray(value.scenarios) ? [] : ['Invalid scenarios'],
  );
  catalog.relations = buildRelations(
    catalog,
    scenarioRecord?.scenarios ?? [],
    scenarioRecord?.relationKinds ?? {},
  );
  evidenceDiagnostics.push(...relationErrors(catalog.relations, documents));
  catalog.health = buildHealth(
    catalog,
    validHistory.find((s) => s.id === (config.maintenanceBaseline ?? current?.id)),
  );
  return catalog;
}
