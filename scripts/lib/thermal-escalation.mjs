const CLUSTER_RADIUS_KM = 20;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_PERSISTENCE_MS = 18 * 60 * 60 * 1000;
const BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const OBSERVATION_WINDOW_HOURS = 24;

const CONFLICT_REGIONS = new Set([
  'Ukraine',
  'Russia',
  'Israel/Gaza',
  'Syria',
  'Iran',
  'Taiwan',
  'North Korea',
  'Yemen',
  'Myanmar',
  'Sudan',
  'South Sudan',
  'Ethiopia',
  'Somalia',
  'Democratic Republic of the Congo',
  'Libya',
  'Mali',
  'Burkina Faso',
  'Niger',
  'Iraq',
  'Pakistan',
]);

const REGION_TO_COUNTRY = {
  Ukraine: { code: 'UA', name: 'Ukraine' },
  Russia: { code: 'RU', name: 'Russia' },
  Iran: { code: 'IR', name: 'Iran' },
  'Israel/Gaza': { code: 'IL', name: 'Israel / Gaza' },
  Syria: { code: 'SY', name: 'Syria' },
  Taiwan: { code: 'TW', name: 'Taiwan' },
  'North Korea': { code: 'KP', name: 'North Korea' },
  'Saudi Arabia': { code: 'SA', name: 'Saudi Arabia' },
  Turkey: { code: 'TR', name: 'Turkey' },
  Yemen: { code: 'YE', name: 'Yemen' },
  Myanmar: { code: 'MM', name: 'Myanmar' },
  Sudan: { code: 'SD', name: 'Sudan' },
  'South Sudan': { code: 'SS', name: 'South Sudan' },
  Ethiopia: { code: 'ET', name: 'Ethiopia' },
  Somalia: { code: 'SO', name: 'Somalia' },
  'Democratic Republic of the Congo': { code: 'CD', name: 'DR Congo' },
  Libya: { code: 'LY', name: 'Libya' },
  Mali: { code: 'ML', name: 'Mali' },
  'Burkina Faso': { code: 'BF', name: 'Burkina Faso' },
  Niger: { code: 'NE', name: 'Niger' },
  Iraq: { code: 'IQ', name: 'Iraq' },
  Pakistan: { code: 'PK', name: 'Pakistan' },
};

export function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

