// @ts-check
//
// One-shot import: GEM Oil & Gas Infrastructure Trackers (CC-BY 4.0) →
// scripts/data/pipelines-{gas,oil}.json shape.
//
// PROVENANCE / OPERATOR-MEDIATED:
//   This script is INTENTIONALLY local-file-only — it does NOT fetch GEM at
//   runtime. The GEM download URL changes per release; a hardcoded URL would
//   silently fetch a different version than the one we attribute. The
//   operator runs:
//
//     1. Visit https://globalenergymonitor.org/projects/global-oil-gas-infrastructure-tracker/
//        (registration required for direct download even though the data
//        itself is CC-BY 4.0 licensed).
//     2. Download the latest gas + oil tracker Excel workbooks.
//     3. Pre-convert each workbook's primary sheet to JSON (Numbers /
//        pandas / csvkit / equivalent) using the canonical column names
//        documented in REQUIRED_COLUMNS below. Country names should be
//        pre-mapped to ISO 3166-1 alpha-2 codes during conversion.
//     4. Save the JSON to a local path and run this script with:
//          GEM_PIPELINES_FILE=/path/to/gem.json node scripts/import-gem-pipelines.mjs --merge
//     5. Record the GEM release date + download URL + file SHA256 in the
//        commit message and docs/methodology/pipelines.mdx, per the
//        seed-imf-external.mjs provenance pattern.
//
// EXECUTION MODES:
//   --print-candidates  : parse + print candidates as JSON to stdout (dry run)
//   --merge             : parse, dedupe against existing pipelines-{gas,oil}.json,
//                         write merged JSON to disk, abort on validate failure
//
// NO xlsx DEPENDENCY: the operator pre-converts externally; this keeps the
// runtime dependency surface tight and avoids the known CVE history of the
// xlsx package for a quarterly one-shot operation.

import { readFileSync } from 'node:fs';

/**
 * Canonical input columns. The operator's Excel-to-JSON conversion must
 * preserve these EXACT key names for each row in `pipelines[]`. Schema-drift
 * sentinel below throws on missing keys before any data is emitted.
 */
export const REQUIRED_COLUMNS = [
  'name',
  'operator',
  'fuel',          // 'Natural Gas' | 'Oil'
  'fromCountry',   // ISO 3166-1 alpha-2
  'toCountry',     // ISO 3166-1 alpha-2
  'transitCountries', // string[] (may be empty)
  'capacity',
  'capacityUnit',  // 'bcm/y' | 'bbl/d' | 'Mbd'
  'lengthKm',
  'status',        // GEM Status string (mapped below)
  'startLat',
  'startLon',
  'endLat',
  'endLon',
];

/**
 * Maps GEM status strings to our `physicalState` enum.
 * Default: 'unknown' — falls into the "treat as not commissioned" bucket.
 */
const STATUS_MAP = {
  Operating: 'flowing',
  Operational: 'flowing',
  Construction: 'unknown',
  Proposed: 'unknown',
  Cancelled: 'offline',
  Mothballed: 'offline',
  Idle: 'offline',
  'Shut-in': 'offline',
};

/**
 * Maps GEM `product` field to our `productClass` enum (oil only).
 */
const PRODUCT_CLASS_MAP = {
  'Crude Oil': 'crude',
  Crude: 'crude',
  'Refined Products': 'products',
  'Petroleum Products': 'products',
  Products: 'products',
  Mixed: 'mixed',
  'Crude/Products': 'mixed',
};

const VALID_LAT = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const VALID_LON = (v) => Number.isFinite(v) && v >= -180 && v <= 180;

