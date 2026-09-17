#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Raw localStorage guard (#7833)
// ---------------------------------------------------------------------------
//
// Android WebView with DOM storage disabled exposes `window.localStorage` as
// NULL rather than throwing, so an unguarded `localStorage.getItem(…)` is a
// TypeError, not a catchable SecurityError. That shape has produced three
// separate Sentry issues (WORLDMONITOR-122, -11X, -XG). `-11X` was resolved in
// Sentry on 2026-09-04 with no code change, which is why it came back.
//
// Nothing mechanical stood between those crashes and a green CI: `biome.json`
// has no matching rule, the repo has no eslint config, and none of the other
// `enforce-*.mjs` checks look at storage. Every guard was a hand-rolled
// convention — and conventions are exactly what produced the two call sites
// that LOOK guarded and are not:
//
//   - `cloud-prefs-sync.applyCloudBlob` wrapped its writes in
//     `try { … } finally { … }`. A `finally` catches nothing.
//   - `persistent-cache.deleteFromLocalStorageByPrefix` opened with
//     `typeof localStorage === 'undefined'`, and `typeof null` is `'object'`.
//
// Both are fixed; this guard is what stops the class from coming back a fourth
// time. It runs as a `lint:*` script rather than a test because the edit it
// must catch is "someone touched a service or a panel", which touches nothing
// under tests/ — and `scripts/prepush-changed-tests.sh` only runs a test file
// when that test file is itself in the changed set, so a test-only guard would
// first surface in CI with the PR already open.
//
// WHAT IS BANNED: a DEREFERENCE of `localStorage` outside the sanctioned
// helper. Dereferencing is what throws, so that is what the guard measures. A
// bare mention of the identifier is deliberately legal — `this === localStorage`
// inside the cloud-prefs setItem patch is an identity comparison that cannot
// throw on a null, and `vi.stubGlobal('localStorage', null)` is a string.
//
// Matching is done on the TypeScript AST. It began as regex, and review found
// a fresh bypass in three consecutive rounds — whitespace around the
// identifier's accessor, then around the RECEIVER's accessor, then
// `localStorage!.getItem(k)` (valid TS; `biome.json` leaves noNonNullAssertion
// off). Each round the patterns were widened and the class declared closed;
// each time the next round found another token. Enumerating TypeScript's
// receiver syntax by hand is the whack-a-mole, and the parser already does it
// exactly — so the parser does it. Switching also found three REAL
// dereferences the regex never saw, all `(localStorage as unknown as {…})`
// casts in `followed-only-chip.ts`.
//
// Note what a green run does and does not mean. It means "no NEW dereference
// outside `safe-storage.ts`, and the recorded legacy population still matches
// the tree". It does NOT mean storage access is safe everywhere. Known gaps:
//
//   - a local alias (`const ls = globalThis.localStorage; ls.getItem(k)`) or a
//     destructure (`const { getItem } = localStorage`). These need the type
//     CHECKER, not the parser — an AST alone cannot resolve what `ls` is — so
//     they are the one class this gate structurally cannot close;
//   - a `sessionStorage` deref, which has the identical null shape;
//   - a count-NEUTRAL swap inside an already-inventoried file: deleting one
//     dereference and adding another keeps N the same and passes green.
//
// Add a shape to DEREF_PROBES when a new one appears rather than reading
// silence as proof.

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { isMainModule } from './lib/main-module.mjs';
import { collectTsFiles } from './lib/source-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Every syntactic shape that reaches THROUGH `localStorage` to something that
 * can throw when the store is null or its property getter throws.
 *
 * These are matched on the TypeScript AST, not on source text. Three rounds of
 * review found three separate token classes a regex missed — whitespace around
 * the identifier's accessor, whitespace around the RECEIVER's accessor, and
 * the non-null assertion in `localStorage!.getItem(k)` (which `biome.json`
 * permits, since `noNonNullAssertion` is off). Each round I patched the token
 * and claimed the class was closed; each time the next round found another.
 * Hand-enumerating TypeScript's receiver syntax is the whack-a-mole, and the
 * parser already does it exactly.
 *
 * The AST also removes this gate's dependence on comment stripping — a comment
 * simply is not a node — which retires the blindness class that made the old
 * regex scanner miss 1826 lines of `panel-layout.ts`.
 *
 * `probes` are the fixtures the self-test matches, so a matcher that silently
 * stops recognizing a shape fails loudly instead of going quiet. Optional
 * chaining (`localStorage?.getItem`) is deliberately still counted: it survives
 * the NULL shape but does nothing for the THROWING one, so on its own it is a
 * half-guard. `safe-storage.ts` pairs it with a try/catch, which is why that
 * file — and only that file — is exempt.
 *
 * NOT closed by this, and not closable without type resolution: a local alias
 * (`const ls = localStorage; ls.getItem(k)`) or a destructure. Those need the
 * checker, not the parser. They stay named in the header as known gaps.
 */
