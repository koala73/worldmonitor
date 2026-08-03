import {
  CHINA_LOGISTICS_CORRIDORS,
  CHINA_LOGISTICS_CORRIDOR_IDS,
  resolveCorridorForPoint,
  type ChinaCorridorSignalFamily,
} from '../../../../shared/china-logistics-corridors';
import type {
  ChinaCorridorSourceBundle,
  CorridorFamilySource,
  CorridorSourceSignal,
  CorridorTimePrecision,
} from '../../../../shared/china-corridor-control-towers';

type UnknownRecord = Record<string, unknown>;

export interface ChinaCorridorRawSnapshots {
  portwatchChina?: unknown;
  portwatchHongKong?: unknown;
  portwatchMeta?: unknown;
  aviation?: unknown;
  aviationMeta?: unknown;
  westernPacificCyclones?: unknown;
  westernPacificCyclonesMeta?: unknown;
  hkoWarnings?: unknown;
  hkoWarningsMeta?: unknown;
  energySpine?: unknown;
  energySpineMeta?: unknown;
  comtrade?: unknown;
  comtradeMeta?: unknown;
  shipping?: unknown;
  shippingMeta?: unknown;
}

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is UnknownRecord => item !== null)
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epochMs = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(epochMs);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function yearTimestamp(value: unknown): string | null {
  const year = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  return `${year}-12-31T23:59:59Z`;
}

function timestampPrecision(value: unknown): CorridorTimePrecision {
  if (typeof value === 'number') return 'instant';
  if (typeof value !== 'string') return 'unknown';
  if (/^\d{4}$/.test(value)) return 'year';
  if (/^\d{4}-\d{2}$/.test(value)) return 'month';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'day';
  return Number.isFinite(Date.parse(value)) ? 'instant' : 'unknown';
}

function ageMinutes(timestamp: string, assessedAt: string): number {
  return Math.max(0, Date.parse(assessedAt) - Date.parse(timestamp)) / 60_000;
}

function metaTimestamp(meta: unknown): string | null {
  return isoTimestamp(record(meta)?.fetchedAt);
}

function transportFreshness(
  meta: unknown,
  maxAgeMinutes: number,
  assessedAt: string,
): CorridorSourceSignal['transportFreshness'] {
  const fetchedAt = metaTimestamp(meta);
  if (fetchedAt === null) return 'missing';
  return ageMinutes(fetchedAt, assessedAt) > maxAgeMinutes ? 'stale' : 'fresh';
}

function contentFreshness(
  observedAt: string | null,
  maxAgeMinutes: number,
  assessedAt: string,
): CorridorSourceSignal['contentFreshness'] {
  if (observedAt === null) return 'timestamp_unknown';
  return ageMinutes(observedAt, assessedAt) > maxAgeMinutes ? 'stale' : 'current';
}

function periodicContentFreshness(
  observedAt: string | null,
  precision: CorridorTimePrecision,
  assessedAt: string,
): CorridorSourceSignal['contentFreshness'] {
  if (precision === 'unknown') return 'timestamp_unknown';
  const maxAgeDays = precision === 'year'
    ? 550
    : precision === 'month'
      ? 210
      : 90;
  return contentFreshness(observedAt, maxAgeDays * 1_440, assessedAt);
}

function metrics(entries: readonly [string, string | number | boolean | null][]) {
  return Object.fromEntries(entries.filter(([, value]) => value !== null));
}

function sourceSignal(
  input: Omit<CorridorSourceSignal, 'releaseTime' | 'releaseTimePrecision' | 'revision'> & {
    releaseTime?: string | null;
    releaseTimePrecision?: CorridorTimePrecision;
    revision?: CorridorSourceSignal['revision'];
  },
): CorridorSourceSignal {
  return {
    releaseTime: null,
    releaseTimePrecision: 'unknown',
    revision: null,
    ...input,
  };
}

