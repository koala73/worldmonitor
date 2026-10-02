const HULL_TYPE_MAP = {
  CVN: 'carrier', CV: 'carrier',
  DDG: 'destroyer', CG: 'destroyer',
  LHD: 'amphibious', LHA: 'amphibious', LPD: 'amphibious', LSD: 'amphibious', LCC: 'amphibious',
  SSN: 'submarine', SSBN: 'submarine', SSGN: 'submarine',
  FFG: 'frigate', LCS: 'frigate',
  MCM: 'patrol', PC: 'patrol',
  AS: 'auxiliary', ESB: 'auxiliary', ESD: 'auxiliary',
  'T-AO': 'auxiliary', 'T-AKE': 'auxiliary', 'T-AOE': 'auxiliary',
  'T-ARS': 'auxiliary', 'T-ESB': 'auxiliary', 'T-EPF': 'auxiliary',
  'T-AGOS': 'research', 'T-AGS': 'research', 'T-AGM': 'research', AGOS: 'research',
};

// Theater and port centroids for every <h2> heading USNI has published in the
// Fleet Tracker. Keep every key and coordinate identical to USNI_REGION_COORDINATES in
// src/config/military.ts — tests/dom/usni-region-coords-parity.test.mts fails if
// the two drift. An unmapped heading is not harmless: the client falls through
// to a hash-derived position, which plots the vessel at an arbitrary point on
// the globe (#7548).
const USNI_REGION_COORDS = {
  // Seas & oceans
  'Philippine Sea': { lat: 18.0, lon: 130.0 }, 'South China Sea': { lat: 14.0, lon: 115.0 },
  'East China Sea': { lat: 28.0, lon: 125.0 }, 'Sea of Japan': { lat: 40.0, lon: 135.0 },
  'Arabian Sea': { lat: 18.0, lon: 63.0 }, 'North Arabian Sea': { lat: 22.0, lon: 64.0 },
  'Red Sea': { lat: 20.0, lon: 38.0 },
  'Mediterranean Sea': { lat: 35.0, lon: 18.0 }, Mediterranean: { lat: 35.0, lon: 18.0 },
  'Eastern Mediterranean': { lat: 34.5, lon: 33.0 }, 'Western Mediterranean': { lat: 37.0, lon: 3.0 },
  'Persian Gulf': { lat: 26.5, lon: 52.0 }, 'Gulf of Oman': { lat: 24.5, lon: 58.5 },
  'Gulf of Aden': { lat: 12.0, lon: 47.0 },
  'Caribbean Sea': { lat: 15.0, lon: -73.0 }, Caribbean: { lat: 15.0, lon: -73.0 },
  'Atlantic Ocean': { lat: 30.0, lon: -40.0 }, Atlantic: { lat: 30.0, lon: -40.0 },
  'North Atlantic': { lat: 45.0, lon: -30.0 }, 'Western Atlantic': { lat: 30.0, lon: -60.0 },
  'Eastern Atlantic': { lat: 40.0, lon: -15.0 },
  'South Atlantic': { lat: -25.0, lon: -20.0 }, 'Southern Atlantic': { lat: -25.0, lon: -20.0 },
  'Pacific Ocean': { lat: 20.0, lon: -150.0 }, Pacific: { lat: 20.0, lon: -150.0 },
  'Eastern Pacific': { lat: 18.0, lon: -125.0 }, 'Western Pacific': { lat: 20.0, lon: 140.0 },
  'South Pacific': { lat: -20.0, lon: -160.0 }, 'Southern Pacific': { lat: -20.0, lon: -160.0 },
  'Indian Ocean': { lat: -5.0, lon: 75.0 }, 'Southern Indian Ocean': { lat: -35.0, lon: 80.0 },
  Antarctic: { lat: -70.0, lon: 20.0 },
  'Baltic Sea': { lat: 58.0, lon: 20.0 }, 'Black Sea': { lat: 43.5, lon: 34.0 },
  'North Sea': { lat: 56.0, lon: 3.0 }, 'English Channel': { lat: 50.0, lon: -1.5 },
  'Bay of Bengal': { lat: 14.0, lon: 87.0 }, 'Andaman Sea': { lat: 10.0, lon: 96.0 },
  'Sulu Sea': { lat: 8.0, lon: 120.0 }, 'Tasman Sea': { lat: -40.0, lon: 160.0 },
  // Straits, chokepoints & features
  'Bab el-Mandeb Strait': { lat: 12.5, lon: 43.5 }, 'Strait of Hormuz': { lat: 26.5, lon: 56.5 },
  'Taiwan Strait': { lat: 24.5, lon: 119.5 }, 'Suez Canal': { lat: 30.0, lon: 32.5 },
  'Strait of Malacca': { lat: 3.5, lon: 100.5 },
  'Tsushima Strait': { lat: 34.3, lon: 129.3 }, 'Miyako Strait': { lat: 25.0, lon: 125.5 },
  'Osumi Strait': { lat: 30.9, lon: 131.0 }, 'La Perouse Strait': { lat: 45.7, lon: 142.0 },
  'Yonaguni Island': { lat: 24.45, lon: 123.0 }, 'Amami Oshima': { lat: 28.3, lon: 129.4 },
  'Scarborough Shoal': { lat: 15.15, lon: 117.75 }, 'Solomon Islands': { lat: -9.5, lon: 160.0 },
  'Gulf Coast': { lat: 28.0, lon: -90.0 },
  // Operating areas & exercises
  'Hawaiian Operating Areas': { lat: 21.0, lon: -158.5 }, Hawaii: { lat: 21.35, lon: -157.95 },
  'California Operating Area': { lat: 32.5, lon: -119.0 },
  'Exercise Valiant Shield': { lat: 15.0, lon: 145.0 },
  // Indo-Pacific ports & bases
  Yokosuka: { lat: 35.29, lon: 139.67 }, Japan: { lat: 35.29, lon: 139.67 },
  Sasebo: { lat: 33.16, lon: 129.72 }, Okinawa: { lat: 26.35, lon: 127.77 },
  Kure: { lat: 34.24, lon: 132.56 }, Shimoda: { lat: 34.68, lon: 138.95 },
  Honshu: { lat: 36.0, lon: 138.0 }, 'Southwest Japan': { lat: 32.5, lon: 131.0 },
  Guam: { lat: 13.45, lon: 144.79 }, 'Pearl Harbor': { lat: 21.35, lon: -157.95 },
  Singapore: { lat: 1.35, lon: 103.82 }, 'Hong Kong': { lat: 22.3, lon: 114.17 },
  Manila: { lat: 14.6, lon: 120.97 }, 'Da Nang': { lat: 16.07, lon: 108.22 },
  Phuket: { lat: 7.88, lon: 98.39 }, 'Laem Chabang': { lat: 13.08, lon: 100.88 },
  'Tanjung Priok': { lat: -6.1, lon: 106.88 }, Jakarta: { lat: -6.1, lon: 106.88 },
  Vladivostok: { lat: 43.12, lon: 131.9 }, 'Diego Garcia': { lat: -7.32, lon: 72.42 },
  'New Zealand': { lat: -41.0, lon: 174.0 }, Wellington: { lat: -41.29, lon: 174.78 },
  // Middle East, Africa & Europe ports
  Bahrain: { lat: 26.23, lon: 50.55 }, Djibouti: { lat: 11.55, lon: 43.15 },
  Rota: { lat: 36.63, lon: -6.35 }, 'Rota Spain': { lat: 36.63, lon: -6.35 },
  'Souda Bay': { lat: 35.49, lon: 24.08 }, Naples: { lat: 40.84, lon: 14.25 },
  Split: { lat: 43.51, lon: 16.44 }, Deveselu: { lat: 44.1, lon: 24.09 },
  Norway: { lat: 60.39, lon: 5.32 }, Kiel: { lat: 54.32, lon: 10.14 },
  Zeebrugge: { lat: 51.33, lon: 3.2 }, 'Portsmouth, England': { lat: 50.8, lon: -1.09 },
  // Americas ports & bases
  'San Diego': { lat: 32.68, lon: -117.15 }, Norfolk: { lat: 36.95, lon: -76.3 },
  Mayport: { lat: 30.39, lon: -81.4 }, Jacksonville: { lat: 30.39, lon: -81.4 },
  'Kings Bay': { lat: 30.8, lon: -81.56 }, Pensacola: { lat: 30.35, lon: -87.3 },
  Pascagoula: { lat: 30.37, lon: -88.55 }, 'New Orleans': { lat: 29.95, lon: -90.07 },
  Houston: { lat: 29.75, lon: -95.35 }, 'Corpus Christi': { lat: 27.8, lon: -97.4 },
  'Newport News': { lat: 37.0, lon: -76.43 }, 'New York City': { lat: 40.7, lon: -74.0 },
  Portsmouth: { lat: 43.07, lon: -70.76 }, Groton: { lat: 41.35, lon: -72.09 },
  'New London': { lat: 41.35, lon: -72.09 },
  Bremerton: { lat: 47.57, lon: -122.63 }, 'Puget Sound': { lat: 47.57, lon: -122.63 },
  'Naval Station Kitsap': { lat: 47.57, lon: -122.63 }, Kitsap: { lat: 47.57, lon: -122.63 },
  Everett: { lat: 47.97, lon: -122.22 }, Bangor: { lat: 47.73, lon: -122.71 },
  Panama: { lat: 8.95, lon: -79.55 }, 'La Guaira': { lat: 10.6, lon: -66.93 },
  Kingston: { lat: 17.97, lon: -76.79 }, 'St. Thomas': { lat: 18.34, lon: -64.93 },
};

