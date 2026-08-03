#!/usr/bin/env node
// Build a deterministic, static HTML corpus for crawlable pages that should
// live outside the SPA catch-all. Inputs are committed repo data only: no
// network calls, no env files, and no live secrets.

import { execFileSync } from 'node:child_process';

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeResearchSection } from './build-research-reports.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUT_DIR = join(DEFAULT_ROOT, 'public');
const DEFAULT_BASE_URL = 'https://www.worldmonitor.app';
const RESILIENCE_SNAPSHOT_PATH = 'docs/snapshots/resilience-ranking-2026-05-28.json';
const COUNTRY_NAMES_PATH = 'shared/country-names.json';
const CHOKEPOINT_REGISTRY_PATH = 'src/config/chokepoint-registry.ts';
const TRADE_ROUTES_PATH = 'src/config/trade-routes.ts';
const GLOSSARY_DATA_PATH = 'blog-site/src/data/glossary.ts';
const CHANGELOG_PATH = 'CHANGELOG.md';
const LIVE_TOOLS_SCRIPT_PATH = 'scripts/crawlable-live-tools.mjs';
const COUNTRY_BBOXES_PATH = 'shared/country-bboxes.js';
const CRISIS_REGISTRY_PATH = 'shared/crawlable-crises.json';
const RESEARCH_REPORTS_INDEX_PATH = 'shared/research-reports/index.mjs';
// Last substantive change to the shared HTML template/content language. Data
// families take the later of this version and their own committed source date,
// so template changes are reflected without pretending every deploy is fresh.
export const CORPUS_GENERATOR_CONTENT_VERSION = '2026-07-27';
const COUNTRY_PAGE_CONTENT_VERSION = '2026-07-28';
const CHOKEPOINT_PAGE_CONTENT_VERSION = '2026-07-28';
const CHANGELOG_PAGE_SIZE = 2;
const MAX_TOOL_LATITUDE_SPAN = 45;
const MAX_TOOL_LONGITUDE_SPAN = 60;
const META_DESCRIPTION_MIN = 155;
const META_DESCRIPTION_MAX = 160;

// Hand-authored, human-readable context for each canonical chokepoint, keyed by
// the registry `id`. `region` describes what the waterway connects (used as the
// index card subtitle and the "Connects" tile); `blurb` is a factual 2-sentence
// summary used as the page lede; `glossarySlug` cross-links
// to the matching /blog/glossary/ term where one exists. Keeping this beside the
// registry (rather than in it) keeps the app bundle free of prose it never uses.
const CHOKEPOINT_CONTENT = {
  suez: {
    region: 'Mediterranean ↔ Red Sea',
    glossarySlug: 'suez-canal',
    blurb:
      'The Suez Canal is the artificial waterway linking the Mediterranean and the Red Sea, giving shipping the shortest route between Europe and Asia without rounding Africa. Its southern approach runs through Bab el-Mandeb, so a blockage or a Red Sea security threat that reroutes traffic around the Cape of Good Hope adds days of transit and materially raises freight costs.',
  },
  malacca_strait: {
    region: 'Indian Ocean ↔ South China Sea',
    glossarySlug: 'strait-of-malacca',
    blurb:
      'The Strait of Malacca runs between the Malay Peninsula and Sumatra, linking the Indian Ocean to the South China Sea and the Pacific. It is one of the busiest shipping lanes in the world and the main artery for energy and container flows into East Asia, where the alternatives are longer and lower-capacity.',
  },
  hormuz_strait: {
    region: 'Persian Gulf ↔ Gulf of Oman',
    glossarySlug: 'strait-of-hormuz',
    blurb:
      'The Strait of Hormuz is the narrow waterway connecting the Persian Gulf to the Gulf of Oman and the open ocean. It is the single most closely watched energy chokepoint on Earth: a very large share of the world’s seaborne crude oil and LNG has no alternative route out of the Gulf.',
  },
  bab_el_mandeb: {
    region: 'Red Sea ↔ Gulf of Aden',
    blurb:
      'Bab el-Mandeb is the strait between the Horn of Africa and the Arabian Peninsula that connects the Red Sea to the Gulf of Aden and the Indian Ocean. Every ship using the Suez Canal route also transits Bab el-Mandeb, so attacks or instability here push traffic onto the far longer Cape of Good Hope route.',
  },
  panama: {
    region: 'Atlantic ↔ Pacific',
    blurb:
      'The Panama Canal cuts across the Isthmus of Panama to link the Atlantic and Pacific oceans, saving vessels the long voyage around South America. Its lock system depends on freshwater from Gatún Lake, so drought can throttle daily transits and reshape Asia–US East Coast routing.',
  },
  taiwan_strait: {
    region: 'East China Sea ↔ South China Sea',
    blurb:
      'The Taiwan Strait separates Taiwan from mainland China and carries a large share of the container traffic moving between North Asia and the rest of the world. Its strategic sensitivity makes any military tension here a first-order risk to global shipping and the semiconductor supply chain.',
  },
  cape_of_good_hope: {
    region: 'Atlantic ↔ Indian Ocean',
    blurb:
      'The Cape of Good Hope is the deep-water route around the southern tip of Africa. It has no canal tolls and no width limits, which makes it the default fallback when the Suez–Bab el-Mandeb corridor is disrupted — at the cost of thousands of extra nautical miles and days of transit.',
  },
  gibraltar: {
    region: 'Atlantic ↔ Mediterranean',
    blurb:
      'The Strait of Gibraltar is the roughly 14-km-wide gateway between the Atlantic Ocean and the Mediterranean Sea. Every cargo moving between the Mediterranean and the wider ocean — including Suez-bound Europe–Asia traffic — passes through it.',
  },
  bosphorus: {
    region: 'Black Sea ↔ Sea of Marmara',
    blurb:
      'The Bosporus Strait runs through Istanbul to connect the Black Sea to the Sea of Marmara and, via the Dardanelles, the Mediterranean. It is the sole maritime outlet for Black Sea grain and Russian oil exports, and passage through it is governed by the Montreux Convention.',
  },
  korea_strait: {
    region: 'East China Sea ↔ Sea of Japan',
    blurb:
      'The Korea Strait lies between the Korean Peninsula and the Japanese islands, linking the East China Sea to the Sea of Japan. It is a key passage for North Asian container and energy traffic and a closely watched naval corridor.',
  },
  dover_strait: {
    region: 'English Channel ↔ North Sea',
    blurb:
      'The Strait of Dover is the narrowest point of the English Channel, connecting it to the North Sea. It is one of the busiest shipping lanes in the world, funnelling North Sea and Baltic traffic past the coasts of England and France.',
  },
  kerch_strait: {
    region: 'Black Sea ↔ Sea of Azov',
    blurb:
      'The Kerch Strait connects the Black Sea to the Sea of Azov and is the only sea route to the Azov ports of Ukraine and Russia. It has been a repeated flashpoint in the Russia–Ukraine conflict, where control of the strait directly gates Azov-basin trade.',
  },
  lombok_strait: {
    region: 'Indian Ocean ↔ Java Sea',
    blurb:
      'The Lombok Strait, between Bali and Lombok, is a deep-water alternative to the Malacca–Singapore route. It is favoured by the largest, deepest-draft bulk carriers and serves as a relief valve when Malacca is congested or disrupted.',
  },
};

// Search-friendly display names for ISO2 codes whose committed snapshot /
// bbox labels are formal long forms, truncated tokens ("Uk", "Korea Rep",
// "Lao Pdr"), or bare codes. Applied AFTER slug computation so every live
// URL stays stable; this only changes what readers and SERPs see.
const COUNTRY_DISPLAY_NAMES = {
  AE: 'United Arab Emirates',
  AG: 'Antigua and Barbuda',
  BA: 'Bosnia and Herzegovina',
  CD: 'DR Congo',
  CG: 'Republic of the Congo',
  CI: 'Côte d’Ivoire',
  EH: 'Western Sahara',
  FM: 'Micronesia',
  GB: 'United Kingdom',
  KG: 'Kyrgyzstan',
  KN: 'Saint Kitts and Nevis',
  KP: 'North Korea',
  KR: 'South Korea',
  LA: 'Laos',
  NC: 'New Caledonia',
  PR: 'Puerto Rico',
  PS: 'Palestine',
  RS: 'Serbia',
  SK: 'Slovakia',
  ST: 'São Tomé and Príncipe',
  TL: 'Timor-Leste',
  TT: 'Trinidad and Tobago',
  VC: 'Saint Vincent and the Grenadines',
  VE: 'Venezuela',
  XK: 'Kosovo',
};

function displayCountryName(code, fallbackName) {
  return COUNTRY_DISPLAY_NAMES[code] || fallbackName || code;
}

const GENERATED_DIRS = [
  'countries',
  'chokepoints',
  'crises',
  'tools',
  'reference/changelog',
  'research',
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function repoPath(rootDir, relativePath) {
  return join(rootDir, relativePath);
}

function readText(rootDir, relativePath) {
  return readFileSync(repoPath(rootDir, relativePath), 'utf8');
}

function readJson(rootDir, relativePath) {
  return JSON.parse(readText(rootDir, relativePath));
}

function laterDate(...values) {
  return values
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? ''))
    .sort()
    .at(-1) ?? null;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function absoluteUrl(baseUrl, pathname) {
  return `${normalizeBaseUrl(baseUrl)}${pathname}`;
}

