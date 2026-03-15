/**
 * Pinned Webcams Panel — shows up to 4 user-pinned webcams as live iframes.
 * Webcams can be pinned via the map context menu (right-click a webcam marker).
 * Ported from koala73/worldmonitor upstream.
 */

import { Panel } from './Panel';
import { t } from '../services/i18n';
import {
  getPinnedWebcams,
  getActiveWebcams,
  unpinWebcam,
  toggleWebcam,
  onPinnedChange,
} from '../services/webcams/pinned-store';

const MAX_SLOTS = 4;
const PLAYER_FALLBACK = 'https://webcams.windy.com/webcams/public/embed/player';

function buildPlayerUrl(webcamId: string, playerUrl?: string): string {
  if (playerUrl) return playerUrl;
  return `${PLAYER_FALLBACK}/${encodeURIComponent(webcamId)}/day`;
}

export class PinnedWebcamsPanel extends Panel {
  private unsubscribe: (() => void) | null = null;

  constructor() {
    super({
      id: 'pinned-webcams',
      title: t('panels.pinnedWebcams') || 'Pinned Webcams',
      trackActivity: false,
    });
    this.unsubscribe = onPinnedChange(() => this.render());
    this.render();
  }

  private render(): void {
    while (this.content.firstChild) this.content.removeChild(this.content.firstChild);
    this.content.className = 'panel-content pinned-webcams-content';

    const active   = getActiveWebcams();
    const allPinned = getPinnedWebcams();

    const grid = document.createElement('div');
    grid.className = 'pinned-webcams-grid';

    for (let i = 0; i < MAX_SLOTS; i++) {
      const slot = document.createElement('div');
      slot.className = 'pinned-webcam-slot';

      const cam = active[i];
      if (cam) {
        const iframe = document.createElement('iframe');
        iframe.className = 'pinned-webcam-iframe';
        iframe.src = buildPlayerUrl(cam.webcamId, cam.playerUrl);
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
        iframe.setAttribute('frameborder', '0');
        iframe.title = cam.title || cam.webcamId;
        iframe.allow = 'autoplay; encrypted-media';
        iframe.allowFullscreen = true;
        iframe.setAttribute('loading', 'lazy');
        slot.appendChild(iframe);

        const labelBar = document.createElement('div');
        labelBar.className = 'pinned-webcam-label';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'pinned-webcam-title';
        titleSpan.textContent = cam.title || cam.webcamId;
        labelBar.appendChild(titleSpan);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'pinned-webcam-toggle';
        toggleBtn.title = 'Hide stream';
        toggleBtn.textContent = '⏸';
        toggleBtn.addEventListener('click', () => toggleWebcam(cam.webcamId));
        labelBar.appendChild(toggleBtn);

        const unpinBtn = document.createElement('button');
        unpinBtn.className = 'pinned-webcam-unpin';
        unpinBtn.title = 'Unpin';
        unpinBtn.textContent = '✖';
        unpinBtn.addEventListener('click', () => unpinWebcam(cam.webcamId));
        labelBar.appendChild(unpinBtn);

        slot.appendChild(labelBar);
      } else {
        slot.classList.add('pinned-webcam-slot--empty');
        const placeholder = document.createElement('div');
        placeholder.className = 'pinned-webcam-placeholder';
        placeholder.textContent = 'Right-click a webcam on the map to pin it here';
        slot.appendChild(placeholder);
      }

      grid.appendChild(slot);
    }

    this.content.appendChild(grid);

    // Show overflow list when more than MAX_SLOTS webcams are pinned
    if (allPinned.length > MAX_SLOTS) {
      const listSection = document.createElement('div');
      listSection.className = 'pinned-webcams-list';

      const listHeader = document.createElement('div');
      listHeader.className = 'pinned-webcams-list-header';
      listHeader.textContent = `All pinned (${allPinned.length})`;
      listSection.appendChild(listHeader);

      allPinned.forEach(cam => {
        const row = document.createElement('div');
        row.className = 'pinned-webcam-row' + (cam.active ? ' pinned-webcam-row--active' : '');

        const name = document.createElement('span');
        name.className = 'pinned-webcam-row-name';
        name.textContent = cam.title || cam.webcamId;
        row.appendChild(name);

        const country = document.createElement('span');
        country.className = 'pinned-webcam-row-country';
        country.textContent = cam.country;
        row.appendChild(country);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'pinned-webcam-row-toggle';
        toggleBtn.textContent = cam.active ? 'ON' : 'OFF';
        toggleBtn.addEventListener('click', () => toggleWebcam(cam.webcamId));
        row.appendChild(toggleBtn);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'pinned-webcam-row-remove';
        removeBtn.textContent = '✖';
        removeBtn.title = 'Unpin';
        removeBtn.addEventListener('click', () => unpinWebcam(cam.webcamId));
        row.appendChild(removeBtn);

        listSection.appendChild(row);
      });

      this.content.appendChild(listSection);
    }

    // Empty state when nothing pinned yet
    if (allPinned.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pinned-webcams-empty';
      empty.innerHTML = '<div class="pinned-webcams-empty-icon">📷</div>' +
        '<div class="pinned-webcams-empty-text">No webcams pinned yet.<br>Right-click a webcam marker on the map to pin it.</div>';
      this.content.appendChild(empty);
    }
  }

  public refresh(): void {
    this.render();
  }

  public override destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.content.querySelectorAll('iframe').forEach(f => {
      f.src = 'about:blank';
      f.remove();
    });
    super.destroy();
  }
}
