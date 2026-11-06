import ts from 'typescript';

/** Supply real module constants when a legacy harness extracts a function body. */
export function moduleRegexDeclarations(source, arrayNames = [], excludeNames = []) {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true);
  return file.statements.filter(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.every(declaration => !excludeNames.includes(declaration.name.text) && declaration.initializer
      && (ts.isRegularExpressionLiteral(declaration.initializer)
        || (arrayNames.includes(declaration.name.text) && ts.isArrayLiteralExpression(declaration.initializer)
          && declaration.initializer.elements.every(element => ts.isStringLiteral(element)
            || ts.isRegularExpressionLiteral(element))))))
    .map(statement => `${statement.declarationList.getText(file)};`).join('\n');
}

/** Resolve static assertions without requiring regex literals at their call sites. */
export function inlineModuleRegexReferences(source, snippet = source) {
  const bindings = moduleRegexBindings(source);
  const file = ts.createSourceFile('snippet.ts', snippet, ts.ScriptTarget.Latest, true);
  const edits = [];
  function visit(node) {
    if (ts.isIdentifier(node) && bindings[node.text] instanceof RegExp) {
      const parent = node.parent;
      if (!(ts.isVariableDeclaration(parent) && parent.name === node)
        && !(ts.isPropertyAccessExpression(parent) && parent.name === node)
        && !(ts.isPropertyAssignment(parent) && parent.name === node)) {
        edits.push({ start: node.getStart(file), end: node.end, text: String(bindings[node.text]) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const edit of edits.sort((a, b) => b.start - a.start)) snippet = snippet.slice(0, edit.start) + edit.text + snippet.slice(edit.end);
  return snippet;
}

export function moduleRegexBindings(source) {
  const declarations = moduleRegexDeclarations(source);
  const file = ts.createSourceFile('constants.js', declarations, ts.ScriptTarget.Latest, true);
  const names = file.statements.flatMap(statement => statement.declarationList.declarations
    .map(declaration => declaration.name.text));
  return new Function(`${declarations}\nreturn { ${names.join(', ')} };`)();
}
