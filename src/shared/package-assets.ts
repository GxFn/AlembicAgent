/**
 * Alembic package asset paths.
 *
 * Core owns generic package-root primitives. AlembicAgent currently only needs
 * its own package root for local prompt/persona assets such as SOUL.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;

function findAlembicPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
        if (pkg.name === '@alembic/agent') {
          return dir;
        }
      } catch {
        // Continue walking ancestors.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('[AlembicAgent] Could not locate package root for @alembic/agent.');
}

export const PACKAGE_ROOT = findAlembicPackageRoot();