function unavailableSignal(input: {
  id: string;
  family: ChinaCorridorSignalFamily;
  selectorId: string;
  corridorIds?: CorridorSourceSignal['corridorIds'];
  publisher: CorridorSourceSignal['publisher'];
  sourceUrl: string | null;
  sourceScope: CorridorSourceSignal['sourceScope'];
  retrievalTime: string | null;
  transportFreshness: CorridorSourceSignal['transportFreshness'];
  summary: string;
}): CorridorSourceSignal {
  return sourceSignal({
    ...input,
    availability: 'unavailable',
    observationTime: null,
    observationTimePrecision: 'unknown',
    retrievalTimePrecision: input.retrievalTime ? 'instant' : 'unknown',
    transportFreshness: input.transportFreshness,
    contentFreshness: 'unavailable',
    metrics: {},
  });
}

function reviewedNodeSelectors(
  family: 'port' | 'aviation',
): Array<{ selectorId: string; nodeName: string }> {
  const seen = new Set<string>();
  return CHINA_LOGISTICS_CORRIDORS.flatMap((corridor) =>
    corridor.nodes.flatMap((node) => {
      if (node.sourceSelector?.family !== family || seen.has(node.sourceSelector.id)) return [];
      seen.add(node.sourceSelector.id);
      return [{ selectorId: node.sourceSelector.id, nodeName: node.name }];
    }));
}

function family(
  providerId: string,
  signals: CorridorSourceSignal[],
  reason: string,
): CorridorFamilySource {
  return {
    providerId,
    reason,
    signals,
  };
}

function adaptPortwatch(
  snapshots: ChinaCorridorRawSnapshots,
  assessedAt: string,
): CorridorFamilySource {
  const transport = transportFreshness(snapshots.portwatchMeta, 36 * 60, assessedAt);
  const retrievalTime = metaTimestamp(snapshots.portwatchMeta);
  const signals: CorridorSourceSignal[] = [];
  for (const payloadValue of [snapshots.portwatchChina, snapshots.portwatchHongKong]) {
    const payload = record(payloadValue);
    if (!payload) continue;
    // Age the CONTENT clock, not the retrieval one (#6060). The seeder rewrites
    // `fetchedAt` on every successful fetch — including the forced refetch once
    // a country's cache passes MAX_CACHE_AGE_MS, which returns an unchanged
    // upstream `asof`. Ageing that would admit a frozen observation as current
    // for one budget window out of every cache lifetime. `contentAsOfChangedAt`
    // advances only when upstream's own max(date) advances; `fetchedAt` remains
    // the fallback for payloads written before that field existed.
    const observedAt = isoTimestamp(payload.contentAsOfChangedAt)
      ?? isoTimestamp(payload.fetchedAt);
    for (const port of records(payload.ports)) {
      const selectorId = stringValue(port.portId);
      if (!selectorId) continue;
      const portName = stringValue(port.portName) ?? selectorId;
      signals.push(sourceSignal({
        id: `signal:portwatch:${selectorId}:${observedAt ?? 'timestamp-unknown'}`,
        family: 'port',
        selectorId,
        availability: observedAt === null ? 'stale' : 'available',
        publisher: {
          id: 'publisher:imf-portwatch',
          name: 'IMF PortWatch',
          type: 'official',
        },
        sourceUrl: 'https://portwatch.imf.org/',
        sourceScope: 'node',
        observationTime: observedAt,
        observationTimePrecision: observedAt ? 'instant' : 'unknown',
        retrievalTime,
        retrievalTimePrecision: retrievalTime ? 'instant' : 'unknown',
        transportFreshness: transport,
        contentFreshness: contentFreshness(observedAt, 72 * 60, assessedAt),
        summary: `PortWatch activity observation available for ${portName}.`,
        metrics: metrics([
          ['tankerCalls30d', numberValue(port.tankerCalls30d)],
          ['trendDelta', numberValue(port.trendDelta)],
          ['importTankerDwt30d', numberValue(port.importTankerDwt30d)],
          ['exportTankerDwt30d', numberValue(port.exportTankerDwt30d)],
          ['anomalySignal', booleanValue(port.anomalySignal)],
        ]),
      }));
    }
  }
  const present = new Set(signals.map((signal) => signal.selectorId));
  for (const expected of reviewedNodeSelectors('port')) {
    if (present.has(expected.selectorId)) continue;
    signals.push(unavailableSignal({
      id: `signal:portwatch:${expected.selectorId}:unavailable`,
      family: 'port',
      selectorId: expected.selectorId,
      publisher: {
        id: 'publisher:imf-portwatch',
        name: 'IMF PortWatch',
        type: 'official',
      },
      sourceUrl: 'https://portwatch.imf.org/',
      sourceScope: 'node',
      retrievalTime,
      transportFreshness: transport,
      summary: `PortWatch observation unavailable for configured node ${expected.nodeName}.`,
    }));
  }
  return family('portwatch', signals, 'PortWatch corridor coverage is missing or stale.');
}

