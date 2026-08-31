#!/usr/bin/env -S npx tsx
/**
 * Validates that every `new <ServiceClient>(...)` instantiation in src/ which
 * calls a method whose generated path is in PREMIUM_RPC_PATHS is constructed
 * with `{ fetch: premiumFetch }`.
 *
 * Catches the HIGH(new) #1 class from #3242 review — SupplyChainServiceClient
 * was constructed with globalThis.fetch (the generated default) and pro users
 * silently got 401s the generated client swallowed into empty-fallback panels.
 * Same class as #3233 (RegionalIntelligenceBoard / DeductionPanel / trade /
 * country-intel) which was fixed manually because there was no enforcement.
 *
 * How it works:
 *   1. Dynamic `import()` of PREMIUM_RPC_PATHS from src/shared/premium-paths.ts
 *      (via tsx, same pattern as enforce-rate-limit-policies.mjs) → set of
 *      premium HTTP paths. Live import means reformatting the source literal
 *      can never desync the lint from the runtime (#3287 follow-up).
 *   2. Walk src/generated/client/ → map each ServiceClient class to its
 *      method-name → path table (the `let path = "/api/..."` line each
 *      generated method opens with).
 *   3. Walk src/ (excluding generated) with the TypeScript AST. For each
 *      `new <ClassName>(...)` (variable decl OR `this.foo =` assignment):
 *        a. Capture the bound variable / member name.
 *        b. Find every `<varName>.<method>(...)` call in the same file.
 *        c. If any called method has a premium path, the construction MUST
 *           use { fetch: premiumFetch }. Anything else fails the lint.
 *
 * Per-call-site analysis lets the trade/index.ts pattern (publicClient with
 * globalThis.fetch + premiumClient with premiumFetch on the same class)
 * stay clean, since publicClient never calls a premium method.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isMainModule } from './lib/main-module.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PREMIUM_PATHS_SRC = join(ROOT, 'src/shared/premium-paths.ts');
const GEN_CLIENT_DIR = join(ROOT, 'src/generated/client');
const SRC_DIR = join(ROOT, 'src');
const PREMIUM_FETCH_SRC = join(ROOT, 'src/services/premium-fetch.ts');

/**
 * Adapters that satisfy the rule WITHOUT being `premiumFetch` itself, because
 * they delegate premium-path traffic to it.
 *
 * `proFreshRpcFetch` is the only one: MarketServiceClient needs an adapter that
 * ALSO force-attaches a Bearer on the Pro-fresh cache allowlist (paths that
 * stay free but refresh faster for Pro), so it cannot simply be premiumFetch.
 * Once the physical-metals routes became premium (#6436/#6448) that same client
 * gained genuinely gated methods, and this lint failed on a call that is in
 * fact authenticated.
 *
 * Naming an adapter here is not enough — assertDelegatingAdapters() below reads
 * premium-fetch.ts and fails if the function stops routing premium targets to
 * premiumFetch. Without that check this constant would be a hole in the lint:
 * anyone could silence a real violation by renaming their adapter.
 */
const DELEGATING_ADAPTERS = new Set(['proFreshRpcFetch']);

/**
 * Prove each DELEGATING_ADAPTERS entry is a real function in premium-fetch.ts
 * whose body returns `premiumFetch(input, init)` under an affirmative
 * `isPremiumRpcTarget(input)` call. Identifiers must match the adapter
 * parameters. A substring scan is not enough: inverted, wrong-argument, and
 * text-only guards would still send premium targets through unauthenticated
 * `globalThis.fetch`.
 */
