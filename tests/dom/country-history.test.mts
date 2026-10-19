import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';
import { CountryHistory } from '@/components/CountryHistory';
import { fetchCountryHistory } from '@/services/country-history';

vi.mock('@/services/country-history', () => ({ fetchCountryHistory: vi.fn() }));
vi.mock('@/services/entitlements', () => ({ onEntitlementChange: () => () => {} }));

const fixture = (allowedDays = 7) => ({
  country: 'US', requestedDays: 7, allowedDays, effectiveDays: 7, returnedDays: 2, stale: false, upstreamUnavailable: false, fetchedAt: Date.now(),
  points: [
    { date: '2026-10-17', capturedAt: 1792197000000, cii: { score: 0, version: 'v10', observedAt: 1792197000000 }, topEvents: [], keySignals: [], ciiVersionBreak: false, resilienceVersionBreak: false },
    { date: '2026-10-19', capturedAt: 1792369800000, cii: { score: 40, version: 'v11', observedAt: 1792369800000 }, topEvents: [{ title: 'United States talks begin', link: 'https://example.com/talks', source: 'Example', category: 'politics' }], keySignals: [], ciiVersionBreak: true, resilienceVersionBreak: true },
  ],
});

describe('daily country history', () => {
  beforeEach(async () => { await initTestI18n(); vi.mocked(fetchCountryHistory).mockReset(); document.body.replaceChildren(); });

  it('shows event click-through, observed zero, formula breaks and the free boundary CTA', async () => {
    vi.mocked(fetchCountryHistory).mockResolvedValue(fixture());
    const mount = document.createElement('div'); document.body.append(mount);
    const widget = new CountryHistory(mount, 'US', new AbortController().signal);
    await vi.waitFor(() => expect(mount.querySelector('a[href="https://example.com/talks"]')).not.toBeNull());
    expect(mount.textContent).toContain('Formula or observation gap');
    expect(mount.textContent).toContain('Unlock 90 days');
    (mount.querySelector('[data-history-date="2026-10-17"]') as HTMLButtonElement).click();
    expect(mount.querySelector('.country-history-detail')?.textContent).toContain('CII 0');
    expect(mount.querySelector('svg path')).toBeNull();
    expect(mount.querySelectorAll('svg [tabindex="0"]')).toHaveLength(0);
    expect(mount.querySelectorAll('[data-history-date]')).toHaveLength(2);
    widget.destroy();
  });

  it('shows a Pro upsell only when the selected window reaches the 90-day boundary', async () => {
    vi.mocked(fetchCountryHistory).mockResolvedValue(fixture(90));
    const mount = document.createElement('div');
    const widget = new CountryHistory(mount, 'US', new AbortController().signal);
    await vi.waitFor(() => expect(mount.querySelector('select')).not.toBeNull());
    expect(mount.querySelector('.panel-locked-cta')).toBeNull();
    const select = mount.querySelector('select')!;
    select.value = '90'; select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(fetchCountryHistory).toHaveBeenLastCalledWith('US', 90, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(mount.textContent).toContain('365 days'));
    widget.destroy();
  });

  it('distinguishes an unavailable archive from an empty one and supports retry', async () => {
    vi.mocked(fetchCountryHistory).mockRejectedValueOnce(new Error('network'));
    const mount = document.createElement('div');
    const widget = new CountryHistory(mount, 'US', new AbortController().signal);
    await vi.waitFor(() => expect(mount.textContent).toContain('History is temporarily unavailable'));
    vi.mocked(fetchCountryHistory).mockResolvedValue({ ...fixture(), points: [], returnedDays: 0 });
    (mount.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.textContent).toContain('No daily snapshots in this window'));
    widget.destroy();
  });
});
