#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const CLASSIFICATIONS = new Set([
  'exact',
  'derived',
  'parity',
  'retirement',
  'named-member',
  'floor',
]);
const INVENTORY_PRESERVING_METHODS = new Set([
  'entries',
  'filter',
  'keys',
  'map',
  'reduce',
  'slice',
  'sort',
  'values',
]);

/**
 * Closed-world register of extensible inventory count contracts.
 *
 * `selectors` identify the inventory values in the audited test surface. They
 * are deliberately local to one file: a generic name such as `registry` is
 * safe here because it cannot taint an unrelated test. Adding a new audited
 * surface requires a registry row; review must keep the register complete.
 */
export const INVENTORY_CONTRACTS = Object.freeze([
  contract('source-attribution-totals', 'source-attribution manifest entries and explicit retirement records', ['retirement', 'parity'], 'replace', 'Aggregate source totals are derived; explicit retirement and exact identity parity protect deletion.', [
    surface('tests/source-attribution.test.mjs', ['stats.activeHosts', 'stats.providerCount', 'stats.observedHosts']),
  ]),
  contract('panel-discoverability', 'PANEL_REGISTRY, panel commands, categories, scheduleRefresh and primeTask call sites', ['derived', 'parity'], 'replace', 'Structural set extraction and containment replace parser-size tripwires.', [
    surface('tests/panel-config-guardrails.test.mjs', ['allRegistryPanelIds', 'panelCommandKeywordCounts', 'categoryMappedPanelIds', 'scheduled', 'primed']),
    surface('tests/news-panel-key-reachability.test.mts', ['feedCategories', 'catalogPanelKeys', 'registrations']),
  ]),
  contract('mcp-output-schema-tools', 'TOOL_REGISTRY and the tools/list response', ['parity'], 'replace', 'Exact tool/schema set parity makes arbitrary tool floors redundant.', [
    surface('tests/mcp-output-schema-coverage.test.mjs', ['registry', 'tools']),
  ]),
  contract('mcp-tool-annotations', 'TOOL_REGISTRY and the tools/list response', ['parity'], 'replace', 'Every discovered tool must have matching protocol annotations.', [
    surface('tests/mcp-tool-annotations.test.mjs', ['registry', 'tools']),
  ]),
  contract('mcp-protocol-tools', 'the MCP tools/list response', ['parity'], 'replace', 'Protocol assertions cover the complete returned tool set.', [
    surface('tests/mcp-protocol-conformance.test.mjs', ['step1bListBody.result.tools', 'step3Body.result.tools']),
    surface('tests/mcp.test.mjs', ['body.result.tools', 'TOOL_REGISTRY']),
    surface('tests/mcp-resources.test.mjs', ['uiUris', 'listedUiUris']),
  ]),
  contract('llms-mcp-tools', 'api/mcp/registry tool names and public discovery citations', ['named-member', 'parity'], 'replace', 'Registry-to-citation parity plus named critical tools replaces an arbitrary floor.', [
    surface('tests/llms-txt-mcp-tools.test.mjs', ['registry']),
  ]),
  contract('openapi-server-specs', 'generated per-service OpenAPI JSON/YAML files', ['parity'], 'replace', 'Exact JSON/YAML sibling and per-spec server coverage protects the full discovered universe.', [
    surface('tests/openapi-servers-contract.test.mjs', ['serviceJsonSpecs', 'serviceYamlSpecs']),
  ]),
  contract('openapi-security-specs', 'generated per-service OpenAPI specifications', ['parity'], 'replace', 'Every discovered service and operation receives the security contract.', [
    surface('tests/openapi-security-contract.test.mjs', ['serviceSpecs']),
  ]),
  contract('openapi-jmespath-specs', 'generated per-service OpenAPI specifications and their GET operations', ['parity'], 'replace', 'Exact sibling and operation coverage replaces aggregate spec and operation totals.', [
    surface('tests/openapi-jmespath-contract.test.mjs', ['serviceJsonSpecs', 'serviceYamlSpecs', 'jsonServiceGetIds', 'yamlServiceGetIds', 'bundleGetIds']),
  ]),
  contract('openapi-rate-limit-operations', 'all operations discovered from generated service OpenAPI specifications', ['parity'], 'replace', 'Classified-operation coverage and bundle parity replace operation floors.', [
    surface('tests/openapi-rate-limit-errors-contract.test.mjs', ['serviceJson', 'serviceYaml', 'jsonServiceOperationIds', 'yamlServiceOperationIds', 'bundleOperationIds']),
  ]),
  contract('route-cache-tiers', 'generated GET routes and RPC_CACHE_TIER keys', ['parity'], 'replace', 'Exact route-to-tier set parity already detects additions and removals.', [
    surface('tests/route-cache-tier.test.mjs', ['getRoutes', 'tierKeys']),
  ]),
  contract('feed-client-server-catalogs', 'client and server feed catalogs', ['parity'], 'replace', 'Exact mirrored feed identity parity replaces arbitrary catalog-size sentinels.', [
    surface('tests/feeds-client-server-parity.test.mjs', ['client', 'server', 'clientNameCount', 'serverNameCount']),
    surface('tests/completeness-measurement.test.mjs', ['extractServerFeeds']),
    surface('tests/publisher-families.test.mjs', ['FEED_LABELS', 'withHosts']),
  ]),
  contract('regional-feed-promises', 'regional feed catalogs and default-enable policy', ['named-member', 'parity'], 'keep', 'Named regional members and their metadata express the coverage promise without a redundant numeric floor.', [
    surface('tests/feed-catalog-drift.test.mts', ['CANADA_CATALOG', 'nordicBeyondSweden']),
  ]),
  contract('feed-source-provenance', 'feed names and their provenance declarations', ['parity'], 'replace', 'Exact discovered feed-to-provenance parity replaces the name-count floor.', [
    surface('tests/source-provenance.test.mts', ['names', 'explicitUnknownDimensions']),
  ]),
  contract('locale-key-completeness', 'English locale keys and every translated locale key set', ['floor', 'parity'], 'keep', 'The English anti-collapse floor is a named completeness promise; locale key sets remain exact.', [
    surface('tests/locale-completeness.test.mjs', ['enKeys', 'localeKeys']),
  ]),
  contract('food-stocks-locales', 'the authoritative locale file registry and food-stocks translations', ['parity'], 'replace', 'Exact per-locale translation coverage replaces a locale-count floor.', [
    surface('tests/food-stocks-registration.test.mjs', ['locales']),
  ]),
  contract('market-tape-locales', 'the authoritative locale file registry and market-tape translations', ['parity'], 'replace', 'Exact per-locale translation coverage replaces a locale-count floor.', [
    surface('tests/market-tape-claim.test.mts', ['localeFiles']),
  ]),
  contract('product-catalog-inventories', 'generated product IDs, tiers and bundle highlights', ['named-member', 'parity'], 'replace', 'Exact catalog-to-generated parity and named sellable products replace arbitrary floors.', [
    surface('tests/product-catalog-freshness.test.mjs', ['generatedProductIds', 'tiersJson', 'bundleHighlights']),
  ]),
  contract('agent-skills-index', 'discovered agent skills and generated skill index', ['parity'], 'replace', 'Exact discovered-skill parity replaces tranche-specific size floors.', [
    surface('tests/agent-skills-index.test.mjs', ['index.skills']),
  ]),
  contract('mcp-presets', 'the MCP preset registry', ['named-member', 'parity'], 'replace', 'Exact preset coverage and named required presets replace the preset floor.', [
    surface('tests/mcp-presets.test.mjs', ['presets']),
  ]),
  contract('route-explorer-countries', 'the authoritative country registry used by route explorer pickers', ['parity'], 'replace', 'Exact authoritative country coverage replaces the country floor.', [
    surface('tests/route-explorer-pickers.test.mts', ['getAllCountries']),
  ]),
  contract('notification-country-registry', 'the shared country-name to ISO-2 registry', ['parity'], 'replace', 'Exact authoritative country coverage replaces the parser floor.', [
    surface('tests/notification-relay-country-scope-5359.test.mjs', ['names']),
  ]),
  contract('iso2-country-registry', 'the closed ISO alpha-2 registry and its client mirror', ['exact', 'parity'], 'keep', 'ISO alpha-2 is a closed external standard and the client/server sets must remain identical.', [
    surface('convex/__tests__/followed-countries-mutations.test.ts', ['_ISO2_REGISTRY_FOR_TESTS']),
  ]),
  contract('public-fixed-algorithm-claims', 'versioned CII country membership and the closed CRI public rankable universe', ['exact', 'named-member'], 'keep', 'Fixed algorithm universes remain exact while platform inventories on the same surfaces use semantic or named-set wording.', [
    surface('tests/cii-docs-drift.test.mts', ['llmsBrief', 'llmsFull', 'pressKit', 'communityGuide', 'publicHome', 'agentView.capabilities']),
  ]),
]);