// Tag dashboard-bound CTAs so page→dashboard conversion is measurable in the
// analytics UTM report. Deliberately NOT `ref=`: the dashboard captures
// `?ref=` as an affiliate referral code (src/services/referral-capture.ts)
// and forwards it to checkout attribution, so a static-page source tag there
// would pollute purchase attribution.
function withUtmSource(url, utmSource) {
  return `${url}${url.includes('?') ? '&' : '?'}utm_source=${utmSource}`;
}

const OG_IMAGE_PATH = '/favico/og-image.png';
const OG_IMAGE_ALT = 'World Monitor — real-time global intelligence dashboard with live markets, geopolitical data, and infrastructure monitoring';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsonScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
}

function uniqueSlug(preferred, code, seen) {
  const base = slugify(preferred || code);
  const fallback = slugify(code);
  let slug = base || fallback;
  if (!seen.has(slug)) {
    seen.add(slug);
    return slug;
  }
  slug = `${base || 'page'}-${String(code).toLowerCase()}`;
  let i = 2;
  while (seen.has(slug)) {
    slug = `${base || 'page'}-${String(code).toLowerCase()}-${i}`;
    i += 1;
  }
  seen.add(slug);
  return slug;
}

function titleCaseName(value) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function reverseCountryNames(forward) {
  const reverse = new Map();
  for (const [name, code] of Object.entries(forward || {})) {
    const iso2 = String(code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso2) || reverse.has(iso2)) continue;
    reverse.set(iso2, titleCaseName(name));
  }
  return reverse;
}

function prettyDate(isoDate) {
  const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(isoDate || '');
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'not available';
  return `${Math.round(numeric * 100)}%`;
}

function formatScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'not ranked';
  return numeric.toFixed(1).replace(/\.0$/, '');
}

function formatCoordinates(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'not available';
  const latText = `${Math.abs(lat)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonText = `${Math.abs(lon)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${latText}, ${lonText}`;
}

function longestEligibleMetaDescription(candidates) {
  return [...new Set(candidates)]
    .map((candidate) => String(candidate ?? '').trim())
    .filter((candidate) => candidate.length <= META_DESCRIPTION_MAX)
    .sort((a, b) => b.length - a.length)[0];
}

function formatMetaDescriptionList(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function signalMetaDescriptionCandidates({ subjects, signals }) {
  const candidates = [];
  const subsetCount = 2 ** signals.length;
  for (const subject of subjects) {
    for (const verb of ['tracks', 'monitors', 'covers']) {
      for (let mask = 1; mask < subsetCount; mask += 1) {
        const selectedSignals = signals.filter((_, index) => mask & (2 ** index));
        if (selectedSignals.length < 3) continue;
        candidates.push(`${subject}: ${verb} ${formatMetaDescriptionList(selectedSignals)}.`);
      }
    }
  }
  return candidates;
}

function selectMetaDescription(candidates, fallbackCandidates) {
  const selected = longestEligibleMetaDescription(candidates);
  if (selected?.length >= META_DESCRIPTION_MIN) return selected;

  const fallback = longestEligibleMetaDescription(fallbackCandidates?.() ?? []);
  if (fallback?.length >= META_DESCRIPTION_MIN) return fallback;

  throw new Error(
    `No meta description candidate fits ${META_DESCRIPTION_MIN}-${META_DESCRIPTION_MAX} characters`,
  );
}

export function countryMetaDescription({ name, rank, rankedCount }) {
  const subjects = [
    `${name} country risk and resilience`,
    `${name} country risk`,
    `${name} risk and resilience`,
  ];
  const standings = rank == null
    ? [
      `a low-confidence listing in World Monitor's Country Resilience Index`,
      `a low-confidence listing in World Monitor's resilience index`,
      `a low-confidence listing in World Monitor's index`,
      `a low-confidence World Monitor index listing`,
      `a low-confidence index listing`,
    ]
    : [
      `ranked #${rank} of ${rankedCount} in World Monitor's Country Resilience Index`,
      `ranked #${rank} of ${rankedCount} in World Monitor's resilience index`,
      `ranked #${rank} of ${rankedCount} in World Monitor's index`,
      `#${rank} of ${rankedCount} in World Monitor's resilience index`,
      `#${rank} of ${rankedCount} in World Monitor's index`,
    ];
  const signals = [
    'with live instability, travel advisories, sanctions and security signals.',
    'with current instability, travel advisories, sanctions and security signals.',
    'with live instability, travel-advisory and sanctions signals.',
    'plus live instability, travel advisories, sanctions and security signals.',
    'with live instability, advisories, sanctions and security signals.',
    'with instability, travel advisories, sanctions and security signals.',
    'with current instability, advisories, sanctions and security signals.',
  ];
  const candidates = subjects.flatMap((subject) => standings.flatMap(
    (standing) => signals.map((signal) => `${subject}: ${standing}, ${signal}`),
  ));
  return selectMetaDescription(candidates, () => signalMetaDescriptionCandidates({
    subjects: [
      `${name} country risk profile`,
      `${name} risk profile`,
      `${name} country risk`,
      `${name} risk`,
    ],
    signals: [
      'live instability',
      'travel advisories',
      'sanctions',
      'security signals',
      'resilience rankings',
      'current conditions',
      'global context',
      'regional context',
      'risk trends',
      'public data',
    ],
  }));
}

export function chokepointMetaDescription(name) {
  const subjects = [
    `${name} chokepoint status`,
    `${name} live chokepoint status`,
    `${name} maritime chokepoint status`,
    `${name} live status`,
  ];
  const signals = [
    'monitor live disruption risk, vessel transits, congestion, AIS warnings and key trade routes through this strategic waterway.',
    'track live disruption risk, vessel transits, congestion, AIS warnings and major trade routes through this strategic waterway.',
    'track disruption risk, vessel transits, congestion, AIS warnings and major trade routes through this strategic waterway.',
    'monitor disruption risk, transits, congestion, AIS warnings and trade routes through this strategic waterway.',
  ];
  const candidates = subjects.flatMap(
    (subject) => signals.map((signal) => `${subject}: ${signal}`),
  );
  return selectMetaDescription(candidates, () => signalMetaDescriptionCandidates({
    subjects: [
      `${name} maritime chokepoint`,
      `${name} chokepoint status`,
      `${name} chokepoint`,
      `${name} status`,
    ],
    signals: [
      'live disruption risk',
      'vessel transits',
      'congestion',
      'AIS warnings',
      'trade routes',
      'maritime security',
      'current conditions',
      'regional context',
      'shipping signals',
      'public data',
    ],
  }));
}

