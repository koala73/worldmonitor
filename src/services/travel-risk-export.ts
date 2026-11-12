/**
 * The browser side of the trip assessment export (#10451, phase 2): the draft
 * the person fills in, the request it becomes, and what comes back.
 *
 * The server is the gate and the author of the document (api/travel-risk-assessment.ts).
 * This only shapes a request from countries, cities and dates, and sorts the
 * answer into something the dialog can say in plain words. Nothing here is
 * stored: the draft lives in the open dialog and nowhere else.
 */

import { premiumFetch } from './premium-fetch';
import type { ReportHandoff } from '../../shared/report-handoff';
import { REPORT_MAX_COUNTRIES } from '../../shared/report-handoff';

export const TRIP_MAX_COUNTRIES = REPORT_MAX_COUNTRIES;
export const TRIP_MAX_CITIES = 5;
export const TRIP_ENDPOINT = '/api/travel-risk-assessment';

export type TripFormat = 'markdown' | 'html';

export interface TripCountryDraft {
  code: string;
  /** Raw text of the cities field: comma, semicolon or line separated. */
  cities: string;
  /** 'YYYY-MM-DD' from a date input, or ''. */
  arrive: string;
  depart: string;
}

export interface TripDraft {
  /** In travel order. */
  countries: TripCountryDraft[];
  dateFrom: string;
  dateTo: string;
  taskLabel: string;
}

/** The dialog's starting point: the focus's countries and window, in focus order. */
export function draftFromHandoff(handoff: ReportHandoff): TripDraft {
  return {
    countries: handoff.countries.map((code) => ({ code, cities: '', arrive: '', depart: '' })),
    dateFrom: handoff.dateFrom ?? '',
    dateTo: handoff.dateTo ?? '',
    taskLabel: '',
  };
}

/** Distinct, trimmed city names, in the order typed. */
export function parseCities(text: string): string[] {
  const seen = new Set<string>();
  const cities: string[] = [];
  for (const raw of text.split(/[,;\n]/)) {
    const city = raw.trim();
    const key = city.toLowerCase();
    if (!city || seen.has(key)) continue;
    seen.add(key);
    cities.push(city);
  }
  return cities;
}

export interface TripDraftError {
  /** A locale key under `tripAssessment`. */
  key: string;
  params?: Record<string, string | number>;
}

/**
 * What can be checked without the server. The server re-checks all of it and
 * more (travel order, assigned country codes); this only saves the round trip
 * for the mistakes a form makes easy.
 */
export function validateTripDraft(draft: TripDraft, nameOf: (code: string) => string): TripDraftError | null {
  if (draft.countries.length === 0) return { key: 'tripAssessment.errNoCountries' };
  if (draft.countries.length > TRIP_MAX_COUNTRIES) return { key: 'tripAssessment.errTooMany', params: { max: TRIP_MAX_COUNTRIES } };
  if (draft.dateFrom && draft.dateTo && draft.dateTo < draft.dateFrom) return { key: 'tripAssessment.errWindow' };
  for (const country of draft.countries) {
    const name = nameOf(country.code);
    if (parseCities(country.cities).length > TRIP_MAX_CITIES) {
      return { key: 'tripAssessment.errCities', params: { name, max: TRIP_MAX_CITIES } };
    }
    if (country.arrive && country.depart && country.depart < country.arrive) {
      return { key: 'tripAssessment.errCountryDates', params: { name } };
    }
    for (const date of [country.arrive, country.depart]) {
      if (date && ((draft.dateFrom && date < draft.dateFrom) || (draft.dateTo && date > draft.dateTo))) {
        return { key: 'tripAssessment.errOutsideWindow', params: { name } };
      }
    }
  }
  return null;
}

/** The request body: only what was filled in, in the shape the MCP tool takes. */
export function buildTripRequest(draft: TripDraft, format: TripFormat): Record<string, unknown> {
  const body: Record<string, unknown> = {
    format,
    countries: draft.countries.map((country) => {
      const cities = parseCities(country.cities);
      return {
        country_code: country.code,
        ...(cities.length > 0 ? { cities } : {}),
        ...(country.arrive ? { arrive: country.arrive } : {}),
        ...(country.depart ? { depart: country.depart } : {}),
      };
    }),
  };
  if (draft.dateFrom) body.date_from = draft.dateFrom;
  if (draft.dateTo) body.date_to = draft.dateTo;
  const label = draft.taskLabel.trim();
  if (label) body.task_label = label;
  return body;
}

export interface TripViolation {
  field: string;
  description: string;
}

export type TripExportResult =
  | { ok: true; content: string; filename: string; mimeType: 'text/markdown;charset=utf-8' | 'text/html;charset=utf-8' }
  | { ok: false; reason: 'auth' | 'upgrade' | 'invalid' | 'busy' | 'unavailable' | 'error'; violations: TripViolation[] };

const FILES: Record<TripFormat, { extension: string; mimeType: 'text/markdown;charset=utf-8' | 'text/html;charset=utf-8' }> = {
  markdown: { extension: 'md', mimeType: 'text/markdown;charset=utf-8' },
  html: { extension: 'html', mimeType: 'text/html;charset=utf-8' },
};

async function violationsOf(response: Response): Promise<TripViolation[]> {
  try {
    const body = await response.json() as { violations?: unknown };
    if (!Array.isArray(body.violations)) return [];
    return body.violations
      .filter((v): v is TripViolation => v !== null && typeof v === 'object'
        && typeof (v as TripViolation).field === 'string' && typeof (v as TripViolation).description === 'string')
      .slice(0, 8);
  } catch {
    return [];
  }
}

export type TripFetch = (input: string, init: RequestInit & { forcePremium?: boolean }) => Promise<Response>;

/**
 * Asks the server for the draft. The server decides the plan: a 403 means the
 * account is not on a plan that includes it, whatever the button showed.
 */
export async function requestTripAssessment(
  draft: TripDraft,
  format: TripFormat,
  options: { fetcher?: TripFetch; signal?: AbortSignal; now?: () => number } = {},
): Promise<TripExportResult> {
  const fetcher = options.fetcher ?? premiumFetch;
  let response: Response;
  try {
    response = await fetcher(TRIP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTripRequest(draft, format)),
      signal: options.signal,
      // The path is not in the shared premium list; the session token is
      // attached because the caller says so.
      forcePremium: true,
    });
  } catch {
    return { ok: false, reason: 'error', violations: [] };
  }
  if (response.ok) {
    const { extension, mimeType } = FILES[format];
    const stamp = new Date((options.now ?? Date.now)()).toISOString().slice(0, 10);
    let content: string;
    try {
      content = await response.text();
    } catch {
      // The connection can break after the headers arrive; reading the file
      // then rejects. That is a failed build, not a thrown error.
      return { ok: false, reason: 'error', violations: [] };
    }
    return { ok: true, content, filename: `travel-risk-assessment-${stamp}.${extension}`, mimeType };
  }
  switch (response.status) {
    case 401: return { ok: false, reason: 'auth', violations: [] };
    case 403: return { ok: false, reason: 'upgrade', violations: [] };
    case 400:
    case 413: return { ok: false, reason: 'invalid', violations: await violationsOf(response) };
    case 429: return { ok: false, reason: 'busy', violations: [] };
    case 503: return { ok: false, reason: 'unavailable', violations: [] };
    default: return { ok: false, reason: 'error', violations: [] };
  }
}
