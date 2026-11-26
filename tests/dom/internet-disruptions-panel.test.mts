/**
 * Issue #11273: the Internet Disruptions panel must state each event's
 * lifecycle from its end time, show outage dates, and count only DDoS rows it
 * renders.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { InternetDisruptionsPanel } from '@/components/InternetDisruptionsPanel';
import type { InternetOutage } from '@/types';
import type {
  ListInternetDdosAttacksResponse,
  TrafficAnomaly,
} from '@/generated/client/worldmonitor/infrastructure/v1/service_client';

beforeAll(async () => {
  await initTestI18n();
});

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
const tab = (name: string) => el().querySelector<HTMLButtonElement>(`.id-tab-btn[data-tab="${name}"]`)!;
const rowFor = (title: string) =>
  [...el().querySelectorAll('.id-row')].find((n) => n.querySelector('.id-row-title')?.textContent === title);
const badges = (row: Element | undefined) => [...(row?.querySelectorAll('.id-badge') ?? [])].map((b) => b.textContent);
const meta = (row: Element | undefined) => [...(row?.querySelectorAll('.id-row-meta') ?? [])].map((m) => m.textContent);
const fmt = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function anomaly(uuid: string, locationName: string, status: string, startDate: number, endDate: number): TrafficAnomaly {
  return {
    uuid, type: 'ANOMALY_ASN', status, startDate, endDate,
    asn: '27653', asnName: 'DIGICEL HAITI', locationCode: '', locationName, latitude: 0, longitude: 0,
  };
}

describe('InternetDisruptionsPanel anomalies', () => {
  it('labels an open verified anomaly ongoing and an ended one with its end time, open rows first', () => {
    const start = Date.parse('2026-11-24T20:00:00Z');
    const end = Date.parse('2026-11-25T01:00:00Z');
    panel.setAnomalies([
      anomaly('ended', 'Guyana', 'VERIFIED', start + 3_600_000, end),
      anomaly('open', 'Haiti', 'VERIFIED', start, 0),
    ]);
    tab('anomalies').click();

    const titles = [...el().querySelectorAll('.id-row .id-row-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Haiti', 'Guyana']);
    expect(badges(rowFor('Haiti'))).toEqual(['⚡ ONGOING']);
    expect(meta(rowFor('Haiti'))).toContain(fmt(start));
    expect(badges(rowFor('Guyana'))).toEqual(['ENDED']);
    expect(meta(rowFor('Guyana'))).toContain(`${fmt(start + 3_600_000)} – ${fmt(end)}`);
    expect(el().textContent).not.toContain('HISTORICAL');
  });
});

describe('InternetDisruptionsPanel outages', () => {
  const detected = Date.parse('2026-11-24T20:00:00Z');
  const ended = Date.parse('2026-11-24T23:30:00Z');
  const outage = (id: string, country: string, endDate?: Date): InternetOutage => ({
    id, title: `Internet disruption in ${country}`, link: 'https://radar.example/outage', description: '',
    pubDate: new Date(detected), country, lat: 0, lon: 0, severity: 'total', categories: ['Cloudflare Radar'],
    cause: 'POWER_OUTAGE', endDate,
  });

  it('shows the detected and end dates with a resolved badge on an ended outage', () => {
    panel.setOutages([outage('gy', 'Guyana', new Date(ended)), outage('ht', 'Haiti')]);

    expect(badges(rowFor('Guyana'))).toEqual(['NATIONWIDE', 'RESOLVED']);
    expect(meta(rowFor('Guyana'))).toContain(`${fmt(detected)} – ${fmt(ended)}`);
    expect(badges(rowFor('Haiti'))).toEqual(['NATIONWIDE', '⚡ LIVE']);
    expect(meta(rowFor('Haiti'))).toContain(fmt(detected));
  });
});

describe('InternetDisruptionsPanel DDoS', () => {
  it('counts exactly the protocol and vector rows it renders', () => {
    const entries = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ label: `${prefix} ${i + 1}`, percentage: 10 - i * 0.5 }));
    const ddos: ListInternetDdosAttacksResponse = {
      protocol: entries('Protocol', 4),
      vector: entries('Vector', 10),
      dateRangeStart: '2026-11-18T00:00:00Z',
      dateRangeEnd: '2026-11-25T00:00:00Z',
      topTargetLocations: [],
    };
    panel.setDdos(ddos);
    tab('ddos').click();

    const rendered = el().querySelectorAll('.id-ddos .id-bar-row').length;
    expect(tab('ddos').querySelector('.id-tab-count')?.textContent).toBe(String(rendered));
    expect(rendered).toBe(14);
  });
});