function metricTile(label, value) {
  return `        <div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

async function importRepoModule(rootDir, relativePath) {
  return import(pathToFileURL(repoPath(rootDir, relativePath)).href);
}

function normalizeGlossaryTerms(terms) {
  return (terms || [])
    .map((term) => ({
      slug: term.slug,
      term: term.term,
      abbr: term.abbr || undefined,
      short: term.short,
    }))
    .filter((term) => term.slug && term.term)
    .sort((a, b) => a.term.localeCompare(b.term));
}

function normalizeChokepoints(entries) {
  return (entries || [])
    .map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      baselineId: entry.baselineId,
      shockModelSupported: Boolean(entry.shockModelSupported),
      routeIds: Array.isArray(entry.routeIds) ? [...entry.routeIds] : [],
      lat: Number(entry.lat),
      lon: Number(entry.lon),
      slug: slugify(entry.displayName || entry.id),
    }))
    .filter((entry) => entry.id && entry.displayName)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function normalizeCountries(snapshot, reverseNames) {
  const seen = new Set();
  const ranked = (snapshot.items || []).map((item) => {
    const code = String(item.countryCode || '').toUpperCase();
    // Slugs derive from the raw snapshot name so live URLs stay stable even
    // when the reader-facing display name is aliased.
    const rawName = item.countryName || reverseNames.get(code) || code;
    return {
      code,
      name: displayCountryName(code, rawName),
      slug: uniqueSlug(rawName, code, seen),
      rank: Number(item.rank),
      overallScore: item.overallScore,
      level: item.level || 'unclassified',
      lowConfidence: Boolean(item.lowConfidence),
      dimensionCoverage: item.dimensionCoverage ?? item.overallCoverage ?? null,
      headlineEligible: item.headlineEligible !== false,
      sourceStatus: 'ranked',
    };
  });

  const rankedCodes = new Set(ranked.map((country) => country.code));
  const greyedOut = (snapshot.greyedOut || [])
    .filter((item) => !rankedCodes.has(String(item.countryCode || '').toUpperCase()))
    .map((item) => {
      const code = String(item.countryCode || '').toUpperCase();
      const rawName = item.countryName || reverseNames.get(code) || code;
      return {
        code,
        name: displayCountryName(code, rawName),
        slug: uniqueSlug(rawName, code, seen),
        rank: null,
        overallScore: item.overallScore ?? null,
        level: item.level || 'low-confidence',
        lowConfidence: true,
        dimensionCoverage: item.overallCoverage ?? item.dimensionCoverage ?? null,
        headlineEligible: item.headlineEligible === true,
        sourceStatus: 'low-confidence',
      };
    });

  return [...ranked, ...greyedOut].sort((a, b) => {
    if (a.rank == null && b.rank == null) return a.name.localeCompare(b.name);
    if (a.rank == null) return 1;
    if (b.rank == null) return -1;
    return a.rank - b.rank;
  });
}

function normalizeCountryBounds(countryBboxes, countries, reverseNames = new Map()) {
  const names = new Map(countries.map((country) => [country.code, country.name]));
  return Object.entries(countryBboxes || {})
    .map(([code, rawBounds]) => {
      if (!/^[A-Z]{2}$/.test(code) || !Array.isArray(rawBounds) || rawBounds.length !== 4) return null;
      const bounds = rawBounds.map(Number);
      const [south, west, north, east] = bounds;
      if (
        bounds.some((value) => !Number.isFinite(value))
        || south < -90
        || north > 90
        || south > north
        || west < -180
        || west > 180
        || east < -180
        || east > 180
      ) {
        return null;
      }
      if (
        north - south > MAX_TOOL_LATITUDE_SPAN
        || (west <= east ? east - west : 360 - (west - east)) > MAX_TOOL_LONGITUDE_SPAN
      ) {
        return null;
      }
      return {
        code,
        // Bare ISO2 codes ("EH", "XK") must never surface as user-facing
        // labels in the tool selects — alias, then reverse-name, then code.
        name: displayCountryName(code, names.get(code) || reverseNames.get(code)),
        bounds,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeCrises(entries) {
  const seen = new Set();
  return (entries || []).map((entry) => {
    const slug = String(entry.slug || '');
    const dashboardPath = String(entry.dashboardPath || '');
    const coverage = Array.isArray(entry.coverage)
      ? entry.coverage.map((country) => ({
          code: String(country.code || '').toUpperCase(),
          name: String(country.name || ''),
        }))
      : [];
    const coverageCodes = new Set(coverage.map((country) => country.code));
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
      || seen.has(slug)
      || !entry.title
      || !entry.shortTitle
      || !entry.description
      || !entry.overview
      || !dashboardPath.startsWith('/')
      || dashboardPath.startsWith('//')
      || coverage.length === 0
      || coverageCodes.size !== coverage.length
      || coverage.some((country) => !/^[A-Z]{2}$/.test(country.code) || !country.name)
    ) {
      throw new Error(`Invalid crawlable crisis registry entry: ${slug || '(missing slug)'}`);
    }
    seen.add(slug);
    return {
      slug,
      title: String(entry.title),
      shortTitle: String(entry.shortTitle),
      description: String(entry.description),
      overview: String(entry.overview),
      coverage,
      dashboardPath,
    };
  });
}

function stripMarkdownInline(value) {
  return String(value || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseChangelog(source) {
  const matches = [...source.matchAll(/^## \[([^\]]+)\](?: - ([0-9-]+))?\s*$/gm)];
  return matches.map((match, index) => {
    const next = matches[index + 1];
    const body = source.slice(match.index + match[0].length, next ? next.index : source.length);
    const bulletItems = [];
    let currentBullet = null;
    for (const line of body.split(/\r?\n/)) {
      const bulletMatch = line.match(/^- (.+)$/);
      if (bulletMatch) {
        if (currentBullet) bulletItems.push(currentBullet.join(' '));
        currentBullet = [bulletMatch[1]];
      } else if (currentBullet && /^\s{2,}\S/.test(line)) {
        currentBullet.push(line.trim());
      } else if (currentBullet && line.trim() === '') {
      } else if (currentBullet) {
        bulletItems.push(currentBullet.join(' '));
        currentBullet = null;
      }
    }
    if (currentBullet) bulletItems.push(currentBullet.join(' '));
    const bullets = bulletItems
      .map((line) => stripMarkdownInline(line))
      .filter(Boolean)
      .slice(0, 8);
    const headings = [...body.matchAll(/^###\s+(.+)$/gm)]
      .map(([, heading]) => stripMarkdownInline(heading))
      .filter(Boolean);
    return {
      label: match[1],
      date: match[2] || null,
      slug: slugify(match[1] === 'Unreleased' ? 'unreleased' : match[1]),
      headings,
      bullets,
    };
  }).filter((release) => release.label && release.bullets.length > 0);
}

function latestDatedChangelogRelease(changelog) {
  const dates = changelog
    .map((release) => release.date)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date ?? ''))
    .sort();
  return dates[dates.length - 1] || null;
}

// Git's local env vars (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...) override
// `cwd`, so a build running inside a git hook would silently resolve these
// queries against the hook's repository instead of the rootDir it was given.
// Strip them, and render dates in UTC (see gitFileLastmod).
let gitLocalEnvVars = null;
function gitEnvForRoot() {
  if (gitLocalEnvVars === null) {
    try {
      gitLocalEnvVars = execFileSync('git', ['rev-parse', '--local-env-vars'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split('\n');
    } catch {
      gitLocalEnvVars = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];
    }
  }
  const env = { ...process.env, TZ: 'UTC' };
  for (const name of gitLocalEnvVars) delete env[name];
  return env;
}

function hasCompleteGitHistory(rootDir) {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnvForRoot(),
    }).trim() === 'false';
  } catch {
    return false;
  }
}

export function gitFileLastmod(rootDir, relativePath) {
  if (!hasCompleteGitHistory(rootDir)) return null;
  try {
    // Committer date rendered in UTC, not the commit's recorded timezone —
    // a +04:00 evening commit would otherwise date as "tomorrow" against a
    // UTC build clock and trip build-sitemap's future-lastmod guard.
    const out = execFileSync(
      'git',
      ['log', '-1', '--date=format-local:%Y-%m-%d', '--format=%cd', '--', relativePath],
      {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: gitEnvForRoot(),
      },
    ).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export async function loadCorpusData({ rootDir = DEFAULT_ROOT } = {}) {
  const resilience = readJson(rootDir, RESILIENCE_SNAPSHOT_PATH);
  const reverseNames = reverseCountryNames(readJson(rootDir, COUNTRY_NAMES_PATH));
  const [
    { CHOKEPOINT_REGISTRY },
    { TRADE_ROUTES },
    { GLOSSARY_TERMS },
    { default: countryBboxes },
    { RESEARCH_REPORTS },
  ] = await Promise.all([
    importRepoModule(rootDir, CHOKEPOINT_REGISTRY_PATH),
    importRepoModule(rootDir, TRADE_ROUTES_PATH),
    importRepoModule(rootDir, GLOSSARY_DATA_PATH),
    importRepoModule(rootDir, COUNTRY_BBOXES_PATH),
    importRepoModule(rootDir, RESEARCH_REPORTS_INDEX_PATH),
  ]);
  const researchReports = RESEARCH_REPORTS.map((report) => ({
    report,
    snapshot: readJson(rootDir, report.snapshotPath),
  }));
  const countries = normalizeCountries(resilience, reverseNames);
  const countryBounds = normalizeCountryBounds(countryBboxes, countries, reverseNames);
  const crises = normalizeCrises(readJson(rootDir, CRISIS_REGISTRY_PATH));
  const chokepoints = normalizeChokepoints(CHOKEPOINT_REGISTRY);
  const tradeRoutesById = new Map(
    (TRADE_ROUTES || []).map((route) => [route.id, {
      id: route.id,
      name: route.name,
      volumeDesc: route.volumeDesc,
      category: route.category,
    }]),
  );
  const glossaryTerms = normalizeGlossaryTerms(GLOSSARY_TERMS);
  const changelog = parseChangelog(readText(rootDir, CHANGELOG_PATH));
  const countriesLastmod = laterDate(
    resilience.capturedAt,
    CORPUS_GENERATOR_CONTENT_VERSION,
    COUNTRY_PAGE_CONTENT_VERSION,
  );
  const changelogLastmod = laterDate(
    gitFileLastmod(rootDir, CHANGELOG_PATH),
    latestDatedChangelogRelease(changelog),
    CORPUS_GENERATOR_CONTENT_VERSION,
  );
  const chokepointsLastmod = laterDate(
    gitFileLastmod(rootDir, CHOKEPOINT_REGISTRY_PATH),
    CORPUS_GENERATOR_CONTENT_VERSION,
    CHOKEPOINT_PAGE_CONTENT_VERSION,
  );
  const toolsLastmod = laterDate(
    gitFileLastmod(rootDir, LIVE_TOOLS_SCRIPT_PATH),
    CORPUS_GENERATOR_CONTENT_VERSION,
  );
  const crisesLastmod = laterDate(
    gitFileLastmod(rootDir, CRISIS_REGISTRY_PATH),
    CORPUS_GENERATOR_CONTENT_VERSION,
  );
  const researchLastmod = laterDate(
    ...researchReports.map(({ report }) => report.dateModified),
    CORPUS_GENERATOR_CONTENT_VERSION,
  );

  return {
    generatorContentVersion: CORPUS_GENERATOR_CONTENT_VERSION,
    sources: {
      resilienceSnapshot: RESILIENCE_SNAPSHOT_PATH,
      countryNames: COUNTRY_NAMES_PATH,
      chokepointRegistry: CHOKEPOINT_REGISTRY_PATH,
      glossaryData: GLOSSARY_DATA_PATH,
      changelog: CHANGELOG_PATH,
      tradeRoutes: TRADE_ROUTES_PATH,
      liveToolsScript: LIVE_TOOLS_SCRIPT_PATH,
      countryBboxes: COUNTRY_BBOXES_PATH,
      crisisRegistry: CRISIS_REGISTRY_PATH,
      researchReports: RESEARCH_REPORTS_INDEX_PATH,
    },
    lastmod: {
      countries: countriesLastmod,
      changelog: changelogLastmod,
      chokepoints: chokepointsLastmod,
      tools: toolsLastmod,
      crises: crisesLastmod,
      research: researchLastmod,
    },
    resilience,
    countries,
    countryBounds,
    crises,
    chokepoints,
    tradeRoutesById,
    glossaryTerms,
    changelog,
    researchReports,
  };
}

function breadcrumbLd(baseUrl, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(baseUrl, item.path),
    })),
  };
}

function pageDocument({
  baseUrl,
  path,
  title,
  description,
  lastmod,
  paginationLinks = [],
  jsonLd,
  breadcrumbs,
  body,
  scriptSrcs = [],
  ogImage = OG_IMAGE_PATH,
  ogImageAlt = OG_IMAGE_ALT,
}) {
  const canonical = absoluteUrl(baseUrl, path);
  const ld = [jsonLd, breadcrumbs].filter(Boolean);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    ${lastmod ? `<meta name="lastmod" content="${escapeHtml(lastmod)}">` : []}
    ${paginationLinks.map((link) => `<link rel="${escapeHtml(link.rel)}" href="${escapeHtml(absoluteUrl(baseUrl, link.path))}">`).join(String.fromCharCode(10) + "    ")}
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <meta property="og:site_name" content="World Monitor">
    <meta property="og:image" content="${escapeHtml(absoluteUrl(baseUrl, ogImage))}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${escapeHtml(ogImageAlt)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(absoluteUrl(baseUrl, ogImage))}">
    <meta name="twitter:image:alt" content="${escapeHtml(ogImageAlt)}">
    <meta name="twitter:site" content="@worldmonitorai">
    ${ld.map((entry) => `<script type="application/ld+json">${escapeJsonScript(entry)}</script>`).join('\n    ')}
    <style>
      :root { color-scheme: dark; --bg: #050807; --panel: #0c1210; --text: #eef8f0; --muted: #a8b8ad; --line: #1b2b22; --accent: #4ade80; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      header, main, footer { max-width: 960px; margin: 0 auto; padding: 0 20px; }
      header { padding-top: 24px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
      nav { display: flex; gap: 4px 14px; flex-wrap: wrap; font-size: 14px; }
      nav a { display: inline-flex; align-items: center; min-height: 44px; }
      main { padding-top: 36px; padding-bottom: 52px; }
      h1 { font-size: clamp(32px, 5vw, 54px); line-height: 1; margin: 0 0 16px; letter-spacing: 0; }
      h2 { margin-top: 36px; font-size: 22px; }
      p { color: var(--muted); }
      .lede { font-size: 18px; max-width: 760px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 24px; }
      .card, .metric { border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: var(--panel); }
      .metric strong { display: block; font-size: 28px; color: var(--text); }
      .metric small { display: block; color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
      .eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; font-weight: 700; }
      .cta { display: inline-flex; align-items: center; gap: 8px; margin-top: 22px; padding: 13px 18px; border-radius: 8px; background: var(--accent); color: #04170c; font-weight: 700; font-size: 15px; }
      .cta:hover { text-decoration: none; filter: brightness(1.08); }
      .live-tool { margin-top: 28px; padding: 20px; border: 1px solid #28543a; border-radius: 12px; background: linear-gradient(145deg, #0e1712, #09100c); }
      .live-tool h2 { margin: 3px 0 0; }
      .live-tool .grid { margin-top: 18px; }
      .tool-head, .tool-meta { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .tool-note { max-width: 760px; margin-bottom: 0; }
      .tool-meta { margin-top: 16px; color: var(--muted); font-size: 13px; }
      .live-status { padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 12px; font-weight: 700; }
      .live-tool[data-state="ready"] .live-status { border-color: #28543a; color: var(--accent); }
      .live-tool[data-state="partial"] .live-status { border-color: #7c6322; color: #fde68a; }
      .live-tool[data-state="error"] .live-status { border-color: #6f3b3b; color: #fca5a5; }
      .refresh { border: 1px solid var(--line); border-radius: 7px; padding: 12px 14px; background: #121d16; color: var(--text); cursor: pointer; font: inherit; }
      .refresh:hover:not(:disabled) { border-color: var(--accent); }
      .refresh:disabled { cursor: wait; opacity: 0.55; }
      .tool-controls { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
      .tool-controls label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
      .tool-controls select { min-width: 240px; border: 1px solid var(--line); border-radius: 7px; padding: 12px 34px 12px 12px; background: #121d16; color: var(--text); font: inherit; }
      .result-list { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 8px; }
      .result-list li { border-left: 2px solid var(--line); padding: 8px 12px; color: var(--muted); font-size: 14px; }
      .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; margin-top: 18px; }
      .split > section { border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: var(--panel); }
      .split h3 { margin: 0; font-size: 18px; }
      .split .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .split .metric strong { font-size: 22px; }
      .routes { list-style: none; padding: 0; margin: 20px 0 0; display: grid; gap: 8px; }
      .routes li { border: 1px solid var(--line); border-radius: 8px; padding: 11px 14px; background: var(--panel); color: var(--text); font-size: 14px; }
      .routes .vol { color: var(--muted); }
      .related { list-style: none; padding: 0; margin: 12px 0 0; display: flex; flex-wrap: wrap; gap: 0 20px; }
      .related a { display: inline-flex; align-items: center; min-height: 44px; }
      .source { margin-top: 34px; font-size: 13px; color: var(--muted); }
      table { border-collapse: collapse; width: 100%; margin-top: 16px; font-size: 14px; }
      caption { caption-side: top; text-align: left; color: var(--muted); font-size: 13px; padding-bottom: 8px; }
      th, td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; }
      th { color: var(--muted); font-weight: 600; background: var(--panel); }
      td data { color: var(--text); }
      figure { margin: 20px 0 0; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
      figcaption { margin-top: 10px; color: var(--muted); font-size: 13px; }
      blockquote { margin: 16px 0 0; padding: 12px 16px; border-left: 2px solid var(--accent); background: var(--panel); border-radius: 0 8px 8px 0; }
      blockquote p { margin: 0; color: var(--text); font-size: 14px; }
      footer { border-top: 1px solid var(--line); padding-top: 20px; padding-bottom: 28px; color: var(--muted); font-size: 13px; }
    </style>
  </head>
  <body>
    <header>
      <nav aria-label="Primary">
        <a href="/">World Monitor</a>
        <a href="/countries/">Countries</a>
        <a href="/chokepoints/">Chokepoints</a>
        <a href="/crises/">Crises</a>
        <a href="/tools/">Live tools</a>
        <a href="/research/">Research</a>
        <a href="/reference/changelog/">Changelog</a>
        <a href="/blog/glossary/">Glossary</a>
      </nav>
    </header>
    <main>
${body}
    </main>
    <footer>World Monitor reference corpus. Crawlable pages use committed snapshots; live API results are labelled separately.</footer>
    ${scriptSrcs.map((src) => `<script type="module" nonce="wm-static-bootstrap" src="${escapeHtml(src)}"></script>`).join('\n    ')}
  </body>
</html>
`;
}

