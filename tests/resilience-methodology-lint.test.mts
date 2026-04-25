import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  RESILIENCE_DIMENSION_ORDER,
  type ResilienceDimensionId,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

// T1.8 Phase 1 of the country-resilience reference-grade upgrade plan.
//
// Enforces parity between the published methodology document and the
// indicator registry in _dimension-scorers.ts. Every scorer must have a
// documented subsection; every documented subsection must map to a real
// scorer. This prevents the methodology doc from drifting silently when
// a new dimension lands (a forever risk on composite indices per the
// OECD/JRC handbook).
//
// The linter is location-agnostic: it looks for the methodology file at
// a short list of candidate paths and prefers the newer .mdx path once
// T1.3 lands on main. This keeps T1.8 independent of T1.3's merge order.

const METHODOLOGY_CANDIDATES = [
  'docs/methodology/country-resilience-index.mdx',
  'docs/methodology/resilience-index.md',
];

// Mapping from H4 subsection headings used in the methodology doc to the
// canonical dimension IDs used by the scorer. Hardcoded deliberately so
// the test file is the single source of truth for how the doc labels map
// to scorer IDs; if a new dimension lands, this map must be updated at
// the same time as the scorer and the doc, which is exactly the drift
// prevention we want. The test fails loudly if either side of this map
// desyncs.
const HEADING_TO_DIMENSION: Readonly<Record<string, ResilienceDimensionId>> = {
  'Macro-Fiscal': 'macroFiscal',
  'Currency & External': 'currencyExternal',
  'Trade Policy': 'tradePolicy',
  'Cyber & Digital': 'cyberDigital',
  'Logistics & Supply': 'logisticsSupply',
  'Infrastructure': 'infrastructure',
  'Energy': 'energy',
  'Governance': 'governanceInstitutional',
  'Social Cohesion': 'socialCohesion',
  'Border Security': 'borderSecurity',
  'Information & Cognitive': 'informationCognitive',
  'Health & Public Service': 'healthPublicService',
  'Food & Water': 'foodWater',
  'Fiscal Space': 'fiscalSpace',
  'Reserve Adequacy': 'reserveAdequacy',
  'External Debt Coverage': 'externalDebtCoverage',
  'Import Concentration': 'importConcentration',
  'State Continuity': 'stateContinuity',
  'Fuel Stock Days': 'fuelStockDays',
  'Liquid Reserve Adequacy': 'liquidReserveAdequacy',
  'Sovereign Fiscal Buffer': 'sovereignFiscalBuffer',
};

function findMethodologyFile(): string {
  for (const candidate of METHODOLOGY_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Methodology file not found. Looked for: ${METHODOLOGY_CANDIDATES.join(', ')}. ` +
    `The linter must be able to find at least one methodology document to validate.`,
  );
}

function extractH4Headings(source: string): string[] {
  // Matches lines of the form `#### <text>` and captures the text.
  // Ignores nested # (H5+) and H3 domain headers so the linter only
  // checks dimension-level subsections.
  const pattern = /^####\s+(.+?)\s*$/gm;
  const headings: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    headings.push(match[1]);
  }
  return headings;
}

describe('resilience methodology doc linter (T1.8)', () => {
  const methodologyPath = findMethodologyFile();
  const source = readFileSync(methodologyPath, 'utf8');
  const headings = extractH4Headings(source);

  it(`locates a methodology file (${methodologyPath})`, () => {
    assert.ok(source.length > 0, 'methodology file should be non-empty');
    assert.ok(headings.length > 0, 'methodology file should contain at least one H4 subsection');
  });

  it('every dimension in RESILIENCE_DIMENSION_ORDER has a documented subsection', () => {
    const documentedIds = new Set(
      headings
        .map((heading) => HEADING_TO_DIMENSION[heading])
        .filter((id): id is ResilienceDimensionId => id != null),
    );

    const missing = RESILIENCE_DIMENSION_ORDER.filter((id) => !documentedIds.has(id));

    assert.deepEqual(
      missing,
      [],
      `Dimensions in RESILIENCE_DIMENSION_ORDER without a matching subsection in ${methodologyPath}: ${missing.join(', ')}. ` +
      `Add an H4 heading for each missing dimension (see HEADING_TO_DIMENSION in this test file for the expected heading text) ` +
      `or update RESILIENCE_DIMENSION_ORDER if the dimension was removed.`,
    );
  });

  it('every H4 subsection in the methodology maps to a real scorer dimension', () => {
    const knownDimensionIds = new Set<string>(RESILIENCE_DIMENSION_ORDER);
    const stale = headings.filter((heading) => {
      const id = HEADING_TO_DIMENSION[heading];
      return id != null && !knownDimensionIds.has(id);
    });

    assert.deepEqual(
      stale,
      [],
      `Methodology subsections whose mapped dimension no longer exists in RESILIENCE_DIMENSION_ORDER: ${stale.join(', ')}. ` +
      `Either restore the dimension to the scorer or remove the subsection from ${methodologyPath}.`,
    );
  });

  it('every H4 subsection is either a mapped dimension or explicitly non-dimension', () => {
    // Catches typos and new subsections that are not yet wired up. A
    // non-dimension heading is allowed only if it is clearly not a
    // dimension name (e.g., a sub-section under Data Sources). The
    // strict interpretation here is: any H4 heading must be in the
    // mapping. If a future edit adds a legitimate non-dimension H4
    // (rare), either upgrade it to H3 or add an explicit allowlist.
    const unmapped = headings.filter((heading) => HEADING_TO_DIMENSION[heading] == null);
    assert.deepEqual(
      unmapped,
      [],
      `H4 subsections in ${methodologyPath} that do not map to a known dimension via HEADING_TO_DIMENSION: ${unmapped.join(', ')}. ` +
      `Either (a) add an entry to HEADING_TO_DIMENSION in this test file if it is a real dimension, ` +
      `or (b) promote the section to H3 if it is a non-dimension subsection, or ` +
      `(c) fix the typo.`,
    );
  });

  it('HEADING_TO_DIMENSION covers exactly the scorer dimensions (no extras, no missing)', () => {
    const mappedIds = new Set(Object.values(HEADING_TO_DIMENSION));
    const registryIds = new Set(RESILIENCE_DIMENSION_ORDER);

    const mappedNotInRegistry = [...mappedIds].filter((id) => !registryIds.has(id));
    const registryNotMapped = [...registryIds].filter((id) => !mappedIds.has(id));

    assert.deepEqual(
      mappedNotInRegistry,
      [],
      `HEADING_TO_DIMENSION maps to dimension IDs that are not in RESILIENCE_DIMENSION_ORDER: ${mappedNotInRegistry.join(', ')}`,
    );
    assert.deepEqual(
      registryNotMapped,
      [],
      `RESILIENCE_DIMENSION_ORDER contains dimensions that are not in HEADING_TO_DIMENSION: ${registryNotMapped.join(', ')}`,
    );
  });
});