function contract(id, authoritativeUniverse, classifications, migrationAction, reason, surfaces) {
  return { id, authoritativeUniverse, classifications, migrationAction, reason, surfaces };
}

function surface(path, selectors) {
  return { path, selectors };
}

export function validateInventoryContractRegistry(contracts = INVENTORY_CONTRACTS) {
  const violations = [];
  const ids = new Set();
  for (const entry of contracts) {
    if (!entry?.id || ids.has(entry.id)) violations.push(problem(entry?.id ?? '<missing>', '', 'invalid-registry', 'contract IDs must be present and unique'));
    ids.add(entry?.id);
    if (!entry?.authoritativeUniverse?.trim()) violations.push(problem(entry?.id, '', 'invalid-registry', 'authoritativeUniverse is required'));
    if (!entry?.reason?.trim()) violations.push(problem(entry?.id, '', 'invalid-registry', 'reason is required'));
    if (!['keep', 'replace'].includes(entry?.migrationAction)) violations.push(problem(entry?.id, '', 'invalid-registry', 'migrationAction must be keep or replace'));
    if (!Array.isArray(entry?.classifications) || entry.classifications.length === 0) {
      violations.push(problem(entry?.id, '', 'invalid-registry', 'at least one classification is required'));
    } else {
      for (const classification of entry.classifications) {
        if (!CLASSIFICATIONS.has(classification)) violations.push(problem(entry?.id, '', 'invalid-registry', `unsupported classification: ${classification}`));
      }
    }
    if (!Array.isArray(entry?.surfaces) || entry.surfaces.length === 0) {
      violations.push(problem(entry?.id, '', 'invalid-registry', 'at least one audited surface is required'));
    }
    for (const auditedSurface of entry?.surfaces ?? []) {
      if (!auditedSurface?.path || !Array.isArray(auditedSurface?.selectors) || auditedSurface.selectors.length === 0) {
        violations.push(problem(entry?.id, auditedSurface?.path ?? '', 'invalid-registry', 'each surface needs a path and selectors'));
      }
    }
  }
  return violations;
}

