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
 * Emit-time transforms keep the served JSON below its guarded scanner
 * budget with identical semantics. The 2026-07-05 rate-limit/idempotency/example
 * doc injections grew the minified JSON from ~752 KB to ~1.04 MB, crossing the
 * ~1 MB cap and flipping orank's function-calling check to "couldn't validate":
 *
 *   - repeated non-2xx error responses      -> components.responses $refs
 *   - repeated response headers             -> components.headers $refs
 *   - fleet-wide injected parameters        -> components.parameters $refs
 *     (then one inline typed param restored on ops that would otherwise
 *     have only $refs — JSON-only scanners often skip parameter $refs)
 *   - shared China provenance value schemas -> reused $refs
 *   - byte-identical nested Schema Objects  -> reused local $refs
 *   - repeated response headers, generated int64 warnings, and China
 *     date-precision unions                  -> components $refs
 *     (described int64 fields keep their own comment and numeric bounds
 *     as OpenAPI 3.1 $ref siblings; the warning lives in the component)
 *     (all in openapi-dedup-schemas.mjs; every dedup transform is resolved
 *     back to the source document in tests, proving they are lossless)
 *   - repeated subtrees too deep for an inline-target ref to pay for
 *     (the pointer into the document is longer than the subtree itself)
 *                                            -> shared WMShared<N> components
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
import {
  dedupeRepeatedChinaDateSchemas,
  dedupeRepeatedInt64Schemas,
  dedupeSharedChinaProvenanceSchemas,
  dedupeSharedResponseHeaders,
  dedupeSharedSchemaSubtrees,
  dedupeSharedSubtreeComponents,
} from './openapi-dedup-schemas.mjs';
import { dropUnreachableSchemas } from './openapi-drop-unreachable-schemas.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// OPENAPI_YAML_PATH exists so the capacity report's "could not measure" exit can
// be exercised as a real process against a real missing/invalid source, instead
// of being asserted from a hand-built report object that never runs the CLI.
export const yamlPath = process.env.OPENAPI_YAML_PATH
  ?? resolve(scriptDir, '../docs/api/worldmonitor.openapi.yaml');
export const jsonPath = resolve(scriptDir, '../public/openapi.json');
const llmsPath = resolve(scriptDir, '../public/llms.txt');

export function withOpenApiByteSize(text, yamlBytes) {
  const annotation = /(\[OpenAPI specification\]\(https:\/\/www\.worldmonitor\.app\/openapi\.yaml\), which is )[\d,]+ bytes/g;
  if ([...text.matchAll(annotation)].length !== 1) {
    throw new Error('llms.txt must contain exactly one OpenAPI YAML byte-size annotation');
  }
  return text.replace(annotation, (_, prefix) => `${prefix}${yamlBytes.toLocaleString('en-US')} bytes`);
}

/**
 * protoc-gen-openapiv3 copies wrapped proto comments verbatim, so every wrap
 * point lands in a description as "\n " — three bytes in the minified JSON for
 * what Markdown renders as one space. Collapsing a soft break to a space is
 * lossless for rendering. A break is kept when the next line starts a block
 * that a newline delimits: a list item, quote, heading, table row, code fence,
 * or a further-indented line. Lines inside a ``` fence are never joined.
 *
 * JSON only. The YAML is the human copy Mintlify renders, and it keeps the
 * proto line structure. Mutates `spec` in place; returns { collapsed }.
 */
const SOFT_BREAK = /\n (?![ \t\-*+>#|`]|\d+[.)]\s)(?=\S)/g;

export function collapseSoftLineBreaks(spec) {
  const stats = { collapsed: 0 };
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') {
        // Odd segments are fenced code blocks: their line breaks are content.
        node[key] = value
          .split(/(```[\s\S]*?```)/)
          .map((segment, index) => (index % 2 === 1
            ? segment
            : segment.replace(SOFT_BREAK, () => {
              stats.collapsed += 1;
              return ' ';
            })))
          .join('');
      } else if (value && typeof value === 'object') {
        visit(value);
      }
    }
  };
  visit(spec);
  return stats;
}

/**
 * `required: false` is the OpenAPI default for every non-path Parameter Object
 * (path parameters must say `true`), so stating it is pure bytes: 316 copies in
 * the served artifact. ensureInlineTypedInput already drops it from restored
 * jmespath copies on the same reasoning. JSON only; the YAML keeps it for the
 * human reader and for the per-spec contract tests that assert it.
 *
 * Mutates `spec` in place; returns { dropped }.
 */
