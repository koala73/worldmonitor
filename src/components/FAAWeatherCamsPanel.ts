import { Panel } from './Panel';
import { fetchFAACameras, scoreCamerasAgainstAlerts } from '@/services/faa-cameras';
import type { ScoredFAACamera } from '@/services/faa-cameras';
import { fetchNWSAlerts } from '@/services/nws-alerts';
import { fetchGDACSEvents } from '@/services/gdacs';
import { getApiBaseUrl } from '@/services/runtime';

export class FAAWeatherCamsPanel extends Panel {
  private cameras: ScoredFAACamera[] = [];
  private alertOnly = false;
  private selectedCam: ScoredFAACamera | null = null;
  private digestText: string | null = null;

  constructor() {
    super({ id: 'faa-weather-cams', title: 'FAA Weather Cams', className: 'panel-wide' });
    this.load();
  }

  private async load(): Promise<void> {
    const [raw, nws, gdacs] = await Promise.all([
      fetchFAACameras(),
      fetchNWSAlerts(),
      fetchGDACSEvents(),
    ]);
    this.cameras = scoreCamerasAgainstAlerts(raw, nws, gdacs);
    this.render();
  }

  public refresh(): void {
    this.load();
  }

  private get displayed(): ScoredFAACamera[] {
    return this.alertOnly
      ? this.cameras.filter(c => c.alertProximityMi !== null)
      : this.cameras;
  }

  private render(): void {
    const el = this.getContentElement();
    while (el.firstChild) el.removeChild(el.firstChild);
    el.className = 'panel-content faa-cams-content';

    const alertCams = this.cameras.filter(c => c.alertProximityMi !== null);
    if (alertCams.length >= 2 && this.digestText) {
      const banner = document.createElement('div');
      banner.className = 'faa-digest-banner';
      banner.textContent = this.digestText;
      el.appendChild(banner);
    }

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'faa-cams-toolbar';
    const label = document.createElement('label');
    label.className = 'faa-toggle-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.alertOnly;
    cb.addEventListener('change', () => { this.alertOnly = cb.checked; this.render(); });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' Alert-proximate only'));
    const countEl = document.createElement('span');
    countEl.className = 'faa-cam-count';
    countEl.textContent = `${this.displayed.length} cameras`;
    toolbar.appendChild(label);
    toolbar.appendChild(countEl);
    el.appendChild(toolbar);

    if (this.selectedCam) el.appendChild(this._buildViewer(this.selectedCam));

    // Table
    const table = document.createElement('table');
    table.className = 'faa-cams-table eq-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of ['Camera', 'Location', 'Alert', 'Score', 'Updated']) {
      const th = document.createElement('th');
      th.textContent = col;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const cam of this.displayed) {
      const tr = document.createElement('tr');
      tr.className = `eq-row${cam.alertProximityMi !== null ? ' eq-moderate' : ''}`;
      if (this.selectedCam?.id === cam.id) tr.classList.add('faa-cam-selected');

      const tdName = document.createElement('td');
      tdName.textContent = cam.name;

      const tdLoc = document.createElement('td');
      tdLoc.textContent = cam.category !== 'weather'
        ? `${cam.state} · ${cam.category}`
        : cam.state;

      const tdAlert = document.createElement('td');
      if (cam.alertLabel) {
        const badge = document.createElement('span');
        badge.className = 'faa-alert-badge';
        badge.textContent = cam.alertLabel;
        tdAlert.appendChild(badge);
      } else {
        tdAlert.textContent = '—';
      }

      const tdScore = document.createElement('td');
      tdScore.textContent = String(cam.relevanceScore);

      const tdTime = document.createElement('td');
      tdTime.textContent = this._relativeTime(cam.lastUpdated);

      for (const td of [tdName, tdLoc, tdAlert, tdScore, tdTime]) tr.appendChild(td);

      tr.addEventListener('click', () => {
        this.selectedCam = this.selectedCam?.id === cam.id ? null : cam;
        this.render();
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.appendChild(table);

    if (this.displayed.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'faa-empty';
      empty.textContent = this.alertOnly
        ? 'No cameras near active alerts.'
        : 'No camera data available.';
      el.appendChild(empty);
    }
  }

  private _buildViewer(cam: ScoredFAACamera): HTMLElement {
    const div = document.createElement('div');
    div.className = 'faa-cam-viewer';

    const header = document.createElement('div');
    header.className = 'faa-cam-viewer-header';
    const nameEl = document.createElement('strong');
    nameEl.textContent = cam.name;
    header.appendChild(nameEl);
    if (cam.alertLabel) {
      const badge = document.createElement('span');
      badge.className = 'faa-alert-badge';
      badge.textContent = cam.alertLabel;
      header.appendChild(badge);
    }
    const updatedEl = document.createElement('span');
    updatedEl.className = 'faa-cam-updated';
    updatedEl.textContent = this._relativeTime(cam.lastUpdated);
    header.appendChild(updatedEl);

    const img = document.createElement('img');
    img.className = 'faa-cam-image';
    img.src = cam.imageUrl;
    img.alt = cam.name;
    img.loading = 'lazy';

    const analyzeBtn = document.createElement('button');
    analyzeBtn.className = 'faa-analyze-btn';
    analyzeBtn.textContent = cam.aiConditions ?? 'Analyze conditions';
    analyzeBtn.disabled = !!cam.aiConditions;
    analyzeBtn.addEventListener('click', () => this._analyzeCamera(cam, analyzeBtn));

    div.appendChild(header);
    div.appendChild(img);
    div.appendChild(analyzeBtn);
    return div;
  }

  private async _analyzeCamera(cam: ScoredFAACamera, btn: HTMLButtonElement): Promise<void> {
    btn.textContent = 'Analyzing…';
    btn.disabled = true;
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/faa-cam-analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: cam.imageUrl,
          cameraName: cam.name,
          alertLabel: cam.alertLabel,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json() as { conditions?: string; error?: string };
      const idx = this.cameras.findIndex(c => c.id === cam.id);
      if (idx !== -1) {
        this.cameras[idx]!.aiConditions = data.conditions ?? data.error ?? 'No response';
        if (this.selectedCam?.id === cam.id) this.selectedCam = this.cameras[idx] ?? null;
      }
    } catch {
      btn.textContent = 'Analysis unavailable';
      btn.disabled = false;
      return;
    }
    this.render();
  }

  private _relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    return `${Math.floor(min / 60)}h ago`;
  }

  public setDisasterMode(active: boolean, disasterCameras?: ScoredFAACamera[]): void {
    if (active && disasterCameras) {
      this.cameras = disasterCameras;
      this.alertOnly = true;
    } else if (!active) {
      this.alertOnly = false;
      this.load();
    }
    this.render();
  }

  public setDigest(text: string): void {
    this.digestText = text;
    this.render();
  }
}
