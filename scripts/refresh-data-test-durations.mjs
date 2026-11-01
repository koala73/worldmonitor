#!/usr/bin/env node
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/main-module.mjs';

export function refreshDurations(previous, inventory, artifacts) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)
    || Object.values(previous).some((duration) => !Number.isFinite(duration) || duration <= 0)) {
    throw new Error('Existing duration estimates must be an object of positive numbers');
  }
  const observations = new Map();
  if (!artifacts.length) throw new Error('Supply timing JSONL files from successful CI runs');
  for (const rows of artifacts) {
    if (!rows.length || rows.at(-1).file !== null || rows.some((row) => row.success !== true)) {
      throw new Error('Every timing artifact must end with a successful aggregate summary and contain only successful summaries');
    }
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
  if (!observations.size) throw new Error('No executed current test files found in timing artifacts');
  const next = { ...previous };
  for (const [file, durations] of observations) {
    durations.sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    const median = durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
    next[file] = Math.max(1, Math.round(median));
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const target = new URL('./shared/data-test-durations.json', import.meta.url);
    const root = new URL('../', import.meta.url);
    const patterns = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
      .scripts['test:data'].trim().split(/\s+/).slice(2);
    const inventory = new Set(globSync(patterns, { cwd: fileURLToPath(root) }));
    const artifacts = process.argv.slice(2).map((path) => readFileSync(path, 'utf8').trim()
      .split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    const updated = refreshDurations(JSON.parse(readFileSync(target, 'utf8')), inventory, artifacts);
    writeFileSync(target, `${JSON.stringify(updated, null, 2)}\n`);
    console.log(`Updated duration estimates from ${artifacts.length} successful timing artifacts`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
