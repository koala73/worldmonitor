#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function runRipgrep() {
  return spawnSync('rg', [
    '-n',
    '--hidden',
    '-g',
    '!node_modules/**',
    '-g',
    '!dist/**',
    '-g',
    '!src-tauri/target/**',
    '^(<<<<<<<|=======|>>>>>>>)',
    '.',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function runGitGrep() {
  return spawnSync('git', [
    'grep',
    '-nE',
    '^(<<<<<<<|=======|>>>>>>>)',
    '--',
    '.',
    ':(exclude)node_modules/**',
    ':(exclude)dist/**',
    ':(exclude)src-tauri/target/**',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

let result = runRipgrep();
if (result.error?.code === 'ENOENT') {
  result = runGitGrep();
}

if (result.error) {
  const details = result.error.message || 'search command failed unexpectedly';
  console.error(`[lint:conflicts] ${details}`);
  process.exit(1);
}

if (result.status === 1) {
  console.log('[lint:conflicts] No merge conflict markers found.');
  process.exit(0);
}

if (result.status === 0) {
  console.error('[lint:conflicts] Merge conflict markers found:');
  if (result.stdout) process.stderr.write(result.stdout);
  process.exit(1);
}

const details = result.stderr?.trim() || result.stdout?.trim() || 'search command failed unexpectedly';
console.error(`[lint:conflicts] ${details}`);
process.exit(result.status ?? 1);
