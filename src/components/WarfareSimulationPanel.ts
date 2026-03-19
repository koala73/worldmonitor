/**
 * WarfareSimulationPanel — Main war game simulation control panel.
 *
 * Provides:
 *   - Scenario creation with faction selection and theater choice
 *   - Turn-by-turn simulation controls (advance, pause, auto-play)
 *   - Live combat log with engagement results
 *   - Casualty tracker per faction
 *   - Missile launch/interception tracking
 *   - Supply status overview
 *   - Territorial control summary
 *   - Force composition breakdown
 *   - Capability assessment and outcome forecasting
 */

import { Panel } from './Panel';
import { h, replaceChildren } from '@/utils/dom-utils';
import {
  createSimulation,
  getGameState,
  advanceTurn,
  listUnits,
  analyzeOutcomes,
  listMissileSystems,
  getSupplyStatus,
  getTerritorialControl,
  assessCapabilities,
  projectCasualties,
  emitWarfareUpdate,
} from '@/services/warfare-simulation';

type ViewTab = 'overview' | 'units' | 'missiles' | 'supply' | 'territory' | 'analysis';

export class WarfareSimulationPanel extends Panel {
  private simulationId: string | null = null;
  private gameState: Record<string, unknown> | null = null;
  private activeTab: ViewTab = 'overview';
  private autoPlayInterval: ReturnType<typeof setInterval> | null = null;
  private boundUpdateHandler: EventListener;

  constructor() {
    super({
      id: 'warfare-simulation',
      title: 'War Simulation',
      showCount: false,
      defaultRowSpan: 3,
      infoTooltip: 'Turn-based conflict simulation with combat modeling, missile tracking, logistics, and outcome forecasting.',
    });

    this.boundUpdateHandler = () => this.refreshState();
    document.addEventListener('wm:warfare-updated', this.boundUpdateHandler);

    this.renderSetup();
  }

  override destroy(): void {
    if (this.autoPlayInterval) clearInterval(this.autoPlayInterval);
    document.removeEventListener('wm:warfare-updated', this.boundUpdateHandler);
    super.destroy();
  }

  // ──────────────────────────────── Setup view ────────────────────────────────

  private renderSetup(): void {
    const container = this.getContentElement();
    if (!container) return;

    const theaterOptions = [
      { value: 'european', label: 'European Theater' },
      { value: 'middle-east', label: 'Middle East' },
      { value: 'indo-pacific', label: 'Indo-Pacific' },
    ];

    const presetScenarios = [
      { name: 'Eastern European Conflict', basis: 'ukraine-russia', factions: ['UA', 'RU'], theater: 'european' },
      { name: 'Middle East Escalation', basis: 'iran-israel', factions: ['IL', 'IR'], theater: 'middle-east' },
      { name: 'Taiwan Strait Crisis', basis: 'taiwan-strait', factions: ['TW', 'CN'], theater: 'indo-pacific' },
    ];

    const el = h('div', { className: 'warfare-setup' },
      h('div', { className: 'warfare-setup__header', style: 'padding:12px;color:#ccc;font-size:13px;' },
        'Configure a conflict simulation scenario, or choose a preset:',
      ),
      h('div', { className: 'warfare-presets', style: 'display:flex;flex-direction:column;gap:8px;padding:0 12px;' },
        ...presetScenarios.map(preset =>
          h('button', {
            className: 'warfare-preset-btn',
            style: 'background:#1a2a3a;border:1px solid #334;color:#ddd;padding:10px 14px;border-radius:6px;cursor:pointer;text-align:left;font-size:12px;',
            onclick: () => this.startSimulation(preset.name, preset.basis, preset.factions, preset.theater),
          },
            h('div', { style: 'font-weight:600;margin-bottom:4px;' }, preset.name),
            h('div', { style: 'color:#888;font-size:11px;' },
              `${preset.factions.join(' vs ')} \u2014 ${theaterOptions.find(t => t.value === preset.theater)?.label || preset.theater}`,
            ),
          )
        ),
      ),
      h('div', { style: 'padding:12px;border-top:1px solid #222;margin-top:12px;' },
        h('div', { style: 'color:#888;font-size:11px;margin-bottom:8px;' }, 'Or create a custom scenario:'),
        h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' },
          this.makeInput('scenario-name', 'Scenario Name', 'text'),
          this.makeInput('faction-a', 'Faction A (ISO2)', 'text'),
          this.makeInput('faction-b', 'Faction B (ISO2)', 'text'),
          this.makeSelect('theater-select', 'Theater', theaterOptions),
          h('button', {
            style: 'background:#0d6efd;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-size:12px;',
            onclick: () => {
              const name = (container.querySelector('#scenario-name') as HTMLInputElement)?.value || 'Custom Scenario';
              const fA = (container.querySelector('#faction-a') as HTMLInputElement)?.value || 'US';
              const fB = (container.querySelector('#faction-b') as HTMLInputElement)?.value || 'RU';
              const theater = (container.querySelector('#theater-select') as HTMLSelectElement)?.value || 'european';
              this.startSimulation(name, 'custom', [fA, fB], theater);
            },
          }, 'Create Simulation'),
        ),
      ),
    );

