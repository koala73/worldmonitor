#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const packageLockPath = path.join(repoRoot, 'package-lock.json');

export function findMissingPackageLockVersions(lockfile) {
  const failures = [];

  for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
    if (packagePath === '' || metadata?.link === true || metadata?.optional === true) {
      continue;
    }

    if (typeof metadata?.version !== 'string' || metadata.version.trim() === '') {
      failures.push(`packages.${packagePath}`);
    }
  }

  for (const [dependencyName, metadata] of Object.entries(lockfile.dependencies ?? {})) {
    if (metadata?.link === true) {
      continue;
    }

    if (typeof metadata?.version !== 'string' || metadata.version.trim() === '') {
      failures.push(`dependencies.${dependencyName}`);
    }
  }

  return failures;
}

async function main() {
  const packageLock = JSON.parse(await readFile(packageLockPath, 'utf8'));
  const failures = findMissingPackageLockVersions(packageLock);

  if (failures.length > 0) {
    console.error('[lockfile:check] package-lock.json contains entries with missing or empty version fields:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    console.error('[lockfile:check] Regenerate package-lock.json with npm install or npm install --package-lock-only before retrying the desktop build.');
    process.exit(1);
  }

  console.log('[lockfile:check] package-lock.json version fields look valid.');
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(`[lockfile:check] Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
