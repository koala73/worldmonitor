import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import { decidePassTier, type ArchiveAnswer } from '../../../shared/orbital/tiers.js';
import { searchEumetsatGeostationary } from './archive-eumetsat';
import { searchGibsDailyMosaics, searchGibsGeostationary, type DailyMosaicRow, type GeostationaryRow } from './archive-gibs';
import type { ArchiveFailure, ArchiveRequestOptions, ArchiveResult } from './archive-result';
import {
  normalisePlatform,
  readPointCondition,
  searchStacArchive,
  type ArchiveItem,
  type ImagingProfileId,
  type PointCondition,
  type StacArchiveId,
} from './archive-stac';
import { cropBox, planetaryComputerCropUrl, type CropBox } from './crop-url';
import type { PointPassLookup } from './pass-client';
import type { PointPass } from './pass-job';
import { profileFor } from './pass-query';

const MINUTE_MS = 60_000;
/** Items of one platform and orbit this close together are tiles or processing levels of one acquisition. */
const SAME_ACQUISITION_GAP_MS = 10 * MINUTE_MS;
/** How far a pass may sit outside an acquisition's sensing span and still be the pass that produced it. */
export const PASS_MATCH_TOLERANCE_MS = 5 * MINUTE_MS;

/** Which archives answer for each imaging mission. */
export const PROFILE_ARCHIVES: Record<ImagingProfileId, readonly StacArchiveId[]> = {
  'sentinel-2': ['earth-search', 'planetary-computer'],
  'sentinel-1': ['earth-search'],
  landsat: ['planetary-computer'],
};

export type AcquisitionCondition = PointCondition | 'not-applicable';

export interface Acquisition {
  key: string;
  profileId: ImagingProfileId;
  platform: string;
  orbit: number | null;
  startMs: number;
  endMs: number;
  /** Every archive item of the acquisition: overlapping tiles, processing levels and copies in other archives. */
  items: ArchiveItem[];
}

export interface MatchedAcquisition extends Acquisition {
  /** The computed pass that produced the acquisition, or null for an unmatched image that is still shown. */
  pass: { noradId: number; timeMs: number } | null;
  condition: AcquisitionCondition;
  cloudCoverPct: number | null;
  sunElevationDeg: number | null;
  resolutionM: number;
  imageUrl: string | null;
}

export interface OrbitalEvidence {
  passes: PointPass[];
  acquisitions: MatchedAcquisition[];
  mosaics: DailyMosaicRow[];
  frames: GeostationaryRow[];
  bestView: MatchedAcquisition | null;
  status: 'complete' | 'partial';
  failures: ArchiveFailure[];
  /** Missions whose every archive failed, so their passes stay unanswered. */
  unansweredProfiles: ImagingProfileId[];
}

const spanGap = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) =>
  Math.max(0, a.startMs - b.endMs, b.startMs - a.endMs);

const isOptical = (profileId: ImagingProfileId) => profileId !== 'sentinel-1';

export function groupAcquisitions(items: readonly ArchiveItem[]): Acquisition[] {
  const groups: Acquisition[] = [];
  for (const item of [...items].sort((a, b) => a.startMs - b.startMs)) {
    const group = groups.find((candidate) =>
      candidate.profileId === item.profileId &&
      candidate.platform === item.platform &&
      (candidate.orbit === null || item.orbit === null || candidate.orbit === item.orbit) &&
      spanGap(candidate, item) <= SAME_ACQUISITION_GAP_MS);
    if (!group) {
      groups.push({
        key: `${item.platform}:${item.orbit ?? '-'}:${item.startMs}`,
        profileId: item.profileId,
        platform: item.platform,
        orbit: item.orbit,
        startMs: item.startMs,
        endMs: item.endMs,
        items: [item],
      });
      continue;
    }
    if (group.items.some((seen) => seen.archive === item.archive && seen.itemId === item.itemId)) continue;
    group.items.push(item);
    group.orbit ??= item.orbit;
    group.startMs = Math.min(group.startMs, item.startMs);
    group.endMs = Math.max(group.endMs, item.endMs);
  }
  return groups;
}

