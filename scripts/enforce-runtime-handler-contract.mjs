#!/usr/bin/env node
/**
 * Runtime handler contract gate for api/ routes.
 *
 * Vercel runs a default-exported function under api/ on the Node runtime as
 * `handler(req, res)` with an http.IncomingMessage / http.ServerResponse pair
 * (@vercel/node serverless-handler: `return listener(req, res)`). The Web
 * `(request: Request) => Response` signature is only dispatched when a module
 * exports named GET/HEAD/OPTIONS/POST/PUT/DELETE/PATCH handlers (or `fetch`).
 * Edge routes (`runtime: 'edge'`) are the opposite: always the Web signature.
 *
 * #4749 moved api/mcp-proxy.ts to `runtime: 'nodejs'` for the GHSA-887j
 * socket pin but kept `export default async function handler(req)`; every
 * production request 500'd at `req.headers.get` and #4754 reverted it 31
 * minutes later. Mocked unit tests hand the handler a `Request`, so they
 * could not see it. This gate reads the source instead of running it:
 *
 *   - A route on the Node runtime (declares `runtime: 'nodejs'`, or declares
 *     no runtime at all — Node is Vercel's default) must default-export a
 *     function with at least two parameters, must not type the first one as
 *     `Request` or the second one as an Edge `{ waitUntil }` context, and
 *     must not export HTTP-method-named / `fetch` functions (those silently
 *     switch Vercel to web-handler dispatch and ignore the default export).
 *   - A route on the Edge runtime must not use the Node `(req, res)` shape.
 *
 * Scope: the same tracked entrypoints scripts/check-edge-function-bundles.mjs
 * bundles (every tracked api/**\/*.js plus top-level api/*.ts), plus any
 * tracked api/ source that declares `runtime: 'nodejs'` wherever it lives.
 * `export { default } from './x'` shims are followed to the file that owns
 * the function. Exit 0 clean, 1 on any violation; output is file:line +
 * remedy.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { isMainModule } from './lib/main-module.mjs';
import {
  hasModifier,
  lineOf,
  parseApiRouteSource,
  propertyName,
  readRuntimeConfig,
  unwrapExpression,
} from './lib/api-route-runtime.mjs';
import {
  listEdgeFunctionEntries,
  listTrackedApiSourceFiles,
} from './check-edge-function-bundles.mjs';

// Kept as a named export: tests/enforce-runtime-handler-contract.test.mjs and
// the bundle gate both read the runtime through this module.
export { readRuntimeConfig };

/** Named exports that flip @vercel/node into web-handler dispatch. */
export const WEB_HANDLER_EXPORT_NAMES = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH', 'fetch']);

const RESOLVE_EXTENSIONS = ['.ts', '.mts', '.tsx', '.js', '.mjs', '.cjs'];
const MAX_REEXPORT_DEPTH = 4;

const parseSource = parseApiRouteSource;

function describeFunction(fn, sourceFile) {
  return {
    kind: 'function',
    line: lineOf(sourceFile, fn),
    params: fn.parameters.map((parameter) => ({
      name: parameter.name.getText(sourceFile),
      type: parameter.type ? parameter.type.getText(sourceFile) : null,
    })),
  };
}

function collectLocalFunctions(sourceFile) {
  const locals = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      locals.set(statement.name.text, describeFunction(statement, sourceFile));
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        locals.set(declaration.name.text, describeFunction(initializer, sourceFile));
      }
    }
  }
  return locals;
}

function collectImportedDefaults(sourceFile) {
  // `import handler from './x'` → local name → module specifier, so
  // `export default handler` can be followed like a re-export.
  const imports = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.name) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    imports.set(statement.importClause.name.text, statement.moduleSpecifier.text);
  }
  return imports;
}

function shapeOfExpression(expression, sourceFile, locals, importedDefaults) {
  const node = unwrapExpression(expression);
  const line = lineOf(sourceFile, node);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return describeFunction(node, sourceFile);
  if (ts.isIdentifier(node)) {
    const local = locals.get(node.text);
    if (local) return local;
    const from = importedDefaults.get(node.text);
    if (from) return { kind: 'reexport', from, line };
    return { kind: 'identifier', name: node.text, line };
  }
  if (ts.isCallExpression(node)) return { kind: 'call', text: `${node.expression.getText(sourceFile)}(...)`, line };
  return { kind: 'expression', text: node.getText(sourceFile).slice(0, 60), line };
}

