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

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupePipelines } from './_pipeline-dedup.mjs';
import { validateRegistry } from './_pipeline-registry.mjs';

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
 * Resolve `lastEvidenceUpdate` for emitted candidates. Prefers the
 * operator-recorded `downloadedAt` (or `sourceVersion` if it parses) so
 * two parser runs on the same input produce byte-identical output.
 * Falls back to the unix-epoch sentinel `1970-01-01` rather than
 * `new Date()` — the fallback is deliberately ugly so anyone reviewing
 * the data file sees that the operator forgot to set the date and re-runs.
 *
 * @param {Record<string, unknown>} envelope
 */
function resolveEvidenceTimestamp(envelope) {
  const candidates = [envelope.downloadedAt, envelope.sourceVersion];
  for (const v of candidates) {
    if (typeof v === 'string') {
      // Accept full ISO strings OR bare YYYY-MM-DD; coerce to midnight-UTC.
      const isoMatch = v.match(/^\d{4}-\d{2}-\d{2}/);
      if (isoMatch) return `${isoMatch[0]}T00:00:00Z`;
    }
  }
  // Sentinel: GEM data SHOULD always carry downloadedAt per the operator
  // runbook. If neither field is present, surface the gap loudly via the
  // epoch date — it'll show up obviously in the diff.
  return '1970-01-01T00:00:00Z';
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
  // Compute once per parse run so every emitted candidate gets the SAME
  // timestamp — and so two runs on identical input produce byte-identical
  // JSON (Greptile P2 on PR #3397: previous use of `new Date().toISOString()`
  // made re-running the parser produce a noisy diff every time).
  const evidenceTimestamp = resolveEvidenceTimestamp(obj);

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
        lastEvidenceUpdate: evidenceTimestamp,
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

/**
 * Read an existing registry file and return its parsed envelope.
 * @param {string} filename
 */
function loadExistingRegistry(filename) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const path = resolvePath(__dirname, 'data', filename);
  const raw = readFileSync(path, 'utf-8');
  return { path, envelope: JSON.parse(raw) };
}

/**
 * Build (but do NOT write) a merged registry envelope. Pure: no disk I/O.
 * Throws on validation failure so the caller can short-circuit before any
 * file is written.
 *
 * @param {string} filename - 'pipelines-gas.json' or 'pipelines-oil.json'
 * @param {any[]} candidates - parser output for that fuel
 * @returns {{ path: string, mergedEnvelope: any, added: number, skipped: number, total: number }}
 */
function prepareMerge(filename, candidates) {
  const { path, envelope } = loadExistingRegistry(filename);
  const existing = Object.values(envelope.pipelines ?? {});
  const { toAdd, skippedDuplicates } = dedupePipelines(existing, candidates);

  // Append in a stable order (alphabetical-by-id) so repeated runs produce
  // a clean diff. Hand-curated rows keep their original ordering at the top.
  const appended = [...toAdd].sort((a, b) => a.id.localeCompare(b.id));
  const mergedPipelines = { ...envelope.pipelines };
  for (const p of appended) mergedPipelines[p.id] = p;

  const mergedEnvelope = {
    ...envelope,
    source: envelope.source?.includes('Global Energy Monitor')
      ? envelope.source
      : `${envelope.source ?? 'Hand-curated'} + Global Energy Monitor (CC-BY 4.0)`,
    pipelines: mergedPipelines,
  };

  if (!validateRegistry(mergedEnvelope)) {
    throw new Error(
      `prepareMerge: merged ${filename} would FAIL validateRegistry. ` +
      `Aborting before writing to disk. Inspect the diff with --print-candidates first.`,
    );
  }

  return {
    path,
    mergedEnvelope,
    added: toAdd.length,
    skipped: skippedDuplicates.length,
    total: Object.keys(mergedPipelines).length,
  };
}

/**
 * Cross-file-atomic merge: builds AND validates BOTH gas + oil envelopes
 * before writing EITHER file. If oil validation fails after gas already
 * succeeded, neither is written — prevents the half-imported state where
 * gas has GEM rows on disk but oil doesn't.
 *
 * Two-phase: prepare both → write both. Pure prepare phase, side-effecting
 * write phase. Order of writes is stable (gas first, oil second), but the
 * "validate everything before any write" guarantee is what prevents
 * partial state on failure.
 *
 * @returns {{ gas: ReturnType<typeof prepareMerge>, oil: ReturnType<typeof prepareMerge> }}
 */
function mergeBothRegistries(gasCandidates, oilCandidates) {
  // Phase 1: prepare + validate BOTH. If either throws, neither file is
  // touched on disk.
  const gas = prepareMerge('pipelines-gas.json', gasCandidates);
  const oil = prepareMerge('pipelines-oil.json', oilCandidates);

  // Phase 2: both validated → write both.
  writeFileSync(gas.path, JSON.stringify(gas.mergedEnvelope, null, 2) + '\n');
  writeFileSync(oil.path, JSON.stringify(oil.mergedEnvelope, null, 2) + '\n');

  return { gas, oil };
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
    try {
      // mergeBothRegistries validates BOTH envelopes before writing
      // either — so a validation failure on oil after gas succeeded
      // leaves neither file modified on disk. Prevents the half-imported
      // state the previous per-file flow could produce.
      const { gas: gasResult, oil: oilResult } = mergeBothRegistries(gas, oil);
      console.error(`gas: +${gasResult.added} added, ${gasResult.skipped} duplicates skipped, ${gasResult.total} total`);
      console.error(`oil: +${oilResult.added} added, ${oilResult.skipped} duplicates skipped, ${oilResult.total} total`);
      console.error(
        `Wrote merged data to scripts/data/pipelines-{gas,oil}.json. ` +
        `Inspect the diff before committing. Per the operator runbook, ` +
        `also update MIN_PIPELINES_PER_REGISTRY in scripts/_pipeline-registry.mjs ` +
        `to a sensible new floor (e.g. 200) once the data is in.`,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  } else {
    console.error('Pass --print-candidates (dry run) or --merge (write to data files).');
    process.exit(1);
  }
}
