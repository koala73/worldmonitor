// Shared static parser for `scripts/seed-bundle-*.mjs` section configuration.
//
// Bundle scripts call `await runBundle(...)` at module top level and end in
// `process.exit()`, so a test cannot import one to read its configuration —
// importing would spawn the real seeders. Both repo-wide bundle gates
// therefore read the source:
//
//   - tests/seeder-canonical-ttl-vs-cron.test.mjs — canonical TTL vs cron interval
//   - tests/bundle-budget-admission.test.mjs      — timeout + kill grace vs wall budget
//
// One parser means a fix to the brace balancer or the resolver lands for both
// gates at once, and neither drifts into silently dropping a section — a
// dropped section is a false PASS, which is the failure mode that matters for
// a guard like this.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Conventional bundle-level duration constants, re-exported by
 * `_bundle-runner.mjs`. Pre-seeded so `12 * HOUR` resolves without parsing
 * the runner's own declarations.
 */
export const PRESEEDED = {
  MIN: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Remove `//` line comments and block comments, leaving string literals
 * intact (so `'https://example.com'` and `regexFilter: 'a//b'` survive).
 *
 * Load-bearing for correctness, not just tidiness: a commented-out section or
 * a comment quoting `maxBundleMs: 570_000` would otherwise be parsed as live
 * configuration, and a gate that reads a commented-out declaration reports on
 * code that does not run.
 */
// Keywords after which a `/` starts a regex literal rather than division.
// `return /re/.test(x)` is the realistic shape in this repo's scripts; without
// the keyword check the previous-significant-character heuristic would read
// the `n` of `return` as an operand end and swallow the regex as a comment.
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

export function stripLineComments(src) {
  let out = '';
  let inStr = false;
  let strCh = '';
  // Regex-vs-division state (#6562 item 5): a bare `/` starts a regex literal
  // unless the previous significant token ENDS an operand (identifier, number,
  // closing bracket, quote, or dot). Inside a regex literal `//` is not a
  // comment — `const RE = /[//]/` used to truncate the file at that point.
  let prevSignificant = '';
  let lastWord = '';
  const regexAllowed = () =>
    (lastWord && KEYWORDS_BEFORE_REGEX.has(lastWord)) ||
    !/[)\]\w$"'.]/.test(prevSignificant);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; continue; }
      if (c === strCh) { inStr = false; prevSignificant = strCh; lastWord = ''; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; out += c; prevSignificant = c; lastWord = ''; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;                       // land on '/', loop's i++ steps past it
      continue;
    }
    if (c === '/' && regexAllowed()) {
      // Regex literal: emit it verbatim (it may contain `//` or `/*`),
      // honoring character classes and escapes. A newline before the closing
      // `/` means this was not a regex after all — emit the slash alone and
      // let the rest of the line be re-examined as ordinary source.
      const start = i;
      i++;
      let inClass = false;
      let closed = false;
      while (i < src.length) {
        const rc = src[i];
        if (rc === '\\') i++;
        else if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) { closed = true; break; }
        else if (rc === '\n') break;
        i++;
      }
      if (!closed) {
        out += c;                // lone slash — division or malformed line
        prevSignificant = c; lastWord = '';
        continue;
      }
      out += src.slice(start, i + 1);
      prevSignificant = '/'; lastWord = '';
      continue;
    }
    out += c;
    if (/\s/.test(c)) continue; // whitespace keeps the previous token significant
    if (/[\w$]/.test(c)) { lastWord += c; prevSignificant = c; }
    else { lastWord = ''; prevSignificant = c; }
  }
  return out;
}

/** Strip JS numeric-separator underscores so safe-eval can parse them. */
export function stripNumericUnderscores(s) {
  // 7_200 → 7200, 86_400 → 86400. Only between digits, never adjacent.
  return s.replace(/(\d)_(?=\d)/g, '$1');
}

/**
 * Safely evaluate a simple numeric expression. Allows digits, +-/*(), and
 * underscored identifiers (which must be in `scope`). Rejects anything
 * else with null. No `eval` — uses Function constructor with a strict
 * input-character whitelist + name-substitution.
 */
