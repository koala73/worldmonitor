/**
 * Wire reprints. An outlet that runs a Reuters, AP or AFP story under the
 * wire's own headline publishes the wire's copy, and Google News credits it as
 * "<headline> - <outlet>". Corroboration counts it with the wire: families are
 * an upper bound on independence, and a reprinter outside the curated table
 * must not add a publisher by copying one. An outlet that writes its own
 * headline keeps its own family, and two outlets sharing a headline that no
 * wire carried stay two.
 */
import { WIRE_FAMILIES, publisherFamilyFor, publisherFamilyForItem } from './publisher-families.js';
import { normalizeNewsStoryTitle } from './story-identity.js';

const CREDIT_TAIL_CHARS = 200;
// Spaced, so a masthead's own hyphen (Herald-Leader) stays inside the credit.
const CREDIT_SEPARATOR_RE = /\s[-–—|]\s+/g;
// Shorter headlines are shared by outlets that never copied each other.
const MIN_HEADLINE_WORDS = 4;

const wireRank = (family) => WIRE_FAMILIES.indexOf(family);

/**
 * The headline without a trailing " - <outlet>" credit that names its own
 * publisher or a wire, normalized; '' when it is too short to name one story.
 * Any other tail ("- live updates") is headline text.
 */
function reprintHeadline(title, family) {
  if (typeof title !== 'string') return '';
  const tailStart = Math.max(0, title.length - CREDIT_TAIL_CHARS);
  const tail = title.slice(tailStart);
  const separator = [...tail.matchAll(CREDIT_SEPARATOR_RE)].at(-1);
  const credited = separator ? publisherFamilyFor(tail.slice(separator.index + separator[0].length)) : '';
  const bare = credited && (credited === family || wireRank(credited) >= 0) ? title.slice(0, tailStart + separator.index) : title;
  const headline = normalizeNewsStoryTitle(bare);
  return headline.split(' ').length >= MIN_HEADLINE_WORDS ? headline : '';
}

/**
 * Each entry's family, with a wire reprint's replaced by its wire's. When two
 * wires carry one headline, a reprint counts with the first in WIRE_FAMILIES.
 *
 * @param {readonly { title?: unknown; family: string }[]} entries
 * @returns {string[]} one family per entry, in order
 */
export function foldWireReprints(entries) {
  const headlines = entries.map(({ title, family }) => reprintHeadline(title, family));
  const wireOf = new Map();
  entries.forEach(({ family }, i) => {
    if (wireRank(family) < 0 || !headlines[i]) return;
    const held = wireOf.get(headlines[i]);
    if (held === undefined || wireRank(family) < wireRank(held)) wireOf.set(headlines[i], family);
  });
  return entries.map(({ family }, i) => (!family || wireRank(family) >= 0 ? family : wireOf.get(headlines[i]) ?? family));
}

/**
 * A family lookup for `items` that counts each wire reprint with its wire, for
 * detectSyndication and every count over the same items.
 *
 * @template {{ title?: unknown }} T
 * @param {readonly T[]} items
 * @param {(item: T) => string} [familyFor] defaults to publisherFamilyForItem
 * @returns {(item: T) => string}
 */
export function wireAwareFamilyFor(items, familyFor = publisherFamilyForItem) {
  const folded = foldWireReprints(items.map((item) => ({ title: item.title, family: familyFor(item) })));
  const byItem = new Map(items.map((item, i) => [item, folded[i]]));
  return (item) => (byItem.has(item) ? byItem.get(item) : familyFor(item));
}
