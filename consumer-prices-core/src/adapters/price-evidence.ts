/**
 * On-page price evidence check (#6182).
 *
 * The anti-fabrication defense used to be purely behavioral — prompt wording
 * telling the extractor never to invent a price (#6270). That wording also
 * produced fleet-wide false negatives: extractors returned null for prices
 * that were printed on the page (a printed price next to an "Out of stock"
 * notice, a buy box adjacent to a recommendation carousel). Recovering those
 * requires softening the prompt, and softening the prompt is only safe if
 * fabrication is caught by PROOF instead of fear: a price we accept must have
 * its digits actually present in the rendered page content the same provider
 * call returned.
 *
 * 'no-content' means the check could not run (provider returned no rendered
 * content, or the price value itself is not verifiable); callers treat that as
 * the historical pass-through behavior, not as evidence either way — but must
 * log/persist the abstention so a fleet-wide loss of page content is visible.
 *
 * KNOWN LIMITATION — presence, not attribution: this check proves the digits
 * appear SOMEWHERE in the rendered content, not that they belong to the main
 * product. A carousel price, a "was" price, or a per-unit price shares the
 * page with the buy box and would verify. Attribution is carried by the other
 * gates (title plausibility, currency, size/validator checks) and by the
 * prompt's carousel prohibition; this gate exists to make FABRICATED values —
 * digits with no source on the page at all (#6270) — deterministically
 * impossible, which is the property the softened prompt's safety rests on.
 */
export type PriceEvidence = 'verified' | 'unverified' | 'no-content';

/** Max characters between the whole part and the fraction part of a price the
 * page renders as separate elements ("49" … ".79" … "AED"). Markdown flattening
 * inserts blank lines between them; unrelated digits hundreds of characters
 * apart must not pair up. */
const SPLIT_ADJACENCY_WINDOW = 40;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Trailing context that turns a digit run into a SIZE or PERCENTAGE token
 * rather than a price. "Extractor returns the package quantity as the price"
 * is a named failure mode in this pipeline (quantity-as-price), and the size
 * token is printed on essentially every product page — without this guard the
 * gate would verify that failure mode by construction (455 "verified" by
 * "455g"). The list is deliberately unit-ish only: currency codes (AED, SAR,
 * INR…) never collide with it, so genuine price renders stay matchable.
 */
const UNIT_SUFFIX = String.raw`\s?(?:%|(?:g|gm|gr|kg|mg|ml|cl|l|ltr|litre|liter|oz|lb|lbs|pcs|pc|pk|ct)\b)`;

/** Digit-boundary guard: `4.60` must not match inside `34.601`, and a size or
 * percentage token (`400g`, `4.6%`) is not price evidence. */
function standaloneNumberPattern(numberText: string): RegExp {
  return new RegExp(`(?<![\\d.,])${escapeRegExp(numberText)}(?!\\d|${UNIT_SUFFIX})`, 'i');
}

/**
 * Whole-part render forms with the DECIMAL separators each may legitimately
 * pair with. A comma-grouped whole ("1,234") only ever takes a dot decimal,
 * and a dot-grouped whole ("1.234") only a comma decimal — "1.234.56" and
 * "1,234,56" are not number renders in any supported locale, and accepting
 * them would let mixed unrelated digits count as evidence.
 */
function wholeFormsWithSeps(digits: string): Array<{ w: string; seps: readonly string[] }> {
  const forms: Array<{ w: string; seps: readonly string[] }> = [{ w: digits, seps: ['.', ','] }];
  if (digits.length > 3) {
    for (const [groupSep, decimalSep] of [
      [',', '.'],
      ['.', ','],
    ] as const) {
      let out = '';
      for (let i = 0; i < digits.length; i++) {
        const fromEnd = digits.length - i;
        if (i > 0 && fromEnd % 3 === 0) out += groupSep;
        out += digits[i];
      }
      forms.push({ w: out, seps: [decimalSep] });
    }
  }
  return forms;
}

export function priceEvidenceOnPage(price: number, content: string | null | undefined): PriceEvidence {
  if (!Number.isFinite(price) || price <= 0) return 'no-content';
  if (!content || !content.trim()) return 'no-content';

  const fixed = price.toFixed(2); // "7.90"
  const [whole, fracPadded] = fixed.split('.');
  const fracShort = fracPadded.replace(/0$/, ''); // "9" for 7.90, "79" stays
  const isInteger = fracPadded === '00';

  const wholeForms = wholeFormsWithSeps(whole);

  if (isInteger) {
    // Integer price: the full digit run as a standalone number token.
    return wholeForms.some(({ w }) => standaloneNumberPattern(w).test(content)) ? 'verified' : 'unverified';
  }

  const fracForms = fracShort && fracShort !== fracPadded ? [fracPadded, fracShort] : [fracPadded];

  // Contiguous decimal: each whole form with its locale-consistent separators.
  for (const { w, seps } of wholeForms) {
    for (const sep of seps) {
      for (const f of fracForms) {
        if (standaloneNumberPattern(`${w}${sep}${f}`).test(content)) return 'verified';
      }
    }
  }

  // Split rendering: whole part and ".frac"/",frac" as separate nearby tokens.
  // Both halves are digit-boundary-guarded (review round, #6182): the whole
  // must not be the integer part of a DIFFERENT decimal ("49.20" must not
  // donate its "49"), and the fraction must not be lifted out of another
  // number ("rated 4.79" must not donate its ".79") — product headers put a
  // count and a rating within 40 chars routinely, which would otherwise let a
  // fabricated price verify from page furniture.
  for (const { w, seps } of wholeForms) {
    const sepClass = seps.length === 2 ? '[.,]' : `[${escapeRegExp(seps[0])}]`;
    for (const f of fracForms) {
      const splitPattern = new RegExp(
        `(?<![\\d.,])${escapeRegExp(w)}(?!\\d|[.,]\\d)[\\s\\S]{0,${SPLIT_ADJACENCY_WINDOW}}?(?<!\\d)${sepClass}${escapeRegExp(f)}(?!\\d|${UNIT_SUFFIX})`,
        'i',
      );
      if (splitPattern.test(content)) return 'verified';
    }
  }

  return 'unverified';
}
