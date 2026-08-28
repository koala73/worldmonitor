import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import ts from 'typescript';

const UNKNOWN = Symbol('unknown-static-value');
const FUNCTION = Symbol('static-function');

function sourceFile(filePath, readSource) {
  const source = readSource(filePath);
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function modulePath(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = resolve(dirname(fromFile), specifier);
  if (extname(candidate)) return candidate;
  return `${candidate}.mjs`;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  throw new Error(`computed property names are not statically resolvable`);
}

function findVariable(sf, name) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function findFunctionReturn(sf, name) {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
      return statement.body.statements.find(ts.isReturnStatement)?.expression ?? null;
    }
  }
  const declaration = findVariable(sf, name);
  const initializer = declaration?.initializer && unwrapExpression(declaration.initializer);
  if (!initializer || (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))) return null;
  if (!ts.isBlock(initializer.body)) return initializer.body;
  return initializer.body.statements.find(ts.isReturnStatement)?.expression ?? null;
}

function findImport(sf, localName) {
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name?.text === localName) {
      return { importedName: 'default', specifier: statement.moduleSpecifier.text };
    }
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text === localName) {
        return {
          importedName: element.propertyName?.text ?? element.name.text,
          specifier: statement.moduleSpecifier.text,
        };
      }
    }
  }
  return null;
}

function findImportedCallBindings(sf, importedName, moduleSuffix) {
  const identifiers = new Set();
  const namespaces = new Set();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.endsWith(moduleSuffix)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === importedName) {
          identifiers.add(element.name.text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  return { identifiers, namespaces };
}

function findDefaultExport(sf) {
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) return statement.expression;
  }
  return null;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolveIdentifierValue(name, context) {
  const seenKey = `${context.filePath}::${name}`;
  if (context.seen.has(seenKey)) {
    throw new Error(`${context.filePath}: cyclic static reference ${name}`);
  }
  const seen = new Set(context.seen).add(seenKey);
  const local = findVariable(context.sf, name);
  if (local?.initializer) {
    return resolveValue(local.initializer, { ...context, seen });
  }
  if (context.sf.statements.some(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  )) return FUNCTION;

  const imported = findImport(context.sf, name);
  if (!imported) return UNKNOWN;
  const targetPath = modulePath(context.filePath, imported.specifier);
  if (!targetPath) return UNKNOWN;
  const targetSf = sourceFile(targetPath, context.readSource);
  const targetContext = { ...context, filePath: targetPath, sf: targetSf, seen };
  if (imported.importedName === 'default') {
    const exported = findDefaultExport(targetSf);
    if (!exported) return UNKNOWN;
    return resolveValue(exported, targetContext);
  }
  return resolveIdentifierValue(imported.importedName, targetContext);
}

function resolveObject(node, context) {
  const result = new Map();
  const valueNeeded = new Set([
    'label',
    'script',
    'canonicalKey',
    'freshnessMetaKey',
    'completionMetaKey',
    'extraKeys',
    'afterPublish',
    'afterFreshness',
  ]);
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = resolveValue(property.expression, context);
      if (!(spread instanceof Map)) {
        throw new Error(`${context.filePath}: object spread is not statically resolvable`);
      }
      for (const [key, value] of spread) result.set(key, value);
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name);
      result.set(name, valueNeeded.has(name) ? resolveValue(property.initializer, context) : UNKNOWN);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      const name = property.name.text;
      result.set(name, valueNeeded.has(name) ? resolveIdentifierValue(name, context) : UNKNOWN);
      continue;
    }
    if (ts.isMethodDeclaration(property)) {
      result.set(propertyName(property.name), FUNCTION);
      continue;
    }
    if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
      result.set(propertyName(property.name), UNKNOWN);
      continue;
    }
    throw new Error(`${context.filePath}: unsupported object property in static configuration`);
  }
  return result;
}

function resolveArray(node, context) {
  const result = [];
  for (const element of node.elements) {
    if (ts.isSpreadElement(element)) {
      const spread = resolveValue(element.expression, context);
      if (!Array.isArray(spread)) {
        throw new Error(`${context.filePath}: array spread is not statically resolvable`);
      }
      result.push(...spread);
      continue;
    }
    result.push(resolveValue(element, context));
  }
  return result;
}

function resolveValue(rawNode, context) {
  const node = unwrapExpression(rawNode);
  if (ts.isObjectLiteralExpression(node)) return resolveObject(node, context);
  if (ts.isArrayLiteralExpression(node)) return resolveArray(node, context);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) && node.text === 'undefined') return undefined;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return FUNCTION;
  if (ts.isIdentifier(node)) return resolveIdentifierValue(node.text, context);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveValue(node.whenTrue, context);
    const whenFalse = resolveValue(node.whenFalse, context);
    if (Array.isArray(whenTrue) && Array.isArray(whenFalse)) {
      const identity = (value) => value instanceof Map
        ? `${String(value.get('label'))}:${String(value.get('script'))}`
        : String(value);
      const trueMembers = [...whenTrue].map(identity).sort();
      const falseMembers = [...whenFalse].map(identity).sort();
      if (JSON.stringify(trueMembers) === JSON.stringify(falseMembers)) return whenTrue;
    }
    return UNKNOWN;
  }
  // Array filter/slice preserve a declared manifest's possible members, and
  // map preserves whether runSeed's extraKeys option is an array. The audit
  // needs membership/type, not the transformed element values.
  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ['filter', 'slice', 'map'].includes(node.expression.name.text)
  ) {
    const receiver = resolveValue(node.expression.expression, context);
    if (Array.isArray(receiver)) return receiver;
  }
  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'Object'
    && node.expression.name.text === 'freeze'
    && node.arguments[0]
  ) {
    return resolveValue(node.arguments[0], context);
  }
  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'Object'
    && node.expression.name.text === 'values'
  ) {
    return [];
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const returned = findFunctionReturn(context.sf, node.expression.text);
    if (returned) return resolveValue(returned, context);
  }
  return UNKNOWN;
}

