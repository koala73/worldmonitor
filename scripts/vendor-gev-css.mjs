/**
 * Generates src/styles/gev.css from God's Eye View's upstream style.css,
 * namespacing every rule under `.gev-root`.
 *
 * Why this is necessary: upstream is a standalone full-viewport app, so its
 * stylesheet legitimately owns global ground that World Monitor also owns.
 * Loading it as-is cross-contaminates in five concrete ways —
 *
 *   1. `.panel-header`, `.panel-title`, `.panel-collapse-btn` are declared as
 *      bare classes in BOTH stylesheets (World Monitor's are in main.css).
 *   2. `:root` declares 24 custom properties, 5 of which (`--accent`,
 *      `--font-mono`, `--panel-radius`, `--text-dim`, `--text-secondary`)
 *      collide with World Monitor's.
 *   3. `* { margin: 0; padding: 0; box-sizing: border-box }` — a reset that
 *      would land on the whole dashboard.
 *   4. `html, body { overflow: hidden; background: var(--bg-dark); ... }`.
 *   5. `body.cockpit-mode` / `.recording-mode` / `.ui-clean-view` /
 *      `.scene-playback-mode` mode rules.
 *
 * Run: node scripts/vendor-gev-css.mjs [path/to/upstream/style.css]
 *
 * Do NOT hand-edit the generated file — re-run this instead. Being able to
 * regenerate is the whole point: it keeps re-vendoring a newer God's Eye View
 * a one-command operation rather than a manual reconciliation of 1396 rules.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** The container class every GEV rule is scoped to. */
const NS = '.gev-root';

/**
 * Mode classes upstream toggles on `document.body`. They stay on <body>
 * (23 call sites across ui.js, scenes/director.js, cockpitCloudEffects.js and
 * data/flights.js read or write them, and the names are GEV-specific enough
 * to be harmless there), so `body.cockpit-mode X` becomes
 * `body.cockpit-mode .gev-root X` rather than being rewritten onto the
 * container. Keeping them on body means zero JS changes for the mode system.
 */
const BODY_MODE_CLASSES = [
  'cockpit-mode',
  'recording-mode',
  'ui-clean-view',
  'scene-playback-mode',
];

/**
 * Rewrite one comma-separated selector list.
 *
 * The interesting cases, in the order they are tested:
 *   `:root`       → the namespace itself (custom props resolve for descendants)
 *   `html, body`  → the namespace itself (it is the viewport for GEV now)
 *   `*`           → `.gev-root *`
 *   `body.<mode>` → `body.<mode> .gev-root` + the remainder
 *   anything else → `.gev-root ` + selector
 *
 * Every rule gains exactly one class of specificity, so GEV's internal
 * cascade order is preserved — only its precedence relative to World
 * Monitor's rules changes, which is the point.
 */
function scopeSelectorList(selectorList) {
  return splitTopLevelCommas(selectorList)
    .map((raw) => {
      const sel = raw.trim();
      if (!sel) return null;

      // Already scoped (idempotent re-runs, and any hand-written additions).
      if (sel === NS || sel.startsWith(`${NS} `) || sel.startsWith(`${NS}.`) ||
          sel.startsWith(`${NS}:`)) {
        return sel;
      }

      if (sel === ':root' || sel === 'html' || sel === 'body') return NS;

      if (sel === '*') return `${NS} *`;

      // `body.cockpit-mode …`, including `body.cockpit-mode:has(...) …`
      // and the bare `body.cockpit-mode` form.
      for (const mode of BODY_MODE_CLASSES) {
        if (sel === `body.${mode}` || sel.startsWith(`body.${mode}:`) ||
            sel.startsWith(`body.${mode} `)) {
          // Split off the leading compound selector (up to the first
          // descendant combinator that is not inside parentheses).
          const head = takeLeadingCompound(sel);
          const tail = sel.slice(head.length).trim();
          return tail ? `${head} ${NS} ${tail}` : `${head} ${NS}`;
        }
      }

      // Leading combinators (`> .foo`) appear in upstream's multi-line
      // selector lists; scoping them would produce `.gev-root > .foo`, which
      // silently changes meaning. Leave them for the caller to notice.
      if (/^[>+~]/.test(sel)) return sel;

      return `${NS} ${sel}`;
    })
    .filter(Boolean)
    // `html, body` both map to the namespace, which would otherwise emit
    // `.gev-root, .gev-root`. Valid, but noise in a generated file.
    .filter((sel, idx, all) => all.indexOf(sel) === idx)
    .join(',\n');
}