function usniStripHtml(html) {
  // &amp; is decoded LAST: every other replace is a literal string that cannot
  // regenerate an entity, so amp-last decodes exactly one level
  // (`&amp;lt;` -> `&lt;`, never `<`).
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"').replace(/&#8211;/g, '\u2013')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function usniHullToType(hull) {
  if (!hull) return 'unknown';
  for (const [prefix, type] of Object.entries(HULL_TYPE_MAP)) { if (hull.startsWith(prefix)) return type; }
  return 'unknown';
}

function usniDetectStatus(text) {
  if (!text) return 'unknown';
  const l = text.toLowerCase();
  if (l.includes('deployed') || l.includes('deployment')) return 'deployed';
  if (l.includes('underway') || l.includes('transiting')) return 'underway';
  if (l.includes('homeport') || l.includes('in port') || l.includes('pierside')) return 'in-port';
  return 'unknown';
}

function usniNormalizeRegion(regionText) {
  return regionText.replace(/^(In the|In|The)\s+/i, '').replace(/\s+/g, ' ').trim();
}

// Longest table key contained in `lower`, so "Eastern Mediterranean Sea" beats
// "Mediterranean Sea". Returns the matched key too, so callers can tell a key
// that spans a comma ("Portsmouth, England") from a single-segment one.
function usniLongestContainedKey(lower) {
  let best = null;
  for (const [key, coords] of Object.entries(USNI_REGION_COORDS)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === lower) return { key, coords };
    if (lower.includes(normalizedKey) && (!best || key.length > best.key.length)) {
      best = { key, coords };
    }
  }
  return best;
}