function findCalls(sf, name) {
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === name
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

function findImportedCalls(sf, importedName, moduleSuffix) {
  const { identifiers, namespaces } = findImportedCallBindings(sf, importedName, moduleSuffix);
  if (identifiers.size === 0 && namespaces.size === 0) {
    const unboundCalls = findCalls(sf, importedName);
    if (unboundCalls.length > 0) {
      throw new Error(`${sf.fileName}: no statically identifiable ${importedName} import`);
    }
    return [];
  }
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && identifiers.has(node.expression.text)) {
        calls.push(node);
      } else if (
        ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === importedName
        && ts.isIdentifier(node.expression.expression)
        && namespaces.has(node.expression.expression.text)
      ) {
        calls.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

function contextFor(filePath, readSource) {
  return {
    filePath,
    readSource,
    sf: sourceFile(filePath, readSource),
    seen: new Set(),
  };
}

export function inspectRunSeedCalls(filePath, readSource = (path) => readFileSync(path, 'utf8')) {
  const context = contextFor(filePath, readSource);
  return findImportedCalls(context.sf, 'runSeed', '_seed-utils.mjs').map((call) => {
    const optionsNode = call.arguments[4];
    if (!optionsNode) return { hasExtraKeys: false, hasPostCanonicalWork: false };
    const options = resolveValue(optionsNode, context);
    if (!(options instanceof Map)) {
      throw new Error(`${filePath}: runSeed options are not statically resolvable`);
    }
    const extraKeys = options.get('extraKeys');
    const afterPublish = options.get('afterPublish');
    const afterFreshness = options.get('afterFreshness');
    for (const [name, value] of [['extraKeys', extraKeys], ['afterPublish', afterPublish], ['afterFreshness', afterFreshness]]) {
      if (options.has(name) && value === UNKNOWN) {
        throw new Error(`${filePath}: runSeed ${name} is not statically resolvable`);
      }
    }
    if (extraKeys && !Array.isArray(extraKeys)) {
      throw new Error(`${filePath}: runSeed extraKeys must resolve to an array`);
    }
    if (afterPublish && afterPublish !== FUNCTION) {
      throw new Error(`${filePath}: runSeed afterPublish must resolve to a function`);
    }
    if (afterFreshness && afterFreshness !== FUNCTION) {
      throw new Error(`${filePath}: runSeed afterFreshness must resolve to a function`);
    }
    const hasExtraKeys = Boolean(extraKeys);
    return {
      hasExtraKeys,
      hasPostCanonicalWork: hasExtraKeys || Boolean(afterPublish) || Boolean(afterFreshness),
    };
  });
}

export function extractAttestationBundleSections(
  filePath,
  readSource = (path) => readFileSync(path, 'utf8'),
) {
  const context = contextFor(filePath, readSource);
  const calls = findCalls(context.sf, 'runBundle');
  if (calls.length === 0) return null;
  if (calls.length !== 1) {
    throw new Error(`${filePath}: expected exactly one runBundle call, found ${calls.length}`);
  }
  const sectionValue = calls[0].arguments[1]
    ? resolveValue(calls[0].arguments[1], context)
    : UNKNOWN;
  if (!Array.isArray(sectionValue) || sectionValue.length === 0) {
    throw new Error(`${filePath}: runBundle member array is empty or not statically resolvable`);
  }
  const resolvedSections = sectionValue.map((section, index) => {
    if (!(section instanceof Map)) {
      throw new Error(`${filePath}: member ${index + 1} is not a statically resolvable object`);
    }
    const label = section.get('label');
    const script = section.get('script');
    if (typeof label !== 'string' || typeof script !== 'string') {
      throw new Error(`${filePath}: member ${index + 1} needs literal label and script values`);
    }
    const canonicalKey = section.get('canonicalKey');
    const freshnessMetaKey = section.get('freshnessMetaKey');
    const completionMetaKey = section.get('completionMetaKey');
    for (const [name, value] of [
      ['canonicalKey', canonicalKey],
      ['freshnessMetaKey', freshnessMetaKey],
      ['completionMetaKey', completionMetaKey],
    ]) {
      if (section.has(name) && value === UNKNOWN) {
        throw new Error(`${filePath}: ${label} ${name} is not statically resolvable`);
      }
    }
    if (completionMetaKey != null && typeof completionMetaKey !== 'string') {
      throw new Error(`${filePath}: ${label} completionMetaKey is not statically resolvable`);
    }
    return {
      label,
      script,
      hasCanonicalKey: Boolean(canonicalKey),
      hasFreshnessMetaKey: Boolean(freshnessMetaKey),
      completionMetaKey: typeof completionMetaKey === 'string' ? completionMetaKey : null,
    };
  });
  // Rotating bundles concatenate complementary slices of one manifest. Static
  // member analysis ignores order, so collapse the duplicate superset created
  // by resolving each dynamic slice to its receiver.
  return [...new Map(
    resolvedSections.map((section) => [`${section.label}:${section.script}`, section]),
  ).values()];
}
