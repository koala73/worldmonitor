import { describe, it, expect } from 'vitest';
import { cleanTitle, tokenOverlap } from '../../src/normalizers/title.js';

describe('cleanTitle', () => {
  it('strips promo tokens', () => {
    const r = cleanTitle('Fresh Organic Eggs - SAVE NOW!');
    expect(r).not.toContain('fresh');
    expect(r).not.toContain('save');
    expect(r).toContain('organic');
    expect(r).toContain('eggs');
  });

  it('lowercases and normalizes whitespace', () => {
    const r = cleanTitle('  Basmati  Rice  ');
    expect(r).toBe('basmati rice');
  });
});

describe('tokenOverlap', () => {
  it('returns 1 for identical titles', () => {
    expect(tokenOverlap('Basmati Rice 1kg', 'Basmati Rice 1kg')).toBe(1);
  });

  it('returns 0 for completely different titles', () => {
    expect(tokenOverlap('Eggs 12 Pack', 'Sunflower Oil 1L')).toBe(0);
  });

  it('returns partial overlap for partial matches', () => {
    const r = tokenOverlap('Basmati Rice 1kg Pack', 'Basmati Rice Premium');
    expect(r).toBeGreaterThan(0.5);
  });
});
