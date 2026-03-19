/**
 * MissileTrackerPanel — Displays missile launch events, interception attempts,
 * deployed systems, and real-time trajectory tracking.
 *
 * Shows:
 *   - Active missile launches with status (in-flight, intercepted, impacted, failed)
 *   - Deployed missile and air defense systems
 *   - Interception success/failure records
 *   - Missile system ammo status
 */

import { Panel } from './Panel';
import { h, replaceChildren } from '@/utils/dom-utils';
import {
  listMissileSystems,
  emitWarfareUpdate,
} from '@/services/warfare-simulation';

export class MissileTrackerPanel extends Panel {
  private simulationId: string | null = null;
  private boundUpdateHandler: EventListener;

  constructor() {
    super({
      id: 'missile-tracker',
      title: 'Missile Tracker',
      showCount: true,
      infoTooltip: 'Tracks missile launches, trajectories, interception attempts, and deployed weapon/air defense systems.',
    });

    this.boundUpdateHandler = ((e: CustomEvent) => {
      if (e.detail?.simulationId) {
        this.simulationId = e.detail.simulationId;
        this.refreshData();
      }
    }) as EventListener;
    document.addEventListener('wm:warfare-updated', this.boundUpdateHandler);

    this.showLoading('Waiting for active simulation...');
  }

  override destroy(): void {
    document.removeEventListener('wm:warfare-updated', this.boundUpdateHandler);
    super.destroy();
  }

  private async refreshData(): Promise<void> {
    if (!this.simulationId) return;

    try {
      const result = await listMissileSystems(this.simulationId) as { systems: Array<Record<string, unknown>> };
      this.renderSystems(result.systems || []);
    } catch {
      // Silently ignore
    }
  }

  private renderSystems(systems: Array<Record<string, unknown>>): void {
    if (!this.contentEl) return;

    if (systems.length === 0) {
      this.showLoading('No missile systems deployed in current simulation.');
      return;
    }

    this.setCount(systems.length);

    const el = h('div', { style: 'display:flex;flex-direction:column;gap:6px;' },
      ...systems.map(sys => {
        const ammoRemaining = (sys.ammoRemaining as number) || 0;
        const ammoCapacity = (sys.ammoCapacity as number) || 1;
        const ammoPct = (ammoRemaining / ammoCapacity) * 100;
        const ammoColor = ammoPct > 50 ? '#3fb950' : ammoPct > 20 ? '#d29922' : '#f85149';

        return h('div', { style: 'background:#0d1117;border:1px solid #222;border-radius:6px;padding:8px 10px;' },
          h('div', { style: 'display:flex;justify-content:space-between;align-items:center;' },
            h('div', {},
              h('span', { style: 'font-weight:600;color:#58a6ff;font-size:12px;' }, (sys.designation as string) || 'Unknown System'),
              h('span', { style: 'color:#888;font-size:10px;margin-left:8px;' },
                ((sys.missileType as string) || '').replace('MISSILE_TYPE_', '').replace(/_/g, ' ').toLowerCase(),
              ),
            ),
            h('span', { style: `font-size:10px;font-weight:600;color:${sys.operational ? '#3fb950' : '#f85149'};` },
              sys.operational ? 'OPERATIONAL' : 'OFFLINE',
            ),
          ),
          h('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:6px;' },
            h('span', { style: 'font-size:10px;color:#888;width:35px;' }, 'Ammo'),
            h('div', { style: 'flex:1;height:4px;background:#222;border-radius:2px;overflow:hidden;' },
              h('div', { style: `width:${ammoPct}%;height:100%;background:${ammoColor};border-radius:2px;` }),
            ),
            h('span', { style: `font-size:10px;color:${ammoColor};width:35px;text-align:right;` }, `${ammoRemaining}/${ammoCapacity}`),
          ),
          h('div', { style: 'font-size:10px;color:#666;margin-top:4px;' },
            `${sys.faction} \u2022 Range: ${sys.rangeKm}km`,
          ),
        );
      }),
    );

    replaceChildren(this.contentEl, el);
  }
}
