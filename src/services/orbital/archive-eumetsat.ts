import { failed, requestArchive, type ArchiveRequestOptions, type ArchiveResult } from './archive-result';
import { layerFailures, GEOSTATIONARY_LOOKBACK_MS, parseTimeDomain, timesWithin, type FrameQuery, type GeostationaryRow, type LayerTimes } from './archive-gibs';
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
  const reply = await requestArchive('eumetsat', url, {}, options, async (response) => {
    const dimension = /<Dimension[^>]*name="time"[^>]*>([^<]*)<\/Dimension>/i.exec(await response.text());
    if (!dimension) throw new TypeError('no time dimension');
    return parseTimeDomain(dimension[1]!);
  });
  if (!reply.ok) return { ok: false, failure: { ...reply.failure, source: layer.source } };
  const ranges = reply.value;
  return { ok: true, times: timesWithin(ranges, fromMs, toMs), stepMs: ranges[ranges.length - 1]?.stepMs ?? null };
}

export async function searchEumetsatGeostationary(query: FrameQuery & { visibleNoradIds: ReadonlySet<number> }): Promise<ArchiveResult<GeostationaryRow>> {
  const layers = EUMETSAT_GEOSTATIONARY.filter((layer) => query.visibleNoradIds.has(layer.noradId));
  const box = query.box ?? cropBox(query.point);
  const answers = await Promise.all(layers.map((layer) => layerTimes(layer, query.nowMs - GEOSTATIONARY_LOOKBACK_MS, query.nowMs, query)));
  const { failures, allFailed } = layerFailures(answers);
  if (allFailed) return failed(failures[0]!);
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
  return { status: 'ok', archive: 'eumetsat', items, failures };
}
