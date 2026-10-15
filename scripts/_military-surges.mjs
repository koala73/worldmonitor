const DEFAULT_SURGE_THRESHOLD = 2;
const DEFAULT_TOTAL_SURGE_THRESHOLD = 1.5;
const MIN_HISTORY_POINTS = 3;
const BASELINE_WINDOW = 12;

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function sortCounts(record = {}) {
  return Object.entries(record)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1]);
}

function normalizeSourceFamily(sourceVersion = '') {
  if (!sourceVersion) return '';
  return sourceVersion.startsWith('opensky') ? 'opensky' : sourceVersion;
}

function getComparableTheaterSnapshots(history, theaterId, sourceVersion = '') {
  const targetFamily = normalizeSourceFamily(sourceVersion);
  return history
    .filter((entry) => {
      const entryFamily = normalizeSourceFamily(entry?.sourceVersion || '');
      if (!targetFamily || !entryFamily) return true;
      return entryFamily === targetFamily;
    })
    .flatMap((entry) => Array.isArray(entry?.theaters) ? entry.theaters : [])
    .filter((snapshot) => snapshot?.theaterId === theaterId)
    .slice(-BASELINE_WINDOW);
}

function countPersistentSnapshots(snapshots, field, baseline, minCount, thresholdFactor = 1) {
  const recent = snapshots.slice(-3);
  const threshold = Math.max(minCount, baseline * thresholdFactor);
  return recent.filter((snapshot) => (snapshot?.[field] || 0) >= threshold).length;
}

export function summarizeMilitaryTheaters(flights, theaters, assessedAt = Date.now()) {
  return theaters.map((theater) => {
    const theaterFlights = flights.filter(
      (flight) =>
        flight.lat >= theater.bounds.south &&
        flight.lat <= theater.bounds.north &&
        flight.lon >= theater.bounds.west &&
        flight.lon <= theater.bounds.east,
    );

    const counts = {
      fighters: theaterFlights.filter((flight) => flight.aircraftType === 'fighter').length,
      tankers: theaterFlights.filter((flight) => flight.aircraftType === 'tanker').length,
      awacs: theaterFlights.filter((flight) => flight.aircraftType === 'awacs').length,
      reconnaissance: theaterFlights.filter((flight) => flight.aircraftType === 'reconnaissance').length,
      transport: theaterFlights.filter((flight) => flight.aircraftType === 'transport').length,
      bombers: theaterFlights.filter((flight) => flight.aircraftType === 'bomber').length,
      drones: theaterFlights.filter((flight) => flight.aircraftType === 'drone').length,
    };

    const byOperator = {};
    const byCountry = {};
    for (const flight of theaterFlights) {
      if (flight.operator) byOperator[flight.operator] = (byOperator[flight.operator] || 0) + 1;
      if (flight.operatorCountry) byCountry[flight.operatorCountry] = (byCountry[flight.operatorCountry] || 0) + 1;
    }

    const totalFlights = theaterFlights.length;
    const postureLevel = totalFlights >= theater.thresholds.critical
      ? 'critical'
      : totalFlights >= theater.thresholds.elevated
        ? 'elevated'
        : 'normal';

    const strikeCapable =
      counts.tankers >= theater.strikeIndicators.minTankers &&
      counts.awacs >= theater.strikeIndicators.minAwacs &&
      counts.fighters >= theater.strikeIndicators.minFighters;

    return {
      theaterId: theater.id,
      assessedAt,
      totalFlights,
      postureLevel,
      strikeCapable,
      ...counts,
      byOperator,
      byCountry,
    };
  });
}

