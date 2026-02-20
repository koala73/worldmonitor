import { getCachedJson, setCachedJson } from './_upstash-cache.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = {
  runtime: 'edge',
};

const CACHE_TTL_SECONDS = 21600; // 6 hours
const STALE_CACHE_TTL_SECONDS = 604800; // 7 days
const CACHE_KEY = 'usni-fleet:v1';
const STALE_CACHE_KEY = 'usni-fleet:stale:v1';

const HULL_TYPE_MAP = {
  CVN: 'carrier',
  CV: 'carrier',
  DDG: 'destroyer',
  CG: 'destroyer',
  LHD: 'amphibious',
  LHA: 'amphibious',
  LPD: 'amphibious',
  LSD: 'amphibious',
  LCC: 'amphibious',
  SSN: 'submarine',
  SSBN: 'submarine',
  SSGN: 'submarine',
  FFG: 'frigate',
  LCS: 'frigate',
  MCM: 'patrol',
  PC: 'patrol',
  AS: 'auxiliary',
  ESB: 'auxiliary',
  ESD: 'auxiliary',
  'T-AO': 'auxiliary',
  'T-AKE': 'auxiliary',
  'T-AOE': 'auxiliary',
  'T-ARS': 'auxiliary',
  'T-ESB': 'auxiliary',
  'T-EPF': 'auxiliary',
  'T-AGOS': 'research',
  'T-AGS': 'research',
  'T-AGM': 'research',
  AGOS: 'research',
};

function hullToVesselType(hull) {
  if (!hull) return 'unknown';
  for (const [prefix, type] of Object.entries(HULL_TYPE_MAP)) {
    if (hull.startsWith(prefix)) return type;
  }
  return 'unknown';
}

function detectDeploymentStatus(text) {
  if (!text) return 'unknown';
  const lower = text.toLowerCase();
  if (lower.includes('deployed') || lower.includes('deployment')) return 'deployed';
  if (lower.includes('underway') || lower.includes('transiting') || lower.includes('transit')) return 'underway';
  if (lower.includes('homeport') || lower.includes('in port') || lower.includes('pierside') || lower.includes('returned')) return 'in-port';
  return 'unknown';
}

