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

const USNI_REGION_COORDS = {
  'Philippine Sea': { lat: 18.0, lon: 130.0 }, 'South China Sea': { lat: 14.0, lon: 115.0 },
  'East China Sea': { lat: 28.0, lon: 125.0 }, 'Sea of Japan': { lat: 40.0, lon: 135.0 },
  'Arabian Sea': { lat: 18.0, lon: 63.0 }, 'Red Sea': { lat: 20.0, lon: 38.0 },
  'Mediterranean Sea': { lat: 35.0, lon: 18.0 }, 'Eastern Mediterranean': { lat: 34.5, lon: 33.0 },
  'Western Mediterranean': { lat: 37.0, lon: 3.0 }, 'Persian Gulf': { lat: 26.5, lon: 52.0 },
  'Gulf of Oman': { lat: 24.5, lon: 58.5 }, 'Gulf of Aden': { lat: 12.0, lon: 47.0 },
  'Caribbean Sea': { lat: 15.0, lon: -73.0 }, 'North Atlantic': { lat: 45.0, lon: -30.0 },
  'Atlantic Ocean': { lat: 30.0, lon: -40.0 }, 'Western Atlantic': { lat: 30.0, lon: -60.0 },
  'Pacific Ocean': { lat: 20.0, lon: -150.0 }, 'Eastern Pacific': { lat: 18.0, lon: -125.0 },
  'Western Pacific': { lat: 20.0, lon: 140.0 }, 'Indian Ocean': { lat: -5.0, lon: 75.0 },
  Antarctic: { lat: -70.0, lon: 20.0 }, 'Baltic Sea': { lat: 58.0, lon: 20.0 },
  'Black Sea': { lat: 43.5, lon: 34.0 }, 'Bay of Bengal': { lat: 14.0, lon: 87.0 },
  Yokosuka: { lat: 35.29, lon: 139.67 }, Japan: { lat: 35.29, lon: 139.67 },
  Sasebo: { lat: 33.16, lon: 129.72 }, Guam: { lat: 13.45, lon: 144.79 },
  'Pearl Harbor': { lat: 21.35, lon: -157.95 }, 'San Diego': { lat: 32.68, lon: -117.15 },
  Norfolk: { lat: 36.95, lon: -76.30 }, Mayport: { lat: 30.39, lon: -81.40 },
  Bahrain: { lat: 26.23, lon: 50.55 }, Rota: { lat: 36.63, lon: -6.35 },
  'Diego Garcia': { lat: -7.32, lon: 72.42 }, Djibouti: { lat: 11.55, lon: 43.15 },
  Singapore: { lat: 1.35, lon: 103.82 }, 'Souda Bay': { lat: 35.49, lon: 24.08 },
  Naples: { lat: 40.84, lon: 14.25 },
  'Tasman Sea': { lat: -40.0, lon: 160.0 }, 'Eastern Atlantic': { lat: 40.0, lon: -15.0 },
  'Laem Chabang, Thailand': { lat: 13.08, lon: 100.88 }, 'Laem Chabang': { lat: 13.08, lon: 100.88 },
  'Split, Croatia': { lat: 43.51, lon: 16.44 }, Split: { lat: 43.51, lon: 16.44 },
  Pacific: { lat: 20.0, lon: -150.0 },
};

function usniStripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"').replace(/&#8211;/g, '\u2013')
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

function usniGetRegionCoords(regionText) {
  const norm = regionText.replace(/^(In the|In|The)\s+/i, '').trim();
  if (USNI_REGION_COORDS[norm]) return USNI_REGION_COORDS[norm];
  const lower = norm.toLowerCase();
  let bestMatch = null;
  for (const [key, coords] of Object.entries(USNI_REGION_COORDS)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === lower) return coords;
    if (lower.includes(normalizedKey) && (!bestMatch || key.length > bestMatch.key.length)) {
      bestMatch = { key, coords };
    }
  }
  return bestMatch?.coords ?? null;
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
    const regionName = usniStripHtml(part.substring(0, h2End)).replace(/^(In the|In|The)\s+/i, '').trim();
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
  usniGetRegionCoords,
  usniParseLeadingInt,
  usniExtractBattleForceSummary,
  usniParseArticle,
};
