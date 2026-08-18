import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardBuiltOutput, shouldSkipBuiltOutput } from './built-output-guard.mjs';

// public/pro/ stopped being committed in #6898 — `npm run build:pro` produces it
// during the deploy build. Tests that read those bytes therefore behave like the
// dist/dashboard.html suites: skip in a checkout that has not built /pro, and
// FAIL when WM_EXPECT_BUILT_OUTPUT=1 says CI built it and the files are still
// missing, so a broken build step can never masquerade as a silent skip.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// welcome.html, not index.html: prerender.mjs iterates PAGES as [index, welcome]
// and writes welcome last, so it is the only one of the two whose presence means
// the whole `vite build && node prerender.mjs` chain finished rather than dying
// partway. Picking index.html would call a half-prerendered tree "built".
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
  return paths.filter((path) => !path.startsWith('public/pro/'));
}
