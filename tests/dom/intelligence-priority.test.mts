import { beforeAll, expect, it, vi } from 'vitest';
import { IntelligenceGapBadge } from '@/components/IntelligenceGapBadge';
import { initTestI18n } from './helpers/i18n.mts';
beforeAll(initTestI18n);
it('does not mark one low-priority alert as high priority', async () => {
  const methods = IntelligenceGapBadge.prototype as unknown as {
    update(): Promise<void>; priorityToConfidence(priority: string): number;
  };
  const badge = document.createElement('div');
  const confidence = methods.priorityToConfidence('low');
  const host = { updateEpoch: 0, enabled: true, destroyed: false, badge,
    lastFindingCount: 0, renderDropdown: vi.fn(),
    mergeFindings: async () => [{ priority: 'low', confidence }],
  };
  await methods.update.call(host);
  expect(badge.classList.contains('status-high')).toBe(false);
  expect(badge.classList.contains('status-low')).toBe(true);
  expect(confidence).toBe(0.4);
});
