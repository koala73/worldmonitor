/**
 * Escape closes the Intelligence Findings dropdown, as it closes every other
 * header popover. Dogfood found it stayed open until a click elsewhere.
 */
import { afterEach, beforeAll, expect, it } from 'vitest';
import { IntelligenceFindingsBadge } from '@/components/IntelligenceGapBadge';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
afterEach(() => { document.body.replaceChildren(); });

it('closes the open findings dropdown on Escape and returns focus to the badge', () => {
  const headerRight = document.createElement('div');
  headerRight.className = 'header-right';
  document.body.append(headerRight);
  const findings = new IntelligenceFindingsBadge();
  const badge = headerRight.querySelector<HTMLButtonElement>('.intel-findings-badge')!;
  const dropdown = badge.querySelector('.intel-findings-dropdown')!;

  badge.click();
  expect(dropdown.classList.contains('open')).toBe(true);

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(dropdown.classList.contains('open')).toBe(false);
  expect(document.activeElement).toBe(badge);

  // A later Escape, with the dropdown closed, is left to whoever owns it.
  const later = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
  findings.setEnabled(false);
});