/** The pass of the acquisition's own satellite nearest its sensing span, within the tolerance. */
export function nearestPass(acquisition: Acquisition, passes: readonly PointPass[]): PointPass | null {
  let best: PointPass | null = null;
  let bestGap = Infinity;
  for (const pass of passes) {
    if (pass.profileId !== acquisition.profileId || normalisePlatform(pass.name) !== acquisition.platform) continue;
    const gap = spanGap(acquisition, { startMs: pass.timeMs, endMs: pass.timeMs });
    if (gap <= PASS_MATCH_TOLERANCE_MS && gap < bestGap) {
      best = pass;
      bestGap = gap;
    }
  }
  return best;
}

const minOf = (values: Array<number | null>) => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.min(...present) : null;
};
const maxOf = (values: Array<number | null>) => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.max(...present) : null;
};

function acquisitionImage(acquisition: Acquisition, box: CropBox): string | null {
  for (const item of acquisition.items) {
    const crop = item.archive === 'planetary-computer' ? planetaryComputerCropUrl(item.collection, item.itemId, box) : null;
    if (crop) return crop;
  }
  return acquisition.items.find((item) => item.previewUrl)?.previewUrl ?? null;
}

const CONDITION_RANK: Record<AcquisitionCondition, number> = { clear: 0, 'not-applicable': 1, unknown: 2, 'cloud-shadow': 3, cloud: 4 };

/** Clear point first, then finer resolution, then higher sun, then the most recent. */
export function compareBestView(a: MatchedAcquisition, b: MatchedAcquisition): number {
  return CONDITION_RANK[a.condition] - CONDITION_RANK[b.condition] ||
    a.resolutionM - b.resolutionM ||
    (b.sunElevationDeg ?? -90) - (a.sunElevationDeg ?? -90) ||
    b.endMs - a.endMs;
}

export function describePointCondition(acquisition: Pick<MatchedAcquisition, 'condition' | 'cloudCoverPct'>): string | null {
  switch (acquisition.condition) {
    case 'clear': return 'clear at this spot';
    case 'cloud': return 'cloud at this spot';
    case 'cloud-shadow': return 'cloud shadow at this spot';
    case 'not-applicable': return null;
    case 'unknown': return acquisition.cloudCoverPct === null ? null : `${Math.round(acquisition.cloudCoverPct)}% cloud in scene`;
  }
}

export interface EvidenceInput {
  lookup: Pick<PointPassLookup, 'point' | 'nowMs' | 'passes'>;
  stac: ReadonlyArray<ArchiveResult<ArchiveItem>>;
  mosaics?: ArchiveResult<DailyMosaicRow>;
  frames?: ReadonlyArray<ArchiveResult<GeostationaryRow>>;
  /** Classification read at the point, by acquisition key. */
  conditions?: ReadonlyMap<string, PointCondition>;
  box?: CropBox;
}

const passKey = (pass: { noradId: number; timeMs: number }) => `${pass.noradId}:${pass.timeMs}`;

