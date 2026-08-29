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
 * Four emit-time transforms keep the served JSON below its guarded scanner
 * budget with identical semantics. The 2026-07-05 rate-limit/idempotency/example
 * doc injections grew the minified JSON from ~752 KB to ~1.04 MB, crossing the
 * ~1 MB cap and flipping orank's function-calling check to "couldn't validate":
 *
 *   - repeated non-2xx error responses      -> components.responses $refs
 *   - fleet-wide injected parameters        -> components.parameters $refs
 *     (then one inline typed param restored on ops that would otherwise
 *     have only $refs — JSON-only scanners often skip parameter $refs)
 *   - shared China provenance value schemas -> reused $refs
 *     (all three in openapi-dedup-*.mjs; tests prove they are lossless)
 *   - component schemas nothing can reach   -> removed
 *     (openapi-drop-unreachable-schemas.mjs)
 *
 * `scripts/openapi-capacity-report.mjs` measures what is left and ranks what to
 * collapse next; docs/perf/openapi-bundle-capacity-2026-08-13.md is the plan.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  dedupeErrorResponses,
  dedupeSharedParameters,
  ensureInlineTypedInput,
} from './openapi-dedup-responses.mjs';
import { dedupeSharedChinaProvenanceSchemas } from './openapi-dedup-schemas.mjs';
import { dropUnreachableSchemas } from './openapi-drop-unreachable-schemas.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// OPENAPI_YAML_PATH exists so the capacity report's "could not measure" exit can
// be exercised as a real process against a real missing/invalid source, instead
// of being asserted from a hand-built report object that never runs the CLI.
export const yamlPath = process.env.OPENAPI_YAML_PATH
  ?? resolve(scriptDir, '../docs/api/worldmonitor.openapi.yaml');
export const jsonPath = resolve(scriptDir, '../public/openapi.json');

export const DEPRECATION_POLICY_URL = 'https://www.worldmonitor.app/api-versioning.md';
const DEPRECATION_POLICY_HTML_URL = 'https://www.worldmonitor.app/docs/api-versioning';

function injectDeprecationPolicyMetadata(spec) {
  spec.components ??= {};
  spec.components.headers ??= {};
  spec.components.headers.Deprecation ??= {
    description:
      'RFC 9745. Present only when this operation or version is deprecated; omitted while the surface is current. Value is the deprecation instant as an HTTP Structured Field date (for example `@1782864000`).',
    schema: { type: 'string', examples: ['@1782864000'] },
  };
  spec.components.headers.Sunset ??= {
    description:
      'RFC 8594. Present only when this operation or version is deprecated. Final availability date in HTTP-date format (for example `Thu, 31 Dec 2026 23:59:59 GMT`).',
    schema: { type: 'string', examples: ['Thu, 31 Dec 2026 23:59:59 GMT'] },
  };
  spec.components.headers.DeprecationPolicyLink ??= {
    description:
      `RFC 8288 Link with rel="deprecation" pointing at the versioning and sunset policy (${DEPRECATION_POLICY_URL}). May appear on current, non-deprecated responses so agents can discover the policy before any surface is retired.`,
    schema: { type: 'string' },
  };

  const info = spec.info ?? (spec.info = {});
  const description = String(info.description ?? '');
  if (!description.includes('api-versioning.md')) {
    const policyNote =
      ` Static machine-readable deprecation policy: ${DEPRECATION_POLICY_URL} (HTML: ${DEPRECATION_POLICY_HTML_URL}). Current responses may carry Link rel="deprecation" for policy discovery (RFC 9745); Deprecation and Sunset headers are sent only on deprecated surfaces.`;
    info.description = description + policyNote;
  }
}

/**
 * Produce the exact artifact `public/openapi.json` receives, without writing it.
 *
 * Exported so the capacity report (#6558) measures the SAME bytes this script
 * emits rather than a re-implementation that can drift from it. `bytes` is the
 * UTF-8 length actually written to disk and served — `json.length` counts UTF-16
 * code units and undercounts every non-ASCII character in the descriptions
 * (264 bytes on the 2026-08-13 bundle), which is the wrong unit for a body cap
 * expressed in bytes.
 *
 * @param {{ spec?: object }} [options] Pre-parsed bundle. The YAML parse of the
 *   2.6 MB source costs seconds; callers that already hold the document (the
 *   contract tests, via the cached loader) pass it in. Mutated in place, exactly
 *   as the CLI path mutates its own freshly parsed copy.
 */
export function buildBundle({ spec: provided } = {}) {
  const spec = provided ?? parseYaml(readFileSync(yamlPath, 'utf8'));

  if (!spec || typeof spec !== 'object' || typeof spec.openapi !== 'string') {
    throw new Error(
      `build-openapi-json: parsed ${yamlPath} but it is not a valid OpenAPI document (missing top-level "openapi" version string)`,
    );
  }

  const stats = dedupeErrorResponses(spec);
  const schemaStats = dedupeSharedChinaProvenanceSchemas(spec);
  const paramStats = dedupeSharedParameters(spec);
  const inlineTypedStats = ensureInlineTypedInput(spec);
  injectDeprecationPolicyMetadata(spec);
  // Last by convention, not by necessity. The drop seeds reachability from
  // EVERY non-schema bucket (see openapi-drop-unreachable-schemas.mjs), so the
  // responses and parameters the passes above hoist into components keep their
  // schema targets alive wherever it runs — that unconditional seeding, not
  // this ordering, is the invariant a future edit must preserve.
  const unreachableStats = dropUnreachableSchemas(spec);

  // Minified: this artifact is machine-consumed (scanners/agents), and the
  // smaller payload dodges fetch-size caps. The YAML remains the human copy.
  const json = JSON.stringify(spec);

  return {
    spec,
    json,
    bytes: Buffer.byteLength(json, 'utf8'),
    stats,
    schemaStats,
    paramStats,
    inlineTypedStats,
    unreachableStats,
  };
}

function main() {
  const { spec, json, bytes, stats, schemaStats, paramStats, inlineTypedStats, unreachableStats } = buildBundle();
  writeFileSync(jsonPath, json);

  const pathCount = spec.paths ? Object.keys(spec.paths).length : 0;
  console.log(
    `build-openapi-json: wrote ${jsonPath} (OpenAPI ${spec.openapi}, ${pathCount} paths, ` +
      `${bytes} bytes; hoisted ${stats.hoisted} shared error responses into ${stats.replacedRefs} $refs; ` +
      `hoisted ${paramStats.hoisted} fleet-wide parameters into ${paramStats.replacedRefs} $refs; ` +
      `restored ${inlineTypedStats.inlined} inline typed parameters for JSON-only scanners; ` +
      `reused ${schemaStats.replacedRefs}/${schemaStats.compared} shared China provenance schemas; ` +
      `dropped ${unreachableStats.dropped} unreachable schemas worth ${unreachableStats.bytesFreed} bytes)`,
  );
}

// Importing this module must not write the artifact: the capacity report and
// the contract tests import `buildBundle` for measurement only.
const invokedDirectly = process.argv[1]
  && pathToFileURL(realpathSync(process.argv[1])).href
    === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
if (invokedDirectly) main();