function renderCountriesIndex({ countries, baseUrl, capturedAt, lastmod }) {
  const path = '/countries/';
  const description = `Browse ${countries.length} country risk and resilience pages from World Monitor's dated ${capturedAt} structural snapshot, with current instability signals on each page.`;
  const body = `      <p class="eyebrow">Country corpus</p>
      <h1>Country risk and resilience</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <div class="grid">
${countries.map((country) => `        <a class="card" href="/countries/${country.slug}/"><strong>${escapeHtml(country.name)}</strong><br><span>${country.rank == null ? 'Low-confidence listing' : `Rank ${country.rank}`} &middot; ${escapeHtml(country.code)}</span></a>`).join('\n')}
      </div>
      <p class="source">Source: ${RESILIENCE_SNAPSHOT_PATH} (${escapeHtml(prettyDate(capturedAt))}). Methodology: <a href="/docs/methodology/country-resilience-index">Country Resilience Index</a>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Country Risk and Resilience | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Country risk and resilience',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Countries', path },
    ]),
    body,
  });
}

function renderCountryPage({
  country,
  baseUrl,
  capturedAt,
  lastmod,
  methodologyFormula,
  rankedCount,
}) {
  const path = `/countries/${country.slug}/`;
  const description = countryMetaDescription({
    name: country.name,
    rank: country.rank,
    rankedCount,
  });
  const mapUrl = withUtmSource(
    absoluteUrl(baseUrl, `/?country=${encodeURIComponent(country.code)}&expanded=1`),
    'seo-country',
  );
  const body = `      <p class="eyebrow">Country &middot; ${escapeHtml(country.code)}</p>
      <h1>${escapeHtml(country.name)} country risk and resilience</h1>
      <p class="lede">${escapeHtml(description)} The structural snapshot is dated and source-labelled; the current instability tool below loads separately from the live World Monitor API.</p>
      <section class="live-tool" data-live-country-risk data-country-code="${escapeHtml(country.code)}" data-country-name="${escapeHtml(country.name)}" data-state="loading">
        <div class="tool-head">
          <div>
            <p class="eyebrow">Current signal</p>
            <h2>${escapeHtml(country.name)} instability monitor</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">Connecting…</span>
        </div>
        <p class="tool-note">Instability is a fast-moving composite of current information, unrest, armed-conflict and security-mobility signals. It is different from the slower structural resilience snapshot below; the two scores should not be combined.</p>
        <div class="grid" data-live-grid aria-label="Current country instability metrics" aria-busy="true">
          <div class="metric"><span>Instability score</span><strong><span data-live-score>—</span><small data-live-band>Loading</small></strong></div>
          <div class="metric"><span>Approx. 24-hour movement</span><strong data-live-trend>—</strong></div>
          <div class="metric"><span>Travel advisory input</span><strong data-live-advisory>—</strong></div>
          <div class="metric"><span>OFAC designations in feed</span><strong data-live-sanctions>—</strong></div>
        </div>
        <div class="tool-meta">
          <time data-live-updated>Requesting the latest available result…</time>
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <noscript><p>Enable JavaScript to load the current API result. The structural resilience snapshot remains available below.</p></noscript>
      </section>
      <a class="cta" href="${escapeHtml(mapUrl)}">Open ${escapeHtml(country.name)} on the live map →</a>
      <h2>Structural resilience snapshot</h2>
      <section class="grid" aria-label="Country resilience metrics">
        <div class="metric"><span>Rank</span><strong>${escapeHtml(country.rank == null ? 'Not ranked' : `#${country.rank}`)}</strong></div>
        <div class="metric"><span>Overall score</span><strong>${escapeHtml(formatScore(country.overallScore))}</strong></div>
        <div class="metric"><span>Dimension coverage</span><strong>${escapeHtml(formatPercent(country.dimensionCoverage))}</strong></div>
        <div class="metric"><span>Confidence</span><strong>${country.lowConfidence ? 'Low' : 'Standard'}</strong></div>
      </section>
      <h2>How to read this page</h2>
      <p>World Monitor's Country Resilience Index is a 0-100 structural resilience score. This page records the committed ${escapeHtml(prettyDate(capturedAt))} snapshot using the ${escapeHtml(methodologyFormula)} methodology tag. The full scoring approach — dimensions, sources, and confidence rules — is documented in the <a href="/docs/methodology/country-resilience-index">Country Resilience Index methodology</a>.</p>
      <p>Use it as a crawlable reference and stable landing page. For the current live picture — active alerts, conflict events, market and energy signals — open ${escapeHtml(country.name)} on the live map above.</p>
      <p class="source">Source: ${RESILIENCE_SNAPSHOT_PATH}. Captured ${escapeHtml(capturedAt)}. Methodology: <a href="/docs/methodology/country-resilience-index">Country Resilience Index</a>.</p>`;
  const coreTitle = `${country.name} Country Risk and Resilience`;
  return pageDocument({
    baseUrl,
    path,
    // Keep SERP titles near the ~60-char display budget: drop the brand
    // suffix for long country names rather than letting Google truncate
    // mid-brand.
    title: coreTitle.length > 44 ? coreTitle : `${coreTitle} | World Monitor`,
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: `${country.name} country risk and resilience`,
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
      about: {
        '@type': 'Country',
        name: country.name,
        identifier: country.code,
      },
      mainEntity: {
        '@type': 'Dataset',
        name: `World Monitor Country Resilience snapshot for ${country.name}`,
        description: `A dated World Monitor Country Resilience Index snapshot for ${country.name}, with the overall score, rank, dimension coverage, confidence classification, and scoring methodology used for this page.`,
        datePublished: capturedAt,
        measurementTechnique: methodologyFormula,
      },
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Countries', path: '/countries/' },
      { name: country.name, path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
}

function renderChokepointsIndex({ chokepoints, baseUrl, lastmod }) {
  const path = '/chokepoints/';
  const description = `The ${chokepoints.length} maritime chokepoints World Monitor tracks — narrow straits and canals where a disruption removes optionality from global trade, energy and food flows.`;
  const body = `      <p class="eyebrow">Maritime corpus</p>
      <h1>Chokepoints and waterways</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <div class="grid">
${chokepoints.map((cp) => {
    const subtitle = CHOKEPOINT_CONTENT[cp.id]?.region || 'Strategic maritime waterway';
    return `        <a class="card" href="/chokepoints/${cp.slug}/"><strong>${escapeHtml(cp.displayName)}</strong><br><span>${escapeHtml(subtitle)}</span></a>`;
  }).join('\n')}
      </div>
      <h2>Why chokepoints matter</h2>
      <p>A <a href="/blog/glossary/maritime-chokepoint/">maritime chokepoint</a> is a narrow passage with no cheap alternative: when one closes or degrades, ships reroute onto longer, costlier paths and freight, insurance, and energy prices move within days. A small number of straits and canals carry a disproportionate share of the world's seaborne oil, LNG, grain, and container traffic, which is why traders, supply-chain teams, and analysts watch them continuously.</p>
      <h2>How the status badge works</h2>
      <p>Each chokepoint page combines a static reference — what the waterway connects, which modelled trade routes depend on it — with a live disruption score computed from active warnings, AIS signal disruptions, congestion, and transit counts. The score is a monitoring signal, not an operational closure declaration; the <a href="/docs/methodology/chokepoints">chokepoint methodology</a> documents the inputs and bands. Daily transit counts and baselines come from <a href="https://portwatch.imf.org/">IMF PortWatch</a> data.</p>
      <p class="source">Source: ${CHOKEPOINT_REGISTRY_PATH}. Methodology: <a href="/docs/methodology/chokepoints">chokepoint disruption scoring</a>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Maritime Chokepoints | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Maritime chokepoints and waterways',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Chokepoints', path },
    ]),
    body,
  });
}

