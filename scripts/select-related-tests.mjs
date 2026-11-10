#!/usr/bin/env node
// Selects the data tests a change can affect, for the local edit loop. CI still
// runs every file (`npm run test:data`, unit-shards), so this only decides what
// is worth running before a push.
//
//   npm run test:related                    # run the selected files
//   npm run test:related -- --list          # print them instead
//   npm run test:related -- --base <ref>    # compare against another base
//
// A test is selected when it changed, when its source names a changed path, or
// when its static, dynamic or template-literal imports reach a changed file.
// Changes to the install, TypeScript config or the runner select every file.
// The 2026-11-09 audit checked this against two sets of reverted fixes: both
// times the selection failed exactly the files the full suite failed, in 22-60 s
// instead of about 350 s.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/main-module.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELECT_ALL = /^(package(-lock)?\.json|tsconfig[^/]*\.json|scripts\/run-data-tests\.mjs|scripts\/select-related-tests\.mjs|scripts\/shared\/data-test-durations\.json)$/;
const TEST_FILE = /\.test\.m?[jt]s$/;
const SOURCE_FILE = /\.(m?[jt]sx?|cjs)$/;
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"`](\.{1,2}\/[^'"`?$]+)/gm;
const RESOLVE_SUFFIXES = ['', '.ts', '.mts', '.mjs', '.js', '.cjs', '.tsx', '.json', '/index.ts', '/index.mjs', '/index.js'];
// A bare name shorter than this (index, types, utils) matches too many files.
const MIN_BASENAME = 8;

// The file patterns `npm run test:data` passes, so both commands draw on one inventory.
export function testDataPatterns(root = ROOT) {
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['test:data'];
  return script.split(/\s+/).filter((part) => TEST_FILE.test(part));
}

export function listInventory(root = ROOT) {
  const files = testDataPatterns(root).flatMap((pattern) => globSync(pattern, { cwd: root }));
  return [...new Set(files.map((file) => file.split('\\').join('/')))].sort();
}

function resolveImport(root, fromFile, spec) {
  const base = posix.join(posix.dirname(fromFile), spec);
  const candidates = RESOLVE_SUFFIXES.map((suffix) => base + suffix);
  // tsx resolves `./x.js` to `./x.ts`.
  if (base.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  return candidates.find((file) => {
    const path = join(root, file);
    return existsSync(path) && statSync(path).isFile();
  }) ?? null;
}

export function selectRelatedTests({ root = ROOT, changed, inventory, readSource = (file) => readFileSync(join(root, file), 'utf8') }) {
  if (changed.some((file) => SELECT_ALL.test(file))) return [...inventory];
  const changedSet = new Set(changed);
  const needles = new Set();
  for (const file of changed) {
    if (TEST_FILE.test(file)) continue;
    const stem = extname(file) ? file.slice(0, -extname(file).length) : file;
    needles.add(stem);
    if (basename(stem).length >= MIN_BASENAME) needles.add(basename(stem));
  }
  const sources = new Map();
  const source = (file) => {
    if (!sources.has(file)) {
      try { sources.set(file, readSource(file)); } catch { sources.set(file, null); }
    }
    return sources.get(file);
  };
  const reaches = new Map();
  // True when `file` or anything it imports, transitively, changed.
  const reachesChange = (file, visiting = new Set()) => {
    if (reaches.has(file)) return reaches.get(file);
    if (changedSet.has(file)) return true;
    if (visiting.has(file) || !SOURCE_FILE.test(file)) return false;
    visiting.add(file);
    const text = source(file) ?? '';
    let hit = false;
    for (const match of text.matchAll(IMPORT_SPEC)) {
      const target = resolveImport(root, file, match[1]);
      if (target && reachesChange(target, visiting)) { hit = true; break; }
    }
    visiting.delete(file);
    reaches.set(file, hit);
    return hit;
  };
  return inventory.filter((test) => {
    if (changedSet.has(test)) return true;
    const text = source(test) ?? '';
    for (const needle of needles) if (text.includes(needle)) return true;
    return reachesChange(test);
  });
}

function git(root, args) {
  // Drop git's hook-time variables so a call from inside a hook still reads this checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env });
}

// Committed, staged, unstaged and untracked changes since the merge base with `base`.
export function changedFiles(root = ROOT, base = 'origin/main') {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const tracked = git(root, ['diff', '--name-only', '-z', mergeBase]).split('\0');
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

// --base <ref> and --list belong to this script; every other argument
// (--concurrency, --test-name-pattern, …) goes to scripts/run-data-tests.mjs.
export function parseCli(args) {
  let base = 'origin/main';
  let list = false;
  const runnerArgs = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--list') list = true;
    else if (arg === '--base') base = args[++index] ?? base;
    else if (arg.startsWith('--base=')) base = arg.slice('--base='.length);
    else runnerArgs.push(arg);
  }
  return { base, list, runnerArgs };
}

function main(args) {
  const { base, list, runnerArgs } = parseCli(args);
  const changed = changedFiles(ROOT, base);
  const inventory = listInventory(ROOT);
  const selected = selectRelatedTests({ root: ROOT, changed, inventory });
  if (list) {
    if (selected.length) console.log(selected.join('\n'));
    return 0;
  }
  console.log(`Related tests: ${selected.length}/${inventory.length} files for ${changed.length} changed path(s) since ${base}`);
  if (!selected.length) return 0;
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/run-data-tests.mjs'), ...runnerArgs, ...selected], { cwd: ROOT, stdio: 'inherit' });
  return result.status ?? 1;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