export function haversineKm(a, b) {
  const lat1 = toRad(a.latitude);
  const lon1 = toRad(a.longitude);
  const lat2 = toRad(b.latitude);
  const lon2 = toRad(b.longitude);
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function sortDetections(detections) {
  return [...detections].sort((a, b) => (a.detectedAt ?? 0) - (b.detectedAt ?? 0));
}

export function clusterDetections(detections, radiusKm = CLUSTER_RADIUS_KM) {
  const sorted = sortDetections(detections);
  const clusters = [];

  for (const detection of sorted) {
    const location = detection.location || { latitude: 0, longitude: 0 };
    let best = null;
    let bestDistance = Infinity;

    for (const cluster of clusters) {
      if ((cluster.regionLabel || '') !== (detection.region || '')) continue;
      const distance = haversineKm(cluster.centroid, location);
      if (distance <= radiusKm && distance < bestDistance) {
        best = cluster;
        bestDistance = distance;
      }
    }

    if (!best) {
      best = {
        detections: [],
        centroid: { latitude: location.latitude, longitude: location.longitude },
        regionLabel: detection.region || 'Unknown',
      };
      clusters.push(best);
    }

    best.detections.push(detection);
    const count = best.detections.length;
    best.centroid = {
      latitude: ((best.centroid.latitude * (count - 1)) + location.latitude) / count,
      longitude: ((best.centroid.longitude * (count - 1)) + location.longitude) / count,
    };
  }

  return clusters;
}

function cellKey(location) {
  const lat = Math.round((location.latitude || 0) * 2) / 2;
  const lon = Math.round((location.longitude || 0) * 2) / 2;
  return `${lat.toFixed(1)}:${lon.toFixed(1)}`;
}

function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdDev(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function severityRank(status) {
  switch (status) {
    case 'THERMAL_STATUS_PERSISTENT':
      return 4;
    case 'THERMAL_STATUS_SPIKE':
      return 3;
    case 'THERMAL_STATUS_ELEVATED':
      return 2;
    default:
      return 1;
  }
}

function relevanceRank(relevance) {
  switch (relevance) {
    case 'THERMAL_RELEVANCE_HIGH':
      return 3;
    case 'THERMAL_RELEVANCE_MEDIUM':
      return 2;
    default:
      return 1;
  }
}

function deriveContext(regionLabel) {
  if (CONFLICT_REGIONS.has(regionLabel)) return 'THERMAL_CONTEXT_CONFLICT_ADJACENT';
  return 'THERMAL_CONTEXT_WILDLAND';
}

function deriveCountry(regionLabel) {
  return REGION_TO_COUNTRY[regionLabel] || { code: 'XX', name: regionLabel || 'Unknown' };
}

function deriveConfidence(observationCount, uniqueSourceCount, baselineSamples) {
  if (observationCount >= 8 && uniqueSourceCount >= 2 && baselineSamples >= 4) return 'THERMAL_CONFIDENCE_HIGH';
  if (observationCount >= 4 && baselineSamples >= 2) return 'THERMAL_CONFIDENCE_MEDIUM';
  return 'THERMAL_CONFIDENCE_LOW';
}

function deriveStatus({ observationCount, totalFrp, countDelta, frpDelta, zScore, persistenceHours, baselineSamples }) {
  if (persistenceHours >= 12 && (countDelta >= 3 || totalFrp >= 80)) return 'THERMAL_STATUS_PERSISTENT';
  if (zScore >= 2.5 || countDelta >= 6 || frpDelta >= 120 || (observationCount >= 8 && totalFrp >= 150)) {
    return 'THERMAL_STATUS_SPIKE';
  }
  if (zScore >= 1.5 || countDelta >= 3 || frpDelta >= 50 || (baselineSamples === 0 && observationCount >= 5)) {
    return 'THERMAL_STATUS_ELEVATED';
  }
  return 'THERMAL_STATUS_NORMAL';
}

function deriveRelevance(status, context, totalFrp, persistenceHours) {
  if (
    context === 'THERMAL_CONTEXT_CONFLICT_ADJACENT' &&
    (status === 'THERMAL_STATUS_SPIKE' || status === 'THERMAL_STATUS_PERSISTENT')
  ) {
    return 'THERMAL_RELEVANCE_HIGH';
  }
  if (
    status === 'THERMAL_STATUS_PERSISTENT' ||
    totalFrp >= 120 ||
    persistenceHours >= 12
  ) {
    return 'THERMAL_RELEVANCE_MEDIUM';
  }
  return 'THERMAL_RELEVANCE_LOW';
}

function buildNarrativeFlags({ context, status, uniqueSourceCount, persistenceHours, nightDetectionShare, zScore }) {
  const flags = [];
  if (context === 'THERMAL_CONTEXT_CONFLICT_ADJACENT') flags.push('conflict_adjacent');
  if (status === 'THERMAL_STATUS_PERSISTENT') flags.push('persistent');
  if (status === 'THERMAL_STATUS_SPIKE') flags.push('spike');
  if (uniqueSourceCount >= 2) flags.push('multi_source');
  if (persistenceHours >= 12) flags.push('sustained');
  if (nightDetectionShare >= 0.5) flags.push('night_activity');
  if (zScore >= 2.5) flags.push('above_baseline');
  return flags;
}

function buildSummary(clusters) {
  return {
    clusterCount: clusters.length,
    elevatedCount: clusters.filter((cluster) => cluster.status === 'THERMAL_STATUS_ELEVATED').length,
    spikeCount: clusters.filter((cluster) => cluster.status === 'THERMAL_STATUS_SPIKE').length,
    persistentCount: clusters.filter((cluster) => cluster.status === 'THERMAL_STATUS_PERSISTENT').length,
    conflictAdjacentCount: clusters.filter((cluster) => cluster.context === 'THERMAL_CONTEXT_CONFLICT_ADJACENT').length,
    highRelevanceCount: clusters.filter((cluster) => cluster.strategicRelevance === 'THERMAL_RELEVANCE_HIGH').length,
  };
}

export function computeThermalEscalationWatch(detections, previousHistory = { cells: {} }, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const sourceVersion = options.sourceVersion ?? 'thermal-escalation-v1';
  const clusters = clusterDetections(detections, options.radiusKm ?? CLUSTER_RADIUS_KM);
  const previousCells = previousHistory?.cells ?? {};
  const nextHistory = {
    updatedAt: new Date(nowMs).toISOString(),
    cells: Object.fromEntries(
      Object.entries(previousCells)
        .map(([key, value]) => [
          key,
          {
            entries: Array.isArray(value?.entries)
              ? value.entries.filter((entry) => (nowMs - Date.parse(entry.observedAt || 0)) <= HISTORY_RETENTION_MS)
              : [],
          },
        ])
        .filter(([, value]) => value.entries.length > 0),
    ),
  };
  const output = [];

  for (const cluster of clusters) {
    const sorted = sortDetections(cluster.detections);
    if (sorted.length === 0) continue;

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const { code: countryCode, name: countryName } = deriveCountry(cluster.regionLabel);
    const key = cellKey(cluster.centroid);
    const prevEntries = Array.isArray(previousCells[key]?.entries)
      ? previousCells[key].entries.filter((entry) => (nowMs - Date.parse(entry.observedAt || 0)) <= HISTORY_RETENTION_MS)
      : [];
    const baselineEntries = prevEntries.filter((entry) => (nowMs - Date.parse(entry.observedAt || 0)) <= BASELINE_WINDOW_MS);
    const baselineCounts = baselineEntries.map((entry) => Number(entry.observationCount || 0)).filter(Number.isFinite);
    const baselineFrps = baselineEntries.map((entry) => Number(entry.totalFrp || 0)).filter(Number.isFinite);
    const baselineExpectedCount = average(baselineCounts);
    const baselineExpectedFrp = average(baselineFrps);
    const observationCount = sorted.length;
    const totalFrp = round(sorted.reduce((sum, detection) => sum + (Number(detection.frp) || 0), 0), 1);
    const maxFrp = round(sorted.reduce((max, detection) => Math.max(max, Number(detection.frp) || 0), 0), 1);
    const maxBrightness = round(sorted.reduce((max, detection) => Math.max(max, Number(detection.brightness) || 0), 0), 1);
    const avgBrightness = round(average(sorted.map((detection) => Number(detection.brightness) || 0)), 1);
    const countDelta = round(observationCount - baselineExpectedCount, 1);
    const frpDelta = round(totalFrp - baselineExpectedFrp, 1);
    const countSigma = baselineCounts.length >= 2 ? stdDev(baselineCounts, baselineExpectedCount) : 0;
    const zScore = round(countSigma > 0 ? (observationCount - baselineExpectedCount) / countSigma : 0, 2);
    const uniqueSourceCount = new Set(sorted.map((detection) => detection.satellite || 'unknown')).size;
    const nightDetectionShare = round(sorted.filter((detection) => String(detection.dayNight || '').toUpperCase() === 'N').length / observationCount, 2);
    const context = deriveContext(cluster.regionLabel);
    const lastPrevObservationMs = prevEntries.length > 0
      ? Math.max(...prevEntries.map((entry) => Date.parse(entry.observedAt || 0)).filter(Number.isFinite))
      : 0;
    const persistenceHours = round(lastPrevObservationMs > 0 && (nowMs - lastPrevObservationMs) <= RECENT_PERSISTENCE_MS
      ? (nowMs - Math.min(Number(first.detectedAt) || nowMs, lastPrevObservationMs)) / (60 * 60 * 1000)
      : (Number(last.detectedAt) - Number(first.detectedAt)) / (60 * 60 * 1000), 1);
    const status = deriveStatus({
      observationCount,
      totalFrp,
      countDelta,
      frpDelta,
      zScore,
      persistenceHours,
      baselineSamples: baselineCounts.length,
    });
    const confidence = deriveConfidence(observationCount, uniqueSourceCount, baselineCounts.length);
    const strategicRelevance = deriveRelevance(status, context, totalFrp, persistenceHours);
    const narrativeFlags = buildNarrativeFlags({
      context,
      status,
      uniqueSourceCount,
      persistenceHours,
      nightDetectionShare,
      zScore,
    });
    const clusterId = [
      countryCode.toLowerCase(),
      key.replace(/[:.]/g, '-'),
      new Date(nowMs).toISOString().slice(0, 13).replace(/[-T:]/g, ''),
    ].join(':');

    output.push({
      id: clusterId,
      centroid: {
        latitude: round(cluster.centroid.latitude, 4),
        longitude: round(cluster.centroid.longitude, 4),
      },
      countryCode,
      countryName,
      regionLabel: cluster.regionLabel,
      firstDetectedAt: new Date(Number(first.detectedAt)).toISOString(),
      lastDetectedAt: new Date(Number(last.detectedAt)).toISOString(),
      observationCount,
      uniqueSourceCount,
      maxBrightness,
      avgBrightness,
      maxFrp,
      totalFrp,
      nightDetectionShare,
      baselineExpectedCount: round(baselineExpectedCount, 1),
      baselineExpectedFrp: round(baselineExpectedFrp, 1),
      countDelta,
      frpDelta,
      zScore,
      persistenceHours: Math.max(0, persistenceHours),
      status,
      context,
      confidence,
      strategicRelevance,
      nearbyAssets: [],
      narrativeFlags,
    });

    nextHistory.cells[key] = {
      entries: [
        ...prevEntries,
        {
          observedAt: new Date(nowMs).toISOString(),
          observationCount,
          totalFrp,
          status,
        },
      ].filter((entry) => (nowMs - Date.parse(entry.observedAt || 0)) <= HISTORY_RETENTION_MS),
    };
  }

  const sortedClusters = output.sort((a, b) => {
    return (
      relevanceRank(b.strategicRelevance) - relevanceRank(a.strategicRelevance)
      || severityRank(b.status) - severityRank(a.status)
      || b.totalFrp - a.totalFrp
      || b.observationCount - a.observationCount
    );
  });

  return {
    watch: {
      fetchedAt: new Date(nowMs).toISOString(),
      observationWindowHours: OBSERVATION_WINDOW_HOURS,
      sourceVersion,
      clusters: sortedClusters,
      summary: buildSummary(sortedClusters),
    },
    history: nextHistory,
  };
}

export function emptyThermalEscalationWatch(nowMs = 0, sourceVersion = 'thermal-escalation-v1') {
  return {
    fetchedAt: nowMs > 0 ? new Date(nowMs).toISOString() : '',
    observationWindowHours: OBSERVATION_WINDOW_HOURS,
    sourceVersion,
    clusters: [],
    summary: {
      clusterCount: 0,
      elevatedCount: 0,
      spikeCount: 0,
      persistentCount: 0,
      conflictAdjacentCount: 0,
      highRelevanceCount: 0,
    },
  };
}
