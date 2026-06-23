import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import ts from 'typescript';

import { CURATED_COUNTRIES, TIER1_COUNTRIES } from '../src/config/countries.ts';
import {
  CII_CONFLICT_ACTIVITY_CAP,
  CII_CONFLICT_ACTIVITY_PIVOT,
  CII_FORMULA_VERSION,
  STRATEGIC_RISK_POSITIONAL_DECAY,
  STRATEGIC_RISK_SCALE_FACTOR,
  STRATEGIC_RISK_SCALE_FLOOR,
  STRATEGIC_RISK_TOP_N,
} from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { TIER1_COUNTRIES as SERVER_TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';
import {
  BASELINE_RISK,
  CII_REALTIME_REQUIRED_SIGNAL_FAMILY_COUNT,
  CII_TREND_BUCKET_LOOKUP_RADIUS,
  CII_TREND_BUCKET_MS,
  CII_TREND_TARGET_AGE_MS,
  climateCountriesForAnomaly,
  EVENT_MULTIPLIER,
  countCiiRealtimeSignalDensityCoverage,
  computeCIIScores,
  computeStrategicRisks,
  filterRiskScoresResponse,
  geoToCountry,
  getAcledFetchWindows,
  getCiiTrendHistoryBucket,
  getCiiTrendPriorCandidateBuckets,
  hasCompleteRiskScoreAdvisoryDisclosure,
  normalizeRiskScoreAdvisoryDisclosure,
  normalizeCountryName,
  selectCiiTrendPriorSnapshot,
  ZONE_COUNTRY_MAP,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import {
  CII_BASELINE_RISK as SHARED_BASELINE_RISK,
  CII_COUNTRY_WEIGHTS,
  CII_EVENT_MULTIPLIER as SHARED_EVENT_MULTIPLIER,
  DEFAULT_CII_BASELINE_RISK,
  DEFAULT_CII_EVENT_MULTIPLIER,
} from '../shared/cii-weights.ts';
import { CLIMATE_ZONES } from '../scripts/_climate-zones.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const CII_PROTOCOL_SNAPSHOT_HASH_BY_VERSION: Record<string, string> = {
  v5: '13a339323a4b1c92bec967a2b006d97330ef7f1d596326bf8a438a129fa89c10',
  // v6 (#4147/#4148/#4149/#4151): attribution/climate fixes plus the
  // formula guard expansion. The guard now includes score-relevant inline
  // literals and guarded top-level formula constants from get-risk-scores.ts,
  // so a v7 scoring branch must refresh this hash after it deliberately
  // changes formula literals.
  v6: '522a12cf805357a7a4df5c32186591c4af11053f5fd6decbff6572abd7e8a9ad',
  // v7 keeps coefficients/cutoffs stable while changing score-shifting
  // attribution inputs (bbox resolution and climate country coverage), and
  // preserves the expanded formula-literal guard from v6.
  v7: '35c2d7270c6473e457d0b189e1411b9eeb0a79bfe2ae9316485ea14369c12369',
  // v8 fixes dead UCDP conflict-floor attribution: the scorer read non-existent
  // `intensity_level`/`type_of_violence` fields, so UCDP never applied a war/minor
  // floor. The classification thresholds are guarded through the expanded helper
  // input snapshot, including `deriveUcdpIntensityByRegion` literals. Live scores
  // now shift upward for UCDP conflict countries (e.g. UA/PK/MX gain a war floor).
  v8: '87fcd775ca953f849c686b8c229c7b1a662056c9751d5c902b811257a1735b5e',
};

const GUARDED_TOP_LEVEL_SCORE_CONST_NAMES = ['NEWS_THREAT_WEIGHT', 'UCDP_CLASSIFICATION_WINDOW_MS'];
const GUARDED_SCORE_FUNCTION_NAMES = ['climateSeverityScore', 'deriveUcdpIntensityByRegion', 'computeCIIScores'];

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

interface ScoreLevelCutoff {
  min: number;
  level: string;
}

interface ParsedScoreLevelFunction {
  cutoffs: ScoreLevelCutoff[];
  fallback: string;
}

function findFunctionDeclaration(sourceFile: ts.SourceFile, functionName: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | null = null;

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  assert.ok(found, `missing function declaration: ${functionName}`);
  return found;
}

function findTopLevelConstDeclaration(
  sourceFile: ts.SourceFile,
  constName: string,
): ts.VariableDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === constName) {
        return declaration;
      }
    }
  }
  return null;
}

function getReturnString(statement: ts.Statement): string | null {
  const returnStatement = ts.isBlock(statement)
    ? statement.statements.length === 1 && ts.isReturnStatement(statement.statements[0])
      ? statement.statements[0]
      : null
    : ts.isReturnStatement(statement)
      ? statement
      : null;

  const expression = returnStatement?.expression;
  if (!expression) return null;
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : null;
}

function getScoreCutoff(expression: ts.Expression): number | null {
  if (!ts.isBinaryExpression(expression)) return null;
  if (expression.operatorToken.kind !== ts.SyntaxKind.GreaterThanEqualsToken) return null;
  if (!ts.isIdentifier(expression.left) || expression.left.text !== 'score') return null;
  return ts.isNumericLiteral(expression.right) ? Number(expression.right.text) : null;
}

