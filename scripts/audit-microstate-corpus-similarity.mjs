import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

export function wordShingles(value, width = 5) {
  const tokens = String(value || '')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu) || [];
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

function parseArgs(argv) {
  const options = { corpusDir: resolve('public'), check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--corpus-dir') options.corpusDir = resolve(argv[++index]);
    else if (arg.startsWith('--corpus-dir=')) options.corpusDir = resolve(arg.slice('--corpus-dir='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
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
