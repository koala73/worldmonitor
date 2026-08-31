import { addLocalDays, localYmd } from '@/utils/local-date';
import { escapeHtml } from '@/utils/sanitize';
import {
  NQ_EARNINGS_WINDOW_DAYS,
  NQ_INFLUENCE_SYMBOLS,
  NQ_MACRO_WINDOW_DAYS,
  NQ_PULSE_DISCLOSURE,
} from '@/config/nq-context';
import { freshnessLabelForAsOf, nqPulseAsOfLabel, type NqFreshnessLabel } from './nq-pulse-content';

export const NQ_EARNINGS_EMPTY = 'No tracked NQ earnings in this window';
export const NQ_MACRO_EMPTY = 'No high-impact US releases in this window';
export const NQ_SECTION_UNAVAILABLE = 'Unavailable';

export interface NqMacroEvent {
  event: string;
  country: string;
  date: string;
  impact: string;
  actual?: string;
  estimate?: string;
  previous?: string;
  unit?: string;
}

export interface NqEarningsEntry {
  symbol: string;
  company: string;
  date: string;
  hour?: string;
}

const INFLUENCE_SET = new Set<string>(NQ_INFLUENCE_SYMBOLS);

function inLocalWindow(date: string, from: string, to: string): boolean {
  return Boolean(date) && date >= from && date <= to;
}

export function filterNqMacroEvents(
  events: readonly NqMacroEvent[],
  now: Date = new Date(),
): NqMacroEvent[] {
  const from = localYmd(now);
  const to = localYmd(addLocalDays(now, NQ_MACRO_WINDOW_DAYS));
  return events
    .filter((event) => (
      event.country === 'US'
      && event.impact.toLowerCase() === 'high'
      && inLocalWindow(event.date, from, to)
    ))
    .sort((a, b) => a.date.localeCompare(b.date) || a.event.localeCompare(b.event));
}

export function filterNqEarnings(
  earnings: readonly NqEarningsEntry[],
  now: Date = new Date(),
): NqEarningsEntry[] {
  const from = localYmd(now);
  const to = localYmd(addLocalDays(now, NQ_EARNINGS_WINDOW_DAYS));
  return earnings
    .filter((entry) => INFLUENCE_SET.has(entry.symbol) && inLocalWindow(entry.date, from, to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
}

function formatHour(hour: string | undefined): string {
  if (!hour) return 'Time unknown';
  return hour;
}

export function composeNqCatalystsHtml(input: {
  macro: readonly NqMacroEvent[];
  earnings: readonly NqEarningsEntry[];
  macroUnavailable: boolean;
  earningsUnavailable: boolean;
  macroAsOf?: string;
  earningsAsOf?: string;
  nowMs?: number;
}): string {
  const nowMs = input.nowMs ?? Date.now();
  const macroFreshness = input.macroUnavailable
    ? 'Freshness unavailable'
    : freshnessLabelForAsOf(input.macroAsOf, nowMs);
  const earningsFreshness = input.earningsUnavailable
    ? 'Freshness unavailable'
    : freshnessLabelForAsOf(input.earningsAsOf, nowMs);

  return `
    <section class="nq-catalysts-section">
      <h3>US macro</h3>
      ${renderMacroBody(input.macro, input.macroUnavailable)}
      ${renderSectionFreshness(macroFreshness, input.macroAsOf)}
    </section>
    <section class="nq-catalysts-section">
      <h3>NQ influence earnings</h3>
      ${renderEarningsBody(input.earnings, input.earningsUnavailable)}
      ${renderSectionFreshness(earningsFreshness, input.earningsAsOf)}
    </section>
    <div class="nq-pulse-disclosure">${escapeHtml(NQ_PULSE_DISCLOSURE)}</div>`;
}

function renderSectionFreshness(freshness: NqFreshnessLabel, asOf: string | undefined): string {
  return `<div class="nq-catalysts-freshness">
    <span>${escapeHtml(freshness)}</span>
    <span>${escapeHtml(nqPulseAsOfLabel(asOf, freshness))}</span>
  </div>`;
}

function renderMacroBody(events: readonly NqMacroEvent[], unavailable: boolean): string {
  if (unavailable) {
    return `<div class="nq-catalysts-empty">${escapeHtml(NQ_SECTION_UNAVAILABLE)}</div>`;
  }
  if (events.length === 0) {
    return `<div class="nq-catalysts-empty">${escapeHtml(NQ_MACRO_EMPTY)}</div>`;
  }
  return events.map((event) => `
    <div class="nq-catalysts-row">
      <span class="nq-catalysts-date">${escapeHtml(event.date)}</span>
      <span class="nq-catalysts-name">${escapeHtml(event.event)}</span>
      <span class="nq-catalysts-time">Time unknown</span>
    </div>`).join('');
}

function renderEarningsBody(entries: readonly NqEarningsEntry[], unavailable: boolean): string {
  if (unavailable) {
    return `<div class="nq-catalysts-empty">${escapeHtml(NQ_SECTION_UNAVAILABLE)}</div>`;
  }
  if (entries.length === 0) {
    return `<div class="nq-catalysts-empty">${escapeHtml(NQ_EARNINGS_EMPTY)}</div>`;
  }
  return entries.map((entry) => `
    <div class="nq-catalysts-row">
      <span class="nq-catalysts-date">${escapeHtml(entry.date)}</span>
      <span class="nq-catalysts-name">${escapeHtml(entry.symbol)}${entry.company ? ` · ${escapeHtml(entry.company)}` : ''}</span>
      <span class="nq-catalysts-time">${escapeHtml(formatHour(entry.hour))}</span>
    </div>`).join('');
}