export function dropDefaultParameterRequired(spec) {
  const stats = { dropped: 0 };
  const strip = (param) => {
    if (!param || typeof param !== 'object' || param.$ref) return;
    if (param.in !== 'path' && param.required === false) {
      delete param.required;
      stats.dropped += 1;
    }
  };
  for (const param of Object.values(spec.components?.parameters ?? {})) strip(param);
  for (const pathItem of Object.values(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    (pathItem.parameters ?? []).forEach(strip);
    for (const operation of Object.values(pathItem)) {
      if (operation && typeof operation === 'object' && Array.isArray(operation.parameters)) {
        operation.parameters.forEach(strip);
      }
    }
  }
  return stats;
}

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
  const headerStats = dedupeSharedResponseHeaders(spec);
  const schemaStats = dedupeSharedChinaProvenanceSchemas(spec);
  // The named passes run before the generic byte-identical sweep. Reversing them
  // lets the generic pass absorb the int64/China-date shapes into anonymous
  // shared refs, and the named transforms then report zero engagement — the
  // silent-disengagement case the contract test watches for.
  const chinaDateStats = dedupeRepeatedChinaDateSchemas(spec);
  const int64Stats = dedupeRepeatedInt64Schemas(spec);
  const schemaSubtreeStats = dedupeSharedSchemaSubtrees(spec);
  // After the named passes and the inline-target pass: anything still repeated
  // here sat deep in a long-named component, where a $ref INTO the document is
  // longer than the repeated subtree itself and only a compact shared
  // component ref wins (see openapi-dedup-schemas.mjs).
  const sharedSubtreeStats = dedupeSharedSubtreeComponents(spec);
  const paramStats = dedupeSharedParameters(spec);
  const inlineTypedStats = ensureInlineTypedInput(spec);
  injectDeprecationPolicyMetadata(spec);
  // Last by convention, not by necessity. The drop seeds reachability from
  // EVERY non-schema bucket (see openapi-drop-unreachable-schemas.mjs), so the
  // responses and parameters the passes above hoist into components keep their
  // schema targets alive wherever it runs — that unconditional seeding, not
  // this ordering, is the invariant a future edit must preserve.
  const unreachableStats = dropUnreachableSchemas(spec);
  // Runs on the finished document so every surviving description, hoisted
  // component or inline copy alike, is compacted exactly once.
  const softBreakStats = collapseSoftLineBreaks(spec);
  const defaultRequiredStats = dropDefaultParameterRequired(spec);

  // Minified: this artifact is machine-consumed (scanners/agents), and the
  // smaller payload dodges fetch-size caps. The YAML remains the human copy.
  const json = JSON.stringify(spec);

  return {
    spec,
    json,
    bytes: Buffer.byteLength(json, 'utf8'),
    stats,
    headerStats,
    schemaStats,
    schemaSubtreeStats,
    sharedSubtreeStats,
    chinaDateStats,
    int64Stats,
    paramStats,
    inlineTypedStats,
    unreachableStats,
    softBreakStats,
    defaultRequiredStats,
  };
}

function main() {
  const yaml = readFileSync(yamlPath);
  const llms = withOpenApiByteSize(readFileSync(llmsPath, 'utf8'), yaml.byteLength);
  const {
    spec,
    json,
    bytes,
    stats,
    schemaStats,
    schemaSubtreeStats,
    sharedSubtreeStats,
    chinaDateStats,
    int64Stats,
    headerStats,
    paramStats,
    inlineTypedStats,
    unreachableStats,
  } = buildBundle({ spec: parseYaml(yaml.toString('utf8')) });
  writeFileSync(jsonPath, json);
  writeFileSync(llmsPath, llms);

  const pathCount = spec.paths ? Object.keys(spec.paths).length : 0;
  console.log(
    `build-openapi-json: wrote ${jsonPath} (OpenAPI ${spec.openapi}, ${pathCount} paths, ` +
      `${bytes} bytes; hoisted ${stats.hoisted} shared error responses into ${stats.replacedRefs} $refs; ` +
      `hoisted ${headerStats.hoisted} shared response headers into ${headerStats.replacedRefs} $refs; ` +
      `hoisted ${paramStats.hoisted} fleet-wide parameters into ${paramStats.replacedRefs} $refs; ` +
      `reused ${int64Stats.replacedRefs} generated int64 schemas (+${int64Stats.describedRefs} described int64 fields); ` +
      `restored ${inlineTypedStats.inlined} inline typed parameters for JSON-only scanners; ` +
      `reused ${schemaStats.replacedRefs}/${schemaStats.compared} shared China provenance schemas; ` +
      `reused ${schemaSubtreeStats.replacedRefs} byte-identical schema subtrees across ${schemaSubtreeStats.groups} groups; ` +
      `hoisted ${sharedSubtreeStats.replacedRefs} deep repeated subtrees into ${sharedSubtreeStats.groups} shared components (${sharedSubtreeStats.bytesFreed} bytes); ` +
      `reused ${chinaDateStats.replacedRefs} China date-precision schemas; ` +
      `dropped ${unreachableStats.dropped} unreachable schemas worth ${unreachableStats.bytesFreed} bytes)`,
  );
}

// Importing this module must not write the artifact: the capacity report and
// the contract tests import `buildBundle` for measurement only.
const invokedDirectly = process.argv[1]
  && pathToFileURL(realpathSync(process.argv[1])).href
    === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
if (invokedDirectly) main();
