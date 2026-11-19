import type { CrossBorderMovement, CrossBorderSourceStatus, GetCrossBorderMovementsResponse } from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { unwrapEnvelope } from '../../../_shared/seed-envelope';

export const CROSS_BORDER_SOURCES = [
  { id: 'odp', key: 'displacement:cross-border:v1', name: 'UNHCR Operational Data Portal', url: 'https://data.unhcr.org/', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', maxContentAgeMin: 45 * 1440 },
  { id: 'uk', key: 'displacement:border-uk:v1', name: 'UK Home Office', url: 'https://www.gov.uk/government/publications/migrants-detected-crossing-the-english-channel-in-small-boats', license: 'Open Government Licence v3.0', licenseUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/', maxContentAgeMin: 7.5 * 1440 },
  { id: 'cbp', key: 'displacement:border-cbp:v1', name: 'US Customs and Border Protection', url: 'https://www.cbp.gov/document/stats/nationwide-encounters', license: 'US public domain', licenseUrl: 'https://www.cbp.gov/site-policy-notices/copyright-notice', maxContentAgeMin: 75 * 1440 },
  { id: 'frontex', key: 'displacement:border-frontex:v1', name: 'Frontex', url: 'https://www.frontex.europa.eu/what-we-do/monitoring-and-risk-analysis/migratory-map/', license: 'Used with permission', licenseUrl: 'https://www.frontex.europa.eu/legal-disclaimer/', maxContentAgeMin: 75 * 1440 },
  { id: 'panama', key: 'displacement:border-panama:v1', name: 'Panama Servicio Nacional de Migración', url: 'https://www.migracion.gob.pa/estadisticas/', license: 'Used with permission', licenseUrl: 'https://www.migracion.gob.pa/estadisticas/', maxContentAgeMin: 75 * 1440 },
] as const;

export const CROSS_BORDER_SOURCE_MOVEMENT_LIMIT = 1000;

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const reportTime = (value: unknown) => {
  const date = text(value);
  const ms = Date.parse(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms : 0;
};

export function projectCrossBorderSnapshots(snapshots: Record<string, unknown>, now = Date.now()): GetCrossBorderMovementsResponse {
  const movements: CrossBorderMovement[] = [];
  const sources: CrossBorderSourceStatus[] = [];
  for (const source of CROSS_BORDER_SOURCES) {
    const envelope = unwrapEnvelope(snapshots[source.id]);
    const data = object(envelope.data);
    const fetchedAt = finite(envelope._seed?.fetchedAt) ?? 0;
    const rows = source.id === 'odp' ? list(data.situations) : list(data.routes);
    const valid = fetchedAt > 0 && fetchedAt <= now && Array.isArray(source.id === 'odp' ? data.situations : data.routes);
    const staleSeed = !valid || now - fetchedAt > 2880 * 60000;
    const status: CrossBorderSourceStatus = { id: source.id, name: source.name, status: valid ? 'ok' : 'unavailable', fetchedAt, contentAt: 0, maxContentAgeMin: source.maxContentAgeMin };
    let staleRows = 0;
    let rejectedRows = 0;
    const start = movements.length;
    function append(raw: Record<string, unknown>, situation?: Record<string, unknown>, flow?: Record<string, unknown>) {
      const asOf = text(situation ? raw.date : raw.asOf);
      const contentAt = reportTime(asOf);
      const stock = flow?.measure === 'stock';
      const kind = text(situation ? flow?.kind : raw.kind);
      if (!nonnegative(situation ? raw.individuals : raw.latestCount) || !contentAt || contentAt > now || !['arrival', 'outflow', 'return', 'encounter', 'death'].includes(kind)) { rejectedRows++; return; }
      if (movements.length - start >= CROSS_BORDER_SOURCE_MOVEMENT_LIMIT) { rejectedRows++; return; }
      const location = situation ? object(raw.location) : raw;
      const latitude = finite(location.latitude);
      const longitude = finite(location.longitude);
      const fetchedDate = new Date(fetchedAt);
      // The ODP writer judges acceleration for the month before its fetch.
      const surgeMonth = new Date(Date.UTC(fetchedDate.getUTCFullYear(), fetchedDate.getUTCMonth(), 0)).toISOString().slice(0, 7);
      const months = list(raw.months).filter(m => /^\d{4}-(0[1-9]|1[0-2])$/.test(text(m.month)) && nonnegative(m.individuals));
      const month = months.sort((a, b) => text(b.month).localeCompare(text(a.month))).find(m => text(m.month) < new Date(fetchedAt).toISOString().slice(0, 7)
        && Date.UTC(Number(text(m.month).slice(0, 4)), Number(text(m.month).slice(5)), 0) <= contentAt);
      if (situation && !stock && !month) { rejectedRows++; return; }
      const count = situation ? stock ? raw.individuals as number : nonnegative(month?.individuals) ? month.individuals : raw.individuals as number : raw.latestCount as number;
      const stale = staleSeed || now - contentAt > source.maxContentAgeMin * 60000;
      if (stale) staleRows++;
      movements.push({ id: situation ? `${text(situation.id)}:${kind}:${text(raw.iso2)}:${text(flow?.label)}` : text(raw.id),
        route: situation ? text(situation.id) : text(raw.route) || text(raw.id), name: situation ? `${text(situation.name)} · ${text(raw.country)}` : text(raw.name),
        kind, measure: situation ? text(flow?.measure) : text(raw.measure), countryCode: text(situation ? raw.iso2 : raw.countryCode),
        originCode: text(flow?.origin) || text(situation?.origin) || text(raw.originCode), asOf,
        period: situation ? stock ? asOf : text(month?.month) : text(raw.period), count,
        stockChange: stock && reportTime(object(raw.change).since) > 0 && reportTime(object(raw.change).since) <= contentAt && Number.isSafeInteger(object(raw.change).delta) ? object(raw.change).delta as number : undefined,
        stockChangeSince: stock && reportTime(object(raw.change).since) ? text(object(raw.change).since) : '',
        last7Days: nonnegative(raw.last7Days) ? raw.last7Days : undefined,
        last30Days: nonnegative(raw.last30Days) ? raw.last30Days : undefined,
        changePct: finite(raw.changePct), surge: !stale && kind === 'arrival' && ['daily', 'monthly'].includes(text(situation ? flow?.measure : raw.measure))
          && (situation ? month?.month === surgeMonth && raw.accelerating === true : raw.surge === true), stale,
        source: source.name, sourceUrl: text(situation?.sourceUrl) || source.url, license: source.license, licenseUrl: source.licenseUrl,
        notice: source.id === 'frontex'
          ? 'Source: Frontex. Used with permission. Counts are detections, not unique people. WorldMonitor aggregates nationality and border-type rows by route. No provider endorsement.'
          : source.id === 'panama'
            ? 'Source: Servicio Nacional de Migración, Panamá. Used with permission. WorldMonitor extracts complete monthly Darién arrival totals from the official report. Figures are preliminary and subject to revision. No provider endorsement.'
            : 'WorldMonitor derives and normalizes this view from the linked sources. No provider endorsement. Contains public sector information licensed under the Open Government Licence v3.0 where the source is UK Home Office.',
        location: latitude !== undefined && longitude !== undefined && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : undefined,
      });
      status.contentAt = Math.max(status.contentAt, contentAt);
    }
    if (valid) {
      if (source.id === 'odp') for (const situation of rows) for (const flow of list(situation.flows)) for (const country of list(flow.countries)) append(country, situation, flow);
      else for (const row of rows) append(row);
      const emitted = movements.length - start;
      if (staleSeed || !status.contentAt || now - status.contentAt > source.maxContentAgeMin * 60000 || (emitted > 0 && staleRows === emitted)) status.status = 'stale';
      else if (rejectedRows > 0 || staleRows > 0 || (Array.isArray(data.unavailable) && data.unavailable.length > 0)) status.status = 'partial';
    }
    sources.push(status);
  }
  return { movements, sources, dataAvailable: sources.some(s => s.status !== 'unavailable') };
}

export function filterCrossBorderMovements(data: GetCrossBorderMovementsResponse, countryCode = '', route = ''): GetCrossBorderMovementsResponse {
  return { ...data, movements: data.movements.filter(m => (!countryCode || m.countryCode === countryCode || m.originCode === countryCode) && (!route || m.route === route)) };
}
