import type { AppContext } from '@/app/app-context';
import type {
  DomainAdapter,
  SignalEvidence,
  ConvergenceCard,
  ClusterState,
  TrendDirection,
} from './types';
import { haversineKm } from '@/utils/distance';
import { IntelligenceServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

const LLM_SCORE_THRESHOLD = 60;
const LLM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const LLM_MAX_CONCURRENT = 3;

interface LlmCacheEntry {
  assessment: string;
  timestamp: number;
}

export class CorrelationEngine {
  private adapters: DomainAdapter[] = [];
  private cards: Map<string, ConvergenceCard[]> = new Map();
  private previousClusters: Map<string, ClusterState[]> = new Map();
  private llmCache: Map<string, LlmCacheEntry> = new Map();
  private intelligenceClient: IntelligenceServiceClient;
  private running = false;
  private llmInFlight = 0;

  constructor() {
    // Use '' base URL — requests go to current origin, same as other panels
    this.intelligenceClient = new IntelligenceServiceClient('');
  }

  registerAdapter(adapter: DomainAdapter): void {
    this.adapters.push(adapter);
    this.cards.set(adapter.domain, []);
    this.previousClusters.set(adapter.domain, []);
  }

  async run(ctx: AppContext): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.pruneLlmCache();
      const t0 = performance.now();

      for (const adapter of this.adapters) {
        const signals = adapter.collectSignals(ctx);
        const clusters = this.clusterSignals(signals, adapter);
        const scored = this.scoreClusters(clusters, adapter);
        const filtered = scored.filter(c => c.score >= adapter.threshold);
        const withTrend = this.applyTrends(filtered, adapter);
        const cards = withTrend.map(c => this.toCard(c, adapter));

        // Sort descending by score
        cards.sort((a, b) => b.score - a.score);
        this.cards.set(adapter.domain, cards);

        // Save cluster state for next cycle trend detection
        this.previousClusters.set(
          adapter.domain,
          withTrend.map(c => c.state),
        );

        // Queue LLM assessments (non-blocking)
        this.queueLlmAssessments(cards, adapter);
      }

      const elapsed = performance.now() - t0;
      if (elapsed > 100) {
        console.warn(`[CorrelationEngine] run() took ${elapsed.toFixed(0)}ms (>100ms target)`);
      }

      document.dispatchEvent(new CustomEvent('wm:correlation-updated', {
        detail: { domains: this.adapters.map(a => a.domain) },
      }));
    } finally {
      this.running = false;
    }
  }

  getCards(domain: string): ConvergenceCard[] {
    return this.cards.get(domain) ?? [];
  }

  // ── Clustering ──────────────────────────────────────────────

  private clusterSignals(
    signals: SignalEvidence[],
    adapter: DomainAdapter,
  ): SignalCluster[] {
    if (signals.length === 0) return [];

    switch (adapter.clusterMode) {
      case 'country':
        return this.clusterByCountry(signals);
      case 'entity':
        return this.clusterByEntity(signals);
      case 'geographic':
      default:
        return this.clusterByProximity(signals, adapter.spatialRadius);
    }
  }

  private clusterByCountry(signals: SignalEvidence[]): SignalCluster[] {
    const byCountry = new Map<string, SignalEvidence[]>();
    for (const s of signals) {
      if (!s.country) continue;
      const list = byCountry.get(s.country) ?? [];
      list.push(s);
      byCountry.set(s.country, list);
    }
    const clusters: SignalCluster[] = [];
    for (const [country, sigs] of byCountry) {
      if (sigs.length < 2) continue;
      clusters.push({ signals: sigs, country });
    }
    return clusters;
  }

  private clusterByEntity(signals: SignalEvidence[]): SignalCluster[] {
    // Compound patterns checked first to avoid false positives from ambiguous
    // single words ("bank" → "river bank", "reserve" → "nature reserve")
    const COMPOUND_PATTERNS = [
      'supply chain', 'rare earth', 'central bank', 'interest rate',
      'trade war', 'oil price', 'gas price', 'federal reserve',
    ];
    const SINGLE_KEYS = new Set([
      'oil', 'gas', 'sanctions', 'trade', 'tariff', 'commodity', 'currency',
      'energy', 'wheat', 'crude', 'gold', 'silver', 'copper', 'bitcoin',
      'crypto', 'inflation', 'embargo', 'opec', 'semiconductor', 'dollar',
      'yuan', 'euro',
    ]);
    const tokenMap = new Map<string, SignalEvidence[]>();

    for (const s of signals) {
      const lower = s.label.toLowerCase();
      // Try compound patterns first
      let matchedKey = COMPOUND_PATTERNS.find(p => lower.includes(p));
      if (!matchedKey) {
        const words = lower.split(/\W+/);
        matchedKey = words.find(w => SINGLE_KEYS.has(w));
      }
      if (!matchedKey) continue; // drop unmatched signals to avoid false convergence
      const key = matchedKey;
      const list = tokenMap.get(key) ?? [];
      list.push(s);
      tokenMap.set(key, list);
    }

    const clusters: SignalCluster[] = [];
    for (const [key, sigs] of tokenMap) {
      if (sigs.length < 2) continue;
      clusters.push({ signals: sigs, entityKey: key });
    }
    return clusters;
  }

  private clusterByProximity(
    signals: SignalEvidence[],
    radiusKm: number,
  ): SignalCluster[] {
    // Grid-based spatial indexing + union-find: O(n * k) where k = avg signals per cell
    const DEG_PER_KM_LAT = 1 / 111;
    const cellSizeLat = radiusKm * DEG_PER_KM_LAT;

    // Union-Find with path compression
    const parent: number[] = signals.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
      return i;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    // Index valid signals into spatial grid
    const grid = new Map<string, number[]>();
    const validIndices: number[] = [];
    for (let i = 0; i < signals.length; i++) {
      const s = signals[i]!;
      if (s.lat == null || s.lon == null) continue;
      validIndices.push(i);
      const cellRow = Math.floor(s.lat / cellSizeLat);
      const cosLat = Math.cos(s.lat * Math.PI / 180);
      const cellSizeLon = cosLat > 0.01 ? cellSizeLat / cosLat : cellSizeLat;
      const cellCol = Math.floor(s.lon / cellSizeLon);
      const key = `${cellRow}:${cellCol}`;
      const list = grid.get(key);
      if (list) list.push(i); else grid.set(key, [i]);
    }

    // Check 3x3 neighborhood for each cell
    for (const [key, indices] of grid) {
      const sep = key.indexOf(':');
      const row = Number(key.slice(0, sep));
      const col = Number(key.slice(sep + 1));
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const neighbors = grid.get(`${row + dr}:${col + dc}`);
          if (!neighbors) continue;
          for (const i of indices) {
            const si = signals[i]!;
            for (const j of neighbors) {
              if (i >= j) continue;
              const sj = signals[j]!;
              if (haversineKm(si.lat!, si.lon!, sj.lat!, sj.lon!) <= radiusKm) {
                union(i, j);
              }
            }
          }
        }
      }
    }

    // Collect clusters from union-find roots
    const clusterMap = new Map<number, SignalEvidence[]>();
    for (const i of validIndices) {
      const root = find(i);
      const list = clusterMap.get(root);
      if (list) list.push(signals[i]!); else clusterMap.set(root, [signals[i]!]);
    }

    const clusters: SignalCluster[] = [];
    for (const sigs of clusterMap.values()) {
      if (sigs.length >= 2) {
        clusters.push({ signals: sigs });
      }
    }
    return clusters;
  }

  // ── Scoring ─────────────────────────────────────────────────

  private scoreClusters(
    clusters: SignalCluster[],
    adapter: DomainAdapter,
  ): ScoredCluster[] {
    return clusters.map(cluster => {
      // Aggregate max severity per signal type
      const perType = new Map<string, number>();
      for (const s of cluster.signals) {
        const current = perType.get(s.type) ?? 0;
        perType.set(s.type, Math.max(current, s.severity));
      }

      // Weighted sum of per-type maxima
      let weightedSum = 0;
      for (const [type, severity] of perType) {
        const weight = adapter.weights[type] ?? 0;
        weightedSum += severity * weight;
      }

      // Diversity bonus (capped at 30)
      const uniqueTypes = perType.size;
      const diversityBonus = Math.min(30, Math.max(0, (uniqueTypes - 2)) * 12);
      const finalScore = Math.min(100, weightedSum + diversityBonus);

      // Compute centroid for geographic clusters
      // Longitude uses circular mean (atan2 of unit-circle components) to
      // handle the antimeridian correctly — arithmetic mean of 179° and -179°
      // would give 0° instead of ±180°.
      let centroidLat: number | undefined;
      let centroidLon: number | undefined;
      const geoSignals = cluster.signals.filter(s => s.lat != null && s.lon != null);
      if (geoSignals.length > 0) {
        centroidLat = geoSignals.reduce((sum, s) => sum + s.lat!, 0) / geoSignals.length;
        const toRad = Math.PI / 180;
        const toDeg = 180 / Math.PI;
        let sinSum = 0, cosSum = 0;
        for (const s of geoSignals) {
          sinSum += Math.sin(s.lon! * toRad);
          cosSum += Math.cos(s.lon! * toRad);
        }
        centroidLon = Math.atan2(sinSum, cosSum) * toDeg;
      }

      // Collect unique countries
      const countries = [...new Set(cluster.signals.map(s => s.country).filter(Boolean) as string[])];

      const state: ClusterState = {
        key: cluster.country ?? cluster.entityKey ?? `${centroidLat?.toFixed(1)},${centroidLon?.toFixed(1)}`,
        centroidLat,
        centroidLon,
        country: cluster.country,
        entityKey: cluster.entityKey,
        score: finalScore,
        timestamp: Date.now(),
      };

      return { cluster, score: finalScore, countries, centroidLat, centroidLon, state };
    });
  }

  // ── Trend Detection ─────────────────────────────────────────

  private applyTrends(
    scored: ScoredCluster[],
    adapter: DomainAdapter,
  ): ScoredClusterWithTrend[] {
    const previous = this.previousClusters.get(adapter.domain) ?? [];
    const halfRadius = adapter.spatialRadius / 2;

    return scored.map(sc => {
      let trend: TrendDirection = 'stable';

      const match = previous.find(prev => {
        if (sc.state.country && prev.country) return sc.state.country === prev.country;
        if (sc.state.entityKey && prev.entityKey) return sc.state.entityKey === prev.entityKey;
        if (sc.centroidLat != null && sc.centroidLon != null &&
            prev.centroidLat != null && prev.centroidLon != null) {
          return haversineKm(sc.centroidLat, sc.centroidLon, prev.centroidLat, prev.centroidLon) <= halfRadius;
        }
        return false;
      });

      if (match) {
        const delta = sc.score - match.score;
        if (delta > 5) trend = 'escalating';
        else if (delta < -5) trend = 'de-escalating';
      }

      return { ...sc, trend };
    });
  }

  // ── Card Generation ─────────────────────────────────────────

  private toCard(
    sc: ScoredClusterWithTrend,
    adapter: DomainAdapter,
  ): ConvergenceCard {
    const title = adapter.generateTitle(sc.cluster.signals, {
      entityKey: sc.cluster.entityKey,
      country: sc.cluster.country,
    });
    const location = sc.centroidLat != null && sc.centroidLon != null
      ? { lat: sc.centroidLat, lon: sc.centroidLon, label: sc.state.key }
      : undefined;

    return {
      id: `${adapter.domain}:${sc.state.key}`,
      domain: adapter.domain,
      title,
      score: Math.round(sc.score),
      signals: sc.cluster.signals,
      location,
      countries: sc.countries,
      trend: sc.trend,
      timestamp: Date.now(),
    };
  }

  // ── LLM Assessment ─────────────────────────────────────────

  private queueLlmAssessments(cards: ConvergenceCard[], adapter: DomainAdapter): void {
    const pending: Array<{ card: ConvergenceCard; cacheKey: string }> = [];
    for (const card of cards) {
      if (card.score < LLM_SCORE_THRESHOLD) continue;

      const cacheKey = this.llmCacheKey(card);
      const cached = this.llmCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < LLM_CACHE_TTL_MS) {
        card.assessment = cached.assessment;
        continue;
      }

      pending.push({ card, cacheKey });
    }

    for (const { card, cacheKey } of pending) {
      if (this.llmInFlight >= LLM_MAX_CONCURRENT) break;
      this.llmInFlight++;
      void this.fetchAssessment(card, adapter, cacheKey).finally(() => { this.llmInFlight--; });
    }
  }

  private llmCacheKey(card: ConvergenceCard): string {
    const types = [...new Set(card.signals.map(s => s.type))].sort().join(',');
    const loc = card.countries.sort().join(',') || card.location?.label || 'global';
    // Include score bucket (10-point granularity) to avoid cache collisions
    // between clusters with same domain+types+location but different signal counts
    const scoreBucket = Math.floor(card.score / 10) * 10;
    return `${card.domain}:${types}:${loc}:s${scoreBucket}`;
  }

  private async fetchAssessment(
    card: ConvergenceCard,
    adapter: DomainAdapter,
    cacheKey: string,
  ): Promise<void> {
    try {
      const signalSummary = card.signals
        .map(s => `- [${s.type}] ${s.label} (severity: ${s.severity})`)
        .join('\n');

      const domainLabels: Record<string, string> = {
        military: 'military force posture and strike packaging',
        escalation: 'conflict escalation dynamics',
        economic: 'economic warfare and sanctions impact',
        disaster: 'cascading disaster and infrastructure failure',
      };

      const query = `Analyze this ${domainLabels[adapter.domain] ?? adapter.domain} convergence pattern. ` +
        `${card.signals.length} signals detected in ${card.countries.join(', ') || card.location?.label || 'region'}:\n${signalSummary}\n\n` +
        `Convergence score: ${card.score}/100. Trend: ${card.trend}. ` +
        `What does this pattern indicate? Assess likelihood and potential implications in 2-3 sentences.`;

      const geoContext = card.countries.length > 0
        ? `Countries: ${card.countries.join(', ')}`
        : card.location
          ? `Location: ${card.location.label} (${card.location.lat.toFixed(2)}, ${card.location.lon.toFixed(2)})`
          : '';

      const resp = await this.intelligenceClient.deductSituation({ query, geoContext });

      if (resp.analysis) {
        card.assessment = resp.analysis;
        this.llmCache.set(cacheKey, { assessment: resp.analysis, timestamp: Date.now() });

        document.dispatchEvent(new CustomEvent('wm:correlation-updated', {
          detail: { domains: [adapter.domain], assessmentUpdate: true },
        }));
      }
    } catch (err) {
      console.warn(`[CorrelationEngine] LLM assessment failed for ${card.domain}:`, err);
    }
  }

  pruneLlmCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.llmCache) {
      if (now - entry.timestamp > LLM_CACHE_TTL_MS) {
        this.llmCache.delete(key);
      }
    }
  }
}

// Internal types
interface SignalCluster {
  signals: SignalEvidence[];
  country?: string;
  entityKey?: string;
}

interface ScoredCluster {
  cluster: SignalCluster;
  score: number;
  countries: string[];
  centroidLat?: number;
  centroidLon?: number;
  state: ClusterState;
}

interface ScoredClusterWithTrend extends ScoredCluster {
  trend: TrendDirection;
}
