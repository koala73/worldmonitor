#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { isMainModule } from '../../scripts/lib/main-module.mjs';

const KEY_PREFIX = 'codeql-overlay-base-database-';
const KEY_PATTERN =
  /^codeql-overlay-base-database-(\d+)-([0-9a-f]{16})-([a-z0-9_]+)-(\d+\.\d+\.\d+)-([0-9a-f]{40})-(\d+)-(\d+)$/;

function parseKey(key) {
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  const [, cacheVersion, hash, langs, codeqlVersion, sha, runId, runAttempt] = match;
  return { cacheVersion, hash, langs, codeqlVersion, sha, runId: BigInt(runId), runAttempt: BigInt(runAttempt) };
}

function compareNewest(a, b) {
  const byTime = Date.parse(b.entry.createdAt) - Date.parse(a.entry.createdAt);
  if (byTime) return byTime;
  if (a.parsed.runId !== b.parsed.runId) return a.parsed.runId > b.parsed.runId ? -1 : 1;
  if (a.parsed.runAttempt !== b.parsed.runAttempt) return a.parsed.runAttempt > b.parsed.runAttempt ? -1 : 1;
  return 0;
}

// The group omits the CodeQL version: once a newer-CLI base exists, an older-CLI base can never be restored.
export function selectStaleOverlayBases(entries, ref) {
  const ignored = [];
  const groups = new Map();
  for (const entry of entries) {
    const parsed = entry.ref === ref ? parseKey(entry.key) : null;
    if (!parsed || !Number.isFinite(Date.parse(entry.createdAt))) {
      ignored.push(entry);
      continue;
    }
    const group = `${parsed.cacheVersion}/${parsed.hash}/${parsed.langs}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ entry, parsed });
  }
  const keep = [];
  const stale = [];
  for (const members of groups.values()) {
    const [newest, ...rest] = members.sort(compareNewest);
    keep.push(newest.entry);
    stale.push(...rest.map(member => member.entry));
  }
  return { keep, stale, ignored };
}

export function parseArgs(argv) {
  const options = { ref: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--ref' && argv[i + 1] && !argv[i + 1].startsWith('--')) options.ref = argv[++i];
    else if (argv[i] !== '--ref') throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!options.ref) throw new Error('Usage: prune-codeql-overlay-bases.mjs --ref <ref> [--dry-run]');
  return options;
}

function gh(run, args) {
  const result = run('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

export function pruneOverlayBases({ ref, dryRun = false, run = spawnSync, log = console.log }) {
  const listed = gh(run, [
    'cache', 'list', '--ref', ref, '--key', KEY_PREFIX, '--limit', '1000',
    '--json', 'id,key,ref,createdAt,sizeInBytes',
  ]);
  if (listed.status !== 0) throw new Error(`gh cache list failed: ${listed.stderr || listed.status}`);
  const { keep, stale, ignored } = selectStaleOverlayBases(JSON.parse(listed.stdout), ref);
  for (const entry of ignored) {
    log(`::warning title=Overlay base not pruned::Unrecognised cache key ${entry.key}; update KEY_PATTERN in prune-codeql-overlay-bases.mjs`);
  }
  let deleted = 0;
  let freed = 0;
  let failed = 0;
  for (const entry of stale) {
    if (dryRun) {
      log(`would delete ${entry.id} ${entry.key} (${entry.sizeInBytes} bytes)`);
      deleted++;
      freed += entry.sizeInBytes;
      continue;
    }
    const result = run('gh', ['cache', 'delete', String(entry.id)], { encoding: 'utf8' });
    const output = result.error ? result.error.message : `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    if (!result.error && (result.status === 0 || /Could not find a cache matching/i.test(output))) {
      log(`deleted ${entry.id} ${entry.key} (${entry.sizeInBytes} bytes)`);
      deleted++;
      freed += entry.sizeInBytes;
    } else {
      log(`failed to delete ${entry.id} ${entry.key}: ${output || `exit ${result.status}`}`);
      failed++;
    }
  }
  log(
    dryRun
      ? `dry run: kept ${keep.length}, would delete ${deleted}, would free ${freed} bytes`
      : `kept ${keep.length}, deleted ${deleted}, freed ${freed} bytes${failed ? `, ${failed} failed` : ''}`,
  );
  return { kept: keep.length, deleted, freed, failed, exitCode: failed ? 1 : 0 };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = pruneOverlayBases(parseArgs(process.argv.slice(2))).exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
