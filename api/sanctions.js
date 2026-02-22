import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getCachedJson, setCachedJson } from './_upstash-cache.js';

export const config = { runtime: 'edge' };

const CACHE_KEY = 'sanctions-ofac-v1';
const CACHE_TTL = 3600; // 1 hour (OFAC updates ~daily)

const SDN_CSV_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv';
const MAX_ENTITIES = 500;

/**
 * OFAC Sanctions API
 *
 * Fetches the OFAC SDN (Specially Designated Nationals) consolidated CSV,
 * parses entity data, and returns country-level aggregates + entity list.
 * Cached for 1 hour via Upstash Redis.
 */
export default async function handler(req) {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  try {
    // Check cache
    const cached = await getCachedJson(CACHE_KEY);
    if (cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...cors,
          'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=300',
        },
      });
    }

    // Fetch OFAC SDN CSV
    const csvText = await fetchSdnCsv();
    if (!csvText) {
      return new Response(JSON.stringify({ error: 'Failed to fetch OFAC data' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    const entities = parseSdnCsv(csvText);
    const countries = aggregateByCountry(entities);

    const result = {
      generatedAt: new Date().toISOString(),
      totalEntities: entities.length,
      countries,
      entities: entities.slice(0, MAX_ENTITIES),
    };

    // Cache the result
    await setCachedJson(CACHE_KEY, result, CACHE_TTL).catch(() => {});

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
        'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=300',
      },
    });
  } catch (error) {
    console.error('[sanctions] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}

// ── SDN CSV Fetch ──

async function fetchSdnCsv() {
  try {
    const res = await fetch(SDN_CSV_URL, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── CSV Parsing ──

// SDN CSV columns (no header row):
// 0: ent_num, 1: SDN_Name, 2: SDN_Type, 3: Program, 4: Title,
// 5: Call_Sign, 6: Vess_type, 7: Tonnage, 8: GRT, 9: Vess_flag,
// 10: Vess_owner, 11: Remarks

const ENTITY_TYPE_MAP = {
  individual: 'individual',
  entity: 'entity',
  vessel: 'vessel',
  aircraft: 'aircraft',
};

function parseEntityType(raw) {
  if (!raw) return 'entity';
  const lower = raw.toLowerCase().trim();
  if (lower.includes('individual')) return 'individual';
  if (lower.includes('vessel')) return 'vessel';
  if (lower.includes('aircraft')) return 'aircraft';
  return 'entity';
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// Extract country from remarks like "Nationality: Iran" or "Country: Russia"
const COUNTRY_PATTERNS = [
  /\bNationality[:\s]+([A-Za-z\s]+?)(?:[;,.]|$)/i,
  /\bCountry[:\s]+([A-Za-z\s]+?)(?:[;,.]|$)/i,
  /\bcitizen(?:ship)?[:\s]+([A-Za-z\s]+?)(?:[;,.]|$)/i,
];

// Known OFAC programs and their severity
const PROGRAM_SEVERITY = {
  SDGT: 'severe',      // Specially Designated Global Terrorists
  SDN: 'high',         // Specially Designated Nationals
  SDNTK: 'severe',     // SDN Narcotics Trafficking Kingpin
  FTO: 'severe',       // Foreign Terrorist Organization
  IRAN: 'high',
  'IRAN-TRA': 'high',
  'IRAN-EO13846': 'high',
  DPRK: 'severe',      // North Korea
  'DPRK2': 'severe',
  'DPRK3': 'severe',
  'DPRK4': 'severe',
  SYRIA: 'high',
  UKRAINE: 'high',     // Russia-Ukraine sanctions
  'UKRAINE-EO13661': 'high',
  'UKRAINE-EO13662': 'high',
  'UKRAINE-EO14024': 'high',
  RUSSIA: 'high',
  'RUSSIA-EO14024': 'high',
  VENEZUELA: 'moderate',
  'VENEZUELA-EO13692': 'moderate',
  BELARUS: 'high',
  MYANMAR: 'moderate',
  BURMA: 'moderate',
  CUBA: 'moderate',
  BALKANS: 'moderate',
  'TCO': 'high',       // Transnational Criminal Organizations
  'CYBER2': 'high',
  'ELECTION-EO13848': 'high',
  'GLOMAG': 'high',    // Global Magnitsky
  'HRIT': 'high',      // Human Rights
  'IFSR': 'high',      // Foreign Sanctions Evaders
};

function extractCountry(remarks, program) {
  // Try extracting from remarks
  if (remarks) {
    for (const pattern of COUNTRY_PATTERNS) {
      const match = remarks.match(pattern);
      if (match) {
        const country = match[1].trim();
        if (country.length >= 2 && country.length <= 40) return country;
      }
    }
  }

  // Infer from program name
  if (!program) return '';
  const upper = program.toUpperCase();
  if (upper.includes('IRAN')) return 'Iran';
  if (upper.includes('DPRK') || upper.includes('NORTH KOREA')) return 'North Korea';
  if (upper.includes('SYRIA')) return 'Syria';
  if (upper.includes('CUBA')) return 'Cuba';
  if (upper.includes('UKRAINE') || upper.includes('RUSSIA')) return 'Russia';
  if (upper.includes('BELARUS')) return 'Belarus';
  if (upper.includes('VENEZUELA')) return 'Venezuela';
  if (upper.includes('MYANMAR') || upper.includes('BURMA')) return 'Myanmar';
  if (upper.includes('BALKANS')) return 'Balkans';
  if (upper.includes('ZIMBABWE')) return 'Zimbabwe';
  if (upper.includes('SOMALIA')) return 'Somalia';
  if (upper.includes('LIBYA')) return 'Libya';
  if (upper.includes('SUDAN')) return 'Sudan';
  if (upper.includes('YEMEN')) return 'Yemen';
  if (upper.includes('NICARAGUA')) return 'Nicaragua';
  if (upper.includes('MALI')) return 'Mali';
  return '';
}

function getProgramSeverity(program) {
  if (!program) return 'moderate';
  const upper = program.toUpperCase().trim();

  // Direct match
  if (PROGRAM_SEVERITY[upper]) return PROGRAM_SEVERITY[upper];

  // Partial match
  for (const [key, severity] of Object.entries(PROGRAM_SEVERITY)) {
    if (upper.includes(key)) return severity;
  }

  return 'moderate';
}

function parseSdnCsv(csvText) {
  const lines = csvText.split('\n');
  const entities = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (fields.length < 4) continue;

    const entNum = (fields[0] || '').trim();
    const name = (fields[1] || '').trim();
    const typeRaw = (fields[2] || '').trim();
    const program = (fields[3] || '').trim();
    const remarks = (fields[11] || '').trim();

    if (!name || !entNum) continue;
    // Skip header-like rows
    if (entNum.toLowerCase() === 'ent_num') continue;

    const entityType = parseEntityType(typeRaw);
    const country = extractCountry(remarks, program);
    const severity = getProgramSeverity(program);

    // Extract date from remarks if available
    let dateAdded = '';
    const dateMatch = remarks.match(/\b(\d{2}\s+\w{3}\s+\d{4})\b/);
    if (dateMatch) dateAdded = dateMatch[1];

    entities.push({
      id: entNum,
      name: name.slice(0, 120),
      type: entityType,
      program: program.slice(0, 60),
      country,
      severity,
      dateAdded,
      remarks: remarks.slice(0, 200),
    });
  }

  // Sort by most recently added (if dates available), else by ID descending
  entities.sort((a, b) => {
    if (a.dateAdded && b.dateAdded) {
      const da = new Date(a.dateAdded).getTime();
      const db = new Date(b.dateAdded).getTime();
      if (!isNaN(da) && !isNaN(db)) return db - da;
    }
    return Number(b.id) - Number(a.id);
  });

  return entities;
}

function aggregateByCountry(entities) {
  const byCountry = {};

  for (const entity of entities) {
    const country = entity.country || 'Unknown';
    if (!byCountry[country]) {
      byCountry[country] = {
        count: 0,
        programs: new Set(),
        severity: 'moderate',
        types: { individual: 0, entity: 0, vessel: 0, aircraft: 0 },
      };
    }

    byCountry[country].count++;
    if (entity.program) byCountry[country].programs.add(entity.program.split(';')[0]?.trim() || entity.program);
    byCountry[country].types[entity.type] = (byCountry[country].types[entity.type] || 0) + 1;

    // Escalate severity
    const severityRank = { severe: 3, high: 2, moderate: 1 };
    if ((severityRank[entity.severity] || 0) > (severityRank[byCountry[country].severity] || 0)) {
      byCountry[country].severity = entity.severity;
    }
  }

  // Convert Sets to arrays for JSON serialization
  const result = {};
  for (const [country, data] of Object.entries(byCountry)) {
    result[country] = {
      count: data.count,
      programs: Array.from(data.programs).slice(0, 10),
      severity: data.severity,
      types: data.types,
    };
  }

  return result;
}

// ── Test helpers ──

export function __testParseSdnCsv(csvText) {
  return parseSdnCsv(csvText);
}

export function __testAggregateByCountry(entities) {
  return aggregateByCountry(entities);
}

export function __testExtractCountry(remarks, program) {
  return extractCountry(remarks, program);
}

export function __testParseCsvLine(line) {
  return parseCsvLine(line);
}

export function __testGetProgramSeverity(program) {
  return getProgramSeverity(program);
}
