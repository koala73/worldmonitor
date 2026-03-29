#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

function listTrackedJsonFiles() {
  try {
    const output = execFileSync('rg', [
      '--files',
      '-g',
      '*.json',
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
      '*.json',
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

function indexToLineColumn(source, index) {
  if (!Number.isInteger(index) || index < 0 || index > source.length) {
    return null;
  }
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function extractPosition(errorMessage) {
  const match = errorMessage.match(/position\s+(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function main() {
  const files = listTrackedJsonFiles();
  if (files.length === 0) {
    console.log('[lint:json] No tracked JSON files found.');
    return;
  }

  const failures = [];

  for (const relativePath of files) {
    const absolutePath = path.join(repoRoot, relativePath);
    const source = await readFile(absolutePath, 'utf8');

    try {
      JSON.parse(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const position = extractPosition(message);
      const location = position == undefined ? null : indexToLineColumn(source, position);
      if (location) {
        failures.push(`${relativePath}:${location.line}:${location.column} ${message}`);
      } else {
        failures.push(`${relativePath}: ${message}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error('[lint:json] Invalid JSON detected:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`[lint:json] Parsed ${files.length} tracked JSON file(s).`);
}

main().catch((error) => {
  console.error(`[lint:json] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
