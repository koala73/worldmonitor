#!/usr/bin/env node
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const STATEFUL_FLAGS = /[gy]/;
const CAMEL_CASE_RE = /([a-z0-9])([A-Z])/g;
const NON_IDENTIFIER_RE = /[^a-zA-Z0-9_]/g;
const SOURCE_EXTENSION_RE = /\.(?:[cm]?[jt]s|tsx)$/;
const EXCLUDED_DIRECTORY_RE = /(?:^|\/)(?:node_modules|vendor|generated|_generated|tests?|__tests__|e2e|fixtures)(?:\/|\.)/;
const TEST_EXTENSION_RE = /\.(?:test|spec|d)\.[cm]?[jt]s$/;
const GENERATED_NAME_RE = /\.generated\./;
const ISOLATED_CALLBACK_METHODS = new Set(['evaluate', 'evaluateHandle', 'addInitScript', '$eval', '$$eval', 'waitForFunction']);
const COMMON_NAMES = new Map([
  ['/\\s+/g', 'WHITESPACE_RE'],
  ['/\\s+/', 'WHITESPACE_RE'],
  ['/\\r?\\n/', 'LINE_BREAK_RE'],
  ['/\\r?\\n/g', 'LINE_BREAK_RE'],
  ['/\\D/g', 'NON_DIGIT_RE'],
  ['/\\/$/', 'TRAILING_SLASH_RE'],
  ['/[^a-z0-9]+/g', 'NON_ALPHANUMERIC_RE'],
  ['/[^a-z0-9]/g', 'NON_ALPHANUMERIC_RE'],
  ['/^[A-Z]{2}$/', 'COUNTRY_CODE_RE'],
]);

function safeUse(node, flags) {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.arguments[0] === node
    && ts.isPropertyAccessExpression(parent.expression)) {
    const method = parent.expression.name.text;
    return ['split', 'search'].includes(method)
      || (!flags.includes('y') && (['replace', 'replaceAll', 'match'].includes(method)
        || (method === 'matchAll' && flags.includes('g'))));
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return ['source', 'flags'].includes(parent.name.text)
      || (!STATEFUL_FLAGS.test(flags) && ['test', 'exec'].includes(parent.name.text));
  }
  return false;
}

function nameFor(node) {
  let owner = node.parent;
  while (owner) {
    if ((ts.isFunctionLike(owner) || ts.isVariableDeclaration(owner))
      && owner.name && ts.isIdentifier(owner.name)) {
      const name = owner.name.text;
      if (!['re', 'regex', 'pattern', 'match', 'm'].includes(name)) {
        return name.replace(CAMEL_CASE_RE, '$1_$2').replace(NON_IDENTIFIER_RE, '_').toUpperCase();
      }
    }
    owner = owner.parent;
  }
  return 'MODULE';
}

const apply = process.argv.includes('--write');
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
  .filter(path => SOURCE_EXTENSION_RE.test(path))
  .filter(path => !path.startsWith('.'))
  .filter(path => !EXCLUDED_DIRECTORY_RE.test(path))
  .filter(path => !TEST_EXTENSION_RE.test(path))
  .filter(path => !GENERATED_NAME_RE.test(path))
  // The production acceptance artifact pins the exact bytes of this historical harness.
  .filter(path => path !== 'scripts/dry-run-resilience-financial-system-exposure-flip.mjs')
  .filter(path => path !== 'scripts/hoist-regexes.mjs');

