import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { PassTier } from '../../shared/orbital/tiers.js';
import type { PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import type { EvidenceProgress, MatchedAcquisition, OrbitalEvidence } from '@/services/orbital/match';
import type { ArchiveId } from '@/services/orbital/archive-result';
import { GIBS_DAILY_MOSAICS, type DailyMosaicRow, type GeostationaryRow } from '@/services/orbital/archive-gibs';
import { DEFAULT_CROP_HALF_SIZE_KM } from '@/services/orbital/crop-url';
import { normalisePlatform } from '@/services/orbital/archive-stac';
import { getCurrentLanguageTag, t } from '@/services/i18n';
import { declareOverlay } from '@/utils/open-modal';
import { isAllowedPreviewUrl } from '@/utils/imagery-preview';
import { h, replaceChildren, type DomChild } from '@/utils/dom-utils';
import { placeTimeZone, placeTimeZoneLabel, zoneAbbreviation, type PlaceTimeZone } from '@/utils/place-time-zone';
import '../styles/orbital-tokens.css';
import '../styles/orbital-watch.css';

export type ArchiveState =
  | { kind: 'checking'; total: number; progress: EvidenceProgress | null }
  | { kind: 'answered'; evidence: OrbitalEvidence };

export type OrbitalWatchState =
  | { kind: 'idle' }
  | { kind: 'computing'; done: number; total: number }
  | { kind: 'unavailable' }
  | { kind: 'passes'; lookup: PointPassLookup; archives: ArchiveState };

export type OrbitalView = 'sheet' | 'full';

/** Empty mount points other surfaces fill: place search, the timeline dock, the pass detail, the replay HUD and the time-lapse entry. */
export type OrbitalSlot = 'search' | 'timeline' | 'pass-detail' | 'replay-hud' | 'timelapse';

export interface OrbitalWatchPageCallbacks {
  onClose: () => void;
  onRetry: () => void;
  onViewChange?: (view: OrbitalView) => void;
  onChangePlace?: () => void;
  /** Copies the share link; without it the button copies the live point. */
  onShare?: (button: HTMLElement) => void;
}

/** One glyph per evidence tier, used everywhere a tier is drawn. */
export type TierGlyph = 'watched' | 'likely' | 'could' | 'overhead' | 'weather';

export const TIER_GLYPH_CHAR: Record<TierGlyph, string> = {
  watched: '◆',
  likely: '◇',
  could: '□',
  overhead: '+',
  weather: '○',
};

export const GLYPH_OF_TIER: Record<PassTier['kind'], TierGlyph> = {
  'confirmed-image': 'watched',
  'likely-imaged': 'likely',
  'within-reach': 'could',
  'capability-overhead': 'could',
  'passed-overhead': 'overhead',
  opportunity: 'overhead',
  'daily-mosaic': 'weather',
};

type GroupId = 'watched' | 'likely' | 'upcoming' | 'could' | 'overhead' | 'weather';

interface GroupSpec {
  id: GroupId;
  glyph: TierGlyph;
  expanded: boolean;
  order: 'closest' | 'newest' | 'soonest';
}

const GROUPS: readonly GroupSpec[] = [
  { id: 'watched', glyph: 'watched', expanded: true, order: 'closest' },
  { id: 'likely', glyph: 'likely', expanded: true, order: 'newest' },
  { id: 'upcoming', glyph: 'overhead', expanded: true, order: 'soonest' },
  { id: 'could', glyph: 'could', expanded: false, order: 'newest' },
  { id: 'overhead', glyph: 'overhead', expanded: false, order: 'newest' },
  { id: 'weather', glyph: 'weather', expanded: false, order: 'newest' },
];

const GROUP_OF_TIER: Record<PassTier['kind'], GroupId> = {
  'confirmed-image': 'watched',
  'likely-imaged': 'likely',
  opportunity: 'upcoming',
  'within-reach': 'could',
  'capability-overhead': 'could',
  'passed-overhead': 'overhead',
  'daily-mosaic': 'weather',
};

const TIER_LABEL_KEY: Record<PassTier['kind'], string> = {
  'confirmed-image': 'orbitalWatch.tier.confirmed',
  'likely-imaged': 'orbitalWatch.tier.likely',
  opportunity: 'orbitalWatch.tier.opportunity',
  'daily-mosaic': 'orbitalWatch.tier.dailyMosaic',
  'within-reach': 'orbitalWatch.tier.withinReach',
  'capability-overhead': 'orbitalWatch.tier.capabilityOverhead',
  'passed-overhead': 'orbitalWatch.tier.passedOverhead',
};

const GRID: ReadonlyArray<{ id: GroupId; glyph: TierGlyph; key: string }> = [
  { id: 'watched', glyph: 'watched', key: 'watched' },
  { id: 'likely', glyph: 'likely', key: 'likely' },
  { id: 'could', glyph: 'could', key: 'could' },
  { id: 'overhead', glyph: 'overhead', key: 'overhead' },
];

const ARCHIVE_NAME: Record<ArchiveId, string> = {
  'earth-search': 'Earth Search',
  'planetary-computer': 'Microsoft Planetary Computer',
  'nasa-gibs': 'NASA GIBS',
  eumetsat: 'EUMETSAT',
};

const ARCHIVE_HOST: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)planetarycomputer\.microsoft\.com$/, 'Planetary Computer'],
  [/(^|\.)element84\.com$|amazonaws\.com$/, 'Earth Search'],
  [/(^|\.)gibs\.earthdata\.nasa\.gov$/, 'NASA GIBS'],
  [/(^|\.)eumetsat\.int$/, 'EUMETSAT'],
];

/** Credit lines the archives ask for, worded as in the source attribution manifest. */
export const IMAGE_CREDIT = {
  copernicus: (year: number) => `Contains modified Copernicus Sentinel data ${year}`,
  usgs: 'Landsat imagery courtesy of the U.S. Geological Survey',
  eumetsat: 'Contains EUMETSAT Meteosat imagery',
  gibs: 'NASA GIBS / EOSDIS',
  gibsAcknowledgement: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
} as const;

const acquisitionCredit = (acquisition: MatchedAcquisition) =>
  acquisition.profileId === 'landsat' ? IMAGE_CREDIT.usgs : IMAGE_CREDIT.copernicus(new Date(acquisition.startMs).getUTCFullYear());

interface RowCredit {
  short: string;
  full: string;
}

const acquisitionRowCredit = (acquisition: MatchedAcquisition): RowCredit => ({
  short: acquisition.profileId === 'landsat' ? 'USGS / Landsat' : `© Copernicus Sentinel ${new Date(acquisition.startMs).getUTCFullYear()}`,
  full: acquisitionCredit(acquisition),
});

/** Set on the body while the full view owns the screen, so the dashboard's own chrome steps aside. */
const FULL_VIEW_BODY_CLASS = 'orbital-full-view';

const frameCredit = (archive: ArchiveId): RowCredit => (archive === 'eumetsat'
  ? { short: '© EUMETSAT', full: IMAGE_CREDIT.eumetsat }
  : { short: IMAGE_CREDIT.gibs, full: IMAGE_CREDIT.gibsAcknowledgement });

const EARTH_RADIUS_KM = 6371;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CROP_WIDTH_KM = DEFAULT_CROP_HALF_SIZE_KM * 2;
const SCALE_BAR_KM = 2;
const MOSAIC_RESOLUTION_M = new Map(GIBS_DAILY_MOSAICS.map((layer) => [layer.layer, Number.parseInt(layer.matrixSet, 10)]));

const passKey = (pass: { noradId: number; timeMs: number }) => `${pass.noradId}:${pass.timeMs}`;

