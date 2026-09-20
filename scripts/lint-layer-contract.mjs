// Dependency-direction lint (P2 AD3, AlembicAgent leg): enforces the internal
// layer contract over src/ top-level areas via config/layer-contract.json as
// a blocking step in `npm run check` — the Core CO2 pattern, following the
// accepted Alembic-leg method (as-is graph derived FIRST via --report, then
// codified; redesigns go through controller-decided waves).
//
// Agent delta vs the Core script: src/ files import each other through BOTH
// relative specifiers and the package.json '#alias/*' subpath imports
// (#agent/#ai/#shared/#tools, 78 alias edges in the as-is census); the lint
// resolves both, otherwise alias edges would be invisible and the contract
// dishonest. `--report` prints the observed cross-area runtime edge matrix
// (the as-is graph the contract was derived from) and exits 0.
// fileBoundaries 可追加具体文件的运行时白名单，约束同一 area 内的职责依赖。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config/layer-contract.json');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

// '#alias/*' → src/<area>/* per package.json imports (alembic-dev condition).
const ALIAS_TO_AREA = {
  '#agent': 'agent',
  '#ai': 'ai',
  '#shared': 'shared',
  '#tools': 'tools',
};

function loadConfig() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (config.schemaVersion !== 1 || !config.allowedRuntimeImports) {
    throw new Error(
      'config/layer-contract.json must have schemaVersion 1 and allowedRuntimeImports'
    );
  }
  if (config.fileBoundaries !== undefined) {
    const { requiredUnder, runtimeImports } = config.fileBoundaries ?? {};
    if (
      !Array.isArray(requiredUnder) ||
      !requiredUnder.every((entry) => typeof entry === 'string' && entry.length > 0) ||
      !runtimeImports ||
      typeof runtimeImports !== 'object' ||
      Array.isArray(runtimeImports) ||
      !Object.values(runtimeImports).every(
        (allowed) => Array.isArray(allowed) && allowed.every((entry) => typeof entry === 'string')
      )
    ) {
      throw new Error(
        'fileBoundaries must contain requiredUnder: string[] and runtimeImports: Record<string, string[]>'
      );
    }
  }
  return config;
}

function areaOf(relativePath) {
  const segments = relativePath.split('/');
  if (segments[0] !== 'src') {
    return undefined;
  }
  return segments.length === 2 ? 'root' : segments[1];
}

function resolveImport(specifier, fromRelativeFile, sourceFiles) {
  const aliasRoot = specifier.split('/')[0];
  let localPath;
  if (Object.hasOwn(ALIAS_TO_AREA, aliasRoot)) {
    localPath = path.posix.join('src', ALIAS_TO_AREA[aliasRoot], specifier.slice(aliasRoot.length));
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    localPath = path.posix.join(path.posix.dirname(fromRelativeFile), specifier);
  } else {
    // 顶层矩阵仍只审仓库内部边；文件白名单同时核对 node:/第三方原始 specifier。
    return { target: specifier };
  }
  const extension = path.posix.extname(localPath);
  const substitutions = {
    '.js': ['.ts', '.tsx'],
    '.jsx': ['.tsx', '.ts'],
    '.mjs': ['.mts'],
    '.cjs': ['.cts'],
  };
  const candidates = (substitutions[extension] ?? []).map(
    (sourceExtension) => localPath.slice(0, -extension.length) + sourceExtension
  );
  candidates.push(localPath);
  if (!extension) {
    // TypeScript 不会从无扩展路径隐式解析 .mts/.cts；它们须使用 .mjs/.cjs。
    for (const sourceExtension of ['.ts', '.tsx']) {
      candidates.push(`${localPath}${sourceExtension}`);
    }
    for (const sourceExtension of ['.ts', '.tsx']) {
      candidates.push(`${localPath}/index${sourceExtension}`);
    }
  }
  // 比较实际源码路径，避免 .js/.ts、relative/#alias 两套写法绕过同一条规则。
  // 未解析路径保留原规范路径；模块是否存在仍由 TypeScript 构建门禁负责。
  const target = candidates.find((candidate) => sourceFiles.has(candidate)) ?? localPath;
  return { target, area: areaOf(target) };
}

function collectSourceFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(absolute, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function collectImports(content, file) {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const imports = [];
  function add(node, specifier, typeOnly, kind = 'import') {
    imports.push({
      index: node.getStart(source),
      specifier: specifier && ts.isStringLiteralLike(specifier) ? specifier.text : undefined,
      typeOnly,
      kind,
    });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const inlineTypesOnly =
        !clause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((entry) => entry.isTypeOnly);
      add(node, node.moduleSpecifier, Boolean(clause?.isTypeOnly || inlineTypesOnly));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const inlineTypesOnly =
        clause &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((entry) => entry.isTypeOnly);
      add(node, node.moduleSpecifier, Boolean(node.isTypeOnly || inlineTypesOnly));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      // import('module').Type / typeof import('module') 都是类型查询，不会加载模块。
      add(node, node.argument.literal, true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node, node.arguments[0], false, 'dynamic import');
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      // 只识别标准直接调用；静态门禁不追踪任意别名、eval 或注入的加载函数。
      add(node, node.arguments[0], false, 'require');
    }
    ts.forEachChild(node, visit);
  }
  // AST 不把注释/文档示例当依赖，且能区分 mixed import 与纯 inline type 桥。
  visit(source);
  return imports;
}

