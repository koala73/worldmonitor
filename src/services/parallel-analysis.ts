/**
 * Parallel Analysis Service
 * Runs browser-based ML alongside API summarization
 * Multiple "perspectives" score headlines independently
 * Logs analysis to console for comparison & improvement
 */

import { mlWorker } from './ml-worker';
import type { ClusteredEvent } from '@/types';

interface NEREntity {
  text: string;
  type: string;
  confidence: number;
}

export interface PerspectiveScore {
  name: string;
  score: number;
  confidence: number;
  reasoning: string;
}

export interface AnalyzedHeadline {
  id: string;
  title: string;
  sourceCount: number;
  perspectives: PerspectiveScore[];
  finalScore: number;
  confidence: number;
  disagreement: number;
  flagged: boolean;
  flagReason?: string;
}

export interface AnalysisReport {
  timestamp: number;
  totalHeadlines: number;
  analyzed: AnalyzedHeadline[];
  topByConsensus: AnalyzedHeadline[];
  topByDisagreement: AnalyzedHeadline[];
  missedByKeywords: AnalyzedHeadline[];
  perspectiveCorrelations: Record<string, number>;
}

const VIOLENCE_KEYWORDS = [
  'killed', 'dead', 'death', 'shot', 'blood', 'massacre', 'slaughter',
  'fatalities', 'casualties', 'wounded', 'injured', 'murdered', 'execution',
  'crackdown', 'violent', 'clashes', 'gunfire', 'shooting',
];

const MILITARY_KEYWORDS = [
  'war', 'armada', 'invasion', 'airstrike', 'strike', 'missile', 'troops',
  'deployed', 'offensive', 'artillery', 'bomb', 'combat', 'fleet', 'warship',
  'carrier', 'navy', 'airforce', 'deployment', 'mobilization', 'attack',
];

const UNREST_KEYWORDS = [
  'protest', 'protests', 'uprising', 'revolt', 'revolution', 'riot', 'riots',
  'demonstration', 'unrest', 'dissent', 'rebellion', 'insurgent', 'overthrow',
  'coup', 'martial law', 'curfew', 'shutdown', 'blackout',
];

const FLASHPOINT_KEYWORDS = [
  'iran', 'tehran', 'russia', 'moscow', 'china', 'beijing', 'taiwan', 'ukraine', 'kyiv',
  'north korea', 'pyongyang', 'israel', 'gaza', 'west bank', 'syria', 'damascus',
  'yemen', 'hezbollah', 'hamas', 'kremlin', 'pentagon', 'nato', 'wagner',
];

const BUSINESS_DEMOTE = [
  'ceo', 'earnings', 'stock', 'startup', 'data center', 'datacenter', 'revenue',
  'quarterly', 'profit', 'investor', 'ipo', 'funding', 'valuation',
];

class ParallelAnalysisService {
  private lastReport: AnalysisReport | null = null;
  private recentEmbeddings: Map<string, number[]> = new Map();
  private analysisCount = 0;

  async analyzeHeadlines(clusters: ClusteredEvent[]): Promise<AnalysisReport> {
    const startTime = performance.now();
    this.analysisCount++;

    console.group(`%c🔬 Parallel Analysis #${this.analysisCount}`, 'color: #6b8afd; font-weight: bold; font-size: 14px');

    const analyzed: AnalyzedHeadline[] = [];
    const titles = clusters.map(c => c.primaryTitle);

    let sentiments: Array<{ label: string; score: number }> | null = null;
    let entities: NEREntity[][] | null = null;
    let embeddings: number[][] | null = null;

    if (mlWorker.isAvailable) {
      const [s, e, emb] = await Promise.all([
        mlWorker.classifySentiment(titles).catch(() => null),
        mlWorker.extractEntities(titles).catch(() => null),
        this.getEmbeddings(titles).catch(() => null),
      ]);
      sentiments = s;
      entities = e;
      embeddings = emb;
    }

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i]!;
      const title = cluster.primaryTitle;
      const titleLower = title.toLowerCase();

      const perspectives: PerspectiveScore[] = [];

      perspectives.push(this.scoreByKeywords(titleLower, cluster));

      const sentiment = sentiments?.[i];
      if (sentiment) {
        perspectives.push(this.scoreBySentiment(sentiment));
      }

