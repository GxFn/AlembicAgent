import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** 只读包/策略/TS输出布局；不import产品、不扫描Core内部、不把冻结名称表当本轮runtime smoke。 */
export function collectPublicEntrypoints(root, inventory) {
  const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
  const pkg = read('package.json'),
    policy = read('config/agent-public-api-boundary.json'),
    signatures = read('config/agent-public-api-signatures.json');
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile).config;
  const sourceRoot = config?.compilerOptions?.rootDir,
    outputRoot = config?.compilerOptions?.outDir;
  const errors = [],
    entries = [],
    sourceFiles = new Set(inventory.files.filter((f) => f.kind === 'source').map((f) => f.path));
  const classified = new Map();
  for (const [field, status] of [
    ['stablePublicExports', 'stable-public'],
    ['provisionalPublicExports', 'provisional-public'],
    ['transitionalInternalExports', 'transitional-internal'],
  ]) {
    for (const key of policy[field] ?? []) {
      if (classified.has(key)) {
        errors.push(`Duplicate public classification: ${key}`);
      }
      classified.set(key, status);
    }
  }
  const safeRelative = (p) =>
    typeof p === 'string' &&
    !path.isAbsolute(p) &&
    !p.includes('\\') &&
    !p.split('/').includes('..');
  if (!safeRelative(sourceRoot) || !safeRelative(outputRoot)) {
    errors.push('Explicit repository-relative rootDir/outDir required');
  }
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    if (key.includes('*')) {
      errors.push(`Wildcard exports are not accepted by this exact-entry atlas: ${key}`);
      continue;
    }
    const specifier = key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`;
    if (!classified.has(key)) {
      errors.push(`Unclassified public export: ${key}`);
    }
    const declaration = policy.publicContractMatrix?.find((row) => row.export === key);
    if (!declaration || declaration.specifier !== specifier) {
      errors.push(`Missing/mismatched public contract row: ${key}`);
    }
    const runtimeTarget = typeof target === 'string' ? target : target?.import;
    const typesTarget = target && typeof target === 'object' ? target.types : null;
    let sourcePath = null;
    const outputPrefix = `./${outputRoot}/`;
    if (
      !safeRelative(sourceRoot) ||
      !safeRelative(outputRoot) ||
      typeof runtimeTarget !== 'string' ||
      !safeRelative(runtimeTarget) ||
      !runtimeTarget.startsWith(outputPrefix)
    ) {
      errors.push(`Public import target outside declared output root: ${key}`);
    } else {
      const candidate = `${sourceRoot}/${runtimeTarget
        .slice(outputPrefix.length)
        .replace(/\.mjs$/u, '.mts')
        .replace(/\.cjs$/u, '.cts')
        .replace(/\.js$/u, '.ts')}`;
      if (!sourceFiles.has(candidate) || !fs.existsSync(path.join(root, candidate))) {
        errors.push(`Missing source mapping for ${key}: ${candidate}`);
      } else {
        sourcePath = candidate;
      }
    }
    const signature = signatures.stableExportSignatures?.[key];
    if (
      classified.get(key) === 'stable-public' &&
      (!signature || signature.exportCount !== signature.entries?.length)
    ) {
      errors.push(`Missing/inconsistent declared runtime signature: ${key}`);
    }
    entries.push({
      export: key,
      specifier,
      status: classified.get(key) ?? 'unclassified',
      runtimeTarget,
      typesTarget,
      sourcePath,
      policyContract: declaration?.contract ?? null,
      agentOwned: declaration?.agentOwned ?? [],
      hostOwned: declaration?.hostOwnedAdapterBoundary ?? null,
      declaredRuntimeBindings: signature?.exportCount ?? null,
      signatureBasis:
        'Frozen configuration expectation; runtime imports were not executed by this collector.',
      reexports: sourcePath
        ? inventory.edges.filter((e) => e.from === sourcePath && e.kind === 're-export')
        : [],
    });
  }
  for (const key of classified.keys()) {
    if (!Object.hasOwn(pkg.exports ?? {}, key)) {
      errors.push(`Classified entry missing from package exports: ${key}`);
    }
  }
  const coreImports = inventory.externalEdges.filter(
    (e) =>
      sourceFiles.has(e.from) && (e.to === '@alembic/core' || e.to.startsWith('@alembic/core/')),
  );
  return {
    schemaVersion: 1,
    packageName: pkg.name,
    packageVersion: pkg.version,
    runtimeImportExecuted: false,
    entries,
    coreImports,
    forbiddenSpecifiers: policy.forbiddenConsumerSpecifiers ?? [],
    errors,
  };
}
