import fs from 'node:fs';
import path from 'node:path';
import { analyzeRepository, atlasRoot, gitInfo, loadAtlas, repositoryRoot } from './atlas-lib.mjs';
import { buildBrowserAssets } from './browser-data.mjs';

const i = process.argv.indexOf('--root');
const root = i >= 0 ? path.resolve(process.argv[i + 1]) : repositoryRoot;
// --root 是独立解析 fixture 的入口，不能把真实图谱/历史混进别的仓库库存。
const catalog =
  root === repositoryRoot
    ? loadAtlas(root)
    : { schemaVersion: 1, git: gitInfo(root), inventory: analyzeRepository(root), documents: [] };
if (process.argv.includes('--stdout')) {
  process.stdout.write(`${JSON.stringify(catalog)}\n`);
} else {
  fs.mkdirSync(path.join(atlasRoot, 'evidence/live'), { recursive: true });
  fs.writeFileSync(path.join(atlasRoot, 'evidence/live/catalog.json'), JSON.stringify(catalog));
  if (root === repositoryRoot) {
    const { bootstrap, assets } = buildBrowserAssets(catalog);
    const destination = path.join(atlasRoot, 'evidence/live/public');
    fs.mkdirSync(path.join(destination, 'atlas-data'), { recursive: true });
    for (const [relative, content] of assets) {
      fs.writeFileSync(path.join(destination, relative), content);
    }
    fs.writeFileSync(
      path.join(atlasRoot, 'evidence/live/bootstrap.json'),
      JSON.stringify(bootstrap),
    );
    for (const name of fs.readdirSync(path.join(destination, 'atlas-data'))) {
      if (
        /^(current|snapshot)-[a-f0-9]{64}\.json$/u.test(name) &&
        !assets.has(`atlas-data/${name}`)
      ) {
        fs.unlinkSync(path.join(destination, 'atlas-data', name));
      }
    }
  }
  console.log(
    'Atlas collected: ' +
      catalog.inventory.files.length +
      ' files, ' +
      catalog.documents.length +
      ' documents; no source files changed.',
  );
}