function slugify(name, country) {
  const base = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base}-${country.toLowerCase()}`;
}

function inferFuel(row) {
  const f = String(row.fuel ?? '').toLowerCase();
  if (f.includes('gas')) return 'gas';
  if (f.includes('oil') || f.includes('crude') || f.includes('petroleum')) return 'oil';
  return null;
}

function mapStatus(gemStatus) {
  return STATUS_MAP[gemStatus] ?? 'unknown';
}

function mapProductClass(rawProduct) {
  if (!rawProduct) return 'crude'; // conservative default per plan U2
  const cls = PRODUCT_CLASS_MAP[rawProduct];
  if (cls) return cls;
  // Best-effort substring match for Excel column variations
  const lower = rawProduct.toLowerCase();
  if (lower.includes('crude') && lower.includes('product')) return 'mixed';
  if (lower.includes('crude')) return 'crude';
  if (lower.includes('product') || lower.includes('refined')) return 'products';
  return 'crude';
}

function convertCapacityToBcmYr(value, unit) {
  if (unit === 'bcm/y' || unit === 'bcm/yr') return Number(value);
  // Future: add bcf/d → bcm/y conversion if needed. Throw loudly so the
  // operator notices instead of silently writing zeros.
  throw new Error(`Unsupported gas capacity unit: ${unit}. Expected 'bcm/y'.`);
}

function convertCapacityToMbd(value, unit) {
  // Schema convention: capacityMbd is in MILLION barrels per day (e.g. CPC
  // pipeline = 1.4 Mbd = 1.4M bbl/day). So conversions:
  //   'Mbd'   → preserved
  //   'bbl/d' → divide by 1_000_000
  //   'kbd'   → divide by 1_000 (rare)
  if (unit === 'Mbd') return Number(value);
  if (unit === 'bbl/d') return Number(value) / 1_000_000;
  if (unit === 'kbd') return Number(value) / 1_000;
  throw new Error(`Unsupported oil capacity unit: ${unit}. Expected 'Mbd' / 'bbl/d' / 'kbd'.`);
}

/**
 * Parse a GEM-shape JSON object into our two-registry candidate arrays.
 *
 * @param {unknown} data
 * @returns {{ gas: any[], oil: any[] }}
 * @throws {Error} on schema drift, malformed input, or unknown capacity units.
 */
export function parseGemPipelines(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('parseGemPipelines: input must be an object');
  }
  const obj = /** @type {Record<string, unknown>} */ (data);
  if (!Array.isArray(obj.pipelines)) {
    throw new Error('parseGemPipelines: input must contain pipelines[] array');
  }

  // Schema sentinel: assert every required column is present on every row.
  // GEM occasionally renames columns between releases; the operator's
  // conversion step is supposed to normalize, but we double-check here so
  // a missed rename fails loud instead of producing silent zero-data.
  for (const [i, row] of obj.pipelines.entries()) {
    if (!row || typeof row !== 'object') {
      throw new Error(`parseGemPipelines: pipelines[${i}] is not an object`);
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    for (const col of REQUIRED_COLUMNS) {
      if (!(col in r)) {
        throw new Error(
          `parseGemPipelines: schema drift — pipelines[${i}] missing column "${col}". ` +
          `Re-run the operator's Excel→JSON conversion using the canonical ` +
          `column names documented in scripts/import-gem-pipelines.mjs::REQUIRED_COLUMNS.`,
        );
      }
    }
  }

  const gas = [];
  const oil = [];
  const droppedReasons = { fuel: 0, coords: 0, capacity: 0 };

  for (const row of obj.pipelines) {
    const r = /** @type {Record<string, any>} */ (row);
    const fuel = inferFuel(r);
    if (!fuel) {
      droppedReasons.fuel++;
      continue;
    }

    const startLat = Number(r.startLat);
    const startLon = Number(r.startLon);
    const endLat = Number(r.endLat);
    const endLon = Number(r.endLon);
    if (!VALID_LAT(startLat) || !VALID_LON(startLon) || !VALID_LAT(endLat) || !VALID_LON(endLon)) {
      droppedReasons.coords++;
      continue;
    }

    let capacityField, capacityValue;
    try {
      if (fuel === 'gas') {
        capacityField = 'capacityBcmYr';
        capacityValue = convertCapacityToBcmYr(r.capacity, r.capacityUnit);
      } else {
        capacityField = 'capacityMbd';
        capacityValue = convertCapacityToMbd(r.capacity, r.capacityUnit);
      }
    } catch (err) {
      // Unsupported unit → drop the row; let the operator notice via the count
      // delta in dry-run output. Throwing would abort the entire run on a
      // single bad row, which is too brittle.
      droppedReasons.capacity++;
      continue;
    }
    if (!Number.isFinite(capacityValue) || capacityValue <= 0) {
      droppedReasons.capacity++;
      continue;
    }

    const id = slugify(r.name, r.fromCountry);
    const transitCountries = Array.isArray(r.transitCountries)
      ? r.transitCountries.filter((c) => typeof c === 'string')
      : [];

    const candidate = {
      id,
      name: r.name,
      operator: r.operator,
      commodityType: fuel,
      fromCountry: r.fromCountry,
      toCountry: r.toCountry,
      transitCountries,
      [capacityField]: capacityValue,
      lengthKm: Number(r.lengthKm) || 0,
      inService: Number(r.startYear) || 0,
      startPoint: { lat: startLat, lon: startLon },
      endPoint: { lat: endLat, lon: endLon },
      evidence: {
        physicalState: mapStatus(r.status),
        physicalStateSource: 'gem',
        operatorStatement: null,
        commercialState: 'unknown',
        sanctionRefs: [],
        lastEvidenceUpdate: new Date().toISOString().slice(0, 10) + 'T00:00:00Z',
        classifierVersion: 'gem-import-v1',
        classifierConfidence: 0.4,
      },
    };

    if (fuel === 'oil') {
      candidate.productClass = mapProductClass(r.product);
    }

    (fuel === 'gas' ? gas : oil).push(candidate);
  }

  return { gas, oil };
}

/**
 * Read a GEM-shape JSON file and return parsed candidates. Returns the same
 * shape as parseGemPipelines but accepts a file path instead of an in-memory
 * object — useful for CLI and dedup pipelines.
 *
 * @param {string} filePath
 * @returns {{ gas: any[], oil: any[] }}
 */
export function loadGemPipelinesFromFile(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `parseGemPipelines: file at ${filePath} is not valid JSON. ` +
      `Did the operator pre-convert the GEM Excel correctly?`,
    );
  }
  return parseGemPipelines(data);
}

// CLI entry point: only fires when this file is the entry script.
if (process.argv[1] && process.argv[1].endsWith('import-gem-pipelines.mjs')) {
  const filePath = process.env.GEM_PIPELINES_FILE;
  if (!filePath) {
    console.error('GEM_PIPELINES_FILE env var not set. See script header for operator runbook.');
    process.exit(1);
  }
  const args = new Set(process.argv.slice(2));
  const { gas, oil } = loadGemPipelinesFromFile(filePath);
  if (args.has('--print-candidates')) {
    process.stdout.write(JSON.stringify({ gas, oil }, null, 2) + '\n');
  } else if (args.has('--merge')) {
    console.error(
      '--merge is the dedup/merge step. Run scripts/_pipeline-dedup.mjs after parsing. ' +
      'TODO: wire dedup invocation here once U3 lands.',
    );
    process.exit(2);
  } else {
    console.error('Pass --print-candidates (dry run) or --merge (write to data files).');
    process.exit(1);
  }
}