/** Angle off straight down at which the satellite sees the point. */
function offNadirDeg(pass: PointPass): number {
  const ratio = (EARTH_RADIUS_KM / (EARTH_RADIUS_KM + pass.altitudeKm)) * Math.cos((pass.elevationDeg * Math.PI) / 180);
  return (Math.asin(Math.min(1, ratio)) * 180) / Math.PI;
}

/** Where the sun is straight overhead, from the low-precision solar position. */
export function subSolarPoint(ms: number): GeoPoint {
  const rad = Math.PI / 180;
  const d = ms / DAY_MS - 10957.5;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const lambda = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const epsilon = (23.439 - 0.00000036 * d) * rad;
  const rightAscension = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)) / rad;
  const declination = Math.asin(Math.sin(epsilon) * Math.sin(lambda)) / rad;
  const gmstDeg = (18.697374558 + 24.06570982441908 * d) * 15;
  const lon = ((((rightAscension - gmstDeg) % 360) + 540) % 360) - 180;
  return { lat: declination, lon };
}

const lang = () => getCurrentLanguageTag();
// Typed locally: the project's `lib` predates ES2021, where ListFormat was added.
type ListFormatCtor = new (locale: string, options: { type: 'conjunction' }) => { format(items: readonly string[]): string };
function formatList(items: string[]): string {
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatCtor }).ListFormat;
  try {
    if (ListFormat) return new ListFormat(lang(), { type: 'conjunction' }).format(items);
  } catch {
    // Unsupported locale: fall through.
  }
  return items.join(', ');
}
const formatInt = (value: number) => new Intl.NumberFormat(lang()).format(value);

function formatPoint({ lat, lon }: GeoPoint, decimals = 3): string {
  return `${Math.abs(lat).toFixed(decimals)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(decimals)}°${lon >= 0 ? 'E' : 'W'}`;
}

/** The first two parts of a searched name ("Palm Jumeirah, Dubai"), which fit the header; the full name is its tooltip. */
function shortPlaceName(name: string): string {
  return name.split(',').slice(0, 2).map((part) => part.trim()).join(', ');
}

/** The zone every displayed time uses, so the whole sheet can switch to the point's local time at once. */
let displayZone = { timeZone: 'UTC', label: 'UTC' };

/** Sets the IANA zone and its short label that every displayed time uses. */
export function setOrbitalDisplayZone(timeZone: string, label: string): void {
  displayZone = { timeZone, label };
}

/** The zone the sheet shows times in, for surfaces that label their own times (the timeline header). */
export function getOrbitalDisplayZone(): { timeZone: string; label: string } {
  return displayZone;
}

