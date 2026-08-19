#!/usr/bin/env node
/**
 * Document the REST async-job pattern on async-enqueue operations in the
 * generated OpenAPI specs.
 *
 * RunScenario enqueues a background job and returns immediately; the runtime
 * (server/worldmonitor/scenario/v1/run-scenario.ts via the
 * setSuccessStatusOverride gateway side-channel) answers a successful enqueue
 * with 202 Accepted plus a Location header pointing at the GetScenarioStatus
 * poll endpoint — restoring the legacy pre-sebuf contract. The sebuf
 * `protoc-gen-openapiv3` plugin has no per-RPC status-code annotation (it
 * emits a 200 for every success), so this post-generation step renames the
 * generated "200" success response to "202" and documents the Location
 * header across the per-service JSON + YAML specs and the bundle. Scanners
 * that do not understand 202 must be configured separately; the canonical
 * public contract must not advertise a status the handler never returns.
 *
 * Wired into `make generate` after the other response-shaping injectors — the
 * examples injector stamps the success example while the response is still
 * keyed "200"; the rename carries it along to "202", and its
 * standalone rerun matches any 2xx so the committed "202" stays stable.
 * Exposed as `npm run gen:openapi:async-jobs`. Idempotent + byte-faithful (JSON
 * re-serialized with the shared sorted, Go-escaped strategy; YAML via
 * surgical line edits). See the orank Access-layer work (#4698, #4728).
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, serialize } from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');

// Async-enqueue operations. `locationExample` must mirror the curated
// statusUrl body example in openapi-inject-examples.mjs (the contract test
// asserts they agree).
export const ASYNC_JOB_OPS = [
  {
    path: '/api/scenario/v1/run-scenario',
    method: 'post',
    description:
      'Accepted — scenario job enqueued. The body carries the job id (jobId), the initial status (always pending) and a poll URL (statusUrl); the Location header points at the same GetScenarioStatus endpoint. Poll it until status is done or failed.',
    locationDescription:
      'Relative URL of the job-status poll endpoint for this job (same value as the statusUrl body field).',
    locationExample:
      '/api/scenario/v1/get-scenario-status?jobId=scenario%3A1717200000000%3Aabcd1234',
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function locationHeaderFor(target) {
  return {
    description: target.locationDescription,
    example: target.locationExample,
    schema: { type: 'string' },
  };
}

// ── Per-service JSON ────────────────────────────────────────────────────────
// Object-key order is irrelevant (the shared serializer sorts recursively);
// only membership + values matter for byte-faithful output.
export function injectJson(spec) {
  let changed = false;
  for (const target of ASYNC_JOB_OPS) {
    const op = spec.paths?.[target.path]?.[target.method];
    if (!op || typeof op !== 'object' || !op.responses) continue;
    // Rename the generated 200 success to the status returned by the live
    // handler. If both exist, retain the already-shaped 202 and remove the
    // stale 200 twin.
    if (op.responses['200']) {
      if (!op.responses['202']) op.responses['202'] = op.responses['200'];
      delete op.responses['200'];
      changed = true;
    }
    const accepted = op.responses['202'];
    if (!accepted || typeof accepted !== 'object') continue;
    if (accepted.description !== target.description) {
      accepted.description = target.description;
      changed = true;
    }
    const header = locationHeaderFor(target);
    accepted.headers ??= {};
    if (!eq(accepted.headers.Location, header)) {
      accepted.headers.Location = clone(header);
      changed = true;
    }
  }
  return changed;
}

// ── YAML (formatting-preserving surgical edits) ─────────────────────────────
// Path lines at 4 spaces, method lines at 8, `responses:` at 12, status-code
// keys at 16, response children (`description:`, `headers:`, `content:`) at
// 20, header entries at 24 — matching the generator's output and the sibling
// injectors (schema first, then description, like the idempotency 409/422
// blocks). The idempotency injector stamps replay-marker headers on the
// generated success before this injector renames it, so this step only merges
// Location and preserves the other headers.
function yamlLocationEntry(target) {
  return [
    '                        Location:',
    '                            schema:',
    '                                type: string',
    `                            description: ${target.locationDescription}`,
    `                            example: "${target.locationExample}"`,
  ];
}

function blockEndAtIndent(lines, start, end, indent) {
  // First line after `start` that is non-empty and indented <= indent.
  const boundary = new RegExp(`^ {0,${indent}}\\S`);
  let i = start + 1;
  while (i < end && !boundary.test(lines[i])) i++;
  return i;
}

// Reports whether it spliced, SEPARATELY from the line delta. Inferring "did
// anything change?" from the delta silently drops equal-line-count edits: a
// same-length replacement is a real rewrite that returns delta 0, so a caller
// gating on `delta !== 0` would leave the file unwritten AND report --check
// green. openapi-inject-idempotency.mjs carries the same contract.
function replaceLinesIfDifferent(lines, start, blockEnd, replacement) {
  const current = lines.slice(start, blockEnd);
  if (current.length === replacement.length && current.every((line, idx) => line === replacement[idx])) {
    return { delta: 0, replaced: false };
  }
  lines.splice(start, blockEnd - start, ...replacement);
  return { delta: replacement.length - (blockEnd - start), replaced: true };
}

// Response-block locators. Every step re-derives its own indices against a
// freshly recomputed end bound, so a splice in one step can never leave a
// later step reading a stale offset.
function findResponseBlock(lines, responsesIndex, code) {
  const end = blockEndAtIndent(lines, responsesIndex, lines.length, 12);
  const key = new RegExp(`^ {16}"${code}":\\s*$`);
  for (let j = responsesIndex + 1; j < end; j++) {
    if (key.test(lines[j])) return { start: j, end: blockEndAtIndent(lines, j, end, 16) };
  }
  return null;
}

function findHeadersBlock(lines, block) {
  for (let j = block.start + 1; j < block.end; j++) {
    if (/^ {20}headers:\s*$/.test(lines[j])) {
      return { start: j, end: blockEndAtIndent(lines, j, block.end, 20) };
    }
  }
  return null;
}

export function injectYaml(text) {
  const lines = text.split('\n');
  let changed = false;

  for (const target of ASYNC_JOB_OPS) {
    // Locate the op block: `    /path:` then `        <method>:` inside it.
    let opStart = -1;
    let opEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith(`    ${target.path}:`)) continue;
      const pathEnd = blockEndAtIndent(lines, i, lines.length, 4);
      for (let j = i + 1; j < pathEnd; j++) {
        if (new RegExp(`^ {8}${target.method}:\\s*$`).test(lines[j])) {
          opStart = j;
          opEnd = blockEndAtIndent(lines, j, pathEnd, 8);
          break;
        }
      }
      break;
    }
    if (opStart === -1) continue;

    let responsesIndex = -1;
    for (let j = opStart + 1; j < opEnd; j++) {
      if (/^ {12}responses:\s*$/.test(lines[j])) {
        responsesIndex = j;
        break;
      }
    }
    if (responsesIndex === -1) continue;
    // Rename a generated 200-only block. If a stale 200 twin is present next
    // to the real 202, remove it and preserve the already-shaped 202.
    const okBlock = findResponseBlock(lines, responsesIndex, '200');
    let acceptedBlock = findResponseBlock(lines, responsesIndex, '202');
    if (okBlock) {
      if (acceptedBlock) {
        lines.splice(okBlock.start, okBlock.end - okBlock.start);
      } else {
        lines[okBlock.start] = lines[okBlock.start].replace('"200":', '"202":');
      }
      changed = true;
      acceptedBlock = findResponseBlock(lines, responsesIndex, '202');
    }
    if (!acceptedBlock) continue;

    for (let j = acceptedBlock.start + 1; j < acceptedBlock.end; j++) {
      if (!/^ {20}description: /.test(lines[j])) continue;
      const descriptionLine = `                    description: ${target.description}`;
      if (lines[j] !== descriptionLine) {
        lines[j] = descriptionLine;
        changed = true;
      }
      break;
    }

    acceptedBlock = findResponseBlock(lines, responsesIndex, '202');
    const locationLines = yamlLocationEntry(target);
    const headers = findHeadersBlock(lines, acceptedBlock);
    if (!headers) {
      let insertAt = acceptedBlock.start + 1;
      for (let j = acceptedBlock.start + 1; j < acceptedBlock.end; j++) {
        if (/^ {20}description: /.test(lines[j])) insertAt = j + 1;
        if (/^ {20}content:\s*$/.test(lines[j])) break;
      }
      lines.splice(insertAt, 0, '                    headers:', ...locationLines);
      changed = true;
      continue;
    }

    let locationStart = -1;
    for (let j = headers.start + 1; j < headers.end; j++) {
      if (/^ {24}Location:\s*$/.test(lines[j])) {
        locationStart = j;
        break;
      }
    }
    if (locationStart === -1) {
      lines.splice(headers.end, 0, ...locationLines);
      changed = true;
      continue;
    }
    let locationEnd = locationStart + 1;
    while (locationEnd < headers.end && !/^ {0,24}\S/.test(lines[locationEnd])) locationEnd++;
    const { replaced } = replaceLinesIfDifferent(lines, locationStart, locationEnd, locationLines);
    if (replaced) changed = true;
  }

  return { text: lines.join('\n'), changed };
}

// ── Run ──────────────────────────────────────────────────────────────────────
// Only run the CLI (read/write/log/exit) when invoked directly — importing this
// module for ASYNC_JOB_OPS / injectJson / injectYaml (the contract tests do)
// must be side-effect-free. Mirrors openapi-inject-webhooks.mjs.
const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const jsonFiles = readdirSync(apiDir).filter((f) => /Service\.openapi\.json$/.test(f)).sort();
  const yamlFiles = readdirSync(apiDir)
    .filter((f) => /Service\.openapi\.yaml$/.test(f) || f === 'worldmonitor.openapi.yaml')
    .sort();
  let wouldChange = 0;
  const touched = [];

  for (const file of jsonFiles) {
    const path = resolve(apiDir, file);
    const spec = JSON.parse(readFileSync(path, 'utf8'));
    if (injectJson(spec)) {
      wouldChange++;
      touched.push(file);
      if (!CHECK) writeFileSync(path, serialize(spec));
    }
  }

  for (const file of yamlFiles) {
    const path = resolve(apiDir, file);
    const result = injectYaml(readFileSync(path, 'utf8'));
    if (result.changed) {
      wouldChange++;
      touched.push(file);
      if (!CHECK) writeFileSync(path, result.text);
    }
  }

  if (CHECK) {
    if (wouldChange > 0) {
      console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing the async-job 202 contract: ${touched.join(', ')}`);
      console.error('  Run: npm run gen:openapi:async-jobs');
      process.exit(1);
    }
    console.log('✓ async-job 202 + Location contract in sync across async-enqueue operations');
  } else {
    console.log(`openapi-inject-async-jobs: updated ${wouldChange} artifact(s)`);
  }
}
