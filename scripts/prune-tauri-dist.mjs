import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DUPLICATE_SUFFIX_RE = / [2-9]\d{0,2}$/;

export function getCanonicalAssetPath(filePath) {
  const parsed = path.parse(filePath);
  if (!DUPLICATE_SUFFIX_RE.test(parsed.name)) return null;
  const canonicalName = parsed.name.replace(DUPLICATE_SUFFIX_RE, '');
  return path.join(parsed.dir, `${canonicalName}${parsed.ext}`);
}

async function walkFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(fullPath));
      continue;
    }
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

export async function findPrunableAssetPaths(rootDir) {
  const files = await walkFiles(rootDir);
  return files.filter((filePath) => {
    const canonicalPath = getCanonicalAssetPath(filePath);
    return canonicalPath !== null && existsSync(canonicalPath);
  });
}

export async function pruneTauriDist(rootDir) {
  const prunablePaths = await findPrunableAssetPaths(rootDir);
  await Promise.all(prunablePaths.map((filePath) => rm(filePath, { force: true })));
  return prunablePaths;
}

async function main() {
  const rootDir = process.argv[2];
  if (!rootDir) {
    console.error('Usage: node scripts/prune-tauri-dist.mjs <dist-dir>');
    process.exit(1);
  }

  if (!existsSync(rootDir)) process.exit(0);

  const pruned = await pruneTauriDist(rootDir);
  if (pruned.length > 0) {
    console.log(`[prune-tauri-dist] removed ${pruned.length} duplicate iCloud asset(s)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
