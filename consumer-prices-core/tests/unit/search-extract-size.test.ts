import { describe, it, expect } from 'vitest';
import { extractSizeHint } from '../../src/adapters/search.js';

describe('extractSizeHint', () => {
  it('returns null when canonical name has no parseable size', () => {
    expect(extractSizeHint('White Sugar')).toBeNull();
    expect(extractSizeHint('Chicken Breast')).toBeNull();
    expect(extractSizeHint('')).toBeNull();
  });

  it('formats single-unit size', () => {
    const hint = extractSizeHint('Vegetable Oil 1 gallon');
    expect(hint).toBeTruthy();
    expect(hint).toContain('1');
    expect(hint).toContain('gallon');
    expect(hint).toContain('3785');
    expect(hint).toContain('ml');
  });

  it('formats ml size', () => {
    const hint = extractSizeHint('Cooking Oil 500ml');
    expect(hint).toBeTruthy();
    expect(hint).toContain('500');
    expect(hint).toContain('ml');
  });

  it('formats kg size', () => {
    const hint = extractSizeHint('White Sugar 5lb');
    expect(hint).toBeTruthy();
    expect(hint).toContain('5');
    expect(hint).toContain('lb');
    expect(hint).toContain('g');
  });

  it('handles 4lb vs 5lb — different canonical names produce different hints', () => {
    const hint4 = extractSizeHint('White Sugar 4lb');
    const hint5 = extractSizeHint('White Sugar 5lb');
    expect(hint4).not.toBe(hint5);
    expect(hint4).toContain('4');
    expect(hint5).toContain('5');
  });
});
