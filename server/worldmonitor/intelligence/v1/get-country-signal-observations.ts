import type { IntelligenceServiceHandler } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { COUNTRY_SIGNAL_BYTES, COUNTRY_SIGNAL_FAMILIES, projectCountrySignalFamily, unavailableCountrySignal } from '../../../../shared/country-signal-observations';
import { isAssignedCountryCode } from '../../../../shared/country-code-resolve';
import { countryActivityQueries } from '../../../../shared/country-activity-query';
import { listInternetOutages } from '../../infrastructure/v1/list-internet-outages';
import { listUnrestEvents } from '../../unrest/v1/list-unrest-events';
import { listFireDetections } from '../../wildfire/v1/list-fire-detections';
import { listRadiationObservations } from '../../radiation/v1/list-radiation-observations';
import { listSanctionsPressure } from '../../sanctions/v1/list-sanctions-pressure';
import { listIranEvents } from '../../conflict/v1/list-iran-events';
import { readTheaterPostureSnapshot } from '../../military/v1/get-theater-posture';
import { readMilitaryFlights } from '../../military/v1/list-military-flights';
import { drainResponseHeaders, setResponseHeader } from '../../../_shared/response-headers';

export const getCountrySignalObservations: IntelligenceServiceHandler['getCountrySignalObservations'] = async (ctx, req) => {
  setResponseHeader(ctx.request, 'Cache-Control', 'no-store');
  const deadline = AbortSignal.any([ctx.request.signal, AbortSignal.timeout(15_000)]);
  const withinDeadline = <T>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
    deadline.throwIfAborted();
    const abort = () => reject(deadline.reason);
    deadline.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => deadline.removeEventListener('abort', abort));
  });
  const family = req.family.replace('COUNTRY_SIGNAL_FAMILY_', '').toLowerCase();
  if (!isAssignedCountryCode(req.countryCode)) throw new ValidationError([{ field: 'country_code', description: 'Invalid country: use an assigned uppercase ISO 3166-1 alpha-2 code.' }]);
  if (family !== 'flight_page' && !COUNTRY_SIGNAL_FAMILIES.includes(family as typeof COUNTRY_SIGNAL_FAMILIES[number])) throw new ValidationError([{ field: 'family', description: 'Invalid country signal family.' }]);
  if (family !== 'flight_page' && (req.windowIndex !== 0 || req.cursor)) throw new ValidationError([{ field: 'window_index', description: 'Unexpected pagination: non-flight families require window_index=0 and an empty cursor.' }]);
  deadline.throwIfAborted();
  if (family === 'flight_page') {
    const box = Number.isInteger(req.windowIndex) && req.windowIndex >= 0 && req.windowIndex <= 1 ? countryActivityQueries(req.countryCode)[req.windowIndex] : undefined;
    const cursorPrefix = `${req.countryCode}:w${req.windowIndex}:`;
    if (!box || req.cursor.length > 200 || req.cursor && (!req.cursor.startsWith(cursorPrefix) || !/^[1-9]\d{0,5}$/.test(req.cursor.slice(cursorPrefix.length)))) throw new ValidationError([{ field: 'cursor', description: 'Invalid country flight window or cursor.' }]);
    const flightPage = await withinDeadline(readMilitaryFlights(ctx, { neLat: box.ne_lat, neLon: box.ne_lon, swLat: box.sw_lat, swLon: box.sw_lon, pageSize: 100, cursor: req.cursor ? req.cursor.slice(cursorPrefix.length) : '', operator: 'MILITARY_OPERATOR_UNSPECIFIED', aircraftType: 'MILITARY_AIRCRAFT_TYPE_UNSPECIFIED' }, { redistributableOnly: true, allowProviderFetch: false }));
    if (flightPage.pagination?.nextCursor) flightPage.pagination = { ...flightPage.pagination, nextCursor: `${cursorPrefix}${flightPage.pagination.nextCursor}` };
    deadline.throwIfAborted();
    const response = { countryCode: req.countryCode, family: req.family, outcomeJson: '', flightPage, windowIndex: req.windowIndex };
    if (new TextEncoder().encode(JSON.stringify(response)).length > COUNTRY_SIGNAL_BYTES) throw new Error('Country flight page exceeds byte limit');
    return response;
  }
  const selected = family as typeof COUNTRY_SIGNAL_FAMILIES[number];
  try {
    const read = {
      outages: () => listInternetOutages(ctx, { country: '', start: 0, end: 0, pageSize: 0, cursor: '' }),
      unrest: () => listUnrestEvents(ctx, { country: req.countryCode, start: 0, end: 0, pageSize: 0, cursor: '', minSeverity: 'SEVERITY_LEVEL_UNSPECIFIED', neLat: 0, neLon: 0, swLat: 0, swLon: 0 }),
      fires: () => listFireDetections(ctx, { start: 0, end: 0, pageSize: 0, cursor: '', neLat: 0, neLon: 0, swLat: 0, swLon: 0 }),
      radiation: () => listRadiationObservations(ctx, { maxItems: 25 }),
      sanctions: () => listSanctionsPressure(ctx, { maxItems: 60 }),
      conflict: () => listIranEvents(ctx, {}),
      posture: () => readTheaterPostureSnapshot(ctx, { redistributableOnly: true }),
    }[selected];
    const body = await withinDeadline<unknown>(read());
    deadline.throwIfAborted();
    const headers = drainResponseHeaders(ctx.request);
    if (headers) for (const [key, value] of Object.entries(headers)) setResponseHeader(ctx.request, key, value);
    const projected = projectCountrySignalFamily(req.countryCode, selected, body);
    const outcome = headers?.['X-No-Cache'] && projected.state !== 'locked' ? unavailableCountrySignal(req.countryCode, selected, 'Source fallback cannot confirm empty country observations.') : projected;
    const response = { countryCode: req.countryCode, family: req.family, outcomeJson: JSON.stringify(outcome), windowIndex: 0 };
    while (new TextEncoder().encode(JSON.stringify(response)).length > COUNTRY_SIGNAL_BYTES && outcome.observations.length) {
      outcome.observations.pop();
      outcome.partial = true;
      if (outcome.sampledRows !== null) outcome.sampledRows = Math.max(0, outcome.sampledRows - 1);
      if (outcome.omittedRows !== null) outcome.omittedRows++;
      response.outcomeJson = JSON.stringify(outcome);
    }
    if (new TextEncoder().encode(JSON.stringify(response)).length > COUNTRY_SIGNAL_BYTES) throw new Error('Country observations exceed byte limit');
    deadline.throwIfAborted();
    return response;
  } catch (error) {
    if (deadline.aborted) throw error;
    return { countryCode: req.countryCode, family: req.family, outcomeJson: JSON.stringify(unavailableCountrySignal(req.countryCode, selected, 'Source observations unavailable.')), windowIndex: 0 };
  }
};
