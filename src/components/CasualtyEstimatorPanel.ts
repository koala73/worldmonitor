/**
 * CasualtyEstimatorPanel — Displays casualty projections and analysis tools.
 *
 * Shows:
 *   - Current cumulative casualties per faction
 *   - Forward-looking casualty projections (30/60/90 day horizons)
 *   - Driving factors behind projections
 *   - Confidence intervals
 *   - Equipment loss tracking
 */

import { Panel } from './Panel';
import { h, replaceChildren } from '@/utils/dom-utils';
import {
  projectCasualties,
  emitWarfareUpdate,
} from '@/services/warfare-simulation';

export class CasualtyEstimatorPanel extends Panel {
  private simulationId: string | null = null;
  private factions: string[] = [];
  private boundUpdateHandler: EventListener;

  constructor() {
    super({
      id: 'casualty-estimator',
      title: 'Casualty Projections',
      showCount: false,
      infoTooltip: 'Forward-looking casualty estimates based on current combat intensity, supply status, and force ratios.',
    });

    this.boundUpdateHandler = ((e: CustomEvent) => {
      if (e.detail?.simulationId) {
        this.simulationId = e.detail.simulationId;
        this.refreshProjections();
      }
    }) as EventListener;
    document.addEventListener('wm:warfare-updated', this.boundUpdateHandler);

    this.showLoading('Waiting for active simulation...');
  }

  override destroy(): void {
    document.removeEventListener('wm:warfare-updated', this.boundUpdateHandler);
    super.destroy();
  }

  setFactions(factions: string[]): void {
    this.factions = factions;
  }

  private async refreshProjections(): Promise<void> {
    if (!this.simulationId || this.factions.length === 0) return;
    if (!this.contentEl) return;

    try {
      const horizons = [30, 60, 90];
      const results = await Promise.all(
        this.factions.flatMap(faction =>
          horizons.map(days =>
            projectCasualties(this.simulationId!, faction, days).then(r => ({
              faction,
              days,
              ...(r as Record<string, unknown>).projection as Record<string, unknown>,
            })),
          )
        )
      );

      this.renderProjections(results);
    } catch {
      // Silently ignore
    }
  }

  private renderProjections(results: Array<Record<string, unknown>>): void {
    if (!this.contentEl) return;

    // Group by faction
    const byFaction = new Map<string, Array<Record<string, unknown>>>();
    for (const r of results) {
      const faction = r.faction as string;
      const arr = byFaction.get(faction) || [];
      arr.push(r);
      byFaction.set(faction, arr);
    }

    const el = h('div', { style: 'display:flex;flex-direction:column;gap:10px;' },
      ...[...byFaction.entries()].map(([faction, projections]) =>
        h('div', { style: 'background:#0d1117;border:1px solid #222;border-radius:6px;padding:10px;' },
          h('div', { style: 'font-weight:600;color:#58a6ff;font-size:12px;margin-bottom:8px;' }, `${faction} Casualty Forecast`),
          h('div', { style: 'display:flex;gap:8px;' },
            ...projections.map(p => {
              const days = (p.days as number) || 0;
              const killed = (p.projectedKilled as number) || 0;
              const wounded = (p.projectedWounded as number) || 0;
              const civilian = (p.projectedCivilian as number) || 0;
              const confidence = (p.confidence as number) || 0;

              return h('div', { style: 'flex:1;background:#161b22;border-radius:4px;padding:8px;text-align:center;' },
                h('div', { style: 'font-size:10px;color:#888;margin-bottom:4px;' }, `${days}-day`),
                h('div', { style: 'font-size:14px;font-weight:600;color:#f85149;' }, killed.toLocaleString()),
                h('div', { style: 'font-size:9px;color:#888;' }, 'projected KIA'),
                h('div', { style: 'font-size:11px;color:#d29922;margin-top:2px;' }, `+${wounded.toLocaleString()} WIA`),
                h('div', { style: 'font-size:10px;color:#f0883e;' }, `+${civilian.toLocaleString()} civilian`),
                h('div', { style: 'font-size:9px;color:#555;margin-top:4px;' }, `${confidence}% confidence`),
              );
            }),
          ),
          // Driving factors
          projections[0]?.drivingFactors ? h('div', { style: 'margin-top:6px;font-size:10px;color:#666;' },
            `Factors: ${(projections[0].drivingFactors as string[]).join(', ')}`,
          ) : h('span'),
        ),
      ),
    );

    replaceChildren(this.contentEl, el);
  }
}
