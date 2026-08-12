#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = path.join(repoRoot, 'src-tauri', 'sidecar', 'node');
const executablePath = path.join(runtimeDirectory, 'node.exe');
const metadataPath = path.join(runtimeDirectory, 'VERSION.json');
const requiredVersion = '22.14.0';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function hasVerifiedWindowsRuntime() {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const binary = await readFile(executablePath);
    return metadata.nodeVersion === requiredVersion
      && typeof metadata.binarySha256 === 'string'
      && metadata.binarySha256 === sha256(binary);
  } catch {
    return false;
  }
}

if (process.platform !== 'win32') {
  // The maintained upstream shell downloader handles non-Windows release
  // targets. This Windows-only helper intentionally never invents a runtime
  // for another operating system.
  console.log('Non-Windows target: retain the upstream sidecar runtime preparation flow.');
} else if (await hasVerifiedWindowsRuntime()) {
  console.log(`Verified bundled Windows Node runtime ${requiredVersion}.`);
} else {
  console.log(`Preparing checksum-verified bundled Windows Node runtime ${requiredVersion}.`);
  await import('./download-node-windows.mjs');
}