const report = [];
for (const path of paths) {
  const source = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const candidates = [];
  const skipped = [];
  const identifiers = new Set();
  const isolatedFunctions = new Set();
  let checker;
  function symbolAt(node) {
    if (!checker) {
      const options = { allowJs: true, noResolve: true, noLib: true };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = name => name === path ? file : undefined;
      checker = ts.createProgram([path], options, host).getTypeChecker();
    }
    return checker.getSymbolAtLocation(node);
  }
  function findIsolatedCallbacks(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'urlPattern'
      && ts.isIdentifier(node.initializer)) isolatedFunctions.add(node.initializer.text);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ISOLATED_CALLBACK_METHODS.has(node.expression.name.text)) {
      for (const argument of node.arguments) if (ts.isIdentifier(argument)) isolatedFunctions.add(argument.text);
    }
    ts.forEachChild(node, findIsolatedCallbacks);
  }
  findIsolatedCallbacks(file);
  function isolated(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isFunctionLike(parent)) continue;
      if (ts.isPropertyAssignment(parent.parent) && parent.parent.name.getText(file) === 'urlPattern') return true;
      if (ts.isMethodDeclaration(parent) && parent.name.getText(file) === 'urlPattern') return true;
      if (parent.name && ts.isIdentifier(parent.name) && isolatedFunctions.has(parent.name.text)) return true;
      if (ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)
        && isolatedFunctions.has(parent.parent.name.text)) return true;
      const call = parent.parent;
      if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
        && ISOLATED_CALLBACK_METHODS.has(call.expression.name.text)) return true;
    }
    return false;
  }
  const constants = new Map();
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, { declaration, statement });
      }
    }
  }
  function staticValue(node, seen = new Set()) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { value: node.text, after: 0 };
    if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
      const { declaration, statement } = constants.get(node.text);
      if (!symbolAt(node)?.declarations?.includes(declaration)) return;
      const resolved = staticValue(declaration.initializer, new Set([...seen, node.text]));
      // A const binding does not make its array immutable; aliases can mutate it.
      // Only inline array literals are safe to resolve for constructor arguments.
      if (resolved && !Array.isArray(resolved.value)) {
        return { value: resolved.value, after: Math.max(resolved.after, statement.end) };
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticValue(node.left, seen);
      const right = staticValue(node.right, seen);
      if (left && right) return { value: left.value + right.value, after: Math.max(left.after, right.after) };
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      let after = 0;
      for (const span of node.templateSpans) {
        const resolved = staticValue(span.expression, seen);
        if (!resolved) return;
        value += resolved.value + span.literal.text;
        after = Math.max(after, resolved.after);
      }
      return { value, after };
    }
    if (ts.isArrayLiteralExpression(node)) {
      const items = node.elements.map(item => staticValue(item, seen));
      if (items.every(Boolean)) return { value: items.map(item => item.value), after: Math.max(0, ...items.map(item => item.after)) };
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'join' && node.arguments.length === 1) {
      const array = staticValue(node.expression.expression, seen);
      const separator = staticValue(node.arguments[0], seen);
      if (array && Array.isArray(array.value) && separator) return { value: array.value.join(separator.value), after: Math.max(array.after, separator.after) };
    }
  }
  function visit(node) {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    const literal = ts.isRegularExpressionLiteral(node);
    const isRegExpConstructor = ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp';
    if (literal || isRegExpConstructor) {
      let scope = node.parent;
      while (scope && !ts.isFunctionLike(scope) && !ts.isClassLike(scope)
        && !ts.isForStatement(scope) && !ts.isForOfStatement(scope)
        && !ts.isForInStatement(scope) && !ts.isWhileStatement(scope)
        && !ts.isDoStatement(scope)) scope = scope.parent;
      if (scope) {
        const pattern = node.getText(file);
        let flags = literal ? pattern.slice(pattern.lastIndexOf('/') + 1) : '';
        let after = 0;
        let resolved = literal;
        if (isRegExpConstructor && !symbolAt(node.expression) && node.arguments?.length && node.arguments.length <= 2) {
          const expression = staticValue(node.arguments[0]);
          const options = node.arguments[1] ? staticValue(node.arguments[1]) : { value: '', after: 0 };
          if (expression && typeof expression.value === 'string' && options && typeof options.value === 'string') {
            try {
              new RegExp(expression.value, options.value);
              flags = options.value;
              after = Math.max(expression.after, options.after);
              resolved = true;
            } catch { /* Invalid patterns must keep throwing at the original call site. */ }
          }
        }
        const parent = node.parent;
        let safe = safeUse(node, flags);
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          let boundary = parent.parent;
          while (boundary.parent && !ts.isFunctionLike(boundary)) boundary = boundary.parent;
          let references = 0;
          let allSafe = true;
          function checkReference(ref) {
            if (ts.isIdentifier(ref) && ref.text === parent.name.text && ref !== parent.name) {
              references++;
              if (!safeUse(ref, flags)) allSafe = false;
            }
            ts.forEachChild(ref, checkReference);
          }
          checkReference(boundary);
          safe = references > 0 && allSafe;
        }
        // Stateless patterns in local lookup tables and filter options are reusable.
        if (!STATEFUL_FLAGS.test(flags) && (ts.isArrayLiteralExpression(parent)
          || ts.isPropertyAssignment(parent))) safe = true;
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        (safe && resolved && !isolated(node) ? candidates : skipped).push({ node, pattern, line, after });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!candidates.length && !skipped.length) continue;
  report.push({ path, hoist: candidates.map(({ pattern, line }) => ({ pattern, line })),
    skipped: skipped.map(({ pattern, line }) => ({ pattern, line })) });
  if (!apply || !candidates.length) continue;
  const patterns = new Map();
  const edits = [];
  const dependencies = new Map();
  for (const { node, pattern, after } of candidates) {
    if (!patterns.has(pattern)) {
      const prefix = COMMON_NAMES.get(pattern) || `${nameFor(node)}_RE`;
      let index = 2;
      let name = prefix;
      while (identifiers.has(name)) name = `${prefix}_${index++}`;
      identifiers.add(name);
      patterns.set(pattern, name);
      dependencies.set(pattern, after);
    }
    edits.push({ start: node.getStart(file), end: node.end, text: patterns.get(pattern) });
  }
  let insert = 0;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)
      || (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression))) insert = statement.end;
    else break;
  }
  if (!insert && source.startsWith('#!')) insert = source.indexOf('\n');
  if (!insert || (source.startsWith('#!') && insert === source.indexOf('\n'))) {
    insert = file.statements[0]?.getStart(file) ?? insert;
  }
  const declarations = new Map();
  for (const [pattern, name] of patterns) {
    const position = Math.max(insert, dependencies.get(pattern));
    if (!declarations.has(position)) declarations.set(position, []);
    declarations.get(position).push(`const ${name} = ${pattern};`);
  }
  for (const [position, lines] of declarations) edits.push({ start: position, end: position,
    text: position === 0 ? lines.join('\n') + '\n\n' : '\n\n' + lines.join('\n') });
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  const parsed = ts.createSourceFile(path, result, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, file.parseDiagnostics.length, `${path}: new syntax errors`);
  let restored = result;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    const delta = edits.filter(other => other.start < edit.start).reduce((sum, other) => sum + other.text.length - (other.end - other.start), 0);
    const start = edit.start + delta;
    assert.equal(result.slice(start, start + edit.text.length), edit.text);
  }
  // Reversing the source edits must reproduce every original byte.
  const positioned = edits.map(edit => ({ ...edit, offset: edit.start
    + edits.filter(other => other.start < edit.start).reduce((sum, other) => sum + other.text.length - (other.end - other.start), 0) }));
  for (const edit of positioned.sort((a, b) => b.offset - a.offset)) {
    restored = restored.slice(0, edit.offset) + source.slice(edit.start, edit.end) + restored.slice(edit.offset + edit.text.length);
  }
  assert.equal(restored, source, `${path}: non-regex source changed`);
  writeFileSync(path, result);
}
const totals = report.reduce((total, item) => ({ files: total.files + 1,
  hoist: total.hoist + item.hoist.length, skipped: total.skipped + item.skipped.length }),
{ files: 0, hoist: 0, skipped: 0 });
if (process.argv.includes('--json')) console.log(JSON.stringify({ totals, report }, null, 2));
else console.log(JSON.stringify(totals));
