import { describe, expect, it } from 'vitest';
import { selectHotspotTopicId } from '@/services/gdelt-intel';

describe('GDELT hotspot topic selection', () => {
  it('uses maritime for every seeded maritime term', () => {
    expect(selectHotspotTopicId({ name: 'Sea alert', keywords: ['south china sea'], description: '' })).toBe('maritime');
    expect(selectHotspotTopicId({ name: 'Sea alert', keywords: ['warship'], description: '' })).toBe('maritime');
    expect(selectHotspotTopicId({ name: 'Sea alert', keywords: ['port closure'], description: '' })).toBe('maritime');
  });

  it('does not treat Port-au-Prince as a maritime hotspot', () => {
    expect(selectHotspotTopicId({ name: 'Port-au-Prince', keywords: ['gang violence'], description: '' })).toBe('military');
  });
});