function renderChokepointPage({ chokepoint, baseUrl, lastmod, tradeRoutesById, researchReports = [] }) {
  const path = `/chokepoints/${chokepoint.slug}/`;
  const content = CHOKEPOINT_CONTENT[chokepoint.id] || {};
  const blurb = content.blurb
    || `${chokepoint.displayName} is one of the 13 canonical maritime chokepoints tracked by World Monitor.`;
  const description = chokepointMetaDescription(chokepoint.displayName);
  const mapUrl = withUtmSource(
    absoluteUrl(baseUrl, `/?chokepoint=${encodeURIComponent(chokepoint.id)}`),
    'seo-chokepoint',
  );

  const routes = chokepoint.routeIds
    .map((id) => tradeRoutesById.get(id))
    .filter(Boolean);
  const routesSection = routes.length
    ? `<ul class="routes">
${routes.map((route) => {
    const category = route.category ? route.category.charAt(0).toUpperCase() + route.category.slice(1) : '';
    return `        <li>${escapeHtml(route.name)} <span class="vol">&middot; ${escapeHtml(route.volumeDesc)}${category ? ` &middot; ${escapeHtml(category)}` : ''}</span></li>`;
  }).join('\n')}
      </ul>`
    : `<p>${escapeHtml(chokepoint.displayName)} is tracked as a strategic waterway reference. It is not currently mapped to one of World Monitor's modelled trade-route corridors, but its vessel traffic and disruption signals are still monitored on the live map.</p>`;

  const tiles = [
    content.region ? metricTile('Connects', content.region) : null,
    metricTile('Position', formatCoordinates(chokepoint.lat, chokepoint.lon)),
    chokepoint.shockModelSupported ? metricTile('Energy shock model', 'Yes') : null,
  ].filter(Boolean).join('\n');

  const relatedItems = [];
  for (const { report } of researchReports) {
    if (report.focusChokepointId === chokepoint.id) {
      relatedItems.push(`<a href="/research/${report.slug}/">${escapeHtml(report.title)}</a>`);
    }
  }
  if (content.glossarySlug) {
    relatedItems.push(`<a href="/blog/glossary/${content.glossarySlug}/">${escapeHtml(chokepoint.displayName)} in the glossary</a>`);
  }
  relatedItems.push('<a href="/blog/glossary/maritime-chokepoint/">What is a maritime chokepoint?</a>');

  const body = `      <p class="eyebrow">Chokepoint</p>
      <h1>${escapeHtml(chokepoint.displayName)}</h1>
      <p class="lede">${escapeHtml(blurb)}</p>
      <section class="live-tool" data-live-chokepoint data-chokepoint-id="${escapeHtml(chokepoint.id)}" data-state="loading">
        <div class="tool-head">
          <div>
            <p class="eyebrow">Current status</p>
            <h2>${escapeHtml(chokepoint.displayName)} disruption pulse</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">Connecting…</span>
        </div>
        <p class="tool-note">The traffic-light badge is a disruption score, not an operational closure declaration. Transit metrics appear only when the current vessel snapshot has coverage.</p>
        <div class="grid" data-live-grid aria-label="Current chokepoint status" aria-busy="true">
          <div class="metric"><span>Disruption score</span><strong><span data-chokepoint-score>—</span><small data-chokepoint-band>Loading</small></strong></div>
          <div class="metric"><span>Congestion</span><strong data-chokepoint-congestion>—</strong></div>
          <div class="metric"><span>Warnings and AIS</span><strong data-chokepoint-warnings>—</strong></div>
          <div class="metric"><span>Today's transits</span><strong data-chokepoint-transits>—</strong></div>
          <div class="metric"><span>Week-over-week movement</span><strong data-chokepoint-movement>—</strong></div>
        </div>
        <p data-chokepoint-description>Requesting the latest available status…</p>
        <div class="tool-meta">
          <time data-live-updated>Requesting the latest available result…</time>
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <noscript><p>Enable JavaScript to load the current API result. The static waterway and route context remains available below.</p></noscript>
      </section>
      <a class="cta" href="${escapeHtml(mapUrl)}">Open ${escapeHtml(chokepoint.displayName)} on the live map →</a>
      <section class="grid" aria-label="Chokepoint overview">
${tiles}
      </section>
      <h2>Major trade routes through ${escapeHtml(chokepoint.displayName)}</h2>
      ${routesSection}
      <h2>Related</h2>
      <ul class="related">
${relatedItems.map((item) => `        <li>${item}</li>`).join('\n')}
      </ul>
      <p class="source">Source: ${CHOKEPOINT_REGISTRY_PATH} and ${TRADE_ROUTES_PATH}. Methodology: <a href="/docs/methodology/chokepoints">how chokepoint disruption is scored</a>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: `${chokepoint.displayName} Chokepoint Status | World Monitor`,
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: `${chokepoint.displayName} chokepoint`,
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
      about: {
        '@type': 'Place',
        name: chokepoint.displayName,
        identifier: chokepoint.id,
        geo: Number.isFinite(chokepoint.lat) && Number.isFinite(chokepoint.lon)
          ? {
              '@type': 'GeoCoordinates',
              latitude: chokepoint.lat,
              longitude: chokepoint.lon,
            }
          : undefined,
      },
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Chokepoints', path: '/chokepoints/' },
      { name: chokepoint.displayName, path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
}

function countrySelectOptions(countryBounds, { includeWorldwide = false, defaultCode = '' } = {}) {
  const worldwide = includeWorldwide
    ? '          <option value="">Worldwide</option>\n'
    : '';
  return worldwide + countryBounds.map((country) => {
    const selected = country.code === defaultCode ? ' selected' : '';
    return `          <option value="${escapeHtml(country.code)}" data-bounds="${escapeHtml(country.bounds.join(','))}"${selected}>${escapeHtml(country.name)}</option>`;
  }).join('\n');
}

function renderCrisesIndex({ crises, baseUrl, lastmod }) {
  const path = '/crises/';
  const description = 'Curated, bounded crisis trackers that combine stable coverage definitions with World Monitor’s maintained country-level humanitarian summaries.';
  const body = `      <p class="eyebrow">Bounded trackers</p>
      <h1>Current crisis trackers</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <p>Each tracker has a fixed, reviewable geographic boundary. The static page explains that boundary; current monthly conflict metrics load separately and fail closed when a country summary is unavailable.</p>
      <div class="grid">
${crises.map((crisis) => `        <a class="card" href="/crises/${escapeHtml(crisis.slug)}/"><strong>${escapeHtml(crisis.shortTitle)}</strong><br><span>${escapeHtml(crisis.coverage.map((country) => country.name).join(', '))}</span></a>`).join('\n')}
      </div>
      <h2>How these trackers are scoped</h2>
      <p>Every tracker names its covered countries up front and never silently widens. Metrics are monthly country-level conflict summaries — recorded events, political-violence events, fatalities, and demonstrations — from the UN OCHA <a href="https://data.humdata.org/hapi">Humanitarian API (HDX HAPI)</a>. A combined total is shown only when every covered country reports the same reference month; otherwise per-country figures stand alone.</p>
      <h2>What they are not</h2>
      <p>These are bounded pulses, not battlefield maps, casualty ledgers, or forecasts. Missing countries are reported as unavailable rather than zero, and event-level context lives in the <a href="/?utm_source=seo-crisis">live dashboard</a> with its map layers and independent signals.</p>
      <p class="source">Scope source: ${CRISIS_REGISTRY_PATH}. Live metrics: HAPI/HDX humanitarian conflict summaries through the World Monitor API.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Current Crisis Trackers | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Current crisis trackers',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Crises', path },
    ]),
    body,
  });
}

