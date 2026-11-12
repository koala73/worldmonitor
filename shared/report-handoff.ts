/**
 * What a focused tab hands to a report (#10453, phase 3): the chosen
 * countries and the date window, in the shape the report tools take.
 *
 * Only chosen countries go: a neighbour is context on the dashboard, not a
 * place the trip visits. The travel risk assessment takes at most six
 * countries (api/mcp/registry/travel-risk-tool.ts), a focus up to twelve, so
 * the rest are returned as `omitted` for the caller to say so. Nothing is
 * dropped silently.
 */

import type { TabScope } from './tab-scope';

/** Mirrors MAX_TRIP_COUNTRIES in api/mcp/registry/travel-risk-tool.ts. */
export const REPORT_MAX_COUNTRIES = 6;

export interface ReportHandoff {
  countries: string[];
  /** Chosen countries that did not fit in the report, in focus order. */
  omitted: string[];
  dateFrom: string | null;
  dateTo: string | null;
}

export function reportHandoffFromScope(scope: TabScope): ReportHandoff {
  return {
    countries: scope.countries.slice(0, REPORT_MAX_COUNTRIES),
    omitted: scope.countries.slice(REPORT_MAX_COUNTRIES),
    dateFrom: scope.start ?? null,
    dateTo: scope.end ?? null,
  };
}

/**
 * A request to paste into an AI assistant that has the World Monitor MCP
 * connected. Plain English on purpose: it is a message to a tool user, not
 * interface copy, and it names the tool so the assistant does not guess.
 */
export function assessmentRequestText(handoff: ReportHandoff, nameOf: (code: string) => string): string {
  const lines = [
    'Use the prepare_travel_risk_assessment tool to draft a travel risk assessment.',
    `Countries, in this order: ${handoff.countries.map((code) => `${nameOf(code)} (${code})`).join(', ')}.`,
  ];
  if (handoff.dateFrom && handoff.dateTo) lines.push(`Date window: ${handoff.dateFrom} to ${handoff.dateTo}.`);
  else if (handoff.dateFrom) lines.push(`From ${handoff.dateFrom}.`);
  else if (handoff.dateTo) lines.push(`Until ${handoff.dateTo}.`);
  // Named so the analyst and the assistant both see what was left out; the
  // wording tells the assistant not to add them back.
  if (handoff.omitted.length > 0) {
    lines.push(`Not part of this request (an assessment covers at most ${REPORT_MAX_COUNTRIES} countries): ${handoff.omitted.map((code) => `${nameOf(code)} (${code})`).join(', ')}.`);
  }
  return lines.join('\n');
}
