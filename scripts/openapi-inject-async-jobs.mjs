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
 * emits a 200 for every success), so this post-generation step copies the
 * generated "200" success response to "202" and documents the Location
 * header across the per-service JSON + YAML specs and the bundle.
 *
 * The typed 200 is retained on purpose. ora.ai / orank `async-job-pattern`
 * reads the 202 + Location poll contract, but `api-schema-analysis` (and
 * `response-schema-coverage`) credit only responses["200"]. Deleting the 200
 * made a fully typed spec read as "partially documented". Both codes share
 * the job-envelope schema; 200's description states that the live enqueue
 * status is 202.
 *
 * Header ownership between the pair: openapi-inject-idempotency.mjs stamps the
 * replay markers (Idempotency-Key, Idempotent-Replayed) on responses["200"]
 * ONLY. So this injector treats the 200's header block as the single source of
 * truth and REBUILDS the 202's from it on every run (adding Location, which is
 * the 202's alone). Without that, a later SUCCESS_HEADERS edit would refresh
 * the 200 — the status no client ever receives — and strand the live 202 with
 * stale prose while every --check gate stayed green.
 *
 * Wired into `make generate` after the other response-shaping injectors — the
 * examples injector stamps the success example while the response is still
 * keyed "200"; the copy in step 1 carries it along to "202", and its
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
    okDescription:
      'Job envelope with the same schema as 202 Accepted. The live handler returns 202 on enqueue; poll GetScenarioStatus until status is done or failed.',
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
    // Keep a typed 200 (scanner-credited) and a 202 (the live enqueue
    // status). Regen emits 200-only; the previously committed tree was
    // 202-only. Copy whichever is missing from the one that exists.
    if (op.responses['200'] && !op.responses['202']) {
      op.responses['202'] = clone(op.responses['200']);
      changed = true;
    }
    if (op.responses['202'] && !op.responses['200']) {
      op.responses['200'] = clone(op.responses['202']);
      changed = true;
    }
    const accepted = op.responses['202'];
    if (!accepted || typeof accepted !== 'object') continue;
    if (accepted.description !== target.description) {
      accepted.description = target.description;
      changed = true;
    }
    const ok = op.responses['200'];
    if (ok && typeof ok === 'object' && ok.description !== target.okDescription) {
      ok.description = target.okDescription;
      changed = true;
    }
    // The 200's header block is the single source of truth for the shared
    // replay markers (openapi-inject-idempotency.mjs stamps them there and
    // nowhere else). Rebuild BOTH blocks from it every run: the 200 loses
    // Location (that pointer is the live 202's alone), the 202 is the same
    // markers plus Location. Doing this unconditionally — not just when one
    // code is missing — is what keeps a later SUCCESS_HEADERS edit from
    // refreshing the dead 200 and stranding the live 202.
    const header = locationHeaderFor(target);
    if (ok && typeof ok === 'object') {
      const shared = { ...(ok.headers ?? {}) };
      delete shared.Location;
      if (!eq(ok.headers ?? {}, shared)) {
        ok.headers = shared;
        changed = true;
      }
      const acceptedHeaders = { ...clone(shared), Location: clone(header) };
      if (!eq(accepted.headers ?? {}, acceptedHeaders)) {
        accepted.headers = acceptedHeaders;
        changed = true;
      }
    } else {
      accepted.headers ??= {};
      if (!eq(accepted.headers.Location, header)) {
        accepted.headers.Location = clone(header);
        changed = true;
      }
    }
  }
  return changed;
}

// ── YAML (formatting-preserving surgical edits) ─────────────────────────────
// Path lines at 4 spaces, method lines at 8, `responses:` at 12, status-code
// keys at 16, response children (`description:`, `headers:`, `content:`) at
// 20, header entries at 24 — matching the generator's output and the sibling
// injectors (schema first, then description, like the idempotency 409/422
// blocks). openapi-inject-idempotency.mjs stamps the replay-marker headers
// (Idempotency-Key, Idempotent-Replayed) onto the 200 earlier in the chain and
// touches no other status code, so the 200's block is the source of truth: this
// injector rebuilds the 202's block from it (plus Location) rather than merging
// a lone Location entry, which is what keeps the two from drifting apart.
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