function usniGetRegionCoords(regionText) {
  const norm = usniNormalizeRegion(regionText);
  if (USNI_REGION_COORDS[norm]) return USNI_REGION_COORDS[norm];
  const lower = norm.toLowerCase();
  const whole = usniLongestContainedKey(lower);
  // A key that itself contains a comma is more specific than any one segment.
  if (whole?.key.includes(',')) return whole.coords;
  // "City, Country" headings: the first segment naming a known place wins, so
  // "Kure, Japan" lands on Kure even though "Japan" is the longer key.
  const segments = lower.split(',').map((part) => part.trim()).filter(Boolean);
  if (segments.length > 1) {
    for (const segment of segments) {
      const match = usniLongestContainedKey(segment);
      if (match) return match.coords;
    }
  }
  return whole?.coords ?? null;
}

function usniParseLeadingInt(text) {
  const m = text.match(/\d{1,3}(?:,\d{3})*/);
  return m ? parseInt(m[0].replace(/,/g, ''), 10) : undefined;
}

function usniExtractBattleForceSummary(tableHtml) {
  const rows = Array.from(tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
  if (rows.length < 2) return undefined;
  const headers = Array.from(rows[0][1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(m => usniStripHtml(m[1]).toLowerCase());
  const values = Array.from(rows[1][1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(m => usniParseLeadingInt(usniStripHtml(m[1])));
  const summary = { totalShips: 0, deployed: 0, underway: 0 };
  let matched = false;
  for (let i = 0; i < headers.length; i++) {
    const label = headers[i] || '';
    const val = values[i];
    if (!Number.isFinite(val)) continue;
    if (label.includes('battle force') || label.includes('total')) { summary.totalShips = val; matched = true; }
    else if (label.includes('deployed')) { summary.deployed = val; matched = true; }
    else if (label.includes('underway')) { summary.underway = val; matched = true; }
  }
  return matched ? summary : undefined;
}

function usniParseArticle(html, articleUrl, articleDate, articleTitle) {
  const warnings = [];
  const vessels = [];
  const vesselByKey = new Map();
  const strikeGroups = [];
  const regionsSet = new Set();

  let battleForceSummary;
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (tableMatch) battleForceSummary = usniExtractBattleForceSummary(tableMatch[1]);

  const h2Parts = html.split(/<h2[^>]*>/i);
  for (let i = 1; i < h2Parts.length; i++) {
    const part = h2Parts[i];
    const h2End = part.indexOf('</h2>');
    if (h2End === -1) continue;
    const regionName = usniNormalizeRegion(usniStripHtml(part.substring(0, h2End)));
    if (!regionName) continue;
    regionsSet.add(regionName);
    const coords = usniGetRegionCoords(regionName);
    if (!coords) warnings.push(`Unknown region: "${regionName}"`);
    const regionLat = coords?.lat ?? 0;
    const regionLon = coords?.lon ?? 0;
    const regionContent = part.substring(h2End + 5);
    const h3Parts = regionContent.split(/<h3[^>]*>/i);
    let currentSG = null;
    for (let j = 0; j < h3Parts.length; j++) {
      const section = h3Parts[j];
      if (j > 0) {
        const h3End = section.indexOf('</h3>');
        if (h3End !== -1) {
          const sgName = usniStripHtml(section.substring(0, h3End));
          if (sgName) { currentSG = { name: sgName, carrier: '', airWing: '', destroyerSquadron: '', escorts: [] }; strikeGroups.push(currentSG); }
        }
      }
      const shipRegex = /(USS|USNS)\s+(?:<[^>]+>)?([^<(]+?)(?:<\/[^>]+>)?\s*\(([^)]+)\)/gi;
      let match;
      const sectionText = usniStripHtml(section);
      const deploymentStatus = usniDetectStatus(sectionText);
      const homePort = (sectionText.match(/homeported (?:at|in) ([^.,]+)/i) || [])[1]?.trim() || '';
      const activityDesc = sectionText.length > 10 ? sectionText.substring(0, 200).trim() : '';
      while ((match = shipRegex.exec(section)) !== null) {
        const prefix = match[1].toUpperCase();
        const shipName = match[2].trim();
        const hullNumber = match[3].trim();
        const vesselType = usniHullToType(hullNumber);
        if (prefix === 'USS' && vesselType === 'carrier' && currentSG) currentSG.carrier = `USS ${shipName} (${hullNumber})`;
        if (currentSG) currentSG.escorts.push(`${prefix} ${shipName} (${hullNumber})`);
        const key = `${regionName}|${hullNumber.toUpperCase()}`;
        if (!vesselByKey.has(key)) {
          const v = { name: `${prefix} ${shipName}`, hullNumber, vesselType, region: regionName, regionLat, regionLon, deploymentStatus, homePort, strikeGroup: currentSG?.name || '', activityDescription: activityDesc, articleUrl, articleDate };
          vessels.push(v);
          vesselByKey.set(key, v);
        }
      }
    }
  }

  for (const sg of strikeGroups) {
    const wingMatch = html.match(new RegExp(sg.name + '[\\s\\S]{0,500}Carrier Air Wing\\s*(\\w+)', 'i'));
    if (wingMatch) sg.airWing = `Carrier Air Wing ${wingMatch[1]}`;
    const desronMatch = html.match(new RegExp(sg.name + '[\\s\\S]{0,500}Destroyer Squadron\\s*(\\w+)', 'i'));
    if (desronMatch) sg.destroyerSquadron = `Destroyer Squadron ${desronMatch[1]}`;
    sg.escorts = [...new Set(sg.escorts)];
  }

  return {
    articleUrl, articleDate, articleTitle,
    battleForceSummary: battleForceSummary || { totalShips: 0, deployed: 0, underway: 0 },
    vessels, strikeGroups, regions: [...regionsSet],
    parsingWarnings: warnings,
    timestamp: Date.now(),
  };
}

module.exports = {
  HULL_TYPE_MAP,
  USNI_REGION_COORDS,
  usniStripHtml,
  usniHullToType,
  usniDetectStatus,
  usniNormalizeRegion,
  usniGetRegionCoords,
  usniParseLeadingInt,
  usniExtractBattleForceSummary,
  usniParseArticle,
};
