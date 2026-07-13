// Shared static import-graph machinery for the Dockerfile/container guard
// tests (#5231 review follow-up). Single home for the comment-stripping
// tokenizer, edge extraction, resolution, Dockerfile COPY parsing, and BFS
// walks that were previously hand-copied across three guards:
//   - tests/resilience-validation-import-graph.test.mjs (walkContainerGraph)
//   - tests/dockerfile-relay-imports.test.mjs (collectRelativeImports/resolveNodeRelative)
//   - tests/dockerfile-digest-notifications-imports.test.mjs (same scanner, copied)
// A fix to an extraction edge case lands here once and covers all three.
//
// This module is test infrastructure only — it lives under tests/ and is
// never COPY'd into any container image.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

// Keywords after which a `/` in code position starts a REGEX LITERAL, not
// division (`return /x/.test(s)`, `typeof /x/`, `case /x/:` ...).
const REGEX_PRECEDING_KEYWORDS = /(?:^|[^$\w.])(?:return|typeof|case|delete|void|in|of|new|instanceof|yield|await|do|else)\s*$/;

// Structure-preserving comment strip. A state machine, not regexes: naive
// regex stripping misreads `/*` inside comment text or strings (a comment
// mentioning `@upstash/*` swallowed everything to the next `*/`, silently
// deleting real imports from extraction) and misreads `//` inside string
// literals. Comments are removed exactly; string/template/regex-literal
// contents and line structure are preserved.
//
// Regex literals get their own state: `/[/*]/` or `/a\/\*b/` would otherwise
// flip the tokenizer into block-comment state and swallow everything to the
// next `*/` or EOF — and a swallowed BARE import produces no visited node and
// no violation, so the deep-node canaries could NOT backstop that case (they
// only see dropped relative edges). Regex-vs-division at a `/` is decided by
// expression position: the last significant char (or a preceding keyword like
// `return`) says whether a regex can start there. Known residual limit: an
// exotic ASI shape could still misclassify division as a regex start — the
// self-test fixtures pin the realistic cases (char-class slashes, division,
// URLs in strings).
export function stripComments(src) {
  let out = '';
  let state = 'code'; // code | line | block | squote | dquote | template | regex
  let inClass = false; // inside [...] while state === 'regex'
  let lastSig = ''; // last non-whitespace char emitted in code state
  let i = 0;

  const regexCanStart = () =>
    lastSig === '' ||
    '([{,;=:?!&|^~%*+-<>'.includes(lastSig) ||
    (lastSig === '/' ? false : /[$\w]/.test(lastSig) && REGEX_PRECEDING_KEYWORDS.test(out));

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === '/' && regexCanStart()) { state = 'regex'; inClass = false; out += c; i += 1; continue; }
      if (c === "'") state = 'squote';
      else if (c === '"') state = 'dquote';
      else if (c === '`') state = 'template';
      if (!/\s/.test(c)) lastSig = c;
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i += 1; continue;
    }
    if (state === 'regex') {
      if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { state = 'code'; lastSig = '/'; out += c; i += 1; continue; }
      else if (c === '\n') { state = 'code'; } // regex literals cannot span lines; bail defensively
      out += c; i += 1; continue;
    }
    // Inside a string or template literal: pass through, honor escapes.
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if ((state === 'squote' && c === "'") || (state === 'dquote' && c === '"') || (state === 'template' && c === '`')) {
      state = 'code';
      lastSig = c; // a closing quote is a value terminator: `/` after it is division
    }
    out += c; i += 1;
  }
  return out;
}

// True when a named-import/export clause consists ONLY of `type` bindings
// (`{ type Foo, type Bar }`). tsx/esbuild erase those at runtime, so the
// specifier is not a runtime edge. A mixed clause (`{ type Foo, real }`) or
// any default/namespace binding keeps the edge.
function isAllTypeNamedClause(clause) {
  const inner = clause.trim();
  if (!inner.startsWith('{') || !inner.endsWith('}')) return false;
  const bindings = inner.slice(1, -1).split(',').map((b) => b.trim()).filter(Boolean);
  return bindings.length > 0 && bindings.every((b) => /^type\s/.test(b));
}