function renderCrisisPage({ crisis, baseUrl, lastmod }) {
  const path = `/crises/${crisis.slug}/`;
  const dashboardUrl = withUtmSource(absoluteUrl(baseUrl, crisis.dashboardPath), 'seo-crisis');
  const body = `      <p class="eyebrow">Bounded crisis tracker</p>
      <h1>${escapeHtml(crisis.title)}</h1>
      <p class="lede">${escapeHtml(crisis.description)}</p>
      <p>${escapeHtml(crisis.overview)}</p>
      <section class="live-tool" data-live-crisis data-state="loading">
        <div class="tool-head">
          <div>
            <p class="eyebrow">Latest maintained month</p>
            <h2>Country conflict pulse</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">Connecting…</span>
        </div>
        <p class="tool-note">Metrics are country-level records for the latest available HAPI/HDX reference month. Missing countries are unavailable, not zero. A combined total is withheld when reference periods differ.</p>
        <div class="grid" data-live-grid aria-label="Current crisis metrics" aria-busy="true">
          <div class="metric"><span>Recorded events</span><strong data-crisis-events>—</strong></div>
          <div class="metric"><span>Recorded fatalities</span><strong data-crisis-fatalities>—</strong></div>
          <div class="metric"><span>Political violence events</span><strong data-crisis-political>—</strong></div>
          <div class="metric"><span>Reference period</span><strong data-crisis-period>Loading</strong></div>
        </div>
        <ul class="result-list" aria-label="Country coverage">
${crisis.coverage.map((country) => `          <li data-crisis-country data-country-code="${escapeHtml(country.code)}" data-country-name="${escapeHtml(country.name)}"><strong>${escapeHtml(country.name)}</strong><br><span data-crisis-country-value>Loading…</span></li>`).join('\n')}
        </ul>
        <div class="tool-meta">
          <span data-crisis-coverage>${crisis.coverage.length} ${crisis.coverage.length === 1 ? 'country' : 'countries'} requested</span>
          <time data-live-updated>Requesting the latest available summaries…</time>
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <noscript><p>Enable JavaScript to load current monthly summaries. The tracker scope and methodology remain available on this page.</p></noscript>
      </section>
      <a class="cta" href="${escapeHtml(dashboardUrl)}">Investigate this crisis in World Monitor →</a>
      <h2>Coverage boundary</h2>
      <p>${escapeHtml(crisis.coverage.map((country) => `${country.name} (${country.code})`).join(', '))}. Events outside this list are not included in the live totals on this page.</p>
      <h2>How to read this tracker</h2>
      <p>Use these monthly country summaries as a bounded pulse, then inspect the dashboard for event-level context, map layers, and other independent signals. The figures are not forecasts and should not be interpreted as a complete casualty or incident ledger.</p>
      <p class="source">Scope source: ${CRISIS_REGISTRY_PATH}. Live metrics: HAPI/HDX humanitarian conflict summaries from the UN OCHA <a href="https://data.humdata.org/hapi">Humanitarian API</a>, served through the World Monitor API.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: `${crisis.title} | World Monitor`,
    description: crisis.description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: crisis.title,
      description: crisis.description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
      about: crisis.coverage.map((country) => ({
        '@type': 'Country',
        name: country.name,
        identifier: country.code,
      })),
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Crises', path: '/crises/' },
      { name: crisis.shortTitle, path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
}

function renderToolsIndex({ baseUrl, lastmod }) {
  const path = '/tools/';
  const description = 'Focused World Monitor tools for current natural hazards and country-level airspace disruption, backed by maintained first-party data contracts.';
  const body = `      <p class="eyebrow">Live intelligence tools</p>
      <h1>Check a current operational signal</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <div class="grid">
        <a class="card" href="/tools/natural-hazard-pulse/"><strong>Natural-hazard pulse</strong><br><span>Worldwide or approximate country filter</span></a>
        <a class="card" href="/tools/airspace-disruption-checker/"><strong>Airspace-disruption checker</strong><br><span>Commercial airport disruption and observed military flights</span></a>
        <a class="card" href="/chokepoints/"><strong>Maritime chokepoint status</strong><br><span>13 canonical waterways</span></a>
        <a class="card" href="/crises/"><strong>Bounded crisis trackers</strong><br><span>Four curated geographic scopes</span></a>
      </div>
      <h2>How these tools work</h2>
      <p>Each tool asks one narrow operational question — what natural hazards are open right now, is a country's monitored airspace disrupted — and answers it from a maintained World Monitor API contract. Results are labelled with their source and retrieval time, unavailable data is reported as unavailable rather than zero, and independent signals are never combined into a single opaque threat score.</p>
      <h2>When to use them</h2>
      <p>Use these pages for a fast, shareable check before a trip, a shipment, or a market open; use the <a href="/?utm_source=seo-tool">live dashboard</a> when you need the full picture — map layers, alerts, news, and country briefs side by side. Hazard coverage is documented in <a href="/docs/natural-disasters">natural disaster tracking</a>; chokepoint scoring in the <a href="/docs/methodology/chokepoints">chokepoint methodology</a>.</p>
      <p class="source">Live results load from maintained World Monitor API contracts. Static route descriptions remain available if a current source cannot be reached.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Live Intelligence Tools | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Live intelligence tools',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Live tools', path },
    ]),
    body,
  });
}

