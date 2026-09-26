#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Overlay reload-contract guard
// ---------------------------------------------------------------------------
//
// Every first-party overlay the reload guard can see must declare its reload
// contract with `declareOverlay(el, { reload })` (src/utils/open-modal.ts).
// Silence means "block every automatic reload until this closes", and an
// overlay that auto-opens and is never closed wedges the tab for the session.
// That was accepted as a residual risk in #8580, fixed for one surface in
// #8593, and recurred on the next surface within an hour of that deploy
// (Sentry WORLDMONITOR-15X and WORLDMONITOR-15Z: 150 of 198 deferrals named
// `signal-modal-overlay`). The failure mode is omission, so this gate makes
// omission a failed push.
//
// Two rules, both structural:
//
//   1. SITES. Every creation idiom in SITE_PATTERNS_BY_CLAUSE is matched by a
//      `declareOverlay` call on the same receiver in the same file. Sites are
//      keyed on candidate IDENTITY (the role attribute, the class token, the
//      `dialog` element), never on how the overlay is revealed: four surfaces
//      are born visible (`className = 'modal-overlay active'` then append)
//      and never touch classList, and ~30 `classList.add('active')` sites are
//      tabs and map controls, so a reveal idiom is the wrong key.
//   2. LOCKSTEP. Every `reload()` call under src/bootstrap/ sits inside an
//      installer that consults `findReloadBlockingModal`. The original bug
//      (#8577) was one consumer with the guard and one without, and a
//      remembered convention already failed here once.
//
// Runs as a `lint:*` script on pre-push (gated on src/) and in the CI biome
// job, not only as a test, for the reason `enforce-panel-content-writes.mjs`
// gives: the edit it must catch is "someone added an overlay", which touches
// nothing under tests/, and `scripts/prepush-changed-tests.sh` only runs a
// test file when that test file is itself in the changed set.
//
// What a green run proves and what it does not. It means every creation
// idiom in the table is matched by a receiver-matched declaration. It does
// not mean an undeclared overlay is impossible: an idiom outside the table
// escapes. That is why `findReloadBlockingModal` reports
// `policy: 'undeclared'` to Sentry; a non-`cl-` label with that value is this
// gate's escape, and the table should grow by that idiom rather than the
// silence being read as proof.

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { isMainModule } from './lib/main-module.mjs';
import { collectTsFiles, lexSource } from './lib/source-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Keyed by the clauses of `MODAL_SELECTORS` in src/utils/open-modal.ts. The
 * self-test pins `Object.keys` deep-equal to that tuple, so a selector clause
 * added there without a creation idiom here fails a test.
 *
 * kind:
 *   'site'         counts as an overlay creation site. `re` captures the
 *                  receiver token (group 1 or 2) when the form has one; the
 *                  template form (`role="dialog"` inside markup) has none.
 *   'companion'    never stands alone in this tree (the scan reports any hit
 *                  farther than SITE_CLUSTER_RADIUS_LINES from a 'site' hit,
 *                  and the CLI fails on it), so it is not counted: one element
 *                  setting role + aria-modal is one site.
 *   'third-party'  no first-party creation form exists; must stay undeclared,
 *                  and undeclared blocks.
 *
 * `probe` is the fixture each pattern must match; `negativeProbe` is a live
 * shape that must NOT match, because `closest('[role="dialog"]')` reads an
 * overlay, it does not create one. The leading `(?<!\[)` is what separates
 * the two.
 */