      const entityList = entities?.[i];
      if (entityList) {
        perspectives.push(this.scoreByEntities(entityList));
      }

      const embedding = embeddings?.[i];
      if (embedding) {
        perspectives.push(await this.scoreByNovelty(title, embedding));
      }

      perspectives.push(this.scoreByVelocity(cluster));
      perspectives.push(this.scoreBySourceDiversity(cluster));

      const { finalScore, confidence, disagreement } = this.aggregateScores(perspectives);

      const flagged = disagreement > 0.3 || (finalScore > 0.5 && this.isLowKeywordScore(perspectives));
      const flagReason = flagged
        ? disagreement > 0.3
          ? 'High disagreement between perspectives'
          : 'ML scores high but keyword score low - potential missed story'
        : undefined;

      analyzed.push({
        id: cluster.id,
        title,
        sourceCount: cluster.sourceCount,
        perspectives,
        finalScore,
        confidence,
        disagreement,
        flagged,
        flagReason,
      });
    }

    analyzed.sort((a, b) => b.finalScore - a.finalScore);

    const topByConsensus = analyzed
      .filter(a => a.confidence > 0.6)
      .slice(0, 10);

    const topByDisagreement = analyzed
      .filter(a => a.disagreement > 0.25)
      .sort((a, b) => b.disagreement - a.disagreement)
      .slice(0, 5);

    const missedByKeywords = analyzed
      .filter(a => {
        const keywordScore = a.perspectives.find(p => p.name === 'keywords')?.score ?? 0;
        const mlAvg = a.perspectives
          .filter(p => p.name !== 'keywords')
          .reduce((sum, p) => sum + p.score, 0) / Math.max(1, a.perspectives.length - 1);
        return mlAvg > 0.5 && keywordScore < 0.3;
      })
      .slice(0, 5);

    const correlations = this.calculateCorrelations(analyzed);

    const report: AnalysisReport = {
      timestamp: Date.now(),
      totalHeadlines: clusters.length,
      analyzed,
      topByConsensus,
      topByDisagreement,
      missedByKeywords,
      perspectiveCorrelations: correlations,
    };

    this.lastReport = report;
    this.logReport(report, performance.now() - startTime);
    console.groupEnd();

    return report;
  }

  private scoreByKeywords(titleLower: string, _cluster: ClusteredEvent): PerspectiveScore {
    let score = 0;
    const reasons: string[] = [];

    const violence = VIOLENCE_KEYWORDS.filter(kw => titleLower.includes(kw));
    if (violence.length > 0) {
      score += 0.4 + violence.length * 0.1;
      reasons.push(`violence(${violence.join(',')})`);
    }

    const military = MILITARY_KEYWORDS.filter(kw => titleLower.includes(kw));
    if (military.length > 0) {
      score += 0.3 + military.length * 0.08;
      reasons.push(`military(${military.join(',')})`);
    }

    const unrest = UNREST_KEYWORDS.filter(kw => titleLower.includes(kw));
    if (unrest.length > 0) {
      score += 0.25 + unrest.length * 0.07;
      reasons.push(`unrest(${unrest.join(',')})`);
    }

    const flashpoint = FLASHPOINT_KEYWORDS.filter(kw => titleLower.includes(kw));
    if (flashpoint.length > 0) {
      score += 0.2 + flashpoint.length * 0.05;
      reasons.push(`flashpoint(${flashpoint.join(',')})`);
    }

    if ((violence.length > 0 || unrest.length > 0) && flashpoint.length > 0) {
      score *= 1.3;
      reasons.push('combo-bonus');
    }

    const business = BUSINESS_DEMOTE.filter(kw => titleLower.includes(kw));
    if (business.length > 0) {
      score *= 0.4;
      reasons.push(`demoted(${business.join(',')})`);
    }

    score = Math.min(1, score);

    return {
      name: 'keywords',
      score,
      confidence: 0.8,
      reasoning: reasons.length > 0 ? reasons.join(' + ') : 'no keywords matched',
    };
  }

  private scoreBySentiment(sentiment: { label: string; score: number }): PerspectiveScore {
    const isNegative = sentiment.label === 'negative';
    const score = isNegative ? sentiment.score * 0.8 : (1 - sentiment.score) * 0.3;

    return {
      name: 'sentiment',
      score: Math.min(1, score),
      confidence: sentiment.score,
      reasoning: `${sentiment.label} (${(sentiment.score * 100).toFixed(0)}%) - negative news more important`,
    };
  }

  private scoreByEntities(entities: NEREntity[]): PerspectiveScore {
    const locations = entities.filter(e => e.type.includes('LOC'));
    const people = entities.filter(e => e.type.includes('PER'));
    const orgs = entities.filter(e => e.type.includes('ORG'));

    const geopoliticalLocations = locations.filter(e =>
      FLASHPOINT_KEYWORDS.some(fp => e.text.toLowerCase().includes(fp))
    );

    let score = 0;
    const reasons: string[] = [];

    if (geopoliticalLocations.length > 0) {
      score += 0.4;
      reasons.push(`geo-locations(${geopoliticalLocations.map(e => e.text).join(',')})`);
    } else if (locations.length > 0) {
      score += 0.15;
      reasons.push(`locations(${locations.length})`);
    }

    if (people.length > 0) {
      score += 0.1 + people.length * 0.05;
      reasons.push(`people(${people.map(e => e.text).join(',')})`);
    }

    if (orgs.length > 0) {
      score += 0.1 + orgs.length * 0.05;
      reasons.push(`orgs(${orgs.map(e => e.text).join(',')})`);
    }

    const entityDensity = entities.length;
    if (entityDensity > 3) {
      score += 0.15;
      reasons.push(`high-density(${entityDensity})`);
    }

    return {
      name: 'entities',
      score: Math.min(1, score),
      confidence: entities.length > 0 ? 0.7 : 0.3,
      reasoning: reasons.length > 0 ? reasons.join(' + ') : 'no significant entities',
    };
  }

  private async scoreByNovelty(title: string, embedding: number[]): Promise<PerspectiveScore> {
    let maxSimilarity = 0;
    let mostSimilar = '';

    for (const [recentTitle, recentEmb] of this.recentEmbeddings) {
      if (recentTitle === title) continue;
      const similarity = this.cosineSimilarity(embedding, recentEmb);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        mostSimilar = recentTitle.slice(0, 50);
      }
    }

    this.recentEmbeddings.set(title, embedding);
    if (this.recentEmbeddings.size > 100) {
      const firstKey = this.recentEmbeddings.keys().next().value;
      if (firstKey) this.recentEmbeddings.delete(firstKey);
    }

    const noveltyScore = 1 - maxSimilarity;
    const importanceBoost = noveltyScore > 0.5 ? 0.3 : 0;

    return {
      name: 'novelty',
      score: Math.min(1, noveltyScore * 0.7 + importanceBoost),
      confidence: 0.6,
      reasoning: maxSimilarity > 0.7
        ? `similar to: "${mostSimilar}..." (${(maxSimilarity * 100).toFixed(0)}%)`
        : `novel content (${(noveltyScore * 100).toFixed(0)}% unique)`,
    };
  }

  private scoreByVelocity(cluster: ClusteredEvent): PerspectiveScore {
    const velocity = cluster.velocity;
    let score = 0;
    let reasoning = '';

    if (!velocity || velocity.level === 'normal') {
      score = 0.2;
      reasoning = 'normal velocity';
    } else if (velocity.level === 'elevated') {
      score = 0.5;
      reasoning = `elevated: +${velocity.sourcesPerHour}/hr`;
    } else if (velocity.level === 'spike') {
      score = 0.7;
      reasoning = `spike: +${velocity.sourcesPerHour}/hr`;
    } else if (velocity.level === 'viral') {
      score = 0.9;
      reasoning = `viral: +${velocity.sourcesPerHour}/hr`;
    }

    if (velocity?.trend === 'rising') {
      score += 0.1;
      reasoning += ' ↑';
    }

    return {
      name: 'velocity',
      score: Math.min(1, score),
      confidence: 0.8,
      reasoning,
    };
  }

  private scoreBySourceDiversity(cluster: ClusteredEvent): PerspectiveScore {
    const sources = cluster.sourceCount;
    let score = 0;
    let reasoning = '';

    if (sources >= 5) {
      score = 0.9;
      reasoning = `${sources} sources - highly confirmed`;
    } else if (sources >= 3) {
      score = 0.7;
      reasoning = `${sources} sources - confirmed`;
    } else if (sources >= 2) {
      score = 0.5;
      reasoning = `${sources} sources - multi-source`;
    } else {
      score = 0.2;
      reasoning = 'single source';
    }

    return {
      name: 'sources',
      score,
      confidence: 0.9,
      reasoning,
    };
  }

  private aggregateScores(perspectives: PerspectiveScore[]): {
    finalScore: number;
    confidence: number;
    disagreement: number;
  } {
    if (perspectives.length === 0) {
      return { finalScore: 0, confidence: 0, disagreement: 0 };
    }

    const weights: Record<string, number> = {
      keywords: 0.25,
      sentiment: 0.15,
      entities: 0.20,
      novelty: 0.10,
      velocity: 0.15,
      sources: 0.15,
    };

    let weightedSum = 0;
    let totalWeight = 0;
    let confidenceSum = 0;

    for (const p of perspectives) {
      const weight = weights[p.name] ?? 0.1;
      weightedSum += p.score * weight * p.confidence;
      totalWeight += weight;
      confidenceSum += p.confidence;
    }

    const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const avgConfidence = confidenceSum / perspectives.length;

    const scores = perspectives.map(p => p.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length;
    const disagreement = Math.sqrt(variance);

    return {
      finalScore,
      confidence: avgConfidence * (1 - disagreement * 0.5),
      disagreement,
    };
  }

  private isLowKeywordScore(perspectives: PerspectiveScore[]): boolean {
    const keywordScore = perspectives.find(p => p.name === 'keywords')?.score ?? 0;
    return keywordScore < 0.3;
  }

  private calculateCorrelations(analyzed: AnalyzedHeadline[]): Record<string, number> {
    const perspectiveNames = ['keywords', 'sentiment', 'entities', 'novelty', 'velocity', 'sources'];
    const correlations: Record<string, number> = {};

    for (let i = 0; i < perspectiveNames.length; i++) {
      for (let j = i + 1; j < perspectiveNames.length; j++) {
        const name1 = perspectiveNames[i];
        const name2 = perspectiveNames[j];

        const scores1 = analyzed.map(a => a.perspectives.find(p => p.name === name1)?.score ?? 0);
        const scores2 = analyzed.map(a => a.perspectives.find(p => p.name === name2)?.score ?? 0);

        const correlation = this.pearsonCorrelation(scores1, scores2);
        correlations[`${name1}-${name2}`] = correlation;
      }
    }

    return correlations;
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n === 0) return 0;

    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let num = 0;
    let denX = 0;
    let denY = 0;

    for (let i = 0; i < n; i++) {
      const xi = x[i] ?? 0;
      const yi = y[i] ?? 0;
      const dx = xi - meanX;
      const dy = yi - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }

    const den = Math.sqrt(denX * denY);
    return den === 0 ? 0 : num / den;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private async getEmbeddings(titles: string[]): Promise<number[][]> {
    return mlWorker.embedTexts(titles);
  }

  private logReport(_report: AnalysisReport, _durationMs: number): void {
  }

  getLastReport(): AnalysisReport | null {
    return this.lastReport;
  }

  getSuggestedImprovements(): string[] {
    if (!this.lastReport) return [];

    const suggestions: string[] = [];

    if (this.lastReport.missedByKeywords.length > 2) {
      suggestions.push('Consider adding more keywords to capture ML-detected important stories');
    }

    const avgDisagreement = this.lastReport.analyzed
      .reduce((sum, a) => sum + a.disagreement, 0) / this.lastReport.analyzed.length;

    if (avgDisagreement > 0.25) {
      suggestions.push('High average disagreement - perspectives may need rebalancing');
    }

    const { perspectiveCorrelations } = this.lastReport;
    const keywordSentiment = perspectiveCorrelations['keywords-sentiment'] ?? 0;
    if (keywordSentiment < 0.3) {
      suggestions.push('Low keyword-sentiment correlation - keyword list may be missing emotional content');
    }

    return suggestions;
  }
}

export const parallelAnalysis = new ParallelAnalysisService();
