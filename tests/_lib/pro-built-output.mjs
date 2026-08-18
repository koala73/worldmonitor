import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardBuiltOutput, shouldSkipBuiltOutput } from './built-output-guard.mjs';

// public/pro/ stopped being committed in #6898 — `npm run build:pro` produces it
// during the deploy build. Tests that read those bytes therefore behave like the
// dist/dashboard.html suites: skip in a checkout that has not built /pro, and
// FAIL when WM_EXPECT_BUILT_OUTPUT=1 says CI built it and the files are still
// missing, so a broken build step can never masquerade as a silent skip.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// An EXISTENCE marker, not a completion marker -- be precise about which. Vite
// emits both index.html and welcome.html (they are the two rollupOptions.input
// entries) before prerender.mjs runs at all, and prerender.mjs then rewrites
// them in place. So neither file's presence proves the prerender step finished;
// what protects that is prerender.mjs's own process.exit(1) on a bad render,
// which fails `npm run build:pro` and therefore the deploy.
// welcome.html is still the better of the two: prerender.mjs writes it last, so
// on a crash between the two writes index.html is already rewritten while
// welcome.html is not -- and a partially-prerendered tree is the state the
// gated suites most need to notice.
export const PRO_BUILT_MARKER = resolve(repoRoot, 'public/pro/welcome.html');

const REBUILD_HINT = 'Run `npm run build:pro` first';

export function shouldSkipProBuiltOutput() {
  return shouldSkipBuiltOutput(PRO_BUILT_MARKER);
}

export function guardProBuiltOutput() {
  guardBuiltOutput(PRO_BUILT_MARKER, undefined, REBUILD_HINT);
}

// For suites that assert over a MIX of committed sources and built /pro pages.
// Dropping only the built entries keeps every committed-file assertion running
// in a checkout that has not built /pro, instead of skipping the whole case.
// guardProBuiltOutput() still fails the suite outright when CI says it built.
export function withoutUnbuiltProPaths(paths) {
  if (!shouldSkipProBuiltOutput()) return paths;
  const remaining = paths.filter((path) => !path.startsWith('public/pro/'));
  // Filtering to nothing would turn the caller's `for` loop into zero
  // iterations and pass silently -- the exact vacuum this helper exists to
  // avoid. A caller with only public/pro/ paths wants shouldSkipProBuiltOutput()
  // instead, so that its cases report as SKIPPED rather than as passing.
  if (remaining.length === 0) {
    throw new Error(
      'withoutUnbuiltProPaths() filtered every path away. A caller whose whole '
      + 'population is public/pro/ must gate on shouldSkipProBuiltOutput() so the '
      + 'cases skip visibly instead of asserting over an empty list.',
    );
  }
  return remaining;
}
