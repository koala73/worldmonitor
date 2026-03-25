import { describe, it, expect } from 'vitest';
import { parseSize, unitPrice } from '../../src/normalizers/size.js';

describe('parseSize', () => {
  it('parses simple gram weights', () => {
    const r = parseSize('500g');
    expect(r?.baseQuantity).toBe(500);
    expect(r?.baseUnit).toBe('g');
    expect(r?.packCount).toBe(1);
  });

  it('parses kilograms and converts to grams', () => {
    const r = parseSize('1kg');
    expect(r?.baseQuantity).toBe(1000);
    expect(r?.baseUnit).toBe('g');
  });

  it('parses multi-pack patterns (2x200g)', () => {
    const r = parseSize('2x200g');
    expect(r?.packCount).toBe(2);
    expect(r?.sizeValue).toBe(200);
    expect(r?.baseQuantity).toBe(400);
  });

  it('parses multi-pack with × symbol', () => {
    const r = parseSize('6×1L');
    expect(r?.packCount).toBe(6);
    expect(r?.baseQuantity).toBe(6000);
    expect(r?.baseUnit).toBe('ml');
  });

  it('parses litre variants', () => {
    expect(parseSize('1L')?.baseQuantity).toBe(1000);
    expect(parseSize('1.5l')?.baseQuantity).toBe(1500);
    expect(parseSize('500ml')?.baseQuantity).toBe(500);
  });

  it('parses count units', () => {
    const r = parseSize('12 rolls');
    expect(r?.baseQuantity).toBe(12);
    expect(r?.baseUnit).toBe('ct');
  });

  it('parses piece counts', () => {
    const r = parseSize('24 pcs');
    expect(r?.baseQuantity).toBe(24);
  });

  it('parses gallon', () => {
    const r = parseSize('1 gallon');
    expect(r?.baseUnit).toBe('ml');
    expect(r?.baseQuantity).toBeCloseTo(3785.41);
  });

  it('parses gal abbreviation', () => {
    const r = parseSize('1gal');
    expect(r?.baseUnit).toBe('ml');
    expect(r?.baseQuantity).toBeCloseTo(3785.41);
  });

  it('parses pack word separator (24 pack 16oz)', () => {
    const r = parseSize('24 pack 16oz');
    expect(r?.packCount).toBe(24);
    expect(r?.sizeValue).toBe(16);
    expect(r?.baseUnit).toBe('g');
    expect(r?.baseQuantity).toBeCloseTo(24 * 16 * 28.3495);
  });

  it('returns null for unparseable text', () => {
    expect(parseSize('large')).toBeNull();
    expect(parseSize(null)).toBeNull();
    expect(parseSize('')).toBeNull();
  });

  it('computes unit price correctly', () => {
    const size = parseSize('1kg')!;
    const up = unitPrice(10, size);
    expect(up).toBeCloseTo(0.01); // 10 AED per 1000g = 0.01 per g
  });
});
