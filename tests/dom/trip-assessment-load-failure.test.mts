/**
 * A dynamic import that rejects must not make the focus bar's Draft assessment
 * press do nothing silently (#10451): the person is told, and can press again.
 * Its own file because the module mock would otherwise break the other suites.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

let failLoad = true;

vi.mock('@/services/travel-risk-export', async (importOriginal) => {
  if (failLoad) throw new Error('chunk load failed');
  return importOriginal();
});

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.querySelector<HTMLButtonElement>('.trip-assessment .modal-close')?.click();
  document.body.replaceChildren();
});

describe('opening the trip assessment when its chunk fails to load', () => {
  it('shows a retryable message instead of failing silently, and works again afterwards', async () => {
    const { openTripAssessmentForScope } = await import('@/components/focus-ui');
    const scope = { countries: ['TH'], neighbours: false };

    failLoad = true;
    await expect(openTripAssessmentForScope(scope)).resolves.toBeUndefined();
    expect(document.querySelector('.trip-assessment')).toBeNull();
    expect(document.querySelector('.toast-notification')?.textContent).toBe('The trip assessment could not be opened. Reload the page and try again.');

    // The pending flag was cleared, so the next press is not swallowed.
    failLoad = false;
    vi.resetModules();
    const fresh = await import('@/components/focus-ui');
    await fresh.openTripAssessmentForScope(scope);
    expect(document.querySelectorAll('.trip-assessment')).toHaveLength(1);
  });
});
