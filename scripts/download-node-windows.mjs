#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeVersion = process.env.NODE_VERSION ?? '22.14.0';
const archiveName = `node-v${nodeVersion}-win-x64.zip`;
// Node.js distribution licence: the extracted upstream `LICENSE` travels with
// the packaged runtime. `nodejs.org` is an executable-runtime supply source,
// not a market/news Provider and is intentionally outside the data-source
// inventory, which scans networked data endpoints for user-facing attribution.
const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
const destinationDirectory = path.join(repoRoot, 'src-tauri', 'sidecar', 'node');
const destinationPath = path.join(destinationDirectory, 'node.exe');
const licensePath = path.join(destinationDirectory, 'LICENSE');
const execFileAsync = promisify(execFile);

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const checksums = await fetchText(`${baseUrl}/SHASUMS256.txt`);
const checksumLine = checksums.split(/\r?\n/).find((line) => line.endsWith(`  ${archiveName}`));
if (!checksumLine) throw new Error(`Official checksum missing for ${archiveName}`);
const expectedSha256 = checksumLine.split(/\s+/)[0].toLowerCase();

const tempDirectory = await mkdir(path.join(os.tmpdir(), 'global-intelligence-node-'), { recursive: true })
  .then(() => path.join(os.tmpdir(), `global-intelligence-node-${process.pid}-${Date.now()}`));
await mkdir(tempDirectory, { recursive: true });

try {
  const archivePath = path.join(tempDirectory, archiveName);
  await download(`${baseUrl}/${archiveName}`, archivePath);
  const archive = await readFile(archivePath);
  const actualSha256 = sha256(archive);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${archiveName}: expected ${expectedSha256}, received ${actualSha256}`);
  }

  const extractionDirectory = path.join(tempDirectory, 'extract');
  await mkdir(extractionDirectory, { recursive: true });
  // `tar.exe` ships with supported Windows releases and can safely extract the
  // two fixed archive members. No third-party npm module is needed merely to
  // unpack the already checksum-verified official Node distribution.
  await execFileAsync('tar.exe', [
    '-xf', archivePath,
    '-C', extractionDirectory,
    `node-v${nodeVersion}-win-x64/node.exe`,
    `node-v${nodeVersion}-win-x64/LICENSE`,
  ]);
  const extractedNode = path.join(extractionDirectory, `node-v${nodeVersion}-win-x64`, 'node.exe');
  if (!await stat(extractedNode).then(() => true, () => false)) {
    throw new Error(`node.exe not found after extracting ${archiveName}`);
  }

  await mkdir(destinationDirectory, { recursive: true });
  // The temporary download directory may live on C: while the workspace is on
  // another drive, so use copy rather than rename to avoid EXDEV failures.
  await copyFile(extractedNode, destinationPath);
  const extractedLicense = path.join(extractionDirectory, `node-v${nodeVersion}-win-x64`, 'LICENSE');
  if (await stat(extractedLicense).then(() => true, () => false)) {
    await copyFile(extractedLicense, licensePath);
  }
  const binarySha256 = sha256(await readFile(destinationPath));
  await writeFile(path.join(destinationDirectory, 'VERSION.json'), `${JSON.stringify({ nodeVersion, archiveName, expectedSha256, binarySha256 }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ nodeVersion, archiveName, expectedSha256, binarySha256, destinationPath }));
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
