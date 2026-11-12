/**
 * Dashboard focus (#10453), internet disruptions: each outage names its
 * country (a Cloudflare Radar name). Under a focus the Outages tab lists the
 * chosen countries, then neighbours marked, and counts the rest. The DDoS and
 * Anomalies tabs are global and say so in the strip.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { InternetDisruptionsPanel } from '@/components/InternetDisruptionsPanel';
import type { InternetOutage } from '@/types';
import type { ResolvedScope } from '@/services/tab-focus';
import { resolveScope } from '../../shared/tab-scope-resolve';

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
// TH's neighbours are KH, LA, MM and MY.
const FOCUS = scopeOf(['TH']);

function outage(id: string, country: string, severity: InternetOutage['severity']): InternetOutage {
  return {
    id,
    title: `Internet disruption in ${country}`,
    link: 'https://radar.example/outage',
    description: '',
    pubDate: new Date('2026-11-10T00:00:00.000Z'),
    country,
    lat: 0,
    lon: 0,
    severity,
    categories: ['Cloudflare Radar'],
  };
}

// Severity order unfocused: total, major, partial.
const OUTAGES = [
  outage('th', 'Thailand', 'partial'),
  outage('us', 'United States', 'major'),
  outage('la', 'Laos', 'total'),
  outage('xx', 'Atlantis', 'major'),
];

let panel: InternetDisruptionsPanel;

beforeEach(() => {
  panel = new InternetDisruptionsPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  document.body.innerHTML = '';
});

const el = () => panel.getElement();
const countries = () => [...el().querySelectorAll('.id-row .id-row-title')].map((n) => n.textContent);
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const rowFor = (country: string) => [...el().querySelectorAll('.id-row')].find((n) => n.querySelector('.id-row-title')?.textContent === country);
const count = () => el().querySelector('.panel-count')?.textContent;
const tab = (name: string) => el().querySelector<HTMLButtonElement>(`.id-tab-btn[data-tab="${name}"]`)!;

describe('InternetDisruptionsPanel under a focus', () => {
  it('lists the chosen country then the marked neighbour, and counts hidden and no-country outages', () => {
    panel.setOutages(OUTAGES);
    panel.applyScope(FOCUS);

    expect(countries()).toEqual(['Thailand', 'Laos']);
    expect(rowFor('Laos')?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Laos');
    expect(rowFor('Thailand')?.querySelector('.panel-scope-tag')).toBeNull();
    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
    // The panel and tab counts follow the focus.
    expect(count()).toBe('2');
    expect(tab('outages').querySelector('.id-tab-count')?.textContent).toBe('2');
  });

  it('shows the unresolved outage on request, Show all shows everything in severity order', () => {
    panel.setOutages(OUTAGES);
    panel.applyScope(FOCUS);
    stripButton('show-unattributed')!.click();
    expect(countries()).toEqual(['Thailand', 'Laos', 'Atlantis']);
    expect(rowFor('Atlantis')?.querySelector('.panel-scope-tag-none')?.textContent).toBe('No country');

    stripButton('show-all')!.click();
    expect(countries()).toEqual(['Laos', 'United States', 'Atlantis', 'Thailand']);
    expect(count()).toBe('4');
    stripButton('apply')!.click();
    expect(countries()).toEqual(['Thailand', 'Laos', 'Atlantis']);
  });

  it('says the DDoS and Anomalies tabs are not filtered, and filters again on Outages', () => {
    panel.setOutages(OUTAGES);
    panel.setAnomalies([]);
    panel.applyScope(FOCUS);
    tab('ddos').click();
    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toContain('This tab is not filtered by country');
    expect(stripButton('show-all')).toBeNull();
    tab('anomalies').click();
    expect(strip()?.textContent).toContain('This tab is not filtered by country');
    tab('outages').click();
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(countries()).toEqual(['Thailand', 'Laos']);
  });

  it('applies a focus set before the data arrives, and clears back to the full list', () => {
    panel.applyScope(scopeOf(['TH'], false));
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelector('.panel-loading-text, .panel-loading-radar')).toBeTruthy();
    panel.setOutages(OUTAGES);
    expect(countries()).toEqual(['Thailand']);
    panel.applyScope(null);
    expect(countries()).toEqual(['Laos', 'United States', 'Atlantis', 'Thailand']);
    expect(strip()?.hidden).toBe(true);
  });

  it('says nothing matched the focus, distinct from "no outages", and keeps the counts reachable', () => {
    panel.setOutages(OUTAGES);
    panel.applyScope(scopeOf(['NZ'], false));
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('No internet disruptions for these countries');
    expect(el().querySelector('.id-empty')).toBeNull();
    expect(strip()?.textContent).toContain('3 hidden by focus');
    stripButton('show-all')!.click();
    expect(countries()).toHaveLength(4);
  });

  it('with no outages at all shows the panel empty state and no strip', () => {
    panel.setOutages([]);
    panel.applyScope(FOCUS);
    expect(el().querySelector('.id-empty')).not.toBeNull();
    expect(el().querySelector('.panel-scope-empty')).toBeNull();
    expect(strip()?.hidden).toBe(true);
  });

  it('hides the strip after a load failure, and a focus change keeps the failure', () => {
    panel.applyScope(FOCUS);
    panel.showError('Outages failed');
    expect(strip()?.hidden).toBe(true);
    panel.applyScope(null);
    panel.applyScope(scopeOf(['US']));
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Outages failed');
    expect(strip()?.hidden).toBe(true);
    panel.setOutages(OUTAGES);
    expect(countries()).toEqual(['United States']);
    expect(strip()?.hidden).toBe(false);
  });

  it('is unchanged without a focus', () => {
    panel.setOutages(OUTAGES);
    expect(countries()).toEqual(['Laos', 'United States', 'Atlantis', 'Thailand']);
    expect(el().querySelector('.panel-scope-tag')).toBeNull();
    expect(strip()?.hidden).toBe(true);
    expect(count()).toBe('4');
  });
});
