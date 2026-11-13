import { failed, requestArchive, type ArchiveRequestOptions, type ArchiveResult } from './archive-result';
import { allFailedOf, GEOSTATIONARY_LOOKBACK_MS, parseTimeDomain, timesWithin, type FrameQuery, type GeostationaryRow, type LayerTimes } from './archive-gibs';
import { cropBox, eumetsatSnapshotUrl } from './crop-url';

const EUMETSAT_GEOSERVER = 'https://view.eumetsat.int/geoserver';

interface EumetsatLayer {
  source: string;
  workspace: string;
  layer: string;
  noradId: number;
}

export const EUMETSAT_GEOSTATIONARY: readonly EumetsatLayer[] = [
  { source: 'Meteosat-12', workspace: 'mtg_fd', layer: 'rgb_geocolour', noradId: 54743 },
];

const isoSecond = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** Reads the layer's time extent from its own capabilities document, which carries no point. */
async function layerTimes(layer: EumetsatLayer, fromMs: number, toMs: number, options: ArchiveRequestOptions): Promise<LayerTimes> {
  const url = `${EUMETSAT_GEOSERVER}/${layer.workspace}/${layer.layer}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
  const reply = await requestArchive('eumetsat', url, {}, options);
  if (!reply.ok) return reply;
  try {
    const text = await reply.response.text();
    const dimension = /<Dimension[^>]*name="time"[^>]*>([^<]*)<\/Dimension>/i.exec(text);
    if (!dimension) return { ok: false, failure: { archive: 'eumetsat', reason: 'invalid-response' } };
    const ranges = parseTimeDomain(dimension[1]!);
    return { ok: true, times: timesWithin(ranges, fromMs, toMs), stepMs: ranges[ranges.length - 1]?.stepMs ?? null };
  } catch {
    return { ok: false, failure: { archive: 'eumetsat', reason: 'invalid-response' } };
  }
}

export async function searchEumetsatGeostationary(query: FrameQuery & { visibleNoradIds: ReadonlySet<number> }): Promise<ArchiveResult<GeostationaryRow>> {
  const layers = EUMETSAT_GEOSTATIONARY.filter((layer) => query.visibleNoradIds.has(layer.noradId));
  const box = query.box ?? cropBox(query.point);
  const answers = await Promise.all(layers.map((layer) => layerTimes(layer, query.nowMs - GEOSTATIONARY_LOOKBACK_MS, query.nowMs, query)));
  const allFailed = allFailedOf(answers);
  if (allFailed) return failed(allFailed);
  const items = layers.map((layer, i): GeostationaryRow => {
    const answer = answers[i]!;
    const latestMs = answer.ok ? answer.times[answer.times.length - 1] : undefined;
    const wmsLayer = `${layer.workspace}:${layer.layer}`;
    return {
      kind: 'geostationary',
      archive: 'eumetsat',
      source: layer.source,
      layer: wmsLayer,
      noradId: layer.noradId,
      cadenceMinutes: !answer.ok || answer.stepMs === null ? null : answer.stepMs / 60_000,
      latest: latestMs === undefined ? null : { time: isoSecond(latestMs), imageUrl: eumetsatSnapshotUrl(wmsLayer, isoSecond(latestMs), box) },
    };
  });
  return { status: 'ok', archive: 'eumetsat', items };
}