// Extract import edges from one source file (comments already stripped).
export function extractEdges(src) {
  const staticSpecs = [];
  const dynamicSpecs = [];
  const requireSpecs = [];

  // import ... from '...' (multi-line safe; skips `import type` and clauses
  // whose named bindings are all inline `type` modifiers — tsx erases both)
  for (const m of src.matchAll(/(?:^|;)[ \t]*import\s+(?!type\s)([^'";]*?)\bfrom\s*['"]([^'"]+)['"]/gms)) {
    if (isAllTypeNamedClause(m[1])) continue;
    staticSpecs.push(m[2]);
  }
  // side-effect: import '...'
  for (const m of src.matchAll(/(?:^|;)[ \t]*import\s*['"]([^'"]+)['"]/gm)) {
    staticSpecs.push(m[1]);
  }
  // export { ... } from '...' / export * from '...' (skips `export type` and
  // all-inline-type clauses)
  for (const m of src.matchAll(/(?:^|;)[ \t]*export\s+(?!type\b)(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gms)) {
    if (m[1].startsWith('{') && isAllTypeNamedClause(m[1])) continue;
    staticSpecs.push(m[2]);
  }
  // dynamic import('...') literals
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)) {
    dynamicSpecs.push(m[1]);
  }
  // require('...') literals (plain require in .cjs, or a createRequire-bound
  // local named require)
  for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    requireSpecs.push(m[1]);
  }
  // createRequire(...)('...') — immediately-invoked form; the plain require
  // regex cannot see it (no lowercase `require(` substring). The argument may
  // itself contain one level of call parens — the common
  // createRequire(fileURLToPath(import.meta.url))('./x') idiom.
  for (const m of src.matchAll(/\bcreateRequire\((?:[^()]|\([^()]*\))*\)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    requireSpecs.push(m[1]);
  }
  return { staticSpecs, dynamicSpecs, requireSpecs };
}

export function isBare(spec) {
  return !spec.startsWith('.') && !spec.startsWith('/');
}

// --- Dockerfile COPY parsing -------------------------------------------------

// Parse every `COPY [--flags] <src> [<src> ...] <dest>` line into file-level
// and directory-level (recursive) coverage. A trailing slash on a source
// means recursive directory coverage; the trailing slash is stripped from
// the returned directory names. `--from=`/`--chown=` style flags are skipped.
// Line continuations are NOT supported — none of the guarded Dockerfiles use
// them, and an unparsed line surfaces via the callers' loud sanity asserts.
// Single home for the three container guards' COPY knowledge (#5236 review).
export function parseDockerfileCopy(src) {
  const files = new Set();
  const directories = new Set();
  for (const m of src.matchAll(/^COPY\s+([^\n]+)$/gm)) {
    const tokens = m[1].trim().split(/\s+/).filter((t) => !t.startsWith('--'));
    if (tokens.length < 2) continue; // need at least <src> <dest>
    for (const arg of tokens.slice(0, -1)) {
      if (arg.endsWith('/')) directories.add(arg.replace(/\/+$/, ''));
      else files.add(arg);
    }
  }
  return { files, directories };
}

// --- Resolution ---------------------------------------------------------------

// Source extensions plain node can load when written explicitly. The runtime-
// loadable set additionally includes .json (via import attributes / require).
export const NODE_SOURCE_EXTS = ['.mjs', '.cjs', '.js'];
const PLAIN_NODE_LOADABLE_EXTS = new Set([...NODE_SOURCE_EXTS, '.json']);
// tsx's extension-guessing order for extensionless specifiers, plus the
// directory-index candidates it probes.
const TSX_EXT_CANDIDATES = ['.ts', '.mts', '.js', '.mjs', '.cjs'];
const TSX_INDEX_CANDIDATES = ['index.ts', 'index.js', 'index.mjs'];

// Node-style resolution against an explicit extension candidate list (COPY-
// closure guard style: literal hit or listed extension appended). Skips
// directory hits — a bare directory match is never what plain node loads.
export function resolveNodeRelative(fromFile, relImport, exts = NODE_SOURCE_EXTS) {
  const abs = resolve(dirname(fromFile), relImport);
  if (existsSync(abs) && !statSync(abs).isDirectory()) return abs;
  for (const ext of exts) {
    if (existsSync(abs + ext)) return abs + ext;
  }
  return null;
}

// tsx-style resolution: extension guessing (including TypeScript), directory
// index probing, and the TS idiom where an explicit .js/.mjs specifier maps
// to a .ts/.mts source.
export function resolveTsxRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, ...TSX_EXT_CANDIDATES.map((ext) => base + ext), ...TSX_INDEX_CANDIDATES.map((ix) => join(base, ix))];
  if (spec.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'));
  if (spec.endsWith('.mjs')) candidates.push(base.replace(/\.mjs$/, '.mts'));
  return candidates.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

// Relative specifiers a file mentions via static import / export-from /
// require / createRequire (dynamic import() literals are deliberately NOT
// included — the COPY-closure guards never followed those). Used by the
// relay and digest-notifications Dockerfile guards.
export function collectRelativeImports(filePath) {
  const src = stripComments(readFileSync(filePath, 'utf-8'));
  const { staticSpecs, requireSpecs } = extractEdges(src);
  const imports = new Set();
  for (const spec of [...staticSpecs, ...requireSpecs]) {
    if (spec.startsWith('.')) imports.add(spec);
  }
  return imports;
}

// Scripts-only packaging guards must cover every literal runtime edge. Unlike
// Dockerfile COPY-closure callers, they cannot safely ignore dynamic imports:
// a conditional import that escapes scripts/ still crashes when that branch
// executes in Railway's /app scripts root.
export function collectRelativeRuntimeImports(filePath) {
  const src = stripComments(readFileSync(filePath, 'utf-8'));
  const { staticSpecs, dynamicSpecs, requireSpecs } = extractEdges(src);
  const imports = new Set();
  for (const spec of [...staticSpecs, ...dynamicSpecs, ...requireSpecs]) {
    if (spec.startsWith('.')) imports.add(spec);
  }
  return imports;
}

// --- Container-contract walk ---------------------------------------------------

// Walk the container-reachable graph from `rootFiles` under `contract`:
//   contract.repoRoot        — absolute path imports may not escape reporting-wise
//   contract.copyRootDirs    — absolute dirs the image COPYs (containment set)
//   contract.dynamicRootDirs — absolute dirs dynamic import() literals are
//                              followed into (executed-unconditionally set)
//   contract.installedPackages — bare-specifier budget beyond node builtins
//   contract.hasTsx          — false = the container runs plain node: no
//                              extension guessing, no index resolution, no
//                              TypeScript. Omitted/true = tsx-shaped resolution.
// Returns violations/unresolved (each with the import chain from a root) and
// the visited set for reachability assertions.
export function walkContainerGraph(rootFiles, contract) {
  const parent = new Map();
  const visited = new Set();
  const queue = [...rootFiles];
  const violations = [];
  const unresolved = [];
  const hasTsx = contract.hasTsx !== false;

  const chainOf = (file) => {
    const chain = [];
    for (let f = file; f; f = parent.get(f)) chain.unshift(relative(contract.repoRoot, f));
    return chain.join('\n    -> ');
  };

  const inside = (dirs, p) => dirs.some((d) => p.startsWith(d + sep));

  const followRelative = (file, spec) => {
    const resolved = resolveTsxRelative(file, spec);
    if (!resolved) {
      unresolved.push(`'${spec}' imported from\n    ${chainOf(file)}`);
      return;
    }
    if (!hasTsx) {
      // Plain node resolves ONLY the literal specifier, and only for
      // extensions it can load. An edge that needed extension guessing or
      // TypeScript would work under tsx elsewhere in the repo yet crash
      // this container at import time.
      const literal = resolve(dirname(file), spec);
      if (resolved !== literal || !PLAIN_NODE_LOADABLE_EXTS.has(extname(resolved))) {
        violations.push(
          `'${spec}' resolves only under a tsx loader (extension guessing / TypeScript -> ${relative(contract.repoRoot, resolved)}), but this container runs plain node via\n    ${chainOf(file)}`,
        );
        return;
      }
    }
    if (!inside(contract.copyRootDirs, resolved)) {
      violations.push(
        `'${spec}' resolves in the repo but OUTSIDE the container COPY set (${relative(contract.repoRoot, resolved)}) via\n    ${chainOf(file)}`,
      );
      return;
    }
    if (!visited.has(resolved) && !parent.has(resolved)) parent.set(resolved, file);
    queue.push(resolved);
  };

  const checkBare = (file, spec, how) => {
    const pkg = spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
    if (!isBuiltin(spec) && !contract.installedPackages.has(pkg)) {
      violations.push(`'${spec}' ${how} via\n    ${chainOf(file)}`);
    }
  };

  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    if (extname(file) === '.json') continue; // data, no imports

    const src = stripComments(readFileSync(file, 'utf-8'));
    const { staticSpecs, dynamicSpecs, requireSpecs } = extractEdges(src);

    for (const spec of staticSpecs) {
      if (isBare(spec)) checkBare(file, spec, 'statically imported');
      else followRelative(file, spec);
    }
    for (const spec of requireSpecs) {
      // A top-level require in a walked file loads eagerly at startup (e.g.
      // _seed-utils.mjs createRequire()s _proxy-utils.cjs at module scope),
      // so bare requires get the same budget check as static imports. The
      // walked graph is require-clean today; if a genuinely-lazy bare
      // require ever appears, exempt that one site explicitly.
      if (isBare(spec)) checkBare(file, spec, 'require()d');
      else followRelative(file, spec);
    }
    for (const spec of dynamicSpecs) {
      if (isBare(spec)) continue; // lazy; cannot classify statically
      const resolved = resolveTsxRelative(file, spec);
      if (resolved && inside(contract.dynamicRootDirs, resolved)) {
        if (!visited.has(resolved) && !parent.has(resolved)) parent.set(resolved, file);
        queue.push(resolved);
      }
    }
  }

  return { violations, unresolved, visited };
}
