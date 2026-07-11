#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SECRET_NAME = /^(VITE_[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)$/;
const LOCAL_ENV_FILES = ['.env', '.env.local'];

export function findViteSecretEnvVars(source) {
  const names = new Set();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(VITE_[A-Z0-9_]+)\s*=/);
    if (match && SECRET_NAME.test(match[1])) names.add(match[1]);
  }
  return [...names].sort();
}

function trackedEnvFiles(rootDir) {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', '.env*'], { cwd: rootDir, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch {
    return ['.env.example'].filter(file => existsSync(resolve(rootDir, file)));
  }
}

function findingsInFiles(rootDir, files) {
  return files.flatMap(file => {
    const path = resolve(rootDir, file);
    if (!existsSync(path)) return [];
    return findViteSecretEnvVars(readFileSync(path, 'utf8')).map(name => ({ file, name }));
  });
}

export function runViteEnvSecretGuard(rootDir = process.cwd(), options = {}) {
  const tracked = options.trackedEnvFiles ?? trackedEnvFiles(rootDir);
  const local = options.localEnvFiles ?? LOCAL_ENV_FILES.filter(file => existsSync(resolve(rootDir, file)));
  const warn = options.warn ?? console.warn;
  const committedFindings = findingsInFiles(rootDir, tracked);
  if (committedFindings.length > 0) {
    const details = committedFindings.map(({ file, name }) => `  - ${file}: ${name}`).join('\n');
    throw new Error(`VITE_-prefixed secret variables must not be committed:\n${details}`);
  }
  const localFindings = findingsInFiles(rootDir, local);
  if (localFindings.length > 0) {
    const details = localFindings.map(({ file, name }) => `  - ${file}: ${name}`).join('\n');
    const message = `local VITE_-prefixed secret variables would be exposed by Vite:\n${details}\nRename them without the VITE_ prefix before building.`;
    if (options.failOnLocal) throw new Error(message);
    warn(`WARNING: ${message}`);
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) {
  try {
    runViteEnvSecretGuard(process.cwd(), { failOnLocal: process.argv.includes('--strict-local') });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
