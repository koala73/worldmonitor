#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function parseFileList(output) {
  return output
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
}

function isMissingCommand(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function listTrackedShellFiles() {
  try {
    const output = execFileSync('rg', [
      '--files',
      '--hidden',
      '-g',
      '*.sh',
      '-g',
      '.husky/**',
      '-g',
      '!node_modules/**',
      '-g',
      '!dist/**',
      '-g',
      '!src-tauri/target/**',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return parseFileList(output);
  } catch (error) {
    if (!isMissingCommand(error)) throw error;
    const output = execFileSync('git', [
      'ls-files',
      '--',
      '*.sh',
      '.husky/**',
      ':(exclude)node_modules/**',
      ':(exclude)dist/**',
      ':(exclude)src-tauri/target/**',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return parseFileList(output);
  }
}

function pickInterpreter(firstLine) {
  if (firstLine.includes('bash')) return 'bash';
  if (firstLine.includes('sh')) return 'sh';
  return null;
}

function isExecutable(mode) {
  return (mode & 0o111) !== 0;
}

function main() {
  const files = listTrackedShellFiles();
  if (files.length === 0) {
    console.log('[lint:shell] No tracked shell files found.');
    return;
  }

  const failures = [];

  for (const relativePath of files) {
    const absolutePath = path.join(repoRoot, relativePath);
    const source = readFileSync(absolutePath, 'utf8');
    const [firstLine = ''] = source.split('\n');
    const interpreter = pickInterpreter(firstLine);

    if (!firstLine.startsWith('#!')) {
      failures.push(`${relativePath}: missing shebang`);
      continue;
    }

    if (!interpreter) {
      failures.push(`${relativePath}: unsupported shell in shebang (${firstLine})`);
      continue;
    }

    const fileStat = statSync(absolutePath);
    if (!isExecutable(fileStat.mode)) {
      failures.push(`${relativePath}: file is not executable`);
    }

    const lintResult = spawnSync(interpreter, ['-n', absolutePath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    if (lintResult.status !== 0) {
      const details = [lintResult.stderr, lintResult.stdout].filter(Boolean).join('\n').trim();
      failures.push(`${relativePath}: ${details || 'shell syntax check failed'}`);
    }

    if (relativePath.startsWith('scripts/') && !source.includes('set -euo pipefail')) {
        failures.push(`${relativePath}: expected strict mode "set -euo pipefail"`);
      }
  }

  if (failures.length > 0) {
    console.error('[lint:shell] Shell lint failures:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`[lint:shell] Checked ${files.length} tracked shell file(s).`);
}

main();
