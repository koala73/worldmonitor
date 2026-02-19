import type { CableAdvisory, RepairShip, UnderseaCable } from '@/types';
import { UNDERSEA_CABLES } from '@/config';
import { fetchWithCache } from '@/utils';

interface CableActivity {
  advisories: CableAdvisory[];
  repairShips: RepairShip[];
}

interface NgaWarning {
  msgYear: number;
  msgNumber: number;
  navArea: string;
  subregion: string;
  text: string;
  status: string;
  issueDate: string;
  authority: string;
}

const NGA_API_URL = '/api/nga-warnings';

const CABLE_KEYWORDS = [
  'CABLE',
  'CABLESHIP',
  'CABLE SHIP',
  'CABLE LAYING',
  'CABLE OPERATIONS',
  'SUBMARINE CABLE',
  'UNDERSEA CABLE',
  'FIBER OPTIC',
  'TELECOMMUNICATIONS CABLE',
];

const CABLESHIP_PATTERNS = [
  /CABLESHIP\s+([A-Z][A-Z0-9\s\-']+)/i,
  /CABLE\s+SHIP\s+([A-Z][A-Z0-9\s\-']+)/i,
  /CS\s+([A-Z][A-Z0-9\s\-']+)/i,
  /M\/V\s+([A-Z][A-Z0-9\s\-']+)/i,
  /VESSEL\s+([A-Z][A-Z0-9\s\-']+)/i,
];

function isCableRelated(text: string): boolean {
  const upper = text.toUpperCase();
  return CABLE_KEYWORDS.some(kw => upper.includes(kw));
}

function parseCoordinates(text: string): { lat: number; lon: number }[] {
  const coords: { lat: number; lon: number }[] = [];

  // Pattern: 26-32N 056-40E or 26-32.5N 056-40.5E
  const dmsPattern = /(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])/gi;
  let match;

  while ((match = dmsPattern.exec(text)) !== null) {
    if (!match[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) continue;

    const latDeg = parseInt(match[1], 10);
    const latMin = parseFloat(match[2]);
    const latDir = match[3].toUpperCase();
    const lonDeg = parseInt(match[4], 10);
    const lonMin = parseFloat(match[5]);
    const lonDir = match[6].toUpperCase();

    let lat = latDeg + latMin / 60;
    let lon = lonDeg + lonMin / 60;

    if (latDir === 'S') lat = -lat;
    if (lonDir === 'W') lon = -lon;

    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      coords.push({ lat, lon });
    }
  }

  // Pattern: 12.345N 067.890W (decimal degrees)
  const decPattern = /(\d{1,3}\.\d+)\s*([NS])\s+(\d{1,3}\.\d+)\s*([EW])/gi;
  while ((match = decPattern.exec(text)) !== null) {
    if (!match[1] || !match[2] || !match[3] || !match[4]) continue;

    let lat = parseFloat(match[1]);
    let lon = parseFloat(match[3]);

    if (match[2].toUpperCase() === 'S') lat = -lat;
    if (match[4].toUpperCase() === 'W') lon = -lon;

    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      coords.push({ lat, lon });
    }
  }

  return coords;
}

function extractCableshipName(text: string): string | null {
  for (const pattern of CABLESHIP_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const name = match[1].trim().replace(/\s+/g, ' ');
      // Skip if it's just a generic word
      if (name.length > 2 && !/^(THE|AND|FOR|WITH)$/i.test(name)) {
        return name;
      }
    }
  }
  return null;
}

function findNearestCable(lat: number, lon: number): UnderseaCable | null {
  let nearest: UnderseaCable | null = null;
  let minDist = Infinity;

  for (const cable of UNDERSEA_CABLES) {
    for (const point of cable.points) {
      const [cableLon, cableLat] = point;
      const dist = Math.sqrt(Math.pow(lat - cableLat, 2) + Math.pow(lon - cableLon, 2));
      if (dist < minDist && dist < 5) { // Within 5 degrees
        minDist = dist;
        nearest = cable;
      }
    }
  }

  return nearest;
}

function parseIssueDate(dateStr: string): Date {
  // Format: "081653Z MAY 2024" or "101200Z JAN 2025"
  const match = dateStr.match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
  if (match && match[1] && match[2] && match[3] && match[4]) {
    const day = parseInt(match[1], 10);
    const time = match[2];
    const monthStr = match[3].toUpperCase();
    const year = parseInt(match[4], 10);

    const months: Record<string, number> = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    };

    const month = months[monthStr] ?? 0;
    const hours = parseInt(time.slice(0, 2), 10);
    const minutes = parseInt(time.slice(2, 4), 10);

    return new Date(Date.UTC(year, month, day, hours, minutes));
  }
  return new Date();
}

function determineSeverity(text: string): 'fault' | 'degraded' {
  const faultKeywords = /FAULT|BREAK|CUT|DAMAGE|SEVERED|RUPTURE|OUTAGE|FAILURE/i;
  return faultKeywords.test(text) ? 'fault' : 'degraded';
}

function determineShipStatus(text: string): 'enroute' | 'on-station' {
  const onStationKeywords = /ON STATION|OPERATIONS IN PROGRESS|LAYING|REPAIRING|WORKING|COMMENCED/i;
  return onStationKeywords.test(text) ? 'on-station' : 'enroute';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 40);
}

function processWarnings(warnings: NgaWarning[]): CableActivity {
  const advisories: CableAdvisory[] = [];
  const repairShips: RepairShip[] = [];
  const seenIds = new Set<string>();

  const cableWarnings = warnings.filter(w => isCableRelated(w.text));

  for (const warning of cableWarnings) {
    const coords = parseCoordinates(warning.text);
    const shipName = extractCableshipName(warning.text);
    const issueDate = parseIssueDate(warning.issueDate);

    // Use first coordinate or try to match to a cable
    let lat = 0;
    let lon = 0;
    let matchedCable: UnderseaCable | null = null;

    if (coords.length > 0) {
      // Use centroid of all coordinates
      lat = coords.reduce((sum, c) => sum + c.lat, 0) / coords.length;
      lon = coords.reduce((sum, c) => sum + c.lon, 0) / coords.length;
      matchedCable = findNearestCable(lat, lon);
    }

    // If no coordinates, can't place on map
    if (lat === 0 && lon === 0) continue;

    const warningId = `nga-${warning.navArea}-${warning.msgYear}-${warning.msgNumber}`;

    // If we found a cableship name, create a repair ship entry
    if (shipName) {
      const shipId = `ship-${warningId}-${slugify(shipName)}`;
      if (!seenIds.has(shipId)) {
        seenIds.add(shipId);
        repairShips.push({
          id: shipId,
          name: shipName,
          cableId: matchedCable?.id || 'unknown',
          status: determineShipStatus(warning.text),
          lat,
          lon,
          eta: determineShipStatus(warning.text) === 'on-station' ? 'On station' : 'TBD',
          operator: warning.authority || undefined,
          note: warning.text.slice(0, 200) + (warning.text.length > 200 ? '...' : ''),
        });
      }
    }

    // Create advisory for all cable-related warnings
    const advisoryId = `advisory-${warningId}`;
    if (!seenIds.has(advisoryId)) {
      seenIds.add(advisoryId);

      const isOperation = /OPERATIONS|LAYING|REPAIR|SURVEY/i.test(warning.text);
      const title = shipName
        ? `${isOperation ? 'Cable Operations' : 'Cable Activity'}: ${shipName}`
        : `NAVAREA ${warning.navArea} Cable Warning`;

      advisories.push({
        id: advisoryId,
        cableId: matchedCable?.id || 'unknown',
        title,
        severity: determineSeverity(warning.text),
        description: warning.text.slice(0, 300) + (warning.text.length > 300 ? '...' : ''),
        reported: issueDate,
        lat,
        lon,
        impact: isOperation
          ? 'Cable operations in progress. Vessels requested to give wide berth.'
          : matchedCable
            ? `Potential impact to ${matchedCable.name} cable route.`
            : 'Navigation warning in effect for cable infrastructure.',
        repairEta: undefined,
      });
    }
  }

  return { advisories, repairShips };
}

export async function fetchCableActivity(): Promise<CableActivity> {
  try {
    const data = await fetchWithCache<unknown>(NGA_API_URL, {
      ttl: 300_000,
      headers: { Accept: 'application/json' },
    });
    const warnings: NgaWarning[] = Array.isArray(data) ? data : ((data as { warnings?: NgaWarning[] })?.warnings ?? []);
    console.log(`[CableActivity] Fetched ${warnings.length} NGA warnings`);

    const activity = processWarnings(warnings);
    console.log(`[CableActivity] Found ${activity.advisories.length} advisories, ${activity.repairShips.length} repair ships`);

    return activity;
  } catch (error) {
    console.error('[CableActivity] Failed to fetch NGA warnings:', error);
    return { advisories: [], repairShips: [] };
  }
}
