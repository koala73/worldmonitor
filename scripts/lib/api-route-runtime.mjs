/**
 * How an `api/` route declares its Vercel runtime, read the way Vercel reads
 * it: from the static `export const config = { runtime: '...' }` declaration,
 * never from file text.
 *
 * This lives in one place because three gates classify the same files and a
 * disagreement between them is silent: scripts/check-edge-function-bundles.mjs
 * picks the esbuild platform, scripts/enforce-runtime-handler-contract.mjs
 * picks the (req, res)-vs-Request handler contract, and the
 * NODE_RUNTIME_ROUTES drift assertion in tests/edge-functions.test.mjs decides
 * which routes may import node: built-ins. A `/runtime\s*:\s*['"]nodejs['"]/`
 * match over the raw source — the first shape of this helper — also fires on a
 * comment or an unrelated string literal, so an Edge route that merely
 * mentions the Node runtime in prose was bundled with esbuild's node platform
 * and its node: imports resolved, passing a gate the deployed Edge runtime
 * would fail at load. api/mcp-proxy.ts carries exactly such a comment.
 */
import ts from 'typescript';

/** Parse one api/ source for static-config reading. */
export function parseApiRouteSource(source, filePath = 'route.ts') {
  const kind = /\.(ts|mts|tsx)$/.test(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, kind);
}

export function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

export function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

export function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * `export const config = { runtime: '...' }` as Vercel's static-config reader
 * sees it. `runtime: null` with `literal: false` means the value is not a
 * string literal and the gate cannot classify the file.
 */
export function readRuntimeConfig(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'config') continue;
      const line = lineOf(sourceFile, declaration);
      const initializer = declaration.initializer ? unwrapExpression(declaration.initializer) : null;
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
        return { declared: true, runtime: null, literal: false, line };
      }
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== 'runtime') continue;
        const value = unwrapExpression(property.initializer);
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
          return { declared: true, runtime: value.text, literal: true, line };
        }
        return { declared: true, runtime: null, literal: false, line };
      }
      return { declared: true, runtime: null, literal: true, line };
    }
  }
  return { declared: false, runtime: null, literal: true, line: null };
}

/**
 * True only when the route's own exported config declares the Node runtime as
 * a string literal. A route that declares nothing is NOT reported here: Vercel
 * defaults it to Node, but the callers that care about that default
 * (scripts/enforce-runtime-handler-contract.mjs) read `readRuntimeConfig`
 * directly, while the bundle gate deliberately keeps undeclared routes on the
 * stricter browser bundle.
 */
export function declaresNodeRuntime(source, filePath = 'route.ts') {
  return readRuntimeConfig(parseApiRouteSource(source, filePath)).runtime === 'nodejs';
}