export function buildMilitarySurges(theaterSummaries, history, opts = {}) {
  const surgeThreshold = opts.surgeThreshold ?? DEFAULT_SURGE_THRESHOLD;
  const totalSurgeThreshold = opts.totalSurgeThreshold ?? DEFAULT_TOTAL_SURGE_THRESHOLD;
  const minHistoryPoints = opts.minHistoryPoints ?? MIN_HISTORY_POINTS;
  const sourceVersion = opts.sourceVersion ?? '';
  const surges = [];

  for (const summary of theaterSummaries) {
    const priorSnapshots = getComparableTheaterSnapshots(history, summary.theaterId, sourceVersion);
    if (priorSnapshots.length < minHistoryPoints) continue;

    const baseline = {
      fighters: average(priorSnapshots.map((snapshot) => snapshot.fighters || 0)),
      transport: average(priorSnapshots.map((snapshot) => snapshot.transport || 0)),
      totalFlights: average(priorSnapshots.map((snapshot) => snapshot.totalFlights || 0)),
    };

    const dominantCountry = sortCounts(summary.byCountry)[0];
    const dominantOperator = sortCounts(summary.byOperator)[0];

    const maybePush = (surgeType, currentCount, baselineCount, minCount) => {
      const effectiveBaseline = Math.max(1, baselineCount);
      if (currentCount < minCount) return;
      if (currentCount < effectiveBaseline * surgeThreshold) return;
      const field = surgeType === 'fighter' ? 'fighters' : 'transport';
      const persistenceCount = countPersistentSnapshots(priorSnapshots, field, effectiveBaseline, minCount, surgeThreshold);

      surges.push({
        id: `${surgeType}-${summary.theaterId}`,
        theaterId: summary.theaterId,
        surgeType,
        currentCount,
        baselineCount: round(effectiveBaseline, 1),
        surgeMultiple: round(currentCount / effectiveBaseline),
        postureLevel: summary.postureLevel,
        strikeCapable: summary.strikeCapable,
        totalFlights: summary.totalFlights,
        fighters: summary.fighters,
        tankers: summary.tankers,
        awacs: summary.awacs,
        transport: summary.transport,
        dominantCountry: dominantCountry?.[0] || '',
        dominantCountryCount: dominantCountry?.[1] || 0,
        dominantOperator: dominantOperator?.[0] || '',
        dominantOperatorCount: dominantOperator?.[1] || 0,
        historyPoints: priorSnapshots.length,
        persistenceCount,
        persistent: persistenceCount >= 1,
        assessedAt: summary.assessedAt,
      });
    };

    maybePush('fighter', summary.fighters, baseline.fighters, 4);
    maybePush('airlift', summary.transport, baseline.transport, 5);

    const effectiveTotalBaseline = Math.max(2, baseline.totalFlights);
    const totalChangePct = ((summary.totalFlights - effectiveTotalBaseline) / effectiveTotalBaseline) * 100;
    if (
      summary.totalFlights >= Math.max(6, Math.ceil(effectiveTotalBaseline * totalSurgeThreshold)) &&
      totalChangePct >= 40
    ) {
      const persistenceCount = countPersistentSnapshots(priorSnapshots, 'totalFlights', effectiveTotalBaseline, 6, totalSurgeThreshold);
      surges.push({
        id: `air-activity-${summary.theaterId}`,
        theaterId: summary.theaterId,
        surgeType: 'air_activity',
        currentCount: summary.totalFlights,
        baselineCount: round(effectiveTotalBaseline, 1),
        surgeMultiple: round(summary.totalFlights / effectiveTotalBaseline),
        postureLevel: summary.postureLevel,
        strikeCapable: summary.strikeCapable,
        totalFlights: summary.totalFlights,
        fighters: summary.fighters,
        tankers: summary.tankers,
        awacs: summary.awacs,
        transport: summary.transport,
        dominantCountry: dominantCountry?.[0] || '',
        dominantCountryCount: dominantCountry?.[1] || 0,
        dominantOperator: dominantOperator?.[0] || '',
        dominantOperatorCount: dominantOperator?.[1] || 0,
        historyPoints: priorSnapshots.length,
        persistenceCount,
        persistent: persistenceCount >= 1,
        assessedAt: summary.assessedAt,
      });
    }
  }

  return surges;
}

export function appendMilitaryHistory(history, historyEntry, maxRuns = 72) {
  const next = Array.isArray(history) ? history.slice() : [];
  next.push(historyEntry);
  return next.slice(-maxRuns);
}
