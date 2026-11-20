#!/usr/bin/env node
// Run a Cloudflare CLI command (wrangler) and retry it with backoff only when
// the Cloudflare API rate-limits it ([code: 10429]). Every other failure exits
// immediately with the command's own code.
//
// Why: deploy-worker.yml run 41960944579 (2026-11-05) failed its first API
// call with 10429, so #9881 never reached production and the post-merge deploy
// monitor stayed red until someone re-ran the deploy by hand.
//
// Usage: node scripts/cf-rate-limit-retry.mjs <command> [args...]
// CF_RATE_LIMIT_RETRY_DELAYS_MS overrides the comma-separated backoff
// (default 15000,30000,60000 → up to 4 attempts).

import { spawn } from 'node:child_process';

const RATE_LIMIT = /\[code: 10429\]/;
const DEFAULT_DELAYS_MS = [15_000, 30_000, 60_000];

function parseDelays(raw) {
  if (raw === undefined || raw === '') return DEFAULT_DELAYS_MS;
  const delays = raw.split(',').map((part) => Number(part.trim()));
  if (delays.some((ms) => !Number.isInteger(ms) || ms < 0)) {
    throw new Error(`CF_RATE_LIMIT_RETRY_DELAYS_MS must be comma-separated non-negative integers, got "${raw}"`);
  }
  return delays;
}

function runOnce(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      output += chunk;
    });
    child.on('error', (err) => {
      process.stderr.write(`cf-rate-limit-retry: failed to start ${command}: ${err.message}\n`);
      resolve({ code: 127, output });
    });
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), output }));
  });
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('usage: node scripts/cf-rate-limit-retry.mjs <command> [args...]\n');
  process.exit(2);
}

let delays;
try {
  delays = parseDelays(process.env.CF_RATE_LIMIT_RETRY_DELAYS_MS);
} catch (err) {
  process.stderr.write(`cf-rate-limit-retry: ${err.message}\n`);
  process.exit(2);
}

const maxAttempts = delays.length + 1;
for (let attempt = 1; ; attempt++) {
  const { code, output } = await runOnce(command, args);
  if (code === 0) process.exit(0);
  if (!RATE_LIMIT.test(output)) process.exit(code);
  if (attempt === maxAttempts) {
    process.stderr.write(`cf-rate-limit-retry: still rate limited after ${maxAttempts} attempts; giving up\n`);
    process.exit(code);
  }
  const delayMs = delays[attempt - 1];
  process.stderr.write(
    `cf-rate-limit-retry: Cloudflare API rate limited (10429); retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1} of ${maxAttempts})\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