/** The module's default export, or null when it has none (a helper module). */
export function findDefaultExport(sourceFile) {
  const locals = collectLocalFunctions(sourceFile);
  const importedDefaults = collectImportedDefaults(sourceFile);
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)
      && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      return describeFunction(statement, sourceFile);
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return shapeOfExpression(statement.expression, sourceFile, locals, importedDefaults);
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== 'default') continue;
        const line = lineOf(sourceFile, element);
        const localName = (element.propertyName ?? element.name).text;
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          return { kind: 'reexport', from: statement.moduleSpecifier.text, line };
        }
        return locals.get(localName) ?? { kind: 'identifier', name: localName, line };
      }
    }
  }
  return null;
}

/** Named exports that would switch Vercel's Node runtime to web-handler dispatch. */
export function findWebHandlerExports(sourceFile) {
  const names = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)
      && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      && !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      && statement.name
      && WEB_HANDLER_EXPORT_NAMES.has(statement.name.text)) {
      names.push(statement.name.text);
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && WEB_HANDLER_EXPORT_NAMES.has(declaration.name.text)) {
          names.push(declaration.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (WEB_HANDLER_EXPORT_NAMES.has(element.name.text)) names.push(element.name.text);
      }
    }
  }
  return names;
}

function resolveRelativeModule(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];
  // TS-ESM convention: `./x.js` in source may be `x.ts` on disk.
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, '.ts'));
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

/**
 * Analyse one route file. `readSource` lets tests feed fixtures; re-exports
 * are followed (up to MAX_REEXPORT_DEPTH) to the module that owns the
 * function, while the runtime is always the entry file's own declaration —
 * that is the file Vercel reads the static config from.
 */
export function analyzeRouteFile(filePath, { readSource = (file) => readFileSync(file, 'utf8') } = {}) {
  const source = readSource(filePath);
  const sourceFile = parseSource(source, filePath);
  const config = readRuntimeConfig(sourceFile);
  const webHandlerExports = findWebHandlerExports(sourceFile);
  let defaultExport = findDefaultExport(sourceFile);
  const via = [];

  let currentFile = filePath;
  let depth = 0;
  while (defaultExport?.kind === 'reexport') {
    if (depth >= MAX_REEXPORT_DEPTH) {
      defaultExport = { kind: 'expression', text: `re-export chain deeper than ${MAX_REEXPORT_DEPTH}`, line: defaultExport.line };
      break;
    }
    const resolved = resolveRelativeModule(currentFile, defaultExport.from);
    if (!resolved) {
      defaultExport = { kind: 'expression', text: `unresolvable re-export from '${defaultExport.from}'`, line: defaultExport.line };
      break;
    }
    via.push(resolved);
    currentFile = resolved;
    defaultExport = findDefaultExport(parseSource(readSource(resolved), resolved));
    depth += 1;
  }

  return {
    filePath,
    config,
    runtime: config.runtime === 'edge' ? 'edge' : 'nodejs',
    defaultExport,
    definedIn: currentFile,
    via,
    webHandlerExports,
  };
}

function describeShape(shape) {
  if (!shape) return 'no default export';
  if (shape.kind === 'function') return `a function taking (${shape.params.map((parameter) => parameter.name).join(', ')})`;
  if (shape.kind === 'call') return `the call ${shape.text}`;
  if (shape.kind === 'identifier') return `the identifier ${shape.name} (not a local function)`;
  return shape.text;
}

const NODE_REMEDY = 'export default async function handler(req, res) — build a fetch Request from the IncomingMessage, run the Web logic, and write the Response back with res.writeHead()/res.end() (see api/mcp-proxy.ts).';
const EDGE_REMEDY = "export default async function handler(req: Request): Promise<Response> — Edge routes receive a fetch Request; there is no ServerResponse.";

