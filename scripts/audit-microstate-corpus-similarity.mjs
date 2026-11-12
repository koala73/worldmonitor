import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Window } from 'happy-dom';
import { isMainModule } from './lib/main-module.mjs';

const DEFAULT_FLOOR_PAIR = Object.freeze([
  { code: 'JP', slug: 'japan', names: ['Japan'] },
  { code: 'DE', slug: 'germany', names: ['Germany'] },
]);

const DEFAULT_MICROSTATE_COHORT = Object.freeze([
  { code: 'TV', slug: 'tuvalu', names: ['Tuvalu'] },
  { code: 'MO', slug: 'macau', names: ['Macau', 'Macao SAR'] },
  { code: 'SM', slug: 'san-marino', names: ['San Marino'] },
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractMainText(html) {
  const window = new Window();
  try {
    window.document.write(html);
    return window.document.querySelector('main')?.textContent || '';
  } finally {
    window.close();
  }
}

export function wordTokens(value) {
  return String(value || '')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu) || [];
}

export function wordShingles(value, width = 5) {
  const tokens = wordTokens(value);
  const shingles = new Set();
  for (let index = 0; index <= tokens.length - width; index += 1) {
    shingles.add(tokens.slice(index, index + width).join(' '));
  }
  return shingles;
}

export function shingleJaccard(left, right, width = 5) {
  const leftShingles = wordShingles(left, width);
  const rightShingles = wordShingles(right, width);
  const intersectionSize = [...leftShingles]
    .filter((shingle) => rightShingles.has(shingle)).length;
  const unionSize = new Set([...leftShingles, ...rightShingles]).size;
  return unionSize === 0 ? 1 : intersectionSize / unionSize;
}

export function maskedSentences(value, countryNames) {
  const countryPattern = [...countryNames]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');
  const countryRe = new RegExp(countryPattern, 'giu');
  const segments = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[\p{N}]+(?:[.,:/-][\p{N}]+)*/gu, '<number>')
    .match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  return segments
    .map((sentence) => sentence
      .replace(countryRe, '<country>')
      .toLocaleLowerCase('en-US')
      .replace(/[^\p{L}<>’'\s-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
}

function readCountryMain(corpusDir, country) {
  const route = `/countries/${country.slug}/`;
  const html = readFileSync(resolve(corpusDir, `countries/${country.slug}/index.html`), 'utf8');
  const mainText = extractMainText(html).trim();
  if (!mainText) {
    throw new Error(`${route} must contain non-empty <main> content`);
  }
  if (wordShingles(mainText).size === 0) {
    throw new Error(`${route} must contain enough <main> content for a 5-word shingle`);
  }
  return {
    ...country,
    route,
    mainText,
  };
}

function readPublishedFloorCountry(corpusDir, country) {
  const page = readCountryMain(corpusDir, country);
  const snapshot = JSON.parse(readFileSync(
    resolve(corpusDir, `countries/${country.slug}/resilience.json`),
    'utf8',
  ));
  if (
    snapshot.countryCode !== country.code
    || snapshot.headlineEligible !== true
    || !Number.isInteger(snapshot.rank)
    || snapshot.rank < 1
    || !Number.isFinite(snapshot.overallScore)
  ) {
    throw new Error(
      `${page.route} must be a headline-eligible ranked page with a published overall score`,
    );
  }
  return page;
}

function pairMetric(left, right) {
  return {
    codes: [left.code, right.code],
    routes: [left.route, right.route],
    jaccard: shingleJaccard(left.mainText, right.mainText),
  };
}

export function auditMicrostateCorpusSimilarity({
  corpusDir,
  floorPair = DEFAULT_FLOOR_PAIR,
  cohort = DEFAULT_MICROSTATE_COHORT,
} = {}) {
  if (!corpusDir) throw new Error('corpusDir is required');
  const floorPages = floorPair.map((country) => readPublishedFloorCountry(corpusDir, country));
  const cohortPages = cohort.map((country) => readCountryMain(corpusDir, country));
  const floor = pairMetric(floorPages[0], floorPages[1]);
  const threshold = floor.jaccard + 0.05;
  const pairs = [];
  for (let left = 0; left < cohortPages.length; left += 1) {
    for (let right = left + 1; right < cohortPages.length; right += 1) {
      pairs.push(pairMetric(cohortPages[left], cohortPages[right]));
    }
  }
  const sentenceSets = cohortPages.map((page) => maskedSentences(page.mainText, page.names));
  const sharedSentences = sentenceSets[0]
    .filter((sentence) => sentenceSets.slice(1).every((sentences) => sentences.includes(sentence)));
  return {
    floor,
    threshold,
    pairs,
    maskedSentenceSharing: {
      referenceCode: cohortPages[0].code,
      sentenceCounts: Object.fromEntries(
        cohortPages.map((page, index) => [page.code, sentenceSets[index].length]),
      ),
      sharedCount: sharedSentences.length,
      share: sharedSentences.length / Math.max(sentenceSets[0].length, 1),
    },
  };
}

// Limits `--family <name> --check` enforces; the corpus test reads the same
// table. A family without an entry has no agreed limits, so checking it is an
// error rather than a silent pass.
export const CORPUS_FAMILY_LIMITS = Object.freeze({
  crises: Object.freeze({ minWords: 700, maxMeanJaccard: 0.3 }),
});

export function corpusFamilyViolations(audit, limits = CORPUS_FAMILY_LIMITS[audit.family]) {
  if (!limits) throw new Error(`No --check limits are defined for the ${audit.family} family`);
  return [
    ...audit.pages
      .filter((page) => page.words < limits.minWords)
      .map((page) => `${page.route} has ${page.words} main-text words; the floor is ${limits.minWords}`),
    ...(audit.meanPairwiseJaccard >= limits.maxMeanJaccard
      ? [`${audit.family} mean pairwise 5-shingle overlap is ${audit.meanPairwiseJaccard.toFixed(3)}; the ceiling is ${limits.maxMeanJaccard}`]
      : []),
  ];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Per-page main-text word counts and pairwise 5-shingle Jaccard for every
// detail page of one generated family (`<family>/<slug>/index.html`). The hub
// page at `<family>/index.html` is excluded: it is a list, not a peer.
export function auditCorpusFamily({ corpusDir, family }) {
  if (!corpusDir) throw new Error('corpusDir is required');
  if (!/^[a-z0-9-]+$/.test(String(family || ''))) throw new Error('family must be a corpus directory name');
  const familyDir = resolve(corpusDir, family);
  const pages = readdirSync(familyDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(familyDir, entry.name, 'index.html')))
    .map((entry) => entry.name)
    .sort()
    .map((slug) => {
      const route = `/${family}/${slug}/`;
      const mainText = extractMainText(readFileSync(join(familyDir, slug, 'index.html'), 'utf8')).trim();
      if (!mainText) throw new Error(`${route} must contain non-empty <main> content`);
      // Two pages with no 5-word shingle would score as identical (Jaccard 1).
      if (wordShingles(mainText).size === 0) {
        throw new Error(`${route} must contain enough <main> content for a 5-word shingle`);
      }
      return { slug, route, mainText, words: wordTokens(mainText).length };
    });
  if (pages.length < 2) throw new Error(`${family} needs at least two detail pages to compare`);
  const pairs = [];
  for (let left = 0; left < pages.length; left += 1) {
    for (let right = left + 1; right < pages.length; right += 1) {
      pairs.push({
        routes: [pages[left].route, pages[right].route],
        jaccard: shingleJaccard(pages[left].mainText, pages[right].mainText),
      });
    }
  }
  const maxPair = pairs.reduce((worst, pair) => (pair.jaccard > worst.jaccard ? pair : worst), pairs[0]);
  return {
    family,
    pageCount: pages.length,
    pages: pages.map(({ route, words }) => ({ route, words })),
    minWords: Math.min(...pages.map((page) => page.words)),
    medianWords: median(pages.map((page) => page.words)),
    meanPairwiseJaccard: pairs.reduce((sum, pair) => sum + pair.jaccard, 0) / pairs.length,
    maxPair,
  };
}

function parseArgs(argv) {
  const options = { corpusDir: resolve('public'), check: false, family: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--family') options.family = argv[++index];
    else if (arg.startsWith('--family=')) options.family = arg.slice('--family='.length);
    else if (arg === '--corpus-dir') options.corpusDir = resolve(argv[++index]);
    else if (arg.startsWith('--corpus-dir=')) options.corpusDir = resolve(arg.slice('--corpus-dir='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.family) {
    const audit = auditCorpusFamily(options);
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    if (!options.check) return;
    const violations = corpusFamilyViolations(audit);
    for (const violation of violations) process.stderr.write(`${violation}\n`);
    if (violations.length) process.exitCode = 1;
    return;
  }
  const result = auditMicrostateCorpusSimilarity(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!options.check) return;
  const hasFailingPair = result.pairs.some((pair) => pair.jaccard > result.threshold);
  if (hasFailingPair || result.maskedSentenceSharing.share >= 0.4) {
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