    replaceChildren(container, el);
  }

  private makeInput(id: string, placeholder: string, type: string): HTMLElement {
    return h('input', {
      id,
      type,
      placeholder,
      style: 'background:#111;border:1px solid #333;color:#ddd;padding:6px 10px;border-radius:4px;font-size:12px;width:120px;',
    });
  }

  private makeSelect(id: string, label: string, options: { value: string; label: string }[]): HTMLElement {
    const sel = h('select', {
      id,
      style: 'background:#111;border:1px solid #333;color:#ddd;padding:6px 10px;border-radius:4px;font-size:12px;',
    },
      ...options.map(o => h('option', { value: o.value }, o.label)),
    );
    return sel;
  }

  // ──────────────────────────────── Simulation lifecycle ────────────────────────────────

  private async startSimulation(name: string, basis: string, factions: string[], theater: string): Promise<void> {
    this.showLoading('Initializing simulation...');
    try {
      const result = await createSimulation({ name, conflictBasis: basis, factions, theater, maxTurns: 365 }) as { simulation: { simulationId: string } };
      this.simulationId = result.simulation.simulationId;
      await this.refreshState();
    } catch (e) {
      this.showError('Failed to create simulation');
    }
  }

  private async refreshState(): Promise<void> {
    if (!this.simulationId) return;
    try {
      this.gameState = await getGameState(this.simulationId) as Record<string, unknown>;
      this.renderSimulation();
    } catch {
      // Silently ignore refresh failures
    }
  }

  private async handleAdvanceTurn(): Promise<void> {
    if (!this.simulationId) return;
    try {
      await advanceTurn(this.simulationId);
      emitWarfareUpdate({ type: 'turn-advanced', simulationId: this.simulationId });
      await this.refreshState();
    } catch {
      // Silently ignore
    }
  }

  private toggleAutoPlay(): void {
    if (this.autoPlayInterval) {
      clearInterval(this.autoPlayInterval);
      this.autoPlayInterval = null;
    } else {
      this.autoPlayInterval = setInterval(() => this.handleAdvanceTurn(), 1500);
    }
    this.renderSimulation();
  }

  // ──────────────────────────────── Main simulation view ────────────────────────────────

  private renderSimulation(): void {
    const container = this.getContentElement();
    if (!container || !this.gameState) return;

    const sim = this.gameState.simulation as Record<string, unknown> | undefined;
    if (!sim) return;

    const el = h('div', { className: 'warfare-sim', style: 'display:flex;flex-direction:column;height:100%;' },
      // Header bar
      this.renderHeader(sim),
      // Tab bar
      this.renderTabBar(),
      // Content area
      this.renderTabContent(),
    );

    replaceChildren(container, el);
  }

  private renderHeader(sim: Record<string, unknown>): HTMLElement {
    const turn = sim.currentTurn as number || 0;
    const status = sim.status as string || '';
    const isRunning = status === 'SIMULATION_STATUS_RUNNING';
    const isConcluded = status === 'SIMULATION_STATUS_CONCLUDED';
    const isAutoPlaying = this.autoPlayInterval !== null;

    const casualties = (this.gameState?.casualties || []) as Array<Record<string, unknown>>;
    const totalKilled = casualties.reduce((s: number, c: Record<string, unknown>) => s + ((c.militaryKilled as number) || 0), 0);

    return h('div', { style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0d1117;border-bottom:1px solid #222;flex-shrink:0;' },
      h('div', { style: 'font-size:13px;font-weight:600;color:#58a6ff;' }, sim.name as string || 'Simulation'),
      h('div', { style: 'font-size:11px;color:#888;margin-left:auto;' },
        `Day ${turn} \u2022 ${isConcluded ? 'CONCLUDED' : isRunning ? 'ACTIVE' : status} \u2022 KIA: ${totalKilled.toLocaleString()}`,
      ),
      ...(isRunning ? [
        h('button', {
          style: 'background:#238636;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px;',
          onclick: () => this.handleAdvanceTurn(),
        }, '\u25B6 Next Turn'),
        h('button', {
          style: `background:${isAutoPlaying ? '#da3633' : '#1f6feb'};color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;`,
          onclick: () => this.toggleAutoPlay(),
        }, isAutoPlaying ? '\u23F8 Pause' : '\u23E9 Auto'),
      ] : []),
      h('button', {
        style: 'background:#333;color:#ccc;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;',
        onclick: () => { this.simulationId = null; this.gameState = null; if (this.autoPlayInterval) clearInterval(this.autoPlayInterval); this.autoPlayInterval = null; this.renderSetup(); },
      }, '\u2715 Reset'),
    );
  }

  private renderTabBar(): HTMLElement {
    const tabs: { id: ViewTab; label: string }[] = [
      { id: 'overview', label: 'Overview' },
      { id: 'units', label: 'Forces' },
      { id: 'missiles', label: 'Missiles' },
      { id: 'supply', label: 'Supply' },
      { id: 'territory', label: 'Territory' },
      { id: 'analysis', label: 'Analysis' },
    ];

    return h('div', { style: 'display:flex;gap:0;border-bottom:1px solid #222;flex-shrink:0;' },
      ...tabs.map(tab =>
        h('button', {
          style: `padding:6px 12px;font-size:11px;border:none;cursor:pointer;background:${this.activeTab === tab.id ? '#161b22' : 'transparent'};color:${this.activeTab === tab.id ? '#58a6ff' : '#888'};border-bottom:${this.activeTab === tab.id ? '2px solid #58a6ff' : '2px solid transparent'};`,
          onclick: () => { this.activeTab = tab.id; this.renderSimulation(); },
        }, tab.label),
      ),
    );
  }

  private renderTabContent(): HTMLElement {
    const wrapper = h('div', { style: 'flex:1;overflow:auto;padding:10px 12px;' });

    switch (this.activeTab) {
      case 'overview': wrapper.appendChild(this.renderOverviewTab()); break;
      case 'units': wrapper.appendChild(this.renderUnitsTab()); break;
      case 'missiles': wrapper.appendChild(this.renderMissilesTab()); break;
      case 'supply': wrapper.appendChild(this.renderSupplyTab()); break;
      case 'territory': wrapper.appendChild(this.renderTerritoryTab()); break;
      case 'analysis': wrapper.appendChild(this.renderAnalysisTab()); break;
    }

    return wrapper;
  }

  // ──────────────────────────────── Overview tab ────────────────────────────────

  private renderOverviewTab(): HTMLElement {
    const casualties = (this.gameState?.casualties || []) as Array<Record<string, unknown>>;
    const totalEngagements = (this.gameState?.totalEngagements as number) || 0;

    return h('div', { style: 'display:flex;flex-direction:column;gap:10px;' },
      // Faction casualty cards
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' },
        ...casualties.map((c: Record<string, unknown>) => this.renderCasualtyCard(c)),
      ),
      // Stats bar
      h('div', { style: 'display:flex;gap:16px;font-size:11px;color:#888;padding:8px 0;border-top:1px solid #222;' },
        h('span', {}, `Total engagements: ${totalEngagements}`),
        h('span', {}, `Units: ${((this.gameState?.units || []) as unknown[]).length}`),
      ),
      // Recent combat log
      this.renderRecentCombatLog(),
    );
  }

  private renderCasualtyCard(c: Record<string, unknown>): HTMLElement {
    const killed = (c.militaryKilled as number) || 0;
    const wounded = (c.militaryWounded as number) || 0;
    const missing = (c.militaryMissing as number) || 0;
    const civilian = (c.civilianCasualties as number) || 0;
    const equipment = (c.equipmentDestroyed as number) || 0;

    return h('div', { style: 'background:#161b22;border:1px solid #222;border-radius:6px;padding:10px;min-width:160px;flex:1;' },
      h('div', { style: 'font-weight:600;color:#58a6ff;font-size:12px;margin-bottom:6px;' }, (c.faction as string) || 'Unknown'),
      h('div', { style: 'font-size:11px;color:#f85149;' }, `KIA: ${killed.toLocaleString()}`),
      h('div', { style: 'font-size:11px;color:#d29922;' }, `WIA: ${wounded.toLocaleString()}`),
      h('div', { style: 'font-size:11px;color:#888;' }, `MIA: ${missing.toLocaleString()}`),
      h('div', { style: 'font-size:11px;color:#f0883e;margin-top:4px;' }, `Civilian: ${civilian.toLocaleString()}`),
      h('div', { style: 'font-size:11px;color:#8b949e;' }, `Equipment lost: ${equipment.toLocaleString()}`),
    );
  }

  private renderRecentCombatLog(): HTMLElement {
    // Show a placeholder for the combat log; actual data comes from turn history
    return h('div', { style: 'margin-top:8px;' },
      h('div', { style: 'font-size:12px;font-weight:600;color:#ccc;margin-bottom:6px;' }, 'Recent Activity'),
      h('div', { style: 'font-size:11px;color:#888;' },
        this.gameState?.totalEngagements
          ? 'Click "Next Turn" to advance the simulation and see combat results.'
          : 'No combat engagements yet. Advance the simulation to begin.',
      ),
    );
  }

  // ──────────────────────────────── Units tab ────────────────────────────────

  private renderUnitsTab(): HTMLElement {
    const units = (this.gameState?.units || []) as Array<Record<string, unknown>>;
    if (units.length === 0) return h('div', { style: 'color:#888;font-size:12px;' }, 'No units deployed.');

    return h('div', { style: 'display:flex;flex-direction:column;gap:4px;' },
      ...units.slice(0, 30).map(u => this.renderUnitRow(u)),
      units.length > 30 ? h('div', { style: 'color:#888;font-size:11px;padding:4px;' }, `+${units.length - 30} more units`) : h('span'),
    );
  }

  private renderUnitRow(u: Record<string, unknown>): HTMLElement {
    const state = u.state as string || '';
    const stateColor = state.includes('DESTROYED') ? '#f85149' :
      state.includes('RETREATING') ? '#d29922' :
      state.includes('DAMAGED') ? '#f0883e' :
      state.includes('MOVING') ? '#58a6ff' : '#3fb950';

    return h('div', { style: 'display:flex;align-items:center;gap:8px;padding:4px 6px;background:#0d1117;border-radius:4px;font-size:11px;' },
      h('div', { style: `width:8px;height:8px;border-radius:50%;background:${stateColor};flex-shrink:0;` }),
      h('div', { style: 'flex:1;color:#ccc;' }, (u.name as string) || 'Unit'),
      h('div', { style: 'color:#888;width:60px;' }, `${u.personnel || 0} pax`),
      h('div', { style: 'color:#888;width:50px;' }, `R:${u.readiness || 0}`),
      h('div', { style: 'color:#888;width:50px;' }, `M:${u.morale || 0}`),
      h('div', { style: 'color:#888;width:50px;' }, `S:${u.supplyLevel || 0}`),
      h('div', { style: `color:${stateColor};width:80px;font-size:10px;` },
        ((state as string).replace('UNIT_STATE_', '') || 'UNKNOWN').toLowerCase(),
      ),
    );
  }

  // ──────────────────────────────── Missiles tab ────────────────────────────────

  private renderMissilesTab(): HTMLElement {
    const loadEl = h('div', { style: 'color:#888;font-size:12px;' }, 'Loading missile systems...');

    if (this.simulationId) {
      listMissileSystems(this.simulationId).then((result: unknown) => {
        const data = result as { systems: Array<Record<string, unknown>> };
        if (!data.systems?.length) {
          replaceChildren(loadEl, h('span', {}, 'No missile systems deployed.'));
          return;
        }
        const content = h('div', { style: 'display:flex;flex-direction:column;gap:6px;' },
          h('div', { style: 'font-size:12px;font-weight:600;color:#ccc;margin-bottom:4px;' }, 'Deployed Missile Systems'),
          ...data.systems.map(sys =>
            h('div', { style: 'background:#0d1117;border-radius:4px;padding:8px;font-size:11px;' },
              h('div', { style: 'display:flex;justify-content:space-between;' },
                h('span', { style: 'color:#58a6ff;font-weight:600;' }, (sys.designation as string) || 'Unknown'),
                h('span', { style: `color:${sys.operational ? '#3fb950' : '#f85149'};` }, sys.operational ? 'OPERATIONAL' : 'DOWN'),
              ),
              h('div', { style: 'color:#888;margin-top:4px;' },
                `${sys.faction} \u2022 Range: ${sys.rangeKm}km \u2022 Ammo: ${sys.ammoRemaining}/${sys.ammoCapacity} \u2022 Type: ${((sys.missileType as string) || '').replace('MISSILE_TYPE_', '').toLowerCase()}`,
              ),
            )
          ),
        );
        replaceChildren(loadEl, content);
      }).catch(() => {
        replaceChildren(loadEl, h('span', { style: 'color:#f85149;' }, 'Failed to load missile systems.'));
      });
    }

    return loadEl;
  }

  // ──────────────────────────────── Supply tab ────────────────────────────────

  private renderSupplyTab(): HTMLElement {
    const sim = this.gameState?.simulation as Record<string, unknown>;
    const factions = (sim?.factions || []) as string[];
    const loadEl = h('div', { style: 'color:#888;font-size:12px;' }, 'Loading supply data...');

    if (this.simulationId && factions.length > 0) {
      Promise.all(factions.map(f => getSupplyStatus(this.simulationId!, f) as Promise<Record<string, unknown>>))
        .then(results => {
          const content = h('div', { style: 'display:flex;flex-direction:column;gap:10px;' },
            ...results.map((r, idx) => {
              const res = r.resources as Record<string, unknown> | undefined;
              if (!res) return h('div', { style: 'color:#888;font-size:11px;' }, `${factions[idx]}: No data`);

              const healthColor = (res.logisticsHealth as number) > 70 ? '#3fb950' :
                (res.logisticsHealth as number) > 40 ? '#d29922' : '#f85149';

              return h('div', { style: 'background:#0d1117;border-radius:6px;padding:10px;' },
                h('div', { style: 'display:flex;justify-content:space-between;margin-bottom:6px;' },
                  h('span', { style: 'font-weight:600;color:#58a6ff;font-size:12px;' }, factions[idx]),
                  h('span', { style: `color:${healthColor};font-size:11px;` }, `Health: ${res.logisticsHealth}%`),
                ),
                this.renderBar('Ammo', (res.ammunitionTons as number) || 0, 50000, '#f0883e'),
                this.renderBar('Fuel', (res.fuelTons as number) || 0, 80000, '#58a6ff'),
                this.renderBar('Food', (res.foodDays as number) || 0, 90, '#3fb950'),
                h('div', { style: 'font-size:10px;color:#f85149;margin-top:4px;' },
                  `Days until critical: ${Math.round((res.daysUntilCritical as number) || 0)}`,
                ),
              );
            }),
          );
          replaceChildren(loadEl, content);
        })
        .catch(() => replaceChildren(loadEl, h('span', { style: 'color:#f85149;' }, 'Failed to load supply data.')));
    }

    return loadEl;
  }

  private renderBar(label: string, value: number, max: number, color: string): HTMLElement {
    const pct = Math.min(100, (value / max) * 100);
    return h('div', { style: 'display:flex;align-items:center;gap:6px;margin:2px 0;' },
      h('span', { style: 'width:40px;font-size:10px;color:#888;' }, label),
      h('div', { style: 'flex:1;height:6px;background:#222;border-radius:3px;overflow:hidden;' },
        h('div', { style: `width:${pct}%;height:100%;background:${color};border-radius:3px;transition:width 0.3s;` }),
      ),
      h('span', { style: 'font-size:10px;color:#888;width:35px;text-align:right;' }, `${Math.round(pct)}%`),
    );
  }

  // ──────────────────────────────── Territory tab ────────────────────────────────

  private renderTerritoryTab(): HTMLElement {
    const loadEl = h('div', { style: 'color:#888;font-size:12px;' }, 'Loading territorial data...');

    if (this.simulationId) {
      getTerritorialControl(this.simulationId).then((result: unknown) => {
        const data = result as { territories: Array<Record<string, unknown>>; totalContested: number };
        if (!data.territories?.length) {
          replaceChildren(loadEl, h('span', {}, 'No territorial data.'));
          return;
        }

        const content = h('div', { style: 'display:flex;flex-direction:column;gap:6px;' },
          h('div', { style: 'font-size:11px;color:#888;margin-bottom:6px;' },
            `${data.territories.length} territories \u2022 ${data.totalContested} contested`,
          ),
          ...data.territories.map(t => {
            const trendColor = (t.trend as string)?.includes('EXPANDING') ? '#3fb950' :
              (t.trend as string)?.includes('CONTRACTING') ? '#f85149' :
              (t.trend as string)?.includes('CONTESTED') ? '#d29922' : '#888';

            return h('div', { style: 'background:#0d1117;border-radius:4px;padding:8px;font-size:11px;' },
              h('div', { style: 'display:flex;justify-content:space-between;' },
                h('span', { style: 'color:#58a6ff;' }, `${t.faction} Territory`),
                h('span', { style: `color:${trendColor};` },
                  ((t.trend as string) || '').replace('TERRITORY_TREND_', '').toLowerCase(),
                ),
              ),
              h('div', { style: 'color:#888;margin-top:4px;' },
                `Area: ${Math.round((t.areaSqKm as number) || 0).toLocaleString()} km\u00B2 \u2022 Pop: ${((t.population as number) || 0).toLocaleString()} \u2022 Garrison: ${t.garrisonCount || 0} units${t.contested ? ' \u2022 CONTESTED' : ''}`,
              ),
            );
          }),
        );
        replaceChildren(loadEl, content);
      }).catch(() => replaceChildren(loadEl, h('span', { style: 'color:#f85149;' }, 'Failed to load territorial data.')));
    }

    return loadEl;
  }

  // ──────────────────────────────── Analysis tab ────────────────────────────────

  private renderAnalysisTab(): HTMLElement {
    const loadEl = h('div', { style: 'color:#888;font-size:12px;' }, 'Loading analysis...');

    if (this.simulationId) {
      analyzeOutcomes(this.simulationId).then((result: unknown) => {
        const data = result as { scenarios: Array<Record<string, unknown>>; analysisSummary: string };

        const content = h('div', { style: 'display:flex;flex-direction:column;gap:10px;' },
          // Summary
          h('div', { style: 'font-size:12px;color:#ccc;padding:8px;background:#0d1117;border-radius:6px;line-height:1.5;' },
            data.analysisSummary || 'Insufficient data for analysis.',
          ),
          // Outcome scenarios
          h('div', { style: 'font-size:12px;font-weight:600;color:#ccc;' }, 'Outcome Scenarios'),
          ...(data.scenarios || []).map(s => {
            const prob = (s.probabilityPercent as number) || 0;
            const barColor = prob > 40 ? '#f85149' : prob > 25 ? '#d29922' : '#3fb950';

            return h('div', { style: 'background:#0d1117;border-radius:6px;padding:10px;' },
              h('div', { style: 'display:flex;justify-content:space-between;margin-bottom:4px;' },
                h('span', { style: 'color:#58a6ff;font-weight:600;font-size:12px;' }, (s.label as string) || ''),
                h('span', { style: `color:${barColor};font-weight:600;font-size:12px;` }, `${prob}%`),
              ),
              h('div', { style: 'height:4px;background:#222;border-radius:2px;margin-bottom:6px;overflow:hidden;' },
                h('div', { style: `width:${prob}%;height:100%;background:${barColor};border-radius:2px;` }),
              ),
              h('div', { style: 'font-size:11px;color:#888;line-height:1.4;' }, (s.description as string) || ''),
              h('div', { style: 'font-size:10px;color:#666;margin-top:4px;' },
                `Duration: ~${s.durationDays || '?'} days \u2022 Military casualties: ~${((s.expectedMilitaryCasualties as number) || 0).toLocaleString()} \u2022 Civilian: ~${((s.expectedCivilianCasualties as number) || 0).toLocaleString()}`,
              ),
              h('div', { style: 'font-size:10px;color:#555;margin-top:2px;' },
                `Resolution: ${(s.resolutionMechanism as string) || 'unknown'}`,
              ),
            );
          }),
        );
        replaceChildren(loadEl, content);
      }).catch(() => replaceChildren(loadEl, h('span', { style: 'color:#f85149;' }, 'Failed to load analysis.')));
    }

    return loadEl;
  }

  // ──────────────────────────────── Helpers ────────────────────────────────

  private getContentElement(): HTMLElement | null {
    return this.contentEl ?? null;
  }

  private showError(msg: string): void {
    const el = this.getContentElement();
    if (el) replaceChildren(el, h('div', { style: 'color:#f85149;padding:12px;font-size:12px;' }, msg));
  }
}