export const DEREF_LABELS = {
  direct: 'localStorage.<member>',
  global: '<global>.localStorage',
  prototype: 'Storage.prototype.<member>.call(…)',
};

/** Globals that name the same Storage object. */
const STORAGE_GLOBALS = new Set(['window', 'globalThis', 'self', 'top', 'parent']);

/**
 * Fixtures per label. Every entry must be matched by the AST walk below; the
 * self-test asserts that, which is what keeps the matcher honest.
 */
export const DEREF_PROBES = {
  [DEREF_LABELS.direct]: [
    'localStorage.getItem(key);',
    'localStorage .getItem(key);',
    'localStorage\n  .getItem(key);',
    'localStorage /* c */.getItem(key);',
    'localStorage?.getItem(key);',
    'localStorage!.getItem(key);',
    '(localStorage).getItem(key);',
    '(localStorage!).getItem(key);',
    '(localStorage as Storage).getItem(key);',
    'localStorage[key] = value;',
    'localStorage!["k"];',
    'async function f() { (await localStorage).getItem(key); }',
    '(0, localStorage).getItem(key);',
  ],
  [DEREF_LABELS.global]: [
    'const ls = window.localStorage;',
    'globalThis.localStorage.getItem(key);',
    'self.localStorage.setItem(key, value);',
    'window?.localStorage.getItem(key);',
    'window .localStorage.getItem(key);',
    'window!.localStorage.getItem(key);',
    "window['localStorage'].getItem(key);",
  ],
  [DEREF_LABELS.prototype]: [
    'Storage.prototype.setItem.call(localStorage, key, value);',
    'Storage . prototype . setItem . call(localStorage, key, value);',
  ],
};

/**
 * Strip the value-preserving wrappers that can sit between an expression and
 * the receiver position, so the identifier underneath is still recognized.
 *
 * The list is the one hand-maintained surface left in this matcher, and review
 * has extended it twice (`!`/`as`, then `await`). DEREF_PROBES is its guard:
 * every shape here has a fixture. Note the boundary though — this closes shapes
 * an engineer might plausibly WRITE, not every shape one could construct. A
 * receiver deliberately obfuscated past this point is not a threat a
 * non-typechecking gate can close, and anyone editing this file could simply
 * add an inventory entry instead; the gate exists to catch ACCIDENTAL
 * reintroduction of the crash class.
 */
function unwrapReceiver(node) {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current)
      || ts.isNonNullExpression(current)
      || ts.isAsExpression(current)
      || ts.isAwaitExpression(current)
      || (ts.isSatisfiesExpression?.(current) ?? false)
      || (ts.isTypeAssertionExpression?.(current) ?? false)
    ) {
      current = current.expression;
      continue;
    }
    // `(0, localStorage).getItem(k)` — the comma operator yields its right
    // operand, and is a real idiom (it unbinds `this` on the callee).
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right;
      continue;
    }
    return current;
  }
}

/** Does this node read `.localStorage` / `['localStorage']` off a global? */
function isGlobalStorageAccess(node) {
  const base = unwrapReceiver(node.expression);
  if (!ts.isIdentifier(base) || !STORAGE_GLOBALS.has(base.text)) return false;
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'localStorage';
  return (
    ts.isElementAccessExpression(node)
    && !!node.argumentExpression
    && ts.isStringLiteralLike(node.argumentExpression)
    && node.argumentExpression.text === 'localStorage'
  );
}

