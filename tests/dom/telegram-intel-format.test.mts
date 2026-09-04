import { describe, expect, it } from 'vitest';

import { formatTelegramTime } from '@/services/telegram-intel';

describe('formatTelegramTime', () => {
  it('does not render the relay epoch fallback as a decades-old update', () => {
    expect(formatTelegramTime(new Date(0).toISOString())).toBe('unknown');
  });

  it('does not render malformed timestamps as live update ages', () => {
    expect(formatTelegramTime('not a timestamp')).toBe('unknown');
  });
});
