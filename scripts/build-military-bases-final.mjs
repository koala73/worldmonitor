/**
 * Merges, deduplicates and enriches military base data from multiple sources
 * into a single final dataset for the map layer.
 *
 * Input files (scripts/data/):
 *   - pizzint-processed.json   (79K primary — has wiki + categories)
 *   - osm-military-processed.json (53K secondary)
 *   - mirta-processed.json     (832 tertiary)
 *   - curated-bases.json       (224 extracted from bases-expanded.ts)
 *
 * Output: scripts/data/military-bases-final.json
 *
 * Run: node scripts/build-military-bases-final.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DATA_DIR = path.join(projectRoot, 'scripts', 'data');

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------
const PIZZINT_PATH = path.join(DATA_DIR, 'pizzint-processed.json');
const OSM_PATH = path.join(DATA_DIR, 'osm-military-processed.json');
const MIRTA_PATH = path.join(DATA_DIR, 'mirta-processed.json');
const CURATED_PATH = path.join(DATA_DIR, 'curated-bases.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'military-bases-final.json');
const DEDUP_LOG_PATH = path.join(DATA_DIR, 'dedup-dropped-pairs.json');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROXIMITY_THRESHOLD_M = 200;
const EARTH_RADIUS_M = 6_371_000;

const NATO_MEMBERS = new Set([
  'GB', 'DE', 'FR', 'IT', 'CA', 'ES', 'PL', 'NL', 'BE', 'NO', 'DK', 'PT',
  'TR', 'GR', 'CZ', 'HU', 'RO', 'BG', 'HR', 'SK', 'SI', 'LV', 'LT', 'EE',
  'AL', 'ME', 'MK', 'FI', 'SE',
]);

const COUNTRY_TYPE_MAP = {
  US: 'us-nato',
  CN: 'china',
  RU: 'russia',
  GB: 'uk',
  FR: 'france',
  IN: 'india',
  IT: 'italy',
  AE: 'uae',
  TR: 'turkey',
  JP: 'japan',
};

const TIER1_KINDS = new Set([
  'base', 'airfield', 'naval_base', 'training_area', 'nuclear_explosion_site',
]);

const TIER2_KINDS = new Set([
  'military', 'barracks', 'office', 'checkpoint',
]);

const TIER3_KINDS = new Set([
  'bunker', 'trench', 'shelter', 'ammunition', 'obstacle_course',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadJson(filepath, label) {
  if (!existsSync(filepath)) {
    console.warn(`  WARNING: ${label} not found at ${filepath} — skipping`);
    return null;
  }
  const raw = readFileSync(filepath, 'utf-8');
  const data = JSON.parse(raw);
  console.log(`  Loaded ${label}: ${Array.isArray(data) ? data.length : 'N/A'} entries`);
  return data;
}

function stripHtml(str) {
  if (!str || typeof str !== 'string') return str || '';
  return str.replace(/<[^>]*>/g, '').trim();
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function assignType(countryIso2) {
  if (!countryIso2) return 'other';
  const iso = countryIso2.toUpperCase();
  if (COUNTRY_TYPE_MAP[iso]) return COUNTRY_TYPE_MAP[iso];
  if (iso === 'US') return 'us-nato';
  if (NATO_MEMBERS.has(iso)) return 'us-nato';
  return 'other';
}

function assignTier(kind, source) {
  if (source === 'mirta') return 1;
  if (!kind) return 2;
  const k = kind.toLowerCase();
  if (TIER1_KINDS.has(k)) return 1;
  if (TIER2_KINDS.has(k)) return 2;
  if (TIER3_KINDS.has(k)) return 3;
  return 2;
}

function osmElementType(osmId) {
  if (!osmId || typeof osmId !== 'string') return 'unknown';
  if (osmId.startsWith('way/') || osmId.startsWith('relation/')) return 'area';
  if (osmId.startsWith('node/')) return 'node';
  return 'unknown';
}

function nameMatch(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

function deriveCategoriesFromKind(kind, name) {
  const k = (kind || '').toLowerCase();
  const n = (name || '').toLowerCase();
  return {
    catAirforce: k.includes('airfield'),
    catNaval: k.includes('naval_base'),
    catNuclear: k.includes('nuclear_explosion_site'),
    catSpace: /space|launch|satellite/i.test(n),
    catTraining: k.includes('training_area') || k.includes('range'),
  };
}

function normalizePizzintEntry(row) {
  return {
    id: row.osm_id || '',
    name: stripHtml(row.name_en || row.name || ''),
    lat: row.lat,
    lon: row.lon,
    kind: row.kind || 'military',
    countryIso2: (row.country_iso2 || '').toUpperCase(),
    type: '', // assigned later
    tier: 0,  // assigned later
    source: 'pizzint',
    catAirforce: !!row.cat_airforce,
    catNaval: !!row.cat_naval,
    catNuclear: !!row.cat_nuclear,
    catSpace: !!row.cat_space,
    catTraining: !!row.cat_training,
    branch: row.branch || '',
    status: row.status || row.state || '',
    _osmId: row.osm_id || '',
  };
}

function normalizeOsmEntry(row) {
  const cats = deriveCategoriesFromKind(row.kind, row.name);
  return {
    id: row.osm_id || row.id || '',
    name: stripHtml(row.name_en || row.name || ''),
    lat: row.lat,
    lon: row.lon,
    kind: row.kind || row.type || 'military',
    countryIso2: (row.country_iso2 || row.country_code || row.country || '').toUpperCase(),
    type: '',
    tier: 0,
    source: 'osm',
    catAirforce: cats.catAirforce,
    catNaval: cats.catNaval,
    catNuclear: cats.catNuclear,
    catSpace: cats.catSpace,
    catTraining: cats.catTraining,
    branch: row.branch || '',
    status: row.status || '',
    _osmId: row.osm_id || row.id || '',
  };
}

function normalizeMirtaEntry(row) {
  return {
    id: row.id || row.osm_id || `mirta:${row.name || 'unknown'}`,
    name: stripHtml(row.name || ''),
    lat: row.lat || row.latitude,
    lon: row.lon || row.longitude,
    kind: row.kind || row.type || 'base',
    countryIso2: (row.country_iso2 || row.country_code || row.country || 'US').toUpperCase(),
    type: '',
    tier: 1, // all MIRTA are tier 1
    source: 'mirta',
    catAirforce: !!row.cat_airforce,
    catNaval: !!row.cat_naval,
    catNuclear: !!row.cat_nuclear,
    catSpace: !!row.cat_space,
    catTraining: !!row.cat_training,
    branch: row.branch || '',
    status: row.status || 'active',
    _osmId: row.osm_id || row.id || '',
  };
}

function normalizeCuratedEntry(row) {
  return {
    id: row.id || '',
    name: stripHtml(row.name || ''),
    lat: row.lat,
    lon: row.lon,
    kind: 'base',
    countryIso2: '', // curated uses country name, not iso2
    type: row.type || 'other',
    tier: 1,
    source: 'curated',
    catAirforce: false,
    catNaval: false,
    catNuclear: false,
    catSpace: false,
    catTraining: false,
    branch: row.arm || '',
    status: row.status || 'active',
    _curatedType: row.type || '',
    _country: row.country || '',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  console.log('build-military-bases-final');
  console.log('='.repeat(60));
  console.log('');
  console.log('Loading input files...');

  const pizzintRaw = loadJson(PIZZINT_PATH, 'pizzint-processed.json');
  const osmRaw = loadJson(OSM_PATH, 'osm-military-processed.json');
  const mirtaLoaded = loadJson(MIRTA_PATH, 'mirta-processed.json');
  // MIRTA has { metadata, installations } wrapper — unwrap to array
  const mirtaRaw = mirtaLoaded && !Array.isArray(mirtaLoaded) && mirtaLoaded.installations
    ? mirtaLoaded.installations
    : mirtaLoaded;
  if (mirtaRaw) console.log(`  MIRTA unwrapped: ${mirtaRaw.length} installations`);
  const curatedRaw = loadJson(CURATED_PATH, 'curated-bases.json');

  if (!pizzintRaw && !osmRaw) {
    console.error('FATAL: at least one of pizzint-processed.json or osm-military-processed.json is required.');
    process.exit(1);
  }

  console.log('');

  // -------------------------------------------------------------------------
  // Step 1: Normalize primary dataset (pizzint if available, otherwise OSM)
  // -------------------------------------------------------------------------
  const merged = [];
  const osmIdSet = new Set();

  if (pizzintRaw) {
    console.log('Step 1: Normalize pizzint entries (primary)...');
    for (const row of pizzintRaw) {
      if (row.lat == null || row.lon == null) continue;
      const entry = normalizePizzintEntry(row);
      merged.push(entry);
      if (entry._osmId) osmIdSet.add(entry._osmId);
    }
    console.log(`  Pizzint base: ${merged.length} entries`);
  } else {
    console.log('Step 1: Pizzint data not available — using OSM as primary');
  }

  // -------------------------------------------------------------------------
  // Step 2: Merge OSM entries not already in pizzint
  // -------------------------------------------------------------------------
  let osmAdded = 0;
  let osmSkipped = 0;
  if (osmRaw) {
    console.log('Step 2: Merge OSM entries...');
    for (const row of osmRaw) {
      if (row.lat == null || row.lon == null) continue;
      const osmId = row.osm_id || row.id || '';
      if (osmId && osmIdSet.has(osmId)) {
        osmSkipped++;
        continue;
      }
      const entry = normalizeOsmEntry(row);
      merged.push(entry);
      if (entry._osmId) osmIdSet.add(entry._osmId);
      osmAdded++;
    }
    console.log(`  OSM added: ${osmAdded}, skipped (already in pizzint): ${osmSkipped}`);
  } else {
    console.log('Step 2: OSM data not available — skipped');
  }

  // -------------------------------------------------------------------------
  // Step 3: Merge MIRTA entries not already matched
  // -------------------------------------------------------------------------
  let mirtaAdded = 0;
  let mirtaSkipped = 0;
  if (mirtaRaw) {
    console.log('Step 3: Merge MIRTA entries...');
    for (const row of mirtaRaw) {
      const lat = row.lat || row.latitude;
      const lon = row.lon || row.longitude;
      if (lat == null || lon == null) continue;
      const mirtaId = row.id || row.osm_id || '';
      const mirtaPrefixed = mirtaId ? `mirta:${mirtaId}` : '';
      if (mirtaId && osmIdSet.has(mirtaId)) {
        mirtaSkipped++;
        continue;
      }
      if (mirtaPrefixed && osmIdSet.has(mirtaPrefixed)) {
        mirtaSkipped++;
        continue;
      }
      // Check for mirta: prefix in existing osm_ids
      let alreadyPresent = false;
      for (const existingId of osmIdSet) {
        if (existingId.startsWith('mirta:') && existingId === mirtaPrefixed) {
          alreadyPresent = true;
          break;
        }
      }
      if (alreadyPresent) {
        mirtaSkipped++;
        continue;
      }
      const entry = normalizeMirtaEntry(row);
      merged.push(entry);
      if (entry._osmId) osmIdSet.add(entry._osmId);
      mirtaAdded++;
    }
    console.log(`  MIRTA added: ${mirtaAdded}, skipped (already matched): ${mirtaSkipped}`);
  } else {
    console.log('Step 3: MIRTA data not available — skipped');
  }

  // -------------------------------------------------------------------------
  // Step 4: Merge curated bases by proximity + name fuzzy match
  // -------------------------------------------------------------------------
  let curatedEnriched = 0;
  let curatedUnmatched = 0;
  if (curatedRaw) {
    console.log('Step 4: Merge curated bases (proximity + name match)...');
    for (const row of curatedRaw) {
      if (row.lat == null || row.lon == null) continue;
      const curated = normalizeCuratedEntry(row);
      let matched = false;

      for (const existing of merged) {
        const dist = haversineMeters(curated.lat, curated.lon, existing.lat, existing.lon);
        if (dist <= PROXIMITY_THRESHOLD_M && nameMatch(curated.name, existing.name)) {
          // Enrich existing entry with curated type
          if (curated._curatedType) {
            existing.type = curated._curatedType;
          }
          if (curated.branch && !existing.branch) {
            existing.branch = curated.branch;
          }
          if (curated.status && !existing.status) {
            existing.status = curated.status;
          }
          curatedEnriched++;
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Add as new entry
        merged.push(curated);
        curatedUnmatched++;
      }
    }
    console.log(`  Curated enriched existing: ${curatedEnriched}, added as new: ${curatedUnmatched}`);
  } else {
    console.log('Step 4: curated-bases.json not found — skipping curated enrichment');
  }

  console.log(`\n  Pre-dedup total: ${merged.length}`);

  // -------------------------------------------------------------------------
  // Dedup Pass 1: Exact osm_id dedup — prefer way/relation over node
  // -------------------------------------------------------------------------
  console.log('\nDedup Pass 1: Exact osm_id dedup...');
  const dedupDropped = [];
  const byOsmId = new Map();

  for (const entry of merged) {
    const oid = entry._osmId;
    if (!oid) {
      // No osm_id — keep
      if (!byOsmId.has('__no_id_' + Math.random())) {
        byOsmId.set('__noid_' + merged.indexOf(entry), entry);
      }
      continue;
    }
    // Extract numeric part for dedup (way/12345 vs node/12345 are different)
    if (byOsmId.has(oid)) {
      const existing = byOsmId.get(oid);
      const existType = osmElementType(existing._osmId);
      const newType = osmElementType(entry._osmId);
      // Prefer way/relation over node
      if (existType === 'node' && newType === 'area') {
        dedupDropped.push({
          pass: 1,
          kept: { id: entry.id, name: entry.name, source: entry.source },
          dropped: { id: existing.id, name: existing.name, source: existing.source },
          reason: 'exact osm_id — prefer area over node',
        });
        byOsmId.set(oid, entry);
      } else {
        dedupDropped.push({
          pass: 1,
          kept: { id: existing.id, name: existing.name, source: existing.source },
          dropped: { id: entry.id, name: entry.name, source: entry.source },
          reason: 'exact osm_id duplicate',
        });
      }
    } else {
      byOsmId.set(oid, entry);
    }
  }

  let pass1Entries = [...byOsmId.values()];
  const pass1Dropped = merged.length - pass1Entries.length;
  console.log(`  Pass 1: ${pass1Dropped} duplicates removed, ${pass1Entries.length} remaining`);

  // -------------------------------------------------------------------------
  // Dedup Pass 2: Conservative proximity — nodes within 200m of way/relation
  //   centroid with case-insensitive name match
  // -------------------------------------------------------------------------
  console.log('Dedup Pass 2: Conservative proximity dedup (200m + name match)...');

  // Separate into area (way/relation) and node entries
  const areaEntries = [];
  const otherEntries = [];

  for (const entry of pass1Entries) {
    if (osmElementType(entry._osmId) === 'area') {
      areaEntries.push(entry);
    } else {
      otherEntries.push(entry);
    }
  }

  const pass2Kept = [...areaEntries];
  let pass2Dropped = 0;

  for (const node of otherEntries) {
    let isDuplicate = false;
    for (const area of areaEntries) {
      const dist = haversineMeters(node.lat, node.lon, area.lat, area.lon);
      if (dist <= PROXIMITY_THRESHOLD_M && nameMatch(node.name, area.name)) {
        dedupDropped.push({
          pass: 2,
          kept: { id: area.id, name: area.name, source: area.source, lat: area.lat, lon: area.lon },
          dropped: { id: node.id, name: node.name, source: node.source, lat: node.lat, lon: node.lon },
          reason: `proximity ${Math.round(dist)}m + name match`,
        });
        isDuplicate = true;
        pass2Dropped++;
        break;
      }
    }
    if (!isDuplicate) {
      pass2Kept.push(node);
    }
  }

  console.log(`  Pass 2: ${pass2Dropped} duplicates removed, ${pass2Kept.length} remaining`);

  // -------------------------------------------------------------------------
  // Assign type and tier
  // -------------------------------------------------------------------------
  console.log('\nAssigning type and tier...');
  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  const typeCounts = {};

  for (const entry of pass2Kept) {
    // Assign type if not already set (curated entries may already have it)
    if (!entry.type) {
      entry.type = assignType(entry.countryIso2);
    }

    // Assign tier
    if (entry.tier === 0 || (entry.source !== 'mirta' && entry.source !== 'curated')) {
      entry.tier = assignTier(entry.kind, entry.source);
    }

    tierCounts[entry.tier] = (tierCounts[entry.tier] || 0) + 1;
    typeCounts[entry.type] = (typeCounts[entry.type] || 0) + 1;
  }

  // -------------------------------------------------------------------------
  // Build final output (strip internal fields)
  // -------------------------------------------------------------------------
  const finalEntries = pass2Kept.map((e) => ({
    id: e.id,
    name: e.name,
    lat: e.lat,
    lon: e.lon,
    kind: e.kind,
    countryIso2: e.countryIso2,
    type: e.type,
    tier: e.tier,
    source: e.source,
    catAirforce: e.catAirforce,
    catNaval: e.catNaval,
    catNuclear: e.catNuclear,
    catSpace: e.catSpace,
    catTraining: e.catTraining,
    branch: e.branch,
    status: e.status,
  }));

  // -------------------------------------------------------------------------
  // Write outputs
  // -------------------------------------------------------------------------
  writeFileSync(OUTPUT_PATH, JSON.stringify(finalEntries));
  const sizeMB = (Buffer.byteLength(JSON.stringify(finalEntries)) / (1024 * 1024)).toFixed(1);
  console.log(`\nOutput: ${OUTPUT_PATH}`);
  console.log(`  ${finalEntries.length} entries, ${sizeMB} MB`);

  writeFileSync(DEDUP_LOG_PATH, JSON.stringify(dedupDropped, null, 2));
  console.log(`\nDedup log: ${DEDUP_LOG_PATH}`);
  console.log(`  ${dedupDropped.length} dropped pairs logged`);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));

  console.log('\nSource counts:');
  const sourceCounts = {};
  for (const e of finalEntries) {
    sourceCounts[e.source] = (sourceCounts[e.source] || 0) + 1;
  }
  for (const [src, count] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src}: ${count}`);
  }

  console.log('\nMerge stats:');
  if (pizzintRaw) console.log(`  Pizzint base:       ${pizzintRaw.length} loaded`);
  if (osmRaw) console.log(`  OSM added:          ${osmAdded} (${osmSkipped} skipped)`);
  if (mirtaRaw) console.log(`  MIRTA added:        ${mirtaAdded} (${mirtaSkipped} skipped)`);
  if (curatedRaw) console.log(`  Curated enriched:   ${curatedEnriched}, new: ${curatedUnmatched}`);

  console.log('\nDedup report:');
  console.log(`  Pass 1 (exact osm_id): ${pass1Dropped} removed`);
  console.log(`  Pass 2 (proximity):    ${pass2Dropped} removed`);
  console.log(`  Total deduped:         ${pass1Dropped + pass2Dropped}`);

  console.log('\nTier distribution:');
  console.log(`  Tier 1 (zoom 3+):  ${tierCounts[1] || 0}`);
  console.log(`  Tier 2 (zoom 5+):  ${tierCounts[2] || 0}`);
  console.log(`  Tier 3 (zoom 8+):  ${tierCounts[3] || 0}`);

  console.log('\nType distribution:');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  console.log('\nDone.');
}

main();