export function auditInventoryCountContracts({
  rootDir = process.cwd(),
  contracts = INVENTORY_CONTRACTS,
  readFile = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const violations = [...validateInventoryContractRegistry(contracts)];
  const scannedSurfaces = [];

  for (const entry of contracts) {
    for (const auditedSurface of entry.surfaces ?? []) {
      const absolutePath = resolve(rootDir, auditedSurface.path);
      if (!existsSync(absolutePath)) {
        violations.push(problem(entry.id, auditedSurface.path, 'missing-surface', 'registered audit surface does not exist'));
        continue;
      }

      let sourceText;
      try {
        sourceText = readFile(absolutePath);
      } catch (error) {
        violations.push(problem(entry.id, auditedSurface.path, 'unreadable-surface', error instanceof Error ? error.message : String(error)));
        continue;
      }

      const result = auditSurfaceSource(sourceText, auditedSurface.path, entry, auditedSurface);
      violations.push(...result.violations);
      scannedSurfaces.push({ contractId: entry.id, path: auditedSurface.path, references: result.references });
    }
  }

  return { violations, scannedSurfaces };
}

function auditSurfaceSource(sourceText, path, entry, auditedSurface) {
  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(path),
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    return {
      references: 0,
      violations: sourceFile.parseDiagnostics.map((diagnostic) => {
        const at = diagnostic.start === undefined ? undefined : sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
        return problem(entry.id, path, 'parse-error', ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), at ? at.line + 1 : undefined);
      }),
    };
  }

  const selectorSet = new Set(auditedSurface.selectors);
  const constantBindings = new Map();
  const constantDeclarations = [];
  const taintedNames = new Map();
  const taintedParameters = new Set();
  const constantParameters = new Map();
  const functionDeclarations = new Map();
  const inventoryPreservingCalls = new Set();
  let references = 0;

  walk(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      constantDeclarations.push(...numericVariableBindingDeclarations(node.name, node.initializer));
      collectVariableFunctionDeclarations(node, functionDeclarations);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      functionDeclarations.set(node.name.text, node);
    }
    if (ts.isMethodDeclaration(node)) collectMethodDeclaration(node, functionDeclarations);
    if (matchesSelector(node, selectorSet)) references++;
  });

  let constantsChanged = true;
  while (constantsChanged) {
    constantsChanged = false;
    for (const [path, initializer] of constantDeclarations) {
      const constant = evaluateNumericDeclaration(initializer, constantBindings);
      if (constant !== undefined && !constantBindings.has(path)) {
        constantBindings.set(path, constant);
        constantsChanged = true;
      }
    }
  }

  if (references === 0) {
    return {
      references,
      violations: [problem(entry.id, path, 'empty-extraction', `none of the registered selectors were found: ${auditedSurface.selectors.join(', ')}`)],
    };
  }

  // Resolve aliases and helper parameters to a fixed point. This is local,
  // intentionally small data flow: it catches count aliases and helper calls
  // without pretending to be a whole-program type checker.
  let changed = true;
  while (changed) {
    changed = false;
    walk(sourceFile, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        for (const name of taintedBindingNames(
          node.name,
          node.initializer,
          selectorSet,
          taintedNames,
          taintedParameters,
          inventoryPreservingCalls,
        )) {
          if (!hasTaintedName(taintedNames, name, node)) {
            addTaintedName(taintedNames, name, node);
            changed = true;
          }
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name && node.body && isTainted(node.body, selectorSet, taintedNames, taintedParameters)) {
        if (!hasTaintedName(taintedNames, node.name.text, node.parent)) {
          addTaintedName(taintedNames, node.name.text, node.parent);
          changed = true;
        }
      }
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        && isTainted(node.initializer.body, selectorSet, taintedNames, taintedParameters)
      ) {
        if (!hasTaintedName(taintedNames, node.name.text, node)) {
          addTaintedName(taintedNames, node.name.text, node);
          changed = true;
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isTainted(node.right, selectorSet, taintedNames, taintedParameters)) {
        if (!hasTaintedName(taintedNames, node.left.text, node.left)) {
          addTaintedName(taintedNames, node.left.text, node.left);
          changed = true;
        }
      }
      if (ts.isCallExpression(node)) {
        const declaration = functionDeclarations.get(callableExpressionPath(node.expression));
        if (!declaration) return;
        node.arguments.forEach((argument, index) => {
          const parameter = declaration.parameters[index];
          if (parameter && isTainted(argument, selectorSet, taintedNames, taintedParameters) && !taintedParameters.has(parameter)) {
            taintedParameters.add(parameter);
            changed = true;
          }
          const constant = evaluateNumericConstant(argument, constantBindings, constantParameters);
          if (parameter && constant !== undefined && addConstantParameter(constantParameters, parameter, constant)) {
            changed = true;
          }
        });
        if (functionReturnsTainted(declaration, selectorSet, taintedNames, taintedParameters)
          && !inventoryPreservingCalls.has(node)) {
          inventoryPreservingCalls.add(node);
          changed = true;
        }
      }
    });
  }

  const violations = [];
  const seen = new Set();
  walk(sourceFile, (node) => {
    const candidate = numericContractCandidate(
      node,
      selectorSet,
      taintedNames,
      taintedParameters,
      constantBindings,
      constantParameters,
      inventoryPreservingCalls,
    );
    if (!candidate || candidate.semanticNonEmpty) return;
    const key = `${candidate.node.pos}:${candidate.node.end}`;
    if (seen.has(key)) return;
    seen.add(key);

    const line = sourceFile.getLineAndCharacterOfPosition(candidate.node.getStart(sourceFile)).line + 1;
    const marker = markerNear(sourceText, line);
    const markerProblem = validateMarker(marker, entry, candidate.kind);
    if (markerProblem) {
      violations.push(problem(entry.id, path, markerProblem.code, `${markerProblem.message}; found ${candidate.kind} numeric contract ${candidate.value}`, line));
    }
  });

  return { references, violations };
}