export function safeEval(expr, scope = {}) {
  const trimmed = stripNumericUnderscores(String(expr).trim());
  if (!/^[\w\s+\-*/().,_]+$/.test(trimmed)) return null;
  let substituted = trimmed;
  for (const [name, value] of Object.entries(scope)) {
    if (typeof value !== 'number') continue;
    substituted = substituted.replace(new RegExp(`\\b${name}\\b`, 'g'), `(${value})`);
  }
  if (!/^[\d\s+\-*/().]+$/.test(substituted)) return null;
  try {
    const result = Function(`"use strict"; return (${substituted})`)();
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Resolve `name` through the named imports declared in `src`, reading the
 * imported module's source. Only relative specifiers are followed — a bare
 * package specifier is not repo configuration.
 *
 * `seed-bundle-macro.mjs` declares its Education section timeout as an
 * imported constant, so without this a gate over that bundle would either
 * skip the section (false pass) or hard-fail on a legitimate config.
 */
function resolveImportedIdentifier(src, name, opts) {
  if (!opts.file) return null;
  const follow = (specifier, importedName) => {
    if (!specifier.startsWith('.')) return null;
    const targetPath = resolve(dirname(opts.file), specifier);
    let targetSrc;
    try { targetSrc = readFileSync(targetPath, 'utf-8'); } catch { return null; }
    return resolveIdentifier(stripLineComments(targetSrc), importedName, {}, {
      ...opts,
      file: targetPath,
    });
  };
  // Default (optionally plus named) imports: `import X from`, `import def, { X } from`
  // (#6562 item 5 — a default clause used to make the whole statement
  // invisible to the named-import regex below).
  for (const m of src.matchAll(/import\s+([\w$]+)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
    const defaultLocal = m[1];
    const namedClause = m[2];
    const specifier = m[3];
    if (defaultLocal === name) {
      // Default imports are not repo configuration in practice; resolving one
      // would need export-default tracking. Fail closed instead of guessing.
      return null;
    }
    if (namedClause == null) continue;
    for (const clause of namedClause.split(',')) {
      const parts = clause.trim().split(/\s+as\s+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      const imported = parts[0];
      const local = parts[1] ?? imported;
      if (local !== name) continue;
      return follow(specifier, imported);
    }
  }
  // Bare named imports without a default clause: `import { X } from`.
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const specifier = m[2];
    for (const clause of m[1].split(',')) {
      const parts = clause.trim().split(/\s+as\s+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      const imported = parts[0];
      const local = parts[1] ?? imported;
      if (local !== name) continue;
      return follow(specifier, imported);
    }
  }
  // Re-exports: `export { X } from '...'` / `export { X as Y } from '...'`.
  // The alias is what THIS file exposes, so match on it, then resolve the
  // original name inside the target module (#6562 item 5).
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const specifier = m[2];
    for (const clause of m[1].split(',')) {
      const parts = clause.trim().split(/\s+as\s+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      const original = parts[0];
      const exposed = parts[1] ?? original;
      if (exposed !== name) continue;
      return follow(specifier, original);
    }
  }
  return null;
}

/**
 * Find a `const|let|var|export const <name> = <expr>` declaration in `src`
 * and resolve to a number, following relative named imports when `opts.file`
 * (the absolute path `src` was read from) is supplied. Cycle-guarded per
 * file: the guard must key on the FILE, not its directory, or a bundle
 * importing a constant from a sibling module in `scripts/` looks like a
 * self-reference and resolves to null.
 */
export function resolveIdentifier(src, name, scope = {}, opts = {}) {
  const seen = opts._seen ?? new Set();
  const seenKey = `${opts.file ?? ''}::${name}`;
  if (seen.has(seenKey)) return null;
  if (name in scope) return scope[name];
  if (name in PRESEEDED) return PRESEEDED[name];
  seen.add(seenKey);
  const nextOpts = { ...opts, _seen: seen };
  // Match: optional `export `, then `const|let|var <name> = <rhs>` up to ; // or newline
  const re = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+?)(?:\\s*(?://|;)|$)`, 'm');
  const m = src.match(re);
  if (!m) return resolveImportedIdentifier(src, name, nextOpts);
  return resolveExpr(src, m[1].trim(), scope, nextOpts);
}

export function resolveExpr(src, expr, scope = {}, opts = {}) {
  const direct = safeEval(expr, { ...PRESEEDED, ...scope });
  if (direct != null) return direct;
  if (/^\w+$/.test(expr)) return resolveIdentifier(src, expr, scope, opts);
  const idents = [...new Set([...expr.matchAll(/\b([A-Za-z_]\w*)\b/g)].map(m => m[1]))];
  const expanded = { ...scope, ...PRESEEDED };
  for (const id of idents) {
    if (id in expanded) continue;
    const v = resolveIdentifier(src, id, scope, opts);
    if (v != null) expanded[id] = v;
  }
  return safeEval(expr, expanded);
}

const SECTION_ANCHOR_RE = /\{\s*label:\s*(['"])((?:(?!\1).)+)\1/g;

// Deliberately a DIFFERENT token from the anchor regex. A section-count check
// that re-uses SECTION_ANCHOR_RE only proves the extractor agrees with itself:
// a section written as `{ script: 'x.mjs', label: 'y' }` (label not first) or
// with a double-quoted label is missed by BOTH the extractor and an
// anchor-derived count, the two numbers match, and the gate passes on a bundle
// it never actually read. Every real section declares `script:`, so counting
// that independently is what makes the comparison load-bearing.
const SECTION_SCRIPT_KEY_RE = /(?:^|[{,\s])script:\s*['"]/g;

/**
 * Count `{ label: ... }` anchors in already-comment-stripped source.
 * `extractBundleSections` drops an anchor it cannot fully parse; comparing
 * the two counts is how a caller proves nothing was dropped silently.
 */
export function countSectionAnchors(bundleSrc) {
  return [...bundleSrc.matchAll(SECTION_ANCHOR_RE)].length;
}

/**
 * Count `script:` keys in already-comment-stripped source — an independent
 * lower bound on how many sections the file declares. Callers assert this
 * against `extractBundleSections(...).length` so a section the anchor regex
 * cannot see still fails the gate instead of vanishing from it.
 */
export function countSectionScriptKeys(bundleSrc) {
  return [...bundleSrc.matchAll(SECTION_SCRIPT_KEY_RE)].length;
}

/**
 * Extract bundle sections via brace-balanced scan from each `{ label: '...'`
 * anchor. The non-greedy `\{...?\}` regex would match at the first inner
 * `}` for sections containing nested objects (e.g. `extraHeaders: {...}`),
 * silently dropping them — which would let a real new violation slip past
 * the guard. Greptile P2 on PR #3625.
 *
 * `bundleSrc` is comment-stripped first, so a commented-out section is not
 * reported as live configuration.
 */
export function extractBundleSections(rawBundleSrc) {
  const bundleSrc = stripLineComments(rawBundleSrc);
  const sections = [];
  for (const m of bundleSrc.matchAll(SECTION_ANCHOR_RE)) {
    const label = m[2];
    const startIdx = m.index;
    // Walk forward balancing braces, respecting string literals.
    let depth = 0, endIdx = -1, inStr = false, strCh = '';
    for (let i = startIdx; i < bundleSrc.length; i++) {
      const c = bundleSrc[i];
      if (inStr) {
        if (c === '\\') i++;     // skip escape
        else if (c === strCh) inStr = false;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx < 0) continue;     // unbalanced — skip
    const block = bundleSrc.slice(startIdx, endIdx + 1);
    const scriptM = block.match(/script:\s*['"]([^'"]+)['"]/);
    const intervalM = block.match(/intervalMs:\s*([^,}\n]+)/);
    if (!scriptM || !intervalM) continue;
    // Shapes this text scanner cannot read correctly. Each would yield a WRONG
    // timeout rather than no timeout, and a wrong (usually smaller) number is
    // one a budget gate happily passes — the silent-pass this parser exists to
    // avoid. No bundle uses any of them today; if one ever does, drop the
    // section so the caller's script-key count check fails loudly instead of
    // the gate quietly checking a number nobody wrote.
    //
    //   nested:    `retry: { timeoutMs: 500 }, timeoutMs: 300_000` -> reads 500
    //   shorthand: `{ ..., timeoutMs }`                            -> reads none, defaults
    //   spread:    `{ ...COMMON }`                                 -> reads none, defaults
    const timeoutMatches = [...block.matchAll(/timeoutMs:\s*([^,}\n]+)/g)];
    const hasShorthandTimeout = /[{,]\s*timeoutMs\s*[,}]/.test(block);
    const hasSpread = /\.\.\./.test(block);
    if (timeoutMatches.length > 1 || hasShorthandTimeout || hasSpread) continue;
    sections.push({
      label,
      script: scriptM[1],
      intervalMsExpr: intervalM[1].trim(),
      timeoutMsExpr: timeoutMatches.length === 1 ? timeoutMatches[0][1].trim() : null,
    });
  }
  return sections;
}

/**
 * Read a scalar option from the `runBundle(label, sections, opts)` call, e.g.
 * `maxBundleMs`. Returns the raw expression, or null when the bundle does not
 * declare it (an unbudgeted bundle).
 */
export function extractBundleOption(rawBundleSrc, name) {
  // Word boundary before the key (#6562 item 5): without it a bundle declaring
  // `fooMaxBundleMs:` would satisfy a `maxBundleMs` lookup. The gates also
  // assert exactly one textual match per bundle; the boundary keeps that
  // assertion meaningful rather than load-bearing.
  const m = stripLineComments(rawBundleSrc).match(new RegExp(`(?<![\\w$])${name}:\\s*([^,}\\n]+)`));
  return m ? m[1].trim() : null;
}

/** Absolute paths of every `scripts/seed-bundle-*.mjs`, sorted. */
export function listBundleFiles(scriptsDir) {
  return readdirSync(scriptsDir)
    .filter((f) => f.startsWith('seed-bundle-') && f.endsWith('.mjs'))
    .sort()
    .map((f) => join(scriptsDir, f));
}
