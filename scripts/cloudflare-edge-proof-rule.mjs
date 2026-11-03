#!/usr/bin/env node
/**
 * Cloudflare Transform Rule contract for `x-wm-edge-proof` (#8402 / #6431).
 *
 * ## Why this exists
 *
 * `getClientIp` trusts `cf-connecting-ip` only when `x-wm-edge-proof` matches
 * `CF_EDGE_PROOF_SECRET`. IP-scoped endpoint rate limits reject unproven
 * `cf-connecting-ip` with 403 rather than sharing a Cloudflare PoP bucket.
 *
 * The Transform Rule that injects the proof header lives in the Cloudflare
 * dashboard. This script is the in-repo expression operators must keep in
 * sync with every path that depends on a real client IP — so a rule written
 * for a subset of `/api/*` cannot silently leave sibling budgets PoP-shared.
 *
 * ## Apply (dashboard)
 *
 * Rules → Transform Rules → Modify Request Header → custom filter expression:
 *
 *   (http.request.uri.path matches "^/(api|mcp|ask|oauth|a2a|docs/mcp)(/|$)")
 *
 * Set static header `x-wm-edge-proof` to the same secret stored in Vercel as
 * `CF_EDGE_PROOF_SECRET`. Confirm Preview and Production both have the secret.
 *
 * Live zone confirmation still requires Cloudflare dashboard / API access;
 * `--check` only proves the in-repo expression covers every declared
 * IP-scoped endpoint policy path.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

/**
 * First path segment alternatives shared by the published Cloudflare
 * expression and every in-repo coverage check. Edit here only.
 */
export const EDGE_PROOF_PATH_ALTERNATIVES = Object.freeze([
  'api',
  'mcp',
  'ask',
  'oauth',
  'a2a',
  'docs/mcp',
]);

/** Regex source pasted into Cloudflare's `matches` operator (anchors included). */
export const EDGE_PROOF_PATH_MATCHER_SOURCE = `^/(${EDGE_PROOF_PATH_ALTERNATIVES.join('|')})(/|$)`;

/** Same matcher Cloudflare evaluates against `http.request.uri.path`. */
export const EDGE_PROOF_PATH_MATCHER = new RegExp(EDGE_PROOF_PATH_MATCHER_SOURCE);

/** Filter expression operators must paste into the Cloudflare Transform Rule. */
export const EDGE_PROOF_TRANSFORM_EXPRESSION =
  `(http.request.uri.path matches "${EDGE_PROOF_PATH_MATCHER_SOURCE}")`;

/** Human-readable path prefixes the Transform Rule must cover. */
export const EDGE_PROOF_PATH_PREFIXES = Object.freeze([
  '/api/',
  '/mcp',
  '/ask',
  '/oauth/',
  '/a2a',
  '/docs/mcp',
]);

/** True when pathname would match the published Transform Rule expression. */
export function pathCoveredByExpression(pathname) {
  return EDGE_PROOF_PATH_MATCHER.test(pathname);
}

function endpointPolicyPathsFromSource() {
  const source = readFileSync(join(ROOT, 'server/_shared/rate-limit.ts'), 'utf8');
  const block = source.match(/export const ENDPOINT_RATE_POLICIES[\s\S]*?^};/m)?.[0];
  if (!block) throw new Error('ENDPOINT_RATE_POLICIES block not found in rate-limit.ts');
  return [...block.matchAll(/'(\/api\/[^']+)'/g)].map((match) => match[1]);
}

function main() {
  const paths = endpointPolicyPathsFromSource();
  const uncovered = [...paths, ...EDGE_PROOF_PATH_PREFIXES].filter((path) => !pathCoveredByExpression(path));
  if (uncovered.length > 0) {
    console.error('Edge-proof Transform Rule expression does not cover:');
    for (const path of uncovered) console.error(`  ${path}`);
    process.exit(1);
  }

  if (CHECK_ONLY) {
    console.log(
      `Edge-proof Transform Rule expression covers ${paths.length} ENDPOINT_RATE_POLICIES paths.`,
    );
    console.log(`Expression: ${EDGE_PROOF_TRANSFORM_EXPRESSION}`);
    return;
  }

  console.log(EDGE_PROOF_TRANSFORM_EXPRESSION);
  console.log(`# covers ${paths.length} endpoint rate-limit paths`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cloudflare-edge-proof-rule.mjs')) {
  main();
}
