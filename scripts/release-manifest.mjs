#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const DEFAULT_TARGET_ROOT = path.join(repoRoot, 'src-tauri', 'target');
const RELEASE_FILE_SUFFIXES = [
  '.AppImage',
  '.app.tar.gz',
  '.app.tar.gz.sig',
  '.deb',
  '.dmg',
  '.exe',
  '.msi',
  '.rpm',
  '.sig',
  '.tar.gz',
  '.zip',
];

function parseArgs(argv) {
  const options = {
    mode: 'collect',
    targetRoot: DEFAULT_TARGET_ROOT,
    manifestsDir: '',
    downloadDir: '',
    output: '',
    version: '',
    variant: '',
    tag: '',
    commitSha: '',
    platform: '',
    generatedAt: process.env.WM_BUILD_TIMESTAMP || new Date().toISOString(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      options.mode = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length);
      continue;
    }
    if (arg === '--target-root') {
      options.targetRoot = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--target-root=')) {
      options.targetRoot = arg.slice('--target-root='.length);
      continue;
    }
    if (arg === '--manifests-dir') {
      options.manifestsDir = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--manifests-dir=')) {
      options.manifestsDir = arg.slice('--manifests-dir='.length);
      continue;
    }
    if (arg === '--download-dir') {
      options.downloadDir = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--download-dir=')) {
      options.downloadDir = arg.slice('--download-dir='.length);
      continue;
    }
    if (arg === '--output') {
      options.output = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--version') {
      options.version = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
      continue;
    }
    if (arg === '--variant') {
      options.variant = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--variant=')) {
      options.variant = arg.slice('--variant='.length);
      continue;
    }
    if (arg === '--tag') {
      options.tag = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length);
      continue;
    }
    if (arg === '--commit-sha') {
      options.commitSha = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--commit-sha=')) {
      options.commitSha = arg.slice('--commit-sha='.length);
      continue;
    }
    if (arg === '--platform') {
      options.platform = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--platform=')) {
      options.platform = arg.slice('--platform='.length);
      continue;
    }
    if (arg === '--generated-at') {
      options.generatedAt = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--generated-at=')) {
      options.generatedAt = arg.slice('--generated-at='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!['collect', 'combine', 'verify'].includes(options.mode)) {
    throw new Error(`Unsupported manifest mode: ${options.mode}`);
  }

  return options;
}

export function isReleaseArtifactName(fileName, version) {
  return RELEASE_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix)) && fileName.includes(version);
}

export function canonicalReleaseAssetName(fileName) {
  return fileName.replace(/^World[ .]Monitor(?=_)/, 'World Monitor');
}

async function listFilesRecursive(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(entryPath));
      continue;
    }
    if (entry.isFile()) files.push(entryPath);
  }

  return files;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

export async function collectReleaseArtifacts({ targetRoot, version, variant, tag, commitSha, platform, generatedAt }) {
  const allFiles = await listFilesRecursive(targetRoot);
  const matches = allFiles
    .filter((filePath) => isReleaseArtifactName(path.basename(filePath), version))
    .sort();

  if (matches.length === 0) {
    throw new Error(`No release artifacts found under ${targetRoot} for ${version}`);
  }

  const assets = [];
  const seenNames = new Set();
  for (const filePath of matches) {
    const name = path.basename(filePath);
    if (seenNames.has(name)) {
      throw new Error(`Duplicate artifact basename detected: ${name}`);
    }
    seenNames.add(name);
    const fileStat = await stat(filePath);
    assets.push({
      name,
      path: filePath,
      size: fileStat.size,
      sha256: await sha256File(filePath),
    });
  }

  return {
    version,
    variant,
    tag,
    commitSha,
    platform,
    generatedAt,
    assets,
  };
}

export function combineReleaseManifests(manifests) {
  if (manifests.length === 0) {
    throw new Error('No manifests were provided');
  }

  const [first, ...rest] = manifests;
  const combinedAssets = [...first.assets];

  for (const manifest of rest) {
    for (const field of ['version', 'variant', 'tag', 'commitSha']) {
      if (manifest[field] !== first[field]) {
        throw new Error(`Manifest ${field} mismatch: ${manifest[field]} != ${first[field]}`);
      }
    }
    combinedAssets.push(...manifest.assets);
  }

  const duplicateNames = combinedAssets
    .map((asset) => asset.name)
    .filter((name, index, array) => array.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    throw new Error(`Duplicate asset names across manifests: ${[...new Set(duplicateNames)].join(', ')}`);
  }

  return {
    version: first.version,
    variant: first.variant,
    tag: first.tag,
    commitSha: first.commitSha,
    generatedAt: first.generatedAt,
    assets: combinedAssets.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function verifyDownloadedAssets(manifest, downloadedFiles) {
  const expectedByCanonical = new Map(
    manifest.assets.map((asset) => [canonicalReleaseAssetName(asset.name), asset.name])
  );
  const actualByCanonical = new Map();
  for (const filePath of downloadedFiles) {
    const name = path.basename(filePath);
    if (name === 'release-manifest.json') continue;
    const canonical = canonicalReleaseAssetName(name);
    if (!actualByCanonical.has(canonical)) {
      actualByCanonical.set(canonical, name);
    }
  }
  const errors = [];

  for (const [canonical, expectedName] of expectedByCanonical) {
    if (!actualByCanonical.has(canonical)) {
      errors.push(`Missing release asset: ${expectedName}`);
    }
  }

  for (const [canonical, actualName] of actualByCanonical) {
    if (!expectedByCanonical.has(canonical)) {
      errors.push(`Unexpected release asset: ${actualName}`);
    }
  }

  return errors;
}

async function collectMode(options) {
  const manifest = await collectReleaseArtifacts(options);
  if (options.output) {
    await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  }
}

async function combineMode(options) {
  const manifestFiles = (await listFilesRecursive(options.manifestsDir))
    .filter((filePath) => filePath.endsWith('.json'))
    .sort();
  const manifests = await Promise.all(
    manifestFiles.map(async (filePath) => JSON.parse(await readFile(filePath, 'utf8')))
  );
  const combined = combineReleaseManifests(manifests);
  await writeFile(options.output, `${JSON.stringify(combined, null, 2)}\n`);
}

async function verifyMode(options) {
  const manifest = JSON.parse(await readFile(options.output, 'utf8'));
  const downloadedFiles = await listFilesRecursive(options.downloadDir);
  const errors = verifyDownloadedAssets(manifest, downloadedFiles);
  const downloadedByName = new Map(downloadedFiles.map((filePath) => [path.basename(filePath), filePath]));
  const downloadedByCanonical = new Map(
    downloadedFiles.map((filePath) => [canonicalReleaseAssetName(path.basename(filePath)), filePath])
  );

  for (const asset of manifest.assets) {
    const filePath = downloadedByName.get(asset.name) ?? downloadedByCanonical.get(canonicalReleaseAssetName(asset.name));
    if (!filePath) continue;
    const actualHash = await sha256File(filePath);
    if (actualHash !== asset.sha256) {
      errors.push(`Checksum mismatch for ${asset.name}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'collect') {
    await collectMode(options);
    return;
  }
  if (options.mode === 'combine') {
    if (!options.manifestsDir || !options.output) {
      throw new Error('combine mode requires --manifests-dir and --output');
    }
    await combineMode(options);
    return;
  }
  if (!options.output || !options.downloadDir) {
    throw new Error('verify mode requires --output and --download-dir');
  }
  await verifyMode(options);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(`[release-manifest] Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