/** Attaches archive answers to the passes that produced them and re-decides each pass's tier. */
export function assembleEvidence(input: EvidenceInput): OrbitalEvidence {
  const { lookup } = input;
  const box = input.box ?? cropBox(lookup.point);
  const answered = new Set(input.stac.filter((r) => r.status === 'ok').map((r) => r.archive));
  const items = input.stac.flatMap((r) => (r.status === 'ok' ? r.items : []));
  const matchedItem = new Map<string, string>();
  const acquisitions = groupAcquisitions(items).map((acquisition): MatchedAcquisition => {
    const pass = nearestPass(acquisition, lookup.passes);
    if (pass && !matchedItem.has(passKey(pass))) matchedItem.set(passKey(pass), acquisition.items[0]!.itemId);
    return {
      ...acquisition,
      pass: pass ? { noradId: pass.noradId, timeMs: pass.timeMs } : null,
      condition: isOptical(acquisition.profileId) ? input.conditions?.get(acquisition.key) ?? 'unknown' : 'not-applicable',
      cloudCoverPct: isOptical(acquisition.profileId) ? minOf(acquisition.items.map((i) => i.cloudCoverPct)) : null,
      sunElevationDeg: maxOf(acquisition.items.map((i) => i.sunElevationDeg)),
      resolutionM: Math.min(...acquisition.items.map((i) => i.resolutionM)),
      imageUrl: acquisitionImage(acquisition, box),
    };
  }).sort((a, b) => b.endMs - a.endMs);

  const unansweredProfiles = (Object.keys(PROFILE_ARCHIVES) as ImagingProfileId[])
    .filter((profileId) => !PROFILE_ARCHIVES[profileId].some((archive) => answered.has(archive)));
  const passes = lookup.passes.map((pass): PointPass => {
    const profile = profileFor(pass.profileId);
    const archives = PROFILE_ARCHIVES[pass.profileId as ImagingProfileId];
    if (!profile || !archives) return pass;
    const itemId = matchedItem.get(passKey(pass));
    const answer: ArchiveAnswer = itemId ? { status: 'match', itemId }
      : unansweredProfiles.includes(pass.profileId as ImagingProfileId) ? { status: 'unanswered' }
      : { status: 'no-match' };
    return { ...pass, tier: decidePassTier(pass, profile, answer, lookup.nowMs) };
  });

  const failures = [...input.stac, ...(input.mosaics ? [input.mosaics] : []), ...(input.frames ?? [])]
    .flatMap((r) => (r.status === 'failed' ? [r.failure] : r.failures ?? []));
  const viewable = acquisitions.filter((a) => a.imageUrl);
  return {
    passes,
    acquisitions,
    mosaics: input.mosaics?.status === 'ok' ? input.mosaics.items : [],
    frames: (input.frames ?? []).flatMap((r) => (r.status === 'ok' ? r.items : [])),
    bestView: viewable.length ? [...viewable].sort(compareBestView)[0]! : null,
    status: failures.length ? 'partial' : 'complete',
    failures,
    unansweredProfiles,
  };
}

/** Queries every archive straight from the browser and attaches what they hold to the computed passes. */
export async function findArchiveEvidence(lookup: PointPassLookup, options: ArchiveRequestOptions = {}): Promise<OrbitalEvidence> {
  const point: GeoPoint = lookup.point;
  const window = { startMs: lookup.window.startMs, endMs: Math.min(lookup.window.endMs, lookup.nowMs) };
  const box = cropBox(point);
  const visibleNoradIds = new Set(lookup.satellites.flatMap((s) => (s.status === 'geostationary' && s.visibility.visible ? [s.noradId] : [])));
  const frameQuery = { ...options, point, window, nowMs: lookup.nowMs, box, visibleNoradIds };
  const [earthSearch, planetaryComputer, mosaics, gibsFrames, eumetsatFrames] = await Promise.all([
    searchStacArchive('earth-search', { ...options, point, window }),
    searchStacArchive('planetary-computer', { ...options, point, window }),
    searchGibsDailyMosaics(frameQuery),
    searchGibsGeostationary(frameQuery),
    searchEumetsatGeostationary(frameQuery),
  ]);
  const stac = [earthSearch, planetaryComputer];
  const items = stac.flatMap((r) => (r.status === 'ok' ? r.items : []));
  const conditions = new Map<string, PointCondition>();
  await Promise.all(groupAcquisitions(items).map(async (acquisition) => {
    const classified = acquisition.items.find((item) => item.classification);
    if (classified) conditions.set(acquisition.key, await readPointCondition(classified, point, options));
  }));
  return assembleEvidence({ lookup, stac, mosaics, frames: [gibsFrames, eumetsatFrames], conditions, box });
}
