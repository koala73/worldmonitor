import { Panel } from './Panel';
import { mlWorker } from '@/services/ml-worker';
import { generateSummary, type SummarizeOptions } from '@/services/summarization';
import { parallelAnalysis, type AnalyzedHeadline } from '@/services/parallel-analysis';
import { signalAggregator, type RegionalConvergence } from '@/services/signal-aggregator';
import { focalPointDetector } from '@/services/focal-point-detector';
import { stripOrefLabels } from '@/services/oref-alerts';
import { ingestNewsForCII, getCountryScore } from '@/services/country-instability';
import { getTheaterPostureSummaries } from '@/services/military-surge';
import { getCachedPosture } from '@/services/cached-theater-posture';
import { isMobileDevice } from '@/utils';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { SITE_VARIANT } from '@/config';
import { deletePersistentCache, getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import { t } from '@/services/i18n';
import { isDesktopRuntime } from '@/services/runtime';
import { getAiFlowSettings, isAnyAiProviderEnabled, subscribeAiFlowChange } from '@/services/ai-flow-settings';
import { getActiveFrameworkForPanel, subscribeFrameworkChange } from '@/services/analysis-framework-store';
import { hasPremiumAccess } from '@/services/panel-gating';
import { FrameworkSelector } from './FrameworkSelector';
import { getServerInsights, type ServerInsights, type ServerInsightStory } from '@/services/insights-loader';
import { computeISQ, type SignalQuality, type SignalQualityInput } from '@/utils/signal-quality';
import { extractEntitiesFromTitle } from '@/services/entity-extraction';
import { getEntityIndex } from '@/services/entity-index';

import type { ClusteredEvent, FocalPoint, MilitaryFlight } from '@/types';

export class InsightsPanel extends Panel {
  private lastBriefUpdate = 0;
  private cachedBrief: string | null = null;
  private lastMissedStories: AnalyzedHeadline[] = [];
  private lastConvergenceZones: RegionalConvergence[] = [];
  private lastFocalPoints: FocalPoint[] = [];
  private lastMilitaryFlights: MilitaryFlight[] = [];
  private lastClusters: ClusteredEvent[] = [];
  private aiFlowUnsubscribe: (() => void) | null = null;
  private frameworkUnsubscribe: (() => void) | null = null;
  private fwSelector: FrameworkSelector | null = null;
  private updateGeneration = 0;
  private static readonly BRIEF_COOLDOWN_MS = 120000; // 2 min cooldown (API has limits)
  private static readonly BRIEF_CACHE_KEY = 'summary:world-brief';

  constructor() {
    super({
      id: 'insights',
      title: t('panels.insights'),
      showCount: false,
      infoTooltip: t('components.insights.infoTooltip'),
    });

    // Web-only: subscribe to AI flow changes so toggling providers re-runs analysis
    // Skip on mobile — only server-side insights are used there (no client-side AI)
    if (!isDesktopRuntime() && !isMobileDevice()) {
      this.aiFlowUnsubscribe = subscribeAiFlowChange((changedKey) => {
        if (changedKey === 'mapNewsFlash') return;
        void this.onAiFlowChanged();
      });
    }

    this.frameworkUnsubscribe = subscribeFrameworkChange('insights', () => {
      void this.updateInsights(this.lastClusters);
    });

    this.fwSelector = new FrameworkSelector({ panelId: 'insights', isPremium: hasPremiumAccess(), panel: this, note: 'Applies to client-generated analysis only' });
    this.header.appendChild(this.fwSelector.el);
  }

  public setMilitaryFlights(flights: MilitaryFlight[]): void {
    this.lastMilitaryFlights = flights;
  }

  private getTheaterPostureContext(): string {
    const cachedPostures = getCachedPosture()?.postures;
    const postures = cachedPostures?.length
      ? cachedPostures
      : (this.lastMilitaryFlights.length > 0 ? getTheaterPostureSummaries(this.lastMilitaryFlights) : []);

    const significant = postures.filter(
      (p) => p.postureLevel === 'critical' || p.postureLevel === 'elevated' || p.strikeCapable
    );

    if (significant.length === 0) {
      return '';
    }

    const lines = significant.map((p) => {
      const parts: string[] = [];
      parts.push(`${p.theaterName}: ${p.totalAircraft} aircraft`);
      parts.push(`(${p.postureLevel.toUpperCase()})`);
      if (p.strikeCapable) parts.push('STRIKE CAPABLE');
      parts.push(`- ${p.summary}`);
      if (p.targetNation) parts.push(`Focus: ${p.targetNation}`);
      return parts.join(' ');
    });

    return `\n\nCRITICAL MILITARY POSTURE:\n${lines.join('\n')}`;
  }


  private async loadBriefFromCache(): Promise<boolean> {
    if (this.cachedBrief) return false;
    const entry = await getPersistentCache<{ summary: string }>(InsightsPanel.BRIEF_CACHE_KEY);
    if (!entry?.data?.summary) return false;
    this.cachedBrief = entry.data.summary;
    this.lastBriefUpdate = entry.updatedAt;
    return true;
  }

  private extractISQInput(cluster: ClusteredEvent): SignalQualityInput {
    const entities = extractEntitiesFromTitle(cluster.primaryTitle);
    const idx = getEntityIndex();
    // Keyword matches (confidence 0.7) are ambiguous for shared-actor terms like
    // "hezbollah" (→ IR + IL) or "hamas" (→ IL + QA). Only trust alias matches
    // (direct country name mention, confidence ≥ 0.85) for ISQ country attribution.
    const countryEntity = entities.find(
      e => e.matchType === 'alias' && idx.byId.get(e.entityId)?.type === 'country'
    );
    return {
      sourceCount: cluster.sourceCount,
      isAlert: cluster.isAlert,
      sourceTier: cluster.topSources?.[0]?.tier ?? undefined,
      threatLevel: cluster.threat?.level ?? undefined,
      velocity: cluster.velocity ?? undefined,
      countryCode: countryEntity?.entityId ?? null,
    };
  }

  private selectTopStories(
    clusters: ClusteredEvent[],
    maxCount: number,
    focalFn: (code: string) => { focalScore: number; urgency: string } | null,
    ciiFn: (code: string) => number | null,
    isFocalReadyFn: () => boolean,
  ): Array<{ cluster: ClusteredEvent; isq: SignalQuality }> {
    const allScored = clusters.map(c => ({
      cluster: c,
      isq: computeISQ(this.extractISQInput(c), focalFn, ciiFn, isFocalReadyFn),
    }));

    const candidates = allScored.filter(({ cluster: c, isq }) =>
      c.sourceCount >= 2 ||
      c.isAlert ||
      (c.velocity && c.velocity.level !== 'normal') ||
      isq.composite > 0.55 ||
      isq.tier === 'strong'
    );

    const sorted = candidates.sort((a, b) => b.isq.composite - a.isq.composite);

    const selected: Array<{ cluster: ClusteredEvent; isq: SignalQuality }> = [];
    const sourceCount = new Map<string, number>();
    const MAX_PER_SOURCE = 3;

    for (const item of sorted) {
      const source = item.cluster.primarySource;
      const count = sourceCount.get(source) ?? 0;
      if (count < MAX_PER_SOURCE) {
        selected.push(item);
        sourceCount.set(source, count + 1);
      }
      if (selected.length >= maxCount) break;
    }

    return selected;
  }

  private setProgress(step: number, total: number, message: string): void {
    const percent = Math.round((step / total) * 100);
    this.setContent(`
      <div class="insights-progress">
        <div class="insights-progress-bar">
          <div class="insights-progress-fill" style="width: ${percent}%"></div>
        </div>
        <div class="insights-progress-info">
          <span class="insights-progress-step">${t('components.insights.step', { step: String(step), total: String(total) })}</span>
          <span class="insights-progress-message">${message}</span>
        </div>
      </div>
    `);
  }

  public async updateInsights(clusters: ClusteredEvent[]): Promise<void> {
    this.lastClusters = clusters;
    this.updateGeneration++;
    const thisGeneration = this.updateGeneration;

    // Try server-side pre-computed insights first (instant, works even without clusters)
    const serverInsights = getServerInsights();
    if (serverInsights) {
      await this.updateFromServer(serverInsights, clusters, thisGeneration);
      return;
    }

    if (clusters.length === 0) {
      this.setDataBadge('unavailable');
      this.setContent(`<div class="insights-empty">${t('components.insights.waitingForData')}</div>`);
      return;
    }

    // Fallback: full client-side pipeline (skip on mobile — too heavy)
    if (isMobileDevice()) {
      this.setDataBadge('unavailable');
      this.setContent(`<div class="insights-empty">${t('components.insights.waitingForData')}</div>`);
      return;
    }
    await this.updateFromClient(clusters, thisGeneration);
  }

  private async updateFromServer(
    serverInsights: ServerInsights,
    clusters: ClusteredEvent[],
    thisGeneration: number,
  ): Promise<void> {
    const totalSteps = 2;

    try {
      // Clear stale ML-detected stories when clusters are empty (e.g. clustering
      // failed) so unrelated missed stories don't render next to server insights
      if (clusters.length === 0) {
        this.lastMissedStories = [];
      }

      // Step 1: Signal aggregation (client-side, depends on real-time map data)
      this.setProgress(1, totalSteps, 'Loading server insights...');

      let signalSummary: ReturnType<typeof signalAggregator.getSummary>;
      let focalSummary: ReturnType<typeof focalPointDetector.analyze>;

      if (SITE_VARIANT === 'full') {
        const _cp = getCachedPosture()?.postures;
        const theaterPostures = _cp?.length
          ? _cp
          : (this.lastMilitaryFlights.length > 0 ? getTheaterPostureSummaries(this.lastMilitaryFlights) : []);
        if (theaterPostures.length > 0) {
          signalAggregator.ingestTheaterPostures(theaterPostures);
        }
        signalSummary = signalAggregator.getSummary();
        this.lastConvergenceZones = signalSummary.convergenceZones;
        focalSummary = focalPointDetector.analyze(clusters, signalSummary);
        this.lastFocalPoints = focalSummary.focalPoints;
        if (focalSummary.focalPoints.length > 0) {
          ingestNewsForCII(clusters);
          window.dispatchEvent(new CustomEvent('focal-points-ready'));
        }
      } else {
        this.lastConvergenceZones = [];
        this.lastFocalPoints = [];
      }

      if (this.updateGeneration !== thisGeneration) return;

      // Step 2: Re-sort server stories by ISQ (shallow copy to avoid mutating cache)
      this.setProgress(2, totalSteps, t('components.insights.analyzingSentiment'));
      const focalFnServer = (code: string) => {
        const fp = focalPointDetector.getFocalPointForCountry(code);
        return (fp && (fp.signalCount > 0 || fp.signalTypes.includes('active_strike'))) ? fp : null;
      };
      const isFocalReadyServer = () => (focalPointDetector.getLastSummary()?.topCountries.some(
        fp => fp.signalCount > 0 || fp.signalTypes.includes('active_strike')
      ) ?? false);
      const sortedStories = [...serverInsights.topStories].sort((a, b) => {
        const isqA = computeISQ(
          { sourceCount: a.sourceCount, isAlert: a.isAlert, threatLevel: a.threatLevel ?? undefined, countryCode: a.countryCode, velocity: a.velocity },
          focalFnServer, getCountryScore, isFocalReadyServer,
        );
        const isqB = computeISQ(
          { sourceCount: b.sourceCount, isAlert: b.isAlert, threatLevel: b.threatLevel ?? undefined, countryCode: b.countryCode, velocity: b.velocity },
          focalFnServer, getCountryScore, isFocalReadyServer,
        );
        return isqB.composite - isqA.composite;
      });

      // Sentiment classification uses positional indexing — must happen AFTER re-sort
      const titles = sortedStories.slice(0, 5).map(s => s.primaryTitle);
      let sentiments: Array<{ label: string; score: number }> | null = null;
      if (mlWorker.isAvailable) {
        sentiments = await mlWorker.classifySentiment(titles).catch(() => null);
      }

      if (this.updateGeneration !== thisGeneration) return;

      this.setDataBadge('live');
      this.renderServerInsights({ ...serverInsights, topStories: sortedStories }, sentiments);
    } catch (error) {
      console.error('[InsightsPanel] Server path error, falling back:', error);
      await this.updateFromClient(clusters, thisGeneration);
    }
  }

  private async updateFromClient(clusters: ClusteredEvent[], thisGeneration: number): Promise<void> {
    // Web-only: if no AI providers enabled, show disabled state
    if (!isDesktopRuntime() && !isAnyAiProviderEnabled()) {
      this.setDataBadge('unavailable');
      this.renderDisabledState();
      return;
    }

    // Build summarize options from AI flow settings (web) or defaults (desktop)
    const aiFlow = isDesktopRuntime() ? { cloudLlm: true, browserModel: true } : getAiFlowSettings();
    const summarizeOpts: SummarizeOptions = {
      skipCloudProviders: !aiFlow.cloudLlm,
      skipBrowserFallback: !aiFlow.browserModel,
    };

    const totalSteps = 4;

    try {
      // Step 1: Signal aggregation + focal point detection (must run BEFORE ranking)
      this.setProgress(1, totalSteps, t('components.insights.rankingStories'));

      // Run parallel multi-perspective analysis in background
      const parallelPromise = parallelAnalysis.analyzeHeadlines(clusters).then(report => {
        this.lastMissedStories = report.missedByKeywords;
      }).catch(err => {
        console.warn('[ParallelAnalysis] Error:', err);
      });

      let signalSummary: ReturnType<typeof signalAggregator.getSummary>;
      let focalSummary: ReturnType<typeof focalPointDetector.analyze>;

      if (SITE_VARIANT === 'full') {
        const _cp = getCachedPosture()?.postures;
        const theaterPostures = _cp?.length
          ? _cp
          : (this.lastMilitaryFlights.length > 0 ? getTheaterPostureSummaries(this.lastMilitaryFlights) : []);
        if (theaterPostures.length > 0) {
          signalAggregator.ingestTheaterPostures(theaterPostures);
        }
        signalSummary = signalAggregator.getSummary();
        this.lastConvergenceZones = signalSummary.convergenceZones;
        focalSummary = focalPointDetector.analyze(clusters, signalSummary);
        this.lastFocalPoints = focalSummary.focalPoints;
        if (focalSummary.focalPoints.length > 0) {
          ingestNewsForCII(clusters);
          window.dispatchEvent(new CustomEvent('focal-points-ready'));
        }
      } else {
        signalSummary = {
          timestamp: new Date(),
          totalSignals: 0,
          byType: {} as Record<string, number>,
          convergenceZones: [],
          topCountries: [],
          aiContext: '',
        };
        focalSummary = {
          focalPoints: [],
          aiContext: '',
          timestamp: new Date(),
          topCountries: [],
          topCompanies: [],
        };
        this.lastConvergenceZones = [];
        this.lastFocalPoints = [];
      }

      // Rank stories with fresh focal + CII context
      const focalFn = (code: string) => {
        const fp = focalPointDetector.getFocalPointForCountry(code);
        return (fp && (fp.signalCount > 0 || fp.signalTypes.includes('active_strike'))) ? fp : null;
      };
      const isFocalReady = () => (focalPointDetector.getLastSummary()?.topCountries.some(
        fp => fp.signalCount > 0 || fp.signalTypes.includes('active_strike')
      ) ?? false);
      const importantItems = this.selectTopStories(clusters, 8, focalFn, getCountryScore, isFocalReady);
      const importantClusters = importantItems.map(({ cluster }) => cluster);

      if (importantClusters.length === 0) {
        this.setContent(`<div class="insights-empty">${t('components.insights.noStories')}</div>`);
        return;
      }

      // Cap titles sent to AI at 5 to reduce entity conflation in small models
      // Strip OREF translation labels (ALERT[id]:, AREAS[id]:) that may leak into cluster titles
      const titles = importantClusters.slice(0, 5).map(c => stripOrefLabels(c.primaryTitle));

      // Step 2: Analyze sentiment (browser-based, fast)
      this.setProgress(2, totalSteps, t('components.insights.analyzingSentiment'));
      let sentiments: Array<{ label: string; score: number }> | null = null;

      if (mlWorker.isAvailable) {
        sentiments = await mlWorker.classifySentiment(titles).catch(() => null);
      }
      if (this.updateGeneration !== thisGeneration) return;

      // Step 3: Generate World Brief (with cooldown)
      await this.loadBriefFromCache();
      if (this.updateGeneration !== thisGeneration) return;

      let worldBrief = this.cachedBrief;
      const now = Date.now();

      if (!worldBrief || now - this.lastBriefUpdate > InsightsPanel.BRIEF_COOLDOWN_MS) {
        this.setProgress(3, totalSteps, t('components.insights.generatingBrief'));

        // Pass focal point context + theater posture to AI for correlation-aware summarization
        // Tech variant: no geopolitical context, just tech news summarization
        const theaterContext = SITE_VARIANT === 'full' ? this.getTheaterPostureContext() : '';
        let geoContext = SITE_VARIANT === 'full'
          ? (focalSummary.aiContext || signalSummary.aiContext) + theaterContext
          : '';
        const insightsFw = getActiveFrameworkForPanel('insights');
        if (insightsFw) {
          geoContext = `${geoContext}\n\n---\nAnalytical Framework:\n${insightsFw.systemPromptAppend}`;
        }
        const result = await generateSummary(titles, (_step, _total, msg) => {
          // Show sub-progress for summarization
          this.setProgress(3, totalSteps, `Generating brief: ${msg}`);
        }, geoContext, undefined, summarizeOpts);

        if (this.updateGeneration !== thisGeneration) return;

        if (result) {
          worldBrief = result.summary;
          this.cachedBrief = worldBrief;
          this.lastBriefUpdate = now;
          void setPersistentCache(InsightsPanel.BRIEF_CACHE_KEY, { summary: worldBrief });
        }
      } else {
        this.setProgress(3, totalSteps, 'Using cached brief...');
      }

      this.setDataBadge(worldBrief ? 'live' : 'unavailable');

      // Step 4: Wait for parallel analysis to complete
      this.setProgress(4, totalSteps, 'Multi-perspective analysis...');
      await parallelPromise;

      if (this.updateGeneration !== thisGeneration) return;

      this.renderInsights(importantItems, sentiments, worldBrief);
    } catch (error) {
      console.error('[InsightsPanel] Error:', error);
      this.showError();
    }
  }

  private renderInsights(
    items: Array<{ cluster: ClusteredEvent; isq: SignalQuality }>,
    sentiments: Array<{ label: string; score: number }> | null,
    worldBrief: string | null
  ): void {
    const clusters = items.map(({ cluster }) => cluster);
    const briefHtml = worldBrief ? this.renderWorldBrief(worldBrief) : '';
    const focalPointsHtml = this.renderFocalPoints();
    const convergenceHtml = this.renderConvergenceZones();
    const sentimentOverview = this.renderSentimentOverview(sentiments);
    const breakingHtml = this.renderBreakingStories(items, sentiments);
    const statsHtml = this.renderStats(clusters);
    const missedHtml = this.renderMissedStories();

    this.setContent(`
      ${briefHtml}
      ${focalPointsHtml}
      ${convergenceHtml}
      ${sentimentOverview}
      ${statsHtml}
      <div class="insights-section">
        <div class="insights-section-title">BREAKING & CONFIRMED</div>
        ${breakingHtml}
      </div>
      ${missedHtml}
    `);
  }

  private renderServerInsights(
    insights: ServerInsights,
    sentiments: Array<{ label: string; score: number }> | null,
  ): void {
    const briefHtml = insights.worldBrief ? this.renderWorldBrief(insights.worldBrief) : '';
    const focalPointsHtml = this.renderFocalPoints();
    const convergenceHtml = this.renderConvergenceZones();
    const sentimentOverview = this.renderSentimentOverview(sentiments);
    const storiesHtml = this.renderServerStories(insights.topStories, sentiments);
    const statsHtml = this.renderServerStats(insights);
    const missedHtml = this.renderMissedStories();

    this.setContent(`
      ${briefHtml}
      ${focalPointsHtml}
      ${convergenceHtml}
      ${sentimentOverview}
      ${statsHtml}
      <div class="insights-section">
        <div class="insights-section-title">BREAKING & CONFIRMED</div>
        ${storiesHtml}
      </div>
      ${missedHtml}
    `);
  }

  private renderServerStories(
    stories: ServerInsightStory[],
    sentiments: Array<{ label: string; score: number }> | null,
  ): string {
    return stories.map((story, i) => {
      const sentiment = sentiments?.[i];
      const sentimentClass = sentiment?.label === 'negative' ? 'negative' :
        sentiment?.label === 'positive' ? 'positive' : 'neutral';

      const badges: string[] = [];

      if (story.sourceCount >= 3) {
        badges.push(`<span class="insight-badge confirmed">✓ ${story.sourceCount} sources</span>`);
      } else if (story.sourceCount >= 2) {
        badges.push(`<span class="insight-badge multi">${story.sourceCount} sources</span>`);
      }

      if (story.isAlert) {
        badges.push('<span class="insight-badge alert">⚠ ALERT</span>');
      }

      const VALID_THREAT_LEVELS = ['critical', 'high', 'elevated', 'moderate', 'medium', 'low', 'info'];
      if (story.threatLevel === 'critical' || story.threatLevel === 'high') {
        const safeThreat = VALID_THREAT_LEVELS.includes(story.threatLevel) ? story.threatLevel : 'moderate';
        badges.push(`<span class="insight-badge velocity ${safeThreat}">${escapeHtml(story.category)}</span>`);
      }

      return `
        <div class="insight-story">
          <div class="insight-story-header">
            <span class="insight-sentiment-dot ${sentimentClass}"></span>
            <span class="insight-story-title">${escapeHtml(story.primaryTitle.slice(0, 100))}${story.primaryTitle.length > 100 ? '...' : ''}</span>
          </div>
          ${badges.length > 0 ? `<div class="insight-badges">${badges.join('')}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  private renderServerStats(insights: ServerInsights): string {
    return `
      <div class="insights-stats">
        <div class="insight-stat">
          <span class="insight-stat-value">${insights.multiSourceCount}</span>
          <span class="insight-stat-label">Multi-source</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-value">${insights.fastMovingCount}</span>
          <span class="insight-stat-label">Fast-moving</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-value">${insights.clusterCount}</span>
          <span class="insight-stat-label">Clusters</span>
        </div>
      </div>
    `;
  }

  private renderWorldBrief(brief: string): string {
    return `
      <div class="insights-brief">
        <div class="insights-section-title">${SITE_VARIANT === 'tech' ? '🚀 TECH BRIEF' : '🌍 WORLD BRIEF'}</div>
        <div class="insights-brief-text">${escapeHtml(brief)}</div>
      </div>
    `;
  }

  private renderBreakingStories(
    items: Array<{ cluster: ClusteredEvent; isq: SignalQuality }>,
    sentiments: Array<{ label: string; score: number }> | null
  ): string {
    const ISQ_BADGE_CLASS: Record<string, string> = {
      strong: 'isq-strong', notable: 'isq-notable', weak: 'isq-weak', noise: 'isq-noise',
    };

    return items.map(({ cluster, isq }, i) => {
      const sentiment = sentiments?.[i];
      const sentimentClass = sentiment?.label === 'negative' ? 'negative' :
        sentiment?.label === 'positive' ? 'positive' : 'neutral';

      const badges: string[] = [];

      if (isq.tier === 'strong' || isq.tier === 'notable') {
        const cls = ISQ_BADGE_CLASS[isq.tier];
        badges.push(`<span class="insight-badge ${cls}">${isq.tier.toUpperCase()}</span>`);
      }

      if (cluster.sourceCount >= 3) {
        badges.push(`<span class="insight-badge confirmed">✓ ${cluster.sourceCount} sources</span>`);
      } else if (cluster.sourceCount >= 2) {
        badges.push(`<span class="insight-badge multi">${cluster.sourceCount} sources</span>`);
      }

      if (cluster.velocity && cluster.velocity.level !== 'normal') {
        const velIcon = cluster.velocity.trend === 'rising' ? '↑' : '';
        badges.push(`<span class="insight-badge velocity ${cluster.velocity.level}">${velIcon}+${cluster.velocity.sourcesPerHour}/hr</span>`);
      }

      if (cluster.isAlert) {
        badges.push('<span class="insight-badge alert">⚠ ALERT</span>');
      }

      return `
        <div class="insight-story">
          <div class="insight-story-header">
            <span class="insight-sentiment-dot ${sentimentClass}"></span>
            <span class="insight-story-title">${escapeHtml(cluster.primaryTitle.slice(0, 100))}${cluster.primaryTitle.length > 100 ? '...' : ''}</span>
          </div>
          ${badges.length > 0 ? `<div class="insight-badges">${badges.join('')}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  private renderSentimentOverview(sentiments: Array<{ label: string; score: number }> | null): string {
    if (!sentiments || sentiments.length === 0) {
      return '';
    }

    const negative = sentiments.filter(s => s.label === 'negative').length;
    const positive = sentiments.filter(s => s.label === 'positive').length;
    const neutral = sentiments.length - negative - positive;

    const total = sentiments.length;
    const negPct = Math.round((negative / total) * 100);
    const neuPct = Math.round((neutral / total) * 100);
    const posPct = 100 - negPct - neuPct;

    let toneLabel = 'Mixed';
    let toneClass = 'neutral';
    if (negative > positive + neutral) {
      toneLabel = 'Negative';
      toneClass = 'negative';
    } else if (positive > negative + neutral) {
      toneLabel = 'Positive';
      toneClass = 'positive';
    }

    return `
      <div class="insights-sentiment-bar">
        <div class="sentiment-bar-track">
          <div class="sentiment-bar-negative" style="width: ${negPct}%"></div>
          <div class="sentiment-bar-neutral" style="width: ${neuPct}%"></div>
          <div class="sentiment-bar-positive" style="width: ${posPct}%"></div>
        </div>
        <div class="sentiment-bar-labels">
          <span class="sentiment-label negative">${negative}</span>
          <span class="sentiment-label neutral">${neutral}</span>
          <span class="sentiment-label positive">${positive}</span>
        </div>
        <div class="sentiment-tone ${toneClass}">Overall: ${toneLabel}</div>
      </div>
    `;
  }

  private renderStats(clusters: ClusteredEvent[]): string {
    const multiSource = clusters.filter(c => c.sourceCount >= 2).length;
    const fastMoving = clusters.filter(c => c.velocity && c.velocity.level !== 'normal').length;
    const alerts = clusters.filter(c => c.isAlert).length;

    return `
      <div class="insights-stats">
        <div class="insight-stat">
          <span class="insight-stat-value">${multiSource}</span>
          <span class="insight-stat-label">Multi-source</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-value">${fastMoving}</span>
          <span class="insight-stat-label">Fast-moving</span>
        </div>
        ${alerts > 0 ? `
        <div class="insight-stat alert">
          <span class="insight-stat-value">${alerts}</span>
          <span class="insight-stat-label">Alerts</span>
        </div>
        ` : ''}
      </div>
    `;
  }

  private get showMlDetected(): boolean {
    try { return localStorage.getItem('wm:debug-ml') === '1'; } catch { return false; }
  }

  private renderMissedStories(): string {
    if (this.lastMissedStories.length === 0 || !this.showMlDetected) {
      return '';
    }

    const storiesHtml = this.lastMissedStories.slice(0, 3).map(story => {
      const topPerspective = story.perspectives
        .filter(p => p.name !== 'keywords')
        .sort((a, b) => b.score - a.score)[0];

      const perspectiveName = topPerspective?.name ?? 'ml';
      const perspectiveScore = topPerspective?.score ?? 0;

      return `
        <div class="insight-story missed">
          <div class="insight-story-header">
            <span class="insight-sentiment-dot ml-flagged"></span>
            <span class="insight-story-title">${escapeHtml(story.title.slice(0, 80))}${story.title.length > 80 ? '...' : ''}</span>
          </div>
          <div class="insight-badges">
            <span class="insight-badge ml-detected">🔬 ${perspectiveName}: ${(perspectiveScore * 100).toFixed(0)}%</span>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="insights-section insights-missed">
        <div class="insights-section-title">🎯 ML DETECTED</div>
        ${storiesHtml}
      </div>
    `;
  }

  private renderConvergenceZones(): string {
    if (this.lastConvergenceZones.length === 0) {
      return '';
    }

    const zonesHtml = this.lastConvergenceZones.slice(0, 3).map(zone => {
      const signalIcons: Record<string, string> = {
        internet_outage: '🌐',
        military_flight: '✈️',
        military_vessel: '🚢',
        protest: '🪧',
        ais_disruption: '⚓',
      };

      const icons = zone.signalTypes.map(t => signalIcons[t] || '📍').join('');

      return `
        <div class="convergence-zone">
          <div class="convergence-region">${icons} ${escapeHtml(zone.region)}</div>
          <div class="convergence-description">${escapeHtml(zone.description)}</div>
          <div class="convergence-stats">${zone.signalTypes.length} signal types • ${zone.totalSignals} events</div>
        </div>
      `;
    }).join('');

    return `
      <div class="insights-section insights-convergence">
        <div class="insights-section-title">📍 GEOGRAPHIC CONVERGENCE</div>
        ${zonesHtml}
      </div>
    `;
  }

  private renderFocalPoints(): string {
    // Show focal points with news+signals correlations, or those with active strikes
    const correlatedFPs = this.lastFocalPoints.filter(
      fp => (fp.newsMentions > 0 && fp.signalCount > 0) ||
            fp.signalTypes.includes('active_strike')
    ).slice(0, 5);

    if (correlatedFPs.length === 0) {
      return '';
    }

    const signalIcons: Record<string, string> = {
      internet_outage: '🌐',
      military_flight: '✈️',
      military_vessel: '⚓',
      protest: '📢',
      ais_disruption: '🚢',
      active_strike: '💥',
    };

    const focalPointsHtml = correlatedFPs.map(fp => {
      const urgencyClass = fp.urgency;
      const icons = fp.signalTypes.map(t => signalIcons[t] || '').join(' ');
      const topHeadline = fp.topHeadlines[0];
      const headlineText = topHeadline?.title?.slice(0, 60) || '';
      const headlineUrl = sanitizeUrl(topHeadline?.url || '');

      return `
        <div class="focal-point ${urgencyClass}">
          <div class="focal-point-header">
            <span class="focal-point-name">${escapeHtml(fp.displayName)}</span>
            <span class="focal-point-urgency ${urgencyClass}">${fp.urgency.toUpperCase()}</span>
          </div>
          <div class="focal-point-signals">${icons}</div>
          <div class="focal-point-stats">
            ${fp.newsMentions} news • ${fp.signalCount} signals
          </div>
          ${headlineText && headlineUrl ? `<a href="${headlineUrl}" target="_blank" rel="noopener" class="focal-point-headline">"${escapeHtml(headlineText)}..."</a>` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="insights-section insights-focal">
        <div class="insights-section-title">🎯 FOCAL POINTS</div>
        ${focalPointsHtml}
      </div>
    `;
  }

  private renderDisabledState(): void {
    this.setContent(`
      <div class="insights-disabled">
        <div class="insights-disabled-icon">⚡</div>
        <div class="insights-disabled-title">${t('components.insights.insightsDisabledTitle')}</div>
        <div class="insights-disabled-hint">${t('components.insights.insightsDisabledHint')}</div>
      </div>
    `);
  }

  private async onAiFlowChanged(): Promise<void> {
    this.updateGeneration++;
    // Reset brief cache so new provider settings take effect immediately
    this.cachedBrief = null;
    this.lastBriefUpdate = 0;
    try {
      await deletePersistentCache(InsightsPanel.BRIEF_CACHE_KEY);
    } catch {
      // Best effort; fallback regeneration still works from memory reset.
    }
    if (!this.element?.isConnected) return;

    if (!isAnyAiProviderEnabled()) {
      this.setDataBadge('unavailable');
      this.renderDisabledState();
      return;
    }

    // Re-run full updateInsights which checks server insights first,
    // then falls back to client-side clustering
    void this.updateInsights(this.lastClusters);
  }

  public override destroy(): void {
    this.aiFlowUnsubscribe?.();
    this.frameworkUnsubscribe?.();
    this.fwSelector?.destroy();
    super.destroy();
  }
}