export const SITE_PATTERNS_BY_CLAUSE = {
  '[aria-modal="true"]': {
    kind: 'companion',
    re: /(?<!\[)(?:([\w$]+(?:\.[\w$]+)*)\.setAttribute\(\s*['"]aria-modal['"]\s*,\s*['"]true['"]\s*\)|\baria-modal=["']true["']|([\w$]+(?:\.[\w$]+)*)\.ariaModal\s*=\s*['"]true['"])/g,
    probe: "overlay.setAttribute('aria-modal', 'true');",
    negativeProbe: "el.closest('[aria-modal=\"true\"]')",
  },
  '[role="dialog"]': {
    kind: 'site',
    re: /(?<!\[)(?:([\w$]+(?:\.[\w$]+)*)\.setAttribute\(\s*['"]role['"]\s*,\s*['"]dialog['"]\s*\)|\brole=["']dialog["']|([\w$]+(?:\.[\w$]+)*)\.role\s*=\s*['"]dialog['"])/g,
    probe: "this.element.setAttribute('role', 'dialog');",
    negativeProbe: "anchor.closest('.modal, [role=\"dialog\"]')",
  },
  '.cl-modalBackdrop': { kind: 'third-party', re: null, probe: null, negativeProbe: null },
  '.modal-overlay': {
    kind: 'site',
    re: /(?:([\w$]+(?:\.[\w$]+)*)\.className\s*=\s*['"`](?:[^'"`]*\s)?modal-overlay(?=[\s'"`])|([\w$]+(?:\.[\w$]+)*)\.classList\.add\(\s*['"]modal-overlay['"]|\bclass=["'](?:[^"']*\s)?modal-overlay(?=[\s"']))/g,
    probe: "overlay.className = 'modal-overlay active';",
    // A class SELECTOR matches whole tokens. `embed-modal-overlay` (live in
    // src/app/event-handlers.ts) is not `.modal-overlay`, and a `\b` regex says
    // otherwise because `-` is a word boundary.
    negativeProbe: "overlay.className = 'embed-modal-overlay active';",
  },
  'dialog[open]': {
    kind: 'site',
    re: /(?:createElement\(\s*['"]dialog['"]\s*\)|<dialog\b)/g,
    probe: "const d = document.createElement('dialog');",
    negativeProbe: "doc.querySelectorAll('dialog[open]')",
  },
};

/** Captures the receiver when it is an identifier path; other forms leave it undefined. */
export const DECLARATION_RE = /\bdeclareOverlay\(\s*([\w$]+(?:\.[\w$]+)*)?/g;

/**
 * The declarations that opt OUT of blocking. 'safe' is the dangerous direction
 * (a wrong 'safe' on a form destroys typed work), so the self-test pins the
 * exact set and widening it is a visible review event, not a silent change.
 */
export const SAFE_DECLARATION_RE = /\bdeclareOverlay\(\s*([^,{]+?)\s*,\s*\{\s*reload:\s*['"]safe['"]/g;

/** Hits this close together are one element's attributes, not two sites. */
export const SITE_CLUSTER_RADIUS_LINES = 3;

/** 21 sites in 19 files when this gate landed. A scan that finds fewer has drifted. */
export const MIN_SITE_COUNT = 21;

/** The module that defines the vocabulary; its selector strings are not sites. */
export const EXCLUDED_FILES = new Set(['src/utils/open-modal.ts']);

/** Where automatic reloads live, and the predicate each one must consult. */
export const RELOAD_CONSUMER_DIR = 'src/bootstrap';
export const RELOAD_GUARD = 'findReloadBlockingModal';

/**
 * The one reload consumer the lockstep rule does not cover, with the reason.
 * Not a permission slip: the self-test fails if the exempt file stops having
 * an unguarded reload, so the entry cannot outlive what it excuses.
 *
 * chunk-reload.ts reloads once on `vite:preloadError`, when the running bundle
 * can no longer load its own code. It predates the guard and has no retry
 * path. Deferring it means deciding who reloads later (the stale-bundle check
 * does, on its next trigger, when the failure is a post-deploy hash mismatch)
 * and what happens to its one-shot session key. That is its own change.
 */
export const RELOAD_GUARD_EXEMPT = new Map([
  ['src/bootstrap/chunk-reload.ts', 'failure recovery with no retry path; deferral semantics undecided'],
]);

/**
 * @typedef {{ line: number, clause: string, receiver: string | null, idiom: string }} Site
 * @typedef {{ line: number, receiver: string | null }} Declaration
 * @typedef {{ file: string, site: Site, reason: 'no-declaration' | 'receiver-mismatch' }} Violation
 */

/** Global regexes carry `lastIndex`; a probe `.test()` must not shift a later scan. */
function fresh(re) {
  return new RegExp(re.source, re.flags);
}

function lineAt(code, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (code.charCodeAt(i) === 10) line += 1;
  return line;
}

function hitsFor(code, clause, pattern) {
  const out = [];
  for (const m of code.matchAll(fresh(pattern.re))) {
    out.push({ line: lineAt(code, m.index), clause, receiver: m[1] ?? m[2] ?? null, idiom: m[0].trim() });
  }
  return out;
}

/** Every companion hit, for the standalone check. */
export function companionHitsIn(code) {
  return Object.entries(SITE_PATTERNS_BY_CLAUSE)
    .filter(([, p]) => p.kind === 'companion')
    .flatMap(([clause, p]) => hitsFor(code, clause, p));
}

/**
 * Site-kind hits, clustered. Two hits within SITE_CLUSTER_RADIUS_LINES on the
 * same receiver (or where either has none) are one element's attributes; two
 * different receivers that close together are two sites.
 * @returns {Site[]}
 */
export function sitesIn(code) {
  const hits = Object.entries(SITE_PATTERNS_BY_CLAUSE)
    .filter(([, p]) => p.kind === 'site')
    .flatMap(([clause, p]) => hitsFor(code, clause, p))
    .sort((a, b) => a.line - b.line);
  const sites = [];
  for (const hit of hits) {
    const last = sites[sites.length - 1];
    const sameElement = last
      && hit.line - last.line <= SITE_CLUSTER_RADIUS_LINES
      && (hit.receiver === null || last.receiver === null || hit.receiver === last.receiver);
    if (sameElement) {
      if (last.receiver === null) last.receiver = hit.receiver;
      continue;
    }
    sites.push({ ...hit });
  }
  return sites;
}

/** @returns {Declaration[]} */
export function declarationsIn(code) {
  return [...code.matchAll(fresh(DECLARATION_RE))].map((m) => ({ line: lineAt(code, m.index), receiver: m[1] ?? null }));
}

/** Receiver text of every `reload: 'safe'` declaration. */
export function safeDeclarationsIn(code) {
  return [...code.matchAll(fresh(SAFE_DECLARATION_RE))].map((m) => m[1]);
}

/**
 * The rule, per file. Each site with a receiver consumes one declaration on the
 * same receiver. Each site without a receiver (template form) consumes any
 * remaining declaration. Unconsumed sites are violations; extra declarations
 * are fine (a surface may re-declare per open path).
 * @returns {Violation[]}
 */
export function violationsIn(file, code) {
  const sites = sitesIn(code);
  const pool = declarationsIn(code);
  const unmatched = [];
  for (const site of sites.filter((s) => s.receiver !== null)) {
    const i = pool.findIndex((d) => d.receiver === site.receiver);
    if (i === -1) unmatched.push(site);
    else pool.splice(i, 1);
  }
  for (const site of sites.filter((s) => s.receiver === null)) {
    if (pool.length === 0) unmatched.push(site);
    else pool.shift();
  }
  // A leftover declaration on some other receiver means the author declared
  // the wrong element, which is a different fix from forgetting entirely.
  const reason = pool.some((d) => d.receiver !== null) ? 'receiver-mismatch' : 'no-declaration';
  return unmatched.map((site) => ({ file, site, reason }));
}

/** Advice for one violation. The question the author must answer is in the message, not in a wiki. */
export function adviceFor(violation) {
  const { file, site, reason } = violation;
  const receiver = site.receiver ?? '<el>';
  const missing = reason === 'receiver-mismatch'
    ? `this file calls declareOverlay, but not on ${receiver}. The declaration goes on the element carrying the role/class, not on a parent or child.`
    : `nothing in this file calls declareOverlay(${receiver}, ...).`;
  return [
    `${file}:${site.line}  ${site.idiom}`,
    `  creates an overlay the reload guard will see, and ${missing}`,
    '',
    '  Every first-party overlay declares its reload contract:',
    "    declareOverlay(el, { reload: 'blocking' })  it can hold typed input, or a flow the user is mid-way through",
    "    declareOverlay(el, { reload: 'safe' })      it holds nothing a reload would lose (a read-only display, a prompt that re-appears)",
    '',
    '  Ask first: can this open WITHOUT a user gesture (data arrival, a timer, boot)? If yes and it is not',
    "  'safe', every automatic reload in that session waits for a close that may never come",
    '  (Sentry WORLDMONITOR-15X, WORLDMONITOR-15Z). Undeclared third-party DOM (Clerk) stays blocking by design.',
  ].join('\n');
}

/**
 * An explicit, greppable opt-out for a reload the user asked for by clicking.
 *
 * Automatic reloads must be guarded. A Reload button the user pressed must not
 * be, because deferring it would ignore a direct instruction. That difference
 * is intent, which no amount of structure reveals, so the call site states it.
 */
export const USER_INITIATED_MARKER = 'reload:user-initiated';

/**
 * Every `reload()` / `.reload()` call that its OWN function does not guard.
 *
 * The rule is same-body: the function containing the reload must itself call
 * `findReloadBlockingModal`, and a guard sitting in a sibling or nested closure
 * does not count. An earlier version accepted any reload whose outermost
 * enclosing function mentioned the guard anywhere, which let a SECOND reload
 * added on another branch of an already-guarded installer through untouched
 * (caught in review on #8663). A guard reached later cannot protect a reload
 * that already happened, so "somewhere in this installer" is not a safe test.
 *
 * Both shipped automatic reloads satisfy the same-body rule already:
 * `reloadOrDefer` in stale-bundle-check and `onHidden` in sw-update each call
 * the guard and the reload in one body. The only legitimate unguarded reload is
 * the toast's Reload click, which carries `USER_INITIATED_MARKER`.
 *
 * Matched on the TypeScript AST rather than text, because "enclosing function"
 * is structure, and because a comment mentioning reload is simply not a node.
 * @returns {Array<{ line: number, text: string }>}
 */
export function unguardedReloadsIn(source) {
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const isReloadCall = (node) => ts.isCallExpression(node) && (
    (ts.isIdentifier(node.expression) && node.expression.text === 'reload')
    || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'reload')
  );
  /** Calls the guard in `fn`'s own body. A nested closure's guard is not `fn`'s. */
  const guardsInOwnBody = (fn) => {
    let found = false;
    const visit = (node) => {
      if (found) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === RELOAD_GUARD) {
        found = true;
        return;
      }
      if (node !== fn && ts.isFunctionLike(node)) return;
      ts.forEachChild(node, visit);
    };
    visit(fn);
    return found;
  };
  const nearestFunction = (node) => {
    for (let cursor = node.parent; cursor; cursor = cursor.parent) {
      if (ts.isFunctionLike(cursor)) return cursor;
    }
    return null;
  };
  /**
   * The marker on the reload's own statement. Deliberately not inherited from an
   * ancestor: marking a whole handler would re-open the hole this rule closes.
   */
  const isUserInitiated = (node) => {
    for (let cursor = node; cursor; cursor = cursor.parent) {
      if (ts.isStatement(cursor)) {
        const ranges = ts.getLeadingCommentRanges(source, cursor.getFullStart()) ?? [];
        return ranges.some((r) => source.slice(r.pos, r.end).includes(USER_INITIATED_MARKER));
      }
    }
    return false;
  };
  /**
   * Inside the initializer of the injectable `reload` binding, as in
   * `const reload = options.reload ?? (() => window.location.reload())`.
   *
   * That is the escape hatch's DEFINITION, not a trigger. It runs only when a
   * caller invokes `reload()`, and that caller is what this rule checks. Counting
   * it would demand a guard inside a one-line default factory, which can never
   * have one.
   */
  const isReloadDefaultFactory = (node) => {
    for (let cursor = node; cursor; cursor = cursor.parent) {
      if (ts.isVariableDeclaration(cursor) && ts.isIdentifier(cursor.name) && cursor.name.text === 'reload') return true;
    }
    return false;
  };
  const out = [];
  const visit = (node) => {
    if (isReloadCall(node) && !isReloadDefaultFactory(node)) {
      const fn = nearestFunction(node);
      if ((fn === null || !guardsInOwnBody(fn)) && !isUserInitiated(node)) {
        out.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText() });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return out;
}

function hasReloadCall(source) {
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node) && (
      (ts.isIdentifier(node.expression) && node.expression.text === 'reload')
      || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'reload')
    )) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

/**
 * Walk src/, lex each file, fail on an untrusted lex rather than scanning less
 * than claimed, and return the inventory the CLI and the self-test both read.
 */
export function scanRepo(root = REPO_ROOT) {
  const absFiles = collectTsFiles(path.join(root, 'src'), { readdirSync, lstatSync, join: path.join });
  const files = [];
  const unparsable = [];
  const sites = [];
  const violations = [];
  const loneCompanions = [];
  const safeDeclarations = [];
  const reloadConsumers = [];
  const unguardedReloads = [];
  const exemptionsUsed = new Set();

  for (const abs of absFiles) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (EXCLUDED_FILES.has(rel)) continue;
    files.push(rel);
    const source = readFileSync(abs, 'utf8');
    const { code, ok } = lexSource(source);
    if (!ok) {
      unparsable.push(rel);
      continue;
    }

    const fileSites = sitesIn(code);
    for (const site of fileSites) sites.push({ file: rel, ...site });
    violations.push(...violationsIn(rel, code));
    for (const hit of companionHitsIn(code)) {
      if (!fileSites.some((s) => Math.abs(s.line - hit.line) <= SITE_CLUSTER_RADIUS_LINES)) {
        loneCompanions.push({ file: rel, line: hit.line, idiom: hit.idiom });
      }
    }
    for (const receiver of safeDeclarationsIn(code)) safeDeclarations.push(`${rel} :: ${receiver}`);

    if (rel.startsWith(`${RELOAD_CONSUMER_DIR}/`) && hasReloadCall(source)) {
      reloadConsumers.push(rel);
      const hits = unguardedReloadsIn(source);
      if (hits.length === 0) continue;
      if (RELOAD_GUARD_EXEMPT.has(rel)) exemptionsUsed.add(rel);
      else unguardedReloads.push(...hits.map((h) => ({ file: rel, ...h })));
    }
  }

  return {
    files,
    unparsable,
    sites,
    violations,
    loneCompanions,
    safeDeclarations: safeDeclarations.sort(),
    reloadConsumers,
    unguardedReloads,
    staleExemptions: [...RELOAD_GUARD_EXEMPT.keys()].filter((f) => !exemptionsUsed.has(f)),
  };
}

function main() {
  const scan = scanRepo();
  const problems = [];

  if (scan.unparsable.length > 0) {
    problems.push(
      'These files could not be parsed, so this guard scanned less of them than it reports:',
      ...scan.unparsable.map((f) => `  - ${f}`),
    );
  }

  if (scan.sites.length < MIN_SITE_COUNT) {
    problems.push(
      `Expected >= ${MIN_SITE_COUNT} overlay creation sites under src/ (21 when this gate landed), found ${scan.sites.length}: the scan or the creation idioms have drifted.`,
    );
  }

  if (scan.loneCompanions.length > 0) {
    problems.push(
      'These set aria-modal="true" with no role="dialog" / .modal-overlay within 3 lines. The reload guard sees them, but this gate cannot attribute them to an element, so it cannot check their declaration. Set role="dialog" on the same element, or teach SITE_PATTERNS_BY_CLAUSE the idiom:',
      ...scan.loneCompanions.map((c) => `  - ${c.file}:${c.line}  ${c.idiom}`),
    );
  }

  if (scan.violations.length > 0) {
    problems.push('Overlays without a reload contract:', ...scan.violations.map((v) => adviceFor(v)));
  }

  if (scan.unguardedReloads.length > 0) {
    problems.push(
      `These automatic reloads under ${RELOAD_CONSUMER_DIR}/ live in an installer that never calls ${RELOAD_GUARD}(). Every reload consumer stays in lockstep on the one shared predicate (#8577): a reload over an open sign-up form destroys it.`,
      ...scan.unguardedReloads.map((r) => `  - ${r.file}:${r.line}  ${r.text}`),
    );
  }

  if (scan.staleExemptions.length > 0) {
    problems.push(
      'These RELOAD_GUARD_EXEMPT entries no longer match an unguarded reload. Delete them from scripts/enforce-overlay-reload-policy.mjs so the exemption cannot outlive its reason:',
      ...scan.staleExemptions.map((f) => `  - ${f}`),
    );
  }

  if (problems.length > 0) {
    console.error('Overlay reload-contract guard failed.');
    for (const line of problems) console.error(line);
    process.exitCode = 1;
    return;
  }

  const fileCount = new Set(scan.sites.map((s) => s.file)).size;
  console.log(
    `Overlay reload-contract guard passed (${scan.sites.length} sites in ${fileCount} files, all declared; ${scan.safeDeclarations.length} declared safe; ${scan.reloadConsumers.length} reload consumers, ${RELOAD_GUARD_EXEMPT.size} exempt).`,
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
