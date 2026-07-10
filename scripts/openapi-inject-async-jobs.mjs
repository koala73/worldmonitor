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
 * (e.g. ora.ai / orank `async-job-pattern`) that fall back to the published
 * spec for auth-gated routes then see the documented pattern.
 *
 * Wired into `make generate` (LAST, after the other OpenAPI injectors — the
 * examples injector stamps the success example while the response is still
 * keyed "200"; the rename carries it along, and its standalone rerun matches
 * any 2xx so the committed "202" stays stable). Exposed as
 * `npm run gen:openapi:async-jobs`. Idempotent + byte-faithful (JSON
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
const ASYNC_JOB_OPS = [
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
function injectJson(spec) {
  let changed = false;
  for (const target of ASYNC_JOB_OPS) {
    const op = spec.paths?.[target.path]?.[target.method];
    if (!op || typeof op !== 'object' || !op.responses) continue;
    // Rename the generated 200 success to 202 (content/example ride along).
    // Both present never occurs in practice (regen emits 200-only, the
    // committed tree is 202-only); if it ever does, the 200 is a stale
    // duplicate of the same success payload.
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
// blocks). The success headers block is SHARED with
// openapi-inject-idempotency.mjs, which stamps the replay-marker headers
// (Idempotency-Key, Idempotent-Replayed) onto the success response earlier in
// the chain — so this injector only ever merges its Location ENTRY into the
// block, never replaces the block.
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

function replaceLinesIfDifferent(lines, start, blockEnd, replacement) {
  const current = lines.slice(start, blockEnd);
  if (current.length === replacement.length && current.every((line, idx) => line === replacement[idx])) {
    return 0;
  }
  lines.splice(start, blockEnd - start, ...replacement);
  return replacement.length - (blockEnd - start);
}

function injectYaml(text) {
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
    const responsesEnd = blockEndAtIndent(lines, responsesIndex, opEnd, 12);

    // 1. Rename the `"200":` status key line to `"202":` (children intact).
    let acceptedIndex = -1;
    for (let j = responsesIndex + 1; j < responsesEnd; j++) {
      if (/^ {16}"202":\s*$/.test(lines[j])) {
        acceptedIndex = j;
        break;
      }
      if (/^ {16}"200":\s*$/.test(lines[j])) {
        lines[j] = lines[j].replace('"200":', '"202":');
        acceptedIndex = j;
        changed = true;
        break;
      }
    }
    if (acceptedIndex === -1) continue;
    let acceptedEnd = blockEndAtIndent(lines, acceptedIndex, responsesEnd, 16);

    // 2. Replace the success description (single-line, first 20-indent
    //    `description:` child of the 202 block).
    let descriptionIndex = -1;
    for (let j = acceptedIndex + 1; j < acceptedEnd; j++) {
      if (/^ {20}description: /.test(lines[j])) {
        descriptionIndex = j;
        break;
      }
    }
    if (descriptionIndex !== -1) {
      const descriptionLine = `                    description: ${target.description}`;
      if (lines[descriptionIndex] !== descriptionLine) {
        lines[descriptionIndex] = descriptionLine;
        changed = true;
      }
    }

    // 3. Merge the Location entry into the 202 headers block (see the
    //    shared-ownership note above yamlLocationEntry). When the block is
    //    missing entirely (no idempotency headers — cannot happen in the
    //    canonical chain, where every POST gets them), create it after the
    //    description line, before `content:`.
    const locationLines = yamlLocationEntry(target);
    let headersIndex = -1;
    for (let j = acceptedIndex + 1; j < acceptedEnd; j++) {
      if (/^ {20}headers:\s*$/.test(lines[j])) {
        headersIndex = j;
        break;
      }
    }
    if (headersIndex === -1) {
      const insertAt = descriptionIndex !== -1 ? descriptionIndex + 1 : acceptedIndex + 1;
      lines.splice(insertAt, 0, '                    headers:', ...locationLines);
      changed = true;
      continue;
    }
    const headersEnd = blockEndAtIndent(lines, headersIndex, acceptedEnd, 20);
    let locationIndex = -1;
    for (let j = headersIndex + 1; j < headersEnd; j++) {
      if (/^ {24}Location:\s*$/.test(lines[j])) {
        locationIndex = j;
        break;
      }
    }
    if (locationIndex === -1) {
      // Append after the existing entries — mirrors the sorted JSON key order
      // (Idempotency-Key, Idempotent-Replayed, Location).
      lines.splice(headersEnd, 0, ...locationLines);
      changed = true;
    } else {
      // Location entry sub-block ends at the next 24-indent sibling entry or
      // the end of the headers block.
      let locationEnd = locationIndex + 1;
      while (locationEnd < headersEnd && !/^ {0,24}\S/.test(lines[locationEnd])) locationEnd++;
      const delta = replaceLinesIfDifferent(lines, locationIndex, locationEnd, locationLines);
      if (delta !== 0) changed = true;
    }
  }

  return { text: lines.join('\n'), changed };
}

// ── Run ──────────────────────────────────────────────────────────────────────
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
