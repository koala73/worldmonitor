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
import type { PassJobResult, PointPass } from './pass-job';
import type { PassWindow } from './pass-query';
import { profileFor } from './pass-query';

/** The parts of a point lookup evidence needs; pass-client is not imported so server bundles stay clear of the browser catalog loader. */
export interface PointPassLookup extends PassJobResult {
  point: GeoPoint;
  window: PassWindow;
  nowMs: number;
}

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
  /** May carry the point: paint it through `loadArchiveImage`, never straight into `img.src`. */
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
    // Planetary Computer holds the same Sentinel-1 GRD products under the same IDs, so radar is cropped there too.
    const crop = item.archive === 'planetary-computer' || item.profileId === 'sentinel-1'
      ? planetaryComputerCropUrl(item.collection, item.itemId, box)
      : null;
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
    case 'unknown': return acquisition.cloudCoverPct === null ? 'this spot not checked for cloud' : `${Math.round(acquisition.cloudCoverPct)}% cloud across the scene, this spot not checked`;
  }
}

export interface EvidenceInput {
  lookup: Pick<PointPassLookup, 'point' | 'nowMs' | 'passes'>;
  stac: ReadonlyArray<ArchiveResult<ArchiveItem>>;
  mosaics?: ArchiveResult<DailyMosaicRow>;
  frames?: ReadonlyArray<ArchiveResult<GeostationaryRow>>;
  /** Classification read at the point, by acquisition key. */
  conditions?: ReadonlyMap<string, PointCondition>;
  conditionFailures?: readonly ArchiveFailure[];
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

  // Mirrors ingest at different speeds, so "no image" needs every archive for the mission to have answered.
  const unansweredProfiles = (Object.keys(PROFILE_ARCHIVES) as ImagingProfileId[])
    .filter((profileId) => !PROFILE_ARCHIVES[profileId].every((archive) => answered.has(archive)));
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
    .flatMap((r) => (r.status === 'failed' ? [r.failure] : r.failures ?? []))
    .concat(input.conditionFailures ?? []);
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

export type ArchiveSearchId = 'earth-search' | 'planetary-computer' | 'gibs-daily-mosaics' | 'gibs-geostationary' | 'eumetsat';

export const ARCHIVE_SEARCHES: readonly ArchiveSearchId[] = ['earth-search', 'planetary-computer', 'gibs-daily-mosaics', 'gibs-geostationary', 'eumetsat'];

export interface EvidenceProgress {
  evidence: OrbitalEvidence;
  settled: ArchiveSearchId[];
  /** Missions with an archive still searching, so their passes are not in their final tier yet. */
  pendingProfiles: ImagingProfileId[];
}

export interface ArchiveEvidenceOptions extends ArchiveRequestOptions {
  /** Called with a partial result each time one archive search settles. */
  onProgress?: (progress: EvidenceProgress) => void;
}

/** Queries every archive straight from the browser and attaches what they hold to the computed passes. */
export async function findArchiveEvidence(lookup: PointPassLookup, options: ArchiveEvidenceOptions = {}): Promise<OrbitalEvidence> {
  const { onProgress, ...requestOptions } = options;
  const point: GeoPoint = lookup.point;
  const window = { startMs: lookup.window.startMs, endMs: Math.min(lookup.window.endMs, lookup.nowMs) };
  const box = cropBox(point);
  const visibleNoradIds = new Set(lookup.satellites.flatMap((s) => (s.status === 'geostationary' && s.visibility.visible ? [s.noradId] : [])));
  const frameQuery = { ...requestOptions, point, window, nowMs: lookup.nowMs, box, visibleNoradIds };

  const stacById = new Map<StacArchiveId, ArchiveResult<ArchiveItem>>();
  let mosaics: ArchiveResult<DailyMosaicRow> | undefined;
  const frames = new Map<ArchiveSearchId, ArchiveResult<GeostationaryRow>>();
  const settled: ArchiveSearchId[] = [];
  const snapshot = () => ({ lookup, stac: [...stacById.values()], mosaics, frames: [...frames.values()], box });
  const settle = <T>(id: ArchiveSearchId, search: Promise<T>, store: (result: T) => void) => search.then((result) => {
    store(result);
    settled.push(id);
    if (!onProgress) return;
    const pendingProfiles = (Object.keys(PROFILE_ARCHIVES) as ImagingProfileId[])
      .filter((profileId) => PROFILE_ARCHIVES[profileId].some((archive) => !stacById.has(archive)));
    onProgress({ evidence: assembleEvidence(snapshot()), settled: [...settled], pendingProfiles });
  });

  await Promise.all([
    settle('earth-search', searchStacArchive('earth-search', { ...requestOptions, point, window }), (r) => stacById.set('earth-search', r)),
    settle('planetary-computer', searchStacArchive('planetary-computer', { ...requestOptions, point, window }), (r) => stacById.set('planetary-computer', r)),
    settle('gibs-daily-mosaics', searchGibsDailyMosaics(frameQuery), (r) => { mosaics = r; }),
    settle('gibs-geostationary', searchGibsGeostationary(frameQuery), (r) => frames.set('gibs-geostationary', r)),
    settle('eumetsat', searchEumetsatGeostationary(frameQuery), (r) => frames.set('eumetsat', r)),
  ]);
  const stac = (['earth-search', 'planetary-computer'] as const).map((id) => stacById.get(id)!);
  const items = stac.flatMap((r) => (r.status === 'ok' ? r.items : []));
  const conditions = new Map<string, PointCondition>();
  const conditionFailures: ArchiveFailure[] = [];
  await Promise.all(groupAcquisitions(items).map(async (acquisition) => {
    const classified = acquisition.items.find((item) => item.classification);
    if (!classified) return;
    const reading = await readPointCondition(classified, point, requestOptions);
    conditions.set(acquisition.key, reading.condition);
    if (reading.failure) conditionFailures.push(reading.failure);
  }));
  return assembleEvidence({ lookup, stac, mosaics, frames: [frames.get('gibs-geostationary')!, frames.get('eumetsat')!], conditions, conditionFailures, box });
}
