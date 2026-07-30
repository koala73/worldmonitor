import type {
  InfrastructureNode,
  DependencyEdge,
  CascadeResult,
  UnderseaCable,
  Pipeline,
  Port,
} from '@/types';
import { STRATEGIC_WATERWAYS } from '@/config/geo';
import {
  buildDependencyGraph as buildCascadeGraph,
  calculateCascade as calculateCascadeCore,
  getGraphStats as getCascadeGraphStats,
  getPipelineById as getPipelineByIdCore,
  getPortById as getPortByIdCore,
  type DependencyGraph as CascadeGraph,
} from '../../shared/analysis-infrastructure-cascade';

export interface DependencyGraph {
  nodes: Map<string, InfrastructureNode>;
  edges: DependencyEdge[];
  outgoing: Map<string, DependencyEdge[]>;
  incoming: Map<string, DependencyEdge[]>;
}

let cachedGraph: CascadeGraph | null = null;

export function clearGraphCache(): void {
  cachedGraph = null;
}

// UNDERSEA_CABLES (~130KB) lives in the lazy geo-map chunk. infrastructure-cascade
// is reached eagerly via country-intel, so a static import would pin it to the
// entry chunk. Lazy-cache: the graph builds without cables until the import
// resolves, then clearGraphCache() forces a rebuild with cables on the next call.
// A failed import leaves the cache empty so the next entry retries (no permanent
// suppression — same pattern as related-assets).
let cablesData: UnderseaCable[] = [];
let cablesPromise: Promise<void> | null = null;

// Await this before building the graph when cables must be present (e.g. the
// cascade panel, which visualizes cable dependencies). The sync graph entry
// points below also trigger the load via ensureCables() and self-heal on the
// next call once it resolves.
export function preloadCables(): Promise<void> {
  if (cablesData.length > 0) return Promise.resolve();
  if (!cablesPromise) {
    cablesPromise = import('@/config/geo-map')
      .then(({ UNDERSEA_CABLES }) => {
        cablesData = UNDERSEA_CABLES;
        clearGraphCache();
      })
      .catch((error) => {
        cablesPromise = null;
        throw error;
      });
  }
  return cablesPromise;
}

function ensureCables(): void {
  void preloadCables().catch(() => {});
}

// The graph build + cascade scoring live in shared/analysis-infrastructure-cascade
// so the same computation can run server-side. This module owns only the client
// glue: the lazy cable table, the cached graph, and the strategic waterways.
function resolveGraph(): CascadeGraph {
  ensureCables();
  if (cachedGraph) return cachedGraph;

  cachedGraph = buildCascadeGraph({
    cables: cablesData,
    waterways: STRATEGIC_WATERWAYS,
  });
  return cachedGraph;
}

export function buildDependencyGraph(): DependencyGraph {
  return resolveGraph();
}

export function calculateCascade(
  sourceId: string,
  disruptionLevel: number = 1.0
): CascadeResult | null {
  return calculateCascadeCore(resolveGraph(), sourceId, disruptionLevel);
}

export function getCableById(id: string): UnderseaCable | undefined {
  ensureCables();
  return cablesData.find(c => c.id === id);
}

export function getPipelineById(id: string): Pipeline | undefined {
  return getPipelineByIdCore(id);
}

export function getPortById(id: string): Port | undefined {
  return getPortByIdCore(id);
}

export function getGraphStats(): { nodes: number; edges: number; cables: number; pipelines: number; ports: number; chokepoints: number; countries: number } {
  return getCascadeGraphStats(resolveGraph());
}
