import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const componentDir = resolve(repoRoot, 'src/components');
const startupModulePaths = [
  'src/App.ts',
  'src/app/country-intel.ts',
  'src/app/data-loader.ts',
  'src/app/event-handlers.ts',
  'src/app/panel-layout.ts',
  'src/app/search-manager.ts',
].map((path) => resolve(repoRoot, path));
const viteConfigPath = resolve(repoRoot, 'vite.config.ts');
const viteConfigSource = readFileSync(viteConfigPath, 'utf8');
const viteConfigAst = ts.createSourceFile(
  viteConfigPath,
  viteConfigSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function findVariableDeclaration(ast, name) {
  let found = null;
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        found = declaration;
      }
    }
  }
  assert.ok(found, `Could not locate ${name}.`);
  return found;
}

function stringValue(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function extractStringArray(name) {
  const declaration = findVariableDeclaration(viteConfigAst, name);
  assert.ok(declaration.initializer && ts.isAsExpression(declaration.initializer), `${name} must use "as const".`);
  const expression = declaration.initializer.expression;
  assert.ok(ts.isArrayLiteralExpression(expression), `${name} must be an array literal.`);
  return expression.elements.map((element) => {
    assert.ok(ts.isStringLiteral(element), `${name} must contain only string literals.`);
    return element.text;
  });
}

function extractObjectMap(name) {
  const declaration = findVariableDeclaration(viteConfigAst, name);
  assert.ok(declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer), `${name} must be an object literal.`);
  const entries = new Map();
  for (const property of declaration.initializer.properties) {
    assert.ok(ts.isPropertyAssignment(property), `${name} must only contain property assignments.`);
    const key = propertyNameText(property.name);
    const value = stringValue(property.initializer);
    assert.ok(key, `${name} has an unsupported property key.`);
    assert.ok(value, `${name}.${key} must be a string literal.`);
    entries.set(key, value);
  }
  return entries;
}

function hasSpreadOfArray(name, spreadName) {
  const declaration = findVariableDeclaration(viteConfigAst, name);
  assert.ok(declaration.initializer && ts.isAsExpression(declaration.initializer), `${name} must use "as const".`);
  const expression = declaration.initializer.expression;
  assert.ok(ts.isArrayLiteralExpression(expression), `${name} must be an array literal.`);
  return expression.elements.some((element) => (
    ts.isSpreadElement(element)
    && ts.isIdentifier(element.expression)
    && element.expression.text === spreadName
  ));
}

function hasStringElement(name, value) {
  const declaration = findVariableDeclaration(viteConfigAst, name);
  assert.ok(declaration.initializer && ts.isAsExpression(declaration.initializer), `${name} must use "as const".`);
  const expression = declaration.initializer.expression;
  assert.ok(ts.isArrayLiteralExpression(expression), `${name} must be an array literal.`);
  return expression.elements.some((element) => ts.isStringLiteral(element) && element.text === value);
}

