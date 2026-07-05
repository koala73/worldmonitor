#!/usr/bin/env node
/**
 * Advertise Idempotency-Key support on every POST (mutation) operation in the
 * generated OpenAPI specs.
 *
 * The gateway (server/_shared/idempotency.ts, wired into server/gateway.ts)
 * honors an `Idempotency-Key` request header on POST endpoints so agents can
 * safely retry on network failure without duplicating a side effect. The sebuf
 * `protoc-gen-openapiv3` plugin has no annotation for describing a header
 * parameter, so this post-generation step stamps the parameter onto each POST
 * operation across the per-service JSON + YAML specs and the bundle. Scanners
 * (e.g. ora.ai / orank) that fall back to the published spec for auth-gated
 * routes then see the documented support.
 *
 * Wired into `make generate` (after the other OpenAPI injectors) and exposed as
 * `npm run gen:openapi:idempotency`. Idempotent + byte-faithful (JSON
 * re-serialized with the shared sorted, Go-escaped strategy; YAML via surgical
 * insertion). See umbrella issue #4599 and the orank Access-layer work (#4698).
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, serialize } from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');

const DESCRIPTION =
  'Optional client-generated idempotency key. Retrying a POST with the same key and an identical request body replays the original response (only the status, body, and Content-Type are reproduced) instead of re-executing; reusing the key with a different body is rejected with 422. For mutations this avoids duplicating the side effect, while for batch-read POSTs it replays a cached snapshot that can be up to 24 hours stale. Keys are scoped per authenticated caller (falling back to the source IP for unauthenticated endpoints) and retained for 24 hours.';
const EXAMPLE = '4f8b9c2e-1a3d-4b6f-8e0a-2c5d7f9b1e34';
const KEY_PATTERN = '^[\\x21-\\x7E]{1,255}$';

const IDEMPOTENCY_ERROR_SCHEMA = {
  type: 'object',
  required: ['error', 'message'],
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
};

const JSON_RESPONSES = {
  '400': {
    description: 'Validation error or invalid Idempotency-Key header',
    content: {
      'application/json': {
        schema: {
          oneOf: [
            { $ref: '#/components/schemas/ValidationError' },
            IDEMPOTENCY_ERROR_SCHEMA,
          ],
        },
      },
    },
  },
  '409': {
    description: 'A request with this Idempotency-Key is still being processed',
    headers: {
      'Idempotency-Key': {
        schema: { type: 'string' },
        description: 'The idempotency key supplied by the client.',
      },
      'Retry-After': {
        schema: { type: 'string' },
        description: 'Seconds to wait before retrying the in-flight request.',
      },
    },
    content: {
      'application/json': {
        schema: IDEMPOTENCY_ERROR_SCHEMA,
      },
    },
  },
  '422': {
    description: 'The Idempotency-Key was already used with a different request body',
    headers: {
      'Idempotency-Key': {
        schema: { type: 'string' },
        description: 'The idempotency key supplied by the client.',
      },
    },
    content: {
      'application/json': {
        schema: IDEMPOTENCY_ERROR_SCHEMA,
      },
    },
  },
};

// Replay markers echoed on the 2xx (success) response of an idempotent POST.
// The gateway sets `Idempotent-Replayed: false` + echoes the key on the first
// request (server/gateway.ts) and `Idempotent-Replayed: true` on a replay
// (server/_shared/idempotency.ts); both are CORS-exposed (server/cors.ts). This
// is the only observable signal for "was this a replay?", so document it on the
// success response the same way the injector documents headers on 409/422.
const SUCCESS_HEADERS = {
  'Idempotency-Key': {
    schema: { type: 'string' },
    description: 'The idempotency key echoed from the request. Present only when the client opted into idempotency.',
  },
  'Idempotent-Replayed': {
    schema: { type: 'boolean' },
    description:
      'true when this response was replayed from an earlier request with the same key, false on the first (original) request. Present only when the client opted into idempotency.',
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── Per-service JSON ────────────────────────────────────────────────────────
// Object-key order is irrelevant (the shared serializer sorts recursively);
// only membership + values matter for byte-faithful output.
const JSON_PARAM = {
  name: 'Idempotency-Key',
  in: 'header',
  description: DESCRIPTION,
  required: false,
  example: EXAMPLE,
  schema: { type: 'string', minLength: 1, maxLength: 255, pattern: KEY_PATTERN },
};

function isIdempotencyParam(param) {
  return (
    param &&
    typeof param === 'object' &&
    param.in === 'header' &&
    String(param.name).toLowerCase() === 'idempotency-key'
  );
}

function injectJson(spec) {
  let changed = false;
  for (const ops of Object.values(spec.paths ?? {})) {
    const post = ops && typeof ops === 'object' ? ops.post : null;
    if (!post || typeof post !== 'object') continue;
    const params = Array.isArray(post.parameters) ? post.parameters : [];
    const paramIndex = params.findIndex(isIdempotencyParam);
    if (paramIndex === -1) {
      post.parameters = [...params, clone(JSON_PARAM)];
      changed = true;
    } else if (!eq(params[paramIndex], JSON_PARAM)) {
      post.parameters = [...params];
      post.parameters[paramIndex] = clone(JSON_PARAM);
      changed = true;
    }
    post.responses ??= {};
    for (const [code, response] of Object.entries(JSON_RESPONSES)) {
      if (!eq(post.responses[code], response)) {
        post.responses[code] = clone(response);
        changed = true;
      }
    }
    // The 2xx success response is generated by the plugin (op-specific
    // description + content) — merge in only the replay-marker headers, keeping
    // any headers another injector/plugin may have already added to the 200.
    const success = post.responses['200'];
    if (success && typeof success === 'object') {
      const mergedHeaders = { ...(success.headers ?? {}), ...clone(SUCCESS_HEADERS) };
      if (!eq(success.headers, mergedHeaders)) {
        success.headers = mergedHeaders;
        changed = true;
      }
    }
  }
  return changed;
}

// ── YAML (formatting-preserving surgical insertion) ─────────────────────────
// Path lines at 4 spaces, method lines at 8, op children (`parameters:`) at 12,
// list items (`- name:`) at 16, item children at 18, schema children at 20 —
// matching the generator's existing query-parameter blocks.
const YAML_ITEM = [
  '                - name: Idempotency-Key',
  '                  in: header',
  `                  description: ${DESCRIPTION}`,
  '                  required: false',
  `                  example: "${EXAMPLE}"`,
  '                  schema:',
  '                    type: string',
  '                    minLength: 1',
  '                    maxLength: 255',
  '                    pattern: "^[\\\\x21-\\\\x7E]{1,255}$"',
];

const YAML_400_RESPONSE = [
  '                "400":',
  '                    description: Validation error or invalid Idempotency-Key header',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  '                                oneOf:',
  "                                    - $ref: '#/components/schemas/ValidationError'",
  '                                    - type: object',
  '                                      required:',
  '                                        - error',
  '                                        - message',
  '                                      properties:',
  '                                        error:',
  '                                            type: string',
  '                                        message:',
  '                                            type: string',
];

const YAML_409_RESPONSE = [
  '                "409":',
  '                    description: A request with this Idempotency-Key is still being processed',
  '                    headers:',
  '                        Idempotency-Key:',
  '                            schema:',
  '                                type: string',
  '                            description: The idempotency key supplied by the client.',
  '                        Retry-After:',
  '                            schema:',
  '                                type: string',
  '                            description: Seconds to wait before retrying the in-flight request.',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  '                                type: object',
  '                                required:',
  '                                    - error',
  '                                    - message',
  '                                properties:',
  '                                    error:',
  '                                        type: string',
  '                                    message:',
  '                                        type: string',
];

const YAML_422_RESPONSE = [
  '                "422":',
  '                    description: The Idempotency-Key was already used with a different request body',
  '                    headers:',
  '                        Idempotency-Key:',
  '                            schema:',
  '                                type: string',
  '                            description: The idempotency key supplied by the client.',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  '                                type: object',
  '                                required:',
  '                                    - error',
  '                                    - message',
  '                                properties:',
  '                                    error:',
  '                                        type: string',
  '                                    message:',
  '                                        type: string',
];

// Replay-marker headers merged into the existing 2xx block (indented to match
// the 409/422 header blocks: headers: at 20, name at 24, schema at 28).
const YAML_SUCCESS_HEADERS = [
  '                    headers:',
  '                        Idempotency-Key:',
  '                            schema:',
  '                                type: string',
  '                            description: The idempotency key echoed from the request. Present only when the client opted into idempotency.',
  '                        Idempotent-Replayed:',
  '                            schema:',
  '                                type: boolean',
  '                            description: true when this response was replayed from an earlier request with the same key, false on the first (original) request. Present only when the client opted into idempotency.',
];

function findIndentedBlockEnd(lines, start, end, markerRegex, parentRegex) {
  let blockEnd = start + 1;
  while (blockEnd < end && !markerRegex.test(lines[blockEnd]) && !parentRegex.test(lines[blockEnd])) {
    blockEnd++;
  }
  return blockEnd;
}

function replaceLinesIfDifferent(lines, start, blockEnd, replacement) {
  const current = lines.slice(start, blockEnd);
  if (current.length === replacement.length && current.every((line, idx) => line === replacement[idx])) {
    return 0;
  }
  lines.splice(start, blockEnd - start, ...replacement);
  return replacement.length - (blockEnd - start);
}

function ensureYamlIdempotencyParam(lines, postIndex, end) {
  let paramsIndex = -1;
  let paramIndex = -1;
  for (let j = postIndex + 1; j < end; j++) {
    if (/^ {16}- name: Idempotency-Key\s*$/.test(lines[j])) {
      paramIndex = j;
      break;
    }
    if (paramsIndex === -1 && /^ {12}parameters:\s*$/.test(lines[j])) paramsIndex = j;
  }

  if (paramIndex !== -1) {
    const blockEnd = findIndentedBlockEnd(
      lines,
      paramIndex,
      end,
      /^ {16}- name: /,
      /^ {0,12}\S/,
    );
    return replaceLinesIfDifferent(lines, paramIndex, blockEnd, YAML_ITEM);
  }

  if (paramsIndex !== -1) {
    lines.splice(paramsIndex + 1, 0, ...YAML_ITEM);
    return YAML_ITEM.length;
  }

  lines.splice(postIndex + 1, 0, '            parameters:', ...YAML_ITEM);
  return 1 + YAML_ITEM.length;
}

function yamlResponseCodeRegex(code) {
  return new RegExp(`^ {16}"${code}":\\s*$`);
}

function ensureYamlResponse(lines, responsesIndex, end, code, replacement, previousCode = null) {
  const codeRegex = yamlResponseCodeRegex(code);
  for (let j = responsesIndex + 1; j < end; j++) {
    if (!codeRegex.test(lines[j])) continue;
    const blockEnd = findIndentedBlockEnd(
      lines,
      j,
      end,
      /^ {16}"(?:[0-9]{3}|default)":/,
      /^ {0,12}\S/,
    );
    return replaceLinesIfDifferent(lines, j, blockEnd, replacement);
  }

  let insertAt = responsesIndex + 1;
  if (previousCode) {
    const previousRegex = yamlResponseCodeRegex(previousCode);
    for (let j = responsesIndex + 1; j < end; j++) {
      if (!previousRegex.test(lines[j])) continue;
      insertAt = findIndentedBlockEnd(
        lines,
        j,
        end,
        /^ {16}"(?:[0-9]{3}|default)":/,
        /^ {0,12}\S/,
      );
      break;
    }
  }
  lines.splice(insertAt, 0, ...replacement);
  return replacement.length;
}

// Insert (or refresh) the replay-marker `headers:` block inside the existing
// 2xx response, before its `content:` (mirroring the 409/422 ordering) without
// disturbing the plugin-generated description/content.
function ensureYamlSuccessHeaders(lines, responsesIndex, end) {
  const codeRegex = yamlResponseCodeRegex('200');
  let blockStart = -1;
  for (let j = responsesIndex + 1; j < end; j++) {
    if (codeRegex.test(lines[j])) {
      blockStart = j;
      break;
    }
  }
  if (blockStart === -1) return 0;

  const blockEnd = findIndentedBlockEnd(
    lines,
    blockStart,
    end,
    /^ {16}"(?:[0-9]{3}|default)":/,
    /^ {0,12}\S/,
  );

  for (let j = blockStart + 1; j < blockEnd; j++) {
    if (/^ {20}headers:\s*$/.test(lines[j])) {
      const headersEnd = findIndentedBlockEnd(lines, j, blockEnd, /^ {20}\S/, /^ {0,16}\S/);
      return replaceLinesIfDifferent(lines, j, headersEnd, YAML_SUCCESS_HEADERS);
    }
  }

  let insertAt = blockEnd;
  for (let j = blockStart + 1; j < blockEnd; j++) {
    if (/^ {20}content:\s*$/.test(lines[j])) {
      insertAt = j;
      break;
    }
  }
  lines.splice(insertAt, 0, ...YAML_SUCCESS_HEADERS);
  return YAML_SUCCESS_HEADERS.length;
}

function injectYaml(text) {
  const lines = text.split('\n');
  let changed = false;
  let currentPath = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pathMatch = line.match(/^ {4}(\/\S+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    if (/^\S/.test(line)) {
      currentPath = null; // left the paths: block
      continue;
    }
    if (!currentPath || !/^ {8}post:\s*$/.test(line)) continue;

    // Op block spans until the next line at <= 8-space indent (next method /
    // path / top-level key).
    let end = i + 1;
    while (end < lines.length && !/^ {0,8}\S/.test(lines[end])) end++;

    let delta = ensureYamlIdempotencyParam(lines, i, end);
    if (delta !== 0) {
      changed = true;
      end += delta;
    }

    let responsesIndex = -1;
    for (let j = i + 1; j < end; j++) {
      if (/^ {12}responses:\s*$/.test(lines[j])) {
        responsesIndex = j;
        break;
      }
    }
    if (responsesIndex !== -1) {
      delta = ensureYamlSuccessHeaders(lines, responsesIndex, end);
      if (delta !== 0) {
        changed = true;
        end += delta;
      }
      for (const [code, replacement, previousCode] of [
        ['400', YAML_400_RESPONSE, null],
        ['409', YAML_409_RESPONSE, '400'],
        ['422', YAML_422_RESPONSE, '409'],
      ]) {
        delta = ensureYamlResponse(lines, responsesIndex, end, code, replacement, previousCode);
        if (delta !== 0) {
          changed = true;
          end += delta;
        }
      }
    }
    i = end - 1;
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
    console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing the Idempotency-Key parameter: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:idempotency');
    process.exit(1);
  }
  console.log('✓ Idempotency-Key parameter in sync across all POST operations');
} else {
  console.log(`openapi-inject-idempotency: updated ${wouldChange} artifact(s)`);
}
