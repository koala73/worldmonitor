#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VITE_ENV_NAME = /^VITE_[A-Za-z0-9_]+$/;
const SECRET_NAME = /(?:api_?key|access_?token|secret|token|password|private_?key|credential)/i;
const VITE_ENV_FILE = /^\.env(?:\.[A-Za-z0-9_-]+)?(?:\.local)?$/;

function isViteSecretEnvVar(name) {
  return VITE_ENV_NAME.test(name) && SECRET_NAME.test(name);
}

function localViteEnvFiles(rootDir) {
  try {
    return readdirSync(rootDir)
      .filter(file => VITE_ENV_FILE.test(file) && existsSync(resolve(rootDir, file)));
  } catch {
    return [];
  }
}

export function findViteSecretEnvVars(source) {
  const names = new Set();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(VITE_[A-Za-z0-9_]+)\s*=/);
    if (match && isViteSecretEnvVar(match[1])) names.add(match[1]);
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

function findingsInEnvironment(env) {
  return Object.keys(env)
    .filter(isViteSecretEnvVar)
    .sort()
    .map(name => ({ file: 'process.env', name }));
}

export function runViteEnvSecretGuard(rootDir = process.cwd(), options = {}) {
  const tracked = options.trackedEnvFiles ?? trackedEnvFiles(rootDir);
  const local = options.localEnvFiles ?? localViteEnvFiles(rootDir);
  const warn = options.warn ?? console.warn;
  const committedFindings = findingsInFiles(rootDir, tracked);
  if (committedFindings.length > 0) {
    const details = committedFindings.map(({ file, name }) => `  - ${file}: ${name}`).join('\n');
    throw new Error(`VITE_-prefixed secret variables must not be committed:\n${details}`);
  }
  const localFindings = [
    ...findingsInFiles(rootDir, local),
    ...findingsInEnvironment(options.env ?? process.env),
  ];
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