function renderHazardPage({ countryBounds, baseUrl, lastmod }) {
  const path = '/tools/natural-hazard-pulse/';
  const description = 'See which natural hazards are active right now — earthquakes, storms, wildfires and floods from EONET, GDACS, NHC and HKO feeds — worldwide or filtered to one country.';
  const body = `      <p class="eyebrow">Natural-hazard pulse</p>
      <h1>What natural hazards are active now?</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <p>The country selector is an approximate geographic filter, not a territorial polygon. Coastal and border events can overlap neighbouring countries. Countries with oversized or discontinuous envelopes are omitted so every country query remains bounded. Agency observations and wind averaging periods remain distinct.</p>
      <section class="live-tool" data-natural-hazard-tool data-state="loading">
        <div class="tool-head">
          <div>
            <p class="eyebrow">Current source snapshot</p>
            <h2>Open event pulse</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">Connecting…</span>
        </div>
        <div class="tool-controls">
          <label>Geographic filter
            <select data-country-select>
${countrySelectOptions(countryBounds, { includeWorldwide: true })}
            </select>
          </label>
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <div class="grid" data-live-grid aria-label="Current natural hazard metrics" aria-busy="true">
          <div class="metric"><span>Open matches</span><strong data-hazard-total>—</strong></div>
          <div class="metric"><span>Categories</span><strong data-hazard-categories>Loading</strong></div>
          <div class="metric"><span>Strongest reported magnitude</span><strong data-hazard-strongest>—</strong></div>
          <div class="metric"><span>Most recent event</span><strong data-hazard-latest>—</strong></div>
        </div>
        <ul class="result-list" data-hazard-list aria-label="Recent matching natural events"><li>Loading current events…</li></ul>
        <div class="tool-meta"><time data-live-updated>Requesting the latest available snapshot…</time></div>
        <noscript><p>Enable JavaScript to load and filter the current event snapshot. This page still documents the tool’s coverage and sources.</p></noscript>
      </section>
      <a class="cta" data-dashboard-link href="${escapeHtml(withUtmSource(absoluteUrl(baseUrl, '/'), 'seo-tool'))}">Open the selected area in World Monitor →</a>
      <h2>Sources and limits</h2>
      <p>World Monitor reads its seeded natural-event snapshot from maintained <a href="https://eonet.gsfc.nasa.gov/">NASA EONET</a>, <a href="https://www.gdacs.org/">GDACS</a>, <a href="https://www.nhc.noaa.gov/">NHC</a>, and <a href="https://www.hko.gov.hk/">HKO</a> ingestion paths. Source names are retained on individual events. A zero is shown only when a source snapshot is explicitly available; unavailable snapshots fail closed. Coverage and update cadence are documented in <a href="/docs/natural-disasters">natural disaster tracking</a>.</p>
      <p class="source">Geographic filters: ${COUNTRY_BBOXES_PATH}. Live metrics: <code>/api/natural/v1/list-natural-events</code>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Live Natural Hazard Tracker | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'World Monitor natural-hazard pulse',
      description,
      url: absoluteUrl(baseUrl, path),
      applicationCategory: 'DataApplication',
      operatingSystem: 'Any',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Live tools', path: '/tools/' },
      { name: 'Natural-hazard pulse', path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
}

function renderAirspacePage({ countryBounds, baseUrl, lastmod }) {
  const path = '/tools/airspace-disruption-checker/';
  const description = 'Check monitored commercial-airport disruption and bounded observed military-flight activity for one country without combining the signals into a threat score.';
  const body = `      <p class="eyebrow">Airspace-disruption checker</p>
      <h1>Check a country’s airspace signals</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <p>Commercial disruption and observed military aircraft are independent evidence domains. Aircraft presence does not establish mission, intent, or danger. Airport coverage is limited to monitored hubs.</p>
      <section class="live-tool" data-airspace-tool data-state="loading">
        <div class="tool-head">
          <div>
            <p class="eyebrow">Country bounding-box check</p>
            <h2>Commercial and observed activity</h2>
          </div>
          <span class="live-status" data-live-status role="status" aria-live="polite">Connecting…</span>
        </div>
        <div class="tool-controls">
          <label>Country
            <select data-country-select>
${countrySelectOptions(countryBounds, { defaultCode: 'JP' })}
            </select>
          </label>
          <button class="refresh" type="button" data-live-refresh disabled>Refresh live data</button>
        </div>
        <div class="split" data-live-grid aria-busy="true">
          <section>
            <p class="eyebrow">Commercial operations</p>
            <h3>Monitored airports</h3>
            <p data-airport-state>Loading source coverage…</p>
            <div class="grid">
              <div class="metric"><span>Monitored in box</span><strong data-airport-monitored>—</strong></div>
              <div class="metric"><span>Disrupted</span><strong data-airport-disrupted>—</strong></div>
              <div class="metric"><span>Normal coverage</span><strong data-airport-normal>—</strong></div>
              <div class="metric"><span>Unknown coverage</span><strong data-airport-unknown>—</strong></div>
            </div>
            <ul class="result-list" data-airport-list aria-label="Current airport disruptions"><li>Loading airport coverage…</li></ul>
            <time data-airport-updated>Requesting monitored-airport data…</time>
          </section>
          <section>
            <p class="eyebrow">Observed activity</p>
            <h3>Military-flight returns</h3>
            <p data-military-state>Loading bounded observations…</p>
            <div class="grid">
              <div class="metric"><span>Returned aircraft</span><strong data-military-returned>—</strong></div>
              <div class="metric"><span>Flagged interesting</span><strong data-military-interesting>—</strong></div>
            </div>
            <ul class="result-list" data-military-list aria-label="Recent returned military flights"><li>Loading returned observations…</li></ul>
            <time data-military-updated>Requesting bounded flight observations…</time>
          </section>
        </div>
        <p class="tool-note">Military results are capped at 100 returned observations for the selected box. Countries with oversized or discontinuous envelopes are omitted so the tool never issues a continent-scale observation query. An empty or failed military response is unavailable, not confirmed zero activity.</p>
        <noscript><p>Enable JavaScript to check the selected country. The independent-source methodology and limitations remain available on this page.</p></noscript>
      </section>
      <a class="cta" data-dashboard-link href="${escapeHtml(withUtmSource(absoluteUrl(baseUrl, '/?country=JP&expanded=1'), 'seo-tool'))}">Investigate the selected country in World Monitor →</a>
      <h2>How to read the result</h2>
      <p>“Normal” applies only to monitored airports with current source coverage. “Unknown” means telemetry was not available and is not counted as normal. Military-flight results are bounded observations from OpenSky/Wingbits-compatible ingestion and are not exhaustive.</p>
      <p class="source">Geographic filters: ${COUNTRY_BBOXES_PATH}. Live metrics: <code>/api/aviation/v1/list-airport-delays</code> and <code>/api/military/v1/list-military-flights</code>.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Airspace-Disruption Checker | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'World Monitor airspace-disruption checker',
      description,
      url: absoluteUrl(baseUrl, path),
      applicationCategory: 'DataApplication',
      operatingSystem: 'Any',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Live tools', path: '/tools/' },
      { name: 'Airspace-disruption checker', path },
    ]),
    body,
    scriptSrcs: ['/tools/live-tools.js'],
  });
}