/** `Storage.prototype.<member>.call(` — the same TypeError on a null receiver. */
function isStoragePrototypeCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrapReceiver(node.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'call') return false;
  const member = unwrapReceiver(callee.expression);
  if (!ts.isPropertyAccessExpression(member)) return false;
  const proto = unwrapReceiver(member.expression);
  if (!ts.isPropertyAccessExpression(proto) || proto.name.text !== 'prototype') return false;
  const base = unwrapReceiver(proto.expression);
  return ts.isIdentifier(base) && base.text === 'Storage';
}

/**
 * The canonical helper. Exempt BY NAME, not by the incidental fact that it
 * currently lives at this path — move it and this entry has to move with it,
 * which is the point.
 *
 * Nothing else is exempt. The remaining "safe storage" implementations
 * (`loadFromStorage`/`saveToStorage` in `src/utils/index.ts`, the file-private
 * helpers in `browser-key-session.ts`, and `safeLocalStorage()` in
 * `passkey-offer-state.ts`) are counted in the inventory below rather than
 * waved through, so the duplication stays visible and a further implementation
 * cannot land quietly. #7833 review caught this file's own author adding one:
 * cloud-prefs-sync grew a private rawGet/rawSet/rawRemove trio justified by a
 * threat (an own-property override of `localStorage`) that exists nowhere in
 * this repo. It now uses the shared helper.
 */
export const GUARD_EXEMPT_FILES = new Set(['src/utils/safe-storage.ts']);

/**
 * Every `<file> :: <idiom> xN` triple outside the helper, as of #7833.
 *
 * Recorded with an OCCURRENCE COUNT, not a per-file or per-(file, idiom)
 * boolean, for the reason `enforce-panel-content-writes.mjs` learned the hard
 * way: a boolean cannot see a SECOND deref of an idiom the file already
 * carries, so a fresh `localStorage.getItem` in `App.ts` — which already has
 * dozens — would pass green. That is the highest-traffic regression shape
 * there is, because new code lands in the files that already read storage.
 * With counts, a new deref bumps N and fails `unlisted`; a migration lowers N
 * and fails `stale`.
 *
 * This list is a ratchet, not a permission slip:
 *   - a NEW pair, or a HIGHER count, fails the guard — route the access
 *     through `@/utils/safe-storage` instead;
 *   - a pair that shrank or vanished MUST be updated here, so the inventory
 *     can never quietly outlive the drift it records.
 *
 * Counts come from the AST, so a comment mentioning an idiom is simply not a
 * node — documenting the rule neither inflates an entry nor keeps a migrated
 * one alive.
 *
 * An entry here is NOT automatically a bug. Three populations are mixed in,
 * and the CLI cannot tell them apart — read the call site before "fixing" one:
 *
 *   1. Genuinely unguarded, and reachable. These are the #7833 backlog. Boot
 *      path first.
 *   2. Guarded by a surrounding try/catch or a capability probe that really
 *      does fire. `src/App.ts` is the large one: its constructor probes with a
 *      write/remove inside a try and drops to `storageAvailable = false`, and
 *      every migration below it sits behind that flag. Its entry exists to
 *      catch a NEW deref landing OUTSIDE the probe, not because the cascade
 *      is broken.
 *   3. Deliberately raw, because the helper's contract is wrong for the site.
 *      `persistent-cache` needs the QuotaExceededError to distinguish a full
 *      disk (`markStorageQuotaExceeded`) from an unusable store, and
 *      `settings-persistence.importSettings` must fail LOUDLY rather than
 *      report "0 keys imported" as success. These are terminal states, not
 *      unfinished migrations.
 *
 * The CLI derives and reports the entry and call-site totals from this
 * registry; do not duplicate those shrinking counts in this comment.
 */
