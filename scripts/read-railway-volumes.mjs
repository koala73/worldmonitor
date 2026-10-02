#!/usr/bin/env node

/**
 * Read the production Railway volume list for the Umami storage monitor.
 *
 * `railway volume list` is a project-wide GraphQL query. It usually answers in
 * a second, but on 2026-09-28 it took 44-70 s and sometimes hit the CLI's ~90 s
 * request timeout, failing 7 of 35 scheduled runs while a service-scoped call
 * one second later answered in 1-3 s. A transport failure (a timeout, a
 * dropped or refused connection, a 502-504) is retried; an error a retry cannot
 * fix (a bad token, an unknown project) fails at once.
 *
 * Writes `read=true|false` to $GITHUB_OUTPUT. When Railway stays unreachable
 * it warns and writes `read=false` without an output file, and the workflow
 * falls back to a check on the stored samples, which fails once they are too
 * old or last measured critical.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs as parseNodeArgs } from 'node:util';

import { isMainModule } from './lib/main-module.mjs';

export const RAILWAY_VOLUME_READ_POLICY = Object.freeze({
  attempts: 2,
  // A backstop above the CLI's own ~90 s request timeout, so a hung CLI cannot
  // spend the whole job and starve the retention alarm after it.
  attemptTimeoutMs: 100_000,
  retryDelayMs: 5_000,
});

const TRANSIENT_ERROR = /operation timed out|error sending request|connection (?:reset|refused|closed)|\b(?:502|503|504)\b/i;

function runRailway(args, timeoutMs) {
  return new Promise((resolve) => {
    // @railway/cli's npm wrapper runs the real binary with stdio: 'inherit'.
    // Killing only the wrapper leaves the binary holding both pipes, and
    // `close` never fires, so the attempt gets its own process group.
    const child = spawn('railway', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}\n`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function setOutput(read) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `read=${read}\n`);
}

function writeAtomically(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, contents, 'utf8');
  renameSync(temporaryPath, path);
}

function parseArguments(argv) {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      output: { type: 'string' },
      'attempt-timeout-ms': { type: 'string' },
      'retry-delay-ms': { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!args.output) throw new Error('Provide the volume list path with --output <path>');
  if (!projectId) throw new Error('RAILWAY_PROJECT_ID is required');
  const attemptTimeoutMs = Number(args['attempt-timeout-ms'] ?? RAILWAY_VOLUME_READ_POLICY.attemptTimeoutMs);
  const retryDelayMs = Number(args['retry-delay-ms'] ?? RAILWAY_VOLUME_READ_POLICY.retryDelayMs);
  const railwayArgs = ['volume', '--project', projectId, '--environment', 'production', 'list', '--json'];

  for (let attempt = 1; attempt <= RAILWAY_VOLUME_READ_POLICY.attempts; attempt += 1) {
    const result = await runRailway(railwayArgs, attemptTimeoutMs);
    if (result.code === 0) {
      JSON.parse(result.stdout);
      writeAtomically(args.output, result.stdout);
      setOutput(true);
      console.log(`Read the Railway volume list on attempt ${attempt}.`);
      return;
    }
    process.stderr.write(result.stderr);
    if (!result.timedOut && !TRANSIENT_ERROR.test(result.stderr)) {
      throw new Error(`railway volume list failed with exit code ${result.code}`);
    }
    console.error(`Railway volume list attempt ${attempt} could not reach Railway.`);
    if (attempt < RAILWAY_VOLUME_READ_POLICY.attempts && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  console.error(
    `::warning::Railway API was unreachable on all ${RAILWAY_VOLUME_READ_POLICY.attempts} volume reads; `
      + 'capacity is checked against the stored samples instead.',
  );
  setOutput(false);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(`Railway volume read failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
