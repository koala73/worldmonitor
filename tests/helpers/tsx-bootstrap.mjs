import ts from 'typescript';

/**
 * Does this module self-register the tsx ESM loader BEFORE its first TypeScript
 * dynamic import?
 *
 * A scripts-root seeder run by plain Node can still import `.mts` at runtime by
 * calling `register()` first. A walker that assumes `hasTsx: false` cannot
 * follow those edges, so it reports a closure that is too NARROW — the one
 * direction that strands a service when Railway decides which commits to build.
 *
 * Shared by tests/nixpacks-seeder-import-graph.test.mjs (which checks the
 * import graph resolves) and tests/railway-watch-path-audit.test.mjs (which
 * checks the deploy watch patterns actually cover that graph). Both need the
 * identical answer; a copy in one of them would drift.
 */
export function sourceBootstrapsTsx(src) {
  const sourceFile = ts.createSourceFile('seeder.mjs', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let registerName = null;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== 'tsx/esm/api') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const importedRegister = bindings.elements.find((element) => (element.propertyName ?? element.name).text === 'register');
    if (importedRegister) registerName = importedRegister.name.text;
  }
  if (!registerName) return false;

  const registerCall = sourceFile.statements.find((statement) =>
    ts.isExpressionStatement(statement)
      && ts.isCallExpression(statement.expression)
      && ts.isIdentifier(statement.expression.expression)
      && statement.expression.expression.text === registerName
      && statement.expression.arguments.length === 0);
  if (!registerCall) return false;

  let firstTypeScriptImport = Number.POSITIVE_INFINITY;
  function visit(node) {
    if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && /\.(?:ts|mts|cts)$/.test(node.arguments[0].text)) {
      firstTypeScriptImport = Math.min(firstTypeScriptImport, node.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return registerCall.getStart(sourceFile) < firstTypeScriptImport;
}
