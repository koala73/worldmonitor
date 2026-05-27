#!/usr/bin/env node
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN_LOCAL_ENV_DUMPS = [
  '.env.vercel-backup',
  '.env.vercel-export',
];

export function findLocalSecretDumps(rootDir = process.cwd()) {
  return FORBIDDEN_LOCAL_ENV_DUMPS.filter((fileName) => {
    try {
      lstatSync(resolve(rootDir, fileName));
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  });
}

export function formatLocalSecretDumpError(found) {
  return [
    'ERROR: local Vercel env dump files are present in the repository root.',
    '',
    ...found.map((fileName) => `  - ${fileName}`),
    '',
    'Delete these plaintext dumps before pushing. Pull Vercel env values on demand',
    'and rotate exposed production secrets through the owning vendor dashboards.',
  ].join('\n');
}

export function runLocalSecretDumpCheck(rootDir = process.cwd()) {
  const found = findLocalSecretDumps(rootDir);
  if (found.length > 0) {
    throw new Error(formatLocalSecretDumpError(found));
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  try {
    runLocalSecretDumpCheck();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