function parseScoreLevelFunction(source: string, functionName: string): ParsedScoreLevelFunction {
  const sourceFile = ts.createSourceFile(
    `${functionName}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const fn = findFunctionDeclaration(sourceFile, functionName);
  assert.ok(fn.body, `${functionName} must have a function body`);

  const cutoffs: ScoreLevelCutoff[] = [];
  let fallback: string | null = null;

  for (const statement of fn.body.statements) {
    if (ts.isIfStatement(statement)) {
      const min = getScoreCutoff(statement.expression);
      const level = getReturnString(statement.thenStatement);
      assert.notEqual(min, null, `${functionName} has an unsupported cutoff condition`);
      assert.notEqual(level, null, `${functionName} cutoff ${min} must return a string literal`);
      cutoffs.push({ min, level });
      continue;
    }

    if (ts.isReturnStatement(statement)) {
      fallback = getReturnString(statement);
    }
  }

  assert.ok(cutoffs.length > 0, `${functionName} must declare score >= cutoff returns`);
  assert.ok(fallback, `${functionName} must end with a string fallback return`);
  return { cutoffs, fallback };
}

function extractScoreLevelCutoffs(source: string, functionName: string): ScoreLevelCutoff[] {
  return parseScoreLevelFunction(source, functionName).cutoffs;
}

type ScoreHelperSnapshotValue = string | number | ScoreHelperSnapshotValue[] | {
  [key: string]: ScoreHelperSnapshotValue;
};

interface NumericConstSnapshot {
  value: number;
}

interface ScoreHelperInputSnapshot {
  ucdpClassificationWindowMs: NumericConstSnapshot;
  advisoryLevelsFallback: ScoreHelperSnapshotValue;
  zoneCountryMap: ScoreHelperSnapshotValue;
}

function requireTopLevelConstDeclaration(sourceFile: ts.SourceFile, constName: string): ts.VariableDeclaration {
  const declaration = findTopLevelConstDeclaration(sourceFile, constName);
  assert.ok(declaration, `missing top-level const declaration: ${constName}`);
  assert.ok(declaration.initializer, `${constName} must have an initializer`);
  return declaration;
}

function propertyNameText(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  assert.fail(`unsupported object property name in helper snapshot: ${name.getText(sourceFile)}`);
}

function isSnapshotObject(value: ScoreHelperSnapshotValue): value is { [key: string]: ScoreHelperSnapshotValue } {
  return typeof value === 'object' && !Array.isArray(value);
}

function unwrapSnapshotExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function literalExpressionSnapshot(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  resolving = new Set<string>(),
): ScoreHelperSnapshotValue {
  const unwrappedExpression = unwrapSnapshotExpression(expression);
  if (unwrappedExpression !== expression) {
    return literalExpressionSnapshot(unwrappedExpression, sourceFile, resolving);
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text.replace(/_/g, ''));
  }
  if (ts.isIdentifier(expression)) {
    const constName = expression.text;
    assert.ok(!resolving.has(constName), `cyclic helper snapshot const reference: ${constName}`);
    resolving.add(constName);
    const declaration = requireTopLevelConstDeclaration(sourceFile, constName);
    const value = literalExpressionSnapshot(declaration.initializer!, sourceFile, resolving);
    resolving.delete(constName);
    return value;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const values: ScoreHelperSnapshotValue[] = [];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) {
        const spreadValue = literalExpressionSnapshot(element.expression, sourceFile, resolving);
        assert.ok(
          Array.isArray(spreadValue),
          `helper snapshot array spread must resolve to an array: ${element.getText(sourceFile)}`,
        );
        values.push(...spreadValue);
        continue;
      }
      values.push(literalExpressionSnapshot(element, sourceFile, resolving));
    }
    return values;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const entries: [string, ScoreHelperSnapshotValue][] = [];
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadValue = literalExpressionSnapshot(property.expression, sourceFile, resolving);
        assert.ok(
          isSnapshotObject(spreadValue),
          `helper snapshot object spread must resolve to an object: ${property.getText(sourceFile)}`,
        );
        entries.push(...Object.entries(spreadValue));
        continue;
      }
      assert.ok(
        ts.isPropertyAssignment(property),
        `unsupported object property in helper snapshot: ${property.getText(sourceFile)}`,
      );
      entries.push([
        propertyNameText(property.name, sourceFile),
        literalExpressionSnapshot(property.initializer, sourceFile, resolving),
      ]);
    }
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }
  assert.fail(`unsupported helper snapshot expression: ${expression.getText(sourceFile)}`);
}

function evaluateNumericExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  resolving = new Set<string>(),
): number {
  const unwrappedExpression = unwrapSnapshotExpression(expression);
  if (unwrappedExpression !== expression) {
    return evaluateNumericExpression(unwrappedExpression, sourceFile, resolving);
  }
  if (ts.isNumericLiteral(expression)) return Number(expression.text.replace(/_/g, ''));
  if (ts.isIdentifier(expression)) {
    const constName = expression.text;
    assert.ok(!resolving.has(constName), `cyclic numeric helper const reference: ${constName}`);
    resolving.add(constName);
    const declaration = requireTopLevelConstDeclaration(sourceFile, constName);
    const value = evaluateNumericExpression(declaration.initializer!, sourceFile, resolving);
    resolving.delete(constName);
    return value;
  }
  if (
    ts.isPrefixUnaryExpression(expression)
    && expression.operator === ts.SyntaxKind.MinusToken
  ) {
    return -evaluateNumericExpression(expression.operand, sourceFile, resolving);
  }
  if (ts.isBinaryExpression(expression)) {
    const left = evaluateNumericExpression(expression.left, sourceFile, resolving);
    const right = evaluateNumericExpression(expression.right, sourceFile, resolving);
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.SlashToken:
        return left / right;
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      default:
        assert.fail(`unsupported numeric operator in helper snapshot: ${expression.getText(sourceFile)}`);
    }
  }
  assert.fail(`unsupported numeric expression in helper snapshot: ${expression.getText(sourceFile)}`);
}

function extractNumericConstSnapshot(sourceFile: ts.SourceFile, constName: string): NumericConstSnapshot {
  const declaration = requireTopLevelConstDeclaration(sourceFile, constName);
  const initializer = declaration.initializer!;
  return {
    value: evaluateNumericExpression(initializer, sourceFile),
  };
}

function extractTopLevelConstLiteralSnapshot(
  sourceFile: ts.SourceFile,
  constName: string,
): ScoreHelperSnapshotValue {
  const declaration = requireTopLevelConstDeclaration(sourceFile, constName);
  return literalExpressionSnapshot(declaration.initializer!, sourceFile);
}

function extractScoreHelperInputSnapshot(source: string): ScoreHelperInputSnapshot {
  const sourceFile = ts.createSourceFile(
    'get-risk-scores.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  return {
    ucdpClassificationWindowMs: extractNumericConstSnapshot(sourceFile, 'UCDP_CLASSIFICATION_WINDOW_MS'),
    advisoryLevelsFallback: extractTopLevelConstLiteralSnapshot(sourceFile, 'ADVISORY_LEVELS_FALLBACK'),
    zoneCountryMap: extractTopLevelConstLiteralSnapshot(sourceFile, 'ZONE_COUNTRY_MAP'),
  };
}

interface ScoreFormulaLiteral {
  region: string;
  order: number;
  value: number;
  context: string;
}

function enclosingFormulaContext(node: ts.Node, sourceFile: ts.SourceFile, rangeEnd: number): string {
  let current: ts.Node = node;
  while (current.parent && current.parent.end <= rangeEnd) {
    current = current.parent;
    if (
      ts.isVariableDeclaration(current)
      || ts.isConditionalExpression(current)
      || ts.isCallExpression(current)
      || ts.isBinaryExpression(current)
      || ts.isReturnStatement(current)
    ) {
      return current.getText(sourceFile).replace(/\s+/g, ' ').trim();
    }
  }
  return node.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function numericLiteralValue(node: ts.Node): number | null {
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''));
  if (
    ts.isPrefixUnaryExpression(node)
    && node.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text.replace(/_/g, ''));
  }
  return null;
}

function isInsideTypeNode(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isTypeParameterDeclaration(current)) return true;
  }
  return false;
}

function collectNumericLiteralsInRange(
  sourceFile: ts.SourceFile,
  region: string,
  rangeStart: number,
  rangeEnd: number,
  orderOffset: number,
): ScoreFormulaLiteral[] {
  const literals: ScoreFormulaLiteral[] = [];

  function visit(node: ts.Node): void {
    if (node.end < rangeStart || node.getStart(sourceFile) > rangeEnd) return;
    if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)) return;

    const value = numericLiteralValue(node);
    if (value !== null && !isInsideTypeNode(node)) {
      literals.push({
        region,
        order: orderOffset + literals.length,
        value,
        context: enclosingFormulaContext(node, sourceFile, rangeEnd),
      });
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return literals;
}

function extractScoreFormulaLiterals(source: string): ScoreFormulaLiteral[] {
  const sourceFile = ts.createSourceFile(
    'get-risk-scores.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const literals: ScoreFormulaLiteral[] = [];

  for (const constName of GUARDED_TOP_LEVEL_SCORE_CONST_NAMES) {
    const declaration = findTopLevelConstDeclaration(sourceFile, constName);
    if (!declaration) continue;
    assert.ok(declaration.initializer, `${constName} must have an initializer`);
    literals.push(
      ...collectNumericLiteralsInRange(
        sourceFile,
        constName,
        declaration.initializer.getStart(sourceFile),
        declaration.initializer.end,
        literals.length,
      ),
    );
  }

  for (const functionName of GUARDED_SCORE_FUNCTION_NAMES) {
    const fn = findFunctionDeclaration(sourceFile, functionName);
    assert.ok(fn.body, `${functionName} must have a function body`);
    literals.push(
      ...collectNumericLiteralsInRange(
        sourceFile,
        functionName,
        fn.body.getStart(sourceFile),
        fn.body.end,
        literals.length,
      ),
    );
  }

  assert.ok(literals.length > 0, 'CII scorer must expose numeric formula literals to the snapshot guard');
  return literals;
}

function assertFormulaLiteralCovered(
  literals: ScoreFormulaLiteral[],
  region: string,
  value: number,
  contextSnippet: string,
): void {
  assert.ok(
    literals.some((literal) => (
      literal.region === region
      && literal.value === value
      && literal.context.includes(contextSnippet)
    )),
    `CII formula snapshot must cover ${region} literal ${value} in context: ${contextSnippet}`,
  );
}

function evaluateScoreLevel(parsed: ParsedScoreLevelFunction, score: number): string {
  for (const cutoff of parsed.cutoffs) {
    if (score >= cutoff.min) return cutoff.level;
  }
  return parsed.fallback;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function emptyAux() {
  return {
    ucdpEvents: [] as any[],
    outages: [] as any[],
    climate: [] as any[],
    cyber: [] as any[],
    fires: [] as any[],
    gpsHexes: [] as any[],
    iranEvents: [] as any[],
    orefData: null as { activeAlertCount: number; historyCount24h: number } | null,
    advisories: null as { byCountry: Record<string, 'do-not-travel' | 'reconsider' | 'caution'> } | null,
    displacedByIso3: {} as Record<string, number>,
    newsTopStories: [] as Array<{ countryCode: string | null; threatLevel: string; primaryTitle: string }>,
    threatSummaryByCountry: null as Record<string, { critical: number; high: number; medium: number; low: number; info: number }> | null,
    aviationAlerts: [] as any[],
    earthquakes: [] as any[],
    sanctionsCountries: [] as any[],
    sanctionsCountryCounts: null as Record<string, number> | null,
    temporalAnomalies: [] as any[],
    militaryCii: null as Record<string, any> | null,
  };
}

function acledEvent(country: string, type: string, fatalities = 0) {
  return { country, event_type: type, fatalities };
}

// Mirror of the real `conflict:ucdp-events:v1` row shape (seed-ucdp-events.mjs /
// ais-relay.cjs): { country, violenceType, deathsBest, dateStart }. There is NO
// `intensity_level`/`type_of_violence` field — the scorer classifies per-country
// using deaths + event count over a 2-year window (deriveUcdpClassifications parity).
function ucdpEvent(country: string, deathsBest = 1, dateStart = Date.now()) {
  return {
    country,
    violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
    deathsBest,
    dateStart,
  };
}

// `war` = totalDeaths > 1000 OR eventCount > 100. A single high-death event is the
// simplest war fixture; >10 low-death events is the simplest `minor` fixture.
function ucdpWarEvents(country: string) {
  return [ucdpEvent(country, 1500)];
}
function ucdpMinorEvents(country: string) {
  return Array.from({ length: 11 }, () => ucdpEvent(country, 1));
}

function acledEvents(country: string, type: string, count: number) {
  return Array.from({ length: count }, () => acledEvent(country, type));
}

function scoreFor(scores: ReturnType<typeof computeCIIScores>, code: string) {
  return scores.find((s) => s.region === code);
}

function countScoredRealtimeComponents(scores: ReturnType<typeof computeCIIScores>): number {
  return scores.filter((score) => {
    const components = score.components;
    return Boolean(
      components
      && (components.newsActivity > 0
        || components.ciiContribution > 0
        || components.geoConvergence > 0
        || components.militaryActivity > 0),
    );
  }).length;
}

const TREND_TEST_NOW = 1_700_000_000_000;
const CII_TEST_DAY_MS = 24 * 60 * 60 * 1000;
const UCDP_TEST_WINDOW_MS = 2 * 365 * CII_TEST_DAY_MS;

function priorCiiScore(region: string, combinedScore: number, computedAt = TREND_TEST_NOW - CII_TREND_TARGET_AGE_MS) {
  return {
    region,
    staticBaseline: 0,
    dynamicScore: 0,
    combinedScore,
    trend: 'TREND_DIRECTION_STABLE',
    components: { newsActivity: 0, ciiContribution: 0, geoConvergence: 0, militaryActivity: 0 },
    computedAt,
    methodologyVersion: CII_FORMULA_VERSION,
    eventMultiplier: 1,
  } as ReturnType<typeof computeCIIScores>[number];
}

function trendSnapshot(capturedAt: number) {
  return {
    capturedAt,
    ciiScores: [priorCiiScore('US', 42, capturedAt)],
  };
}

describe('CII signal wiring', () => {
  it('country text attribution uses token boundaries and preserves explicit aliases', () => {
    assert.equal(normalizeCountryName('Jerusalem security alert'), null,
      'Jerusalem must not match US via the embedded "usa" substring');
    assert.equal(normalizeCountryName('Sukhoi incident reported'), null,
      'Sukhoi must not match GB via the embedded "uk" substring');
    assert.equal(normalizeCountryName('New England outage'), null,
      'New England must not match GB via a bare England alias');
    assert.equal(normalizeCountryName('Fukushima plant inspection'), 'JP',
      'Fukushima is a legitimate Japan place alias, not a GB substring match');
    assert.equal(normalizeCountryName('United Kingdom sanctions update'), 'GB',
      'United Kingdom must resolve to GB');
    assert.equal(normalizeCountryName('UK sanctions update'), 'GB',
      'UK remains a valid token alias for GB');
    assert.equal(normalizeCountryName('U.K. sanctions update'), 'GB',
      'dotted U.K. remains a valid token alias for GB');
    assert.equal(normalizeCountryName('Iranian sanctions debate'), 'IR',
      'demonym aliases that raw substring matching used to cover must stay covered explicitly');
    assert.equal(normalizeCountryName('North Korean missile drill'), 'KP',
      'North Korean demonym should resolve to KP');
    assert.equal(normalizeCountryName('Taiwanese election pressure'), 'TW',
      'Taiwanese demonym should resolve to TW');
    assert.equal(normalizeCountryName('Korean export data'), null,
      'bare Korean remains ambiguous and must not resolve to KR/KP');
  });

  it('geoToCountry disambiguates known overlapping bboxes with deterministic border heuristics', () => {
    assert.equal(geoToCountry(33.5138, 36.2765), 'SY', 'Damascus must resolve to Syria, not Lebanon');
    assert.equal(geoToCountry(29.7604, -95.3698), 'US', 'southern US coordinates must resolve to US, not Mexico');
    assert.equal(geoToCountry(33.5904, 130.4017), 'JP', 'Fukuoka must resolve to Japan, not South Korea');
    assert.equal(geoToCountry(17.5656, 44.2289), 'SA', 'Najran must resolve to Saudi Arabia, not Yemen');
    assert.equal(geoToCountry(41.28, 129.09), 'KP', 'Punggye-ri must resolve to North Korea, not China');
    assert.equal(geoToCountry(42.89, 129.51), 'CN', 'Yanji must resolve to China, not North Korea');
    assert.equal(geoToCountry(42.86, 130.36), 'CN', 'Hunchun must resolve to China, not North Korea');
    assert.equal(geoToCountry(42.77, 129.51), 'CN', 'Longjing must resolve to China, not North Korea');
    assert.equal(geoToCountry(51.25, 22.57), 'PL', 'Lublin must resolve to Poland, not Ukraine');

    assert.equal(geoToCountry(32.7157, -117.1611), 'US', 'San Diego remains US');
    assert.equal(geoToCountry(32.5149, -117.0382), 'MX', 'Tijuana remains Mexico');
    assert.equal(geoToCountry(31.7619, -106.4850), 'US', 'El Paso remains US');
    assert.equal(geoToCountry(31.6904, -106.4245), 'MX', 'Ciudad Juarez remains Mexico');
    assert.equal(geoToCountry(25.9017, -97.4975), 'US', 'Brownsville remains US');
    assert.equal(geoToCountry(27.4763, -99.5164), 'MX', 'Nuevo Laredo must resolve to Mexico, not Texas');
    assert.equal(geoToCountry(28.6916, -100.5409), 'MX', 'Piedras Negras must resolve to Mexico, not Texas');
    assert.equal(geoToCountry(29.3232, -100.9522), 'MX', 'Ciudad Acuna must resolve to Mexico, not Texas');
    assert.equal(geoToCountry(25.6866, -100.3161), 'MX', 'Monterrey remains Mexico');
    assert.equal(geoToCountry(33.8938, 35.5018), 'LB', 'Beirut remains Lebanon');
    assert.equal(geoToCountry(37.5665, 126.9780), 'KR', 'Seoul remains South Korea');
    assert.equal(geoToCountry(37.9382, 126.5878), 'KP', 'Kaesong must resolve to North Korea, not South Korea');
    assert.equal(geoToCountry(38.0400, 125.7140), 'KP', 'Haeju must resolve to North Korea, not South Korea');
    assert.equal(geoToCountry(15.3694, 44.1910), 'YE', 'Sanaa remains Yemen');
    assert.equal(geoToCountry(47.2357, 39.7015), 'RU', 'Rostov-on-Don must resolve to Russia, not Ukraine');
    assert.equal(geoToCountry(51.7304, 36.1939), 'RU', 'Kursk remains Russia');
    assert.equal(geoToCountry(50.5954, 36.5873), 'RU', 'Belgorod remains Russia');
    assert.equal(geoToCountry(50.9077, 34.7981), 'UA', 'Sumy must resolve to Ukraine, not Russia');
    assert.equal(geoToCountry(49.9935, 36.2304), 'UA', 'Kharkiv remains Ukraine');
    assert.equal(geoToCountry(49.8397, 24.0297), 'UA', 'Lviv remains Ukraine east of the PL/UA border heuristic');
    assert.equal(geoToCountry(31.5204, 74.3587), 'PK', 'Lahore remains Pakistan');
    assert.equal(geoToCountry(31.6340, 74.8723), 'IN', 'Amritsar must resolve to India, not Pakistan');
    assert.equal(geoToCountry(29.6520, 91.1721), 'CN', 'Lhasa must resolve to China, not India');
    assert.equal(geoToCountry(37.0662, 37.3833), 'TR', 'Gaziantep must resolve to Turkey, not Syria');
    assert.equal(geoToCountry(34.3277, 47.0778), 'IR', 'Kermanshah must resolve to Iran, not Iraq');
    assert.equal(geoToCountry(30.1798, 66.9750), 'PK', 'Quetta must resolve to Pakistan, not Afghanistan');
    assert.equal(geoToCountry(33.6844, 73.0479), 'PK', 'Islamabad remains Pakistan');
    assert.equal(geoToCountry(26.4207, 50.0888), 'SA', 'Dammam remains Saudi Arabia');
    assert.equal(geoToCountry(28.3835, 36.5662), 'SA', 'Tabuk must resolve to Saudi Arabia, not Egypt');
    assert.equal(geoToCountry(24.0128, 97.8519), 'CN', 'Ruili must resolve to China, not Myanmar');
    assert.equal(geoToCountry(43.1155, 131.8855), 'RU', 'Vladivostok must resolve to Russia, not China');
    assert.equal(geoToCountry(50.2907, 127.5272), 'RU', 'Blagoveshchensk remains Russia');
    assert.equal(geoToCountry(50.9213, 128.4739), 'RU', 'Belogorsk must resolve to Russia, not China');
    assert.equal(geoToCountry(50.2458, 127.4886), 'CN', 'Heihe must resolve to China, not Russia');
    assert.equal(geoToCountry(52.9721, 122.5386), 'CN', 'Mohe must resolve to China, not Russia');
    assert.equal(geoToCountry(45.8038, 126.5350), 'CN', 'Harbin remains China');
    assert.equal(geoToCountry(46.9591, 142.7380), 'RU', 'Yuzhno-Sakhalinsk must resolve to Russia, not Japan');
    assert.equal(geoToCountry(45.4500, 142.0500), 'RU', 'southern Sakhalin inside the JP bbox must resolve to Russia');
    assert.equal(geoToCountry(44.3500, 142.4600), 'JP', 'north Hokkaido must resolve to Japan, not Russia');
    assert.equal(geoToCountry(45.4150, 141.6730), 'JP', 'Wakkanai remains Japan');
    assert.equal(geoToCountry(43.0618, 141.3545), 'JP', 'Sapporo remains Japan');
    assert.equal(geoToCountry(31.8560, 35.4590), 'IL', 'Jordan fail-closed gap must not mask tighter IL bbox attribution');
    assert.equal(geoToCountry(32.4500, 36.1000), 'SY', 'Jordan fail-closed gap must not mask Syria bbox attribution');
    assert.equal(geoToCountry(31.9539, 35.9106), null, 'Amman must fail closed because Jordan is not a Tier-1 CII country');
  });

  it('climate producer zones intersect the CII consumer map for score-relevant zones', () => {
    const producerZones = new Set(CLIMATE_ZONES.map((zone) => zone.name));
    const expected: Record<string, string[]> = {
      Ukraine: ['UA'],
      Europe: ['DE', 'FR', 'GB', 'PL'],
      'East Asia': ['KP', 'KR', 'JP'],
      California: ['US'],
      Amazon: ['BR'],
      'Taiwan Strait': ['TW'],
      'Latin America': ['VE'],
      Caribbean: ['CU', 'MX'],
      'Middle East': ['IR', 'IL', 'SA', 'SY', 'YE', 'AE', 'IQ', 'LB', 'QA'],
      'South Asia': ['IN', 'PK', 'AF'],
      Myanmar: ['MM'],
    };

    for (const [zone, expectedCodes] of Object.entries(expected)) {
      assert.equal(producerZones.has(zone), true, `${zone} must still be emitted by the climate producer`);
      assert.deepEqual(
        expectedCodes.filter((code) => ZONE_COUNTRY_MAP[zone]?.includes(code)),
        expectedCodes,
        `${zone} must feed CII countries ${expectedCodes.join(', ')}`,
      );
    }
  });

  it('climate anomaly enum severities raise scores for producer zone names', () => {
    const cases: Array<[string, string]> = [
      ['California', 'US'],
      ['Ukraine', 'UA'],
      ['East Asia', 'KP'],
      ['East Asia', 'KR'],
      ['East Asia', 'JP'],
      ['Europe', 'PL'],
      ['Europe', 'DE'],
      ['Europe', 'FR'],
      ['Europe', 'GB'],
      ['Latin America', 'VE'],
      ['Amazon', 'BR'],
      ['Taiwan Strait', 'TW'],
      ['Caribbean', 'MX'],
      ['Caribbean', 'CU'],
    ];

    for (const [zone, code] of cases) {
      const countryName = TIER1_COUNTRIES[code as keyof typeof TIER1_COUNTRIES];
      const activity = acledEvents(countryName, 'Battles', 1000);
      const base = scoreFor(computeCIIScores(activity, emptyAux()), code);
      const aux = emptyAux();
      aux.climate = [{ zone, severity: 'ANOMALY_SEVERITY_EXTREME' }];
      const withClimate = scoreFor(computeCIIScores(activity, aux), code);
      assert.ok(
        withClimate!.combinedScore > base!.combinedScore,
        `${zone} anomaly should raise ${code} through climateBoost`,
      );
    }
  });

  it('climate anomaly coordinate fallback attributes producer records with unknown zone vocabulary', () => {
    assert.deepEqual(
      climateCountriesForAnomaly({
        zone: 'Producer Vocabulary Added After Consumer Deploy',
        location: { latitude: 41.28, longitude: 129.09 },
      }),
      ['KP'],
    );
    assert.deepEqual(
      climateCountriesForAnomaly({
        zone: 'Producer Vocabulary Added After Consumer Deploy',
        lat: 51.25,
        lon: 22.57,
      }),
      ['PL'],
    );
  });

  it('ACLED 7d and 30d fetch windows do not double-count the 7-day boundary date', () => {
    const windows = getAcledFetchWindows(Date.UTC(2026, 5, 6, 12, 0, 0));
    assert.deepEqual(windows, {
      recent: { startDate: '2026-05-30', endDate: '2026-06-06' },
      older: { startDate: '2026-05-07', endDate: '2026-05-29' },
    });
    assert.notEqual(windows.recent.startDate, windows.older.endDate,
      'older window must end before the recent inclusive start date');
  });

  it('earthquake seed fetches the same 7-day window that CII scoring claims', () => {
    const seedPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'scripts',
      'seed-earthquakes.mjs',
    );
    const seed = readFileSync(seedPath, 'utf8');
    assert.match(seed, /summary\/4\.5_week\.geojson/,
      'seed-earthquakes must use the USGS 7-day feed because CII scores a 7-day earthquake lookback');
    assert.doesNotMatch(seed, /summary\/4\.5_day\.geojson/,
      'seed-earthquakes must not publish only a 1-day feed under the 7-day CII scoring contract');
  });

  it('Phase 3b D5/D6: earthquake / sanctions signals raise the score', () => {
    // Temporal anomalies are deliberately NOT scored — the temporal:anomalies:v1
    // producer emits region:'global' so they cannot be country-attributed. The
    // score rise asserted below comes entirely from earthquakeBoost + sanctionsBoost.
    const acled = [acledEvent('US', 'protest', 0)];
    const base = scoreFor(computeCIIScores(acled, emptyAux()), 'US');
    const aux = emptyAux();
    aux.earthquakes = [{ magnitude: 7.0, occurredAt: Date.now(), location: { latitude: 39, longitude: -98 } }];
    aux.sanctionsCountries = [
      { countryCode: 'US', entryCount: 10, newEntryCount: 1 },
      { countryCode: 'US', entryCount: 5, newEntryCount: 0 }, // duplicate ISO2 — must accumulate, not overwrite
    ];
    const withAux = scoreFor(computeCIIScores(acled, aux), 'US');
    assert.ok(withAux, 'computeCIIScores handles the aux sources without throwing');
    assert.ok(withAux!.combinedScore > base!.combinedScore,
      'earthquake + sanctions feed earthquakeBoost + sanctionsBoost in the blend');
  });

  it('earthquake lookback honors injected CII scorer clock', () => {
    const nowMs = Date.UTC(2020, 0, 10);
    const base = scoreFor(computeCIIScores([], emptyAux(), { nowMs }), 'US')!;

    const recentAux = emptyAux();
    recentAux.earthquakes = [
      { magnitude: 7.0, occurredAt: nowMs - 24 * 60 * 60 * 1000, location: { latitude: 39, longitude: -98 } },
    ];
    const recent = scoreFor(computeCIIScores([], recentAux, { nowMs }), 'US')!;
    assert.ok(
      recent.combinedScore > base.combinedScore,
      'a one-day-old magnitude 7 earthquake must boost scores relative to injected nowMs',
    );

    const staleAux = emptyAux();
    staleAux.earthquakes = [
      { magnitude: 7.0, occurredAt: nowMs - 8 * 24 * 60 * 60 * 1000, location: { latitude: 39, longitude: -98 } },
    ];
    const stale = scoreFor(computeCIIScores([], staleAux, { nowMs }), 'US')!;
    assert.equal(
      stale.combinedScore,
      base.combinedScore,
      'an eight-day-old earthquake must be ignored relative to injected nowMs',
    );
  });

  it('Phase 3b D7/D8: cyber severity + high-brightness fires raise the score', () => {
    const base = scoreFor(computeCIIScores([], emptyAux()), 'US');
    const aux = emptyAux();
    aux.cyber = [{ country: 'US', severity: 'critical' }, { country: 'US', severity: 'high' }];
    aux.fires = [{ lat: 39, lon: -98, brightness: 400, frp: 60 }];
    const us = scoreFor(computeCIIScores([], aux), 'US');
    assert.ok(us!.combinedScore > base!.combinedScore,
      'critical/high cyber feed the severity-weighted cyberBoost; a bright fire feeds fireBoost');
  });

  it('Phase 3b D7: cyber severity accepts the production proto enum form (CRITICALITY_LEVEL_*)', () => {
    // The cyber seed (seed-cyber-threats.mjs lines 52-55) emits the proto enum strings,
    // not bare lowercase — the ingestion must bucket both. Without the prefix-strip,
    // these would all fall through and cyberBoost would be 0 in production.
    const baseAux = emptyAux();
    const protoAux = emptyAux();
    protoAux.cyber = [
      { country: 'US', severity: 'CRITICALITY_LEVEL_CRITICAL' },
      { country: 'US', severity: 'CRITICALITY_LEVEL_HIGH' },
    ];
    const protoScore = scoreFor(computeCIIScores([], protoAux), 'US');
    const baseScore = scoreFor(computeCIIScores([], baseAux), 'US');
    assert.ok(protoScore!.combinedScore > baseScore!.combinedScore,
      'production CRITICALITY_LEVEL_* enums must feed cyberBoost');
  });

  it('Phase 3b D6: sanctions duplicate-ISO2 rows accumulate across the tier boundary', () => {
    const aux = emptyAux();
    aux.sanctionsCountries = [
      { countryCode: 'US', entryCount: 60, newEntryCount: 1 },
      { countryCode: 'US', entryCount: 60, newEntryCount: 0 },
    ];
    const us = scoreFor(computeCIIScores([], aux), 'US');
    const none = scoreFor(computeCIIScores([], emptyAux()), 'US');
    // 60+60 = 120 entries → tier ≥101 → boost 5, +2 newEntry = 7. Had the loop overwritten
    // instead of accumulated, 60 alone → tier <101 → boost 3+2 = 5. The gap proves accumulation.
    assert.ok(us!.combinedScore - none!.combinedScore >= 7,
      'duplicate-ISO2 sanctions rows accumulate (120 entries crosses the ≥101 tier)');
  });

  it('Phase 3b D6: sanctions all-country count map scores countries outside the top pressure rows', () => {
    const aux = emptyAux();
    aux.sanctionsCountries = [];
    aux.sanctionsCountryCounts = { GB: 120 };
    const gb = scoreFor(computeCIIScores([], aux), 'GB');
    const none = scoreFor(computeCIIScores([], emptyAux()), 'GB');
    assert.ok(gb!.combinedScore > none!.combinedScore,
      'CII must use sanctions:country-counts:v1 so countries outside the top-12 pressure rows are not silently ignored');
  });

  it('C3: security component scores military flights/vessels/aviation, not just GPS', () => {
    // No GPS hexes — pre-Phase-3b this would score security 0; the 4-input formula
    // must now pick up military activity and aviation.
    const aux = emptyAux();
    aux.militaryCii = {
      US: { ownFlights: 5, foreignFlights: 0, ownVessels: 0, foreignVessels: 0, aisDisruptionHigh: 0, aisDisruptionElevated: 0, aisDisruptionLow: 0 },
    };
    aux.aviationAlerts = [{ country: 'United States', delayType: 'closure' }];
    const us = scoreFor(computeCIIScores([], aux), 'US');
    assert.ok(us, 'US scored');
    // flightScore = min(50, 5·3=15) = 15; aviationScore (one closure) = 20; vessels/GPS = 0
    assert.equal(us!.components!.militaryActivity, 35,
      'security = flightScore(15) + aviationScore(20), no GPS');
  });

  it('Phase 3b C1: a riot adds severityBoost vs a plain protest', () => {
    // Same unrest count (1 event), 0 fatalities, 0 outages in both — the only difference
    // is the riot classifies as high-severity → severityBoost. Isolates C1.
    const protest = scoreFor(computeCIIScores([acledEvent('Russia', 'Protests', 0)], emptyAux()), 'RU');
    const riot = scoreFor(computeCIIScores([acledEvent('Russia', 'Riots', 0)], emptyAux()), 'RU');
    assert.ok(riot!.components!.ciiContribution > protest!.components!.ciiContribution,
      'a riot is high-severity unrest and adds severityBoost; a plain protest does not');
  });

  it('C3: foreign military presence is weighted x2', () => {
    const aux = emptyAux();
    // 0 own + 5 foreign flights → reconstructed count 0 + 5·2 = 10 → flightScore min(50, 30) = 30
    aux.militaryCii = {
      US: { ownFlights: 0, foreignFlights: 5, ownVessels: 0, foreignVessels: 0, aisDisruptionHigh: 0, aisDisruptionElevated: 0, aisDisruptionLow: 0 },
    };
    const us = scoreFor(computeCIIScores([], aux), 'US');
    assert.equal(us!.components!.militaryActivity, 30, 'foreign flights weighted x2: 5·2·3 = 30');
  });
});

describe('CII scoring', () => {
  it('returns scores for all 31 tier-1 countries including MX, BR, AE, LB, IQ, AF', () => {
    const scores = computeCIIScores([], emptyAux());
    assert.equal(scores.length, 31);
    assert.ok(scoreFor(scores, 'MX'), 'MX missing');
    assert.ok(scoreFor(scores, 'BR'), 'BR missing');
    assert.ok(scoreFor(scores, 'AE'), 'AE missing');
    assert.ok(scoreFor(scores, 'LB'), 'LB missing');
    assert.ok(scoreFor(scores, 'IQ'), 'IQ missing');
    assert.ok(scoreFor(scores, 'AF'), 'AF missing');
    assert.ok(scoreFor(scores, 'KR'), 'KR missing');
    assert.ok(scoreFor(scores, 'EG'), 'EG missing');
    assert.ok(scoreFor(scores, 'JP'), 'JP missing');
    assert.ok(scoreFor(scores, 'QA'), 'QA missing');
  });

  it('UCDP war floor: composite >= 70', () => {
    const aux = emptyAux();
    // Real feed shape: high-death state-based events → war (totalDeaths > 1000).
    aux.ucdpEvents = ucdpWarEvents('Ukraine');
    const scores = computeCIIScores([], aux);
    const ua = scoreFor(scores, 'UA')!;
    assert.ok(ua.combinedScore >= 70, `UA score ${ua.combinedScore} should be >= 70 with UCDP war`);
  });

  it('UCDP minor conflict floor: composite >= 50', () => {
    const aux = emptyAux();
    // Real feed shape: > 10 low-death events but below the war thresholds → minor.
    aux.ucdpEvents = ucdpMinorEvents('Pakistan');
    const scores = computeCIIScores([], aux);
    const pk = scoreFor(scores, 'PK')!;
    assert.ok(pk.combinedScore >= 50, `PK score ${pk.combinedScore} should be >= 50 with UCDP minor`);
  });

  it('UCDP regression: feed without intensity_level/type_of_violence still classifies (real shape)', () => {
    // The cached feed has NO intensity_level/type_of_violence — the old scorer read
    // those non-existent keys and never applied a UCDP floor. Guard the field names.
    const aux = emptyAux();
    aux.ucdpEvents = [
      { country: 'Ukraine', violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED', deathsBest: 2000, dateStart: Date.now() },
    ];
    const scores = computeCIIScores([], aux);
    const ua = scoreFor(scores, 'UA')!;
    assert.ok(ua.combinedScore >= 70,
      `UA must reach the war floor from the real UCDP shape (violenceType/deathsBest), got ${ua.combinedScore}`);
    // A handful of low-death events stays below thresholds → no floor beyond baseline/advisory.
    const auxQuiet = emptyAux();
    auxQuiet.ucdpEvents = [{ country: 'Brazil', violenceType: 'UCDP_VIOLENCE_TYPE_NON_STATE', deathsBest: 1, dateStart: Date.now() }];
    const br = scoreFor(computeCIIScores([], auxQuiet), 'BR')!;
    assert.ok(br.combinedScore < 50, `BR with a single quiet UCDP event must not reach the minor floor, got ${br.combinedScore}`);
  });

  it('UCDP date guard ignores future and non-finite dates for conflict floors', () => {
    const baseline = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'UA')!;
    const aux = emptyAux();
    aux.ucdpEvents = [
      ucdpEvent('Ukraine', 2000, TREND_TEST_NOW + 365 * CII_TEST_DAY_MS),
      ucdpEvent('Ukraine', 2000, Number.NaN),
      { country: 'Ukraine', violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED', deathsBest: 2000 },
    ];

    const ua = scoreFor(computeCIIScores([], aux, { nowMs: TREND_TEST_NOW }), 'UA')!;
    assert.equal(
      ua.combinedScore,
      baseline.combinedScore,
      `future/non-finite UCDP rows must not impose a war floor; got ${ua.combinedScore} vs baseline ${baseline.combinedScore}`,
    );
    assert.ok(ua.combinedScore < 70, `future-dated UCDP row must not trigger war floor, got ${ua.combinedScore}`);
  });

  it('UCDP date guard preserves valid current and trailing-window conflict floors', () => {
    for (const dateStart of [
      TREND_TEST_NOW,
      TREND_TEST_NOW - UCDP_TEST_WINDOW_MS + CII_TEST_DAY_MS,
    ]) {
      const aux = emptyAux();
      aux.ucdpEvents = [ucdpEvent('Ukraine', 2000, dateStart)];
      const ua = scoreFor(computeCIIScores([], aux, { nowMs: TREND_TEST_NOW }), 'UA')!;
      assert.ok(ua.combinedScore >= 70, `valid UCDP date ${dateStart} must still trigger war floor, got ${ua.combinedScore}`);
    }
  });

  it('advisory do-not-travel floor: composite >= 60', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const code of ['UA', 'SY', 'YE', 'MM']) {
      const s = scoreFor(scores, code)!;
      assert.ok(s.combinedScore >= 60, `${code} score ${s.combinedScore} should be >= 60 (do-not-travel)`);
    }
  });

  it('advisory reconsider floor: composite >= 50', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const code of ['MX', 'IR', 'PK', 'VE', 'CU']) {
      const s = scoreFor(scores, code)!;
      assert.ok(s.combinedScore >= 50, `${code} score ${s.combinedScore} should be >= 50 (reconsider)`);
    }
  });

  it('advisory provenance distinguishes live, fallback, and absent inputs', () => {
    const fallbackScores = computeCIIScores([], emptyAux());
    const uaFallback = scoreFor(fallbackScores, 'UA') as unknown as {
      advisoryLevel: string;
      advisoryProvenance: string;
    };
    const usAbsent = scoreFor(fallbackScores, 'US') as unknown as {
      advisoryLevel: string;
      advisoryProvenance: string;
    };

    assert.equal(uaFallback.advisoryLevel, 'do-not-travel');
    assert.equal(uaFallback.advisoryProvenance, 'fallback');
    assert.equal(usAbsent.advisoryLevel, '');
    assert.equal(usAbsent.advisoryProvenance, 'absent');

    const aux = emptyAux();
    aux.advisories = { byCountry: { UA: 'caution' } };
    const uaLive = scoreFor(computeCIIScores([], aux), 'UA') as unknown as {
      advisoryLevel: string;
      advisoryProvenance: string;
    };
    assert.equal(uaLive.advisoryLevel, 'caution');
    assert.equal(uaLive.advisoryProvenance, 'live');
  });

  it('invalid live advisory levels do not suppress the fallback table', () => {
    const aux = emptyAux();
    aux.advisories = { byCountry: { UA: 'unknown-level' as 'do-not-travel' } };

    const ua = scoreFor(computeCIIScores([], aux), 'UA') as unknown as {
      advisoryLevel: string;
      advisoryProvenance: string;
    };

    assert.equal(ua.advisoryLevel, 'do-not-travel');
    assert.equal(ua.advisoryProvenance, 'fallback');
  });

  it('OREF active alerts boost IL conflict score', () => {
    const aux = emptyAux();
    aux.orefData = { activeAlertCount: 5, historyCount24h: 12 };
    const withOref = scoreFor(computeCIIScores([], aux), 'IL')!;
    const withoutOref = scoreFor(computeCIIScores([], emptyAux()), 'IL')!;
    assert.ok(withOref.combinedScore > withoutOref.combinedScore,
      `IL with OREF (${withOref.combinedScore}) should be > without (${withoutOref.combinedScore})`);
  });

  it('outage TOTAL severity gives higher unrest component than PARTIAL', () => {
    const auxTotal = emptyAux();
    auxTotal.outages = [{ countryCode: 'DE', severity: 'OUTAGE_SEVERITY_TOTAL' }];
    const auxPartial = emptyAux();
    auxPartial.outages = [{ countryCode: 'DE', severity: 'OUTAGE_SEVERITY_PARTIAL' }];
    const total = scoreFor(computeCIIScores([], auxTotal), 'DE')!;
    const partial = scoreFor(computeCIIScores([], auxPartial), 'DE')!;
    assert.ok(total.components!.ciiContribution > partial.components!.ciiContribution,
      `TOTAL unrest (${total.components!.ciiContribution}) should be > PARTIAL (${partial.components!.ciiContribution})`);
  });

  it('GPS high level gives higher weight than medium', () => {
    const auxHigh = emptyAux();
    auxHigh.gpsHexes = Array.from({ length: 5 }, () => ({ lat: 33.0, lon: 35.0, level: 'high' }));
    const auxMed = emptyAux();
    auxMed.gpsHexes = Array.from({ length: 5 }, () => ({ lat: 33.0, lon: 35.0, level: 'medium' }));
    const high = scoreFor(computeCIIScores([], auxHigh), 'IL')!;
    const med = scoreFor(computeCIIScores([], auxMed), 'IL')!;
    assert.ok(high.components!.militaryActivity >= med.components!.militaryActivity,
      `GPS high (${high.components!.militaryActivity}) should be >= medium (${med.components!.militaryActivity})`);
  });

  it('conflict fatalities use sqrt scaling', () => {
    const acled100 = [acledEvent('Ukraine', 'Battles', 100)];
    const acled400 = [acledEvent('Ukraine', 'Battles', 400)];
    const s100 = scoreFor(computeCIIScores(acled100, emptyAux()), 'UA')!;
    const s400 = scoreFor(computeCIIScores(acled400, emptyAux()), 'UA')!;
    const diff = s400.combinedScore - s100.combinedScore;
    assert.ok(diff < (s400.combinedScore - s100.staticBaseline) * 0.5,
      'sqrt scaling should produce diminishing returns for 4x fatalities');
  });

  it('conflict activity scaling preserves the gap between moderate and extreme event volume', () => {
    const acled = [
      ...Array.from({ length: 46 }, () => acledEvent('China', 'Battles')),
      ...Array.from({ length: 1549 }, () => acledEvent('Iran', 'Battles')),
    ];
    const scores = computeCIIScores(acled, emptyAux());
    const cn = scoreFor(scores, 'CN')!;
    const ir = scoreFor(scores, 'IR')!;
    assert.ok(
      ir.components!.geoConvergence >= cn.components!.geoConvergence + 10,
      `IR conflict component (${ir.components!.geoConvergence}) should materially exceed CN (${cn.components!.geoConvergence})`,
    );
  });

  it('log2 scaling dampens high-volume low-multiplier countries vs linear', () => {
    const manyProtests = Array.from({ length: 100 }, () => acledEvent('United States', 'Protests'));
    const fewProtests = Array.from({ length: 10 }, () => acledEvent('United States', 'Protests'));
    const many = scoreFor(computeCIIScores(manyProtests, emptyAux()), 'US')!;
    const few = scoreFor(computeCIIScores(fewProtests, emptyAux()), 'US')!;
    const ratio = many.components!.ciiContribution / Math.max(1, few.components!.ciiContribution);
    assert.ok(ratio < 5, `10x events should produce < 5x unrest ratio (got ${ratio.toFixed(2)}), log2 dampens`);
  });

  it('displacement boost preserves humanitarian scale above six figures', () => {
    const moderateAux = emptyAux();
    moderateAux.displacedByIso3 = { USA: 120_000 };
    const extremeAux = emptyAux();
    extremeAux.displacedByIso3 = { USA: 5_600_000 };
    const moderate = scoreFor(computeCIIScores([], moderateAux), 'US')!;
    const extreme = scoreFor(computeCIIScores([], extremeAux), 'US')!;
    assert.ok(
      extreme.combinedScore >= moderate.combinedScore + 10,
      `5.6M displaced (${extreme.combinedScore}) should score materially above 120K (${moderate.combinedScore})`,
    );
  });

  it('iran high severity strikes boost conflict', () => {
    const aux1 = emptyAux();
    aux1.iranEvents = [{ lat: 33.0, lon: 35.0, severity: 'high' }];
    const aux2 = emptyAux();
    aux2.iranEvents = [{ lat: 33.0, lon: 35.0, severity: 'low' }];
    const highSev = scoreFor(computeCIIScores([], aux1), 'IL')!;
    const lowSev = scoreFor(computeCIIScores([], aux2), 'IL')!;
    assert.ok(highSev.combinedScore >= lowSev.combinedScore,
      `High severity strike (${highSev.combinedScore}) should be >= low (${lowSev.combinedScore})`);
  });

  it('IL scores higher than MX with active conflict signals', () => {
    const acled = [
      acledEvent('Israel', 'Battles', 10),
      acledEvent('Israel', 'Explosions/Remote violence', 5),
      acledEvent('Mexico', 'Riots', 3),
    ];
    const aux = emptyAux();
    aux.ucdpEvents = ucdpMinorEvents('Israel');
    aux.orefData = { activeAlertCount: 3, historyCount24h: 8 };
    const scores = computeCIIScores(acled, aux);
    const il = scoreFor(scores, 'IL')!;
    const mx = scoreFor(scores, 'MX')!;
    assert.ok(il.combinedScore > mx.combinedScore,
      `IL (${il.combinedScore}) should be > MX (${mx.combinedScore})`);
  });

  it('scores capped at 100', () => {
    const acled = Array.from({ length: 200 }, () => acledEvent('Syria', 'Battles', 50));
    const aux = emptyAux();
    aux.ucdpEvents = ucdpWarEvents('Syria');
    aux.iranEvents = Array.from({ length: 50 }, () => ({ lat: 35.0, lon: 38.0, severity: 'critical' }));
    const scores = computeCIIScores(acled, aux);
    for (const s of scores) {
      assert.ok(s.combinedScore <= 100, `${s.region} score ${s.combinedScore} should be <= 100`);
    }
  });

  it('UAE geo events attributed to AE not SA despite bbox overlap', () => {
    const aux = emptyAux();
    aux.gpsHexes = [{ lat: 25.2, lon: 55.3, level: 'high' }];
    const scores = computeCIIScores([], aux);
    const ae = scoreFor(scores, 'AE')!;
    const sa = scoreFor(scores, 'SA')!;
    assert.ok(ae.components!.militaryActivity > 0, 'AE should get the Dubai GPS hex');
    assert.equal(sa.components!.militaryActivity, 0, 'SA should not get the Dubai GPS hex');
  });

  it('empty data returns baseline-derived scores with floors', () => {
    const scores = computeCIIScores([], emptyAux());
    const us = scoreFor(scores, 'US')!;
    assert.ok(us.combinedScore >= 2 && us.combinedScore <= 10, `US baseline score ${us.combinedScore} should be ~2-10`);
  });

  it('clamps negative upstream counts before score math', () => {
    const aux = emptyAux();
    aux.militaryCii = {
      UA: {
        ownFlights: -5,
        foreignFlights: -3,
        ownVessels: -2,
        foreignVessels: -1,
        aisDisruptionHigh: -4,
        aisDisruptionElevated: -8,
        aisDisruptionLow: -13,
      },
    };
    aux.orefData = { activeAlertCount: -5, historyCount24h: -12 };
    aux.threatSummaryByCountry = { UA: { critical: -2, high: -3, medium: -5, low: -8, info: -13 } };
    aux.sanctionsCountryCounts = { UA: -200 };

    const scores = computeCIIScores([acledEvent('Ukraine', 'Battles', -9)], aux, { nowMs: TREND_TEST_NOW });
    const ua = scoreFor(scores, 'UA')!;

    assert.equal(Number.isFinite(ua.combinedScore), true, 'negative fatalities must not produce NaN scores');
    assert.equal(Number.isFinite(ua.components!.ciiContribution), true, 'negative counts must not produce NaN components');
    assert.ok(ua.components!.militaryActivity >= 0, 'negative military counts must not lower security below zero');
    assert.ok(ua.components!.newsActivity >= 0, 'negative threat counts must not lower news below zero');
  });

  it('applies ACLED bucket weights and replays earthquake lookback, trend prior, and computedAt from fixed nowMs', () => {
    const replayNowMs = Date.UTC(2020, 0, 10, 12, 0, 0);
    // ACLED `daysAgo` is computed before computeCIIScores runs; this guards the
    // scorer's bucket weights, not clock-derived ACLED age calculation.
    const recentAcled = [
      { ...acledEvent('United States', 'Protests', 0), daysAgo: 7 },
      { ...acledEvent('United States', 'Battles', 2), daysAgo: 7 },
    ];
    const tailAcled = [
      { ...acledEvent('United States', 'Protests', 0), daysAgo: 8 },
      { ...acledEvent('United States', 'Battles', 2), daysAgo: 8 },
    ];

    const base = scoreFor(computeCIIScores([], emptyAux(), { nowMs: replayNowMs }), 'US')!;
    const recent = scoreFor(computeCIIScores(recentAcled, emptyAux(), { nowMs: replayNowMs }), 'US')!;
    const tail = scoreFor(computeCIIScores(tailAcled, emptyAux(), { nowMs: replayNowMs }), 'US')!;
    assert.equal(base.computedAt, replayNowMs);
    assert.equal(recent.computedAt, replayNowMs);
    assert.equal(tail.computedAt, replayNowMs);
    assert.ok(
      recent.components!.ciiContribution > tail.components!.ciiContribution,
      `0-7d ACLED weight (${recent.components!.ciiContribution}) should exceed 8-30d tail weight (${tail.components!.ciiContribution})`,
    );
    assert.ok(
      tail.components!.ciiContribution > base.components!.ciiContribution,
      '8-30d ACLED bucket still contributes to scoring',
    );

    const withRecentEqAux = emptyAux();
    withRecentEqAux.earthquakes = [
      { magnitude: 7.0, occurredAt: replayNowMs - 24 * 60 * 60 * 1000, location: { latitude: 39, longitude: -98 } },
    ];
    const withStaleEqAux = emptyAux();
    withStaleEqAux.earthquakes = [
      { magnitude: 7.0, occurredAt: replayNowMs - 8 * 24 * 60 * 60 * 1000, location: { latitude: 39, longitude: -98 } },
    ];
    const withRecentEq = scoreFor(computeCIIScores([], withRecentEqAux, { nowMs: replayNowMs }), 'US')!;
    const withStaleEq = scoreFor(computeCIIScores([], withStaleEqAux, { nowMs: replayNowMs }), 'US')!;
    assert.ok(withRecentEq.combinedScore > base.combinedScore, 'earthquake inside fixed 7d replay window raises score');
    assert.equal(withStaleEq.combinedScore, base.combinedScore, 'earthquake outside fixed 7d replay window is ignored');

    const targetSnapshot = trendSnapshot(replayNowMs - CII_TREND_TARGET_AGE_MS);
    targetSnapshot.ciiScores = [priorCiiScore('US', withRecentEq.combinedScore - 5, targetSnapshot.capturedAt)];
    const recentSnapshot = trendSnapshot(replayNowMs - 10 * 60 * 1000);
    recentSnapshot.ciiScores = [priorCiiScore('US', withRecentEq.combinedScore + 40, recentSnapshot.capturedAt)];
    const selectedPrior = selectCiiTrendPriorSnapshot([recentSnapshot, targetSnapshot], replayNowMs);
    const replayed = scoreFor(
      computeCIIScores([], withRecentEqAux, {
        nowMs: replayNowMs,
        priorScores: selectedPrior?.ciiScores ?? null,
      }),
      'US',
    )!;
    assert.equal(selectedPrior, targetSnapshot);
    assert.equal(replayed.computedAt, replayNowMs);
    assert.equal(replayed.dynamicScore, 5);
    assert.equal(replayed.trend, 'TREND_DIRECTION_RISING');
  });

  it('cold-start emits flat movement instead of baseline delta', () => {
    const us = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    assert.notEqual(us.combinedScore - us.staticBaseline, 0, 'fixture should have a non-zero structural baseline gap');
    assert.equal(us.dynamicScore, 0, 'cold-start movement must not reuse combinedScore - staticBaseline');
    assert.equal(us.trend, 'TREND_DIRECTION_STABLE');
  });

  it('derives rising trend and dynamicScore from a prior CII snapshot', () => {
    const current = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    const us = scoreFor(
      computeCIIScores([], emptyAux(), {
        nowMs: TREND_TEST_NOW,
        priorScores: [priorCiiScore('US', current.combinedScore - 5)],
      }),
      'US',
    )!;

    assert.equal(us.dynamicScore, 5);
    assert.equal(us.trend, 'TREND_DIRECTION_RISING');
  });

  it('derives falling trend and negative dynamicScore from a prior CII snapshot', () => {
    const current = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    const us = scoreFor(
      computeCIIScores([], emptyAux(), {
        nowMs: TREND_TEST_NOW,
        priorScores: [priorCiiScore('US', current.combinedScore + 5)],
      }),
      'US',
    )!;

    assert.equal(us.dynamicScore, -5);
    assert.equal(us.trend, 'TREND_DIRECTION_FALLING');
  });

  it('keeps trend stable inside the one-point deadband while preserving the measured delta', () => {
    const current = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    const us = scoreFor(
      computeCIIScores([], emptyAux(), {
        nowMs: TREND_TEST_NOW,
        priorScores: [priorCiiScore('US', current.combinedScore - 1)],
      }),
      'US',
    )!;

    assert.equal(us.dynamicScore, 1);
    assert.equal(us.trend, 'TREND_DIRECTION_STABLE');
  });

  it('rejects live-cache-age prior snapshots when deriving CII movement', () => {
    const current = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    const us = scoreFor(
      computeCIIScores([], emptyAux(), {
        nowMs: TREND_TEST_NOW,
        priorScores: [priorCiiScore('US', current.combinedScore - 10, TREND_TEST_NOW - 10 * 60 * 1000)],
      }),
      'US',
    )!;

    assert.equal(us.dynamicScore, 0);
    assert.equal(us.trend, 'TREND_DIRECTION_STABLE');
  });

  it('ignores stale prior snapshots when deriving CII movement', () => {
    const current = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    const us = scoreFor(
      computeCIIScores([], emptyAux(), {
        nowMs: TREND_TEST_NOW,
        priorScores: [priorCiiScore('US', current.combinedScore - 10, TREND_TEST_NOW - 25 * 60 * 60 * 1000)],
      }),
      'US',
    )!;

    assert.equal(us.dynamicScore, 0);
    assert.equal(us.trend, 'TREND_DIRECTION_STABLE');
  });

  it('targets trend history buckets around the 24-hour comparison window', () => {
    const targetBucket = getCiiTrendHistoryBucket(TREND_TEST_NOW - CII_TREND_TARGET_AGE_MS);
    const currentBucket = getCiiTrendHistoryBucket(TREND_TEST_NOW);
    const buckets = getCiiTrendPriorCandidateBuckets(TREND_TEST_NOW);

    assert.equal(buckets[0], targetBucket);
    assert.equal(new Set(buckets).size, 1 + CII_TREND_BUCKET_LOOKUP_RADIUS * 2);
    assert.equal(buckets.includes(currentBucket), false, 'trend lookup must not target the live cache bucket');
  });

  it('selects the prior snapshot closest to 24 hours and ignores outside-window snapshots', () => {
    const recent = trendSnapshot(TREND_TEST_NOW - 10 * 60 * 1000);
    const outside = trendSnapshot(
      TREND_TEST_NOW - CII_TREND_TARGET_AGE_MS - (CII_TREND_BUCKET_LOOKUP_RADIUS + 1) * CII_TREND_BUCKET_MS,
    );
    const farther = trendSnapshot(TREND_TEST_NOW - CII_TREND_TARGET_AGE_MS - 2 * CII_TREND_BUCKET_MS);
    const closest = trendSnapshot(TREND_TEST_NOW - CII_TREND_TARGET_AGE_MS + CII_TREND_BUCKET_MS);

    assert.equal(selectCiiTrendPriorSnapshot([recent, outside], TREND_TEST_NOW), null);
    assert.equal(selectCiiTrendPriorSnapshot([recent, farther, closest], TREND_TEST_NOW), closest);
  });

  it('handler uses dedicated trend history rather than stale fallback as the movement prior', () => {
    const handlerPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'server',
      'worldmonitor',
      'intelligence',
      'v1',
      'get-risk-scores.ts',
    );
    const handlerSource = readFileSync(handlerPath, 'utf8');
    const freshGateIndex = handlerSource.indexOf("if (source === 'fresh' && leader)");
    const trendPersistIndex = handlerSource.indexOf('persistCiiTrendSnapshot(freshResult)');

    assert.match(handlerSource, /readCiiTrendPriorScores\(nowMs\)/);
    assert.doesNotMatch(handlerSource, /priorRiskScores/);
    assert.match(handlerSource, /recordCiiTrendPriorGap\(nowMs\)/,
      'fresh computations without a valid 24h prior must leave an operator-visible trend gap signal');
    assert.match(handlerSource, /Promise\.all\(writes\.map/,
      'leader-only post-fetch writes should run in parallel instead of serially');
    assert.ok(trendPersistIndex > freshGateIndex, 'trend history writes must be gated to fresh upstream computations');
  });

  it('newsTopStories critical threat boosts newsActivity for attributed country', () => {
    const aux = emptyAux();
    aux.newsTopStories = [
      { countryCode: 'RU', threatLevel: 'critical', primaryTitle: 'Russia launches strikes' },
    ];
    const withNews = scoreFor(computeCIIScores([], aux), 'RU')!;
    const withoutNews = scoreFor(computeCIIScores([], emptyAux()), 'RU')!;
    assert.ok(withNews.components!.newsActivity > 0, 'newsActivity should be > 0 with critical story');
    assert.ok(withNews.combinedScore > withoutNews.combinedScore,
      `RU with critical news (${withNews.combinedScore}) should exceed baseline (${withoutNews.combinedScore})`);
  });

  it('threatSummaryByCountry boosts newsActivity for target country', () => {
    const aux = emptyAux();
    aux.threatSummaryByCountry = { RU: { critical: 3, high: 2, medium: 1, low: 1, info: 0 } };
    const withThreat = scoreFor(computeCIIScores([], aux), 'RU')!;
    const withoutThreat = scoreFor(computeCIIScores([], emptyAux()), 'RU')!;
    assert.ok(withThreat.components!.newsActivity > 0, 'newsActivity should be > 0 with threat summary');
    assert.ok(withThreat.combinedScore > withoutThreat.combinedScore,
      `RU with threat summary (${withThreat.combinedScore}) should exceed baseline (${withoutThreat.combinedScore})`);
  });

  // Cap raised 20 → 100 per issue #3739 — the 20 cap silently limited
  // information's max contribution to 5/25 points despite the equal 0.25 weight.
  it('newsTopStories newsActivity scales above 20 with heavy input and is capped at 100', () => {
    const aux = emptyAux();
    aux.newsTopStories = Array.from({ length: 20 }, () => ({
      countryCode: 'SY', threatLevel: 'critical', primaryTitle: 'Syria conflict escalates',
    }));
    const scores = computeCIIScores([], aux);
    const sy = scoreFor(scores, 'SY')!;
    assert.ok(sy.components!.newsActivity > 20, `newsActivity ${sy.components!.newsActivity} should exceed 20 (cap raised to 100 per #3739)`);
    assert.ok(sy.components!.newsActivity <= 100, `newsActivity ${sy.components!.newsActivity} should be capped at 100`);
  });

  it('threatSummaryByCountry newsActivity is capped at 100 (per-source threatSummaryScore still inner-capped at 20)', () => {
    const aux = emptyAux();
    aux.threatSummaryByCountry = { SY: { critical: 100, high: 100, medium: 100, low: 100, info: 100 } };
    const scores = computeCIIScores([], aux);
    const sy = scoreFor(scores, 'SY')!;
    assert.ok(sy.components!.newsActivity <= 100, `newsActivity ${sy.components!.newsActivity} should be capped at 100`);
  });

  it('newsTopStories moderate threat contributes (not silently dropped)', () => {
    const aux = emptyAux();
    aux.newsTopStories = [
      { countryCode: 'DE', threatLevel: 'moderate', primaryTitle: 'Germany election results' },
    ];
    const withNews = scoreFor(computeCIIScores([], aux), 'DE')!;
    const withoutNews = scoreFor(computeCIIScores([], emptyAux()), 'DE')!;
    assert.ok(withNews.components!.newsActivity > 0, 'moderate threat should produce non-zero newsActivity');
    assert.ok(withNews.combinedScore >= withoutNews.combinedScore,
      `DE with moderate news (${withNews.combinedScore}) should be >= baseline (${withoutNews.combinedScore})`);
  });

  it('newsTopStories null countryCode falls back to title keyword match', () => {
    const aux = emptyAux();
    aux.newsTopStories = [
      { countryCode: null, threatLevel: 'high', primaryTitle: 'Iran launches ballistic missile test' },
    ];
    const withNews = scoreFor(computeCIIScores([], aux), 'IR')!;
    const withoutNews = scoreFor(computeCIIScores([], emptyAux()), 'IR')!;
    assert.ok(withNews.components!.newsActivity > 0, 'null countryCode with Iran keyword should attribute to IR');
    assert.ok(withNews.components!.newsActivity > withoutNews.components!.newsActivity,
      `IR newsActivity with keyword-matched news (${withNews.components!.newsActivity}) should exceed baseline (${withoutNews.components!.newsActivity})`);
  });

  it('newsTopStories info threat is not counted', () => {
    const aux = emptyAux();
    aux.newsTopStories = [
      { countryCode: 'JP', threatLevel: 'info', primaryTitle: 'Japan trade summit scheduled' },
    ];
    const withInfo = scoreFor(computeCIIScores([], aux), 'JP')!;
    const withoutNews = scoreFor(computeCIIScores([], emptyAux()), 'JP')!;
    assert.equal(withInfo.components!.newsActivity, withoutNews.components!.newsActivity,
      'info threat level should not affect newsActivity');
  });

  it('threatSummaryByCountry unknown country code is safely ignored', () => {
    const aux = emptyAux();
    aux.threatSummaryByCountry = { XX: { critical: 10, high: 5, medium: 2, low: 1, info: 0 } };
    assert.doesNotThrow(() => computeCIIScores([], aux), 'unknown country code should not throw');
  });

  it('null threatSummaryByCountry produces zero newsActivity', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const s of scores) {
      assert.equal(s.components!.newsActivity, 0, `${s.region} should have zero newsActivity with null threatSummary`);
    }
  });

  // ===== Disclosure fields (issue #3725) =====

  it('every score carries methodologyVersion === CII_FORMULA_VERSION', () => {
    const scores = computeCIIScores([], emptyAux());
    assert.ok(scores.length > 0, 'expected non-empty score set');
    for (const s of scores) {
      assert.equal(
        (s as unknown as { methodologyVersion: string }).methodologyVersion,
        CII_FORMULA_VERSION,
        `${s.region} methodologyVersion should equal '${CII_FORMULA_VERSION}'`,
      );
      assert.equal(typeof (s as unknown as { methodologyVersion: string }).methodologyVersion, 'string');
    }
  });

  it('every score carries the shared editorial eventMultiplier', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const s of scores) {
      const mult = (s as unknown as { eventMultiplier: number }).eventMultiplier;
      const expected = SHARED_EVENT_MULTIPLIER[s.region as keyof typeof SHARED_EVENT_MULTIPLIER];
      assert.ok(Number.isFinite(mult), `${s.region} eventMultiplier should be finite, got ${mult}`);
      assert.ok(mult > 0, `${s.region} eventMultiplier should be > 0, got ${mult}`);
      assert.ok(mult <= 5, `${s.region} eventMultiplier should be <= 5 (sanity), got ${mult}`);
      assert.equal(mult, expected, `${s.region} eventMultiplier should match shared/cii-weights.ts`);
    }
  });

  it('every score exposes advisoryLevel and advisoryProvenance', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const s of scores) {
      const disclosure = s as unknown as { advisoryLevel: string; advisoryProvenance: string };
      assert.equal(typeof disclosure.advisoryLevel, 'string', `${s.region} advisoryLevel should be a string`);
      assert.match(
        disclosure.advisoryProvenance,
        /^(live|fallback|absent)$/,
        `${s.region} advisoryProvenance should be live, fallback, or absent`,
      );
    }
  });

  it('normalizes pre-provenance cached risk-score payloads before return', () => {
    const scores = computeCIIScores([], emptyAux()).map((score) => {
      const { advisoryLevel: _advisoryLevel, advisoryProvenance: _advisoryProvenance, ...legacyScore } =
        score as typeof score & { advisoryLevel?: string; advisoryProvenance?: string };
      return legacyScore;
    });
    const response = {
      ciiScores: scores,
      strategicRisks: computeStrategicRisks(scores),
      degraded: false,
      stale: false,
    };

    assert.equal(hasCompleteRiskScoreAdvisoryDisclosure(response), false);
    const normalized = normalizeRiskScoreAdvisoryDisclosure(response);
    assert.equal(hasCompleteRiskScoreAdvisoryDisclosure(normalized), true);

    const ua = scoreFor(normalized.ciiScores, 'UA') as unknown as {
      advisoryLevel: string;
      advisoryProvenance: string;
    };
    const us = scoreFor(normalized.ciiScores, 'US') as unknown as {
      advisoryLevel: string;
      advisoryProvenance: string;
    };
    assert.equal(ua.advisoryLevel, 'do-not-travel');
    assert.equal(ua.advisoryProvenance, 'fallback');
    assert.equal(us.advisoryLevel, '');
    assert.equal(us.advisoryProvenance, 'absent');
  });

  it('staticBaseline is in [0, 100] for every score', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const s of scores) {
      assert.ok(s.staticBaseline >= 0 && s.staticBaseline <= 100,
        `${s.region} staticBaseline ${s.staticBaseline} out of [0, 100]`);
    }
  });

  it('server and frontend baseline/multiplier values match shared CII weights for every country', () => {
    const sharedCodes = Object.keys(CII_COUNTRY_WEIGHTS).sort();
    assert.deepEqual(Object.keys(CURATED_COUNTRIES).sort(), sharedCodes,
      'CURATED_COUNTRIES keys must match shared/cii-weights.ts keys');
    assert.deepEqual(Object.keys(TIER1_COUNTRIES).sort(), sharedCodes,
      'frontend TIER1_COUNTRIES keys must match shared/cii-weights.ts keys');
    assert.deepEqual(Object.keys(SERVER_TIER1_COUNTRIES).sort(), sharedCodes,
      'server _shared.ts TIER1_COUNTRIES keys must match shared/cii-weights.ts keys (computeCIIScores iterates this map)');

    const scores = computeCIIScores([], emptyAux());
    for (const code of sharedCodes) {
      const expected = CII_COUNTRY_WEIGHTS[code as keyof typeof CII_COUNTRY_WEIGHTS];
      assert.equal(CURATED_COUNTRIES[code]?.baselineRisk, expected.baselineRisk,
        `${code} frontend baselineRisk should come from shared/cii-weights.ts`);
      assert.equal(CURATED_COUNTRIES[code]?.eventMultiplier, expected.eventMultiplier,
        `${code} frontend eventMultiplier should come from shared/cii-weights.ts`);
      assert.equal(BASELINE_RISK[code], expected.baselineRisk,
        `${code} server BASELINE_RISK should come from shared/cii-weights.ts`);
      assert.equal(EVENT_MULTIPLIER[code], expected.eventMultiplier,
        `${code} server EVENT_MULTIPLIER should come from shared/cii-weights.ts`);
      assert.equal(SHARED_BASELINE_RISK[code as keyof typeof SHARED_BASELINE_RISK], expected.baselineRisk,
        `${code} shared baseline map should be derived from CII_COUNTRY_WEIGHTS`);
      assert.equal(SHARED_EVENT_MULTIPLIER[code as keyof typeof SHARED_EVENT_MULTIPLIER], expected.eventMultiplier,
        `${code} shared multiplier map should be derived from CII_COUNTRY_WEIGHTS`);

      const s = scoreFor(scores, code);
      assert.ok(s, `${code} score missing`);
      assert.equal(s!.staticBaseline, expected.baselineRisk,
        `${code} staticBaseline ${s!.staticBaseline} should match shared baselineRisk ${expected.baselineRisk}`);
      const actualMult = (s as unknown as { eventMultiplier: number }).eventMultiplier;
      assert.equal(actualMult, expected.eventMultiplier,
        `${code} eventMultiplier ${actualMult} should match shared eventMultiplier ${expected.eventMultiplier}`);
    }
  });

  it('CII protocol coefficients are snapshot-keyed to CII_FORMULA_VERSION', () => {
    const expectedHash = CII_PROTOCOL_SNAPSHOT_HASH_BY_VERSION[CII_FORMULA_VERSION];
    assert.ok(
      expectedHash,
      `No CII protocol snapshot for ${CII_FORMULA_VERSION}. Add a new snapshot hash when bumping CII_FORMULA_VERSION.`,
    );

    const cachedRiskSource = readRepoFile('src/services/cached-risk-scores.ts');
    const getRiskScoresSource = readRepoFile('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
    const scoreFormulaLiterals = extractScoreFormulaLiterals(getRiskScoresSource);
    const scoreHelperInputs = extractScoreHelperInputSnapshot(getRiskScoresSource);
    assertFormulaLiteralCovered(scoreFormulaLiterals, 'climateSeverityScore', 5, 'return 5');
    assertFormulaLiteralCovered(scoreFormulaLiterals, 'UCDP_CLASSIFICATION_WINDOW_MS', 2, '2 * 365');
    assertFormulaLiteralCovered(scoreFormulaLiterals, 'deriveUcdpIntensityByRegion', 1000, 'totalDeaths > 1000');
    assertFormulaLiteralCovered(scoreFormulaLiterals, 'deriveUcdpIntensityByRegion', 100, 'eventCount > 100');
    assertFormulaLiteralCovered(scoreFormulaLiterals, 'deriveUcdpIntensityByRegion', 10, 'eventCount > 10');
    assert.equal(
      scoreHelperInputs.ucdpClassificationWindowMs.value,
      2 * 365 * 24 * 60 * 60 * 1000,
      'UCDP classification window must remain a two-year trailing window',
    );
    assertFormulaLiteralCovered(scoreFormulaLiterals, 'computeCIIScores', 0.4, '(ev.daysAgo ?? 0) <= 7 ? 1.0 : 0.4');
    assertFormulaLiteralCovered(scoreFormulaLiterals, 'computeCIIScores', 360, 'safeNonNegativeNum(f.brightness) >= 360');
    assertFormulaLiteralCovered(scoreFormulaLiterals, 'computeCIIScores', 5.5, 'mag < 5.5');
    if (getRiskScoresSource.includes('NEWS_THREAT_WEIGHT')) {
      assertFormulaLiteralCovered(scoreFormulaLiterals, 'NEWS_THREAT_WEIGHT', 4, 'critical: 4');
      assertFormulaLiteralCovered(scoreFormulaLiterals, 'NEWS_THREAT_WEIGHT', 0.5, 'low: 0.5');
    }
    const snapshot = {
      countryWeights: Object.fromEntries(
        Object.entries(CII_COUNTRY_WEIGHTS).sort(([a], [b]) => a.localeCompare(b)),
      ),
      defaultWeight: {
        baselineRisk: DEFAULT_CII_BASELINE_RISK,
        eventMultiplier: DEFAULT_CII_EVENT_MULTIPLIER,
      },
      riskConfig: {
        CII_CONFLICT_ACTIVITY_CAP,
        CII_CONFLICT_ACTIVITY_PIVOT,
        STRATEGIC_RISK_POSITIONAL_DECAY,
        STRATEGIC_RISK_SCALE_FACTOR,
        STRATEGIC_RISK_SCALE_FLOOR,
        STRATEGIC_RISK_TOP_N,
      },
      scoreFormulaLiterals,
      scoreHelperInputs,
      scoreLevelCutoffs: extractScoreLevelCutoffs(cachedRiskSource, 'getScoreLevel'),
    };

    assert.equal(
      hashJson(snapshot),
      expectedHash,
      'CII coefficient/formula/cutoff snapshot changed. Bump CII_FORMULA_VERSION, update methodology docs/changelogs, and add the new version-keyed snapshot hash.',
    );
  });

  it('CII protocol snapshot includes guarded top-level score constants and helpers', () => {
    const literals = extractScoreFormulaLiterals(`
      const UCDP_CLASSIFICATION_WINDOW_MS = 2 * 365 * 24 * 60 * 60 * 1000;
      const NEWS_THREAT_WEIGHT: Record<string, number> = {
        critical: 4,
        high: 2,
        medium: 1,
        low: 0.5,
        info: 0,
      };
      function climateSeverityScore(): number {
        return 5;
      }
      function deriveUcdpIntensityByRegion(): string {
        const totalDeaths = 1001;
        const eventCount = 101;
        if (totalDeaths > 1000 || eventCount > 100) return 'war';
        if (eventCount > 10) return 'minor';
        return 'none';
      }
      export function computeCIIScores(): number {
        return 1;
      }
    `);

    assertFormulaLiteralCovered(literals, 'UCDP_CLASSIFICATION_WINDOW_MS', 2, '2 * 365');
    assertFormulaLiteralCovered(literals, 'NEWS_THREAT_WEIGHT', 4, 'critical: 4');
    assertFormulaLiteralCovered(literals, 'NEWS_THREAT_WEIGHT', 0.5, 'low: 0.5');
    assertFormulaLiteralCovered(literals, 'deriveUcdpIntensityByRegion', 1000, 'totalDeaths > 1000');
    assertFormulaLiteralCovered(literals, 'deriveUcdpIntensityByRegion', 100, 'eventCount > 100');
    assertFormulaLiteralCovered(literals, 'deriveUcdpIntensityByRegion', 10, 'eventCount > 10');
  });

  it('CII helper input snapshot resolves local literal aliases and spreads', () => {
    const helperInputs = extractScoreHelperInputSnapshot(`
      const TWO_YEARS_MS = (2 * 365 * 24 * 60 * 60 * 1000) as const;
      const UCDP_CLASSIFICATION_WINDOW_MS = TWO_YEARS_MS;
      const HIGH_RISK_FALLBACKS = { UA: 'do-not-travel', SY: 'do-not-travel' } as const;
      const CAUTION_FALLBACKS = <Record<string, string>>{ RU: 'caution' };
      const ADVISORY_LEVELS_FALLBACK = {
        ...CAUTION_FALLBACKS,
        ...HIGH_RISK_FALLBACKS,
        IL: 'reconsider',
      } satisfies Record<string, string>;
      const EUROPE_COUNTRIES = ['DE', 'FR'] as const;
      const EXTRA_MIDDLE_EAST_COUNTRIES = ['IL', 'SA'] as const;
      const MIDDLE_EAST_COUNTRIES = ['IR', ...EXTRA_MIDDLE_EAST_COUNTRIES];
      const CLIMATE_ZONE_GROUPS = { Europe: EUROPE_COUNTRIES } satisfies Record<string, readonly string[]>;
      const ZONE_COUNTRY_MAP = {
        ...CLIMATE_ZONE_GROUPS,
        'Middle East': MIDDLE_EAST_COUNTRIES,
      };
    `);

    assert.equal(helperInputs.ucdpClassificationWindowMs.value, 2 * 365 * 24 * 60 * 60 * 1000);
    assert.deepEqual(helperInputs.advisoryLevelsFallback, {
      IL: 'reconsider',
      RU: 'caution',
      SY: 'do-not-travel',
      UA: 'do-not-travel',
    });
    assert.deepEqual(helperInputs.zoneCountryMap, {
      Europe: ['DE', 'FR'],
      'Middle East': ['IR', 'IL', 'SA'],
    });
  });

  it('getScoreLevel uses canonical CII UI bands at 81/66/51/31', () => {
    const cachedRiskSource = readRepoFile('src/services/cached-risk-scores.ts');
    const browserCiiSource = readRepoFile('src/services/country-instability.ts');
    const cachedScoreLevel = parseScoreLevelFunction(cachedRiskSource, 'getScoreLevel');
    const browserScoreLevel = parseScoreLevelFunction(browserCiiSource, 'getLevel');
    const expectedCutoffs = [
      { min: 81, level: 'critical' },
      { min: 66, level: 'high' },
      { min: 51, level: 'elevated' },
      { min: 31, level: 'normal' },
    ];

    assert.deepEqual(cachedScoreLevel.cutoffs, expectedCutoffs);
    assert.deepEqual(browserScoreLevel.cutoffs, expectedCutoffs);
    assert.equal(cachedScoreLevel.fallback, 'low');
    assert.equal(browserScoreLevel.fallback, 'low');

    for (const [score, level] of [
      [81, 'critical'], [80, 'high'],
      [66, 'high'], [65, 'elevated'],
      [51, 'elevated'], [50, 'normal'],
      [31, 'normal'], [30, 'low'],
    ] as const) {
      assert.equal(evaluateScoreLevel(cachedScoreLevel, score), level,
        `cached getScoreLevel(${score}) should be ${level}`);
      assert.equal(evaluateScoreLevel(browserScoreLevel, score), level,
        `browser getLevel(${score}) should be ${level}`);
    }
  });

  // ===== Strategic risk roll-up (issue #3725) =====

  it('computeStrategicRisks: score is in [STRATEGIC_RISK_SCALE_FLOOR, 100]', () => {
    const scores = computeCIIScores([], emptyAux());
    const risks = computeStrategicRisks(scores);
    assert.equal(risks.length, 1);
    const score = risks[0]!.score;
    assert.ok(score >= STRATEGIC_RISK_SCALE_FLOOR && score <= 100,
      `strategic risk ${score} should be in [${STRATEGIC_RISK_SCALE_FLOOR}, 100]`);
  });

  it('computeStrategicRisks: equals STRATEGIC_RISK_SCALE_FLOOR (15) when all CII scores are 0', () => {
    const zeros = Array.from({ length: STRATEGIC_RISK_TOP_N }, (_, i) => ({
      region: `Z${i}`,
      staticBaseline: 0,
      dynamicScore: 0,
      combinedScore: 0,
      trend: 'TREND_DIRECTION_STABLE',
      components: { newsActivity: 0, ciiContribution: 0, geoConvergence: 0, militaryActivity: 0 },
      computedAt: 0,
    })) as unknown as ReturnType<typeof computeCIIScores>;
    const risks = computeStrategicRisks(zeros);
    assert.equal(risks[0]!.score, STRATEGIC_RISK_SCALE_FLOOR,
      `all-zero top-N should yield exactly STRATEGIC_RISK_SCALE_FLOOR (${STRATEGIC_RISK_SCALE_FLOOR}), got ${risks[0]!.score}`);
  });

  it('computeStrategicRisks: empty input does not throw and yields floor score', () => {
    const risks = computeStrategicRisks([]);
    assert.equal(risks.length, 1);
    assert.equal(risks[0]!.score, STRATEGIC_RISK_SCALE_FLOOR);
  });

  it('riskScores health coverage reports zero for total real-time outage', () => {
    const aux = emptyAux();
    const scores = computeCIIScores([], emptyAux());

    assert.equal(scores.length, Object.keys(SERVER_TIER1_COUNTRIES).length);
    assert.equal(
      countScoredRealtimeComponents(scores),
      0,
      'baseline-only CII emits Tier-1 rows but must report zero live signal coverage to seed health',
    );
    assert.equal(
      countCiiRealtimeSignalDensityCoverage([], aux),
      0,
      'no ACLED/news/cyber-style inputs means riskScores seed health must fail closed',
    );
  });

  it('riskScores health coverage ignores slow/static score movers during real-time outage', () => {
    const aux = emptyAux();
    aux.displacedByIso3 = { USA: 5_600_000 };
    aux.sanctionsCountryCounts = { US: 2_500 };
    aux.advisories = { byCountry: { US: 'do-not-travel' } };
    const baseline = scoreFor(computeCIIScores([], emptyAux()), 'US')!;
    const slowOnly = scoreFor(computeCIIScores([], aux), 'US')!;
    const scores = computeCIIScores([], aux);

    assert.ok(
      slowOnly.combinedScore > baseline.combinedScore,
      'slow/static displacement, sanctions, and advisory inputs still move the CII score',
    );
    assert.equal(
      countScoredRealtimeComponents(scores),
      0,
      'slow/static-only score deltas must not count as live component coverage',
    );
    assert.equal(
      countCiiRealtimeSignalDensityCoverage([], aux),
      0,
      'slow/static-only score deltas must not keep /api/health.riskScores green',
    );
  });

  it('riskScores health coverage reports partial when only one required real-time family is alive', () => {
    const aux = emptyAux();
    aux.cyber = [{ country: 'US', severity: 'CRITICALITY_LEVEL_CRITICAL' }];

    assert.equal(
      countCiiRealtimeSignalDensityCoverage([], aux),
      1,
      'one surviving real-time family must stay below the health minRecordCount threshold',
    );
  });

  it('riskScores health coverage counts normal mixed real-time source families', () => {
    const acled = [acledEvent('Ukraine', 'Battles', 0)];
    const aux = emptyAux();
    aux.cyber = [{ country: 'US', severity: 'CRITICALITY_LEVEL_CRITICAL' }];
    aux.newsTopStories = [{ countryCode: 'GB', threatLevel: 'high', primaryTitle: 'UK security alert' }];
    const scores = computeCIIScores(acled, aux);

    assert.equal(
      countScoredRealtimeComponents(scores),
      2,
      'ACLED and news feed scored CII components for UA and GB',
    );
    assert.equal(
      countCiiRealtimeSignalDensityCoverage(acled, aux),
      CII_REALTIME_REQUIRED_SIGNAL_FAMILY_COUNT,
      'health coverage counts ACLED, news, and cyber source families even when cyber lands as supplemental boost',
    );
  });

  it('riskScores health coverage ignores non-Tier-1 realtime family inputs', () => {
    const acled = [acledEvent('Andorra', 'Battles', 0)];
    const aux = emptyAux();
    aux.newsTopStories = [{ countryCode: null, threatLevel: 'high', primaryTitle: 'Andorra security alert' }];
    aux.cyber = [{ country: 'AD', severity: 'CRITICALITY_LEVEL_CRITICAL' }];
    // Non-Tier-1 UCDP events must not satisfy the conflict family either.
    aux.ucdpEvents = ucdpWarEvents('Andorra');

    assert.equal(
      countCiiRealtimeSignalDensityCoverage(acled, aux),
      0,
      'non-Tier-1 ACLED/news/cyber/UCDP inputs must not satisfy Tier-1 CII realtime health coverage',
    );
  });

  it('riskScores conflict family is satisfied by UCDP when the ACLED API path is empty', () => {
    // Production root cause (recordCount=2 → COVERAGE_PARTIAL): the ACLED API path
    // returned zero events while the rich UCDP feed (15+ Tier-1 countries) was healthy.
    // The conflict family must count from EITHER source, so health stays green.
    const aux = emptyAux();
    aux.ucdpEvents = ucdpWarEvents('Ukraine'); // healthy UCDP conflict, no ACLED
    aux.newsTopStories = [{ countryCode: 'GB', threatLevel: 'high', primaryTitle: 'UK security alert' }];
    aux.cyber = [{ country: 'US', severity: 'CRITICALITY_LEVEL_CRITICAL' }];

    assert.equal(
      countCiiRealtimeSignalDensityCoverage([], aux),
      CII_REALTIME_REQUIRED_SIGNAL_FAMILY_COUNT,
      'UCDP must satisfy the conflict family when ACLED is empty so /api/health.riskScores stays green',
    );
  });

  it('riskScores UCDP health coverage ignores future-dated conflict rows', () => {
    const aux = emptyAux();
    aux.ucdpEvents = [ucdpEvent('Ukraine', 1500, TREND_TEST_NOW + 365 * CII_TEST_DAY_MS)];
    aux.newsTopStories = [{ countryCode: 'GB', threatLevel: 'high', primaryTitle: 'UK security alert' }];
    aux.cyber = [{ country: 'US', severity: 'CRITICALITY_LEVEL_CRITICAL' }];

    assert.equal(
      countCiiRealtimeSignalDensityCoverage([], aux, TREND_TEST_NOW),
      2,
      'future-dated UCDP rows must not satisfy the conflict family when ACLED is empty',
    );
  });

  it('riskScores UCDP health coverage uses the supplied clock', () => {
    const aux = emptyAux();
    aux.ucdpEvents = [ucdpEvent('Ukraine', 1500, TREND_TEST_NOW - CII_TEST_DAY_MS)];
    aux.newsTopStories = [{ countryCode: 'GB', threatLevel: 'high', primaryTitle: 'UK security alert' }];
    aux.cyber = [{ country: 'US', severity: 'CRITICALITY_LEVEL_CRITICAL' }];

    const originalDateNow = Date.now;
    Date.now = () => TREND_TEST_NOW + 3 * 365 * 24 * 60 * 60 * 1000;
    try {
      assert.equal(
        countCiiRealtimeSignalDensityCoverage([], aux, TREND_TEST_NOW),
        CII_REALTIME_REQUIRED_SIGNAL_FAMILY_COUNT,
        'UCDP coverage should use the injected health clock instead of the ambient Date.now()',
      );
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('riskScores conflict family stays uncovered when both ACLED and UCDP are empty', () => {
    const aux = emptyAux();
    aux.newsTopStories = [{ countryCode: 'GB', threatLevel: 'high', primaryTitle: 'UK security alert' }];
    aux.cyber = [{ country: 'US', severity: 'CRITICALITY_LEVEL_CRITICAL' }];

    assert.equal(
      countCiiRealtimeSignalDensityCoverage([], aux),
      2,
      'with no ACLED and no UCDP, only news + cyber families count → below minRecordCount',
    );
  });

  it('strategic risk uses positional decay 1 - i * 0.15 (top-5 weights = [1, 0.85, 0.7, 0.55, 0.4])', () => {
    // Two top entries with very different scores should produce a roll-up
    // score that respects the weighted-average — first slot heavier than
    // second by the declared decay step.
    const expected = [1, 0.85, 0.7, 0.55, 0.4];
    for (let i = 0; i < STRATEGIC_RISK_TOP_N; i++) {
      const w = 1 - i * STRATEGIC_RISK_POSITIONAL_DECAY;
      assert.ok(Math.abs(w - expected[i]!) < 1e-9,
        `position ${i} weight ${w} should equal ${expected[i]} given decay ${STRATEGIC_RISK_POSITIONAL_DECAY}`);
    }
    // STRATEGIC_RISK_SCALE_FACTOR sanity (used in the doc).
    assert.equal(STRATEGIC_RISK_SCALE_FACTOR, 0.7,
      `STRATEGIC_RISK_SCALE_FACTOR is documented as 0.7 — bump CII_FORMULA_VERSION and update docs/methodology/cii-risk-scores.mdx if changing.`);
  });

  it('region filter normalizes ISO2 input and omits global strategic risk', () => {
    const ciiScores = computeCIIScores([], emptyAux());
    const response = {
      ciiScores,
      strategicRisks: computeStrategicRisks(ciiScores),
      degraded: false,
      stale: false,
    };

    const filtered = filterRiskScoresResponse(response, ' us ');
    assert.equal(filtered.ciiScores.length, 1);
    assert.equal(filtered.ciiScores[0]!.region, 'US');
    assert.deepEqual(filtered.strategicRisks, [],
      'country-filtered responses must not relabel the global strategic roll-up as country-scoped');
    assert.equal(response.ciiScores.length, ciiScores.length,
      'filtering is a post-cache projection and must not mutate the cached all-country payload');
    assert.equal(response.strategicRisks.length, 1);
  });

  it('region filter returns empty arrays for unknown ISO2 regions', () => {
    const ciiScores = computeCIIScores([], emptyAux());
    const filtered = filterRiskScoresResponse(
      { ciiScores, strategicRisks: computeStrategicRisks(ciiScores), degraded: true, stale: true },
      'zz',
    );

    assert.deepEqual(filtered, { ciiScores: [], strategicRisks: [], degraded: true, stale: true });
  });

  it('region filter leaves empty requests on the all-country response and rejects malformed non-empty input', () => {
    const ciiScores = computeCIIScores([], emptyAux());
    const response = {
      ciiScores,
      strategicRisks: computeStrategicRisks(ciiScores),
      degraded: false,
      stale: false,
    };

    assert.equal(filterRiskScoresResponse(response, '').ciiScores.length, ciiScores.length);
    assert.deepEqual(filterRiskScoresResponse(response, 'USA'), {
      ciiScores: [],
      strategicRisks: [],
      degraded: false,
      stale: false,
    });
  });

  it('handler marks stale-cache and cold-cache fallback responses as degraded', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const source = readFileSync(
      resolve(root, 'server', 'worldmonitor', 'intelligence', 'v1', 'get-risk-scores.ts'),
      'utf8',
    );

    assert.match(
      source,
      /if \(stale\) \{[\s\S]*normalizeRiskScoreAdvisoryDisclosure\(stale\)[\s\S]*\{ degraded: true, stale: true \}[\s\S]*\}/,
      'stale-cache fallback must carry degraded=true and stale=true',
    );
    assert.match(
      source,
      /\{ ciiScores, strategicRisks: computeStrategicRisks\(ciiScores\), degraded: true, stale: false \}/,
      'cold baseline-only fallback must carry degraded=true and stale=false',
    );
  });

  it('handler preserves live cached payloads if advisory backfill rebuild fails', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const source = readFileSync(
      resolve(root, 'server', 'worldmonitor', 'intelligence', 'v1', 'get-risk-scores.ts'),
      'utf8',
    );

    assert.match(
      source,
      /if \(!hasCompleteRiskScoreAdvisoryDisclosure\(freshResult\)\) \{[\s\S]*try \{[\s\S]*buildRiskScoresPayload\(\)[\s\S]*\} catch \{[\s\S]*normalizeRiskScoreAdvisoryDisclosure\(freshResult\)[\s\S]*degraded: false,[\s\S]*stale: false,[\s\S]*\}[\s\S]*\}/,
      'live-cache advisory backfill must fall back to normalized cached data instead of dropping the cache hit',
    );
  });

  it('proto schema constrains advisory_provenance vocabulary', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const proto = readFileSync(
      resolve(root, 'proto', 'worldmonitor', 'intelligence', 'v1', 'intelligence.proto'),
      'utf8',
    );

    assert.match(
      proto,
      /string advisory_provenance = 11 \[\(buf\.validate\.field\)\.string\.pattern = "\^\(live\|fallback\|absent\)\$"\]/,
      'advisory_provenance must publish its fixed live/fallback/absent vocabulary in the proto schema',
    );
  });

  it('proto and OpenAPI CiiComponents descriptions match the server scoring sources', () => {
    const expectedGeo = 'Armed-conflict contribution from ACLED events, fatalities, civilian violence, strikes, and OREF alerts (0-100).';
    const expectedMilitary = 'Security-mobility contribution from military flights, military vessels, aviation disruption, and GPS interference (0-100).';
    const staleSourcePattern = /ACLED\/UCDP|AIS disruption/;

    const proto = readRepoFile('proto/worldmonitor/intelligence/v1/intelligence.proto');
    const protoBlock = proto.match(/message CiiComponents \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(protoBlock, 'intelligence.proto must define CiiComponents.');
    assert.ok(protoBlock.includes(expectedGeo), 'intelligence.proto must describe geo_convergence with current ACLED-only sources.');
    assert.ok(protoBlock.includes(expectedMilitary), 'intelligence.proto must describe military_activity with military vessels.');
    assert.doesNotMatch(protoBlock, staleSourcePattern);

    const serviceOpenApi = JSON.parse(readRepoFile('docs/api/IntelligenceService.openapi.json')) as {
      components?: { schemas?: { CiiComponents?: { properties?: Record<string, { description?: string }> } } };
    };
    const ciiProperties = serviceOpenApi.components?.schemas?.CiiComponents?.properties ?? {};
    assert.equal(ciiProperties.geoConvergence?.description, expectedGeo);
    assert.equal(ciiProperties.militaryActivity?.description, expectedMilitary);

    for (const path of ['docs/api/IntelligenceService.openapi.yaml', 'docs/api/worldmonitor.openapi.yaml']) {
      const openApi = readRepoFile(path);
      const block = openApi.match(/\n {8}[A-Za-z0-9_]*CiiComponents:\n[\s\S]*?(?=\n {8}[A-Za-z][A-Za-z0-9_]*:\n)/)?.[0] ?? '';
      assert.ok(block, `${path} must define CiiComponents.`);
      assert.ok(block.includes(`description: ${expectedGeo}`), `${path} must describe geoConvergence with current ACLED-only sources.`);
      assert.ok(block.includes(`description: ${expectedMilitary}`), `${path} must describe militaryActivity with military vessels.`);
      assert.doesNotMatch(block, staleSourcePattern);
    }
  });

  // ===== Methodology doc drift guard (issue #3725) =====

  it('docs/methodology/cii-risk-scores.mdx lists every CURATED_COUNTRIES code', () => {
    const docPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'docs',
      'methodology',
      'cii-risk-scores.mdx',
    );
    const doc = readFileSync(docPath, 'utf8');
    const missing: string[] = [];
    for (const code of Object.keys(CURATED_COUNTRIES)) {
      // Match `| <CODE> |` in the per-country table.
      if (!new RegExp(`\\|\\s${code}\\s\\|`).test(doc)) missing.push(code);
    }
    assert.equal(missing.length, 0,
      `docs/methodology/cii-risk-scores.mdx is missing rows for: ${missing.join(', ')}. Update the methodology doc and bump CII_FORMULA_VERSION.`);
  });

  it('methodology doc baseline/multiplier columns match BASELINE_RISK and EVENT_MULTIPLIER exactly (numeric drift guard)', () => {
    // PR #3780 review hardening: the previous regex-existence check only
    // verified that a row exists for each code. That lets the doc and the
    // code silently disagree on the numeric values — exactly the kind of
    // drift this whole methodology disclosure was meant to prevent.
    //
    // This stricter test parses each row's numeric columns and asserts they
    // match BASELINE_RISK[code] and EVENT_MULTIPLIER[code] character-for-
    // character. Bump CII_FORMULA_VERSION and update the doc together when
    // either changes.
    const docPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'docs',
      'methodology',
      'cii-risk-scores.mdx',
    );
    const doc = readFileSync(docPath, 'utf8');
    // Parse the per-country table. Rows look like:
    //   | AE | United Arab Emirates | 10 | 1.5 | — |
    // The first non-header table row defines the column count; we tolerate
    // any number of trailing columns (drift notes etc.) but require at least
    // 4 columns: code, name, baseline, multiplier.
    const drifts: string[] = [];
    for (const code of Object.keys(BASELINE_RISK)) {
      // Capture the row for this code. Anchor on `| <CODE> |` then non-greedy
      // up to end-of-line.
      const rowRe = new RegExp(`^\\|\\s${code}\\s\\|([^\\n]+)$`, 'm');
      const m = doc.match(rowRe);
      if (!m) {
        drifts.push(`${code}: no row in methodology doc`);
        continue;
      }
      // Split the remaining row on `|`, strip whitespace.
      const cols = m[1]!.split('|').map((c) => c.trim());
      // cols = [name, baseline, multiplier, driftNote, '']  (5 entries after split)
      // We need cols[1] and cols[2].
      if (cols.length < 4) {
        drifts.push(`${code}: malformed row, expected at least 4 columns, got ${cols.length}`);
        continue;
      }
      const docBaseline = Number(cols[1]);
      const docMultiplier = Number(cols[2]);
      const expectedBaseline = BASELINE_RISK[code]!;
      const expectedMultiplier = EVENT_MULTIPLIER[code]!;
      if (docBaseline !== expectedBaseline) {
        drifts.push(`${code}: baseline doc=${cols[1]} code=${expectedBaseline}`);
      }
      if (docMultiplier !== expectedMultiplier) {
        drifts.push(`${code}: multiplier doc=${cols[2]} code=${expectedMultiplier}`);
      }
    }
    assert.equal(drifts.length, 0,
      `methodology doc drift:\n  ${drifts.join('\n  ')}\nBump CII_FORMULA_VERSION and reconcile docs/methodology/cii-risk-scores.mdx with server BASELINE_RISK / EVENT_MULTIPLIER.`);
  });

  it('every TIER1_COUNTRIES code is listed in the methodology doc (server tables stay in sync)', () => {
    const docPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'docs',
      'methodology',
      'cii-risk-scores.mdx',
    );
    const doc = readFileSync(docPath, 'utf8');
    const missing: string[] = [];
    for (const code of Object.keys(TIER1_COUNTRIES)) {
      if (!new RegExp(`\\|\\s${code}\\s\\|`).test(doc)) missing.push(code);
    }
    assert.equal(missing.length, 0,
      `docs/methodology/cii-risk-scores.mdx is missing rows for TIER1 codes: ${missing.join(', ')}.`);
  });

  it('methodology doc references the current CII_FORMULA_VERSION', () => {
    const docPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'docs',
      'methodology',
      'cii-risk-scores.mdx',
    );
    const doc = readFileSync(docPath, 'utf8');
    assert.ok(doc.includes(`**${CII_FORMULA_VERSION}**`) || doc.includes(`'${CII_FORMULA_VERSION}'`) || doc.includes(`"${CII_FORMULA_VERSION}"`),
      `methodology doc must mention current CII_FORMULA_VERSION '${CII_FORMULA_VERSION}' — bump the version and update the doc together.`);
  });

  it('methodology doc discloses advisory fallback and CII attribution caveats', () => {
    const methodologyDoc = readRepoFile('docs/methodology/cii-risk-scores.mdx');
    const overviewDoc = readRepoFile('docs/country-instability-index.mdx');
    const dataSourcesDoc = readRepoFile('docs/data-sources.mdx');
    const riskScoresSource = readRepoFile('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
    const fallbackBlock = riskScoresSource.match(/const ADVISORY_LEVELS_FALLBACK[\s\S]*?\};/)?.[0] ?? '';
    assert.ok(fallbackBlock, 'get-risk-scores.ts must keep the advisory fallback table inspectable.');

    const fallbackRows = [...fallbackBlock.matchAll(/\b([A-Z]{2}): '([^']+)'/g)]
      .map((match) => ({ code: match[1]!, level: match[2]! }));
    assert.equal(fallbackRows.length, 15, 'advisory fallback table size changed; update methodology disclosure.');

    for (const { code, level } of fallbackRows) {
      const label = level === 'do-not-travel' ? 'Do not travel'
        : level === 'reconsider' ? 'Reconsider'
        : 'Caution';
      assert.match(
        methodologyDoc,
        new RegExp(`^\\| \`${code}\` \\| [^|]+ \\| ${label} \\|`, 'm'),
        `cii-risk-scores.mdx must disclose fallback advisory level for ${code}.`,
      );
    }

    assert.match(
      methodologyDoc,
      /live security-advisory feed[\s\S]{0,160}fallback/i,
      'methodology doc must state that live advisory data wins before fallback.',
    );
    assert.match(
      dataSourcesDoc,
      /Live advisory feed values override the fallback/i,
      'data-sources doc must state that CII advisory fallback does not override live feed values.',
    );
    assert.doesNotMatch(
      dataSourcesDoc,
      /consensus bonus/i,
      'data-sources doc must not preserve the retired server-side consensus bonus claim.',
    );
    assert.match(
      methodologyDoc,
      /`gaza`[\s\S]{0,120}IL/i,
      'methodology doc must disclose that Gaza text fallback routes to IL.',
    );
    assert.match(
      methodologyDoc,
      /min\(50, iranStrikes \* 3 \+ highSeverityStrikes \* 5\)/,
      'methodology doc must disclose the Iran-region strike boost formula.',
    );
    assert.match(
      overviewDoc,
      /Tier-1 membership is curated rather than algorithmic/i,
      'country-instability overview must disclose Tier-1 inclusion criteria.',
    );
  });

  it('public CII docs reference the current RPC route and backend-authoritative v3 conflict curve', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const methodologyDoc = readFileSync(resolve(root, 'docs', 'methodology', 'cii-risk-scores.mdx'), 'utf8');
    const algorithmsDoc = readFileSync(resolve(root, 'docs', 'algorithms.mdx'), 'utf8');

    assert.ok(
      methodologyDoc.includes('GET /api/intelligence/v1/get-risk-scores'),
      'methodology doc must point to the current get-risk-scores RPC route',
    );
    assert.doesNotMatch(
      methodologyDoc,
      /GET \/api\/intelligence\/risk-scores/,
      'methodology doc must not reference the retired pre-RPC CII route',
    );
    assert.match(
      algorithmsDoc,
      /Authoritative CII scores come from the server-side `GET \/api\/intelligence\/v1\/get-risk-scores` RPC/,
      'algorithms doc must identify the server RPC as the authoritative CII source',
    );
    assert.match(
      algorithmsDoc,
      /fallback\/local renderer path after cached backend scores/,
      'algorithms doc must describe frontend scoring as fallback/local rendering after cached backend scores',
    );
    assert.match(
      algorithmsDoc,
      /min\(70, log1p\(rawActivity\) \/ log1p\(4000\) \* 70\)/,
      'algorithms doc must publish the v3 conflict activity cap=70 curve',
    );
    assert.doesNotMatch(
      algorithmsDoc,
      /server-side score .* uses the same formulas as the frontend/i,
      'algorithms doc must not overclaim server/frontend formula parity',
    );
    assert.doesNotMatch(
      algorithmsDoc,
      /Weighted ACLED events .* capped at 50/i,
      'algorithms doc must not describe the server-authoritative v3 conflict activity cap as 50',
    );
  });

  it('public docs separate server Strategic Risk headline from panel additive context', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const algorithmsDoc = readFileSync(resolve(root, 'docs', 'algorithms.mdx'), 'utf8');
    const strategicRiskDoc = readFileSync(resolve(root, 'docs', 'strategic-risk.mdx'), 'utf8');
    const methodologyDoc = readFileSync(resolve(root, 'docs', 'methodology', 'cii-risk-scores.mdx'), 'utf8');

    for (const [label, doc] of [
      ['docs/algorithms.mdx', algorithmsDoc],
      ['docs/strategic-risk.mdx', strategicRiskDoc],
    ] as const) {
      assert.match(
        doc,
        /server(?:-published|-side)? Strategic Risk headline|displayed\/server headline/i,
        `${label} must name the server/displayed headline Strategic Risk score`,
      );
      assert.match(
        doc,
        /top 5 CII|top-5 CII/i,
        `${label} must say the server headline comes from the top-5 CII roll-up`,
      );
      assert.match(
        doc,
        /panel(?:-local)? context|panel context/i,
        `${label} must distinguish additive panel context from the server headline`,
      );
    }
    assert.match(
      methodologyDoc,
      /advisory_provenance[\s\S]*live[\s\S]*fallback[\s\S]*absent/,
      'methodology doc must publish advisory provenance values',
    );
  });

  it('public changelogs document the current CII_FORMULA_VERSION and cache impact', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const changelogs = [
      ['CHANGELOG.md', readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')],
      ['docs/changelog.mdx', readFileSync(resolve(root, 'docs', 'changelog.mdx'), 'utf8')],
    ] as const;

    for (const [label, changelog] of changelogs) {
      assert.match(
        changelog,
        new RegExp(`CII (?:methodology|formula)[^\\n]*${CII_FORMULA_VERSION}`),
        `${label} must publish the CII ${CII_FORMULA_VERSION} entry`,
      );
      assert.ok(
        changelog.includes('combinedScore') &&
        changelog.includes(`risk:scores:sebuf:${CII_FORMULA_VERSION}`) &&
        changelog.includes(`methodology_version`) &&
        changelog.includes(CII_FORMULA_VERSION),
        `${label} must describe combinedScore, cache-key, and methodology_version impact`,
      );
    }
  });

  it('public changelogs retain the CII v4 attribution/source semantics entry', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const changelogs = [
      ['CHANGELOG.md', readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')],
      ['docs/changelog.mdx', readFileSync(resolve(root, 'docs', 'changelog.mdx'), 'utf8')],
    ] as const;

    for (const [label, changelog] of changelogs) {
      const normalizedChangelog = changelog.replace(/\s+/g, ' ');
      assert.match(
        changelog,
        /CII (?:methodology|formula)[^\n]*`?v4`?/,
        `${label} must retain the CII v4 changelog entry`,
      );
      for (const requiredText of [
        'token exact-match',
        '4.5_week',
        'country-count map',
        'combinedScore',
        'risk:scores:sebuf:v4',
        'methodology_version',
      ]) {
        assert.ok(
          normalizedChangelog.includes(requiredText),
          `${label} CII v4 entry must mention ${requiredText}`,
        );
      }
    }
  });

  it('CII dynamicScore contract allows signed 24-hour movement deltas', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const proto = readFileSync(resolve(root, 'proto', 'worldmonitor', 'intelligence', 'v1', 'intelligence.proto'), 'utf8');
    const serviceOpenapi = readFileSync(resolve(root, 'docs', 'api', 'IntelligenceService.openapi.yaml'), 'utf8');
    const unifiedOpenapi = readFileSync(resolve(root, 'docs', 'api', 'worldmonitor.openapi.yaml'), 'utf8');

    assert.match(
      proto,
      /Approximate 24-hour score movement delta \(-100 to 100\)[\s\S]*double dynamic_score = 3 \[[\s\S]*double\.gte = -100,[\s\S]*double\.lte = 100/,
      'proto CiiScore.dynamic_score must be a signed 24-hour movement delta, not a non-negative real-time score',
    );
    for (const [label, yaml] of [
      ['IntelligenceService.openapi.yaml', serviceOpenapi],
      ['worldmonitor.openapi.yaml', unifiedOpenapi],
    ] as const) {
      const dynamicScoreBlock = yaml.match(/dynamicScore:\n(?: {20}.+\n)+/);
      assert.ok(dynamicScoreBlock, `${label} must expose CiiScore.dynamicScore`);
      assert.match(dynamicScoreBlock[0], /minimum: -100/, `${label} dynamicScore minimum must allow falling deltas`);
      assert.match(dynamicScoreBlock[0], /maximum: 100/, `${label} dynamicScore maximum must cap rising deltas`);
      assert.match(dynamicScoreBlock[0], /Approximate 24-hour score movement delta \(-100 to 100\)/, `${label} dynamicScore description must match proto semantics`);
      assert.doesNotMatch(dynamicScoreBlock[0], /Dynamic real-time score \(0-100\)/, `${label} must not retain stale non-negative dynamicScore prose`);
    }
  });

  it('current public CII docs do not reintroduce pre-v3 stale claims', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const publicDocPaths = [
      'docs/country-instability-index.mdx',
      'docs/strategic-risk.mdx',
      'docs/algorithms.mdx',
      'docs/overview.mdx',
      'docs/features.mdx',
      'docs/methodology/cii-risk-scores.mdx',
      'docs/Docs_To_Review/DOCUMENTATION.md',
      'docs/COMMUNITY-PROMOTION-GUIDE.md',
    ];
    const stalePatterns = [
      /\b(?:20|22|24)\s+(?:curated\s+)?(?:monitored\s+|strategically\s+significant\s+)?(?:Tier[- ]?1\s+)?(?:countries|nations)\b/i,
      /\b(?:20|22|24)\s+(?:curated\s+)?tier[- ]?1\b/i,
      /Information\s+score:\s+Reserved\s+\(0\)/i,
      /Information\s*\|\s*25%\s*\|\s*Reserved\s+\(0\)/i,
      /known\s+7-country\s+server\s+vs\s+frontend\s+drift/i,
      /relay\s+CII\s+seed\s+loop\s+is\s+disabled/i,
      /GPS[-/ ]only\s+security/i,
      /GPS\s+jamming\s+only/i,
      /dynamicScore[\s\S]{0,120}composite\s+−\s+staticBaseline/i,
      /dynamicScore[\s\S]{0,120}composite\s+-\s+staticBaseline/i,
      new RegExp(`\\bCII\\s+(?!${CII_FORMULA_VERSION}\\b)v\\d+\\s+(?:stability|stress|instability|scores?|formula)`, 'i'),
      new RegExp(`\\b(?:full|the)\\s+(?!${CII_FORMULA_VERSION}\\b)v\\d+\\s+formula\\b`, 'i'),
      new RegExp(`methodology_version\\s*\\(\\s*\`?(?!${CII_FORMULA_VERSION}\\b)v\\d+\`?\\s*\\)`, 'i'),
      /CII\s+v3\s+stability\s+scores/i,
      /real-time\s+CII\s+v3\s+instability\s+score/i,
      /Computes\s+CII\s+v3\s+scores/i,
      /Subsequent\s+changes\s+of\s+±5\s+points\s+trigger\s+trend\s+changes/i,
      /score\s+increased\s+by\s+at\s+least\s+5\s+points/i,
      /change\s+is\s+within\s+5\s+points/i,
      /score\s+decreased\s+by\s+at\s+least\s+5\s+points/i,
    ];

    const violations: string[] = [];
    for (const relPath of publicDocPaths) {
      const text = readFileSync(resolve(root, relPath), 'utf8');
      for (const pattern of stalePatterns) {
        if (pattern.test(text)) violations.push(`${relPath}: ${pattern}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `public CII docs contain pre-v3 stale claims:\n  ${violations.join('\n  ')}`,
    );
  });

  it('methodology doc and browser CII engine expose the current conflict curve coefficients', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const doc = readFileSync(resolve(root, 'docs', 'methodology', 'cii-risk-scores.mdx'), 'utf8');
    const browserSource = readFileSync(resolve(root, 'src', 'services', 'country-instability.ts'), 'utf8');

    assert.ok(
      doc.includes(`cap = ${CII_CONFLICT_ACTIVITY_CAP}`) && doc.includes(`pivot = ${CII_CONFLICT_ACTIVITY_PIVOT}`),
      'methodology doc must publish the current conflict activity curve cap and pivot',
    );
    assert.ok(
      browserSource.includes(`const CII_CONFLICT_ACTIVITY_CAP = ${CII_CONFLICT_ACTIVITY_CAP}`),
      'browser CII engine conflict activity cap must match server _risk-config.ts',
    );
    assert.ok(
      browserSource.includes(`const CII_CONFLICT_ACTIVITY_PIVOT = ${CII_CONFLICT_ACTIVITY_PIVOT}`),
      'browser CII engine conflict activity pivot must match server _risk-config.ts',
    );
  });

  it('risk-score Redis payload keys are derived from the CII formula version', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const source = readFileSync(
      resolve(root, 'server', 'worldmonitor', 'intelligence', 'v1', 'get-risk-scores.ts'),
      'utf8',
    );
    assert.match(
      source,
      /RISK_CACHE_KEY\s*=\s*`risk:scores:sebuf:\$\{CII_FORMULA_VERSION\}`/,
      `live CII cache key must derive from CII_FORMULA_VERSION ${CII_FORMULA_VERSION}`,
    );
    assert.match(
      source,
      /RISK_STALE_CACHE_KEY\s*=\s*`risk:scores:sebuf:stale:\$\{CII_FORMULA_VERSION\}`/,
      `stale CII cache key must derive from CII_FORMULA_VERSION ${CII_FORMULA_VERSION}`,
    );
    assert.match(
      source,
      /RISK_TREND_HISTORY_CACHE_KEY_PREFIX\s*=\s*`risk:scores:sebuf:trend-history:\$\{CII_FORMULA_VERSION\}`/,
      `trend-history CII cache key must derive from CII_FORMULA_VERSION ${CII_FORMULA_VERSION}`,
    );
  });

  it('downstream CII risk-score consumers use the current cache key family', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const expectedLiveKey = `risk:scores:sebuf:${CII_FORMULA_VERSION}`;
    const expectedStaleKey = `risk:scores:sebuf:stale:${CII_FORMULA_VERSION}`;
    const expectedTrendPrefix = `risk:scores:sebuf:trend-history:${CII_FORMULA_VERSION}`;
    const keyPattern = /risk:scores:sebuf(?::(?:stale|trend-history))?:v\d+/g;
    const consumers: Array<{ relPath: string; expectedKeys?: string[]; expectedRefs?: string[] }> = [
      {
        relPath: 'api/_cii-risk-cache-keys.js',
        expectedKeys: [expectedLiveKey, expectedStaleKey, expectedTrendPrefix],
      },
      {
        relPath: 'api/_cii-risk-cache-keys.d.ts',
        expectedKeys: [expectedLiveKey, expectedStaleKey, expectedTrendPrefix],
      },
      {
        relPath: 'scripts/_cii-risk-cache-keys.mjs',
        expectedKeys: [expectedLiveKey, expectedStaleKey, expectedTrendPrefix],
      },
      {
        relPath: 'server/_shared/cache-keys.ts',
        expectedKeys: [expectedLiveKey, expectedStaleKey, expectedTrendPrefix],
        expectedRefs: ['riskScores:       CII_RISK_SCORE_CACHE_KEYS.stale'],
      },
      { relPath: 'api/bootstrap.js', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'api/health.js', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale', 'CII_RISK_SCORE_CACHE_KEYS.live'] },
      { relPath: 'api/mcp/registry/cache-tools.ts', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'server/worldmonitor/intelligence/v1/brief-story-context.ts', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'server/worldmonitor/intelligence/v1/chat-analyst-context.ts', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'server/worldmonitor/intelligence/v1/get-country-risk.ts', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'scripts/seed-cross-source-signals.mjs', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'scripts/seed-forecasts.mjs', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'scripts/regional-snapshot/balance-vector.mjs', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'scripts/regional-snapshot/evidence-collector.mjs', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'scripts/regional-snapshot/freshness.mjs', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'scripts/regional-snapshot/trigger-evaluator.mjs', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'tests/mcp-bootstrap-parity.test.mjs', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.live', 'CII_RISK_SCORE_CACHE_KEYS.stale'] },
      { relPath: 'tests/regional-snapshot.test.mjs', expectedRefs: ['CII_RISK_SCORE_CACHE_KEYS.stale'] },
    ];

    const violations: string[] = [];
    for (const { relPath, expectedKeys = [], expectedRefs = [] } of consumers) {
      const source = readFileSync(resolve(root, relPath), 'utf8');
      for (const expectedKey of expectedKeys) {
        if (!source.includes(expectedKey)) violations.push(`${relPath}: missing ${expectedKey}`);
      }
      for (const expectedRef of expectedRefs) {
        if (!source.includes(expectedRef)) violations.push(`${relPath}: missing ${expectedRef}`);
      }
      for (const match of source.matchAll(keyPattern)) {
        if (!expectedKeys.includes(match[0])) violations.push(`${relPath}: stale ${match[0]}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `CII risk-score cache consumers must track ${CII_FORMULA_VERSION}:\n  ${violations.join('\n  ')}`,
    );
  });

  it('legacy browser CII engine no longer carries the old compression formulas', () => {
    const sourcePath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'src',
      'services',
      'country-instability.ts',
    );
    const src = readFileSync(sourcePath, 'utf8');
    assert.ok(
      !src.includes('Math.min(60, h.eventsPoliticalViolence * 3 * multiplier)'),
      'browser HAPI fallback must not hard-cap moderate and extreme political-violence counts at the same value',
    );
    assert.ok(
      !src.includes('data.displacementOutflow >= 1_000_000 ? 8'),
      'browser displacement boost must not use the old +4/+8 two-tier scale',
    );
    assert.ok(
      !src.includes('20 * multiplier'),
      'browser news alert boost must not amplify salience with country eventMultiplier',
    );
  });
});
