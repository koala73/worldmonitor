import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

const mocks = vi.hoisted(() => ({ run: vi.fn(), poll: vi.fn(), premium: true, gate: vi.fn() }));
vi.mock('@/services/scenario', () => ({ runScenario: mocks.run, getScenarioStatus: mocks.poll }));
vi.mock('@/services/panel-gating', () => ({ hasPremiumAccess: () => mocks.premium }));
vi.mock('@/services/analytics', () => ({ trackGateHit: mocks.gate }));
vi.mock('@/services/supply-chain', () => ({
  fetchBypassOptions: async () => ({ options: [] }), fetchChokepointHistory: async () => ({ history: [] }),
}));
import { SupplyChainPanel } from '@/components/SupplyChainPanel';

let panel: SupplyChainPanel;
const result = (iso2 = 'DE', severity = 50) => ({
  scenarioId: 'hormuz-tanker-blockade', scopedIso2: iso2, computedAt: '2026-09-10T12:00:00Z',
  affectedChokepointIds: ['hormuz_strait'], topImpactCountries: [{ iso2, totalImpact: severity * 0.84, impactPct: 100 }],
  template: { name: 'hormuz_strait', disruptionPct: severity, durationDays: 14, costShockMultiplier: 2.1 },
  coverage: { status: 'partial', countryIds: [iso2], hs2Codes: ['27', '29'], manifestFetchedAt: '2026-09-09T12:00:00Z', records: [
    { iso2, hs2: '27', state: 'evaluated', basis: 'flow_weighted', rawImpact: severity * 0.84, fetchedAt: '2026-09-09T12:00:00Z' },
    { iso2, hs2: '29', state: 'missing', basis: '', fetchedAt: '' },
  ] },
});
const select = () => panel.getElement().querySelector<HTMLSelectElement>('.sc-scenario-country-select')!;
const severity = () => panel.getElement().querySelector<HTMLInputElement>('.sc-scenario-severity')!;
const button = () => panel.getElement().querySelector<HTMLButtonElement>('.sc-scenario-btn')!;
async function settle() { await vi.advanceTimersByTimeAsync(160); }
function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }));
}
beforeAll(initTestI18n);
beforeEach(async () => {
  vi.useFakeTimers(); mocks.premium = true; mocks.run.mockReset(); mocks.poll.mockReset(); mocks.gate.mockReset();
  mocks.run.mockResolvedValue({ jobId: 'scenario:1712345678901:abcdefgh', status: 'pending' });
  mocks.poll.mockResolvedValue({ status: 'done', result: result() });
  panel = new SupplyChainPanel(); document.body.append(panel.getElement());
  panel.setOnScenarioActivate((id, value) => panel.showScenarioSummary(id, value));
  panel.updateChokepointStatus({ chokepoints: [{ id: 'hormuz_strait', name: 'Strait of Hormuz', disruptionScore: 20, status: 'yellow', affectedCommodities: [], affectedRoutes: [], description: 'Fixture', lat: 26, lon: 56 }], fetchedAt: Date.now() } as never);
  await settle();
  panel.getElement().querySelector<HTMLElement>('.trade-restriction-header')!.click();
  await settle();
});
afterEach(() => { panel.destroy(); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('SupplyChainPanel scenario controls', () => {
  it('selects controls without enqueue, polls, renders and exports the captured result', async () => {
    select().click(); expect(mocks.run).not.toHaveBeenCalled();
    change(select(), 'DE'); change(severity(), '50');
    button().click(); await settle();
    expect(mocks.run.mock.calls[0]![0]).toEqual({ scenarioId: 'hormuz-tanker-blockade', iso2: 'DE', disruptionPct: 50 });
    expect(panel.getElement().textContent).toContain('42.00 score units');
    expect(panel.getElement().textContent).toContain('Partial coverage: 1/2');
    expect(panel.getElement().textContent).toContain('1 missing');
    expect(panel.getElement().textContent).toContain('descriptive only');
    expect(button().disabled).toBe(true);
    let exported: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { exported = blob as Blob; return 'blob:fixture'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    panel.getElement().querySelector<HTMLButtonElement>('.sc-scenario-export')!.click();
    const data = JSON.parse(await exported!.text());
    expect(data.result).toEqual(result());
    expect(data.observationDate).toBe('unknown');
    change(select(), 'JP'); change(severity(), '100');
    expect(button().disabled).toBe(false);
    mocks.poll.mockResolvedValue({ status: 'done', result: result('JP', 100) });
    button().click(); await settle();
    expect(mocks.run.mock.calls[1]![0]).toEqual({ scenarioId: 'hormuz-tanker-blockade', iso2: 'JP', disruptionPct: 100 });
    expect(panel.getElement().textContent).toContain('84.00 score units');
    expect(select().value).toBe('JP');
  });

  it('defers broad evidence rows until expanded and exports every captured record', async () => {
    const broad = result();
    broad.coverage.records = Array.from({ length: 3349 }, (_, i) => ({ ...broad.coverage.records[0]!, hs2: String(i) }));
    panel.showScenarioSummary('hormuz-tanker-blockade', broad);
    await settle();
    const details = panel.getElement().querySelector<HTMLDetailsElement>('.sc-scenario-banner details')!;
    expect(details.querySelectorAll('li')).toHaveLength(0);
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    expect(details.querySelectorAll('li')).toHaveLength(3349);
    let exported: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { exported = blob as Blob; return 'blob:fixture'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    panel.getElement().querySelector<HTMLButtonElement>('.sc-scenario-export')!.click();
    expect(JSON.parse(await exported!.text()).result.coverage.records).toHaveLength(3349);
    panel.updateShippingRates({ rates: [] } as never); await settle();
    expect(panel.getElement().querySelectorAll('.sc-scenario-banner li')).toHaveLength(0);
  });

  it('keeps default severity, PRO gating and retry behavior', async () => {
    expect(severity().value).toBe('100');
    mocks.run.mockRejectedValueOnce(new Error('queue unavailable'));
    button().click(); await settle();
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('retry');
    mocks.premium = false;
    panel.updateShippingRates({ rates: [] } as never); await settle();
    button().click(); await settle();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.gate).toHaveBeenCalledWith('scenario-engine');
  });

  it('ignores a stale poll after controls change and displays unknown legacy coverage', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.poll.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    button().click(); await settle();
    change(select(), 'JP'); resolve({ status: 'done', result: result('DE') }); await settle();
    expect(panel.getElement().querySelector('.sc-scenario-banner')).toBeNull();
    const legacy = { ...result('JP'), coverage: undefined };
    mocks.poll.mockResolvedValueOnce({ status: 'done', result: legacy });
    button().click(); await settle();
    expect(panel.getElement().textContent).toContain('Unknown coverage');
  });
  // Positive control for the render-vs-DOM-mutation fix. The change handler used to set
  // button.disabled/textContent directly, which desynced Panel's committed-HTML snapshot;
  // a later identical render then short-circuited and could never repair the button.
  it('re-enables the button through a render when a control returns to the active params', async () => {
    change(select(), 'DE'); change(severity(), '50');
    button().click(); await settle();
    expect(button().disabled).toBe(true);
    // Away and back with no intervening run: the snapshot and the DOM must still agree.
    change(select(), 'JP');
    expect(button().disabled).toBe(false);
    change(select(), 'DE');
    expect(button().disabled).toBe(true);
    change(select(), 'JP');
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('Simulate Closure');
    // And it must actually be clickable, not merely painted enabled.
    mocks.poll.mockResolvedValue({ status: 'done', result: result('JP', 50) });
    button().click(); await settle();
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it('does not let a cancelled run re-enable the button a newer run owns', async () => {
    let releaseFirst: (value: unknown) => void = () => {};
    mocks.poll.mockReturnValueOnce(new Promise(r => { releaseFirst = r; }));
    button().click(); await settle();
    expect(button().disabled).toBe(true);
    // Second run starts and takes ownership of the shared abort controller.
    change(select(), 'JP');
    mocks.poll.mockReturnValue(new Promise(() => {}));
    button().click(); await settle();
    expect(button().disabled).toBe(true);
    // The FIRST run now unblocks and walks its abort path. It must not touch the button.
    releaseFirst({ status: 'done', result: result('DE') });
    await settle();
    expect(button().disabled).toBe(true);
    expect(button().textContent).not.toContain('Simulate Closure');
  });

  it('releases a cancelled template when a different template starts', async () => {
    panel.updateChokepointStatus({ chokepoints: ['hormuz_strait', 'panama'].map(id => ({
      id, name: id, disruptionScore: 20, status: 'yellow', affectedCommodities: [],
      affectedRoutes: [], description: 'Fixture', lat: 26, lon: 56,
    })), fetchedAt: Date.now() } as never);
    await settle();
    panel.getElement().querySelector<HTMLElement>('.trade-restriction-header')!.click();
    await settle();
    let releaseFirst: (value: unknown) => void = () => {};
    mocks.poll.mockReturnValueOnce(new Promise(r => { releaseFirst = r; }));
    button().click(); await settle();
    const headers = () => panel.getElement().querySelectorAll<HTMLElement>('.trade-restriction-header');
    headers()[1]!.click(); await settle();
    mocks.poll.mockReturnValue(new Promise(() => {}));
    button().click(); await settle();
    expect(mocks.run.mock.calls[1]![0].scenarioId).toBe('panama-drought-50pct');
    releaseFirst({ status: 'done', result: result() });
    await settle();
    expect(button().disabled).toBe(true);
    headers()[0]!.click(); await settle();
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('Simulate Closure');
  });

  it('sends an explicit zero severity and reports no route disruption', async () => {
    change(severity(), '0');
    mocks.poll.mockResolvedValue({ status: 'done', result: result('DE', 0) });
    change(select(), 'DE');
    button().click(); await settle();
    expect(mocks.run.mock.calls[0]![0]).toEqual({ scenarioId: 'hormuz-tanker-blockade', iso2: 'DE', disruptionPct: 0 });
    expect(panel.getElement().textContent).toContain('No physical route disruption is highlighted.');
    expect(panel.getElement().textContent).toContain('0% closure');
  });

  it('restores a cleared severity box to the template default instead of an explicit zero', async () => {
    change(severity(), '');
    expect(severity().value).toBe('100');
    change(select(), 'DE');
    button().click(); await settle();
    expect(mocks.run.mock.calls[0]![0]!.disruptionPct).toBe(100);
  });

  it('marks a country aggregated from partial evidence as a lower bound', async () => {
    const partial = result('DE', 50);
    partial.topImpactCountries = [{ iso2: 'DE', totalImpact: 42, impactPct: 100, evaluatedRecords: 1, requestedRecords: 2, partialEvidence: true }] as never;
    panel.showScenarioSummary('hormuz-tanker-blockade', partial);
    await settle();
    expect(panel.getElement().textContent).toContain('partial evidence');
    expect(panel.getElement().textContent).toContain('\u226542.00 score units');
  });

  it('offers unseeded countries as disabled options rather than silent dead ends', () => {
    const options = [...select().querySelectorAll('option')];
    const seeded = options.find(o => o.value === 'DE')!;
    const unseeded = options.find(o => o.value === 'PR')!;
    expect(seeded.disabled).toBe(false);
    expect(unseeded.disabled).toBe(true);
    expect(unseeded.textContent).toContain('not seeded');
  });
});