function taintedBindingNames(name, initializer, selectors, taintedNames, taintedParameters, inventoryPreservingCalls) {
  if (ts.isIdentifier(name)) {
    return propagatesInventory(initializer, selectors, taintedNames, taintedParameters, inventoryPreservingCalls)
      || objectSpreadPropagatesInventory(initializer, selectors, taintedNames, taintedParameters)
      ? [name.text]
      : [];
  }
  if (ts.isArrayBindingPattern(name)) {
    const names = [];
    name.elements.forEach((element, index) => {
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) return;
      const source = ts.isArrayLiteralExpression(initializer) ? initializer.elements[index] : initializer;
      if (source && propagatesInventory(source, selectors, taintedNames, taintedParameters, inventoryPreservingCalls)) {
        names.push(element.name.text);
      }
    });
    return names;
  }
  if (!ts.isObjectBindingPattern(name)) return [];
  const basePath = expressionPath(initializer);
  const names = [];
  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const property = element.propertyName ?? element.name;
    const propertyText = ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : null;
    if (!propertyText) continue;
    const selectorPath = basePath ? `${basePath}.${propertyText}` : null;
    if ((selectorPath && selectors.has(selectorPath)) || isTainted(initializer, selectors, taintedNames, taintedParameters)) {
      names.push(element.name.text);
    }
  }
  return names;
}