function isRequiredBoundary(file, boundaries) {
  return (boundaries?.requiredUnder ?? []).some((entry) => {
    const prefix = entry.replace(/\/+$/, '');
    return file === prefix || file.startsWith(`${prefix}/`);
  });
}

function main() {
  const reportMode = process.argv.includes('--report');
  // Report mode derives the as-is graph and must work before the contract
  // file exists (it is how the contract gets authored in the first place).
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!reportMode) {
      throw error;
    }
    config = { allowedRuntimeImports: {}, typeOnlyImportsExempt: true };
  }
  const blessedByFile = new Map(
    (config.blessedImports ?? []).map((entry) => [`${entry.file}->${entry.to}`, entry])
  );
  const violations = [];
  const edgeCounts = new Map();
  let runtimeEdges = 0;
  let typeOnlyEdges = 0;
  const files = collectSourceFiles(path.join(REPO_ROOT, 'src'));
  const relativeFiles = new Set(
    files.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
  );

  for (const absolute of files) {
    const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
    const fromArea = areaOf(relative);
    if (!fromArea) {
      continue;
    }
    if (!reportMode && !(fromArea in config.allowedRuntimeImports)) {
      violations.push({
        file: relative,
        line: 1,
        message: `area "${fromArea}" is not declared in config/layer-contract.json`,
      });
      continue;
    }

    const fileRules = config.fileBoundaries?.runtimeImports ?? {};
    const hasFileRule = Object.hasOwn(fileRules, relative);
    const requiredBoundary = isRequiredBoundary(relative, config.fileBoundaries);
    if (!reportMode && requiredBoundary && !hasFileRule) {
      violations.push({ file: relative, line: 1, message: 'no file boundary rule is declared' });
    }
    const content = readFileSync(absolute, 'utf8');
    for (const found of collectImports(content, absolute)) {
      if (found.specifier === undefined) {
        if (!reportMode && (hasFileRule || requiredBoundary)) {
          violations.push({
            file: relative,
            line: lineAt(content, found.index),
            message: `nonliteral ${found.kind} cannot be checked against the file boundary`,
          });
        }
        continue;
      }
      const resolved = resolveImport(found.specifier, relative, relativeFiles);
      // 必须在同 area 的快速跳过之前审文件边界，engine → facade 也属反向依赖。
      // 文件级规则只约束运行时，类型桥仍豁免；顶层矩阵保留原开关语义。
      if (
        !reportMode &&
        hasFileRule &&
        !found.typeOnly &&
        !fileRules[relative].includes(resolved.target)
      ) {
        violations.push({
          file: relative,
          line: lineAt(content, found.index),
          message: `runtime import ${resolved.target} (${found.specifier}) violates the file boundary`,
        });
      }
      const toArea = resolved.area;
      if (!toArea || toArea === fromArea) {
        continue;
      }
      // 保留原顶层 census 范围；新增真实源码 area 由 FROM 侧声明检查拦截。
      if (
        Array.isArray(config.areas) &&
        config.areas.length > 0 &&
        !config.areas.includes(toArea)
      ) {
        continue;
      }

      if (found.typeOnly && config.typeOnlyImportsExempt) {
        typeOnlyEdges += 1;
        continue;
      }
      runtimeEdges += 1;
      const key = `${fromArea} -> ${toArea}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);

      if (reportMode) {
        continue;
      }
      const allowed = config.allowedRuntimeImports[fromArea];
      if (allowed.includes('*') || allowed.includes(toArea)) {
        continue;
      }
      if (blessedByFile.has(`${relative}->${toArea}`)) {
        continue;
      }
      violations.push({
        file: relative,
        line: lineAt(content, found.index),
        message: `runtime import ${fromArea} -> ${toArea} (${found.specifier}) violates the layer contract`,
      });
    }
  }

  if (reportMode) {
    process.stdout.write('Observed cross-area runtime edges (as-is graph):\n');
    for (const [edge, count] of [...edgeCounts.entries()].sort()) {
      process.stdout.write(`  ${edge}: ${count}\n`);
    }
    process.stdout.write(
      `Total: ${runtimeEdges} runtime edges, ${typeOnlyEdges} type-only bridges.\n`
    );
    return;
  }

  if (violations.length > 0) {
    process.stderr.write(`Layer contract failed: ${violations.length} violation(s).\n`);
    for (const violation of violations) {
      process.stderr.write(`- ${violation.file}:${violation.line} ${violation.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Layer contract OK: ${runtimeEdges} cross-area runtime imports within the allowed matrix; ${typeOnlyEdges} type-only bridges exempt.\n`
  );
}

main();
