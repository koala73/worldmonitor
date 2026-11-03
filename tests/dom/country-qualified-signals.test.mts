import { beforeAll, describe, expect, it, vi } from 'vitest';
import { qualifiedFixtureOutcomes } from '../../src/e2e/fixtures/qualified-country-signals';
import { COUNTRY_SIGNAL_FAMILIES, projectQualifiedCountrySignals, projectQualifiedCountrySignalContext, unavailableCountrySignal } from '../../shared/country-signal-observations';
import { initTestI18n } from './helpers/i18n.mts';
vi.mock('@/services/premium-fetch', () => ({ premiumFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }));
import { createHostCountryBriefSource, createWebsiteCountryBriefSource } from '@/services/country-brief-source';
import { loadQualifiedCountrySignals } from '@/services/country-signal-projection';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { countrySignalsFromMilitary } from '@/services/country-signals';
import type { loadHostCountryMilitaryActivity } from '@/services/country-military-activity';

beforeAll(async () => { await initTestI18n(); });
const military = () => Promise.resolve({ qualified: qualifiedFixtureOutcomes().find(row => row.family === 'military')! } as Awaited<ReturnType<typeof loadHostCountryMilitaryActivity>>);
it.each([401, 403])('clears prior family observations after actual website HTTP %i', async status => {
  const previous = projectQualifiedCountrySignals('IR', qualifiedFixtureOutcomes());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Denied', { status })));
  try {
    const next = await loadQualifiedCountrySignals(createWebsiteCountryBriefSource(), 'IR', new AbortController().signal, military(), previous);
    expect(next.families.find(row => row.family === 'radiation')).toMatchObject({ state: 'locked', observations: [] });
    expect(next.details?.critical).toBe(0);
    expect(next.families.filter(row => row.family !== 'military').every(row => row.state === 'locked')).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
it.each([401, 403])('clears prior observations through the actual MCP HTTP %i carrier and native adapter', async status => {
  const { COUNTRY_VIEW_TOOLS } = await import('../../api/mcp/registry/country-view');
  const tool = COUNTRY_VIEW_TOOLS.find(value => value.name === 'get_country_brief_section')!;
  vi.stubEnv('MCP_INTERNAL_HMAC_SECRET', 'controlled-country-signals-denial-fixture-secret-0123456789abcdef');
  const previous = projectQualifiedCountrySignals('IR', qualifiedFixtureOutcomes());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Denied', { status })));
  try {
    const source = await createHostCountryBriefSource(async (_name, args) => {
      const result = await tool._execute!(args as Record<string, unknown>, 'https://www.worldmonitor.app', { kind: 'pro', userId: 'controlled-user', mcpTokenId: 'controlled-token' }, { countryPanelCode: 'IR', inboundHostClass: 'www', downstreamOrigin: 'https://www.worldmonitor.app', downstreamOriginTag: 'controlled' });
      expect(result).toMatchObject({ state: 'locked' });
      return result;
    });
    const next = await loadQualifiedCountrySignals(source, 'IR', new AbortController().signal, military(), previous);
    expect(next.families.find(row => row.family === 'radiation')).toMatchObject({ state: 'locked', observations: [] });
    expect(next.details?.critical).toBe(0);
    expect(next.families.filter(row => row.family !== 'military').every(row => row.state === 'locked')).toBe(true);
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
describe('qualified country source to rendered view and context', () => {
  it('shows the same populated 1/4/3/1 and top three through website and native generated adapters', async () => {
    const outcomes = qualifiedFixtureOutcomes();
    const envelope = (family: string) => ({ countryCode: 'IR', family, windowIndex: 0, outcomeJson: JSON.stringify(outcomes.find(row => `COUNTRY_SIGNAL_FAMILY_${row.family.toUpperCase()}` === family)) });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://www.worldmonitor.app');
      return new Response(JSON.stringify(envelope(url.searchParams.get('family')!)), { headers: { 'Content-Type': 'application/json' } });
    }));
    const calls: string[] = [];
    const native = await createHostCountryBriefSource(async (_name, args: any) => { calls.push(args.arguments.family); return { section: 'countrySignals', state: 'ready', value: envelope(args.arguments.family), retrievedAt: new Date().toISOString() }; });
    const website = createWebsiteCountryBriefSource();
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([loadQualifiedCountrySignals(website, 'IR', signal, military()), loadQualifiedCountrySignals(native, 'IR', signal, military())]);
    expect(a.details).toEqual(b.details);
    expect(a.details).toMatchObject({ critical: 1, high: 4, medium: 3, low: 1 });
    const context = projectQualifiedCountrySignalContext(b);
    expect(context.details).toMatchObject({ critical: 1, high: 4, medium: 3, low: 1 });
    expect(context.details?.recentHigh.map(row => row.description.text)).toEqual(b.details?.recentHigh.map(row => row.description));
    expect(context.families.map(row => row.includedObservations)).toEqual(b.families.map(row => row.observations.length));
    expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThan(16384);
    expect(calls).toHaveLength(7);
    const panels = [a, b].map(value => {
      const panel = new CountryDeepDivePanel();
      Reflect.set(panel, 'currentCode', 'IR');
      const body = document.createElement('div'); Reflect.set(panel, 'signalsBody', body);
      panel.updateSignals(countrySignalsFromMilitary('IR'));
      panel.updateQualifiedCountrySignals(value);
      expect(body.querySelector('.cdp-signal-breakdown')?.textContent).toBe('Critical1High4Moderate3Low1');
      expect(body.querySelectorAll('.cdp-signal-item')).toHaveLength(3);
      expect(panel.getQualifiedCountrySignals()?.details).toEqual(value.details);
      expect(body.textContent).toContain('not a 24-hour total');
      panel.updateSignals(countrySignalsFromMilitary('IR'));
      expect(body.querySelector('.cdp-signal-breakdown')?.textContent).toBe('Critical1High4Moderate3Low1');
      return { panel, text: body.textContent };
    });
    expect(panels[0]!.text).toBe(panels[1]!.text);
    for (const { panel } of panels) panel.hide();
    vi.unstubAllGlobals();
  });
  it('keeps failed refresh clocks, clears denied evidence and never publishes after abort', async () => {
    const previous = projectQualifiedCountrySignals('IR', qualifiedFixtureOutcomes());
    const source = await createHostCountryBriefSource(async () => { throw new Error('must not dispatch'); });
    vi.spyOn(source, 'countrySignals').mockImplementation(async (_code, family) => unavailableCountrySignal('IR', family, 'Denied', family === 'radiation' ? 'locked' : 'unavailable'));
    const signal = new AbortController();
    const value = await loadQualifiedCountrySignals(source, 'IR', signal.signal, military(), previous);
    expect(value.families.find(row => row.family === 'radiation')?.observations).toEqual([]);
    expect(value.families.find(row => row.family === 'outages')?.snapshotAt).toBe(previous.families[0]?.snapshotAt);
    expect(value.details?.critical).toBe(0);
    signal.abort();
    await expect(loadQualifiedCountrySignals(source, 'IR', signal.signal, military())).rejects.toThrow();
    expect(COUNTRY_SIGNAL_FAMILIES).toHaveLength(7);
  });
  it('bounds the website body before generated decoding and cancels an overflowing stream', async () => {
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(131073)); }, cancel() { cancelled = true; } }))));
    try {
      await expect(createWebsiteCountryBriefSource().countrySignals('IR', 'outages', new AbortController().signal)).rejects.toThrow('byte limit');
      expect(cancelled).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('uses one website deadline through a stalled body and suppresses late completion', async () => {
    const deadline = new AbortController();
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))));
    try {
      const pending = createWebsiteCountryBriefSource().countrySignals('IR', 'outages', new AbortController().signal);
      await Promise.resolve(); await Promise.resolve();
      deadline.abort(new DOMException('Country body deadline', 'TimeoutError'));
      await expect(pending).rejects.toThrow('Country body deadline');
      expect(timer).toHaveBeenCalledWith(15_000);
      expect(cancelled).toBe(true);
    } finally { timer.mockRestore(); vi.unstubAllGlobals(); }
  });
});
