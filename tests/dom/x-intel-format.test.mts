import { describe, expect, it } from 'vitest';

import { formatXTime } from '@/services/x-intel';

describe('formatXTime', () => {
  it('does not render the relay epoch fallback as a decades-old update', () => {
    expect(formatXTime(new Date(0).toISOString())).toBe('unknown');
  });

  it('does not render malformed timestamps as live update ages', () => {
    expect(formatXTime('not a timestamp')).toBe('unknown');
  });
});