function adaptAviation(
  snapshots: ChinaCorridorRawSnapshots,
  assessedAt: string,
): CorridorFamilySource {
  const payload = record(snapshots.aviation);
  const transport = transportFreshness(snapshots.aviationMeta, 90, assessedAt);
  const retrievalTime = metaTimestamp(snapshots.aviationMeta);
  const signals = records(payload?.coverage).flatMap((coverage): CorridorSourceSignal[] => {
    const selectorId = stringValue(coverage.iata);
    const status = stringValue(coverage.status);
    if (!selectorId || !status) return [];
    const observedAt = isoTimestamp(coverage.updatedAt);
    const covered = status === 'normal' || status === 'disruption';
    const flightCount = covered ? numberValue(coverage.flightCount) : null;
    return [sourceSignal({
      id: `signal:aviationstack:${selectorId}:${observedAt ?? 'timestamp-unknown'}`,
      family: 'aviation',
      selectorId,
      availability: covered ? 'available' : 'unavailable',
      publisher: {
        id: 'publisher:aviationstack',
        name: 'AviationStack',
        type: 'market',
      },
      sourceUrl: 'https://aviationstack.com/',
      sourceScope: 'node',
      observationTime: observedAt,
      observationTimePrecision: observedAt ? 'instant' : 'unknown',
      retrievalTime,
      retrievalTimePrecision: retrievalTime ? 'instant' : 'unknown',
      transportFreshness: transport,
      contentFreshness: covered
        ? contentFreshness(observedAt, 180, assessedAt)
        : 'unavailable',
      summary: covered
        ? `${selectorId} provider status: ${status}.`
        : `${selectorId} provider coverage unavailable (${status}).`,
      metrics: metrics([
        ['providerStatus', status],
        ['flightCount', flightCount],
      ]),
    })];
  });
  const present = new Set(signals.map((signal) => signal.selectorId));
  for (const expected of reviewedNodeSelectors('aviation')) {
    if (present.has(expected.selectorId)) continue;
    signals.push(unavailableSignal({
      id: `signal:aviationstack:${expected.selectorId}:unavailable`,
      family: 'aviation',
      selectorId: expected.selectorId,
      publisher: {
        id: 'publisher:aviationstack',
        name: 'AviationStack',
        type: 'market',
      },
      sourceUrl: 'https://aviationstack.com/',
      sourceScope: 'node',
      retrievalTime,
      transportFreshness: transport,
      summary: `Aviation provider coverage unavailable for configured hub ${expected.nodeName}.`,
    }));
  }
  return family('aviationstack', signals, 'Aviation provider coverage is missing, omitted, or stale.');
}

