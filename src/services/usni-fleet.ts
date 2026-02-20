import type { MilitaryVessel, MilitaryVesselCluster, USNIFleetReport } from '@/types';
import { createCircuitBreaker } from '@/utils';
import { getUSNIRegionApproxCoords, getUSNIRegionCoords } from '@/config/military';

const breaker = createCircuitBreaker<USNIFleetReport | null>({
  name: 'USNI Fleet Tracker',
  maxFailures: 3,
  cooldownMs: 10 * 60 * 1000,
  cacheTtlMs: 60 * 60 * 1000, // 1hr local cache
});

let lastReport: USNIFleetReport | null = null;
let lastFetchTime = 0;
const LOCAL_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function fetchUSNIFleetReport(): Promise<USNIFleetReport | null> {
  if (lastReport && Date.now() - lastFetchTime < LOCAL_CACHE_TTL) {
    return lastReport;
  }

  const report = await breaker.execute(async () => {
    const response = await fetch('/api/usni-fleet');
    if (!response.ok) throw new Error(`USNI API error: ${response.status}`);
    const data = await response.json();
    if (data.skipped || data.error) return null;
    return data as USNIFleetReport;
  }, null);

  if (report) {
    lastReport = report;
    lastFetchTime = Date.now();
  }

  return report;
}

function normalizeHull(hull: string | undefined): string {
  if (!hull) return '';
  return hull.toUpperCase().replace(/\s+/g, '').replace(/[–—]/g, '-');
}

function scatterOffset(hullNumber: string, index: number): { lat: number; lon: number } {
  let hash = 0;
  const str = hullNumber || String(index);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  const angle = (hash % 360) * (Math.PI / 180);
  const dist = 0.2 + (Math.abs(hash) % 30) * 0.01;
  return { lat: Math.sin(angle) * dist, lon: Math.cos(angle) * dist };
}