/** Formats a time in the display zone: weekday and date, date, clock, both with the zone label, or date and clock. */
export function formatOrbitalTime(ms: number, style: 'day' | 'date' | 'clock' | 'when' | 'stamp'): string {
  const { timeZone, label } = displayZone;
  const day = () => new Intl.DateTimeFormat(lang(), { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(ms);
  const clock = () => new Intl.DateTimeFormat(lang(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(ms);
  switch (style) {
    case 'day': return day();
    case 'date': return new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short', timeZone }).format(ms);
    case 'clock': return clock();
    // The abbreviation follows the moment shown, so a pass across a daylight-saving change reads right.
    case 'when': return `${day()} · ${clock()} ${timeZone === 'UTC' ? label : zoneAbbreviation(timeZone, ms)}`;
    case 'stamp': return `${formatOrbitalTime(ms, 'date')} ${clock()}`;
  }
}

const formatDay = (ms: number) => formatOrbitalTime(ms, 'day');
const formatWhen = (ms: number) => formatOrbitalTime(ms, 'when');

function formatUtcClock(ms: number): string {
  return new Intl.DateTimeFormat(lang(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(ms);
}

function formatRelative(ms: number, nowMs: number, style: Intl.RelativeTimeFormatStyle = 'long'): string {
  const diff = ms - nowMs;
  const abs = Math.abs(diff);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = abs < HOUR_MS ? [Math.round(diff / 60_000), 'minute']
    : abs < DAY_MS ? [Math.round(diff / HOUR_MS), 'hour']
    : [Math.round(diff / DAY_MS), 'day'];
  return new Intl.RelativeTimeFormat(lang(), { numeric: 'always', style }).format(value, unit);
}

function formatAge(days: number): string {
  const [value, unit] = days < 1 ? [Math.max(1, Math.round(days * 24)), 'hour'] : [Math.round(days), 'day'];
  return new Intl.NumberFormat(lang(), { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}

function archiveOfUrl(url: string | null): string {
  if (!url) return '';
  try {
    const host = new URL(url).hostname;
    return ARCHIVE_HOST.find(([pattern]) => pattern.test(host))?.[1] ?? host;
  } catch {
    return '';
  }
}

const sensorName = (platform: string) => platform.toUpperCase();

function conditionLabel(acquisition: MatchedAcquisition): string {
  const pct = acquisition.cloudCoverPct === null ? null : Math.round(acquisition.cloudCoverPct);
  switch (acquisition.condition) {
    case 'clear': return t('orbitalWatch.ui.caption.clear');
    case 'cloud': return t('orbitalWatch.ui.caption.clouded', { pct: pct ?? 100 });
    case 'cloud-shadow': return t('orbitalWatch.ui.caption.cloudShadow');
    case 'not-applicable': return t('orbitalWatch.ui.caption.radar');
    case 'unknown': return pct === null ? t('orbitalWatch.ui.caption.spotNotChecked') : t('orbitalWatch.ui.caption.sceneCloud', { pct });
  }
}

type TileSize = 'hero' | 'thumb';

/** An image with a visible state at every moment: a labelled skeleton, the image, or a failure tile with retry. */
function imageTile(url: string | null, alt: string, sensor: string, size: TileSize, overlays: DomChild[] = []): HTMLElement {
  const archive = archiveOfUrl(url);
  if (!url || !isAllowedPreviewUrl(url)) {
    return h('div', { className: `ow-tile ow-tile-${size}`, dataset: { state: 'none' } },
      h('span', { className: 'ow-tile-status ow-label' }, size === 'hero' ? t('orbitalWatch.ui.tile.noPreview') : TIER_GLYPH_CHAR.watched));
  }
  const status = h('span', { className: 'ow-tile-status ow-label' }, size === 'hero' ? sensor : '');
  const img = h('img', {
    src: url,
    alt,
    loading: size === 'hero' ? 'eager' : 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
    onLoad: () => { tile.dataset.state = 'loaded'; },
    onError: () => {
      tile.dataset.state = 'failed';
      replaceChildren(status,
        size === 'hero' ? t('orbitalWatch.ui.tile.failed', { archive: archive.toUpperCase() }) : '!',
        size === 'hero' ? h('button', { type: 'button', className: 'ow-tile-retry', dataset: { action: 'retry-image' } }, t('countryBrief.retryBtn')) : null);
    },
  }) as HTMLImageElement;
  const tile = h('div', { className: `ow-tile ow-tile-${size}`, dataset: { state: 'loading', sensor } }, img, status, ...overlays);
  return tile;
}

function heroOverlays(): DomChild[] {
  return [
    h('span', { className: 'ow-reticle', 'aria-hidden': 'true' }),
    h('span', { className: 'ow-scale ow-label', 'aria-hidden': 'true' },
      h('span', { className: 'ow-scale-bar', style: `width: ${((SCALE_BAR_KM / CROP_WIDTH_KM) * 100).toFixed(2)}%` }),
      `${SCALE_BAR_KM} KM`),
    h('span', { className: 'ow-north ow-label', 'aria-hidden': 'true' }, '▲ N'),
  ];
}

interface ImageCard {
  key: string;
  tab: 'detailed' | 'weather' | 'radar';
  sensor: string;
  url: string | null;
  sortMs: number;
  top: string;
  bottom: string;
  credit: RowCredit;
  pass: { noradId: number; timeMs: number } | null;
}

type Tab = 'all' | ImageCard['tab'];
const TABS: readonly Tab[] = ['all', 'detailed', 'weather', 'radar'];

function acquisitionCard(acquisition: MatchedAcquisition, nowMs: number, names: Map<string, string>): ImageCard {
  const sensor = (acquisition.pass ? names.get(passKey(acquisition.pass)) : null) ?? sensorName(acquisition.platform);
  const radar = acquisition.profileId === 'sentinel-1';
  const resolution = `${acquisition.resolutionM} M`;
  return {
    key: `image:${acquisition.key}`,
    tab: radar ? 'radar' : 'detailed',
    sensor,
    url: acquisition.imageUrl,
    sortMs: acquisition.startMs,
    top: `${sensor} · ${formatWhen(acquisition.startMs)}`,
    bottom: [
      acquisition.pass ? null : t('orbitalWatch.ui.archiveScene'),
      ...(radar ? [t('orbitalWatch.ui.caption.radar'), 'VV', resolution, formatRelative(acquisition.startMs, nowMs, 'narrow')]
        : [resolution, formatRelative(acquisition.startMs, nowMs, 'narrow'), conditionLabel(acquisition)]),
    ].filter(Boolean).join(' · '),
    credit: acquisitionRowCredit(acquisition),
    pass: acquisition.pass,
  };
}

function weatherCards(evidence: OrbitalEvidence): ImageCard[] {
  const cards: ImageCard[] = [];
  for (const mosaic of evidence.mosaics) {
    const latest = mosaic.days.find((day) => day.imageUrl) ?? null;
    if (!latest) continue;
    const ms = Date.parse(latest.date);
    const resolution = MOSAIC_RESOLUTION_M.get(mosaic.layer);
    cards.push({
      key: `mosaic:${mosaic.source}`,
      tab: 'weather',
      sensor: mosaic.source.toUpperCase(),
      url: latest.imageUrl,
      sortMs: ms,
      top: `${mosaic.source.toUpperCase()} · ${formatDay(ms)}`,
      bottom: [t('orbitalWatch.ui.caption.dailyMosaic'), resolution ? `${resolution} M` : null].filter(Boolean).join(' · '),
      credit: { short: IMAGE_CREDIT.gibs, full: IMAGE_CREDIT.gibs },
      pass: null,
    });
  }
  for (const frame of evidence.frames) {
    if (!frame.latest?.imageUrl) continue;
    const ms = Date.parse(frame.latest.time);
    cards.push({
      key: `frame:${frame.source}`,
      tab: 'weather',
      sensor: frame.source.toUpperCase(),
      url: frame.latest.imageUrl,
      sortMs: ms,
      top: `${frame.source.toUpperCase()} · ${formatWhen(ms)}`,
      bottom: frame.cadenceMinutes === null ? t('orbitalWatch.ui.caption.geostationary') : t('orbitalWatch.ui.caption.geostationaryCadence', { minutes: frame.cadenceMinutes }),
      credit: frame.archive === 'eumetsat' ? frameCredit(frame.archive) : { short: IMAGE_CREDIT.gibs, full: IMAGE_CREDIT.gibs },
      pass: null,
    });
  }
  return cards.sort((a, b) => b.sortMs - a.sortMs);
}

interface Summary {
  satellites: number;
  images: number;
  counts: Record<GroupId, number>;
  cards: ImageCard[];
  closestKey: string | null;
}

function summarize(lookup: PointPassLookup, evidence: OrbitalEvidence): Summary {
  const names = new Map(evidence.passes.map((pass) => [passKey(pass), pass.name]));
  const counts: Record<GroupId, number> = { watched: 0, likely: 0, upcoming: 0, could: 0, overhead: 0, weather: 0 };
  for (const pass of evidence.passes) counts[GROUP_OF_TIER[pass.tier.kind]]++;
  counts.watched += evidence.acquisitions.filter((acquisition) => !acquisition.pass).length;
  const past = evidence.passes.filter((pass) => pass.timeMs <= lookup.nowMs);
  const closest = evidence.bestView;
  const acquisitions = [...evidence.acquisitions].sort((a, b) => (a === closest ? -1 : b === closest ? 1 : b.startMs - a.startMs));
  const platforms = new Set(past.map((pass) => normalisePlatform(pass.name)));
  for (const acquisition of evidence.acquisitions) if (!acquisition.pass) platforms.add(acquisition.platform);
  return {
    satellites: platforms.size,
    images: evidence.acquisitions.length
      + evidence.mosaics.reduce((sum, mosaic) => sum + mosaic.days.filter((day) => day.imageUrl).length, 0)
      + evidence.frames.filter((frame) => frame.latest).length,
    counts,
    cards: [...acquisitions.map((acquisition) => acquisitionCard(acquisition, lookup.nowMs, names)), ...weatherCards(evidence)],
    closestKey: closest ? `image:${closest.key}` : null,
  };
}

interface Row {
  sortMs: number;
  render: () => HTMLElement;
}

interface Group {
  spec: GroupSpec;
  rows: Row[];
  count: number;
}

function badge(text: string, tone: 'cloud' | 'radar' | 'neutral' = 'neutral'): HTMLElement {
  return h('span', { className: 'ow-badge ow-label', dataset: { tone } }, text);
}

function rowShell(key: string, tier: string, thumb: HTMLElement, name: string, tierLabel: string, lines: string[], badges: DomChild[], credit: RowCredit | null = null): HTMLElement {
  return h('li', { className: 'ow-row', tabindex: '0', dataset: { tier, key } },
    thumb,
    h('div', { className: 'ow-row-main' },
      h('div', { className: 'ow-row-name' }, name, h('span', { className: 'ow-tier-label ow-sr' }, tierLabel)),
      ...lines.map((line) => h('div', { className: 'ow-row-meta ow-label', title: line }, line)),
      credit ? h('div', { className: 'ow-row-credit ow-label', title: credit.full }, credit.short) : null),
    h('div', { className: 'ow-badges' }, ...badges));
}

const glyphTile = (glyph: TierGlyph) =>
  h('div', { className: 'ow-glyph-tile', dataset: { glyph }, 'aria-hidden': 'true' }, h('span', { className: 'ow-glyph', dataset: { glyph } }, TIER_GLYPH_CHAR[glyph]));

function acquisitionBadges(acquisition: MatchedAcquisition | null): HTMLElement[] {
  if (!acquisition) return [];
  if (acquisition.profileId === 'sentinel-1') return [badge(t('orbitalWatch.ui.caption.radar'), 'radar')];
  if (acquisition.condition === 'cloud') return [badge(t('orbitalWatch.ui.caption.clouded', { pct: Math.round(acquisition.cloudCoverPct ?? 100) }), 'cloud')];
  return [];
}

function passRow(pass: PointPass, nowMs: number, acquisition: MatchedAcquisition | null, repeats: number): HTMLElement {
  const military = pass.tier.kind === 'capability-overhead';
  const glyph = GLYPH_OF_TIER[pass.tier.kind];
  const name = pass.name;
  const thumb = acquisition && !military
    ? imageTile(acquisition.imageUrl, t('orbitalWatch.row.imageAlt', { name, time: formatWhen(pass.timeMs) }), sensorName(acquisition.platform), 'thumb', [h('span', { className: 'ow-thumb-dot', 'aria-hidden': 'true' })])
    : glyphTile(glyph);
  const geometry = [t('orbitalWatch.row.offNadir', { deg: offNadirDeg(pass).toFixed(1) }), `${formatInt(Math.round(pass.groundDistanceKm))} KM`];
  if (acquisition?.cloudCoverPct != null && acquisition.profileId !== 'sentinel-1') geometry.push(t('orbitalWatch.ui.row.cloud', { pct: Math.round(acquisition.cloudCoverPct) }));
  const badges: DomChild[] = [
    ...acquisitionBadges(military ? null : acquisition),
    military ? badge(t('orbitalWatch.tier.capabilityOverhead')) : null,
    pass.edgeOfSwath ? badge(t('orbitalWatch.row.edgeOfSwath')) : null,
    pass.tier.kind === 'passed-overhead' && pass.tier.note === 'not-in-archive' ? badge(t('orbitalWatch.row.notInArchive')) : null,
    repeats > 1 ? h('span', { className: 'ow-repeat ow-label', title: t('orbitalWatch.ui.row.repeats', { count: repeats }) }, `×${repeats}`) : null,
  ];
  return rowShell(`pass:${passKey(pass)}`, pass.tier.kind, thumb, name, t(TIER_LABEL_KEY[pass.tier.kind]),
    [`${formatWhen(pass.timeMs)} · ${formatRelative(pass.timeMs, nowMs, 'narrow')}`, geometry.join(' · ')], badges,
    acquisition && !military ? acquisitionRowCredit(acquisition) : null);
}

function unmatchedRow(acquisition: MatchedAcquisition, nowMs: number): HTMLElement {
  const name = sensorName(acquisition.platform);
  const thumb = imageTile(acquisition.imageUrl, t('orbitalWatch.row.imageAlt', { name, time: formatWhen(acquisition.startMs) }), name, 'thumb', [h('span', { className: 'ow-thumb-dot', 'aria-hidden': 'true' })]);
  const meta = [`${acquisition.resolutionM} M`];
  if (acquisition.cloudCoverPct != null && acquisition.profileId !== 'sentinel-1') meta.push(t('orbitalWatch.ui.row.cloud', { pct: Math.round(acquisition.cloudCoverPct) }));
  return rowShell(`image:${acquisition.key}`, 'confirmed-image', thumb, name, t('orbitalWatch.tier.unmatchedImage'),
    [`${formatWhen(acquisition.startMs)} · ${formatRelative(acquisition.startMs, nowMs, 'narrow')}`, meta.join(' · ')],
    [badge(t('orbitalWatch.ui.archiveScene')), ...acquisitionBadges(acquisition)], acquisitionRowCredit(acquisition));
}

function mosaicRow(mosaic: DailyMosaicRow, day: { date: string; imageUrl: string | null }): HTMLElement {
  const ms = Date.parse(day.date);
  const resolution = MOSAIC_RESOLUTION_M.get(mosaic.layer);
  const thumb = imageTile(day.imageUrl, t('orbitalWatch.row.imageAlt', { name: mosaic.source, time: formatDay(ms) }), mosaic.source.toUpperCase(), 'thumb');
  return rowShell(`source:${mosaic.source}`, 'daily-mosaic', thumb, mosaic.source, t('orbitalWatch.tier.dailyMosaic'),
    [formatDay(ms), [t('orbitalWatch.ui.caption.dailyMosaic'), resolution ? `${resolution} M` : null, t('orbitalWatch.ui.row.days', { count: mosaic.days.length })].filter(Boolean).join(' · ')],
    [badge('NASA')], { short: IMAGE_CREDIT.gibs, full: IMAGE_CREDIT.gibsAcknowledgement });
}

function frameRow(frame: GeostationaryRow, latest: { time: string; imageUrl: string | null }): HTMLElement {
  const ms = Date.parse(latest.time);
  const thumb = imageTile(latest.imageUrl, t('orbitalWatch.row.imageAlt', { name: frame.source, time: formatWhen(ms) }), frame.source.toUpperCase(), 'thumb');
  return rowShell(`source:${frame.source}`, 'weather-frame', thumb, frame.source, t('orbitalWatch.tier.weatherFrame'),
    [formatWhen(ms), frame.cadenceMinutes === null ? t('orbitalWatch.ui.caption.geostationary') : t('orbitalWatch.ui.caption.geostationaryCadence', { minutes: frame.cadenceMinutes })],
    [badge(frame.archive === 'eumetsat' ? 'EUMETSAT' : 'NASA')],
    frameCredit(frame.archive));
}

function groupPasses(lookup: PointPassLookup, evidence: OrbitalEvidence): Map<GroupId, Group> {
  const acquisitionByPass = new Map<string, MatchedAcquisition>();
  for (const acquisition of evidence.acquisitions) if (acquisition.pass) acquisitionByPass.set(passKey(acquisition.pass), acquisition);
  const closest = evidence.bestView?.pass ? passKey(evidence.bestView.pass) : evidence.bestView ? `image:${evidence.bestView.key}` : null;
  const groups = new Map<GroupId, Group>(GROUPS.map((spec) => [spec.id, { spec, rows: [], count: 0 }]));
  const repeats = new Map<string, number>();
  for (const pass of evidence.passes) {
    const id = `${GROUP_OF_TIER[pass.tier.kind]}:${pass.noradId}`;
    repeats.set(id, (repeats.get(id) ?? 0) + 1);
  }
  const closestFirst = (key: string, ms: number) => (key === closest ? Number.MAX_SAFE_INTEGER : ms);
  for (const pass of evidence.passes) {
    if (pass.tier.kind === 'daily-mosaic') continue;
    const id = GROUP_OF_TIER[pass.tier.kind];
    const key = passKey(pass);
    const group = groups.get(id)!;
    group.count++;
    group.rows.push({
      sortMs: id === 'watched' ? closestFirst(key, pass.timeMs) : pass.timeMs,
      render: () => passRow(pass, lookup.nowMs, acquisitionByPass.get(key) ?? null, repeats.get(`${id}:${pass.noradId}`) ?? 1),
    });
  }
  for (const acquisition of evidence.acquisitions) {
    if (acquisition.pass) continue;
    const group = groups.get('watched')!;
    group.count++;
    group.rows.push({ sortMs: closestFirst(`image:${acquisition.key}`, acquisition.startMs), render: () => unmatchedRow(acquisition, lookup.nowMs) });
  }
  const weather = groups.get('weather')!;
  for (const mosaic of evidence.mosaics) {
    const day = mosaic.days[0];
    if (!day) continue;
    weather.count++;
    weather.rows.push({ sortMs: Date.parse(day.date), render: () => mosaicRow(mosaic, day) });
  }
  for (const frame of evidence.frames) {
    const latest = frame.latest;
    if (!latest) continue;
    weather.count++;
    weather.rows.push({ sortMs: Date.parse(latest.time), render: () => frameRow(frame, latest) });
  }
  for (const group of groups.values()) group.rows.sort((a, b) => (group.spec.order === 'soonest' ? a.sortMs - b.sortMs : b.sortMs - a.sortMs));
  return groups;
}

interface StepTimes {
  startedAt: number;
  catalogAt: number | null;
  propagatedAt: number | null;
  archivesAt: number | null;
  total: number;
}

type StepStatus = 'pending' | 'running' | 'ok' | 'partial' | 'failed';

/** The lookup sheet: a compact side sheet that opens into a full-screen view. */
export class OrbitalWatchPage {
  private readonly sheet: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly place: HTMLElement;
  private readonly zone: HTMLElement;
  private placeName: string | null = null;
  private placeZone: PlaceTimeZone | null = null;
  /** Times show in the point's local zone unless the reader switched to UTC; the choice holds across places. */
  private localTime = true;
  private readonly changeButton: HTMLElement;
  private readonly closeButton: HTMLElement;
  private readonly privacy: HTMLElement;
  private readonly mapMark: HTMLElement;
  private readonly statusBar: HTMLElement;
  private readonly slots: Record<OrbitalSlot, HTMLElement>;
  private returnFocusTo: HTMLElement | null = null;
  private point: GeoPoint | null = null;
  private view: OrbitalView = 'sheet';
  private tab: Tab = 'all';
  private cardIndex = 0;
  private filter: GroupId | null = null;
  /** Groups the user opened or closed, against their default. */
  private readonly toggled = new Set<GroupId>();
  private selectedKey: string | null = null;
  private state: OrbitalWatchState | null = null;
  private steps: StepTimes = { startedAt: 0, catalogAt: null, propagatedAt: null, archivesAt: null, total: 0 };
  private clock: ReturnType<typeof setInterval> | null = null;
  private shareReset: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly callbacks: OrbitalWatchPageCallbacks) {
    const titleId = 'orbital-watch-title';
    this.place = h('h2', { id: titleId, className: 'ow-place' });
    this.zone = h('button', { type: 'button', className: 'ow-zone ow-label', dataset: { action: 'zone' } });
    this.changeButton = h('button', { type: 'button', className: 'ow-change ow-label', dataset: { action: 'change' } });
    this.closeButton = h('button', { type: 'button', className: 'ow-close', dataset: { action: 'close' } }, '×');
    this.body = h('div', { className: 'ow-body' });
    this.privacy = h('details', { className: 'ow-privacy' });
    this.mapMark = h('div', { className: 'ow-mapmark', 'aria-hidden': 'true', hidden: true },
      h('span', { className: 'ow-mapmark-ring' }),
      h('span', { className: 'ow-mapmark-label ow-label' }));
    this.slots = {
      search: h('div', { className: 'ow-slot ow-search-slot', dataset: { slot: 'search' }, hidden: true }),
      timelapse: h('div', { className: 'ow-slot', dataset: { slot: 'timelapse' } }),
      'pass-detail': h('div', { className: 'ow-slot', dataset: { slot: 'pass-detail' } }),
      timeline: h('div', { className: 'ow-slot ow-dock', dataset: { slot: 'timeline' } }),
      'replay-hud': h('div', { className: 'ow-slot ow-hud', dataset: { slot: 'replay-hud' } }),
    };
    this.panel = h('div', { className: 'ow-panel' },
      h('div', { className: 'ow-handle', 'aria-hidden': 'true' }),
      h('header', { className: 'ow-header' },
        h('span', { className: 'ow-search-icon', 'aria-hidden': 'true' }, '⌕'),
        h('div', { className: 'ow-place-block' }, this.place, this.zone),
        this.changeButton,
        this.closeButton),
      this.slots.search,
      this.slots['pass-detail'],
      this.body,
      this.privacy);
    this.statusBar = h('div', { className: 'ow-statusbar ow-label' });
    this.sheet = h('section', { className: 'orbital-watch-sheet', role: 'dialog', 'aria-labelledby': titleId, tabindex: '-1', dataset: { view: 'sheet' } },
      this.mapMark, this.panel, this.slots.timeline, this.slots['replay-hud'], this.statusBar);
    declareOverlay(this.sheet, { reload: 'safe' });
    this.sheet.addEventListener('keydown', this.onSheetKeydown);
    this.sheet.addEventListener('click', this.onSheetClick);
  }

  get isOpen(): boolean {
    return this.sheet.isConnected;
  }

  get currentView(): OrbitalView {
    return this.view;
  }

  slot(name: OrbitalSlot): HTMLElement {
    return this.slots[name];
  }

  /** Names the open point after the searched place, or null for its rounded coordinates. */
  setPlaceName(name: string | null): void {
    this.placeName = name && shortPlaceName(name);
    this.place.title = name ?? '';
    this.place.textContent = this.placeLabel();
    if (this.state) this.render(this.state);
  }

  /** Points every time on the sheet at the place's zone, or at UTC when the reader asked for it or the zone is unknown. */
  private applyZone(): void {
    const zone = this.placeZone;
    const local = this.localTime && zone !== null;
    if (local) setOrbitalDisplayZone(zone.zone, zone.abbr);
    else setOrbitalDisplayZone('UTC', 'UTC');
    this.zone.hidden = zone === null;
    this.zone.textContent = local ? placeTimeZoneLabel(zone) : 'UTC';
    this.zone.setAttribute('aria-pressed', String(local));
    this.zone.title = t(local ? 'orbitalWatch.ui.zoneShowUtc' : 'orbitalWatch.ui.zoneShowLocal');
  }

  private placeLabel(): string {
    return this.placeName ?? (this.point ? formatPoint(this.point) : t('orbitalWatch.search.label'));
  }

  open(point: GeoPoint | null, returnFocusTo: HTMLElement | null, view: OrbitalView = 'sheet'): void {
    this.returnFocusTo = returnFocusTo;
    this.point = point;
    this.placeName = null;
    this.place.title = '';
    this.toggled.clear();
    this.selectedKey = null;
    this.tab = 'all';
    this.cardIndex = 0;
    this.filter = null;
    this.place.textContent = this.placeLabel();
    this.placeZone = point ? placeTimeZone(point) : null;
    this.applyZone();
    this.sheet.setAttribute('aria-label', t('contextMenu.satellitePasses'));
    this.changeButton.textContent = t('orbitalWatch.ui.change');
    this.closeButton.setAttribute('aria-label', t('countryBrief.closeBtn'));
    this.mapMark.lastElementChild!.textContent = point ? formatPoint(point) : '';
    this.renderPrivacy();
    this.applyView(view);
    this.render(point ? { kind: 'computing', done: 0, total: 0 } : { kind: 'idle' });
    if (!this.isOpen) {
      document.body.appendChild(this.sheet);
      document.addEventListener('keydown', this.onDocumentKeydown);
    }
    this.sheet.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    document.removeEventListener('keydown', this.onDocumentKeydown);
    this.stopClock();
    if (this.shareReset) clearTimeout(this.shareReset);
    this.sheet.remove();
    this.state = null;
    const wasFull = this.view === 'full';
    this.view = 'sheet';
    this.sheet.dataset.view = 'sheet';
    document.body.classList.remove(FULL_VIEW_BODY_CLASS);
    if (wasFull) this.callbacks.onViewChange?.('sheet');
    this.selectedKey = null;
    this.callbacks.onClose();
    const target = this.returnFocusTo;
    this.returnFocusTo = null;
    if (target?.isConnected) {
      if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }

  /** Opens the full view on a pass's row, expanding its group, and announces it for the pass detail. */
  select(key: string): boolean {
    const state = this.state;
    if (!this.isOpen || state?.kind !== 'passes' || state.archives.kind !== 'answered') return false;
    const pass = state.archives.evidence.passes.find((p) => passKey(p) === key);
    if (!pass || pass.tier.kind === 'daily-mosaic') return false;
    const id = GROUP_OF_TIER[pass.tier.kind];
    const spec = GROUPS.find((g) => g.id === id)!;
    if (!spec.expanded) this.toggled.add(id);
    else this.toggled.delete(id);
    this.filter = null;
    this.selectedKey = `pass:${key}`;
    if (this.view === 'full') this.render(state);
    else this.setView('full');
    const row = this.body.querySelector<HTMLElement>(`.ow-row[aria-current]`);
    if (!row) return false;
    row.scrollIntoView?.({ block: 'center' });
    row.focus();
    this.sheet.dispatchEvent(new CustomEvent('orbital-watch:select', { bubbles: true, detail: { noradId: pass.noradId, timeMs: pass.timeMs } }));
    return true;
  }

  /** The boxes the open lookup draws over the map, in client coordinates. */
  coverRects(): DOMRect[] {
    if (!this.isOpen) return [];
    return [this.panel, this.slots.timeline, this.statusBar]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
  }

  /** Draws the reticle at a client position on the map, or hides it. */
  placeMapMark(at: { x: number; y: number } | null): void {
    this.mapMark.hidden = !at;
    if (at) this.mapMark.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
  }

  setView(view: OrbitalView): void {
    if (view === this.view || !this.isOpen) return;
    this.applyView(view);
    if (this.state) this.render(this.state);
    this.callbacks.onViewChange?.(view);
    this.sheet.focus();
  }

  private renderPrivacy(): void {
    const credits = [IMAGE_CREDIT.copernicus(new Date().getUTCFullYear()), IMAGE_CREDIT.usgs, IMAGE_CREDIT.eumetsat, IMAGE_CREDIT.gibsAcknowledgement];
    replaceChildren(this.privacy,
      h('summary', { className: 'ow-privacy-line ow-label' }, `${t('orbitalWatch.ui.privacyLine')} · ${t('orbitalWatch.ui.privacyHow')} ›`),
      h('div', { className: 'ow-privacy-body' },
        h('p', null, t('orbitalWatch.privacy')),
        h('p', { className: 'ow-sources-head ow-label' }, t('orbitalWatch.ui.sources')),
        h('ul', { className: 'ow-sources' }, ...credits.map((credit) => h('li', null, credit)))));
  }

  private applyView(view: OrbitalView): void {
    this.view = view;
    this.sheet.dataset.view = view;
    document.body.classList.toggle(FULL_VIEW_BODY_CLASS, view === 'full');
    if (view === 'full') this.startClock();
    else this.stopClock();
  }

  render(state: OrbitalWatchState): void {
    if (state.kind === 'computing' && state.total === 0) this.steps = { startedAt: performance.now(), catalogAt: null, propagatedAt: null, archivesAt: null, total: 0 };
    this.markSteps(state);
    this.state = state;
    const focused = document.activeElement instanceof HTMLElement && this.body.contains(document.activeElement) ? document.activeElement : null;
    const selector = focused?.dataset.key ? `.ow-row[data-key="${CSS.escape(focused.dataset.key)}"]`
      : focused?.dataset.group ? `.ow-group-toggle[data-group="${focused.dataset.group}"]`
      : null;
    replaceChildren(this.body, ...this.renderState(state));
    if (this.selectedKey) this.body.querySelector(`.ow-row[data-key="${CSS.escape(this.selectedKey)}"]`)?.setAttribute('aria-current', 'true');
    this.renderStatusBar();
    if (focused) ((selector ? this.body.querySelector<HTMLElement>(selector) : null) ?? this.sheet).focus();
  }

  private markSteps(state: OrbitalWatchState): void {
    const now = performance.now();
    const steps = this.steps;
    if (state.kind === 'computing' && state.total > 0) {
      steps.total = state.total;
      steps.catalogAt ??= now;
    }
    if (state.kind === 'passes') {
      steps.total = state.lookup.satellites.length;
      steps.catalogAt ??= now;
      steps.propagatedAt ??= now;
      if (state.archives.kind === 'answered') steps.archivesAt ??= now;
    }
  }

  private renderState(state: OrbitalWatchState): DomChild[] {
    if (state.kind === 'idle') return [h('p', { className: 'ow-empty' }, t('orbitalWatch.search.idle'))];
    if (state.kind === 'passes' && state.archives.kind === 'answered') return this.renderResults(state.lookup, state.archives.evidence);
    const lookup = state.kind === 'passes' ? state.lookup : null;
    return [
      lookup ? this.staleBanner(lookup) : null,
      this.renderSteps(state),
      state.kind === 'unavailable'
        ? h('div', { className: 'ow-empty' }, h('p', null, t('orbitalWatch.unavailable')), this.retryButton())
        : null,
    ];
  }

  private staleBanner(lookup: PointPassLookup): DomChild {
    if (lookup.catalog.status !== 'stale') return null;
    return h('p', { className: 'ow-banner ow-banner-stale', role: 'note' }, t('orbitalWatch.stale', { age: formatAge((lookup.nowMs - lookup.catalog.fetchedAt) / DAY_MS) }));
  }

  private renderSteps(state: OrbitalWatchState): HTMLElement {
    const { steps } = this;
    const now = performance.now();
    const seconds = (from: number | null, to: number | null) => (from === null ? '' : `${(((to ?? now) - from) / 1000).toFixed(2)} S`);
    const computing = state.kind === 'computing' ? state : null;
    const archives = state.kind === 'passes' ? state.archives : null;
    const settled = archives?.kind === 'checking' ? archives.progress?.settled.length ?? 0 : 0;
    const archiveTotal = archives?.kind === 'checking' ? archives.total : 0;
    const failed = state.kind === 'unavailable';
    const catalog: StepStatus = failed && steps.catalogAt === null ? 'failed' : steps.catalogAt !== null ? 'ok' : 'running';
    const propagation: StepStatus = steps.propagatedAt !== null ? 'ok' : failed ? 'failed' : steps.catalogAt !== null ? 'running' : 'pending';
    const archiveStatus: StepStatus = archives ? 'running' : 'pending';
    const propagatedDone = computing ? computing.done : steps.propagatedAt !== null ? steps.total : 0;
    const pct = steps.propagatedAt !== null
      ? 60 + (archiveTotal > 0 ? (35 * settled) / archiveTotal : 0)
      : steps.catalogAt !== null && steps.total > 0 ? 5 + (55 * propagatedDone) / steps.total : 2;
    const step = (n: string, label: string, time: string, status: StepStatus) =>
      h('li', { className: 'ow-step', dataset: { status } },
        h('span', { className: 'ow-step-n' }, n),
        h('span', { className: 'ow-step-label' }, label),
        h('span', { className: 'ow-step-time' }, time),
        h('span', { className: 'ow-step-status' }, status === 'ok' ? 'OK' : status === 'failed' ? t('orbitalWatch.ui.step.failed') : status === 'running' ? '…' : ''));
    const lookup = state.kind === 'passes' ? state.lookup : null;
    const nowMs = lookup?.nowMs ?? Date.now();
    const windowStart = lookup?.window.startMs ?? nowMs - 7 * DAY_MS;
    return h('section', { className: 'ow-steps', role: 'status', 'aria-live': 'polite' },
      h('div', { className: 'ow-steps-head ow-label' },
        h('span', null, t('orbitalWatch.ui.step.computing')),
        h('span', { className: 'ow-steps-clock' }, `T+${((now - steps.startedAt) / 1000).toFixed(2)} S`)),
      h('ol', { className: 'ow-step-list ow-label' },
        step('01', steps.total > 0 ? t('orbitalWatch.ui.step.catalog', { count: formatInt(steps.total) }) : t('orbitalWatch.ui.step.catalogLoading'), seconds(steps.startedAt, steps.catalogAt), catalog),
        step('02', t('orbitalWatch.ui.step.propagating', { done: formatInt(propagatedDone), total: formatInt(steps.total) }), seconds(steps.catalogAt, steps.propagatedAt), propagation),
        step('03', t('orbitalWatch.ui.step.archives', { done: settled, total: archiveTotal || 5 }), seconds(steps.propagatedAt, steps.archivesAt), archiveStatus),
        step('04', t('orbitalWatch.ui.step.matching', { passes: formatInt(lookup?.passes.length ?? 0) }), '', 'pending')),
      h('div', { className: 'ow-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) },
        h('span', { className: 'ow-progress-fill', style: `width: ${pct.toFixed(1)}%` })),
      h('div', { className: 'ow-steps-foot ow-label' },
        h('span', null, t('orbitalWatch.ui.step.window', { start: formatOrbitalTime(windowStart, 'stamp'), end: `${formatOrbitalTime(nowMs, 'stamp')} ${displayZone.label}` })),
        h('span', { className: 'ow-steps-pct' }, `${Math.round(pct)}%`)),
      archives ? h('p', { className: 'ow-steps-note' }, t('orbitalWatch.ui.step.note')) : null);
  }

  private renderResults(lookup: PointPassLookup, evidence: OrbitalEvidence): DomChild[] {
    const summary = summarize(lookup, evidence);
    const failedNames = [...new Set(evidence.failures.map((failure) => (failure.source ? `${ARCHIVE_NAME[failure.archive]} (${failure.source})` : ARCHIVE_NAME[failure.archive])))];
    const partial = failedNames.length > 0
      ? h('div', { className: 'ow-banner ow-banner-partial', role: 'note' },
        h('p', null, t('orbitalWatch.partial', { sources: formatList(failedNames) })),
        this.retryButton())
      : null;
    const empty = lookup.passes.length > 0 ? null
      : summary.cards.length > 0 ? h('p', { className: 'ow-empty' }, t('orbitalWatch.ui.archiveOnly'))
      : h('p', { className: 'ow-empty' }, t('orbitalWatch.empty', { pastDays: Math.round((lookup.nowMs - lookup.window.startMs) / DAY_MS), futureHours: Math.round((lookup.window.endMs - lookup.nowMs) / HOUR_MS) }));
    return [
      this.staleBanner(lookup),
      h('section', { className: 'ow-section ow-summary' },
        this.sectionHead('01', t('orbitalWatch.ui.section.summary')),
        this.headline(lookup, summary),
        partial,
        empty,
        this.carousel(summary),
        this.slots.timelapse,
        this.tierGrid(summary),
        this.view === 'sheet'
          ? h('button', { type: 'button', className: 'ow-primary', dataset: { action: 'open-full' } }, t('orbitalWatch.ui.openFull'))
          : null),
      this.view === 'full' ? this.passList(lookup, evidence) : null,
    ];
  }

  private sectionHead(n: string, label: string): HTMLElement {
    return h('h3', { className: 'ow-section-head ow-label' }, `${n} / ${label}`);
  }

  private headline(lookup: PointPassLookup, summary: Summary): HTMLElement {
    const days = Math.round((lookup.nowMs - lookup.window.startMs) / DAY_MS);
    const template = t('orbitalWatch.ui.headline', { days, satellites: '\u0001', place: '\u0002' });
    const parts = template.split(/(\u0001|\u0002)/).map((part) =>
      part === '\u0001' ? h('strong', null, t('orbitalWatch.ui.satellites', { count: summary.satellites }))
        : part === '\u0002' ? h('strong', null, this.placeName ?? formatPoint(lookup.point))
        : part);
    return h('div', { className: 'ow-headline-row' },
      h('div', null,
        h('p', { className: 'ow-headline', role: 'status' }, ...parts),
        h('p', { className: 'ow-subline' }, t('orbitalWatch.ui.subline', { count: summary.images }))),
      h('button', { type: 'button', className: 'ow-share ow-label', dataset: { action: 'share' } }, t('orbitalWatch.ui.share')));
  }

  private carousel(summary: Summary): DomChild {
    const present = new Set(summary.cards.map((card) => card.tab));
    const tabs = TABS.filter((tab) => tab === 'all' || present.has(tab));
    if (!tabs.includes(this.tab)) this.tab = 'all';
    const cards = summary.cards.filter((card) => this.tab === 'all' || card.tab === this.tab);
    if (cards.length === 0) return null;
    this.cardIndex = Math.min(this.cardIndex, cards.length - 1);
    const track = h('div', { className: 'ow-track', onScroll: () => this.syncPager(track, pager) },
      ...cards.map((card, i) => this.heroCard(card, card.key === summary.closestKey && this.tab !== 'weather', i)));
    const pager = h('span', { className: 'ow-pager-count' }, `${this.cardIndex + 1} / ${cards.length}`);
    const nav = (action: 'prev' | 'next', label: string, glyph: string, disabled: boolean) =>
      h('button', { type: 'button', className: 'ow-pager-btn', dataset: { action }, 'aria-label': label, disabled }, glyph);
    queueMicrotask(() => this.scrollToCard(track, false));
    return h('div', { className: 'ow-carousel' },
      h('div', { className: 'ow-carousel-bar' },
        h('div', { className: 'ow-tabs ow-label', role: 'tablist' },
          ...tabs.map((tab) => h('button', { type: 'button', role: 'tab', className: 'ow-tab', 'aria-selected': String(tab === this.tab), dataset: { action: 'tab', tab } }, tab === 'radar' ? t('orbitalWatch.ui.caption.radar') : t(`orbitalWatch.ui.tab.${tab}`)))),
        h('div', { className: 'ow-pager ow-label' },
          pager,
          nav('prev', t('orbitalWatch.ui.previous'), '‹', this.cardIndex === 0),
          nav('next', t('orbitalWatch.ui.next'), '›', this.cardIndex >= cards.length - 1))),
      track);
  }

  private heroCard(card: ImageCard, closest: boolean, index: number): HTMLElement {
    const tile = imageTile(card.url, t('orbitalWatch.row.imageAlt', { name: card.sensor, time: card.top }), card.sensor, 'hero', [
      ...heroOverlays(),
      h('span', { className: 'ow-card-tag ow-label' }, closest ? t('orbitalWatch.ui.closestLook') : card.sensor),
      h('button', { type: 'button', className: 'ow-expand', dataset: { action: 'open-full' }, 'aria-label': t('orbitalWatch.ui.openFull') }, '⤢'),
    ]);
    return h('figure', { className: 'ow-card', dataset: { key: card.key, tab: card.tab, index: String(index) } },
      tile,
      h('figcaption', { className: 'ow-caption' },
        h('div', { className: 'ow-caption-row' },
          h('div', { className: 'ow-caption-lines ow-label' }, h('span', null, card.top), h('span', null, card.bottom)),
          card.pass
            ? h('button', { type: 'button', className: 'ow-replay ow-label', dataset: { action: 'replay', norad: String(card.pass.noradId), time: String(card.pass.timeMs) } }, `▸ ${t('orbitalWatch.ui.replay')}`)
            : null),
        h('span', { className: 'ow-image-credit ow-label', title: card.credit.full }, card.credit.short)));
  }

  private syncPager(track: HTMLElement, pager: HTMLElement): void {
    const cards = [...track.querySelectorAll<HTMLElement>('.ow-card')];
    if (cards.length === 0 || track.clientWidth === 0) return;
    const index = Math.round(track.scrollLeft / (cards[0]!.offsetWidth || track.clientWidth));
    const bounded = Math.max(0, Math.min(cards.length - 1, index));
    if (bounded === this.cardIndex) return;
    this.cardIndex = bounded;
    pager.textContent = `${bounded + 1} / ${cards.length}`;
    const bar = track.previousElementSibling;
    bar?.querySelector<HTMLButtonElement>('[data-action="prev"]')?.toggleAttribute('disabled', bounded === 0);
    bar?.querySelector<HTMLButtonElement>('[data-action="next"]')?.toggleAttribute('disabled', bounded >= cards.length - 1);
  }

  private scrollToCard(track: HTMLElement, smooth: boolean): void {
    const card = track.querySelectorAll<HTMLElement>('.ow-card')[this.cardIndex];
    if (!card || typeof track.scrollTo !== 'function') return;
    track.scrollTo({ left: card.offsetLeft - track.offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
  }

  private tierGrid(summary: Summary): HTMLElement {
    return h('div', { className: 'ow-tier-grid' },
      ...GRID.map(({ id, glyph, key }) =>
        h('button', { type: 'button', className: 'ow-tier-cell', dataset: { action: 'filter', group: id, glyph }, 'aria-pressed': String(this.filter === id) },
          h('span', { className: 'ow-tier-count' },
            h('span', { className: 'ow-glyph', dataset: { glyph } }, TIER_GLYPH_CHAR[glyph]),
            h('span', { className: 'ow-tier-number' }, formatInt(summary.counts[id])),
            h('span', { className: 'ow-label' }, t('orbitalWatch.ui.passes', { count: summary.counts[id] }))),
          h('span', { className: 'ow-tier-name ow-label' }, t(`orbitalWatch.ui.grid.${key}`)),
          h('span', { className: 'ow-tier-def' }, t(`orbitalWatch.ui.grid.${key}Def`)),
          h('span', { className: 'ow-tier-short' }, t(`orbitalWatch.ui.grid.${key}Short`)))));
  }

  private passList(lookup: PointPassLookup, evidence: OrbitalEvidence): HTMLElement {
    const groups = groupPasses(lookup, evidence);
    const shown = GROUPS.map(({ id }) => groups.get(id)!).filter((group) => group.count > 0 && (!this.filter || group.spec.id === this.filter));
    const missing = [...evidence.mosaics.filter((mosaic) => mosaic.days.length === 0), ...evidence.frames.filter((frame) => !frame.latest)].map((row) => row.source);
    return h('section', { className: 'ow-section ow-passes' },
      this.sectionHead('02', t('orbitalWatch.ui.section.passes')),
      this.filter
        ? h('button', { type: 'button', className: 'ow-clear-filter ow-label', dataset: { action: 'clear-filter' } }, t('orbitalWatch.ui.showAll'))
        : null,
      ...shown.map((group) => this.renderGroup(group, missing)));
  }

  private renderGroup(group: Group, missingMosaics: string[]): HTMLElement {
    const { id, glyph, order } = group.spec;
    const expanded = this.filter === id || group.spec.expanded !== this.toggled.has(id);
    const listId = `orbital-watch-group-${id}`;
    const toggle = h('button', { type: 'button', className: 'ow-group-toggle ow-label', 'aria-expanded': String(expanded), 'aria-controls': listId, dataset: { group: id } },
      h('span', { className: 'ow-glyph', dataset: { glyph } }, TIER_GLYPH_CHAR[glyph]),
      h('span', { className: 'ow-group-count' }, formatInt(group.count)),
      h('span', { className: 'ow-group-name' }, id === 'weather' ? t('orbitalWatch.ui.group.weather', { count: group.count }) : `${t('orbitalWatch.ui.passes', { count: group.count })} ${t(`orbitalWatch.ui.group.${id}`)}`),
      h('span', { className: 'ow-group-order' }, `· ${t(`orbitalWatch.ui.order.${order}`)}`));
    const list = h('ul', { className: 'ow-rows', id: listId, hidden: !expanded });
    if (expanded) list.append(...group.rows.map((row) => row.render()));
    const note = id === 'weather' && expanded && missingMosaics.length > 0
      ? h('p', { className: 'ow-group-note ow-label' }, t('orbitalWatch.ui.noRecentDays', { sources: formatList(missingMosaics) }))
      : null;
    return h('section', { className: 'ow-group', dataset: { group: id } }, toggle, list, note);
  }

  private renderStatusBar(): void {
    if (this.view !== 'full') {
      replaceChildren(this.statusBar);
      return;
    }
    const state = this.state;
    const lookup = state?.kind === 'passes' ? state.lookup : null;
    const nowMs = Date.now();
    const sun = subSolarPoint(nowMs);
    const fetched = lookup ? new Date(lookup.catalog.fetchedAt).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : null;
    replaceChildren(this.statusBar,
      h('span', { className: 'ow-status-left' },
        lookup ? `${t('orbitalWatch.ui.status.objects', { count: formatInt(lookup.satellites.length) })} · ${t('orbitalWatch.ui.status.fetched', { time: fetched, ago: formatRelative(lookup.catalog.fetchedAt, nowMs) })}` : ''),
      h('span', { className: 'ow-status-right' }, `${t('orbitalWatch.ui.status.sun', { point: formatPoint(sun, 1) })} · ${formatUtcClock(nowMs)} UTC`));
  }

  private startClock(): void {
    this.stopClock();
    this.clock = setInterval(() => this.renderStatusBar(), 1000);
  }

  private stopClock(): void {
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
  }

  private retryButton(): HTMLElement {
    return h('button', { type: 'button', className: 'ow-retry', dataset: { action: 'retry' } }, t('countryBrief.retryBtn'));
  }

  private share(button: HTMLElement): void {
    if (!this.point) return;
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = `orbital=${this.point.lat.toFixed(4)},${this.point.lon.toFixed(4)}&view=full`;
    void navigator.clipboard?.writeText(url.toString()).then(() => {
      button.textContent = t('orbitalWatch.ui.shareCopied');
      if (this.shareReset) clearTimeout(this.shareReset);
      this.shareReset = setTimeout(() => { button.textContent = t('orbitalWatch.ui.share'); }, 2000);
    }).catch(() => {});
  }

  private readonly onSheetClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    const actionEl = target.closest<HTMLElement>('[data-action]');
    const action = actionEl?.dataset.action;
    const track = actionEl?.closest('.ow-carousel')?.querySelector<HTMLElement>('.ow-track') ?? null;
    switch (action) {
      case 'retry': this.callbacks.onRetry(); return;
      case 'close': this.view === 'full' ? this.setView('sheet') : this.close(); return;
      case 'change': this.callbacks.onChangePlace ? this.callbacks.onChangePlace() : this.close(); return;
      case 'open-full': this.setView('full'); return;
      case 'zone':
        this.localTime = !this.localTime;
        this.applyZone();
        if (this.state) this.render(this.state);
        this.sheet.dispatchEvent(new CustomEvent('orbital-watch:zone-change', { bubbles: true, detail: getOrbitalDisplayZone() }));
        return;
      case 'share': this.callbacks.onShare ? this.callbacks.onShare(actionEl!) : this.share(actionEl!); return;
      case 'retry-image': {
        const tile = actionEl!.closest<HTMLElement>('.ow-tile');
        const img = tile?.querySelector('img');
        if (!tile || !img) return;
        const src = img.getAttribute('src')!;
        tile.dataset.state = 'loading';
        replaceChildren(tile.querySelector('.ow-tile-status')!, tile.dataset.sensor ?? '');
        img.removeAttribute('src');
        img.setAttribute('src', src);
        return;
      }
      case 'replay':
        this.sheet.dispatchEvent(new CustomEvent('orbital-watch:replay', { bubbles: true, detail: { noradId: Number(actionEl!.dataset.norad), timeMs: Number(actionEl!.dataset.time) } }));
        return;
      case 'tab':
        this.tab = actionEl!.dataset.tab as Tab;
        this.cardIndex = 0;
        if (this.state) this.render(this.state);
        this.body.querySelector<HTMLElement>(`.ow-tab[data-tab="${this.tab}"]`)?.focus();
        return;
      case 'prev':
      case 'next':
        if (!track) return;
        this.cardIndex = Math.max(0, this.cardIndex + (action === 'next' ? 1 : -1));
        if (this.state) this.render(this.state);
        this.body.querySelector<HTMLElement>(`.ow-pager-btn[data-action="${action}"]`)?.focus();
        return;
      case 'filter':
        this.filter = actionEl!.dataset.group as GroupId;
        if (this.view === 'full' && this.state) this.render(this.state);
        else this.setView('full');
        return;
      case 'clear-filter':
        this.filter = null;
        if (this.state) this.render(this.state);
        return;
    }
    const toggle = target.closest<HTMLElement>('.ow-group-toggle');
    const id = toggle?.dataset.group as GroupId | undefined;
    if (!id || !this.state) return;
    if (this.toggled.has(id)) this.toggled.delete(id);
    else this.toggled.add(id);
    toggle!.focus();
    this.render(this.state);
  };

  private readonly onSheetKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const row = (event.target as HTMLElement).closest('.ow-row');
    if (!row) return;
    const rows = [...this.sheet.querySelectorAll<HTMLElement>('.ow-row')];
    const next = rows[rows.indexOf(row as HTMLElement) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (this.view === 'full') this.setView('sheet');
    else this.close();
  };
}
