import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { transformSync } from 'esbuild';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const countryInstabilityPath = resolve(root, 'src/services/country-instability.ts');
const serverRiskScoresPath = resolve(root, 'server/worldmonitor/intelligence/v1/get-risk-scores.ts');
const crossModulePath = resolve(root, 'src/services/cross-module-integration.ts');
const cachedRiskScoresPath = resolve(root, 'src/services/cached-risk-scores.ts');

const countryInstabilitySource = readFileSync(countryInstabilityPath, 'utf8');
const serverRiskScoresSource = readFileSync(serverRiskScoresPath, 'utf8');
const crossModuleSource = readFileSync(crossModulePath, 'utf8');
const cachedRiskScoresSource = readFileSync(cachedRiskScoresPath, 'utf8');

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

function propertyNameText(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  assert.fail(`unsupported ZONE_COUNTRY_MAP key syntax: ${name.getText(sourceFile)}`);
}

function extractTopLevelStringArrayRecord(
  source: string,
  fileName: string,
  constName: string,
): Record<string, string[]> {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = findTopLevelConstDeclaration(sourceFile, constName);
  assert.ok(declaration, `${fileName} must declare top-level const ${constName}`);
  assert.ok(declaration.initializer, `${fileName} ${constName} must have an initializer`);
  assert.ok(
    ts.isObjectLiteralExpression(declaration.initializer),
    `${fileName} ${constName} must be an object literal`,
  );

  const out: Record<string, string[]> = {};
  for (const property of declaration.initializer.properties) {
    assert.ok(
      ts.isPropertyAssignment(property),
      `${fileName} ${constName} must only contain property assignments`,
    );
    assert.ok(
      ts.isArrayLiteralExpression(property.initializer),
      `${fileName} ${constName}.${property.name.getText(sourceFile)} must be an array literal`,
    );

    out[propertyNameText(property.name, sourceFile)] = property.initializer.elements.map((element) => {
      assert.ok(
        ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element),
        `${fileName} ${constName}.${property.name.getText(sourceFile)} entries must be string literals`,
      );
      return element.text;
    });
  }
  return out;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