function extractHomePort(text) {
  const match = text.match(/homeported (?:at|in) ([^.,]+)/i) || text.match(/home[ -]?ported (?:at|in) ([^.,]+)/i);
  return match ? match[1].trim() : undefined;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8211;/g, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

const REGION_COORDS = {
  'Philippine Sea': { lat: 18.0, lon: 130.0 },
  'South China Sea': { lat: 14.0, lon: 115.0 },
  'East China Sea': { lat: 28.0, lon: 125.0 },
  'Sea of Japan': { lat: 40.0, lon: 135.0 },
  'Arabian Sea': { lat: 18.0, lon: 63.0 },
  'Red Sea': { lat: 20.0, lon: 38.0 },
  'Mediterranean Sea': { lat: 35.0, lon: 18.0 },
  'Eastern Mediterranean': { lat: 34.5, lon: 33.0 },
  'Western Mediterranean': { lat: 37.0, lon: 3.0 },
  'Persian Gulf': { lat: 26.5, lon: 52.0 },
  'Gulf of Oman': { lat: 24.5, lon: 58.5 },
  'Gulf of Aden': { lat: 12.0, lon: 47.0 },
  'Caribbean Sea': { lat: 15.0, lon: -73.0 },
  'North Atlantic': { lat: 45.0, lon: -30.0 },
  'Atlantic Ocean': { lat: 30.0, lon: -40.0 },
  'Western Atlantic': { lat: 30.0, lon: -60.0 },
  'Pacific Ocean': { lat: 20.0, lon: -150.0 },
  'Eastern Pacific': { lat: 18.0, lon: -125.0 },
  'Western Pacific': { lat: 20.0, lon: 140.0 },
  'Indian Ocean': { lat: -5.0, lon: 75.0 },
  Antarctic: { lat: -70.0, lon: 20.0 },
  'Baltic Sea': { lat: 58.0, lon: 20.0 },
  'Black Sea': { lat: 43.5, lon: 34.0 },
  'Bay of Bengal': { lat: 14.0, lon: 87.0 },
  'Yokosuka': { lat: 35.29, lon: 139.67 },
  'Japan': { lat: 35.29, lon: 139.67 },
  'Sasebo': { lat: 33.16, lon: 129.72 },
  'Guam': { lat: 13.45, lon: 144.79 },
  'Pearl Harbor': { lat: 21.35, lon: -157.95 },
  'San Diego': { lat: 32.68, lon: -117.15 },
  'Norfolk': { lat: 36.95, lon: -76.30 },
  'Mayport': { lat: 30.39, lon: -81.40 },
  'Bahrain': { lat: 26.23, lon: 50.55 },
  'Rota': { lat: 36.63, lon: -6.35 },
  'Diego Garcia': { lat: -7.32, lon: 72.42 },
  'Djibouti': { lat: 11.55, lon: 43.15 },
  'Singapore': { lat: 1.35, lon: 103.82 },
  'Souda Bay': { lat: 35.49, lon: 24.08 },
  'Naples': { lat: 40.84, lon: 14.25 },
};

function getRegionCoords(regionText) {
  const normalized = regionText
    .replace(/^(In the|In|The)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (REGION_COORDS[normalized]) return REGION_COORDS[normalized];
  const lower = normalized.toLowerCase();
  for (const [key, coords] of Object.entries(REGION_COORDS)) {
    if (key.toLowerCase() === lower || lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return coords;
    }
  }
  return null;
}

function parseLeadingInteger(text) {
  const match = text.match(/\d{1,3}(?:,\d{3})*/);
  if (!match) return undefined;
  return parseInt(match[0].replace(/,/g, ''), 10);
}

function extractBattleForceSummary(tableHtml) {
  const rows = Array.from(tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
  if (rows.length < 2) return undefined;

  const headerCells = Array.from(rows[0][1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi))
    .map((match) => stripHtml(match[1]).toLowerCase());
  const valueCells = Array.from(rows[1][1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi))
    .map((match) => parseLeadingInteger(stripHtml(match[1])));

  const summary = {
    totalShips: 0,
    deployed: 0,
    underway: 0,
  };
  let matched = false;

  for (let idx = 0; idx < headerCells.length; idx++) {
    const label = headerCells[idx] || '';
    const value = valueCells[idx];
    if (!Number.isFinite(value)) continue;

    if (label.includes('battle force') || label.includes('total') || label.includes('ships')) {
      summary.totalShips = value;
      matched = true;
    } else if (label.includes('deployed')) {
      summary.deployed = value;
      matched = true;
    } else if (label.includes('underway')) {
      summary.underway = value;
      matched = true;
    }
  }

  if (matched) return summary;

  // Fallback for unexpected table layouts.
  const tableText = stripHtml(tableHtml);
  const totalMatch = tableText.match(/(?:battle[- ]?force|ships?|total)[^0-9]{0,40}(\d{1,3}(?:,\d{3})*)/i)
    || tableText.match(/(\d{1,3}(?:,\d{3})*)\s*(?:battle[- ]?force|ships?|total)/i);
  const deployedMatch = tableText.match(/deployed[^0-9]{0,40}(\d{1,3}(?:,\d{3})*)/i)
    || tableText.match(/(\d{1,3}(?:,\d{3})*)\s*deployed/i);
  const underwayMatch = tableText.match(/underway[^0-9]{0,40}(\d{1,3}(?:,\d{3})*)/i)
    || tableText.match(/(\d{1,3}(?:,\d{3})*)\s*underway/i);

  if (!totalMatch && !deployedMatch && !underwayMatch) return undefined;
  return {
    totalShips: totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : 0,
    deployed: deployedMatch ? parseInt(deployedMatch[1].replace(/,/g, ''), 10) : 0,
    underway: underwayMatch ? parseInt(underwayMatch[1].replace(/,/g, ''), 10) : 0,
  };
}

function parseUSNIArticle(html, articleUrl, articleDate, articleTitle) {
  const warnings = [];
  const vessels = [];
  const vesselByRegionHull = new Map();
  const strikeGroups = [];
  const regionsSet = new Set();

  // Extract battle force summary from first table
  let battleForceSummary;
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (tableMatch) {
    battleForceSummary = extractBattleForceSummary(tableMatch[1]);
  }

  // Split by H2 for region sections
  const h2Parts = html.split(/<h2[^>]*>/i);

  for (let i = 1; i < h2Parts.length; i++) {
    const part = h2Parts[i];
    const h2EndIdx = part.indexOf('</h2>');
    if (h2EndIdx === -1) continue;
    const regionRaw = stripHtml(part.substring(0, h2EndIdx));
    const regionContent = part.substring(h2EndIdx + 5);

    const regionName = regionRaw
      .replace(/^(In the|In|The)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!regionName) continue;
    regionsSet.add(regionName);

    const coords = getRegionCoords(regionName);
    if (!coords) {
      warnings.push(`Unknown region: "${regionName}"`);
    }
    const regionLat = coords?.lat ?? 0;
    const regionLon = coords?.lon ?? 0;

    // Detect H3 strike groups within this region
    const h3Parts = regionContent.split(/<h3[^>]*>/i);

    let currentStrikeGroup = null;

    for (let j = 0; j < h3Parts.length; j++) {
      const section = h3Parts[j];

      // If this starts with H3 content (j > 0), extract strike group name
      if (j > 0) {
        const h3EndIdx = section.indexOf('</h3>');
        if (h3EndIdx !== -1) {
          const sgName = stripHtml(section.substring(0, h3EndIdx));
          if (sgName) {
            currentStrikeGroup = {
              name: sgName,
              carrier: undefined,
              airWing: undefined,
              destroyerSquadron: undefined,
              escorts: [],
            };
            strikeGroups.push(currentStrikeGroup);
          }
        }
      }

      // Extract ship names: USS <em>Name</em> (HULL-NN) or USS <i>Name</i> (HULL-NN)
      const shipRegex = /USS\s+<(?:em|i)>([^<]+)<\/(?:em|i)>\s*\(([^)]+)\)/gi;
      let match;
      const sectionText = stripHtml(section);
      const deploymentStatus = detectDeploymentStatus(sectionText);
      const homePort = extractHomePort(sectionText);

      // Get a meaningful activity description: up to 200 chars of surrounding prose
      const activityDesc = sectionText.length > 10 ? sectionText.substring(0, 200).trim() : undefined;

      const upsertVessel = (entry) => {
        const key = `${entry.region}|${entry.hullNumber.toUpperCase()}`;
        const existing = vesselByRegionHull.get(key);
        if (existing) {
          if (!existing.strikeGroup && entry.strikeGroup) existing.strikeGroup = entry.strikeGroup;
          if (existing.deploymentStatus === 'unknown' && entry.deploymentStatus !== 'unknown') {
            existing.deploymentStatus = entry.deploymentStatus;
          }
          if (!existing.homePort && entry.homePort) existing.homePort = entry.homePort;
          if ((!existing.activityDescription || existing.activityDescription.length < (entry.activityDescription || '').length) && entry.activityDescription) {
            existing.activityDescription = entry.activityDescription;
          }
          return;
        }
        vessels.push(entry);
        vesselByRegionHull.set(key, entry);
      };

      while ((match = shipRegex.exec(section)) !== null) {
        const shipName = match[1].trim();
        const hullNumber = match[2].trim();
        const vesselType = hullToVesselType(hullNumber);

        if (vesselType === 'carrier' && currentStrikeGroup) {
          currentStrikeGroup.carrier = `USS ${shipName} (${hullNumber})`;
        }
        if (currentStrikeGroup) {
          currentStrikeGroup.escorts.push(`USS ${shipName} (${hullNumber})`);
        }

        upsertVessel({
          name: `USS ${shipName}`,
          hullNumber,
          vesselType,
          region: regionName,
          regionLat,
          regionLon,
          deploymentStatus,
          homePort,
          strikeGroup: currentStrikeGroup?.name || undefined,
          activityDescription: activityDesc,
          usniArticleUrl: articleUrl,
          usniArticleDate: articleDate,
        });
      }

      // Also match USNS ships: USNS <em>Name</em> (T-XX-NN)
      const usnsRegex = /USNS\s+<(?:em|i)>([^<]+)<\/(?:em|i)>\s*\(([^)]+)\)/gi;
      while ((match = usnsRegex.exec(section)) !== null) {
        const shipName = match[1].trim();
        const hullNumber = match[2].trim();
        upsertVessel({
          name: `USNS ${shipName}`,
          hullNumber,
          vesselType: hullToVesselType(hullNumber),
          region: regionName,
          regionLat,
          regionLon,
          deploymentStatus,
          homePort,
          strikeGroup: currentStrikeGroup?.name || undefined,
          activityDescription: activityDesc,
          usniArticleUrl: articleUrl,
          usniArticleDate: articleDate,
        });
      }
    }
  }

  // Extract air wings from strike group content
  for (const sg of strikeGroups) {
    const wingMatch = html.match(new RegExp(sg.name + '[\\s\\S]{0,500}Carrier Air Wing\\s*(\\w+)', 'i'));
    if (wingMatch) sg.airWing = `Carrier Air Wing ${wingMatch[1]}`;
    const desronMatch = html.match(new RegExp(sg.name + '[\\s\\S]{0,500}Destroyer Squadron\\s*(\\w+)', 'i'));
    if (desronMatch) sg.destroyerSquadron = `Destroyer Squadron ${desronMatch[1]}`;
    sg.escorts = Array.from(new Set(sg.escorts));
  }

  return {
    articleUrl,
    articleDate,
    articleTitle,
    battleForceSummary,
    vessels,
    strikeGroups,
    regions: Array.from(regionsSet),
    parsingWarnings: warnings,
    timestamp: new Date().toISOString(),
  };
}

export {
  extractBattleForceSummary as __testExtractBattleForceSummary,
  getRegionCoords as __testGetRegionCoords,
  parseUSNIArticle as __testParseUSNIArticle,
};

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req);
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: corsHeaders });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const cached = await getCachedJson(CACHE_KEY);
    if (cached) {
      console.log('[USNI Fleet] Cache hit');
      return Response.json({ ...cached, cached: true }, {
        headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60' },
      });
    }

    console.log('[USNI Fleet] Fetching from WordPress API...');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let wpData;
    try {
      const response = await fetch(
        'https://news.usni.org/wp-json/wp/v2/posts?categories=4137&per_page=1',
        {
          headers: { 'Accept': 'application/json', 'User-Agent': 'WorldMonitor/2.0' },
          signal: controller.signal,
        }
      );
      if (!response.ok) throw new Error(`USNI API error: ${response.status}`);
      wpData = await response.json();
    } finally {
      clearTimeout(timeoutId);
    }

    if (!wpData || !wpData.length) {
      return Response.json({ skipped: true, reason: 'No USNI fleet tracker articles found' }, { headers: corsHeaders });
    }

    const post = wpData[0];
    const articleUrl = post.link || `https://news.usni.org/?p=${post.id}`;
    const articleDate = post.date || new Date().toISOString();
    const articleTitle = stripHtml(post.title?.rendered || 'USNI Fleet Tracker');
    const htmlContent = post.content?.rendered || '';

    if (!htmlContent) {
      return Response.json({ skipped: true, reason: 'Empty article content' }, { headers: corsHeaders });
    }

    const report = parseUSNIArticle(htmlContent, articleUrl, articleDate, articleTitle);
    console.log(`[USNI Fleet] Parsed: ${report.vessels.length} vessels, ${report.strikeGroups.length} CSGs, ${report.regions.length} regions`);

    if (report.parsingWarnings.length > 0) {
      console.warn('[USNI Fleet] Warnings:', report.parsingWarnings.join('; '));
    }

    await Promise.all([
      setCachedJson(CACHE_KEY, report, CACHE_TTL_SECONDS),
      setCachedJson(STALE_CACHE_KEY, report, STALE_CACHE_TTL_SECONDS),
    ]);

    return Response.json({ ...report, cached: false }, {
      headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60' },
    });
  } catch (error) {
    console.warn('[USNI Fleet] Error:', error.message);

    const stale = await getCachedJson(STALE_CACHE_KEY);
    if (stale) {
      console.log('[USNI Fleet] Returning stale cached data');
      return Response.json({ ...stale, cached: true, stale: true, error: 'Using cached data' }, {
        headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=60' },
      });
    }

    return Response.json({ error: error.message, vessels: [], strikeGroups: [], regions: [], timestamp: new Date().toISOString() }, {
      status: 500,
      headers: corsHeaders,
    });
  }
}
