/**
 * Trip assessment: copying a handoff names the chosen countries and dates,
 * and discloses countries that did not fit.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyHandoffRequest } from '@/components/focus-handoff';
import type { ReportHandoff } from '../../shared/report-handoff';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

const SEA: ReportHandoff = { countries: ['TH', 'VN', 'ID'], omitted: [], dateFrom: '2026-11-14', dateTo: '2026-11-18' };
const toast = () => document.querySelector('.toast-notification')?.textContent ?? null;

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('copyHandoffRequest', () => {
  it('copies a request with the countries, their names and the window, then says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyHandoffRequest(SEA, { writeText })).toBe(true);
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain('prepare_travel_risk_assessment');
    expect(text).toContain('Thailand (TH), Vietnam (VN), Indonesia (ID)');
    expect(text).toContain('2026-11-14 to 2026-11-18');
    expect(toast()).toBe('Request copied. Paste it into your AI assistant.');
  });

  it('copies the selected countries and names the omitted countries in the toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const handoff: ReportHandoff = { countries: ['TH', 'VN', 'ID', 'MY', 'SG', 'PH'], omitted: ['KH', 'LA'], dateFrom: null, dateTo: null };
    expect(await copyHandoffRequest(handoff, { writeText })).toBe(true);
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain('Philippines (PH)');
    const [, countries, omitted] = text.split('\n');
    expect(countries).not.toMatch(/Cambodia|Laos/);
    expect(omitted).toBe('Not part of this request (an assessment covers at most 6 countries): Cambodia (KH), Laos (LA).');
    expect(toast()).toBe('Request copied for the first 6 countries. An assessment covers at most 6 countries. Left out: Cambodia, Laos.');
  });

  it('says the copy failed when the clipboard refuses', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    expect(await copyHandoffRequest(SEA, { writeText })).toBe(false);
    expect(toast()).toBe('Could not copy the request.');
  });

  it('says the copy failed when there is no clipboard', async () => {
    expect(await copyHandoffRequest(SEA, null)).toBe(false);
    expect(toast()).toBe('Could not copy the request.');
  });
});
