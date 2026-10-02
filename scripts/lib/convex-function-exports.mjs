/**
 * Enumerate Convex `query` / `mutation` / `action` / `httpAction` /
 * `internal*` exports under `convex/`.
 *
 * Shared by the string-call audit and the Sentry Convex-probe ingest-filter
 * generator. Parsing walks from each factory call site back to the nearest
 * preceding `export const NAME` so a constant such as
 * `export const TOUCH_DEBOUNCE_MS = 60_000` cannot be attributed to a later
 * `internalQuery(` (the failure mode of a naive `export const … = factory(`
 * regex that spans export boundaries).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const PUBLIC_FN_TYPES = Object.freeze(
  new Set(['query', 'mutation', 'action', 'httpAction']),
);

export const INTERNAL_FN_TYPES = Object.freeze(
  new Set(['internalQuery', 'internalMutation', 'internalAction']),
);

const FACTORY_RE =
  /\b(internalQuery|internalMutation|internalAction|query|mutation|action|httpAction)\s*\(/g;

const SKIP_DIR_NAMES = new Set(['node_modules', '_generated', '__tests__']);

/**
 * Recursively yield Convex source files that can become backend modules.
 *
 * Skips `_generated`, `__tests__`, dotfiles, and multi-dot basenames that
 * `convex deploy` never treats as entry points.
 *
 * @param {string} dir
 * @yields {string}
 */
export function* walkConvexSourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkConvexSourceFiles(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    // Convex skips multi-dot basenames (`x.test.ts`, `x.helpers.ts`) as entry
    // points; keep the same filter so we do not invent filter patterns for
    // files that never deploy.
    if ((entry.name.match(/\./g) || []).length !== 1) continue;
    if (!/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(entry.name)) continue;
    yield fullPath;
  }
}

/**
 * Resolve `convex/foo/bar.ts` → `foo/bar` (Convex module ref form).
 *
 * @param {string} convexRoot
 * @param {string} filePath
 * @returns {string}
 */
export function moduleRefForConvexFile(convexRoot, filePath) {
  const rel = relative(convexRoot, filePath).split(sep).join('/');
  return rel.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, '');
}

/**
 * Report whether `fromExport` is exactly one `export const NAME` binding whose
 * initializer starts at the trailing factory call (the factory name itself is
 * outside this slice).
 *
 * Semicolons inside type annotations (`{ a: string; b: number }`) must not
 * reject the binding — only a top-level statement terminator before `=` does.
 *
 * @param {string} fromExport
 * @returns {boolean}
 */