/** Violations for one analysed route. Each is { file, line, message, remedy }. */
export function collectRouteViolations(analysis, relativePath = analysis.filePath) {
  const violations = [];
  const push = (line, message, remedy) => violations.push({ file: relativePath, line, message, remedy });
  const { config, defaultExport } = analysis;

  if (config.declared && !config.literal) {
    push(config.line, 'export const config.runtime is not a string literal — Vercel reads this statically and so does this gate.',
      "write runtime: 'edge' or runtime: 'nodejs' as a literal.");
    return violations;
  }

  const location = analysis.via.length ? ` (default export defined in ${path.relative(process.cwd(), analysis.definedIn)})` : '';

  if (analysis.runtime === 'edge') {
    if (defaultExport?.kind === 'function' && defaultExport.params.length >= 2) {
      const second = defaultExport.params[1];
      if (/^res\b/.test(second.name) || /\b(ServerResponse|VercelResponse)\b/.test(second.type ?? '')) {
        push(defaultExport.line, `Edge route default-exports a Node-style (req, res) handler${location}; the Edge runtime passes (Request, context) and never a ServerResponse.`, EDGE_REMEDY);
      }
    }
    return violations;
  }

  // Node runtime (declared, or Vercel's default when nothing is declared).
  const runtimeLabel = config.declared && config.runtime ? `runtime: '${config.runtime}'` : 'no runtime declared (Vercel defaults to Node)';

  if (analysis.webHandlerExports.length > 0) {
    push(1, `exports ${analysis.webHandlerExports.join(', ')} with ${runtimeLabel} — @vercel/node switches to web-handler dispatch for HTTP-method/fetch exports and ignores the default export.`,
      'keep a single default (req, res) export on Node routes; move Web-style method handlers to an Edge route.');
  }

  if (!defaultExport) return violations; // helper module, not a route

  if (defaultExport.kind !== 'function') {
    push(defaultExport.line, `default export is ${describeShape(defaultExport)} with ${runtimeLabel}${location} — the (req, res) shape cannot be verified statically.`, NODE_REMEDY);
    return violations;
  }

  if (defaultExport.params.length < 2) {
    push(defaultExport.line, `default export takes ${defaultExport.params.length} parameter(s) with ${runtimeLabel}${location}. The Node runtime invokes it as handler(req, res) with http.IncomingMessage / http.ServerResponse — this is the #4749 shape that 500'd every request (reverted in #4754).`, NODE_REMEDY);
    return violations;
  }

  const [first, second] = defaultExport.params;
  if (/^Request\b/.test(first.type ?? '')) {
    push(defaultExport.line, `first parameter is typed as ${first.type} with ${runtimeLabel}${location}; on the Node runtime it is an http.IncomingMessage (plain headers object, no .headers.get()).`, NODE_REMEDY);
  }
  if (/\bwaitUntil\b/.test(second.type ?? '')) {
    push(defaultExport.line, `second parameter is an Edge context (${second.type}) with ${runtimeLabel}${location}; on the Node runtime it is the http.ServerResponse.`, NODE_REMEDY);
  }
  return violations;
}

/**
 * Every tracked route entry the bundle gate checks, plus any tracked api/
 * source declaring runtime:'nodejs' wherever it lives (a nested Node route
 * is still a function Vercel deploys).
 */
export function listRouteFiles(root) {
  const files = new Set(listEdgeFunctionEntries(root));
  for (const file of listTrackedApiSourceFiles(root)) {
    if (path.posix.basename(file).includes('.test.')) continue;
    if (!existsSync(path.join(root, file))) continue;
    if (readRuntimeConfig(parseSource(readFileSync(path.join(root, file), 'utf8'), file)).runtime === 'nodejs') files.add(file);
  }
  return [...files].filter((file) => existsSync(path.join(root, file))).sort();
}

export function collectNodeRuntimeHandlerShapeViolations(root = process.cwd()) {
  const routes = [];
  const violations = [];
  for (const file of listRouteFiles(root)) {
    const analysis = analyzeRouteFile(path.join(root, file));
    routes.push({ file, runtime: analysis.runtime, defaultExport: analysis.defaultExport });
    violations.push(...collectRouteViolations(analysis, file));
  }
  return { routes, violations };
}

function main() {
  const root = process.cwd();
  const { routes, violations } = collectNodeRuntimeHandlerShapeViolations(root);
  if (routes.length === 0) {
    console.error('runtime handler contract check found zero tracked api/ routes — refusing to pass vacuously');
    process.exitCode = 1;
    return;
  }
  if (violations.length > 0) {
    console.error(`runtime handler contract check failed: ${violations.length} violation(s)\n`);
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line} ${violation.message}`);
      console.error(`  → ${violation.remedy}\n`);
    }
    process.exitCode = 1;
    return;
  }
  const nodeRoutes = routes.filter((route) => route.runtime === 'nodejs').length;
  console.log(`runtime handler contract ok: ${routes.length} tracked api/ routes (${nodeRoutes} nodejs, ${routes.length - nodeRoutes} edge)`);
}

// Realpath-safe entry guard — see scripts/lib/main-module.mjs for why a naive
// import.meta.url comparison exits 0 having checked nothing behind a symlink.
if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
