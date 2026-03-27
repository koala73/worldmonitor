import type {
  ServerContext,
  GetFearGreedIndexRequest,
  GetFearGreedIndexResponse,
  FearGreedCategory,
  FearGreedSectorPerformance,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:fear-greed:v1';

export async function getFearGreedIndex(
  _ctx: ServerContext,
  _req: GetFearGreedIndexRequest,
): Promise<GetFearGreedIndexResponse> {
  try {
    const raw = await getCachedJson(SEED_CACHE_KEY, true) as Record<string, unknown> | null;
    if (!raw?.composite) return { compositeScore: 0, compositeLabel: '', unavailable: true } as GetFearGreedIndexResponse;

    const comp = raw.composite as Record<string, unknown>;
    const cats = (raw.categories ?? {}) as Record<string, Record<string, unknown>>;
    const hdr = (raw.headerMetrics ?? {}) as Record<string, Record<string, unknown> | null>;

    const mapCat = (c: Record<string, unknown> | undefined): FearGreedCategory => ({
      score: Number(c?.score ?? 50),
      weight: Number(c?.weight ?? 0),
      contribution: Number(c?.contribution ?? 0),
      degraded: Boolean(c?.degraded),
      inputsJson: JSON.stringify(c?.inputs ?? {}),
    });

    const rawSectors = (raw.sectorPerformance ?? []) as Array<Record<string, unknown>>;
    const sectorPerformance: FearGreedSectorPerformance[] = rawSectors.map((s) => {
      const c = Number(s.change1d ?? 0);
      return {
        symbol: String(s.symbol ?? ''),
        name: String(s.name ?? ''),
        change1d: Number.isFinite(c) ? c : 0,
      };
    });

    return {
      compositeScore: Number(comp.score ?? 0),
      compositeLabel: String(comp.label ?? ''),
      previousScore: Number(comp.previous ?? 0),
      seededAt: String(raw.timestamp ?? ''),
      sentiment:   mapCat(cats.sentiment),
      volatility:  mapCat(cats.volatility),
      positioning: mapCat(cats.positioning),
      trend:       mapCat(cats.trend),
      breadth:     mapCat(cats.breadth),
      momentum:    mapCat(cats.momentum),
      liquidity:   mapCat(cats.liquidity),
      credit:      mapCat(cats.credit),
      macro:       mapCat(cats.macro),
      crossAsset:  mapCat(cats.crossAsset),
      vix: Number(hdr?.vix?.value ?? 0),
      hySpread: Number(hdr?.hySpread?.value ?? 0),
      yield10y: Number(hdr?.yield10y?.value ?? 0),
      putCallRatio: Number(hdr?.putCall?.value ?? 0),
      pctAbove200d: Number(hdr?.pctAbove200d?.value ?? 0),
      cnnFearGreed: Number(hdr?.cnnFearGreed?.value ?? 0),
      cnnLabel: String(hdr?.cnnFearGreed?.label ?? ''),
      aaiiBull: Number(hdr?.aaiBull?.value ?? 0),
      aaiiBear: Number(hdr?.aaiBear?.value ?? 0),
      fedRate: String(hdr?.fedRate?.value ?? ''),
      fsiValue: Number(hdr?.fsi?.value ?? 0),
      fsiLabel: String(hdr?.fsi?.label ?? ''),
      hygPrice: Number(hdr?.fsi?.hygPrice ?? 0),
      tltPrice: Number(hdr?.fsi?.tltPrice ?? 0),
      sectorPerformance,
      unavailable: false,
    };
  } catch {
    return { compositeScore: 0, compositeLabel: '', unavailable: true } as GetFearGreedIndexResponse;
  }
}
