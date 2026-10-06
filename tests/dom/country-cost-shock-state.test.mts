import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { briefSectionState } from '@/components/country-brief-presentation';
import { freezeBriefContent, createCountryBriefOutput } from '@/components/CountryBriefOutput';
import { initTestI18n } from './helpers/i18n.mts';
import type { CountryBriefSource } from '@/services/country-brief-source';

const attemptedFetches = vi.hoisted(() => {
  const attempted: string[] = [];
  globalThis.fetch = async input => {
    attempted.push(String(input));
    throw new Error('Cost shock fixtures forbid network reads');
  };
  return attempted;
});
let panel: CountryDeepDivePanel;
let body: HTMLElement;
let cost: ReturnType<typeof vi.fn>;
function result(closureDays: number) {
  return { iso2: 'CA', chokepointId: 'taiwan_strait', closureDays, warRiskTier: 'WAR_RISK_TIER_ELEVATED', sectors: [{ hs2: '27', hs2Label: 'Fuel', totalCostShock: closureDays * 1_000_000 }, { hs2: '84', hs2Label: 'Machinery', totalCostShock: 0 }], totalAddedCost: closureDays * 1_000_000, fetchedAt: '2026-10-06T10:00:00Z', unavailableReason: '' };
}
beforeAll(initTestI18n);
beforeEach(() => {
  vi.useFakeTimers();
  cost = vi.fn();
  panel = new CountryDeepDivePanel(null, { canRequestPremium: () => true, cost } as unknown as CountryBriefSource);
  body = document.createElement('div');
  Reflect.set(panel, 'currentCode', 'CA');
  Reflect.set(panel, 'costShockCalcBody', body);
  panel.updateMultiSectorCostShock(result(30) as never);
});
afterEach(() => {
  panel.hide();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});
afterAll(() => { expect(attemptedFetches).toEqual([]); });
function move(days: number) {
  const slider = body.querySelector<HTMLInputElement>('input[type=range]')!;
  slider.value = String(days);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}
function state() { return briefSectionState({ id: 'scenario', title: 'Cost Shock Calculator', card: body, body }); }