function unwrapParens(node) {
  let cur = node;
  while (cur && ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function identifierText(node) {
  const inner = unwrapParens(node);
  return inner && ts.isIdentifier(inner) ? inner.text : null;
}

function adapterParamNames(fnNode) {
  const names = [];
  for (const param of fnNode.parameters) {
    if (!ts.isIdentifier(param.name)) return null;
    names.push(param.name.text);
  }
  return names;
}

/** `isPremiumRpcTarget(input)` — a CallExpression, not `!isPremiumRpcTarget(...)`. */
function isAffirmativePremiumTargetCall(expr, inputName) {
  const call = unwrapParens(expr);
  if (!call || !ts.isCallExpression(call)) return false;
  if (identifierText(call.expression) !== 'isPremiumRpcTarget') return false;
  if (call.arguments.length < 1) return false;
  return identifierText(call.arguments[0]) === inputName;
}

/** `return premiumFetch(input, init)` as the then-branch or its first statement. */
function isPremiumFetchReturn(stmt, inputName, initName) {
  if (ts.isBlock(stmt)) {
    const first = stmt.statements[0];
    return first ? isPremiumFetchReturn(first, inputName, initName) : false;
  }
  if (!ts.isReturnStatement(stmt) || !stmt.expression) return false;
  const call = unwrapParens(stmt.expression);
  if (!call || !ts.isCallExpression(call)) return false;
  if (identifierText(call.expression) !== 'premiumFetch') return false;
  if (call.arguments.length !== 2) return false;
  return identifierText(call.arguments[0]) === inputName
    && identifierText(call.arguments[1]) === initName;
}

function hasAffirmativePremiumDelegation(fnNode) {
  const params = adapterParamNames(fnNode);
  if (!params || params.length < 2 || !fnNode.body) return false;
  const [inputName, initName] = params;
  let guarded = false;
  function findGuard(n) {
    if (
      ts.isIfStatement(n)
      && isAffirmativePremiumTargetCall(n.expression, inputName)
      && isPremiumFetchReturn(n.thenStatement, inputName, initName)
    ) {
      guarded = true;
      return;
    }
    ts.forEachChild(n, findGuard);
  }
  findGuard(fnNode.body);
  return guarded;
}

export function assertDelegatingAdapters(
  src = readFileSync(PREMIUM_FETCH_SRC, 'utf8'),
  adapters = DELEGATING_ADAPTERS,
) {
  const ast = ts.createSourceFile(PREMIUM_FETCH_SRC, src, ts.ScriptTarget.Latest, true);
  const seen = new Set();

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && adapters.has(node.name.text) && node.body) {
      const bodyText = node.body.getText(ast);
      if (!hasAffirmativePremiumDelegation(node)) {
        throw new Error(
          `${relative(ROOT, PREMIUM_FETCH_SRC)}: ${node.name.text} is listed in `
          + `DELEGATING_ADAPTERS but no longer routes isPremiumRpcTarget() traffic to `
          + `premiumFetch(). Every ServiceClient built with it is now unauthenticated on `
          + `its premium methods. Restore the delegation or drop the adapter from the set.\n\n`
          + `Body seen:\n${bodyText.slice(0, 400)}`,
        );
      }
      seen.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);

  for (const name of adapters) {
    if (!seen.has(name)) {
      throw new Error(
        `DELEGATING_ADAPTERS names "${name}" but ${relative(ROOT, PREMIUM_FETCH_SRC)} exports no such `
        + `function declaration. Remove the stale entry — a name that resolves to nothing silences `
        + `every violation that happens to use it.`,
      );
    }
  }
}

export { DELEGATING_ADAPTERS, PREMIUM_FETCH_SRC };

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, fn);
    else if (s.isFile()) fn(full);
  }
}

async function loadPremiumPaths() {
  // Dynamic import via file URL — runs under tsx (the shebang) which
  // transparently transpiles TS. Importing the live Set means any reformat of
  // the source literal (single→double quotes, spread, helper-computed entries)
  // can never desync the lint from the runtime.
  const mod = await import(pathToFileURL(PREMIUM_PATHS_SRC).href);
  if (!(mod.PREMIUM_RPC_PATHS instanceof Set) || mod.PREMIUM_RPC_PATHS.size === 0) {
    throw new Error(
      `${PREMIUM_PATHS_SRC} must export PREMIUM_RPC_PATHS as a non-empty Set<string> — the lint relies on it.`,
    );
  }
  return mod.PREMIUM_RPC_PATHS;
}