function adaptHazards(
  snapshots: ChinaCorridorRawSnapshots,
  assessedAt: string,
): CorridorFamilySource {
  const cycloneSnapshot = record(snapshots.westernPacificCyclones);
  const cycloneTransport = transportFreshness(
    snapshots.westernPacificCyclonesMeta,
    540,
    assessedAt,
  );
  const cycloneRetrieval = metaTimestamp(snapshots.westernPacificCyclonesMeta);
  const eventSignals: CorridorSourceSignal[] = records(cycloneSnapshot?.events).flatMap((event) => {
    const lat = numberValue(event.lat);
    const lon = numberValue(event.lon);
    if (lat === null || lon === null) return [];
    const corridorId = resolveCorridorForPoint({ lat, lon });
    if (corridorId === null) return [];
    const eventId = stringValue(event.id);
    if (!eventId) return [];
    const observedAt = isoTimestamp(event.date);
    return [sourceSignal({
      id: `signal:western-pacific-hazard:${eventId}`,
      family: 'hazard',
      selectorId: `hazard:event:${eventId}`,
      corridorIds: [corridorId],
      availability: observedAt ? 'available' : 'stale',
      publisher: {
        id: `publisher:${String(event.sourceName ?? 'hazard-source').toLowerCase()}`,
        name: stringValue(event.sourceName) ?? 'Western Pacific hazard source',
        type: 'official',
      },
      sourceUrl: stringValue(event.sourceUrl),
      sourceScope: 'regional',
      observationTime: observedAt,
      observationTimePrecision: observedAt ? timestampPrecision(event.date) : 'unknown',
      retrievalTime: cycloneRetrieval,
      retrievalTimePrecision: cycloneRetrieval ? 'instant' : 'unknown',
      transportFreshness: cycloneTransport,
      contentFreshness: contentFreshness(observedAt, 540, assessedAt),
      summary: stringValue(event.title) ?? 'Western Pacific hazard event.',
      metrics: metrics([
        ['category', stringValue(event.category)],
        ['closed', booleanValue(event.closed)],
        ['windKt', numberValue(event.windKt)],
        ['lat', lat],
        ['lon', lon],
      ]),
    })];
  });
  const signals = [...eventSignals];
  const cycloneAvailable = cycloneSnapshot?.dataAvailable === true;
  const cycloneObservedAt = isoTimestamp(
    cycloneSnapshot?.latestObservationAt ?? cycloneSnapshot?.evaluatedAt,
  );
  for (const corridorId of CHINA_LOGISTICS_CORRIDOR_IDS) {
    const reviewedEventCount = eventSignals.filter((signal) =>
      signal.corridorIds?.includes(corridorId)).length;
    signals.push(cycloneAvailable
      ? sourceSignal({
        id: `signal:western-pacific-hazard-coverage:${corridorId}:${cycloneObservedAt ?? 'timestamp-unknown'}`,
        family: 'hazard',
        selectorId: `hazard:western-pacific-coverage:${corridorId}`,
        corridorIds: [corridorId],
        availability: cycloneObservedAt ? 'available' : 'stale',
        publisher: {
          id: 'publisher:worldmonitor-western-pacific-coverage',
          name: 'WorldMonitor Western Pacific hazard coverage',
          type: 'derived',
        },
        sourceUrl: null,
        sourceScope: 'regional',
        observationTime: cycloneObservedAt,
        observationTimePrecision: cycloneObservedAt ? 'instant' : 'unknown',
        retrievalTime: cycloneRetrieval,
        retrievalTimePrecision: cycloneRetrieval ? 'instant' : 'unknown',
        transportFreshness: cycloneTransport,
        contentFreshness: contentFreshness(cycloneObservedAt, 540, assessedAt),
        summary: `Western Pacific hazard feed available with ${reviewedEventCount} event${reviewedEventCount === 1 ? '' : 's'} inside this reviewed corridor boundary.`,
        metrics: { reviewedEventCount },
      })
      : unavailableSignal({
        id: `signal:western-pacific-hazard-coverage:${corridorId}:unavailable`,
        family: 'hazard',
        selectorId: `hazard:western-pacific-coverage:${corridorId}`,
        corridorIds: [corridorId],
        publisher: {
          id: 'publisher:worldmonitor-western-pacific-coverage',
          name: 'WorldMonitor Western Pacific hazard coverage',
          type: 'derived',
        },
        sourceUrl: null,
        sourceScope: 'regional',
        retrievalTime: cycloneRetrieval,
        transportFreshness: cycloneTransport,
        summary: 'Western Pacific hazard feed coverage is unavailable for this reviewed corridor.',
      }));
  }

  const hkoSnapshot = record(snapshots.hkoWarnings);
  const hkoTransport = transportFreshness(snapshots.hkoWarningsMeta, 540, assessedAt);
  const hkoRetrieval = metaTimestamp(snapshots.hkoWarningsMeta);
  const hkoAvailable = hkoSnapshot?.dataAvailable === true;
  const hkoItems = records(hkoSnapshot?.warnings ?? hkoSnapshot?.events);
  const hkoObservedAt = isoTimestamp(hkoSnapshot?.latestObservationAt ?? hkoSnapshot?.evaluatedAt);
  if (hkoAvailable) {
    const item = hkoItems[0];
    signals.push(sourceSignal({
      id: `signal:hko-warnings:${hkoObservedAt ?? 'timestamp-unknown'}`,
      family: 'hazard',
      selectorId: 'hazard:hko-warnings',
      availability: hkoObservedAt ? 'available' : 'stale',
      publisher: {
        id: 'publisher:hong-kong-observatory',
        name: 'Hong Kong Observatory',
        type: 'official',
      },
      sourceUrl: stringValue(item?.sourceUrl) ?? 'https://www.hko.gov.hk/en/wxinfo/dailywx/warnsummary.htm',
      sourceScope: 'regional',
      observationTime: hkoObservedAt,
      observationTimePrecision: hkoObservedAt ? 'instant' : 'unknown',
      retrievalTime: hkoRetrieval,
      retrievalTimePrecision: hkoRetrieval ? 'instant' : 'unknown',
      transportFreshness: hkoTransport,
      contentFreshness: contentFreshness(hkoObservedAt, 540, assessedAt),
      summary: hkoItems.length > 0
        ? `${hkoItems.length} HKO warning record${hkoItems.length === 1 ? '' : 's'} in the current snapshot.`
        : 'HKO warning feed available; no warning record is present in the snapshot.',
      metrics: { warningRecordCount: hkoItems.length },
    }));
  } else {
    signals.push(unavailableSignal({
      id: 'signal:hko-warnings:unavailable',
      family: 'hazard',
      selectorId: 'hazard:hko-warnings',
      publisher: {
        id: 'publisher:hong-kong-observatory',
        name: 'Hong Kong Observatory',
        type: 'official',
      },
      sourceUrl: 'https://www.hko.gov.hk/en/wxinfo/dailywx/warnsummary.htm',
      sourceScope: 'regional',
      retrievalTime: hkoRetrieval,
      transportFreshness: hkoTransport,
      summary: 'Hong Kong Observatory warning coverage is unavailable.',
    }));
  }
  return family('western-pacific-hazards', signals, 'Hazard feeds are missing or stale.');
}