it('keeps initial thirty-day costs and observed zero available', () => {
  expect(body.textContent).toContain('30 days');
  expect(body.textContent).toContain('$30.0M');
  expect(body.querySelector('.cdp-cost-shock-calc-cost--zero')?.textContent).toBe('$0');
  expect(state()).toBe('ready');
});
it('marks calculating immediately and identifies retained thirty-day results while sixty is pending', async () => {
  cost.mockReturnValue(new Promise(() => {}));
  move(60);
  expect(state()).toBe('loading');
  expect(body.textContent).toContain('Retained 30-day results');
  expect(body.textContent).toContain('$30.0M');
  await vi.advanceTimersByTimeAsync(300);
  expect(state()).toBe('loading');
  expect(cost.mock.calls[0]?.slice(0, 3)).toEqual(['CA', 'taiwan_strait', 60]);
});
it('marks a rejected sixty-day calculation unavailable and retains the thirty-day basis', async () => {
  cost.mockRejectedValue(new Error('Controlled sixty-day failure'));
  move(60);
  await vi.advanceTimersByTimeAsync(300);
  expect(state()).toBe('unavailable');
  expect(body.textContent).toContain('60-day calculation unavailable');
  expect(body.textContent).toContain('Retained 30-day results');
  expect(body.textContent).toContain('$30.0M');
});
it('keeps failure and retained basis in the frozen report and rendered context text', async () => {
  cost.mockRejectedValue(new Error('Controlled failure'));
  move(60);
  await vi.advanceTimersByTimeAsync(300);
  const section = { id: 'scenario', title: 'Cost Shock Calculator', topics: ['economy'], state: state(), content: freezeBriefContent(body) };
  const output = createCountryBriefOutput({ country: 'Canada', code: 'CA', capturedAt: '2026-10-06T10:14:47Z', sections: [section], story: [] } as never, 'report', () => {});
  expect(output.textContent).toContain('Retained 30-day results');
  expect(output.textContent).toContain('60-day calculation unavailable');
  expect(output.textContent).not.toContain('All selected sections are available');
  expect(section.state).toBe('unavailable');
});
it('atomically applies a matching successful response basis, header, rows and supplied total', async () => {
  cost.mockResolvedValue({ ...result(60), warRiskTier: 'WAR_RISK_TIER_HIGH', totalAddedCost: 61_000_000 });
  move(60);
  await vi.advanceTimersByTimeAsync(300);
  expect(body.textContent).toContain('60 days');
  expect(body.textContent).toContain('War risk: HIGH');
  expect(body.textContent).toContain('$60.0M');
  expect(body.querySelector('.cdp-cost-shock-calc-total-value')?.textContent).toBe('$61.0M');
  expect(body.textContent).not.toContain('Retained');
  expect(state()).toBe('ready');
});
it('preserves a successful observed zero instead of treating it as a failed empty response', async () => {
  cost.mockResolvedValue({ ...result(60), sectors: [{ hs2: '27', hs2Label: 'Fuel', totalCostShock: 0 }], totalAddedCost: 0 });
  move(60);
  await vi.advanceTimersByTimeAsync(300);
  expect(body.querySelector('.cdp-cost-shock-calc-total-value')?.textContent).toBe('$0');
  expect(state()).toBe('ready');
});
it.each(['unavailable', 'empty', 'wrong-duration'])('does not replace known costs with a %s failure response', async mode => {
  const response = result(mode === 'wrong-duration' ? 30 : 60);
  if (mode === 'unavailable') response.unavailableReason = 'No seeded import data available';
  if (mode === 'empty') response.sectors = [];
  cost.mockResolvedValue(response);
  move(60);
  await vi.advanceTimersByTimeAsync(300);
  expect(state()).toBe('unavailable');
  expect(body.textContent).toContain('Retained 30-day results');
  expect(body.querySelector('.cdp-cost-shock-calc-total-value')?.textContent).toBe('$30.0M');
});
it('keeps an initially unavailable zero skeleton unknown', () => {
  panel.updateMultiSectorCostShock({ ...result(30), sectors: [], totalAddedCost: 0, unavailableReason: 'No seeded import data available' } as never);
  expect(state()).toBe('unavailable');
  expect(body.textContent).toContain('No seeded import data available');
  expect(body.querySelector('.cdp-cost-shock-calc-total-value')).toBeNull();
});
it('ignores a superseded sixty-day rejection after ninety-day success', async () => {
  let rejectOld: (error: Error) => void = () => {};
  cost.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; })).mockResolvedValueOnce(result(90));
  move(60);
  await vi.advanceTimersByTimeAsync(300);
  move(90);
  await vi.advanceTimersByTimeAsync(300);
  rejectOld(new Error('Late obsolete failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(body.textContent).toContain('90 days');
  expect(body.textContent).toContain('$90.0M');
  expect(state()).toBe('ready');
});
it('ignores a superseded sixty-day resolution after ninety-day success', async () => {
  let releaseOld: (value: unknown) => void = () => {};
  cost.mockReturnValueOnce(new Promise(resolve => { releaseOld = resolve; })).mockResolvedValueOnce(result(90));
  move(60);
  await vi.advanceTimersByTimeAsync(300);
  move(90);
  await vi.advanceTimersByTimeAsync(300);
  releaseOld(result(60));
  await vi.advanceTimersByTimeAsync(0);
  expect(body.textContent).toContain('$90.0M');
  expect(state()).toBe('ready');
});
it('does not apply a pending result after the country changes', async () => {
  let releaseOld: (value: unknown) => void = () => {};
  cost.mockReturnValue(new Promise(resolve => { releaseOld = resolve; }));
  move(60);
  await vi.advanceTimersByTimeAsync(300);
  Reflect.set(panel, 'currentCode', 'US');
  releaseOld(result(60));
  await vi.advanceTimersByTimeAsync(0);
  expect(body.querySelector('.cdp-cost-shock-calc-total-value')?.textContent).toBe('$30.0M');
});

it('preserves the debounce and requests only the last rapidly selected duration', async () => {
  cost.mockResolvedValue(result(90));
  move(60);
  move(90);
  await vi.advanceTimersByTimeAsync(299);
  expect(cost).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(cost).toHaveBeenCalledTimes(1);
  expect(cost.mock.calls[0]?.slice(0, 3)).toEqual(['CA', 'taiwan_strait', 90]);
  expect(state()).toBe('ready');
});
it('does not apply a response after premium access is revoked', async () => {
  let releaseOld: (value: unknown) => void = () => {};
  cost.mockReturnValue(new Promise(resolve => { releaseOld = resolve; }));
  move(60);
  await vi.advanceTimersByTimeAsync(300);
  Reflect.get(panel, 'source').canRequestPremium = () => false;
  releaseOld(result(60));
  await vi.advanceTimersByTimeAsync(0);
  expect(body.querySelector('.cdp-cost-shock-calc-total-value')?.textContent).toBe('$30.0M');
});
it('aborts on content reset and ignores a late successful result', async () => {
  let releaseOld: (value: unknown) => void = () => {};
  cost.mockReturnValue(new Promise(resolve => { releaseOld = resolve; }));
  move(60);
  await vi.advanceTimersByTimeAsync(300);
  const signal = cost.mock.calls[0]?.[3] as AbortSignal;
  Reflect.get(panel, 'resetPanelContent').call(panel);
  expect(signal.aborted).toBe(true);
  releaseOld(result(60));
  await vi.advanceTimersByTimeAsync(0);
  expect(body.querySelector('.cdp-cost-shock-calc-total-value')?.textContent).toBe('$30.0M');
});