function hasCall(ast, calleeName) {
  let found = false;
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === calleeName
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

function hasTrueProperty(ast, propertyName) {
  let found = false;
  function visit(node) {
    if (
      ts.isPropertyAssignment(node)
      && propertyNameText(node.name) === propertyName
      && node.initializer.kind === ts.SyntaxKind.TrueKeyword
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

function hasLazyHtmlModulePreloadFilter(ast) {
  let found = false;
  function visit(node) {
    if (
      ts.isPropertyAssignment(node)
      && propertyNameText(node.name) === 'resolveDependencies'
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      let hasHtmlHostGuard = false;
      let hasDepsFilter = false;
      let hasLazyChunkTest = false;
      function inspect(bodyNode) {
        if (
          ts.isBinaryExpression(bodyNode)
          && ts.isIdentifier(bodyNode.left)
          && bodyNode.left.text === 'hostType'
          && bodyNode.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
          && stringValue(bodyNode.right) === 'html'
        ) {
          hasHtmlHostGuard = true;
        }
        if (
          ts.isCallExpression(bodyNode)
          && ts.isPropertyAccessExpression(bodyNode.expression)
          && bodyNode.expression.name.text === 'filter'
          && ts.isIdentifier(bodyNode.expression.expression)
          && bodyNode.expression.expression.text === 'deps'
        ) {
          hasDepsFilter = true;
        }
        if (
          ts.isCallExpression(bodyNode)
          && ts.isPropertyAccessExpression(bodyNode.expression)
          && bodyNode.expression.name.text === 'test'
          && ts.isIdentifier(bodyNode.expression.expression)
          && bodyNode.expression.expression.text === 'LAZY_HTML_PRELOAD_RE'
        ) {
          hasLazyChunkTest = true;
        }
        ts.forEachChild(bodyNode, inspect);
      }
      inspect(node.initializer.body);
      if (hasHtmlHostGuard && hasDepsFilter && hasLazyChunkTest) found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

function returnedStringLiterals(ast) {
  const values = [];
  function visit(node) {
    if (ts.isReturnStatement(node) && node.expression) {
      const value = stringValue(node.expression);
      if (value) values.push(value);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return values;
}

function panelKeyForFile(fileName) {
  const baseName = fileName.replace(/\.ts$/, '');
  if (baseName === 'Panel') return null;
  if (baseName === 'CountryBriefPage' || baseName === 'RegionalIntelligenceBoard') return baseName;
  if (baseName.endsWith('Panel')) return baseName.slice(0, -'Panel'.length);
  return null;
}

function sourceFileForComponent(fileName) {
  const filePath = resolve(componentDir, fileName);
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function isGeneratedServiceClientNew(node) {
  return (
    ts.isNewExpression(node)
    && ts.isIdentifier(node.expression)
    && /ServiceClient$/.test(node.expression.text)
  );
}

function lineForPosition(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function topLevelGeneratedClientOffenders(fileName) {
  const ast = sourceFileForComponent(fileName);
  const offenders = [];
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && isGeneratedServiceClientNew(declaration.initializer)) {
          offenders.push(`${fileName}:${lineForPosition(ast, declaration.initializer.getStart(ast))}`);
        }
      }
    }
    if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        const isStatic = member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
        if (
          isStatic
          && ts.isPropertyDeclaration(member)
          && member.initializer
          && isGeneratedServiceClientNew(member.initializer)
        ) {
          offenders.push(`${fileName}:${lineForPosition(ast, member.initializer.getStart(ast))}`);
        }
      }
    }
  }
  return offenders;
}

function astForPath(filePath) {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function panelKeyForSpecifier(specifier) {
  if (!specifier.startsWith('@/components/')) return null;
  const baseName = specifier.slice('@/components/'.length).split('/').pop();
  if (!baseName) return null;
  return panelKeyForFile(`${baseName}.ts`);
}

function startupPanelValueImportOffenders(panelCluster) {
  const offenders = [];
  for (const filePath of startupModulePaths) {
    const ast = astForPath(filePath);
    const relativePath = filePath.slice(repoRoot.length + 1);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const importClause = statement.importClause;
      if (!importClause || importClause.isTypeOnly) continue;
      const specifier = stringValue(statement.moduleSpecifier);
      if (!specifier) continue;
      if (specifier === '@/components') {
        offenders.push(`${relativePath}:${lineForPosition(ast, statement.getStart(ast))} imports the component barrel`);
        continue;
      }
      const panelKey = panelKeyForSpecifier(specifier);
      if (panelKey && panelCluster.has(panelKey)) {
        offenders.push(`${relativePath}:${lineForPosition(ast, statement.getStart(ast))} imports ${specifier}`);
      }
    }
  }
  return offenders;
}

function builtDashboardLazyPreloadOffenders() {
  const htmlPath = resolve(repoRoot, 'dist/dashboard.html');
  if (!existsSync(htmlPath)) return null;
  const html = readFileSync(htmlPath, 'utf8');
  const preloadHrefs = [...html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["'][^>]*>/g)]
    .map((match) => match[1]);
  return preloadHrefs.filter((href) => /\/assets\/(?:panels-[a-z]+|panel-support|UnifiedSettings|settings-window|checkout)-[A-Za-z0-9_-]+\.js$/.test(href));
}

// When a build is present, confirm each secondary flow actually emitted its own
// lazy chunk. Without this, builtDashboardLazyPreloadOffenders passes vacuously
// if the split regresses and a module folds back into the eager entry (the
// #4382 onlyExplicitManualChunks failure mode): a chunk that no longer exists
// can never appear in the modulepreload list.
function builtSecondaryLazyChunksMissing() {
  const assetsDir = resolve(repoRoot, 'dist/assets');
  if (!existsSync(assetsDir)) return null;
  const files = readdirSync(assetsDir);
  return ['UnifiedSettings', 'settings-window', 'checkout'].filter(
    (name) => !files.some((file) => new RegExp(`^${name}-[A-Za-z0-9_-]+\\.js$`).test(file)),
  );
}

function startupSecondaryFlowImportOffenders() {
  const blockedSpecifiers = new Set([
    '@/components/UnifiedSettings',
  ]);
  const offenders = [];
  for (const filePath of startupModulePaths) {
    const ast = astForPath(filePath);
    const relativePath = filePath.slice(repoRoot.length + 1);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const importClause = statement.importClause;
      if (!importClause || importClause.isTypeOnly) continue;
      const specifier = stringValue(statement.moduleSpecifier);
      if (specifier && blockedSpecifiers.has(specifier)) {
        offenders.push(`${relativePath}:${lineForPosition(ast, statement.getStart(ast))} imports ${specifier}`);
      }
    }
  }
  return offenders;
}

function checkoutSdkValueImportOffenders() {
  const filePath = resolve(repoRoot, 'src/services/checkout.ts');
  const ast = astForPath(filePath);
  const offenders = [];
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const importClause = statement.importClause;
    if (!importClause || importClause.isTypeOnly) continue;
    const specifier = stringValue(statement.moduleSpecifier);
    if (specifier === 'dodopayments-checkout') {
      offenders.push(`src/services/checkout.ts:${lineForPosition(ast, statement.getStart(ast))} imports ${specifier}`);
    }
  }
  return offenders;
}

describe('panel cluster chunk guardrails', () => {
  it('keeps all panel component files assigned to documented domain chunks', () => {
    const panelCluster = extractObjectMap('PANEL_CLUSTER');
    const panelSupportCluster = extractObjectMap('PANEL_SUPPORT_CLUSTER');
    const panelChunkNames = new Set([
      ...extractStringArray('PANEL_CHUNK_NAMES'),
      ...extractStringArray('PANEL_SUPPORT_CHUNK_NAMES'),
    ]);
    const panelFiles = readdirSync(componentDir)
      .filter(file => file.endsWith('.ts'))
      .map(file => ({ file, key: panelKeyForFile(file) }))
      .filter(({ key }) => key !== null);

    const missing = panelFiles
      .filter(({ key }) => !panelCluster.has(key) && !panelSupportCluster.has(key))
      .map(({ file, key }) => `${file} (${key})`);
    assert.deepEqual(missing, [], 'Every panel component file must be assigned in PANEL_CLUSTER or PANEL_SUPPORT_CLUSTER.');

    const configuredKeys = [...panelCluster.keys(), ...panelSupportCluster.keys()];
    const stale = configuredKeys
      .filter(key => key !== 'CountryBriefPage' && key !== 'RegionalIntelligenceBoard')
      .filter(key => !existsSync(resolve(componentDir, `${key}Panel.ts`)));
    assert.deepEqual(stale, [], 'Panel chunk maps contain entries for missing panel files.');

    const invalidChunks = [...panelCluster.entries(), ...panelSupportCluster.entries()]
      .filter(([, chunk]) => !panelChunkNames.has(chunk))
      .map(([key, chunk]) => `${key}: ${chunk}`);
    assert.deepEqual(invalidChunks, [], 'Panel chunk maps must only use documented chunk-name entries.');
  });

  it('routes panel modules through PANEL_CLUSTER instead of a monolithic panels chunk', () => {
    assert.equal(
      hasCall(viteConfigAst, 'panelChunkForComponentId'),
      true,
      'manualChunks must classify panel files through panelChunkForComponentId().',
    );
    assert.equal(
      returnedStringLiterals(viteConfigAst).includes('panels'),
      false,
      'manualChunks must not return the old monolithic panels chunk.',
    );
    assert.equal(
      hasTrueProperty(viteConfigAst, 'onlyExplicitManualChunks'),
      true,
      'Rollup must keep manual chunk dependencies explicit so app-shared modules do not make main import panel chunks. (DeckGLMap is co-located into the deck-stack chunk to avoid the circular-chunk TDZ this flag otherwise caused on the WebGL map.)',
    );
  });

  it('keeps panel domain chunks out of entry HTML modulepreloads', () => {
    assert.equal(
      hasSpreadOfArray('LAZY_HTML_PRELOAD_CHUNKS', 'PANEL_CHUNK_NAMES'),
      true,
      'PANEL_CHUNK_NAMES must feed the HTML preload exclusion list.',
    );
    assert.equal(
      hasSpreadOfArray('LAZY_HTML_PRELOAD_CHUNKS', 'PANEL_SUPPORT_CHUNK_NAMES'),
      true,
      'PANEL_SUPPORT_CHUNK_NAMES must feed the HTML preload exclusion list.',
    );
    assert.equal(
      hasLazyHtmlModulePreloadFilter(viteConfigAst),
      true,
      'modulePreload.resolveDependencies must filter HTML deps through LAZY_HTML_PRELOAD_RE so panel chunks stay out of eager entry preloads even when this test runs without dist/.',
    );
    const builtOffenders = builtDashboardLazyPreloadOffenders();
    if (builtOffenders !== null) {
      assert.deepEqual(
        builtOffenders,
        [],
        'Built dashboard.html must not modulepreload panel domain/support chunks.',
      );
    }
  });

  it('keeps generated service clients lazy in component modules', () => {
    const offenders = readdirSync(componentDir)
      .filter(file => file.endsWith('.ts'))
      .flatMap(topLevelGeneratedClientOffenders);

    assert.deepEqual(
      offenders,
      [],
      'Generated ServiceClient instances in component modules must be created through lazy getters, not at module evaluation.',
    );
  });

  it('keeps startup modules from value-importing clustered panel chunks', () => {
    const panelCluster = new Map([
      ...extractObjectMap('PANEL_CLUSTER'),
      ...extractObjectMap('PANEL_SUPPORT_CLUSTER'),
    ]);

    assert.deepEqual(
      startupPanelValueImportOffenders(panelCluster),
      [],
      'Startup modules must use dynamic imports or type-only imports for panel chunks.',
    );
  });

  it('keeps secondary settings and checkout chunks off the eager startup path', () => {
    for (const chunkName of ['UnifiedSettings', 'settings-window', 'checkout']) {
      assert.equal(
        hasStringElement('LAZY_HTML_PRELOAD_CHUNKS', chunkName),
        true,
        `${chunkName} must stay in the HTML preload exclusion list.`,
      );
    }
    assert.deepEqual(
      startupSecondaryFlowImportOffenders(),
      [],
      'Startup modules must use dynamic imports for the UnifiedSettings modal.',
    );
    assert.deepEqual(
      checkoutSdkValueImportOffenders(),
      [],
      'Checkout must dynamically import dodopayments-checkout so the SDK stays out of main.',
    );
    const missingLazyChunks = builtSecondaryLazyChunksMissing();
    if (missingLazyChunks) {
      assert.deepEqual(
        missingLazyChunks,
        [],
        `Secondary flows must build into their own lazy chunks (split regressed): ${missingLazyChunks.join(', ')}`,
      );
    }
  });
});