export const LEGACY_RAW_LOCAL_STORAGE = [
  'src/App.ts :: localStorage.<member> x74',
  'src/app/event-handlers.ts :: localStorage.<member> x5',
  'src/app/map-dimension-control.ts :: localStorage.<member> x1',
  'src/app/panel-layout.ts :: localStorage.<member> x9',
  'src/app/pro-activation-controller.ts :: <global>.localStorage x8',
  'src/bootstrap/sw-update.ts :: localStorage.<member> x1',
  'src/components/AviationCommandBar.ts :: localStorage.<member> x1',
  'src/components/ChatAnalystPanel.ts :: <global>.localStorage x2',
  'src/components/ConsumerPricesPanel.ts :: localStorage.<member> x2',
  'src/components/GlobeMap.ts :: localStorage.<member> x2',
  'src/components/InsightsPanel.ts :: localStorage.<member> x1',
  'src/components/NewsPanel.ts :: localStorage.<member> x6',
  'src/components/ProActivationChip.ts :: localStorage.<member> x4',
  'src/components/ProBanner.ts :: localStorage.<member> x5',
  'src/components/ProPreviewSection.ts :: localStorage.<member> x2',
  'src/components/SearchModal.ts :: localStorage.<member> x2',
  'src/components/StrategicPosturePanel.ts :: localStorage.<member> x2',
  'src/components/WorldClockPanel.ts :: localStorage.<member> x1',
  'src/config/basemap.ts :: localStorage.<member> x2',
  'src/config/beta.ts :: localStorage.<member> x1',
  'src/config/variant.ts :: localStorage.<member> x1',
  'src/main.ts :: localStorage.<member> x2',
  'src/mcp-grant-main.ts :: localStorage.<member> x1',
  'src/services/ai-flow-settings.ts :: localStorage.<member> x4',
  'src/services/analytics.ts :: <global>.localStorage x3',
  'src/services/anonymous-identity-storage.ts :: localStorage.<member> x5',
  'src/services/aviation/watchlist.ts :: localStorage.<member> x2',
  'src/services/breaking-news-alerts.ts :: localStorage.<member> x4',
  'src/services/browser-key-session.ts :: localStorage.<member> x2',
  'src/services/cached-risk-scores.ts :: localStorage.<member> x5',
  'src/services/cached-theater-posture.ts :: localStorage.<member> x4',
  'src/services/followed-countries.ts :: localStorage.<member> x3',
  'src/services/font-scale-settings.ts :: localStorage.<member> x2',
  'src/services/font-settings.ts :: localStorage.<member> x2',
  'src/services/globe-render-settings.ts :: localStorage.<member> x6',
  'src/services/i18n.ts :: localStorage.<member> x3',
  'src/services/live-stream-settings.ts :: localStorage.<member> x2',
  'src/services/map-mode-preference.ts :: localStorage.<member> x1',
  'src/services/market-watchlist.ts :: localStorage.<member> x6',
  'src/services/mission-presets.ts :: localStorage.<member> x7',
  'src/services/persistent-cache.ts :: localStorage.<member> x3',
  'src/services/referral-capture.ts :: localStorage.<member> x7',
  'src/services/runtime-config.ts :: localStorage.<member> x2',
  'src/services/sentiment-gate.ts :: localStorage.<member> x1',
  'src/services/tab-store.ts :: localStorage.<member> x2',
  'src/services/telegram-watchlist.ts :: localStorage.<member> x2',
  'src/services/trending-keywords.ts :: <global>.localStorage x1',
  'src/services/trending-keywords.ts :: localStorage.<member> x2',
  'src/services/webcams/pinned-store.ts :: localStorage.<member> x2',
  'src/services/widget-store.ts :: localStorage.<member> x4',
  'src/utils/followed-only-chip.ts :: localStorage.<member> x7',
  'src/utils/index.ts :: localStorage.<member> x2',
  'src/utils/panel-storage.ts :: localStorage.<member> x3',
  'src/utils/theme-manager.ts :: localStorage.<member> x5',
];

/**
 * Floor for the scanned population, derived from the file count at #7833. A
 * moved directory or a changed extension filter would otherwise shrink the
 * scan toward zero and let every assertion pass vacuously — the silent
 * failure mode this guard exists to prevent.
 */
export const MIN_SCANNED_FILES = 700;

