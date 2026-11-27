#!/usr/bin/env node
/**
 * Runs a list of package.json scripts in parallel with bounded concurrency,
 * buffers each script's output so logs do not interleave, runs every check to
 * completion so CI reports all failures in one pass, and exits non-zero if
 * any check fails or any script name is missing.
 *
 * Usage:
 *   node scripts/run-parallel-checks.mjs [--concurrency=4] <script> [<script> ...]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { isMainModule } from './lib/main-module.mjs';

export function resolveScripts(names, cwd = process.cwd()) {
  if (!names.length) throw new Error('Supply at least one package.json script name');
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  const scripts = pkg?.scripts ?? {};
  return names.map((name) => {
    const command = scripts[name];
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error(`Unknown or empty package.json script: ${name}`);
    }
    return { name, command };
  });
}

function runOne({ name, command }, cwd, env) {
  return new Promise((done) => {
    const t0 = performance.now();
    const chunks = [];
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    child.on('error', (err) => {
      done({
        name,
        code: 1,
        signal: null,
        durationMs: Math.round(performance.now() - t0),
        output: `${Buffer.concat(chunks).toString('utf8')}\n${err.message}`.trim(),
      });
    });
    child.on('close', (code, signal) => {
      done({
        name,
        code: code ?? 1,
        signal,
        durationMs: Math.round(performance.now() - t0),
        output: Buffer.concat(chunks).toString('utf8').trim(),
      });
    });
  });
}

export async function runParallelChecks(names, { concurrency = 4, cwd = process.cwd(), serial = [] } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Concurrency must be a positive integer');
  }
  const serialJobs = serial.length ? resolveScripts(serial, cwd) : [];
  const jobs = names.length ? resolveScripts(names, cwd) : [];
  if (!serialJobs.length && !jobs.length) {
    throw new Error('Supply at least one package.json script name');
  }
  const binDir = resolve(cwd, 'node_modules/.bin');
  const env = {
    ...process.env,
    PATH: process.env.PATH ? `${binDir}${delimiter}${process.env.PATH}` : binDir,
  };
  const serialResults = [];
  for (const job of serialJobs) {
    serialResults.push(await runOne(job, cwd, env));
  }
  const results = new Array(jobs.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, jobs.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < jobs.length) {
        const idx = nextIndex++;
        results[idx] = await runOne(jobs[idx], cwd, env);
      }
    }),
  );
  return [...serialResults, ...results];
}

export async function main(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      concurrency: { type: 'string', default: '4' },
      serial: { type: 'string', multiple: true, default: [] },
    },
  });
  if (!/^[1-9]\d*$/.test(values.concurrency) || !Number.isSafeInteger(Number(values.concurrency))) {
    throw new Error('Concurrency must be a positive integer');
  }
  const t0 = performance.now();
  const results = await runParallelChecks(positionals, {
    concurrency: Number(values.concurrency),
    cwd,
    serial: values.serial,
  });
  const totalMs = Math.round(performance.now() - t0);
  const failed = results.filter((r) => r.code !== 0 || r.signal !== null);

  for (const r of results) {
    const status = r.code === 0 && r.signal === null ? 'PASS' : 'FAIL';
    const detail = r.signal ? `signal ${r.signal}` : `exit ${r.code}`;
    const line = `${status} ${r.name} (${r.durationMs}ms${status === 'FAIL' ? `, ${detail}` : ''})\n`;
    (status === 'FAIL' ? stderr : stdout).write(line);
    if (status === 'FAIL' && r.output) {
      stderr.write(`--- ${r.name} ---\n${r.output}\n--- end ${r.name} ---\n`);
    }
  }
  stdout.write(
    `Checks complete: ${results.length - failed.length}/${results.length} passed in ${(totalMs / 1000).toFixed(2)}s (concurrency ${values.concurrency}).\n`,
  );
  if (failed.length > 0) {
    stderr.write(`Failed checks (${failed.length}): ${failed.map((r) => r.name).join(', ')}\n`);
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