function latestEnergySourceObservation(
  value: unknown,
): { timestamp: string; precision: Exclude<CorridorTimePrecision, 'unknown'> } | null {
  const sources = record(value);
  if (!sources) return null;
  const observations = Object.values(sources).flatMap((sourceValue) => {
    const numericYear = typeof sourceValue === 'number'
      && Number.isInteger(sourceValue)
      && sourceValue >= 1900
      && sourceValue <= 2200;
    const precision = numericYear ? 'year' : timestampPrecision(sourceValue);
    if (precision === 'unknown') return [];
    const timestamp = precision === 'year'
      ? yearTimestamp(sourceValue)
      : isoTimestamp(sourceValue);
    return timestamp ? [{ timestamp, precision }] : [];
  });
  return observations.reduce<{
    timestamp: string;
    precision: Exclude<CorridorTimePrecision, 'unknown'>;
  } | null>((latest, observation) =>
    latest === null || Date.parse(observation.timestamp) > Date.parse(latest.timestamp)
      ? observation
      : latest, null);
}

function adaptEnergy(
  snapshots: ChinaCorridorRawSnapshots,
  assessedAt: string,
): CorridorFamilySource {
  const payload = record(snapshots.energySpine);
  const transport = transportFreshness(snapshots.energySpineMeta, 2_880, assessedAt);
  const retrievalTime = metaTimestamp(snapshots.energySpineMeta);
  if (!payload) {
    return family('china-energy-spine', [unavailableSignal({
      id: 'signal:energy-spine:CN:unavailable',
      family: 'power_energy',
      selectorId: 'energy:spine:v1:CN',
      publisher: {
        id: 'publisher:worldmonitor-energy-spine',
        name: 'WorldMonitor energy spine',
        type: 'derived',
      },
      sourceUrl: null,
      sourceScope: 'national',
      retrievalTime,
      transportFreshness: transport,
      summary: 'National China energy-spine observation is unavailable.',
    })], 'China energy spine cache is unavailable.');
  }
  const sourceObservation = latestEnergySourceObservation(payload.sources);
  const observedAt = sourceObservation?.timestamp ?? isoTimestamp(payload.updatedAt);
  const observationPrecision = sourceObservation?.precision ?? (observedAt ? 'instant' : 'unknown');
  const coverage = record(payload.coverage);
  return family('china-energy-spine', [sourceSignal({
    id: `signal:energy-spine:CN:${observedAt ?? 'timestamp-unknown'}`,
    family: 'power_energy',
    selectorId: 'energy:spine:v1:CN',
    availability: observedAt ? 'available' : 'stale',
    publisher: {
      id: 'publisher:worldmonitor-energy-spine',
      name: 'WorldMonitor energy spine',
      type: 'derived',
    },
    sourceUrl: null,
    sourceScope: 'national',
    observationTime: observedAt,
    observationTimePrecision: observationPrecision,
    retrievalTime,
    retrievalTimePrecision: retrievalTime ? 'instant' : 'unknown',
    transportFreshness: transport,
    contentFreshness: periodicContentFreshness(observedAt, observationPrecision, assessedAt),
    summary: 'National China energy-spine dependencies available for corridor context.',
    metrics: metrics([
      ['hasMix', booleanValue(coverage?.hasMix)],
      ['hasJodiOil', booleanValue(coverage?.hasJodiOil)],
      ['hasJodiGas', booleanValue(coverage?.hasJodiGas)],
      ['hasIeaStocks', booleanValue(coverage?.hasIeaStocks)],
      ['hasEmber', booleanValue(coverage?.hasEmber)],
    ]),
  })], 'China energy spine is missing or stale.');
}

