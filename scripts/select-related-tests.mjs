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
// when its static, dynamic, template-literal or tsconfig-aliased (`@/…`) imports
// reach a changed file.
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
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"`]([^'"`?$\s]+)/gm;
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

// tsconfig.json `paths` with a trailing `/*`, as tsx applies them: `@/*` -> `./src/*`.
// Returns null when the aliases cannot be known for certain: a config that does
// not parse once whole-line comments are dropped, or one that `extends` another
// file (which may hold the paths). The caller then selects every test, because
// a missed alias would silently skip tests rather than run extra ones.
export function readPathAliases(root = ROOT) {
  let text;
  try {
    text = readFileSync(join(root, 'tsconfig.json'), 'utf8');
  } catch (error) {
    // No config means no aliases; a config that exists but cannot be read is unknown.
    return error.code === 'ENOENT' ? [] : null;
  }
  let config;
  try {
    config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    return null;
  }
  if (config.extends) return null;
  return Object.entries(config.compilerOptions?.paths ?? {})
    .filter(([pattern, targets]) => pattern.endsWith('/*') && targets[0]?.endsWith('/*'))
    .map(([pattern, targets]) => [pattern.slice(0, -1), posix.normalize(targets[0].slice(0, -1))]);
}

// Resolves a relative or tsconfig-aliased import the way Node and tsx do. A
// changed path counts even when it no longer exists, so a test that imports a
// deleted file is selected.
function resolveImport(root, fromFile, spec, changedSet, aliases) {
  let base;
  if (spec.startsWith('./') || spec.startsWith('../')) base = posix.join(posix.dirname(fromFile), spec);
  else {
    const alias = aliases.find(([prefix]) => spec.startsWith(prefix));
    if (!alias) return null;
    base = posix.join(alias[1], spec.slice(alias[0].length));
  }
  const candidates = RESOLVE_SUFFIXES.map((suffix) => base + suffix);
  // tsx resolves `./x.js` to `./x.ts`.
  if (base.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  return candidates.find((file) => {
    const path = join(root, file);
    return existsSync(path) && statSync(path).isFile();
  }) ?? candidates.find((file) => changedSet.has(file)) ?? null;
}

// True when `needle` occurs in `text` and is not the start of a longer name
// (`src/feature` must not match `src/feature-flags`).
function namesPath(text, needle) {
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (!/[\w-]/.test(text[at + needle.length] ?? '')) return true;
  }
  return false;
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
  const aliases = readPathAliases(root);
  if (aliases === null) return [...inventory];
  const read = (file) => {
    try { return readSource(file); } catch { return ''; }
  };
  // Import graph of everything the tests load, then a backward walk from the
  // changed files. Walking backward needs no per-file cache, so an import cycle
  // cannot record a partial answer for one of its members.
  const importers = new Map();
  const seen = new Set();
  const pending = [...inventory];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!SOURCE_FILE.test(file) || changedSet.has(file) && !existsSync(join(root, file))) continue;
    for (const match of read(file).matchAll(IMPORT_SPEC)) {
      const target = resolveImport(root, file, match[1], changedSet, aliases);
      if (!target) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
      pending.push(target);
    }
  }
  const affected = new Set(changed);
  const frontier = [...changed];
  while (frontier.length) {
    for (const importer of importers.get(frontier.pop()) ?? []) {
      if (!affected.has(importer)) {
        affected.add(importer);
        frontier.push(importer);
      }
    }
  }
  return inventory.filter((test) => {
    if (affected.has(test)) return true;
    const text = read(test);
    for (const needle of needles) if (namesPath(text, needle)) return true;
    return false;
  });
}

function git(root, args) {
  // Drop git's hook-time variables so a call from inside a hook still reads this checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env });
}

// Committed, staged, unstaged and untracked changes since the merge base with `base`.
// --no-renames lists both paths of a rename, so tests that import the old path run.
export function changedFiles(root = ROOT, base = 'origin/main') {
  let mergeBase;
  try {
    mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  } catch {
    throw new Error(`Cannot find a merge base with "${base}". Fetch it or pass --base <ref>.`);
  }
  const tracked = git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase]).split('\0');
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
    else if (arg === '--base' || arg.startsWith('--base=')) {
      const value = arg === '--base' ? args[++index] : arg.slice('--base='.length);
      if (!value) throw new Error('--base requires a ref');
      base = value;
    } else runnerArgs.push(arg);
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
  // The preparation `npm run test:data` gets from pretest:data. --list stays read-only.
  const dates = spawnSync(process.execPath, [join(ROOT, 'scripts/generate-docs-page-dates.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (dates.status !== 0) return dates.status ?? 1;
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
