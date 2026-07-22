import { describe, it, expect } from 'vitest';
import { isPlausiblePriceMove, MAX_MOVE_RATIO } from './worldmonitor.js';

describe('isPlausiblePriceMove', () => {
  it('rejects the parse-artifact movers reported in #5445', () => {
    expect(isPlausiblePriceMove(874.68)).toBe(false); // White Sugar 1kg, lulu_ae
    expect(isPlausiblePriceMove(608.86)).toBe(false); // Whole Chicken, spinneys_ae
    expect(isPlausiblePriceMove(-99.25)).toBe(false); // Yaumi bread
  });

  it('keeps realistic weekly moves', () => {
    expect(isPlausiblePriceMove(0)).toBe(true);
    expect(isPlausiblePriceMove(12.5)).toBe(true);
    expect(isPlausiblePriceMove(-40)).toBe(true);
  });

  it('gates exactly at the bilateral MAX_MOVE_RATIO bound', () => {
    expect(MAX_MOVE_RATIO).toBe(4);
    // upper bound: new price = 4x past -> +300%
    expect(isPlausiblePriceMove(300)).toBe(true);
    expect(isPlausiblePriceMove(300.1)).toBe(false);
    // lower bound: new price = 0.25x past -> -75%
    expect(isPlausiblePriceMove(-75)).toBe(true);
    expect(isPlausiblePriceMove(-75.1)).toBe(false);
  });

  it('rejects non-finite change values', () => {
    expect(isPlausiblePriceMove(Number.NaN)).toBe(false);
    expect(isPlausiblePriceMove(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
