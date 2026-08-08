import { describe, expect, it } from 'vitest';
import { priceEvidenceOnPage } from './price-evidence.js';

describe('priceEvidenceOnPage', () => {
  it('passes through when no page content is available', () => {
    expect(priceEvidenceOnPage(4.6, undefined)).toBe('no-content');
    expect(priceEvidenceOnPage(4.6, '')).toBe('no-content');
    expect(priceEvidenceOnPage(4.6, '   ')).toBe('no-content');
  });

  it('passes through for non-verifiable price values', () => {
    expect(priceEvidenceOnPage(Number.NaN, 'page')).toBe('no-content');
    expect(priceEvidenceOnPage(0, 'page')).toBe('no-content');
    expect(priceEvidenceOnPage(-3, 'page')).toBe('no-content');
  });

  it('verifies a contiguous dot-decimal price', () => {
    expect(priceEvidenceOnPage(4.6, 'EVERYDAY LOW PRICE\n\n$4.60\n\n$0.66 / 100G')).toBe('verified');
  });

  it('verifies a contiguous comma-decimal price (pt-BR)', () => {
    expect(priceEvidenceOnPage(7.9, 'Leite Integral Piracanjuba 1 Litro\n\nR$ 7,90\n\nOps! sem estoque')).toBe('verified');
  });

  it('verifies a short decimal without a padded zero', () => {
    expect(priceEvidenceOnPage(7.9, 'preço: 7.9 reais')).toBe('verified');
  });

  it('verifies a split-rendered price (whole and fraction in separate nodes)', () => {
    // Carrefour AE renders "49" ".79" "AED" as separate lines.
    expect(priceEvidenceOnPage(49.79, 'Jumbo Pack 68 Diapers\n\n49\n\n.79\n\nAED\n\nOnly 3 left')).toBe('verified');
  });

  it('does not split-match across unrelated distant digits', () => {
    // "49" appears, ".79" appears — but 600 chars apart.
    const page = `49 diapers ${'x'.repeat(600)} rated .79 stars`;
    expect(priceEvidenceOnPage(49.79, page)).toBe('unverified');
  });

  it('rejects a fabricated price absent from the page', () => {
    const shell = "We couldn't find the page you were looking for. Explore our catalogue instead.";
    expect(priceEvidenceOnPage(3.95, shell)).toBe('unverified');
  });

  it('does not verify from digits embedded inside larger numbers', () => {
    // 4.60 must not match inside 34.601 or 4.6087.
    expect(priceEvidenceOnPage(4.6, 'weight 34.601g and id 4.6087-x')).toBe('unverified');
  });

  it('verifies an integer price as a standalone token', () => {
    expect(priceEvidenceOnPage(455, 'MRP: ₹455 (incl. taxes)')).toBe('verified');
    expect(priceEvidenceOnPage(455, 'order #4550 shipped')).toBe('unverified');
  });

  it('verifies a thousands-separated price', () => {
    expect(priceEvidenceOnPage(1234.56, 'now $1,234.56 only')).toBe('verified');
    expect(priceEvidenceOnPage(1234.56, 'agora R$ 1.234,56')).toBe('verified');
  });

  // Review round (#6182): the split-adjacency branch must not stitch a price
  // together from digits that belong to OTHER numbers on the page. Product
  // headers routinely put a count and a rating within 40 chars ("49 in stock,
  // rated 4.79"), which is exactly the furniture a fabricated NN.FF price
  // would pair with. Reproduced live by three independent reviewers.
  it('does not steal the fraction from an unrelated decimal inside the window', () => {
    expect(priceEvidenceOnPage(49.79, '49 in stock, rated 4.79 by 1200 users')).toBe('unverified');
    expect(priceEvidenceOnPage(49.79, '49 items in cart, total 3.79')).toBe('unverified');
    expect(priceEvidenceOnPage(4.95, 'Bundle of 4 similar items from 2.95')).toBe('unverified');
    expect(priceEvidenceOnPage(49.79, '49 kg pack - now 1,79 each')).toBe('unverified');
    expect(priceEvidenceOnPage(1234.56, '1,234 sold + rated 4.56 stars')).toBe('unverified');
  });

  it('does not donate the whole part from another decimal', () => {
    expect(priceEvidenceOnPage(49.79, 'was 49.20 save .79 today')).toBe('unverified');
  });

  it('still verifies the legitimate split render after the boundary tightening', () => {
    expect(priceEvidenceOnPage(49.79, 'Jumbo Pack 68 Diapers\n\n49\n\n.79\n\nAED\n\nOnly 3 left')).toBe('verified');
  });

  // A size or percentage token is not price evidence: the extractor returning
  // the package quantity as the price is a NAMED failure mode
  // (quantity-as-price), and the size token is printed on essentially every
  // product page — without this guard the gate verifies that failure mode by
  // construction.
  it('does not verify from unit-suffixed size or percentage tokens', () => {
    expect(priceEvidenceOnPage(455, 'Tesco Bread 455g loaf')).toBe('unverified');
    expect(priceEvidenceOnPage(400, 'White Sandwich Bread 400g')).toBe('unverified');
    expect(priceEvidenceOnPage(400, 'White Sandwich Bread 400 g fresh')).toBe('unverified');
    expect(priceEvidenceOnPage(1.5, 'Coca-Cola 1.5L bottle')).toBe('unverified');
    expect(priceEvidenceOnPage(4.6, 'save 4.6% today')).toBe('unverified');
    // Currency-adjacent digits remain evidence.
    expect(priceEvidenceOnPage(455, 'MRP: 455 rupees (incl. taxes)')).toBe('verified');
    expect(priceEvidenceOnPage(49.79, 'now 49.79 AED')).toBe('verified');
  });

  // Thousands groupings must stay separator-consistent: a comma-grouped whole
  // pairs with a dot decimal and vice versa. "1.234.56" / "1,234,56" are not
  // number renders in any supported locale and must not count as evidence.
  it('rejects same-separator thousands-decimal combinations', () => {
    expect(priceEvidenceOnPage(1234.56, 'ref 1.234.56 item')).toBe('unverified');
    expect(priceEvidenceOnPage(1234.56, 'code 1,234,56 x')).toBe('unverified');
  });
});