function chinaComtradeFlows(snapshot: unknown): UnknownRecord[] {
  return records(record(snapshot)?.flows).filter((flow) => String(flow.reporterCode) === '156');
}

function adaptStrategicIndustry(
  snapshots: ChinaCorridorRawSnapshots,
  assessedAt: string,
): CorridorFamilySource {
  const flows = chinaComtradeFlows(snapshots.comtrade);
  const latestYear = flows.reduce((latest, flow) =>
    Math.max(latest, numberValue(flow.year) ?? 0), 0);
  const observedAt = latestYear > 0 ? yearTimestamp(latestYear) : null;
  const transport = transportFreshness(snapshots.comtradeMeta, 2_880, assessedAt);
  const retrievalTime = metaTimestamp(snapshots.comtradeMeta);
  const productCodes = new Set(flows.map((flow) => stringValue(flow.cmdCode)).filter(Boolean));
  const signals = flows.length === 0 ? [unavailableSignal({
    id: 'signal:comtrade:156:strategic-products:unavailable',
    family: 'strategic_industry',
    selectorId: 'comtrade:reporter:156:strategic-products',
    publisher: {
      id: 'publisher:un-comtrade',
      name: 'UN Comtrade',
      type: 'official',
    },
    sourceUrl: 'https://comtradeplus.un.org/',
    sourceScope: 'national',
    retrievalTime,
    transportFreshness: transport,
    summary: 'UN Comtrade strategic-product observations for China reporter 156 are unavailable.',
  })] : [sourceSignal({
    id: `signal:comtrade:156:strategic-products:${latestYear || 'timestamp-unknown'}`,
    family: 'strategic_industry',
    selectorId: 'comtrade:reporter:156:strategic-products',
    availability: observedAt ? 'available' : 'stale',
    publisher: {
      id: 'publisher:un-comtrade',
      name: 'UN Comtrade',
      type: 'official',
    },
    sourceUrl: 'https://comtradeplus.un.org/',
    sourceScope: 'national',
    observationTime: observedAt,
    observationTimePrecision: observedAt ? 'year' : 'unknown',
    retrievalTime,
    retrievalTimePrecision: retrievalTime ? 'instant' : 'unknown',
    transportFreshness: transport,
    contentFreshness: periodicContentFreshness(
      observedAt,
      observedAt ? 'year' : 'unknown',
      assessedAt,
    ),
    summary: 'UN Comtrade strategic-product observations for China reporter 156.',
    metrics: {
      productCount: productCodes.size,
      observationYear: latestYear || null,
    },
  })];
  return family('un-comtrade-strategic-products', signals, 'China strategic-product trade observations are unavailable.');
}

