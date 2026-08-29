/**
 * Re-points God's Eye View's client-side API calls at the `/api/gev/*` mount.
 *
 * Upstream's client fetches `/api/radio/stations`, `/api/opensky`, and 49
 * other absolute literals scattered across 25 modules — there is no base-URL
 * helper to redirect. Embedded in World Monitor those have to move under
 * `/api/gev/`, because `/api/opensky` collides with World Monitor's own route
 * and because one nginx `location /api/gev/` is worth 24 per-route rules.
 *
 * This is a script rather than a one-time hand edit for the same reason
 * `vendor-gev-css.mjs` is: re-vendoring a newer God's Eye View should be a
 * copy plus two commands, not a manual reconciliation.
 *
 * The route list is not hardcoded — it is read from the server that actually
 * mounts them, so the two halves of the contract cannot drift.
 *
 * Run:    node scripts/vendor-gev-api-base.mjs [--check]
 * Verify: tests/gev-api-contract.test.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEV_API_PREFIX } from '../server/gev/gev-api-paths.mjs';
import { createGevApiApp } from '../server/gev/gev-api-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CLIENT_ROOT = join(ROOT, 'src', 'gev', 'src');

const CHECK_ONLY = process.argv.includes('--check');

/** Source files whose API literals we rewrite. Tests included on purpose —
 *  several assert against the exact URLs the client builds. */
const EXTENSIONS = new Set(['.js', '.mjs']);

async function collectFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'local_data') continue;
      await collectFiles(full, out);
    } else if (EXTENSIONS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Build the set of first path segments God's Eye View owns, from the routes
 * the server actually registers. `/api/gev/adsblol/trace` contributes
 * `adsblol`; `/api/gev/radio` contributes `radio`.
 */
function ownedSegments(routes) {
  const segments = new Set();
  for (const route of routes) {
    const rest = route.slice(`${GEV_API_PREFIX}/`.length);
    const head = rest.split('/')[0];
    if (head) segments.add(head);
  }
  return segments;
}

function buildPatterns(segments) {
  const alternation = [...segments]
    .sort((a, b) => b.length - a.length)   // longest first: opensky-track before opensky
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  return [
    // 1. String literals: '/api/radio', `/api/tomtom/flow/...`
    //    The trailing lookahead keeps `/api/openskyfoo` from matching
    //    `opensky`; the leading quote keeps prose in comments alone.
    {
      re: new RegExp(`(['"\`])/api/(${alternation})(?=$|[/?'"\`])`, 'g'),
      replace: (_m, quote, segment) => `${quote}${GEV_API_PREFIX}/${segment}`,
    },
    // 2. Regex literals with escaped slashes: /^\/api\/tomtom\/flow\/.../
    //    Several upstream tests assert the exact URL this way, so missing
    //    them leaves the suite red even though the client is correct.
    //    Anchored on the owned-segment alternation, so an external URL like
    //    `https:\/\/maps\.googleapis\.com\/maps\/api\/geocode` does not
    //    match — `geocode` is not a segment God's Eye View serves.
    {
      re: new RegExp(`\\\\/api\\\\/(${alternation})(?=$|[\\\\'"\`?])`, 'g'),
      replace: (_m, segment) => `\\/api\\/gev\\/${segment}`,
    },
  ];
}

const { routes } = await createGevApiApp({ mode: 'production' });
const patterns = buildPatterns(ownedSegments(routes));

const files = await collectFiles(CLIENT_ROOT);
const touched = [];
let occurrences = 0;

for (const file of files) {
  const before = readFileSync(file, 'utf-8');
  let after = before;
  for (const { re, replace } of patterns) {
    after = after.replace(re, (...args) => {
      occurrences++;
      return replace(...args);
    });
  }
  if (after !== before) {
    touched.push(relative(ROOT, file));
    if (!CHECK_ONLY) writeFileSync(file, after);
  }
}

console.log(`vendor-gev-api-base: ${routes.length} routes, ${files.length} files scanned`);

if (CHECK_ONLY) {
  if (touched.length > 0) {
    console.error(
      `\n  ${occurrences} un-namespaced God's Eye View API literal(s) in `
      + `${touched.length} file(s):`,
    );
    for (const f of touched) console.error(`    ${f}`);
    console.error('\n  Run: node scripts/vendor-gev-api-base.mjs');
    process.exit(1);
  }
  console.log('  all client API literals are namespaced');
} else {
  console.log(`  rewrote ${occurrences} literal(s) across ${touched.length} file(s)`);
  for (const f of touched) console.log(`    ${f}`);
}
