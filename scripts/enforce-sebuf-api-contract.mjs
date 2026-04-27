#!/usr/bin/env node
/**
 * Sebuf API contract enforcement.
 *
 * Every file under api/ must be one of:
 *   1. A sebuf gateway — api/<kebab-domain>/v<N>/[rpc].ts paired with a
 *      generated service_server under src/generated/server/worldmonitor/<snake_domain>/v<N>/.
 *   2. A listed entry in api/api-route-exceptions.json with category, reason,
 *      owner, and (for temporary categories) a removal_issue.
 *
 * Also checks the reverse: every generated service has a gateway. This catches
 * the case where a proto is deleted but the gateway wrapper is left behind.
 *
 * Skips: underscore-prefixed helpers, *.test.*, and anything gitignored (the
 * compiled sidecar bundles at api/[[...path]].js and api/<domain>/v1/[rpc].js
 * are build artifacts, not source).
 *
 * Exit 0 clean, 1 on any violation. Output is agent-readable: file:line + remedy.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'api');
const GEN_SERVER_DIR = join(ROOT, 'src/generated/server/worldmonitor');
const MANIFEST_PATH = join(API_DIR, 'api-route-exceptions.json');

const VALID_CATEGORIES = new Set([
  'external-protocol',
  'non-json',
  'upstream-proxy',
  'ops-admin',
  'internal-helper',
  'deferred',
  'migration-pending',
]);

// Categories that describe *permanent* exceptions — never expected to leave the
// manifest. A removal_issue on these would be misleading.
const PERMANENT_CATEGORIES = new Set([
  'external-protocol',
  'non-json',
  'upstream-proxy',
  'ops-admin',
  'internal-helper',
]);

const violations = [];

function violation(file, message, remedy) {
  violations.push({ file, message, remedy });
}

// --- Enumerate candidate files under api/ ---

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

function isSourceFile(path) {
  const base = path.split(sep).pop();
  if (base.startsWith('_')) return false;
  if (base.includes('.test.')) return false;
  return SOURCE_EXTS.some((ext) => base.endsWith(ext));
}

const allApiFiles = walk(API_DIR).filter(isSourceFile);

// Filter out gitignored paths in one batch.
function filterIgnored(files) {
  if (files.length === 0) return [];
  const relPaths = files.map((f) => relative(ROOT, f)).join('\n');
  let ignored = new Set();
  try {
    // --stdin returns the ignored paths (one per line). Exit 0 = some matched,
    // 1 = none matched, 128 = error. We treat 0 and 1 as success.
    const output = execFileSync('git', ['check-ignore', '--stdin'], {
      input: relPaths,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    ignored = new Set(output.split('\n').filter(Boolean));
  } catch (err) {
    // exit code 1 = no paths ignored; treat as empty.
    if (err.status === 1) {
      ignored = new Set();
    } else {
      throw err;
    }
  }
  return files.filter((f) => !ignored.has(relative(ROOT, f)));
}

const candidateFiles = filterIgnored(allApiFiles);

// --- Load manifest ---

if (!existsSync(MANIFEST_PATH)) {
  console.error(`✖ ${relative(ROOT, MANIFEST_PATH)} is missing.`);
  console.error(
    '  Remedy: restore api-route-exceptions.json (see docs/adding-endpoints.mdx). It is the single source of truth for non-proto endpoints.',
  );
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (err) {
  console.error(`✖ ${relative(ROOT, MANIFEST_PATH)} is not valid JSON: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(manifest.exceptions)) {
  console.error(`✖ ${relative(ROOT, MANIFEST_PATH)} is missing the "exceptions" array.`);
  process.exit(1);
}

// Validate every manifest entry's shape.
const manifestByPath = new Map();
for (const [idx, entry] of manifest.exceptions.entries()) {
  const label = `api-route-exceptions.json[${idx}]`;
  if (typeof entry.path !== 'string' || entry.path.length === 0) {
    violation(label, 'entry is missing a non-empty "path" string', 'Set "path" to the api/ path this entry covers.');
    continue;
  }
  if (manifestByPath.has(entry.path)) {
    violation(
      label,
      `duplicate entry for path "${entry.path}"`,
      'Remove the duplicate — one entry per path.',
    );
  }
  manifestByPath.set(entry.path, entry);

  if (!VALID_CATEGORIES.has(entry.category)) {
    violation(
      label,
      `invalid category "${entry.category}" for ${entry.path}`,
      `category must be one of: ${[...VALID_CATEGORIES].join(', ')}.`,
    );
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
    violation(
      label,
      `entry for ${entry.path} is missing a substantive "reason" (≥10 chars)`,
      'Write a one-sentence reason explaining why this endpoint cannot or should not be a sebuf RPC.',
    );
  }
  if (typeof entry.owner !== 'string' || !entry.owner.startsWith('@')) {
    violation(
      label,
      `entry for ${entry.path} has an invalid "owner" (must be a GitHub handle starting with @)`,
      'Set "owner" to a GitHub handle like @SebastienMelki.',
    );
  }
  if (entry.removal_issue !== null && entry.removal_issue !== undefined) {
    if (typeof entry.removal_issue !== 'string') {
      violation(
        label,
        `entry for ${entry.path} has non-string "removal_issue"`,
        'Set "removal_issue" to null, "TBD", or an issue reference like "#3207".',
      );
    } else if (
      entry.removal_issue !== 'TBD' &&
      !/^#\d+$/.test(entry.removal_issue)
    ) {
      violation(
        label,
        `entry for ${entry.path} has malformed "removal_issue" "${entry.removal_issue}"`,
        'Use null for permanent exceptions, "TBD" while an issue is being filed, or "#<number>" once tracked.',
      );
    }
  }
  if (PERMANENT_CATEGORIES.has(entry.category) && entry.removal_issue) {
    violation(
      label,
      `entry for ${entry.path} is category "${entry.category}" but has a "removal_issue" set`,
      'Permanent categories (external-protocol, non-json, upstream-proxy, ops-admin, internal-helper) do not track removal. Set removal_issue to null.',
    );
  }
  if (!PERMANENT_CATEGORIES.has(entry.category) && !entry.removal_issue) {
    violation(
      label,
      `entry for ${entry.path} is category "${entry.category}" but has no "removal_issue"`,
      'Temporary categories (deferred, migration-pending) must declare a tracking issue or "TBD".',
    );
  }

  // Reverse pointer: manifest must not name a file that doesn't exist.
  const absolute = join(ROOT, entry.path);
  if (!existsSync(absolute)) {
    violation(
      label,
      `entry for ${entry.path} points to a file that does not exist`,
      'Remove the entry if the file was deleted, or fix the path.',
    );
  }
}

// --- Classify each api/ source file ---

// Sebuf gateway pattern — two accepted forms:
//   1. api/<kebab-domain>/v<N>/[rpc].ts (standard, domain-first)
//   2. api/v<N>/<kebab-domain>/[rpc].ts (version-first, for partner-URL
//      preservation where the external contract already uses that layout —
//      e.g. /api/v2/shipping/*).
// Both map to src/generated/server/worldmonitor/<snake_domain>/v<N>/.
const GATEWAY_RE = /^api\/(?:([a-z][a-z0-9-]*)\/v(\d+)|v(\d+)\/([a-z][a-z0-9-]*))\/\[rpc\]\.(ts|tsx|js|mjs|cjs)$/;

function kebabToSnake(s) {
  return s.replace(/-/g, '_');
}

const seenGatewayDomains = new Set();

for (const absolute of candidateFiles) {
  const rel = relative(ROOT, absolute).split(sep).join('/');

  // Skip the manifest itself — it isn't an endpoint.
  if (rel === 'api/api-route-exceptions.json') continue;

  const gatewayMatch = rel.match(GATEWAY_RE);
  if (gatewayMatch) {
    // Group 1+2 = standard form (domain, version); 3+4 = version-first form (version, domain).
    const domain = gatewayMatch[1] ?? gatewayMatch[4];
    const version = gatewayMatch[2] ?? gatewayMatch[3];
    const snakeDomain = kebabToSnake(domain);
    const expectedServer = join(
      GEN_SERVER_DIR,
      snakeDomain,
      `v${version}`,
      'service_server.ts',
    );
    seenGatewayDomains.add(`${snakeDomain}/v${version}`);
    if (!existsSync(expectedServer)) {
      violation(
        rel,
        `sebuf gateway for /${domain}/v${version} has no matching generated service`,
        `Expected ${relative(ROOT, expectedServer)}. Either regenerate (cd proto && buf generate), restore the proto under proto/worldmonitor/${snakeDomain}/v${version}/service.proto, or delete this orphaned gateway.`,
      );
    }
    continue;
  }

  if (manifestByPath.has(rel)) {
    // The entry was already validated above. Nothing more to check here.
    continue;
  }

  violation(
    rel,
    'file under api/ is neither a sebuf gateway nor a listed exception',
    'New JSON data APIs must be sebuf RPCs (proto → buf generate → handler). See docs/adding-endpoints.mdx. If this endpoint genuinely cannot be proto (external protocol, binary response, upstream proxy, ops plumbing), add an entry to api/api-route-exceptions.json — expect reviewer pushback.',
  );
}

// --- Bidirectional check: every generated service has a gateway ---

if (existsSync(GEN_SERVER_DIR)) {
  for (const domainDir of readdirSync(GEN_SERVER_DIR, { withFileTypes: true })) {
    if (!domainDir.isDirectory()) continue;
    const snakeDomain = domainDir.name;
    const domainPath = join(GEN_SERVER_DIR, snakeDomain);
    for (const versionDir of readdirSync(domainPath, { withFileTypes: true })) {
      if (!versionDir.isDirectory()) continue;
      if (!/^v\d+$/.test(versionDir.name)) continue;
      const serviceServer = join(
        domainPath,
        versionDir.name,
        'service_server.ts',
      );
      if (!existsSync(serviceServer)) continue;
      const key = `${snakeDomain}/${versionDir.name}`;
      if (!seenGatewayDomains.has(key)) {
        const kebabDomain = snakeDomain.replace(/_/g, '-');
        violation(
          relative(ROOT, serviceServer),
          `generated service ${snakeDomain}/${versionDir.name} has no HTTP gateway under api/`,
          `Create api/${kebabDomain}/${versionDir.name}/[rpc].ts (follow the pattern from any existing domain — it just imports the generated server factory and re-exports as the edge handler).`,
        );
      }
    }
  }
}

// --- Output ---

if (violations.length === 0) {
  console.log(
    `✓ sebuf API contract clean: ${candidateFiles.length} api/ files checked, ${manifest.exceptions.length} manifest entries validated.`,
  );
  process.exit(0);
}

console.error(`✖ sebuf API contract: ${violations.length} violation(s):\n`);
for (const v of violations) {
  console.error(`  ${v.file}`);
  console.error(`    ${v.message}`);
  console.error(`    Remedy: ${v.remedy}`);
  console.error('');
}
process.exit(1);