function objectSpreadPropagatesInventory(initializer, selectors, taintedNames, taintedParameters) {
  if (!ts.isObjectLiteralExpression(initializer)) return false;
  return initializer.properties.some((property) => {
    if (!ts.isSpreadAssignment(property)) return false;
    if (isTainted(property.expression, selectors, taintedNames, taintedParameters)) return true;
    const spreadPath = expressionPath(property.expression);
    return spreadPath !== null
      && [...selectors].some((selector) => selector === spreadPath || selector.startsWith(`${spreadPath}.`));
  });
}

function numericContractCandidate(node, selectors, taintedNames, taintedParameters, constants, constantParameters, inventoryPreservingCalls) {
  if (ts.isBinaryExpression(node) && isComparison(node.operatorToken.kind)) {
    if (!isAssertedValue(node)) return null;
    const leftTainted = isInventoryCountValue(node.left, selectors, taintedNames, taintedParameters, inventoryPreservingCalls);
    const rightTainted = isInventoryCountValue(node.right, selectors, taintedNames, taintedParameters, inventoryPreservingCalls);
    const leftConstant = evaluateNumericConstant(node.left, constants, constantParameters);
    const rightConstant = evaluateNumericConstant(node.right, constants, constantParameters);
    if (leftTainted && rightConstant !== undefined) {
      return {
        node,
        value: rightConstant,
        kind: comparisonKind(node.operatorToken.kind),
        semanticNonEmpty: rightConstant === 0 && node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken,
      };
    }
    if (rightTainted && leftConstant !== undefined) {
      return {
        node,
        value: leftConstant,
        kind: comparisonKind(node.operatorToken.kind),
        semanticNonEmpty: leftConstant === 0 && node.operatorToken.kind === ts.SyntaxKind.LessThanToken,
      };
    }
  }

  if (ts.isCallExpression(node) && assertionLike(node.expression)) {
    if (negativeAssertionLike(node.expression)) return null;
    const taintedArguments = node.arguments.some((argument) => isTainted(argument, selectors, taintedNames, taintedParameters));
    const taintedCallee = isTainted(node.expression, selectors, taintedNames, taintedParameters);
    if (!taintedArguments && !taintedCallee) return null;
    for (const argument of node.arguments) {
      const constant = evaluateNumericConstant(argument, constants, constantParameters);
      if (constant !== undefined) return { node, value: constant, kind: 'exact' };
    }
    const embedded = embeddedNumericLiteral(assertionContractNodes(node));
    if (embedded !== undefined) return { node, value: embedded, kind: 'exact' };
  }
  return null;
}

function isInventoryCountValue(node, selectors, taintedNames, taintedParameters, inventoryPreservingCalls) {
  if (!isTainted(node, selectors, taintedNames, taintedParameters)) return false;
  return !ts.isCallExpression(node)
    || propagatesInventory(node, selectors, taintedNames, taintedParameters, inventoryPreservingCalls);
}

function isTainted(node, selectors, taintedNames, taintedParameters) {
  if (!node) return false;
  if (matchesSelector(node, selectors)) return true;
  if (ts.isIdentifier(node) && (hasTaintedName(taintedNames, node.text, node) || isTaintedParameterReference(node, taintedParameters))) return true;
  if (ts.isParameter(node) && taintedParameters.has(node)) return true;
  let found = false;
  node.forEachChild((child) => {
    if (!found && isTainted(child, selectors, taintedNames, taintedParameters)) found = true;
  });
  return found;
}

function addTaintedName(taintedNames, name, node) {
  const scope = lexicalScope(node);
  const names = taintedNames.get(scope) ?? new Set();
  names.add(name);
  taintedNames.set(scope, names);
}

function hasTaintedName(taintedNames, name, node) {
  let scope = lexicalScope(node);
  while (scope) {
    if (taintedNames.get(scope)?.has(name)) return true;
    scope = enclosingLexicalScope(scope.parent);
  }
  return false;
}

