/**
 * Dashboard focus (#10453, phase 3): "Draft assessment" copies a request that
 * names the focus's countries and dates for the travel risk assessment tool.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyAssessmentRequest } from '@/components/focus-handoff';
import type { TabScope } from '../../shared/tab-scope';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

const SEA: TabScope = { countries: ['TH', 'VN', 'ID'], neighbours: true, start: '2026-11-14', end: '2026-11-18' };
const toast = () => document.querySelector('.toast-notification')?.textContent ?? null;

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('copyAssessmentRequest', () => {
  it('copies a request with the countries, their names and the window, then says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyAssessmentRequest(SEA, { writeText })).toBe(true);
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain('prepare_travel_risk_assessment');
    expect(text).toContain('Thailand (TH), Vietnam (VN), Indonesia (ID)');
    expect(text).toContain('2026-11-14 to 2026-11-18');
    expect(toast()).toBe('Request copied. Paste it into your AI assistant.');
  });

  it('copies only the first six of a larger focus and says how many it took', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const scope: TabScope = { countries: ['TH', 'VN', 'ID', 'MY', 'SG', 'PH', 'KH', 'LA'], neighbours: true };
    expect(await copyAssessmentRequest(scope, { writeText })).toBe(true);
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain('Philippines (PH)');
    const [, countries, omitted] = text.split('\n');
    expect(countries).not.toMatch(/Cambodia|Laos/);
    expect(omitted).toBe('Not part of this request (an assessment covers at most 6 countries): Cambodia (KH), Laos (LA).');
    expect(toast()).toBe('Request copied for the first 6 countries. An assessment covers at most 6 countries.');
  });

  it('says the copy failed when the clipboard refuses', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    expect(await copyAssessmentRequest(SEA, { writeText })).toBe(false);
    expect(toast()).toBe('Could not copy the request.');
  });

  it('says the copy failed when there is no clipboard', async () => {
    expect(await copyAssessmentRequest(SEA, null)).toBe(false);
    expect(toast()).toBe('Could not copy the request.');
  });
});
