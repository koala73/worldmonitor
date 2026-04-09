import { describe, it, expect } from 'vitest';
import { isTitlePlausible, isAllowedHost } from './search.js';

describe('isAllowedHost', () => {
  it('accepts exact domain match', () => {
    expect(isAllowedHost('https://www.luluhypermarket.com/ae/eggs', 'luluhypermarket.com')).toBe(false);
    expect(isAllowedHost('https://luluhypermarket.com/ae/eggs', 'luluhypermarket.com')).toBe(true);
  });

  it('accepts proper subdomain', () => {
    expect(isAllowedHost('https://www.luluhypermarket.com/ae/eggs', 'luluhypermarket.com')).toBe(false);
    // www is a subdomain — but our allowedHost is the bare hostname from baseUrl
    expect(isAllowedHost('https://www.luluhypermarket.com/item', 'www.luluhypermarket.com')).toBe(true);
  });

  it('blocks domain with shared suffix (no dot boundary)', () => {
    expect(isAllowedHost('https://evilluluhypermarket.com/page', 'luluhypermarket.com')).toBe(false);
  });

  it('blocks entirely different domain', () => {
    expect(isAllowedHost('https://amazon.com/eggs', 'noon.com')).toBe(false);
  });

  it('handles malformed URLs gracefully', () => {
    expect(isAllowedHost('not-a-url', 'noon.com')).toBe(false);
    expect(isAllowedHost('', 'noon.com')).toBe(false);
  });
});

describe('isTitlePlausible', () => {
  it('accepts when product name contains canonical tokens', () => {
    expect(isTitlePlausible('Eggs Fresh 12 Pack', 'Farm Fresh Eggs 12 Pack White')).toBe(true);
    expect(isTitlePlausible('Milk 1L', 'Almarai Full Fat Fresh Milk 1 Litre')).toBe(true);
    expect(isTitlePlausible('Basmati Rice 1kg', 'Tilda Pure Basmati Rice 1kg')).toBe(true);
  });

  it('rejects gross mismatches (seeds vs vegetables)', () => {
    expect(isTitlePlausible('Tomatoes Fresh 1kg', 'GGOOT Tomato Seeds 100 pcs Vegetable Garden')).toBe(false);
    expect(isTitlePlausible('Onions 1kg', 'Red Karmen Onion Sets for Planting x200')).toBe(false);
    expect(isTitlePlausible('Eggs Fresh 12 Pack', 'Generic 12 Grids Egg Storage Box Container')).toBe(false);
  });

  it('rejects when productName is undefined or empty', () => {
    expect(isTitlePlausible('Milk 1L', undefined)).toBe(false);
    expect(isTitlePlausible('Milk 1L', '')).toBe(false);
  });

  it('handles short canonical names with single-token check', () => {
    // "Milk" → 1 token, need ≥1 match
    expect(isTitlePlausible('Milk', 'Fresh Pasteurized Milk 1L')).toBe(true);
    expect(isTitlePlausible('Milk', 'Orange Juice 1L')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isTitlePlausible('EGGS FRESH 12 PACK', 'farm fresh eggs 12 pack')).toBe(true);
  });

  it('ignores short tokens (≤2 chars)', () => {
    // "1L" → filtered out, only "Milk" counts
    expect(isTitlePlausible('Milk 1L', 'Fresh Milk Whole 1 Litre')).toBe(true);
  });
});
