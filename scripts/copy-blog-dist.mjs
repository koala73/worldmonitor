import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const blogDist = resolve(projectRoot, 'blog-site', 'dist');
const publicDir = resolve(projectRoot, 'public');
const outputDir = resolve(publicDir, 'blog');

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== '' && !pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..';
}

async function main() {
  if (!isWithin(publicDir, outputDir)) {
    throw new Error(`Refusing to replace a path outside public/: ${outputDir}`);
  }

  const source = await stat(blogDist).catch(() => null);
  if (!source?.isDirectory()) {
    throw new Error(`Blog build output is missing: ${blogDist}`);
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await cp(blogDist, outputDir, { recursive: true });
  process.stdout.write(`copy-blog-dist: copied ${blogDist} -> ${outputDir}\n`);
}

await main();
