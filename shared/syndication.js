/**
 * Syndication detection from content (#9095).
 *
 * Corroboration counts publisher FAMILIES, and families come from the curated
 * map in publisher-families.js. A network that is not in the map (one owner
 * running the same copy under several mastheads) therefore counted as
 * independent corroboration. This module finds that case from the text: two
 * items in one story whose title and lead are near-identical are one copy, so
 * their families count once.
 *
 * Rules (each one keeps the count from going UP):
 *  - a merge only ever joins families, so the count can only go down;
 *  - two curated families are never merged: the curated map already decided
 *    they are different publishers, and a shared wire copy does not change who
 *    published it;
 *  - an item without a real lead never merges: two outlets can write the same
 *    short headline independently, so a headline alone is not evidence of a
 *    shared copy.
 */
import { publisherFamilyForItem } from './publisher-families.js';

/** A lead with fewer words than this beyond the headline's is not enough text to call two items one copy. */
export const SYNDICATION_MIN_LEAD_WORDS = 12;

/**
 * Share of the shorter item's word 3-grams the other must contain. Containment
 * rather than Jaccard, because feeds truncate the same lead at different
 * lengths.
 */
export const SYNDICATION_MIN_CONTAINMENT = 0.85;

/** Words of the lead compared; past this, feeds diverge in boilerplate. */
const LEAD_WORD_LIMIT = 60;

const CURATED_FAMILY = (family) => typeof family === 'string' && family !== '' && !family.startsWith('label:');

/**
 * Lower-case words in any script that separates words with spaces (Latin,
 * Greek, Cyrillic, Arabic, Hebrew, Devanagari...), accents and other combining
 * marks dropped. Scripts written without spaces (Chinese, Japanese, Thai) come
 * out as a few long runs, fail the lead-length rule and are never merged: the
 * count stays as curated, it does not go up.
 */
function words(text) {
  return String(text || '')
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, ' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The item's lead text: digest items carry it as `snippet`, parsed feed items as `description`. */
function leadOf(item) {
  const lead = typeof item?.snippet === 'string' && item.snippet.trim() !== '' ? item.snippet : item?.description;
  return typeof lead === 'string' ? lead : '';
}

/**
 * Word 3-grams of the title and the first LEAD_WORD_LIMIT words of the lead, or
 * null when the lead is too short to compare.
 *
 * @param {{ title?: unknown; snippet?: unknown; description?: unknown }} item
 * @returns {Set<string> | null}
 */
export function copyShingles(item) {
  const title = words(item?.title);
  const lead = words(leadOf(item));
  // Aggregator feeds (Google News) fill the description with the headline and
  // the outlet name. That repeats the title; it is not a lead, and two outlets
  // writing the same headline must not look like one copy. So the lead must
  // carry enough words the headline does not.
  const titleWords = new Set(title);
  if (lead.filter((word) => !titleWords.has(word)).length < SYNDICATION_MIN_LEAD_WORDS) return null;
  const tokens = [...title, ...lead.slice(0, LEAD_WORD_LIMIT)];
  const shingles = new Set();
  for (let i = 0; i + 2 < tokens.length; i++) shingles.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  return shingles.size > 0 ? shingles : null;
}

/**
 * Share of the smaller shingle set found in the larger (0..1).
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
export function copyContainment(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let shared = 0;
  for (const shingle of small) if (large.has(shingle)) shared += 1;
  return shared / small.size;
}

/**
 * @template T
 * @typedef {object} SyndicationResult
 * @property {(item: T) => string} familyOf The item's family after merging same-copy families ('' for an item with no family).
 * @property {number} publishers Distinct families after merging.
 * @property {{ families: string[]; labels: string[] }[]} groups Each merge: the families joined and their labels, for display and for curation review.
 */

/**
 * Merge the families of items that carry the same copy. Items are expected to
 * be one story (a cluster); comparing across stories is the caller's error.
 *
 * @template {{ source?: unknown; title?: unknown; snippet?: unknown; description?: unknown }} T
 * @param {readonly T[]} items
 * @param {(item: T) => string} [familyFor] defaults to publisherFamilyForItem
 * @returns {SyndicationResult<T>}
 */
export function detectSyndication(items, familyFor = publisherFamilyForItem) {
  const list = Array.isArray(items) ? items : [];
  const familyByItem = new Map();
  for (const item of list) familyByItem.set(item, familyFor(item) || '');

  // Union-find over family ids; each root remembers its curated member, if any.
  const parent = new Map();
  const curatedOf = new Map();
  for (const family of new Set(familyByItem.values())) {
    if (!family) continue;
    parent.set(family, family);
    curatedOf.set(family, CURATED_FAMILY(family) ? family : null);
  }
  const find = (family) => {
    let root = family;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(family) !== root) {
      const next = parent.get(family);
      parent.set(family, root);
      family = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    const curatedA = curatedOf.get(rootA);
    const curatedB = curatedOf.get(rootB);
    if (curatedA && curatedB) return; // never merge two curated publishers
    // A curated family stays the root so the merged group is named after it.
    const [root, child] = curatedB && !curatedA ? [rootB, rootA] : [rootA, rootB];
    parent.set(child, root);
    curatedOf.set(root, curatedA ?? curatedB ?? null);
  };

  const comparable = [];
  for (const item of list) {
    const family = familyByItem.get(item);
    if (!family) continue;
    const shingles = copyShingles(item);
    if (shingles) comparable.push({ family, shingles });
  }
  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      const a = comparable[i];
      const b = comparable[j];
      if (find(a.family) === find(b.family)) continue;
      if (copyContainment(a.shingles, b.shingles) >= SYNDICATION_MIN_CONTAINMENT) union(a.family, b.family);
    }
  }

  const membersByRoot = new Map();
  for (const family of parent.keys()) {
    const root = find(family);
    if (!membersByRoot.has(root)) membersByRoot.set(root, []);
    membersByRoot.get(root).push(family);
  }
  const groups = [];
  for (const members of membersByRoot.values()) {
    if (members.length < 2) continue;
    const memberSet = new Set(members);
    const labels = [];
    for (const item of list) {
      const label = typeof item?.source === 'string' ? item.source.trim() : '';
      if (label && memberSet.has(familyByItem.get(item)) && !labels.includes(label)) labels.push(label);
    }
    groups.push({ families: [...members].sort(), labels });
  }

  return {
    familyOf: (item) => {
      const family = familyByItem.has(item) ? familyByItem.get(item) : (familyFor(item) || '');
      return family && parent.has(family) ? find(family) : family;
    },
    publishers: membersByRoot.size,
    groups,
  };
}
