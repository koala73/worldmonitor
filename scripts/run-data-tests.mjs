#!/usr/bin/env node
import { closeSync, existsSync, globSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { parseArgs } from 'node:util';
import { isMainModule } from './lib/main-module.mjs';

const timingPath = new URL('./shared/data-test-durations.json', import.meta.url);

export function partitionTests(files, durations, total) {
  if (!Number.isSafeInteger(total) || total < 1) throw new Error('Shard count must be a positive integer');
  for (const duration of Object.values(durations)) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Test durations must be positive numbers');
  }
  const estimate = (file) => durations[file] ?? 1000;
  const ordered = [...new Set(files)].sort((a, b) => estimate(b) - estimate(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: total }, () => ({ files: [], duration: 0 }));
  for (const file of ordered) {
    const shard = shards.reduce((least, next) => next.duration < least.duration ? next : least);
    shard.files.push(file);
    shard.duration += estimate(file);
  }
  return shards.map(({ files: selected }) => selected);
}

export async function main(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      shard: { type: 'string' },
      concurrency: { type: 'string', default: '4' },
      list: { type: 'boolean', default: false },
      timings: { type: 'string' },
      'test-name-pattern': { type: 'string' },
    },
  });
  if (!/^[1-9]\d*$/.test(values.concurrency) || !Number.isSafeInteger(Number(values.concurrency))) {
    throw new Error('Concurrency must be a positive integer');
  }
  let index = 1;
  let total = 1;
  if (values.shard) {
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(values.shard);
    if (!match) throw new Error('Shard must be INDEX/TOTAL (for example 1/2)');
    [index, total] = match.slice(1).map(Number);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
      throw new Error('Shard index must be between 1 and TOTAL');
    }
  }
  if (!positionals.length) throw new Error('Supply test files or globs');
  const files = [...new Set(positionals.flatMap((pattern) => {
    const matches = (existsSync(pattern) && statSync(pattern).isFile() ? [pattern] : globSync(pattern))
      .map((file) => file.split(sep).join('/'));
    if (!matches.length) throw new Error(`No test files match ${pattern}`);
    return matches;
  }))];
  const durations = JSON.parse(readFileSync(timingPath, 'utf8'));
  if (total > files.length) throw new Error('Shard count exceeds the test file count');
  const selected = partitionTests(files, durations, total)[index - 1];
  if (!selected.length) throw new Error('The selected shard contains no test files');
  if (values.list) {
    console.log(JSON.stringify(selected));
    return 0;
  }
  console.log(`Data tests: ${selected.length}/${files.length} files, shard ${index}/${total}, concurrency ${values.concurrency}`);
  const env = { ...process.env };
  // This is a new test run, even when a contract test invokes the CLI.
  delete env.NODE_TEST_CONTEXT;
  const timingFd = values.timings ? openSync(values.timings, 'w') : undefined;
  let success = false;
  try {
    const events = run({
      files: selected.map((file) => resolve(file)),
      concurrency: Number(values.concurrency),
      timeout: 120000,
      execArgv: ['--import', 'tsx'],
      testNamePatterns: values['test-name-pattern'],
      env,
    });
    events.on('test:summary', (data) => {
      if (!data.file) success = data.success;
      if (timingFd !== undefined) writeSync(timingFd, `${JSON.stringify({
        file: data.file ? relative(process.cwd(), data.file).split(sep).join('/') : null,
        duration_ms: data.duration_ms,
        counts: data.counts,
        success: data.success,
      })}\n`);
    });
    await pipeline(events, new spec(), process.stdout, { end: false });
    return success ? 0 : 1;
  } finally {
    if (timingFd !== undefined) closeSync(timingFd);
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