function lexicalScope(node) {
  let current = node;
  while (current.parent) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return current;
}

function enclosingLexicalScope(node) {
  let current = node;
  while (current) {
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return null;
}

function propagatesInventory(node, selectors, taintedNames, taintedParameters, inventoryPreservingCalls = new Set()) {
  if (!isTainted(node, selectors, taintedNames, taintedParameters)) return false;
  if (!ts.isCallExpression(node)) return true;
  if (inventoryPreservingCalls.has(node)) return true;
  if (matchesSelector(node.expression, selectors)) return true;
  if (ts.isIdentifier(node.expression) && hasTaintedName(taintedNames, node.expression.text, node.expression)) return true;
  if (ts.isIdentifier(node.expression) && ['BigInt', 'Number', 'parseFloat', 'parseInt'].includes(node.expression.text)) return true;
  if (ts.isPropertyAccessExpression(node.expression)) {
    return INVENTORY_PRESERVING_METHODS.has(node.expression.name.text)
      || (ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'Math');
  }
  return false;
}

function isTaintedParameterReference(identifier, taintedParameters) {
  let current = identifier.parent;
  while (current) {
    if (ts.isFunctionLike(current)) {
      return current.parameters.some((parameter) =>
        taintedParameters.has(parameter) && ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text);
    }
    current = current.parent;
  }
  return false;
}

function isAssertedValue(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent) && assertionLike(parent.expression)) {
      if (parent.arguments[0] === current) return true;
      return false;
    }
    if (ts.isFunctionLike(parent) || ts.isStatement(parent)) return false;
    current = parent;
  }
  return false;
}

function matchesSelector(node, selectors) {
  if (ts.isIdentifier(node) && selectors.has(node.text)) return true;
  if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
    const path = expressionPath(node);
    if (path && selectors.has(path)) return true;
  }
  return false;
}

function expressionPath(node) {
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const left = expressionPath(node.expression);
    return left ? `${left}.${node.name.text}` : null;
  }
  if (ts.isElementAccessExpression(node)
    && (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))) {
    const left = expressionPath(node.expression);
    return left ? `${left}.${node.argumentExpression.text}` : null;
  }
  return null;
}

function callableExpressionPath(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
    current = current.expression;
  }
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === 'bind'
  ) {
    return callableExpressionPath(current.expression.expression);
  }
  return expressionPath(current);
}

function collectVariableFunctionDeclarations(node, declarations) {
  if (!ts.isIdentifier(node.name) || !node.initializer) return;
  if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
    declarations.set(node.name.text, node.initializer);
    return;
  }
  if (ts.isObjectLiteralExpression(node.initializer)) {
    collectObjectFunctionDeclarations(node.name.text, node.initializer, declarations);
  }
}

function collectObjectFunctionDeclarations(basePath, object, declarations) {
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) continue;
    const name = propertyNameText(property.name);
    if (name === null) continue;
    const path = `${basePath}.${name}`;
    if (ts.isMethodDeclaration(property)) {
      declarations.set(path, property);
    } else if (ts.isPropertyAssignment(property)) {
      if (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)) {
        declarations.set(path, property.initializer);
      } else if (ts.isObjectLiteralExpression(property.initializer)) {
        collectObjectFunctionDeclarations(path, property.initializer, declarations);
      }
    }
  }
}

function collectMethodDeclaration(node, declarations) {
  const methodName = propertyNameText(node.name);
  if (methodName === null) return;
  let owner = node.parent;
  while (owner && !ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) owner = owner.parent;
  if (!owner) return;
  const isStatic = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
  if (isStatic && owner.name) declarations.set(`${owner.name.text}.${methodName}`, node);
  else declarations.set(`this.${methodName}`, node);
}

function functionReturnsTainted(declaration, selectors, taintedNames, taintedParameters) {
  if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)) {
    return isTainted(declaration.body, selectors, taintedNames, taintedParameters);
  }
  let found = false;
  walk(declaration.body, (node) => {
    if (!found && ts.isReturnStatement(node) && node.expression) {
      found = isTainted(node.expression, selectors, taintedNames, taintedParameters);
    }
  });
  return found;
}