function adaptTrade(
  snapshots: ChinaCorridorRawSnapshots,
  assessedAt: string,
): CorridorFamilySource {
  const signals: CorridorSourceSignal[] = [];
  const flows = chinaComtradeFlows(snapshots.comtrade);
  const latestYear = flows.reduce((latest, flow) =>
    Math.max(latest, numberValue(flow.year) ?? 0), 0);
  const comtradeObservedAt = latestYear > 0 ? yearTimestamp(latestYear) : null;
  const comtradeRetrieval = metaTimestamp(snapshots.comtradeMeta);
  if (flows.length > 0) {
    signals.push(sourceSignal({
      id: `signal:comtrade:156:${latestYear || 'timestamp-unknown'}`,
      family: 'trade',
      selectorId: 'comtrade:reporter:156',
      availability: comtradeObservedAt ? 'available' : 'stale',
      publisher: {
        id: 'publisher:un-comtrade',
        name: 'UN Comtrade',
        type: 'official',
      },
      sourceUrl: 'https://comtradeplus.un.org/',
      sourceScope: 'national',
      observationTime: comtradeObservedAt,
      observationTimePrecision: comtradeObservedAt ? 'year' : 'unknown',
      retrievalTime: comtradeRetrieval,
      retrievalTimePrecision: comtradeRetrieval ? 'instant' : 'unknown',
      transportFreshness: transportFreshness(snapshots.comtradeMeta, 2_880, assessedAt),
      contentFreshness: periodicContentFreshness(
        comtradeObservedAt,
        comtradeObservedAt ? 'year' : 'unknown',
        assessedAt,
      ),
      summary: 'UN Comtrade annual trade observations for China reporter 156.',
      metrics: {
        observationCount: flows.length,
        observationYear: latestYear || null,
      },
    }));
  } else {
    signals.push(unavailableSignal({
      id: 'signal:comtrade:156:unavailable',
      family: 'trade',
      selectorId: 'comtrade:reporter:156',
      publisher: {
        id: 'publisher:un-comtrade',
        name: 'UN Comtrade',
        type: 'official',
      },
      sourceUrl: 'https://comtradeplus.un.org/',
      sourceScope: 'national',
      retrievalTime: comtradeRetrieval,
      transportFreshness: transportFreshness(snapshots.comtradeMeta, 2_880, assessedAt),
      summary: 'UN Comtrade annual observations for China reporter 156 are unavailable.',
    }));
  }

  const shipping = record(snapshots.shipping);
  const ccfi = records(shipping?.indices).find((index) => index.indexId === 'CCFI');
  if (ccfi) {
    const history = records(ccfi.history);
    const latestHistory = history
      .map((item) => ({ item, timestamp: isoTimestamp(item.date) }))
      .filter((item): item is { item: UnknownRecord; timestamp: string } => item.timestamp !== null)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
    const observedRaw = latestHistory?.item.date ?? shipping?.fetchedAt;
    const observedAt = isoTimestamp(observedRaw);
    const retrievalTime = metaTimestamp(snapshots.shippingMeta);
    signals.push(sourceSignal({
      id: `signal:ccfi:${observedAt ?? 'timestamp-unknown'}`,
      family: 'trade',
      selectorId: 'supply_chain:shipping:v2:CCFI',
      availability: observedAt ? 'available' : 'stale',
      publisher: {
        id: 'publisher:shanghai-shipping-exchange',
        name: 'Shanghai Shipping Exchange',
        type: 'market',
      },
      sourceUrl: 'https://en.sse.net.cn/indices/ccfinew.jsp',
      sourceScope: 'national',
      observationTime: observedAt,
      observationTimePrecision: timestampPrecision(observedRaw),
      retrievalTime,
      retrievalTimePrecision: retrievalTime ? 'instant' : 'unknown',
      transportFreshness: transportFreshness(snapshots.shippingMeta, 420, assessedAt),
      contentFreshness: contentFreshness(observedAt, 28 * 1_440, assessedAt),
      summary: 'China Containerized Freight Index observation.',
      // `periodChangePct` is the publisher's own period-over-period move and is
      // absent unless the seeder proved a comparable prior (#6066). The legacy
      // `changePct` field stays unpublished: it fabricates 0 when no prior
      // exists, so a level would silently become a change.
      metrics: metrics([
        ['currentValue', numberValue(ccfi.currentValue)],
        ['periodChangePct', numberValue(ccfi.periodChangePct)],
        ['periodChangeBasis', stringValue(ccfi.periodChangeBasis)],
        ['priorPeriodValue', numberValue(ccfi.priorPeriodValue)],
        ['priorPeriodDate', stringValue(ccfi.priorPeriodDate)],
        ['unit', stringValue(ccfi.unit)],
      ]),
    }));
  } else {
    const retrievalTime = metaTimestamp(snapshots.shippingMeta);
    signals.push(unavailableSignal({
      id: 'signal:ccfi:unavailable',
      family: 'trade',
      selectorId: 'supply_chain:shipping:v2:CCFI',
      publisher: {
        id: 'publisher:shanghai-shipping-exchange',
        name: 'Shanghai Shipping Exchange',
        type: 'market',
      },
      sourceUrl: 'https://en.sse.net.cn/indices/ccfinew.jsp',
      sourceScope: 'national',
      retrievalTime,
      transportFreshness: transportFreshness(snapshots.shippingMeta, 420, assessedAt),
      summary: 'China Containerized Freight Index observation is unavailable.',
    }));
  }
  return family('china-trade-signals', signals, 'China trade and freight signals are unavailable.');
}

export function buildChinaCorridorSourceBundle(
  snapshots: ChinaCorridorRawSnapshots,
  assessedAt: string,
): ChinaCorridorSourceBundle {
  const families: Record<ChinaCorridorSignalFamily, CorridorFamilySource> = {
    port: adaptPortwatch(snapshots, assessedAt),
    aviation: adaptAviation(snapshots, assessedAt),
    hazard: adaptHazards(snapshots, assessedAt),
    power_energy: adaptEnergy(snapshots, assessedAt),
    strategic_industry: adaptStrategicIndustry(snapshots, assessedAt),
    trade: adaptTrade(snapshots, assessedAt),
  };
  return { assessedAt, families };
}