function loadClientClassMap() {
  // AST walk rather than regex — the earlier regex
  //   /async (\w+)\s*\([^)]*\)\s*:\s*Promise<[^>]+>\s*\{\s*let path = "([^"]+)"/
  // assumed (a) no nested `)` in arg types, (b) no nested `>` in the return
  // type, (c) `let path = "..."` as the literal first statement. Any shift in
  // the codegen template would silently drop methods and the lint would pass
  // clean with missing coverage — the same silent-drift class this PR closed
  // on the premium-paths side (#3287 greptile nit 2).
  const map = new Map();
  walk(GEN_CLIENT_DIR, (file) => {
    if (basename(file) !== 'service_client.ts') return;
    const src = readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);

    function visit(node) {
      if (
        ts.isClassDeclaration(node) &&
        node.name &&
        /ServiceClient$/.test(node.name.text) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const methods = new Map();
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          if (!member.name || !ts.isIdentifier(member.name)) continue;
          const methodName = member.name.text;
          const body = member.body;
          if (!body) continue;
          // Look for the first `let path = "/api/..."` variable statement in
          // the method body. Generated clients open each RPC method with it.
          for (const stmt of body.statements) {
            if (!ts.isVariableStatement(stmt)) continue;
            const decl = stmt.declarationList.declarations[0];
            if (
              decl &&
              ts.isIdentifier(decl.name) &&
              decl.name.text === 'path' &&
              decl.initializer &&
              ts.isStringLiteral(decl.initializer)
            ) {
              methods.set(methodName, decl.initializer.text);
              break;
            }
          }
        }
        map.set(node.name.text, methods);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  });
  if (map.size === 0) {
    throw new Error(`No ServiceClient classes parsed from ${GEN_CLIENT_DIR}`);
  }
  return map;
}

function collectSourceFiles() {
  const out = [];
  walk(SRC_DIR, (file) => {
    if (file.startsWith(GEN_CLIENT_DIR)) return;
    if (!/\.(ts|tsx)$/.test(file)) return;
    if (file.endsWith('.d.ts')) return;
    out.push(file);
  });
  return out;
}

function getFetchOptionText(optionsArg) {
  if (!optionsArg) return null;
  if (!ts.isObjectLiteralExpression(optionsArg)) return optionsArg.getText();
  for (const prop of optionsArg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
    if (name === 'fetch') return prop.initializer.getText();
  }
  return null;
}

function checkFile(filePath, clientClassMap, premiumPaths) {
  const src = readFileSync(filePath, 'utf8');
  const ast = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);

  const instances = [];

  function recordInstance(varName, newExpr, posNode, accessorNames) {
    const className = newExpr.expression.getText();
    if (!clientClassMap.has(className)) return;
    const optionsArg = newExpr.arguments?.[1] ?? null;
    const lc = ast.getLineAndCharacterOfPosition(posNode.getStart());
    instances.push({
      varName,
      className,
      optionsArg,
      accessorNames,
      line: lc.line + 1,
      column: lc.character + 1,
    });
  }

  /**
   * Names that hand this instance to a caller, for the two lazy shapes that
   * dominate src/ and that a bare identifier match cannot see:
   *
   *   const getClient = createLazyClient(() => new XServiceClient(...))
   *   let _client; function getClient() { _client ??= new XServiceClient(...); }
   *
   * Both are reached as `getClient().method()`, so the receiver is a
   * CallExpression rather than the bound identifier. resilience.ts shipped two
   * PREMIUM_RPC_PATHS methods on a bare globalThis.fetch through exactly this
   * hole — the lint reported "clean" the whole time.
   *
   * Walking every enclosing declaration is deliberately generous: an extra name
   * can only cause this lint to attribute MORE calls to an instance, which is
   * the fail-safe direction for a guard whose whole job is catching a missing
   * premiumFetch.
   */
  function findAccessorNames(newExpr) {
    const names = new Set();
    for (let cur = newExpr.parent; cur; cur = cur.parent) {
      if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
        names.add(cur.name.text);
      } else if (ts.isFunctionDeclaration(cur) && cur.name) {
        names.add(cur.name.text);
      } else if (
        (ts.isMethodDeclaration(cur) || ts.isGetAccessorDeclaration(cur)) &&
        cur.name && ts.isIdentifier(cur.name)
      ) {
        names.add(cur.name.text);
      }
    }
    return names;
  }

  function visit(node) {
    if (ts.isNewExpression(node) && clientClassMap.has(node.expression.getText())) {
      // The direct binding, when there is one. A `createLazyClient(() => new X())`
      // has none — it is reached only through its accessor.
      let varName = null;
      let posNode = node;
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        varName = parent.name.text;
        posNode = parent;
      } else if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === node
      ) {
        varName = parent.left.getText();
        posNode = parent;
      }
      recordInstance(varName, node, posNode, findAccessorNames(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);

  if (instances.length === 0) return [];

  const violations = [];
  for (const inst of instances) {
    const methods = clientClassMap.get(inst.className);
    const calledMethods = new Set();

    // Scope-blind walk — matches any `<varName>.<method>()` anywhere in the
    // file. If two constructions in different function scopes share the same
    // variable name (e.g. both declare `const client = new XServiceClient()`
    // in unrelated functions), their called-method sets merge and the lint
    // errs on the side of caution (flags premium calls against both
    // instances). No current src/ file hits this — keeping the walker
    // simple until scope-aware binding is actually needed (#3287 nit 5).
    function findCalls(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const receiver = node.expression.expression;
        const methodName = node.expression.name.text;
        // `client.method()` — the bound identifier.
        let matches = inst.varName !== null && receiver.getText() === inst.varName;
        // `getClient().method()` — the accessor shapes above.
        if (!matches && ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression)) {
          matches = inst.accessorNames.has(receiver.expression.text);
        }
        if (matches) calledMethods.add(methodName);
      }
      ts.forEachChild(node, findCalls);
    }
    findCalls(ast);

    const premiumCalls = [...calledMethods].filter((m) => {
      const path = methods.get(m);
      return path && premiumPaths.has(path);
    });
    if (premiumCalls.length === 0) continue;

    const fetchText = getFetchOptionText(inst.optionsArg);
    if (fetchText === 'premiumFetch') continue;
    if (DELEGATING_ADAPTERS.has(fetchText)) continue;

    violations.push({
      file: filePath,
      line: inst.line,
      column: inst.column,
      varName: inst.varName,
      accessorNames: inst.accessorNames,
      className: inst.className,
      fetchText: fetchText ?? '<no fetch option — defaults to globalThis.fetch>',
      premiumCalls,
    });
  }
  return violations;
}

