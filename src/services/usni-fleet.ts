import type { MilitaryVessel, MilitaryVesselCluster, USNIFleetReport, USNIVesselEntry } from '@/types';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils';
import { getUSNIRegionApproxCoords, getUSNIRegionCoords, HULL_HOMEPORT } from '@/config/military';
import {
  MilitaryServiceClient,
  type GetUSNIFleetReportResponse,
} from '@/generated/client/worldmonitor/military/v1/service_client';

const client = new MilitaryServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const breaker = createCircuitBreaker<USNIFleetReport | null>({
  name: 'USNI Fleet Tracker',
  maxFailures: 3,
  cooldownMs: 10 * 60 * 1000,
  cacheTtlMs: 60 * 60 * 1000, // 1hr local cache
  persistCache: true,
});

function mapProtoToReport(resp: GetUSNIFleetReportResponse): USNIFleetReport | null {
  const r = resp.report;
  if (!r) return null;

  const vessels: USNIVesselEntry[] = r.vessels.map((v) => ({
    name: v.name,
    hullNumber: v.hullNumber,
    vesselType: v.vesselType as USNIVesselEntry['vesselType'],
    region: v.region,
    regionLat: v.regionLat,
    regionLon: v.regionLon,
    deploymentStatus: v.deploymentStatus as USNIVesselEntry['deploymentStatus'],
    homePort: v.homePort || undefined,
    strikeGroup: v.strikeGroup || undefined,
    activityDescription: v.activityDescription || undefined,
    usniArticleUrl: v.articleUrl,
    usniArticleDate: v.articleDate,
  }));

  return {
    articleUrl: r.articleUrl,
    articleDate: r.articleDate,
    articleTitle: r.articleTitle,
    battleForceSummary: r.battleForceSummary,
    vessels,
    strikeGroups: r.strikeGroups,
    regions: r.regions,
    parsingWarnings: r.parsingWarnings,
    timestamp: new Date(r.timestamp).toISOString(),
  };
}

export async function fetchUSNIFleetReport(): Promise<USNIFleetReport | null> {
  return breaker.execute(async () => {
    const resp = await client.getUSNIFleetReport({ forceRefresh: false });
    if (resp.error && !resp.report) return null;
    return mapProtoToReport(resp);
  }, null, { shouldCache: (result) => result !== null });
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

/** Tighter scatter for in-port ships — just enough to separate icons at the same pier. */
function portScatterOffset(hullNumber: string, index: number): { lat: number; lon: number } {
  let hash = 0;
  const str = hullNumber || String(index);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  const angle = (hash % 360) * (Math.PI / 180);
  const dist = 0.01 + (Math.abs(hash) % 10) * 0.003; // 0.01–0.04 deg ≈ 1–4 km
  return { lat: Math.sin(angle) * dist, lon: Math.cos(angle) * dist };
}

/** Resolve homeport coordinates for an in-port vessel.
 *  Option A: USNI text supplied an explicit homePort string.
 *  Option B: Fall back to hull-number lookup table.
 *  Returns undefined if neither resolves. */
function resolvePortCoords(
  homePort: string | undefined,
  hullNumber: string | undefined,
): { lat: number; lon: number; portName: string } | undefined {
  // Option A — use what USNI actually told us
  if (homePort) {
    const coords = getUSNIRegionCoords(homePort);
    if (coords) return { ...coords, portName: homePort };
  }
  // Option B — hull number fallback table
  if (hullNumber) {
    const normalized = hullNumber.toUpperCase().replace(/\s+/g, '').replace(/[–—]/g, '-');
    const portName = HULL_HOMEPORT[normalized];
    if (portName) {
      const coords = getUSNIRegionCoords(portName);
      if (coords) return { ...coords, portName };
    }
  }
  return undefined;
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
        const portRes = usniVessel.deploymentStatus === 'in-port'
          ? resolvePortCoords(usniVessel.homePort, usniVessel.hullNumber)
          : undefined;
        vessel.usniHomePort = portRes?.portName ?? usniVessel.homePort;
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
        const portRes = usniVessel.deploymentStatus === 'in-port'
          ? resolvePortCoords(usniVessel.homePort, usniVessel.hullNumber)
          : undefined;
        vessel.usniHomePort = portRes?.portName ?? usniVessel.homePort;
        matchedHulls.add(normalizeHull(usniVessel.hullNumber));
        break;
      }
    }
  }

  // Pass 2: Create synthetic vessels for unmatched USNI entries
  let syntheticIndex = 0;
  for (const usniVessel of usniReport.vessels) {
    if (matchedHulls.has(normalizeHull(usniVessel.hullNumber))) continue;

    // Resolve position: in-port ships use port coords (Option A + B),
    // deployed/underway ships use deployment theater coords.
    const inPort = usniVessel.deploymentStatus === 'in-port';
    const portResolution = inPort
      ? resolvePortCoords(usniVessel.homePort, usniVessel.hullNumber)
      : undefined;

    const regionCoords = getUSNIRegionCoords(usniVessel.region);
    const hasParsedCoords = Number.isFinite(usniVessel.regionLat)
      && Number.isFinite(usniVessel.regionLon)
      && !(usniVessel.regionLat === 0 && usniVessel.regionLon === 0);
    const fallbackCoords = getUSNIRegionApproxCoords(usniVessel.region);

    const baseLat = portResolution?.lat
      ?? regionCoords?.lat
      ?? (hasParsedCoords ? usniVessel.regionLat : fallbackCoords.lat);
    const baseLon = portResolution?.lon
      ?? regionCoords?.lon
      ?? (hasParsedCoords ? usniVessel.regionLon : fallbackCoords.lon);

    const offset = portResolution
      ? portScatterOffset(usniVessel.hullNumber, syntheticIndex++)
      : scatterOffset(usniVessel.hullNumber, syntheticIndex++);

    const noteBase = portResolution
      ? `In port — ${portResolution.portName} (USNI)`
      : `USNI position — ${usniVessel.region} (approximate)`;

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
      note: noteBase,
      usniRegion: usniVessel.region,
      usniDeploymentStatus: usniVessel.deploymentStatus,
      usniHomePort: portResolution?.portName ?? usniVessel.homePort,
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
