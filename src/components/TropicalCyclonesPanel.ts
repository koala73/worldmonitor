import { Panel } from './Panel';
import type { TropicalCyclone } from '@/services/tropical-cyclones';
import { tcSeverityClass, tcCategoryLabel } from '@/services/tropical-cyclones';
import { escapeHtml } from '@/utils/sanitize';

export class TropicalCyclonesPanel extends Panel {
  private storms: TropicalCyclone[] = [];

  constructor() {
    super({
      id: 'tropical-cyclones',
      title: 'Tropical Cyclones',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Active tropical cyclones and hurricanes from NHC and JTWC advisories.',
    });
    this.showLoading('Fetching tropical cyclone data...');
  }

  public update(storms: TropicalCyclone[]): void {
    this.storms = storms;
    this.setCount(storms.length);
    this.render();
  }

  private render(): void {
    if (this.storms.length === 0) {
      this.setContent('<div class="panel-empty">No active tropical cyclones.</div>');
      return;
    }

    const rows = this.storms.map(s => {
      const rowClass = tcSeverityClass(s.severity);
      const catLabel = tcCategoryLabel(s.category);
      const windCell = s.windKts === null ? '—' : `${s.windKts} kt`;
      const movCell = s.movement ? escapeHtml(s.movement) : '—';
      const basinLabel = escapeHtml(basinName(s.basin));
      return `<tr class="${rowClass}">
        <td class="tc-cat">${escapeHtml(catLabel)}</td>
        <td class="tc-name">${escapeHtml(s.name)}</td>
        <td class="tc-basin">${basinLabel}</td>
        <td class="tc-wind">${windCell}</td>
        <td class="tc-movement">${movCell}</td>
        <td class="tc-date">${timeAgo(s.advisoryTime)}</td>
      </tr>`;
    }).join('');

    this.setContent(`
      <div class="tc-panel-content">
        <table class="eq-table">
          <thead>
            <tr>
              <th>Cat</th>
              <th>Name</th>
              <th>Basin</th>
              <th>Wind</th>
              <th>Movement</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fires-footer">
          <span class="fires-source">NHC · JTWC · ${this.storms.length} active</span>
        </div>
      </div>
    `);
  }
}

function basinName(basin: TropicalCyclone['basin']): string {
  const names: Record<string, string> = {
    atlantic: 'Atlantic',
    east_pacific: 'E. Pacific',
    central_pacific: 'C. Pacific',
    west_pacific: 'W. Pacific',
    north_indian: 'N. Indian',
    south_indian: 'S. Indian',
    south_pacific: 'S. Pacific',
  };
  return names[basin] ?? basin;
}

function timeAgo(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