async function main() {
  // Before trusting any adapter exemption, prove the exemption is real.
  assertDelegatingAdapters();
  const premiumPaths = await loadPremiumPaths();
  const clientClassMap = loadClientClassMap();
  const files = collectSourceFiles();

  const violations = [];
  for (const f of files) {
    violations.push(...checkFile(f, clientClassMap, premiumPaths));
  }

  if (violations.length > 0) {
    console.error(
      `\u2717 ${violations.length} ServiceClient instantiation(s) call PREMIUM_RPC_PATHS methods without { fetch: premiumFetch }:\n`,
    );
    for (const v of violations) {
      const rel = relative(ROOT, v.file);
      console.error(`  ${rel}:${v.line}:${v.column}`);
      // A lazily-constructed client has no binding at all — it is reached only
      // through its accessor, so name that instead of printing `null`.
      const reachedBy = v.varName !== null
        ? `bound to \`${v.varName}\``
        : v.accessorNames.size > 0
          ? `reached via \`${[...v.accessorNames].map((n) => `${n}()`).join('` / `')}\``
          : 'unbound';
      console.error(`    new ${v.className}(...) ${reachedBy}`);
      console.error(`    fetch option: ${v.fetchText}`);
      console.error(`    premium method(s) called: ${v.premiumCalls.join(', ')}`);
      console.error('');
    }
    console.error('Each ServiceClient that calls a method whose path is in');
    console.error('src/shared/premium-paths.ts PREMIUM_RPC_PATHS must be constructed with');
    console.error('  { fetch: premiumFetch }');
    console.error('imported from @/services/premium-fetch.\n');
    console.error('Why: globalThis.fetch sends no auth header, so signed-in browser pros');
    console.error('without a WORLDMONITOR_API_KEY get a 401 the generated client swallows');
    console.error('into the empty fallback. premiumFetch injects WM key / Clerk bearer when');
    console.error('available and no-ops safely otherwise — safe to use even on a client whose');
    console.error('other methods target public paths (see src/services/supply-chain/index.ts).\n');
    console.error('If a single class needs both gated and ungated calls, split into two');
    console.error('instances — one with premiumFetch (used for premium methods) and one with');
    console.error('globalThis.fetch (used for public methods only). See src/services/trade/');
    console.error('index.ts for the publicClient + premiumClient pattern.\n');
    console.error('Reference: HIGH(new) #1 in #3242 review — SupplyChainServiceClient was');
    console.error('constructed with globalThis.fetch and pro users saw silent empty country-');
    console.error('products + multi-sector-cost-shock panels until commit 01518c3c.');
    process.exit(1);
  }

  console.log(
    `\u2713 premium-fetch parity clean: ${clientClassMap.size} ServiceClient classes scanned, ${premiumPaths.size} premium paths checked, ${files.length} src/ files analyzed.`,
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