export function mergeUSNIWithAIS(
  aisVessels: MilitaryVessel[],
  usniReport: USNIFleetReport,
  aisClusters: MilitaryVesselCluster[] = [],
): { vessels: MilitaryVessel[]; clusters: MilitaryVesselCluster[] } {
  // Keep merge pure so USNI enrichment does not mutate tracked AIS vessel objects.
  const merged: MilitaryVessel[] = aisVessels.map((vessel) => ({ ...vessel }));
  const matchedHulls = new Set<string>();

  // Pass 1: Enrich AIS vessels with USNI data
  for (const vessel of merged) {
    if (!vessel.hullNumber) continue;
    const aisHull = normalizeHull(vessel.hullNumber);

    for (const usniVessel of usniReport.vessels) {
      if (normalizeHull(usniVessel.hullNumber) === aisHull) {
        vessel.usniRegion = usniVessel.region;
        vessel.usniDeploymentStatus = usniVessel.deploymentStatus;
        vessel.usniStrikeGroup = usniVessel.strikeGroup;
        vessel.usniActivityDescription = usniVessel.activityDescription;
        vessel.usniArticleUrl = usniVessel.usniArticleUrl;
        vessel.usniArticleDate = usniVessel.usniArticleDate;
        matchedHulls.add(normalizeHull(usniVessel.hullNumber));
        break;
      }
    }
  }

  // Also try name matching for vessels without hull numbers
  for (const vessel of merged) {
    if (vessel.usniRegion) continue; // Already matched
    const aisName = vessel.name.replace(/^USS\s+/i, '').toUpperCase().trim();
    if (!aisName) continue;

    for (const usniVessel of usniReport.vessels) {
      if (matchedHulls.has(normalizeHull(usniVessel.hullNumber))) continue;
      const usniName = usniVessel.name.replace(/^USS\s+/i, '').replace(/^USNS\s+/i, '').toUpperCase().trim();
      if (aisName === usniName || aisName.includes(usniName) || usniName.includes(aisName)) {
        vessel.usniRegion = usniVessel.region;
        vessel.usniDeploymentStatus = usniVessel.deploymentStatus;
        vessel.usniStrikeGroup = usniVessel.strikeGroup;
        vessel.usniActivityDescription = usniVessel.activityDescription;
        vessel.usniArticleUrl = usniVessel.usniArticleUrl;
        vessel.usniArticleDate = usniVessel.usniArticleDate;
        matchedHulls.add(normalizeHull(usniVessel.hullNumber));
        break;
      }
    }
  }

  // Pass 2: Create synthetic vessels for unmatched USNI entries
  let syntheticIndex = 0;
  for (const usniVessel of usniReport.vessels) {
    if (matchedHulls.has(normalizeHull(usniVessel.hullNumber))) continue;

    const coords = getUSNIRegionCoords(usniVessel.region);
    const hasParsedCoords = Number.isFinite(usniVessel.regionLat)
      && Number.isFinite(usniVessel.regionLon)
      && !(usniVessel.regionLat === 0 && usniVessel.regionLon === 0);
    const fallbackCoords = getUSNIRegionApproxCoords(usniVessel.region);
    const baseLat = coords?.lat ?? (hasParsedCoords ? usniVessel.regionLat : fallbackCoords.lat);
    const baseLon = coords?.lon ?? (hasParsedCoords ? usniVessel.regionLon : fallbackCoords.lon);
    const offset = scatterOffset(usniVessel.hullNumber, syntheticIndex++);

    merged.push({
      id: `usni-${usniVessel.hullNumber || usniVessel.name}`,
      mmsi: '',
      name: usniVessel.name,
      vesselType: usniVessel.vesselType,
      hullNumber: usniVessel.hullNumber,
      operator: 'usn',
      operatorCountry: 'USA',
      lat: baseLat + offset.lat,
      lon: baseLon + offset.lon,
      heading: 0,
      speed: 0,
      lastAisUpdate: new Date(usniVessel.usniArticleDate),
      confidence: 'low',
      isInteresting: usniVessel.vesselType === 'carrier' || usniVessel.vesselType === 'amphibious',
      note: `USNI position — ${usniVessel.region} (approximate)`,
      usniRegion: usniVessel.region,
      usniDeploymentStatus: usniVessel.deploymentStatus,
      usniStrikeGroup: usniVessel.strikeGroup,
      usniActivityDescription: usniVessel.activityDescription,
      usniArticleUrl: usniVessel.usniArticleUrl,
      usniArticleDate: usniVessel.usniArticleDate,
      usniSource: true,
    });
  }

  // Pass 3: Keep existing AIS clusters and append USNI-specific operational clusters.
  const usniClusters = buildUSNIClusters(merged);
  const clusters = [...aisClusters, ...usniClusters];

  return { vessels: merged, clusters };
}

function buildUSNIClusters(vessels: MilitaryVessel[]): MilitaryVesselCluster[] {
  const regionGroups = new Map<string, MilitaryVessel[]>();

  for (const v of vessels) {
    const key = v.usniStrikeGroup || v.usniRegion;
    if (!key) continue;
    if (!regionGroups.has(key)) regionGroups.set(key, []);
    regionGroups.get(key)!.push(v);
  }

  const clusters: MilitaryVesselCluster[] = [];
  for (const [name, groupVessels] of regionGroups) {
    if (groupVessels.length < 2) continue;

    const avgLat = groupVessels.reduce((s, v) => s + v.lat, 0) / groupVessels.length;
    const avgLon = groupVessels.reduce((s, v) => s + v.lon, 0) / groupVessels.length;
    const hasCarrier = groupVessels.some((v) => v.vesselType === 'carrier');

    clusters.push({
      id: `usni-cluster-${name.toLowerCase().replace(/\s+/g, '-')}`,
      name: hasCarrier ? `${name} CSG` : `${name} Naval Group`,
      lat: avgLat,
      lon: avgLon,
      vesselCount: groupVessels.length,
      vessels: groupVessels,
      region: groupVessels[0]?.usniRegion || name,
      activityType: hasCarrier ? 'deployment' : 'transit',
    });
  }

  return clusters;
}

export function getUSNIFleetStatus(): string {
  return breaker.getStatus();
}