/**
 * Split a selector list on commas that are NOT inside parentheses.
 *
 * A plain `.split(',')` corrupts `:is(a, b)` / `:has(a, b)` / `:not(a, b)`,
 * which upstream uses across multiple lines — it tears the functional
 * pseudo-class in half and emits selectors with unbalanced parens that
 * silently kill the rule (`.gev-root #control-panel):hover .panel-title`).
 */
function splitTopLevelCommas(selectorList) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let inStr = null;
  for (let i = 0; i < selectorList.length; i++) {
    const c = selectorList[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(selectorList.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selectorList.slice(start));
  return parts;
}

/** The leading compound selector, respecting parentheses (`:has(a b)`). */
function takeLeadingCompound(sel) {
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /\s/.test(c)) return sel.slice(0, i);
  }
  return sel;
}

/**
 * Walk the stylesheet, rewriting selectors and leaving at-rules alone except
 * to recurse into the ones that contain rules.
 *
 * `@keyframes` is deliberately NOT recursed into — its "selectors" are
 * percentages and `from`/`to` keywords, and prefixing those produces a
 * stylesheet that parses but animates nothing.
 */
function transform(css) {
  let out = '';
  let i = 0;

  while (i < css.length) {
    // Comments pass through untouched.
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }

    if (/\s/.test(css[i])) {
      out += css[i];
      i++;
      continue;
    }

    // Find the next block opener at this level.
    const braceAt = findTopLevel(css, i, '{');
    if (braceAt === -1) {
      out += css.slice(i);
      break;
    }

    const prelude = css.slice(i, braceAt);
    const { body, end } = readBlock(css, braceAt);
    const trimmed = prelude.trim();

    if (trimmed.startsWith('@')) {
      const atName = trimmed.slice(1).split(/[\s(]/)[0].toLowerCase();
      if (atName === 'keyframes' || atName.endsWith('keyframes')) {
        out += `${prelude}{${body}}`;          // verbatim
      } else if (atName === 'media' || atName === 'supports' ||
                 atName === 'layer' || atName === 'container') {
        out += `${prelude}{${transform(body)}}`;  // recurse
      } else {
        out += `${prelude}{${body}}`;          // @font-face, @page, …
      }
    } else {
      out += `${scopeSelectorList(prelude)} {${body}}`;
    }

    i = end;
  }

  return out;
}

/** Index of `ch` at nesting depth 0, skipping comments and strings. */
function findTopLevel(css, from, ch) {
  let inStr = null;
  for (let i = from; i < css.length; i++) {
    const c = css[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    if (c === ch) return i;
    if (c === '}') return -1;   // block ended before we found an opener
  }
  return -1;
}

/** Read the balanced block starting at the `{` at `open`. */
function readBlock(css, open) {
  let depth = 0;
  let inStr = null;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (css.startsWith('/*', i)) {
      const e = css.indexOf('*/', i + 2);
      i = e === -1 ? css.length : e + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: css.slice(open + 1, i), end: i + 1 };
    }
  }
  return { body: css.slice(open + 1), end: css.length };
}

// ── main ────────────────────────────────────────────────────────────────────
// Default source is the vendored upstream copy, so regenerating needs no
// checkout of the original repo — src/gev/ keeps upstream's own layout
// (root files beside src/) precisely so its self-consistency tests, which
// reference `../style.css`, `../index.html` and `../vite.config.js`, keep
// resolving. See src/gev/UPSTREAM.md.
const srcPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(ROOT, 'src/gev/style.css');
const outPath = resolve(ROOT, 'src/styles/gev.css');

const input = readFileSync(srcPath, 'utf-8');
// Asset URLs are NOT rewritten: God's Eye View's public/ files are served
// from World Monitor's web root under their upstream names (verified
// collision-free — see src/gev/UPSTREAM.md), so `url('/location.svg')` and
// friends resolve unchanged.
const output = transform(input);

const banner = `/*
 * GENERATED FILE — do not edit.
 *
 * Produced by scripts/vendor-gev-css.mjs from God's Eye View's style.css.
 * Every rule is namespaced under \`.gev-root\`; see src/gev/UPSTREAM.md.
 * Re-run: node scripts/vendor-gev-css.mjs [path/to/style.css]
 */
`;

writeFileSync(outPath, banner + output);

// A cheap smoke check — if these drop to zero the transform silently broke.
const scoped = (output.match(/\.gev-root/g) || []).length;
const keyframes = (output.match(/@keyframes/g) || []).length;
console.log(`vendor-gev-css: ${srcPath}`);
console.log(`  → ${outPath}`);
console.log(`  ${scoped} scoped selectors, ${keyframes} @keyframes left verbatim`);
if (scoped === 0) {
  console.error('  !! no selectors were scoped — refusing to call this a success');
  process.exit(1);
}