function numericVariableBindingDeclarations(name, initializer) {
  if (ts.isIdentifier(name)) return numericBindingDeclarations(name.text, initializer);
  const declarations = [];
  if (ts.isObjectBindingPattern(name)) {
    const basePath = expressionPath(initializer);
    for (const element of name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const propertyName = propertyNameText(element.propertyName ?? element.name);
      if (propertyName === null) continue;
      const property = ts.isObjectLiteralExpression(initializer)
        ? initializer.properties.find((candidate) =>
          !ts.isSpreadAssignment(candidate) && propertyNameText(candidate.name) === propertyName)
        : null;
      if (property && ts.isPropertyAssignment(property)) {
        declarations.push(...numericBindingDeclarations(element.name.text, property.initializer));
      } else if (property && ts.isShorthandPropertyAssignment(property)) {
        declarations.push([element.name.text, property.name]);
      } else if (basePath) {
        declarations.push([element.name.text, { bindingPath: `${basePath}.${propertyName}` }]);
      } else if (element.initializer) {
        declarations.push(...numericBindingDeclarations(element.name.text, element.initializer));
      }
    }
  } else if (ts.isArrayBindingPattern(name)) {
    const basePath = expressionPath(initializer);
    name.elements.forEach((element, index) => {
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) return;
      const source = ts.isArrayLiteralExpression(initializer) ? initializer.elements[index] : null;
      if (source && !ts.isOmittedExpression(source) && !ts.isSpreadElement(source)) {
        declarations.push(...numericBindingDeclarations(element.name.text, source));
      } else if (basePath) {
        declarations.push([element.name.text, { bindingPath: `${basePath}.${index}` }]);
      } else if (element.initializer) {
        declarations.push(...numericBindingDeclarations(element.name.text, element.initializer));
      }
    });
  }
  return declarations;
}

function evaluateNumericDeclaration(initializer, bindings) {
  if (initializer?.bindingPath) return bindings.get(initializer.bindingPath);
  return evaluateNumericConstant(initializer, bindings);
}

function numericBindingDeclarations(path, initializer) {
  const declarations = [[path, initializer]];
  if (ts.isObjectLiteralExpression(initializer)) {
    for (const property of initializer.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        if (name !== null) declarations.push(...numericBindingDeclarations(`${path}.${name}`, property.initializer));
      } else if (ts.isShorthandPropertyAssignment(property)) {
        declarations.push([`${path}.${property.name.text}`, property.name]);
      }
    }
  } else if (ts.isArrayLiteralExpression(initializer)) {
    initializer.elements.forEach((element, index) => {
      if (!ts.isOmittedExpression(element) && !ts.isSpreadElement(element)) {
        declarations.push(...numericBindingDeclarations(`${path}.${index}`, element));
      }
    });
  }
  return declarations;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function evaluateNumericConstant(node, bindings, constantParameters = new Map()) {
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
  if (ts.isParenthesizedExpression(node)) return evaluateNumericConstant(node.expression, bindings, constantParameters);
  if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) {
    const value = evaluateNumericConstant(node.operand, bindings, constantParameters);
    if (value === undefined) return undefined;
    return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  if (ts.isIdentifier(node)) {
    const parameterConstant = constantParameterReference(node, constantParameters);
    if (parameterConstant !== undefined) return parameterConstant;
  }
  if (ts.isIdentifier(node) && bindings.has(node.text)) {
    return bindings.get(node.text);
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const path = expressionPath(node);
    if (path && bindings.has(path)) return bindings.get(path);
  }
  if (!ts.isBinaryExpression(node)) return undefined;
  const left = evaluateNumericConstant(node.left, bindings, constantParameters);
  const right = evaluateNumericConstant(node.right, bindings, constantParameters);
  if (left === undefined || right === undefined) return undefined;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken: return left + right;
    case ts.SyntaxKind.MinusToken: return left - right;
    case ts.SyntaxKind.AsteriskToken: return left * right;
    case ts.SyntaxKind.SlashToken: return right === 0 ? undefined : left / right;
    case ts.SyntaxKind.PercentToken: return right === 0 ? undefined : left % right;
    case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right;
    default: return undefined;
  }
}

function addConstantParameter(constantParameters, parameter, value) {
  const values = constantParameters.get(parameter) ?? new Set();
  const previousSize = values.size;
  values.add(value);
  constantParameters.set(parameter, values);
  return values.size !== previousSize;
}

function constantParameterReference(identifier, constantParameters) {
  let current = identifier.parent;
  while (current) {
    if (ts.isFunctionLike(current)) {
      const parameter = current.parameters.find((candidate) =>
        ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text);
      if (!parameter) return undefined;
      return constantParameters.get(parameter)?.values().next().value;
    }
    current = current.parent;
  }
  return undefined;
}

