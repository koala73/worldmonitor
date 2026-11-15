/**
 * #10713 unit 1: when a looked-up point falls on a watched site, the evidence
 * sheet names the site and shows its public daily record. The site is matched
 * in the browser; only its registry id is sent to WorldMonitor, never the point.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

type WithSignal = { signal?: AbortSignal };
const harness = vi.hoisted(() => ({
  lookup: null as unknown as Mock<(query: unknown, options?: WithSignal) => Promise<unknown>>,
  siteRead: null as unknown as Mock<(request: unknown, options?: WithSignal) => Promise<unknown>>,
}));

vi.mock('@/services/orbital/pass-client', () => ({
  getOrbitalPassClient: () => ({ lookup: (query: unknown, options?: WithSignal) => harness.lookup(query, options), dispose: () => {} }),
}));
vi.mock('@/services/generated-rpc-clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/generated-rpc-clients')>()),
  OrbitalServiceClient: class { getWatchedSiteImagery(request: unknown, options?: WithSignal) { return harness.siteRead(request, options); } },
}));
vi.mock('../../shared/watched-sites', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/watched-sites')>()),
  composeWatchedSites: () => [{
    id: 'port:jebel_ali', name: 'Jebel Ali', lat: 25.011, lon: 55.061, countryCode: 'AE', surface: 'maritime',
    origins: [{ list: 'port', id: 'jebel_ali' }, { list: 'military-base', id: 'jebel_ali_naval' }],
  }],
}));

import type { GetWatchedSiteImageryResponse } from '@/generated/client/worldmonitor/orbital/v1/service_client';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import type { WatchedSite } from '../../shared/watched-sites';
import { OrbitalWatchPage, type OrbitalWatchState } from '@/components/OrbitalWatchPage';
import { watchedSiteAt } from '@/services/orbital/watched-site-at';
import { openOrbitalWatch } from '@/app/orbital-watch';

const NOW = Date.UTC(2026, 10, 13, 12);
const HOUR = 3_600_000;
const onSite = { lat: 25.0123, lon: 55.0587 };
const offSite = { lat: 25.2048, lon: 55.2708 };
const site: WatchedSite = {
  id: 'port:jebel_ali', name: 'Jebel Ali', lat: 25.011, lon: 55.061, countryCode: 'AE', surface: 'maritime',
  origins: [{ list: 'port', id: 'jebel_ali' }, { list: 'military-base', id: 'jebel_ali_naval' }],
};
const record = (over: Partial<GetWatchedSiteImageryResponse> = {}): GetWatchedSiteImageryResponse => ({
  siteId: 'port:jebel_ali', name: 'Jebel Ali', lat: 25.011, lon: 55.061, evaluatedAt: NOW - 2 * HOUR, stale: false,
  latestImage: { itemId: 'S2B_X', collection: 'sentinel-2-l2a', profileId: 'sentinel-2', datetime: '2026-11-12T07:00:00Z' },
  nextPass: { satellite: 'SENTINEL-2A', profileId: 'sentinel-2', time: new Date(NOW + 5 * HOUR).toISOString() },
  ...over,
});
const passLookup = (point: { lat: number; lon: number }): PointPassLookup => ({
  point, window: { startMs: NOW - 30 * 24 * HOUR, endMs: NOW + 48 * HOUR }, nowMs: NOW,
  catalog: { status: 'fresh', fetchedAt: NOW - HOUR, inventoryVersion: 'test' },
  passes: [], satellites: [], daylight: [], computedOn: 'worker',
});
const answered = (point = onSite): OrbitalWatchState => ({
  kind: 'passes', lookup: passLookup(point),
  archives: { kind: 'answered', evidence: { passes: [], acquisitions: [], mosaics: [], frames: [], bestView: null, status: 'complete', failures: [], unansweredProfiles: [] } },
});

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const siteSection = () => sheet().querySelector<HTMLElement>('[data-section="site"]');
const bodyOrder = () => [...sheet().querySelector('.ies-body')!.children].map(
  (el) => (el as HTMLElement).dataset.section ?? (el as HTMLElement).dataset.slot,
);
const pages: OrbitalWatchPage[] = [];
function mounted(point = onSite): OrbitalWatchPage {
  const page = new OrbitalWatchPage({ onClose: vi.fn(), onRetry: vi.fn() });
  pages.push(page);
  page.open(point, null);
  page.render(answered(point));
  return page;
}

beforeAll(async () => { await initTestI18n(); });
beforeEach(() => {
  harness.lookup = vi.fn(async (query: unknown) => passLookup((query as { point: { lat: number; lon: number } }).point));
  harness.siteRead = vi.fn(async () => record());
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  document.querySelector<HTMLButtonElement>('.ies-close')?.click();
  for (const page of pages.splice(0)) page.close();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('watchedSiteAt', () => {
  it('matches a point on the site\'s 0.01-degree cell, and nothing off it', async () => {
    expect((await watchedSiteAt(onSite))?.id).toBe('port:jebel_ali');
    expect(await watchedSiteAt(offSite)).toBeNull();
    expect(await watchedSiteAt({ lat: 25.0249, lon: 55.06 })).toBeNull();
  });
});

describe('evidence sheet on a watched site', () => {
  it('names the site in the header and shows its daily record after the latest image', () => {
    const page = mounted();
    expect(siteSection()).toBeNull();
    page.setWatchedSite({ kind: 'loaded', site, record: record() });
    expect(sheet().querySelector('.ies-place')!.textContent).toBe('Jebel Ali');
    expect(sheet().querySelector('.ies-coords')!.textContent).toContain('Monitored site');
    const order = bodyOrder();
    expect(order.indexOf('site')).toBe(order.indexOf('latest') + 1);
    const block = siteSection()!.textContent ?? '';
    expect(block).toContain('Jebel Ali · port · military base');
    expect(block).toContain('SENTINEL-2');
    expect(block).toContain('SENTINEL-2A');
    expect([...siteSection()!.querySelectorAll<HTMLElement>('.ies-cell')].map((c) => c.dataset.label)).toEqual(['Latest image', 'Next pass', 'Checked']);
    expect(block, 'the change-flag row stays out while flags are in shadow').not.toMatch(/changed/i);
  });

  it('keeps a typed place name as the title', () => {
    const page = mounted();
    page.setPlaceName('Dubai');
    page.setWatchedSite({ kind: 'loaded', site, record: record() });
    expect(sheet().querySelector('.ies-place')!.textContent).toBe('Dubai');
  });

  it('says when the record is loading, failed or stale, and when no pass is on record', () => {
    const page = mounted();
    page.setWatchedSite({ kind: 'loading', site });
    expect(siteSection()!.textContent).toContain('Loading the site\'s daily record');
    page.setWatchedSite({ kind: 'failed', site });
    expect(siteSection()!.textContent).toContain('did not load');
    page.setWatchedSite({ kind: 'loaded', site, record: record({ stale: true, latestImage: undefined, nextPass: undefined }) });
    expect(siteSection()!.textContent).toContain('No current daily check on record');
    page.setWatchedSite({ kind: 'loaded', site, record: record({ latestImage: undefined, nextPass: { satellite: 'S', profileId: 'sentinel-2', time: new Date(NOW - HOUR).toISOString() } }) });
    expect(siteSection()!.textContent).toContain('No recent image');
    expect(siteSection()!.textContent).toContain('No upcoming pass on record');
  });

  it('keeps the record readable while passes compute and when pass data is unavailable', () => {
    const page = mounted();
    page.render({ kind: 'computing', done: 3, total: 9 });
    page.setWatchedSite({ kind: 'loaded', site, record: record() });
    const cells = () => siteSection()!.querySelectorAll('.ies-cell').length;
    expect(cells()).toBe(3);
    page.render({ kind: 'unavailable' });
    expect(cells()).toBe(3);
  });

  it('drops the block when the sheet opens on another point', () => {
    const page = mounted();
    page.setWatchedSite({ kind: 'loaded', site, record: record() });
    page.open(offSite, null);
    page.render(answered(offSite));
    expect(siteSection()).toBeNull();
    expect(sheet().querySelector('.ies-coords')!.textContent).not.toContain('Monitored site');
  });
});

describe('opening the lookup on a watched site', () => {
  it('reads the site record by site id only, never the point', async () => {
    openOrbitalWatch(onSite, null);
    await vi.waitFor(() => expect(siteSection()?.textContent).toContain('SENTINEL-2A'));
    expect(harness.siteRead).toHaveBeenCalledTimes(1);
    const [request] = harness.siteRead.mock.calls[0]!;
    expect(request).toEqual({ siteId: 'port:jebel_ali' });
    expect(JSON.stringify(request)).not.toMatch(/25\.01|55\.05/);
  });

  it('reads nothing for a point off every watched site', async () => {
    openOrbitalWatch(offSite, null);
    await vi.waitFor(() => expect(harness.lookup).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.siteRead).not.toHaveBeenCalled();
    expect(siteSection()).toBeNull();
  });

  it('shows the failure when the record does not load', async () => {
    harness.siteRead.mockRejectedValueOnce(new Error('503'));
    openOrbitalWatch(onSite, null);
    await vi.waitFor(() => expect(siteSection()?.textContent).toContain('did not load'));
  });

  it('aborts the site read when the sheet closes', async () => {
    let signal: AbortSignal | undefined;
    harness.siteRead.mockImplementationOnce((_request, options) => { signal = options?.signal; return new Promise(() => {}); });
    openOrbitalWatch(onSite, null);
    await vi.waitFor(() => expect(signal).toBeDefined());
    document.querySelector<HTMLButtonElement>('.ies-close')!.click();
    expect(signal!.aborted).toBe(true);
  });
});
