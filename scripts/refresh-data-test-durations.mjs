#!/usr/bin/env node
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainModule } from './lib/main-module.mjs';

function assertEstimates(previous) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)
    || Object.values(previous).some((duration) => !Number.isFinite(duration) || duration <= 0)) {
    throw new Error('Existing duration estimates must be an object of positive numbers');
  }
}

// A shard's artifact is complete when it ends with the run's aggregate summary
// and every summary in it passed. A failed or killed shard is not.
const isComplete = (rows) => rows.length > 0 && rows.at(-1).file === null && rows.every((row) => row.success === true);

function collectObservations(inventory, artifacts) {
  const observations = new Map();
  for (const rows of artifacts) {
    const seen = new Set();
    for (const { file, duration_ms: duration, counts } of rows) {
      if (file == null) continue;
      if (seen.has(file)) throw new Error(`Duplicate file summary: ${file}`);
      seen.add(file);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid duration: ${file}`);
      if (!inventory.has(file) || !(counts?.passed > 0)) continue;
      if (!observations.has(file)) observations.set(file, []);
      observations.get(file).push(duration);
    }
  }
  return observations;
}

const sortByFile = (estimates) => Object.fromEntries(Object.entries(estimates).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

export function refreshDurations(previous, inventory, artifacts) {
  assertEstimates(previous);
  if (!artifacts.length) throw new Error('Supply timing JSONL files from successful CI runs');
  if (!artifacts.every(isComplete)) {
    throw new Error('Every timing artifact must end with a successful aggregate summary and contain only successful summaries');
  }
  const observations = collectObservations(inventory, artifacts);
  if (!observations.size) throw new Error('No executed current test files found in timing artifacts');
  const next = { ...previous };
  for (const [file, durations] of observations) {
    durations.sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    const median = durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
    next[file] = Math.max(1, Math.round(median));
  }
  return sortByFile(next);
}

// What CI does after every run, passing or not: each complete shard's timings
// move a file's estimate halfway to what it measured, which follows a test that
// got slower within a few runs without letting one noisy runner decide its
// place. Failed and truncated shards are skipped rather than failing the
// refresh, and files no longer in the inventory are dropped so the estimates do
// not grow forever. Returns null when no shard completed.
export function blendDurations(previous, inventory, artifacts) {
  assertEstimates(previous);
  const complete = artifacts.filter((rows) => rows && isComplete(rows));
  if (!complete.length) return null;
  const observations = collectObservations(inventory, complete);
  const next = Object.fromEntries(Object.entries(previous).filter(([file]) => inventory.has(file)));
  for (const [file, [measured]] of observations) {
    next[file] = Math.max(1, Math.round(next[file] === undefined ? measured : (next[file] + measured) / 2));
  }
  return { estimates: sortByFile(next), shards: complete.length, measured: observations.size };
}

// A truncated last line means the shard was killed mid-write: not complete.
function parseArtifact(path, { tolerant }) {
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  try {
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    if (tolerant) return null;
    throw error;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        // CI mode: blend into --previous and write --output (see blendDurations).
        blend: { type: 'boolean', default: false },
        previous: { type: 'string' },
        output: { type: 'string' },
      },
    });
    const target = new URL('./shared/data-test-durations.json', import.meta.url);
    const root = new URL('../', import.meta.url);
    const patterns = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
      .scripts['test:data'].trim().split(/\s+/).slice(2);
    const inventory = new Set(globSync(patterns, { cwd: fileURLToPath(root) }));
    const artifacts = positionals.map((path) => parseArtifact(path, { tolerant: values.blend }));
    if (values.blend) {
      if (!values.output) throw new Error('--blend needs --output');
      const result = blendDurations(JSON.parse(readFileSync(values.previous ?? target, 'utf8')), inventory, artifacts);
      if (!result) {
        console.log(`No complete shard among ${artifacts.length} timing artifacts; nothing to save`);
      } else {
        writeFileSync(values.output, `${JSON.stringify(result.estimates, null, 2)}\n`);
        console.log(`Blended ${result.measured} measured files from ${result.shards} of ${artifacts.length} shards into ${values.output}`);
      }
    } else {
      const updated = refreshDurations(JSON.parse(readFileSync(target, 'utf8')), inventory, artifacts);
      writeFileSync(target, `${JSON.stringify(updated, null, 2)}\n`);
      console.log(`Updated duration estimates from ${artifacts.length} successful timing artifacts`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