async function loadCountryInstability() {
  const patched = countryInstabilitySource
    .replace(
      "import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';",
      `const tokenizeForMatch = (value: string) => value.toLowerCase().split(/\\W+/).filter(Boolean);
const matchKeyword = (tokens: string[], keyword: string) => tokens.includes(keyword.toLowerCase());`,
    )
    .replace(
      "import { INTEL_HOTSPOTS, CONFLICT_ZONES, STRATEGIC_WATERWAYS } from '@/config/geo';",
      'const INTEL_HOTSPOTS: any[] = []; const CONFLICT_ZONES: any[] = []; const STRATEGIC_WATERWAYS: any[] = [];',
    )
    .replace(
      "import { CURATED_COUNTRIES, DEFAULT_BASELINE_RISK, DEFAULT_EVENT_MULTIPLIER, getHotspotCountries } from '@/config/countries';",
      `const CURATED_COUNTRIES: Record<string, any> = {
  US: { name: "United States", scoringKeywords: ["united", "states", "america"], baselineRisk: 10, eventMultiplier: 0.5 },
};
const DEFAULT_BASELINE_RISK = 5;
const DEFAULT_EVENT_MULTIPLIER = 1;
const getHotspotCountries = (_: string) => [];`,
    )
    .replace(
      "export { TIER1_COUNTRIES } from '@/config/countries';",
      'export const TIER1_COUNTRIES: Record<string, string> = { US: "United States" };',
    )
    .replace(
      "import { focalPointDetector } from './focal-point-detector';",
      'const focalPointDetector = { getCountryUrgencyMap: () => new Map(), getCountryUrgency: (_: string) => null };',
    )
    .replace(
      "import { getCountryAtCoordinates, iso3ToIso2Code, nameToCountryCode, getCountryNameByCode, matchCountryNamesInText, ME_STRIKE_BOUNDS, resolveCountryFromBounds } from './country-geometry';",
      `const getCountryAtCoordinates = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) ? { code: "US", name: "United States" } : null;
const iso3ToIso2Code = (_: string) => null;
const nameToCountryCode = (name: string) => ({ "united states": "US", usa: "US", america: "US" } as Record<string, string>)[name.toLowerCase()] ?? null;
const getCountryNameByCode = (code: string) => ({ US: "United States" } as Record<string, string>)[code] ?? null;
const matchCountryNamesInText = (_: string) => [];
const ME_STRIKE_BOUNDS = {};
const resolveCountryFromBounds = (_lat: number, _lon: number, _bounds: unknown) => null;`,
    );

  const transformed = transformSync(patched, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`;
  return (await import(dataUrl)) as {
    clearCountryData: () => void;
    calculateCII: () => Array<{ code: string; score: number }>;
    getCountryScore: (code: string) => number | null;
    getCountryData: (code: string) => {
      sanctionsEntryCount: number;
      sanctionsNewEntryCount: number;
      climateStress: number;
    } | undefined;
    hasAnyIntelligenceData: () => boolean;
    ingestSanctionsForCII: (countries: Array<{ countryCode: string; entryCount: number; newEntryCount: number }>) => void;
    ingestEarthquakesForCII: (earthquakes: Array<{ magnitude: number; occurredAt: number; location: { latitude: number; longitude: number } }>, now?: number) => void;
    ingestCyberThreatsForCII: (threats: Array<{ country: string; severity: string; lat: number; lon: number }>) => void;
    ingestClimateForCII: (anomalies: Array<{ zone: string; severity: 'normal' | 'moderate' | 'extreme' }>) => void;
  };
}

describe('frontend CII closeout regressions', () => {
  it('getCountryScore uses the same earthquake and sanctions blend as calculateCII', async () => {
    const cii = await loadCountryInstability();
    cii.clearCountryData();

    const now = Date.now();
    cii.ingestEarthquakesForCII([
      { magnitude: 7.0, occurredAt: now, location: { latitude: 39, longitude: -98 } },
    ], now);
    cii.ingestSanctionsForCII([
      { countryCode: 'US', entryCount: 60, newEntryCount: 1 },
      { countryCode: 'US', entryCount: 60, newEntryCount: 0 },
    ]);

    const tableScore = cii.calculateCII().find((score) => score.code === 'US')?.score;
    assert.equal(cii.getCountryScore('US'), tableScore);
  });

  it('frontend sanctions ingestion accumulates duplicate ISO2 rows', async () => {
    const cii = await loadCountryInstability();
    cii.clearCountryData();

    cii.ingestSanctionsForCII([
      { countryCode: 'US', entryCount: 60, newEntryCount: 1 },
      { countryCode: 'US', entryCount: 60, newEntryCount: 0 },
    ]);

    const data = cii.getCountryData('US');
    assert.equal(data?.sanctionsEntryCount, 120);
    assert.equal(data?.sanctionsNewEntryCount, 1);
  });

  it('hasAnyIntelligenceData recognizes newer local CII signals', async () => {
    const cii = await loadCountryInstability();
    cii.clearCountryData();
    assert.equal(cii.hasAnyIntelligenceData(), false);

    cii.ingestCyberThreatsForCII([
      { country: 'US', severity: 'critical', lat: 39, lon: -98 },
    ]);
    assert.equal(cii.hasAnyIntelligenceData(), true);

    cii.clearCountryData();
    cii.ingestSanctionsForCII([{ countryCode: 'US', entryCount: 1, newEntryCount: 0 }]);
    assert.equal(cii.hasAnyIntelligenceData(), true);
  });

  it('frontend climate fallback maps producer zones into CII country stress', async () => {
    const cii = await loadCountryInstability();
    cii.clearCountryData();

    cii.ingestClimateForCII([
      { zone: 'California', severity: 'extreme' },
      { zone: 'Amazon', severity: 'moderate' },
      { zone: 'Taiwan Strait', severity: 'extreme' },
      { zone: 'Caribbean', severity: 'moderate' },
      { zone: 'Europe', severity: 'extreme' },
      { zone: 'East Asia', severity: 'extreme' },
      { zone: 'Latin America', severity: 'moderate' },
    ]);

    assert.equal(cii.getCountryData('US')?.climateStress, 15);
    assert.equal(cii.getCountryData('BR')?.climateStress, 8);
    assert.equal(cii.getCountryData('TW')?.climateStress, 15);
    assert.equal(cii.getCountryData('CN')?.climateStress, 15);
    assert.equal(cii.getCountryData('MX')?.climateStress, 8);
    assert.equal(cii.getCountryData('CU')?.climateStress, 8);
    assert.equal(cii.getCountryData('PL')?.climateStress, 15);
    assert.equal(cii.getCountryData('DE')?.climateStress, 15);
    assert.equal(cii.getCountryData('FR')?.climateStress, 15);
    assert.equal(cii.getCountryData('GB')?.climateStress, 15);
    assert.equal(cii.getCountryData('UA')?.climateStress, 15);
    assert.equal(cii.getCountryData('TR')?.climateStress, 15);
    assert.equal(cii.getCountryData('KP')?.climateStress, 15);
    assert.equal(cii.getCountryData('KR')?.climateStress, 15);
    assert.equal(cii.getCountryData('JP')?.climateStress, 15);
    assert.equal(cii.getCountryData('VE')?.climateStress, 8);
  });

  it('frontend climate fallback accepts backend-named CII climate zones', async () => {
    const cii = await loadCountryInstability();
    cii.clearCountryData();

    cii.ingestClimateForCII([
      { zone: 'North America', severity: 'moderate' },
      { zone: 'Russia', severity: 'extreme' },
      { zone: 'North Africa', severity: 'moderate' },
      { zone: 'South Asia', severity: 'extreme' },
    ]);

    assert.equal(cii.getCountryData('US')?.climateStress, 8);
    assert.equal(cii.getCountryData('RU')?.climateStress, 15);
    assert.equal(cii.getCountryData('EG')?.climateStress, 8);
    assert.equal(cii.getCountryData('MM')?.climateStress, 15);
  });

  it('browser and server CII climate zone maps stay in lockstep', () => {
    const browserMap = extractTopLevelStringArrayRecord(
      countryInstabilitySource,
      'src/services/country-instability.ts',
      'ZONE_COUNTRY_MAP',
    );
    const serverMap = extractTopLevelStringArrayRecord(
      serverRiskScoresSource,
      'server/worldmonitor/intelligence/v1/get-risk-scores.ts',
      'ZONE_COUNTRY_MAP',
    );

    assert.deepEqual(sortRecord(browserMap), sortRecord(serverMap));
  });
});

describe('cached CII names', () => {
  it('cached risk score adapter derives country names from the shared Tier-1 table', () => {
    assert.match(
      cachedRiskScoresSource,
      /import\s+\{\s*TIER1_COUNTRIES\s+\}\s+from\s+'@\/config\/countries';/,
    );
    assert.doesNotMatch(cachedRiskScoresSource, /const\s+TIER1_NAMES\b/);
  });
});

describe('cross-module CII alert labeling', () => {
  it('highest-component labeling includes conflict-led CII changes', () => {
    assert.match(crossModuleSource, /Conflict Activity/);
    assert.match(crossModuleSource, /\{\s*unrest,\s*conflict,\s*security,\s*information\s*\}\s*=\s*score\.components/);
  });
});