export function isExportConstBoundToTrailingFactory(fromExport) {
  const header = /^export\s+const\s+(\w+)/.exec(fromExport);
  if (!header) return false;
  if ((fromExport.match(/export\s+const\s+/g) || []).length !== 1) return false;

  let i = header[0].length;
  const source = fromExport;

  const skipWs = () => {
    while (i < source.length && /\s/.test(source[i])) i += 1;
  };

  /**
   * Advance from the first character of a type annotation to the binding `=`,
   * or return false if a top-level `;` ends the statement first.
   */
  const seekBindingEqualsThroughType = () => {
    let angle = 0;
    let paren = 0;
    let brace = 0;
    let bracket = 0;
    /** @type {null | "'" | '"' | '`'} */
    let quote = null;

    while (i < source.length) {
      const ch = source[i];
      if (quote !== null) {
        if (ch === '\\' && i + 1 < source.length) {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === '<') {
        angle += 1;
        i += 1;
        continue;
      }
      if (ch === '>') {
        angle = Math.max(0, angle - 1);
        i += 1;
        continue;
      }
      if (ch === '(') {
        paren += 1;
        i += 1;
        continue;
      }
      if (ch === ')') {
        paren = Math.max(0, paren - 1);
        i += 1;
        continue;
      }
      if (ch === '{') {
        brace += 1;
        i += 1;
        continue;
      }
      if (ch === '}') {
        brace = Math.max(0, brace - 1);
        i += 1;
        continue;
      }
      if (ch === '[') {
        bracket += 1;
        i += 1;
        continue;
      }
      if (ch === ']') {
        bracket = Math.max(0, bracket - 1);
        i += 1;
        continue;
      }

      const atTopLevel = angle === 0 && paren === 0 && brace === 0 && bracket === 0;
      if (atTopLevel && ch === ';' ) return false;
      if (atTopLevel && ch === '=') {
        // `=>` is part of a type (function type), not the binding equals.
        if (source[i + 1] === '>') {
          i += 2;
          continue;
        }
        return true;
      }
      i += 1;
    }
    return false;
  };

  skipWs();
  if (source[i] === ':') {
    i += 1;
    if (!seekBindingEqualsThroughType()) return false;
  } else {
    skipWs();
    if (source[i] !== '=') return false;
  }

  // `i` is on the binding `=`.
  if (source[i] !== '=') return false;
  i += 1;
  skipWs();
  // Nothing may sit between the binding equals and the factory call site.
  return i === source.length;
}

/**
 * List every Convex function export in one source file.
 *
 * @param {string} filePath
 * @returns {Map<string, string>} name → factory
 */
export function listConvexFunctionExports(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const exports = new Map();
  FACTORY_RE.lastIndex = 0;
  let match;
  while ((match = FACTORY_RE.exec(src)) !== null) {
    const factory = match[1];
    const windowStart = Math.max(0, match.index - 800);
    const window = src.slice(windowStart, match.index);
    const exportMatches = [...window.matchAll(/export\s+const\s+(\w+)\b/g)];
    if (exportMatches.length === 0) continue;
    const last = exportMatches[exportMatches.length - 1];
    const fromExport = window.slice(last.index);
    if (!isExportConstBoundToTrailingFactory(fromExport)) continue;
    exports.set(last[1], factory);
  }
  return exports;
}

/**
 * @typedef {{ moduleRef: string, name: string, factory: string, filePath: string }} ConvexFunctionExport
 */

/**
 * @param {string} convexRoot
 * @returns {ConvexFunctionExport[]}
 */
export function listAllConvexFunctionExports(convexRoot) {
  /** @type {ConvexFunctionExport[]} */
  const out = [];
  for (const filePath of walkConvexSourceFiles(convexRoot)) {
    const moduleRef = moduleRefForConvexFile(convexRoot, filePath);
    for (const [name, factory] of listConvexFunctionExports(filePath)) {
      out.push({ moduleRef, name, factory, filePath });
    }
  }
  out.sort((a, b) => {
    const byModule = a.moduleRef.localeCompare(b.moduleRef);
    if (byModule !== 0) return byModule;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * @param {string} convexRoot
 * @returns {ConvexFunctionExport[]}
 */
export function listInternalConvexFunctionExports(convexRoot) {
  return listAllConvexFunctionExports(convexRoot).filter((entry) =>
    INTERNAL_FN_TYPES.has(entry.factory),
  );
}

/**
 * @param {string} convexRoot
 * @returns {ConvexFunctionExport[]}
 */
export function listPublicConvexFunctionExports(convexRoot) {
  return listAllConvexFunctionExports(convexRoot).filter(
    (entry) => PUBLIC_FN_TYPES.has(entry.factory) && entry.factory !== 'httpAction',
  );
}

/**
 * Sentry Relay glob for a Convex "missing public function" message.
 *
 * Relay matches each glob case-insensitively against `"<type>: <value>"` as
 * well as the bare value, so the leading/trailing `*` absorb the `Error: `
 * prefix when present.
 *
 * @param {string} moduleRef
 * @param {string} name
 * @returns {string}
 */
export function convexMissingPublicFunctionPattern(moduleRef, name) {
  return `*Could not find public function for '${moduleRef}:${name}'*`;
}

/**
 * @param {string} convexRoot
 * @returns {string[]}
 */
export function listInternalMissingPublicFunctionPatterns(convexRoot) {
  return listInternalConvexFunctionExports(convexRoot).map((entry) =>
    convexMissingPublicFunctionPattern(entry.moduleRef, entry.name),
  );
}
