#!/usr/bin/env node
/**
 * Emit a JSON copy of the unified OpenAPI bundle at public/openapi.json.
 *
 * The sebuf generator only produces a YAML bundle
 * (docs/api/worldmonitor.openapi.yaml). `build:openapi` copies that to
 * public/openapi.yaml, and the site advertises it via the `service-desc`
 * Link header + /.well-known/api-catalog. But some agent-readiness scanners
 * (e.g. ora.ai / orank) fetch the spec and run it straight through a JSON
 * parser — YAML input trips them with a generic "found but failed to parse
 * for complexity analysis" warning even though the spec itself is valid
 * OpenAPI 3.1 (both @apidevtools/swagger-parser and @scalar/openapi-parser
 * validate it with zero errors). The minified JSON is also ~40% smaller than
 * the YAML (~752 KB vs ~1.25 MB), which sidesteps the ~1 MB body caps such
 * fetchers sometimes impose.
 *
 * This step deserializes the YAML bundle and writes it back out as minified
 * JSON so `/openapi.json` serves a parseable, self-describing spec alongside
 * the human-readable YAML. Wired into `build:openapi` (and therefore every
 * web-variant build + the default prebuild hook). Idempotent.
 *
 * It also $ref-dedupes the repeated non-2xx error responses (see
 * openapi-dedup-responses.mjs): the 2026-07-05 rate-limit/idempotency/example
 * doc injections grew the minified JSON from ~752 KB to ~1.04 MB, crossing the
 * ~1 MB cap and flipping orank's function-calling check to "couldn't
 * validate". Dedup keeps the served JSON ~814 KB with identical semantics;
 * tests/openapi-json-dedup.test.mjs guards the size budget.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { dedupeErrorResponses } from './openapi-dedup-responses.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const yamlPath = resolve(scriptDir, '../docs/api/worldmonitor.openapi.yaml');
const jsonPath = resolve(scriptDir, '../public/openapi.json');

const spec = parseYaml(readFileSync(yamlPath, 'utf8'));

if (!spec || typeof spec !== 'object' || typeof spec.openapi !== 'string') {
  throw new Error(
    `build-openapi-json: parsed ${yamlPath} but it is not a valid OpenAPI document (missing top-level "openapi" version string)`,
  );
}

const stats = dedupeErrorResponses(spec);

// Minified: this artifact is machine-consumed (scanners/agents), and the
// smaller payload dodges fetch-size caps. The YAML remains the human copy.
const json = JSON.stringify(spec);
writeFileSync(jsonPath, json);

const pathCount = spec.paths ? Object.keys(spec.paths).length : 0;
console.log(
  `build-openapi-json: wrote ${jsonPath} (OpenAPI ${spec.openapi}, ${pathCount} paths, ` +
    `${json.length} bytes; hoisted ${stats.hoisted} shared error responses into ${stats.replacedRefs} $refs)`,
);