// The 24-indent header entries of a `headers:` block (name line + its
// children), excluding Location — the caller re-adds that where it belongs.
function sharedHeaderEntries(lines, headers) {
  const out = [];
  let j = headers.start + 1;
  while (j < headers.end) {
    if (!/^ {24}\S/.test(lines[j])) {
      j++;
      continue;
    }
    let k = j + 1;
    while (k < headers.end && !/^ {0,24}\S/.test(lines[k])) k++;
    if (!/^ {24}Location:\s*$/.test(lines[j])) out.push(...lines.slice(j, k));
    j = k;
  }
  return out;
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
    let responsesEnd = blockEndAtIndent(lines, responsesIndex, opEnd, 12);

    // 1. Ensure both a typed 200 (scanner-credited) and a 202 (live enqueue)
    //    exist. Regen emits 200-only; the previously committed tree is
    //    202-only. Copy whichever is missing from the one that exists.
    let acceptedIndex = -1;
    let okIndex = -1;
    for (let j = responsesIndex + 1; j < responsesEnd; j++) {
      if (/^ {16}"202":\s*$/.test(lines[j])) acceptedIndex = j;
      if (/^ {16}"200":\s*$/.test(lines[j])) okIndex = j;
    }
    if (okIndex !== -1 && acceptedIndex === -1) {
      const okEnd = blockEndAtIndent(lines, okIndex, responsesEnd, 16);
      const copy = lines.slice(okIndex, okEnd);
      copy[0] = copy[0].replace('"200":', '"202":');
      lines.splice(okIndex, 0, ...copy);
      acceptedIndex = okIndex;
      responsesEnd += copy.length;
      changed = true;
    } else if (acceptedIndex !== -1 && okIndex === -1) {
      const acceptedEndForCopy = blockEndAtIndent(lines, acceptedIndex, responsesEnd, 16);
      const copy = lines.slice(acceptedIndex, acceptedEndForCopy);
      copy[0] = copy[0].replace('"202":', '"200":');
      lines.splice(acceptedEndForCopy, 0, ...copy);
      responsesEnd += copy.length;
      changed = true;
    }
    // okIndex/acceptedIndex are deliberately not maintained past this point —
    // every step below re-locates its own block via findResponseBlock against a
    // freshly recomputed end bound, so a value shifted by the splices above
    // would be a stale trap rather than a shortcut.
    if (acceptedIndex === -1) continue;
    const locationLines = yamlLocationEntry(target);

    // Each step below re-locates its own block. Steps 2 and 3 rewrite lines in
    // place (no length change), step 4 can splice — so ordering between them is
    // irrelevant and no step inherits another's offsets.

    // 2. The 202 (live enqueue) description.
    const acceptedForDesc = findResponseBlock(lines, responsesIndex, '202');
    if (acceptedForDesc) {
      for (let j = acceptedForDesc.start + 1; j < acceptedForDesc.end; j++) {
        if (!/^ {20}description: /.test(lines[j])) continue;
        const descriptionLine = `                    description: ${target.description}`;
        if (lines[j] !== descriptionLine) {
          lines[j] = descriptionLine;
          changed = true;
        }
        break;
      }
    }

    // 3. The retained 200's description: same schema, live status is 202.
    const okForDesc = findResponseBlock(lines, responsesIndex, '200');
    if (okForDesc) {
      for (let j = okForDesc.start + 1; j < okForDesc.end; j++) {
        if (!/^ {20}description: /.test(lines[j])) continue;
        const okDescriptionLine = `                    description: ${target.okDescription}`;
        if (lines[j] !== okDescriptionLine) {
          lines[j] = okDescriptionLine;
          changed = true;
        }
        break;
      }
    }

    // 4. Reconcile the header blocks from the 200 (the source of truth — see
    //    the ownership note above yamlLocationEntry). The 200 keeps the shared
    //    replay markers minus Location; the 202 is those same markers plus it.
    const okBlock = findResponseBlock(lines, responsesIndex, '200');
    const acceptedBlock = findResponseBlock(lines, responsesIndex, '202');
    if (!okBlock || !acceptedBlock) continue;

    const okHeaders = findHeadersBlock(lines, okBlock);
    const shared = okHeaders ? sharedHeaderEntries(lines, okHeaders) : [];
    const wantedAccepted = ['                    headers:', ...shared, ...locationLines];

    // `shared` is captured before either rewrite, and both rewrites re-locate
    // their own block, so this is correct in either order; doing the later
    // block first simply avoids a redundant re-scan.
    const okFirst = okBlock.start < acceptedBlock.start;
    const rewriteOk = () => {
      const block = findResponseBlock(lines, responsesIndex, '200');
      const headers = block && findHeadersBlock(lines, block);
      if (!headers) return;
      const wanted = ['                    headers:', ...shared];
      const { replaced } = replaceLinesIfDifferent(lines, headers.start, headers.end, wanted);
      if (replaced) changed = true;
    };
    const rewriteAccepted = () => {
      const block = findResponseBlock(lines, responsesIndex, '202');
      if (!block) return;
      const headers = findHeadersBlock(lines, block);
      if (headers) {
        const { replaced } = replaceLinesIfDifferent(lines, headers.start, headers.end, wantedAccepted);
        if (replaced) changed = true;
        return;
      }
      // No headers block at all (no idempotency markers — cannot happen in the
      // canonical chain, where every POST gets them). Create it after the
      // description line, before `content:`.
      let insertAt = block.start + 1;
      for (let j = block.start + 1; j < block.end; j++) {
        if (/^ {20}description: /.test(lines[j])) insertAt = j + 1;
        if (/^ {20}content:\s*$/.test(lines[j])) break;
      }
      lines.splice(insertAt, 0, ...wantedAccepted);
      changed = true;
    };

    if (okFirst) {
      rewriteAccepted();
      rewriteOk();
    } else {
      rewriteOk();
      rewriteAccepted();
    }
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