/**
 * `<idiom> xN` for every raw-storage dereference in `source`, with counts.
 *
 * Counting rule, and why it does not double-count: a node is counted when EITHER
 * it reads `localStorage` off a global (`window.localStorage`), OR it is a
 * member access whose unwrapped receiver is the bare `localStorage` identifier.
 * The two are mutually exclusive per node, so `window.localStorage.getItem(k)`
 * counts once — at the inner global read — because the outer access's receiver
 * unwraps to a property access rather than to a bare identifier.
 *
 * A bare `localStorage` that is never accessed through is NOT counted:
 * `this === localStorage` is an identity comparison that cannot throw, and
 * flagging it would push callers to "fix" working code.
 */
export function rawStorageUsesIn(source) {
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const counts = new Map();
  const bump = (label) => counts.set(label, (counts.get(label) ?? 0) + 1);

  const visit = (node) => {
    if (isStoragePrototypeCall(node)) {
      bump(DEREF_LABELS.prototype);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (isGlobalStorageAccess(node)) {
        bump(DEREF_LABELS.global);
      } else {
        const receiver = unwrapReceiver(node.expression);
        if (ts.isIdentifier(receiver) && receiver.text === 'localStorage') bump(DEREF_LABELS.direct);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);

  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, n]) => `${label} x${n}`);
}

/** Scan the tree and return everything the assertions and the CLI both need. */
export function scanRepo(root = REPO_ROOT) {
  const allFiles = collectTsFiles(path.join(root, 'src'), { readdirSync, lstatSync, join: path.join });
  const scanned = allFiles.filter(
    (abs) => !GUARD_EXEMPT_FILES.has(path.relative(root, abs)),
  );

  const observed = scanned
    .flatMap((abs) =>
      rawStorageUsesIn(readFileSync(abs, 'utf8')).map(
        (label) => `${path.relative(root, abs)} :: ${label}`,
      ),
    )
    .sort();

  const allowed = new Set(LEGACY_RAW_LOCAL_STORAGE);
  const observedSet = new Set(observed);

  return {
    scannedFiles: scanned,
    observed,
    unlisted: observed.filter((pair) => !allowed.has(pair)),
    stale: LEGACY_RAW_LOCAL_STORAGE.filter((pair) => !observedSet.has(pair)),
  };
}

function main() {
  const result = scanRepo();
  const problems = [];

  if (result.scannedFiles.length < MIN_SCANNED_FILES) {
    problems.push(
      `Expected >= ${MIN_SCANNED_FILES} scanned files under src/ (860 at #7833), found ${result.scannedFiles.length} — the scan or the source layout has drifted.`,
    );
  }

  if (result.unlisted.length > 0) {
    problems.push(
      'These dereference localStorage directly. Android WebView with DOM storage disabled exposes it as null, so each one is a TypeError on those devices (#7833, the WORLDMONITOR-122 class):',
      ...result.unlisted.map(
        (pair) =>
          `  - ${pair}\n      read/write through safeStorageGet / safeStorageSet / safeStorageRemove / safeStorageKeys from @/utils/safe-storage`,
      ),
      'If the helper is genuinely wrong for the site — you need the QuotaExceededError, or the failure must be loud — say so in a comment at the call site and add the entry to LEGACY_RAW_LOCAL_STORAGE with its count.',
    );
  }

  if (result.stale.length > 0) {
    problems.push(
      'These recorded dereferences no longer match the tree. Update LEGACY_RAW_LOCAL_STORAGE in scripts/enforce-safe-local-storage.mjs (lower the count, or delete the line) so the inventory keeps matching reality.',
      ...result.stale.map((pair) => `  - ${pair}`),
    );
  }

  if (problems.length > 0) {
    console.error('Raw localStorage guard failed (#7833).');
    for (const line of problems) console.error(line);
    process.exitCode = 1;
    return;
  }

  const sites = LEGACY_RAW_LOCAL_STORAGE.reduce(
    (sum, pair) => sum + Number(pair.split(' x').pop()),
    0,
  );
  console.log(
    `Raw localStorage guard passed (${result.scannedFiles.length} files scanned; ${LEGACY_RAW_LOCAL_STORAGE.length} legacy entries / ${sites} dereferences tracked).`,
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