function chunk(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function changelogPagePath(index) {
  return index === 0 ? '/reference/changelog/' : `/reference/changelog/page/${index + 1}/`;
}

function renderChangelogPage({ releases, pageIndex, totalPages, baseUrl, lastmod }) {
  const path = changelogPagePath(pageIndex);
  const paginationLinks = [
    pageIndex > 0 ? { rel: 'prev', path: changelogPagePath(pageIndex - 1) } : null,
    pageIndex + 1 < totalPages ? { rel: 'next', path: changelogPagePath(pageIndex + 1) } : null,
  ].filter(Boolean);
  const title = pageIndex === 0
    ? 'World Monitor Changelog | World Monitor'
    : `World Monitor Changelog Page ${pageIndex + 1} | World Monitor`;
  const description = 'Paginated release notes for World Monitor — new panels, data sources, API changes and fixes — built from the committed CHANGELOG.md so every release is crawlable.';
  const body = `      <p class="eyebrow">Release notes</p>
      <h1>World Monitor changelog</h1>
      <p class="lede">${escapeHtml(description)}</p>
${releases.map((release) => `      <article class="card">
        <h2>${escapeHtml(release.label)}${release.date ? ` <small>${escapeHtml(release.date)}</small>` : ''}</h2>
        ${release.headings.length ? `<p>${escapeHtml(release.headings.join(' / '))}</p>` : ''}
        <ul>
${release.bullets.map((bullet) => `          <li>${escapeHtml(bullet)}</li>`).join('\n')}
        </ul>
      </article>`).join('\n')}
      <nav class="grid" aria-label="Changelog pagination">
        ${pageIndex > 0 ? `<a class="card" href="${changelogPagePath(pageIndex - 1)}">Previous page</a>` : ''}
        ${pageIndex + 1 < totalPages ? `<a class="card" href="${changelogPagePath(pageIndex + 1)}">Next page</a>` : ''}
      </nav>
      <p class="source">Source: ${CHANGELOG_PATH}. Page ${pageIndex + 1} of ${totalPages}.</p>`;
  return pageDocument({
    baseUrl,
    path,
    title,
    description,
    lastmod,
    paginationLinks,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'World Monitor changelog',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
      isPartOf: {
        '@type': 'CreativeWorkSeries',
        name: 'World Monitor release notes',
      },
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Changelog', path: '/reference/changelog/' },
    ]),
    body,
  });
}

function writeGeneratedFile(outDir, relativePath, content) {
  const target = join(outDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function routeFile(pathname) {
  const withoutLeading = pathname.replace(/^\/+/, '');
  return join(withoutLeading, 'index.html');
}

function buildManifest({ data, baseUrl, changelogPageCount }) {
  const countryRoutes = data.countries.map((country) => `/countries/${country.slug}/`);
  const chokepointRoutes = data.chokepoints.map((chokepoint) => `/chokepoints/${chokepoint.slug}/`);
  const crisisRoutes = data.crises.map((crisis) => `/crises/${crisis.slug}/`);
  const toolRoutes = [
    '/tools/natural-hazard-pulse/',
    '/tools/airspace-disruption-checker/',
  ];
  const changelogRoutes = Array.from({ length: changelogPageCount }, (_, index) => changelogPagePath(index));
  const glossaryRoutes = data.glossaryTerms.map((term) => `/blog/glossary/${term.slug}/`);
  const researchRoutes = data.researchReports.map(({ report }) => `/research/${report.slug}/`);
  return {
    schemaVersion: 1,
    baseUrl: normalizeBaseUrl(baseUrl),
    generatorContentVersion: data.generatorContentVersion,
    sources: data.sources,
    sections: {
      countries: {
        count: countryRoutes.length,
        index: '/countries/',
        routes: countryRoutes,
        sourceCapturedAt: data.resilience.capturedAt,
      },
      chokepoints: {
        count: chokepointRoutes.length,
        index: '/chokepoints/',
        routes: chokepointRoutes,
      },
      crises: {
        count: crisisRoutes.length,
        index: '/crises/',
        routes: crisisRoutes,
      },
      tools: {
        count: toolRoutes.length,
        index: '/tools/',
        routes: toolRoutes,
      },
      changelog: {
        count: changelogRoutes.length,
        index: '/reference/changelog/',
        routes: changelogRoutes,
        sourceLastmod: data.lastmod.changelog,
      },
      research: {
        count: researchRoutes.length,
        index: '/research/',
        routes: researchRoutes,
      },
      glossary: {
        count: glossaryRoutes.length,
        index: '/blog/glossary/',
        routes: glossaryRoutes,
        generatedBy: 'blog-site Astro build',
      },
    },
  };
}

export async function buildCorpus({
  rootDir = DEFAULT_ROOT,
  outDir = DEFAULT_OUT_DIR,
  baseUrl = DEFAULT_BASE_URL,
  clean = true,
} = {}) {
  const data = await loadCorpusData({ rootDir });
  if (clean) {
    for (const dir of GENERATED_DIRS) {
      rmSync(join(outDir, dir), { recursive: true, force: true });
    }
  }

  writeGeneratedFile(
    outDir,
    'countries/index.html',
    renderCountriesIndex({
      countries: data.countries,
      baseUrl,
      capturedAt: data.resilience.capturedAt,
      lastmod: data.lastmod.countries,
    }),
  );
  const rankedCount = data.countries.filter((country) => country.rank != null).length;
  for (const country of data.countries) {
    writeGeneratedFile(
      outDir,
      routeFile(`/countries/${country.slug}/`),
      renderCountryPage({
        country,
        baseUrl,
        capturedAt: data.resilience.capturedAt,
        lastmod: data.lastmod.countries,
        methodologyFormula: data.resilience.methodologyFormula || 'unknown',
        rankedCount,
      }),
    );
  }

  writeGeneratedFile(
    outDir,
    'chokepoints/index.html',
    renderChokepointsIndex({
      chokepoints: data.chokepoints,
      baseUrl,
      lastmod: data.lastmod.chokepoints,
    }),
  );
  for (const chokepoint of data.chokepoints) {
    writeGeneratedFile(
      outDir,
      routeFile(`/chokepoints/${chokepoint.slug}/`),
      renderChokepointPage({
        chokepoint,
        baseUrl,
        lastmod: data.lastmod.chokepoints,
        tradeRoutesById: data.tradeRoutesById,
        researchReports: data.researchReports,
      }),
    );
  }

  writeResearchSection({
    data,
    outDir,
    baseUrl,
    tpl: { escapeHtml, absoluteUrl, breadcrumbLd, withUtmSource, pageDocument },
  });

  writeGeneratedFile(
    outDir,
    'tools/live-tools.js',
    readText(rootDir, LIVE_TOOLS_SCRIPT_PATH),
  );
  writeGeneratedFile(
    outDir,
    'tools/index.html',
    renderToolsIndex({
      baseUrl,
      lastmod: data.lastmod.tools,
    }),
  );
  writeGeneratedFile(
    outDir,
    'tools/natural-hazard-pulse/index.html',
    renderHazardPage({
      countryBounds: data.countryBounds,
      baseUrl,
      lastmod: data.lastmod.tools,
    }),
  );
  writeGeneratedFile(
    outDir,
    'tools/airspace-disruption-checker/index.html',
    renderAirspacePage({
      countryBounds: data.countryBounds,
      baseUrl,
      lastmod: data.lastmod.tools,
    }),
  );

  writeGeneratedFile(
    outDir,
    'crises/index.html',
    renderCrisesIndex({
      crises: data.crises,
      baseUrl,
      lastmod: data.lastmod.crises,
    }),
  );
  for (const crisis of data.crises) {
    writeGeneratedFile(
      outDir,
      routeFile(`/crises/${crisis.slug}/`),
      renderCrisisPage({
        crisis,
        baseUrl,
        lastmod: data.lastmod.crises,
      }),
    );
  }

  const changelogPages = chunk(data.changelog, CHANGELOG_PAGE_SIZE);
  changelogPages.forEach((releases, pageIndex) => {
    writeGeneratedFile(
      outDir,
      routeFile(changelogPagePath(pageIndex)),
      renderChangelogPage({
        releases,
        pageIndex,
        totalPages: changelogPages.length,
        baseUrl,
        lastmod: data.lastmod.changelog,
      }),
    );
  });

  const manifest = buildManifest({
    data,
    baseUrl,
    changelogPageCount: changelogPages.length,
  });
  writeGeneratedFile(outDir, 'crawlable-corpus.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(argv) {
  const options = {
    rootDir: DEFAULT_ROOT,
    outDir: DEFAULT_OUT_DIR,
    baseUrl: DEFAULT_BASE_URL,
    clean: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-clean') {
      options.clean = false;
    } else if (arg === '--out-dir') {
      options.outDir = resolve(argv[++i]);
    } else if (arg.startsWith('--out-dir=')) {
      options.outDir = resolve(arg.slice('--out-dir='.length));
    } else if (arg === '--root-dir') {
      options.rootDir = resolve(argv[++i]);
    } else if (arg.startsWith('--root-dir=')) {
      options.rootDir = resolve(arg.slice('--root-dir='.length));
    } else if (arg === '--base-url') {
      options.baseUrl = argv[++i];
    } else if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await buildCorpus(options);
  process.stdout.write(
    `Wrote crawlable corpus: ${manifest.sections.countries.count} countries, `
    + `${manifest.sections.chokepoints.count} chokepoints, `
    + `${manifest.sections.crises.count} crisis trackers, `
    + `${manifest.sections.tools.count} live tools, `
    + `${manifest.sections.research.count} research reports, `
    + `${manifest.sections.changelog.count} changelog pages. `
    + `Glossary manifest references ${manifest.sections.glossary.count} existing blog pages.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