function assertionLike(expression) {
  const text = expression.getText();
  return /(?:^|\.)(?:assert|expect|check|verify|ensure|require|guard|must)/i.test(text);
}

function negativeAssertionLike(expression) {
  return /(?:doesNot|not\.(?:to)?(?:equal|match|contain|include)|notEqual)/i.test(expression.getText());
}

function assertionContractNodes(call) {
  const name = call.expression.getText().split('.').at(-1) ?? '';
  if (/^(?:ok|isTrue|isFalse)$/i.test(name)) return call.arguments.slice(0, 1);
  if (/^(?:match|equal|strictEqual|deepEqual)$/i.test(name)) return call.arguments.slice(1, 2);
  return call.arguments.slice(0, 2);
}

function embeddedNumericLiteral(nodes) {
  let value;
  for (const node of nodes) {
    walk(node, (candidate) => {
      if (value !== undefined) return;
      if (!ts.isStringLiteralLike(candidate) && !ts.isRegularExpressionLiteral(candidate)) return;
      const match = candidate.text.match(/(?:^|\D)(\d+(?:\.\d+)?)(?!\d)/);
      if (match) value = Number(match[1]);
    });
    if (value !== undefined) break;
  }
  return value;
}

function isComparison(kind) {
  return [
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
  ].includes(kind);
}

function comparisonKind(kind) {
  return [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(kind)
    ? 'floor'
    : 'exact';
}

function markerNear(sourceText, lineNumber) {
  const lines = sourceText.split(/\r?\n/);
  const start = Math.max(0, lineNumber - 3);
  const text = lines.slice(start, lineNumber).join('\n');
  const raw = [...text.matchAll(/inventory-contract:\s*([^\n]+)/g)].at(-1)?.[1];
  if (!raw) return null;
  const fields = {};
  const firstSeparator = raw.indexOf(';');
  fields.id = (firstSeparator === -1 ? raw : raw.slice(0, firstSeparator)).trim();
  for (const part of (firstSeparator === -1 ? '' : raw.slice(firstSeparator + 1)).split(';')) {
    const match = part.match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
    if (match) fields[match[1].toLowerCase()] = match[2];
  }
  return fields;
}

function validateMarker(marker, entry, kind) {
  if (!marker) return { code: 'unclassified-literal', message: 'hardcoded inventory count needs an inline inventory-contract classification' };
  if (marker.id !== entry.id) return { code: 'wrong-contract-marker', message: `marker names ${marker.id || '<empty>'}, expected ${entry.id}` };
  if (!marker.reason?.trim()) return { code: 'missing-contract-reason', message: 'inventory-contract marker needs a reason' };
  const markedClassifications = new Set((marker.classification ?? '').split('+').map((value) => value.trim()).filter(Boolean));
  if (markedClassifications.size === 0 || [...markedClassifications].some((value) => !entry.classifications.includes(value))) {
    return { code: 'unsupported-contract-classification', message: `marker classification must be one of: ${entry.classifications.join(', ')}` };
  }
  if (entry.migrationAction === 'replace') {
    return { code: 'literal-on-replace-contract', message: 'this inventory is registered for replacement with derivation or parity' };
  }
  if (kind === 'floor') {
    if (!entry.classifications.includes('floor') || !markedClassifications.has('floor')) {
      return { code: 'unsupported-floor', message: 'a floor is not a supported contract for this inventory' };
    }
    if (!marker.promise?.trim()) return { code: 'unsupported-floor', message: 'a retained floor needs a named product promise' };
  }
  return null;
}

function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function problem(contractId, path, code, message, line) {
  return { contractId, path, code, message, ...(line ? { line } : {}) };
}

export function formatInventoryContractViolations(violations) {
  return violations.map((violation) => {
    const location = `${violation.path || '<registry>'}${violation.line ? `:${violation.line}` : ''}`;
    return `${location} [${violation.contractId}/${violation.code}] ${violation.message}`;
  }).join('\n');
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const rootIndex = process.argv.indexOf('--root');
  const rootDir = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1] ?? '') : process.cwd();
  const result = auditInventoryCountContracts({ rootDir });
  if (result.violations.length > 0) {
    process.stderr.write(`${formatInventoryContractViolations(result.violations)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Inventory count contracts: ${result.scannedSurfaces.length} registered surfaces passed.\n`);
  }
}
