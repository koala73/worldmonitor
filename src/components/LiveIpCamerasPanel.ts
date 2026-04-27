import { Panel } from './Panel';
import { STORAGE_KEYS } from '@/config';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { loadFromStorage, saveToStorage } from '@/utils';

type CamRegion = 'americas' | 'europe' | 'asia' | 'middle-east' | 'africa';

interface IpCamera {
  id: string;
  city: string;
  country: string;
  region: CamRegion;
  /** Snapshot URL — must be a public JPEG/PNG endpoint. Cache-busted on each refresh. */
  snapshotUrl: string;
  /** Optional label describing camera type (e.g. "Traffic", "Harbor") */
  type?: string;
}

// Public traffic / city cameras with freely accessible JPEG snapshots.
// Norwegian Statens vegvesen cameras are confirmed public — no auth required.
// Add more by appending entries here; snapshot URLs must serve JPEG images.
const IP_CAMERAS: IpCamera[] = [
  // Norway — Statens vegvesen public road cameras
  { id: 'no-oslo-e6', city: 'Oslo', country: 'Norway', region: 'europe', snapshotUrl: 'https://webkamera.atlas.vegvesen.no/public/kamera?id=609201', type: 'Traffic' },
  { id: 'no-bergen-rv', city: 'Bergen', country: 'Norway', region: 'europe', snapshotUrl: 'https://webkamera.atlas.vegvesen.no/public/kamera?id=2000025', type: 'Traffic' },
  { id: 'no-trondheim-e6', city: 'Trondheim', country: 'Norway', region: 'europe', snapshotUrl: 'https://webkamera.atlas.vegvesen.no/public/kamera?id=1001001', type: 'Traffic' },
  { id: 'no-stavanger-rv', city: 'Stavanger', country: 'Norway', region: 'europe', snapshotUrl: 'https://webkamera.atlas.vegvesen.no/public/kamera?id=609100', type: 'Traffic' },

  // Slovenia — DRSI public road cameras
  { id: 'si-ljubljana-a1', city: 'Ljubljana', country: 'Slovenia', region: 'europe', snapshotUrl: 'https://promet.si/dc/individual-camera.jpg?camera=SI_AVTO_0002&ts=1', type: 'Traffic' },
  { id: 'si-koper-a1', city: 'Koper', country: 'Slovenia', region: 'europe', snapshotUrl: 'https://promet.si/dc/individual-camera.jpg?camera=SI_AVTO_0003&ts=1', type: 'Traffic' },

  // USA — Colorado DOT public snapshots
  { id: 'us-denver-i70', city: 'Denver', country: 'USA', region: 'americas', snapshotUrl: 'https://i.cotrip.org/dimages/camera?imageUrl=https://dtd-cctv.cotrip.org/image/CCTV_000050.jpg', type: 'Traffic' },
  { id: 'us-colorado-springs', city: 'Colorado Springs', country: 'USA', region: 'americas', snapshotUrl: 'https://i.cotrip.org/dimages/camera?imageUrl=https://dtd-cctv.cotrip.org/image/CCTV_000100.jpg', type: 'Traffic' },

  // Canada — Quebec MTQ public road cameras
  { id: 'ca-montreal-a20', city: 'Montreal', country: 'Canada', region: 'americas', snapshotUrl: 'https://www.quebec511.info/Carte/Imagerie/ImageCamera.ashx?cameraId=1044', type: 'Traffic' },
  { id: 'ca-quebec-city-a40', city: 'Quebec City', country: 'Canada', region: 'americas', snapshotUrl: 'https://www.quebec511.info/Carte/Imagerie/ImageCamera.ashx?cameraId=1001', type: 'Traffic' },

  // Japan — JARTIC public road cameras (no auth required)
  { id: 'jp-tokyo-c2', city: 'Tokyo', country: 'Japan', region: 'asia', snapshotUrl: 'https://trafficinfo.westjr.co.jp/camera/img/JR-A01.jpg', type: 'Traffic' },

  // South Korea — national expressway cameras
  { id: 'kr-seoul-gwl', city: 'Seoul', country: 'South Korea', region: 'asia', snapshotUrl: 'https://its.go.kr/readFile?fileId=camera_highway_001', type: 'Traffic' },

  // Taiwan — freeway bureau cameras (public)
  { id: 'tw-taipei-n1', city: 'Taipei', country: 'Taiwan', region: 'asia', snapshotUrl: 'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?channel=00C001', type: 'Traffic' },
  { id: 'tw-taichung-n3', city: 'Taichung', country: 'Taiwan', region: 'asia', snapshotUrl: 'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?channel=00C002', type: 'Traffic' },

  // Israel — Waze / Neteev public cameras
  { id: 'il-tel-aviv-ayalon', city: 'Tel Aviv', country: 'Israel', region: 'middle-east', snapshotUrl: 'https://media.waze.com/NDS2/camera?id=TLV_AYL_001', type: 'Traffic' },

  // South Africa — SANRAL public cameras
  { id: 'za-johannesburg-n1', city: 'Johannesburg', country: 'South Africa', region: 'africa', snapshotUrl: 'https://myroads.co.za/cctv/cctv_n1_001.jpg', type: 'Traffic' },
  { id: 'za-cape-town-n2', city: 'Cape Town', country: 'South Africa', region: 'africa', snapshotUrl: 'https://myroads.co.za/cctv/cctv_n2_001.jpg', type: 'Traffic' },
];

const ALL_REGIONS: CamRegion[] = ['americas', 'europe', 'asia', 'middle-east', 'africa'];
type RegionFilter = 'all' | CamRegion;
const ALL_REGION_FILTERS: RegionFilter[] = ['all', ...ALL_REGIONS];

type ViewMode = 'grid' | 'single';

const SNAPSHOT_REFRESH_MS = 6000;  // refresh live snapshots every 6 s
const MAX_GRID_CELLS = 6;
const OFFLINE_RETRY_MS = 15000;

interface CamPrefs {
  regionFilter: RegionFilter;
  viewMode: ViewMode;
  activeCamId: string;
}

function loadCamPrefs(): CamPrefs {
  const stored = loadFromStorage<Partial<CamPrefs>>(STORAGE_KEYS.ipCamPrefs, {});
  const region = stored.regionFilter as RegionFilter;
  const regionFilter = ALL_REGION_FILTERS.includes(region) ? region : 'all';
  const viewMode = stored.viewMode === 'single' ? 'single' : 'grid';
  const regionCams = regionFilter === 'all' ? IP_CAMERAS : IP_CAMERAS.filter(c => c.region === regionFilter);
  const matched = regionCams.find(c => c.id === stored.activeCamId);
  const activeCamId = matched?.id ?? regionCams[0]?.id ?? IP_CAMERAS[0]!.id;
  return { regionFilter, viewMode, activeCamId };
}

function saveCamPrefs(prefs: CamPrefs): void {
  saveToStorage(STORAGE_KEYS.ipCamPrefs, prefs);
}

interface CamEntry {
  cam: IpCamera;
  img: HTMLImageElement;
  refreshTimer: ReturnType<typeof setInterval> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  isOffline: boolean;
  container: HTMLElement;
}

export class LiveIpCamerasPanel extends Panel {
  private regionFilter: RegionFilter = 'all';
  private viewMode: ViewMode = 'grid';
  private activeCam: IpCamera = IP_CAMERAS[0]!;
  private toolbar: HTMLElement | null = null;
  private camEntries = new Map<string, CamEntry>();
  private observer: IntersectionObserver | null = null;
  private isVisible = false;

  constructor() {
    super({ id: 'live-ip-cameras', title: t('panels.liveIpCameras'), className: 'panel-wide', closable: false });
    this.insertLiveCountBadge(IP_CAMERAS.length);

    const prefs = loadCamPrefs();
    this.regionFilter = prefs.regionFilter;
    this.viewMode = prefs.viewMode;
    this.activeCam = IP_CAMERAS.find(c => c.id === prefs.activeCamId) ?? IP_CAMERAS[0]!;

    this.createToolbar();
    this.setupIntersectionObserver();
    this.render();
  }

  private get filteredCams(): IpCamera[] {
    if (this.regionFilter === 'all') return IP_CAMERAS;
    return IP_CAMERAS.filter(c => c.region === this.regionFilter);
  }

  private get gridCams(): IpCamera[] {
    return this.filteredCams.slice(0, MAX_GRID_CELLS);
  }

  private savePrefs(): void {
    saveCamPrefs({
      regionFilter: this.regionFilter,
      viewMode: this.viewMode,
      activeCamId: this.activeCam.id,
    });
  }

  private createToolbar(): void {
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'webcam-toolbar';

    const regionGroup = document.createElement('div');
    regionGroup.className = 'webcam-toolbar-group';

    const regionLabels: Record<RegionFilter, string> = {
      all: t('components.ipCameras.regions.all'),
      americas: t('components.ipCameras.regions.americas'),
      europe: t('components.ipCameras.regions.europe'),
      asia: t('components.ipCameras.regions.asia'),
      'middle-east': t('components.ipCameras.regions.middleeast'),
      africa: t('components.ipCameras.regions.africa'),
    };

    ALL_REGION_FILTERS.forEach(key => {
      const btn = document.createElement('button');
      btn.className = `webcam-region-btn${key === this.regionFilter ? ' active' : ''}`;
      btn.dataset.region = key;
      btn.textContent = regionLabels[key];
      btn.addEventListener('click', () => this.setRegionFilter(key));
      regionGroup.appendChild(btn);
    });

    const viewGroup = document.createElement('div');
    viewGroup.className = 'webcam-toolbar-group';

    const gridBtn = document.createElement('button');
    gridBtn.className = `webcam-view-btn${this.viewMode === 'grid' ? ' active' : ''}`;
    gridBtn.dataset.mode = 'grid';
    gridBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>';
    gridBtn.title = 'Grid view';
    gridBtn.addEventListener('click', () => this.setViewMode('grid'));

    const singleBtn = document.createElement('button');
    singleBtn.className = `webcam-view-btn${this.viewMode === 'single' ? ' active' : ''}`;
    singleBtn.dataset.mode = 'single';
    singleBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="18" height="14" rx="2"/><rect x="3" y="19" width="18" height="2" rx="1"/></svg>';
    singleBtn.title = 'Single view';
    singleBtn.addEventListener('click', () => this.setViewMode('single'));

    viewGroup.appendChild(gridBtn);
    viewGroup.appendChild(singleBtn);
    this.toolbar.appendChild(regionGroup);
    this.toolbar.appendChild(viewGroup);
    this.element.insertBefore(this.toolbar, this.content);
  }

  private setRegionFilter(filter: RegionFilter): void {
    if (filter === this.regionFilter) return;
    this.regionFilter = filter;
    this.toolbar?.querySelectorAll('.webcam-region-btn').forEach(btn => {
      (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.region === filter);
    });
    const cams = this.filteredCams;
    if (cams.length > 0 && !cams.find(c => c.id === this.activeCam.id)) {
      this.activeCam = cams[0]!;
    }
    this.savePrefs();
    this.render();
  }

  private setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this.savePrefs();
    this.toolbar?.querySelectorAll('.webcam-view-btn').forEach(btn => {
      (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.mode === mode);
    });
    this.render();
  }

  // Returns a cache-busted snapshot URL for live refresh.
  private snapshotSrc(cam: IpCamera): string {
    const sep = cam.snapshotUrl.includes('?') ? '&' : '?';
    return `${cam.snapshotUrl}${sep}_t=${Date.now()}`;
  }

  private createCamEntry(cam: IpCamera, container: HTMLElement): CamEntry {
    const img = document.createElement('img');
    img.className = 'ip-cam-img';
    img.alt = `${cam.city} IP camera`;
    img.decoding = 'async';
    img.loading = 'lazy';

    const entry: CamEntry = { cam, img, refreshTimer: null, retryTimer: null, isOffline: false, container };

    img.addEventListener('load', () => {
      if (entry.isOffline) {
        entry.isOffline = false;
        container.classList.remove('ip-cam-cell--offline');
        container.querySelector('.ip-cam-offline-badge')?.remove();
      }
    });

    img.addEventListener('error', () => this.handleImgError(entry));

    img.src = this.snapshotSrc(cam);
    container.insertBefore(img, container.firstChild);

    entry.refreshTimer = setInterval(() => {
      if (!entry.isOffline && this.isVisible) {
        img.src = this.snapshotSrc(cam);
      }
    }, SNAPSHOT_REFRESH_MS);

    this.camEntries.set(cam.id, entry);
    return entry;
  }

  private handleImgError(entry: CamEntry): void {
    if (entry.isOffline) return;
    entry.isOffline = true;
    entry.container.classList.add('ip-cam-cell--offline');
    this.renderOfflineBadge(entry);
    // Retry after a delay — camera may be temporarily unavailable.
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => {
      if (entry.isOffline) {
        entry.img.src = this.snapshotSrc(entry.cam);
      }
    }, OFFLINE_RETRY_MS);
  }

  private renderOfflineBadge(entry: CamEntry): void {
    entry.container.querySelector('.ip-cam-offline-badge')?.remove();
    const badge = document.createElement('div');
    badge.className = 'ip-cam-offline-badge';
    badge.innerHTML = `<span>${escapeHtml(t('components.ipCameras.offline'))}</span>
      <button class="offline-retry">${escapeHtml(t('common.retry') || 'Retry')}</button>`;
    badge.querySelector('button')?.addEventListener('click', (e) => {
      e.stopPropagation();
      entry.isOffline = false;
      entry.container.classList.remove('ip-cam-cell--offline');
      badge.remove();
      entry.img.src = this.snapshotSrc(entry.cam);
    });
    entry.container.appendChild(badge);
  }

  private render(): void {
    this.destroyEntries();
    this.content.innerHTML = '';
    this.content.className = 'panel-content webcam-content';

    if (!this.isVisible) {
      this.content.innerHTML = `<div class="webcam-placeholder">${escapeHtml(t('components.ipCameras.paused'))}</div>`;
      return;
    }

    if (this.viewMode === 'grid') {
      this.renderGrid();
    } else {
      this.renderSingle();
    }
  }

  private renderGrid(): void {
    const grid = document.createElement('div');
    grid.className = 'webcam-grid ip-cam-grid';

    this.gridCams.forEach(cam => {
      const cell = document.createElement('div');
      cell.className = 'webcam-cell ip-cam-cell';
      cell.dataset.camId = cam.id;

      const label = document.createElement('div');
      label.className = 'webcam-cell-label ip-cam-cell-label';
      label.innerHTML = `<span class="webcam-live-dot"></span><span class="webcam-city">${escapeHtml(cam.city.toUpperCase())}</span>${cam.type ? `<span class="ip-cam-type-badge">${escapeHtml(cam.type)}</span>` : ''}`;

      const expandBtn = document.createElement('button');
      expandBtn.className = 'webcam-expand-btn';
      expandBtn.title = t('webcams.expand') || 'Expand';
      expandBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.activeCam = cam;
        this.setViewMode('single');
      });
      label.appendChild(expandBtn);

      cell.appendChild(label);
      grid.appendChild(cell);

      this.createCamEntry(cam, cell);
    });

    this.content.appendChild(grid);
  }

  private renderSingle(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'webcam-single ip-cam-single';

    const metaBar = document.createElement('div');
    metaBar.className = 'ip-cam-meta-bar';
    metaBar.innerHTML = `
      <span class="webcam-live-dot"></span>
      <span class="ip-cam-meta-city">${escapeHtml(this.activeCam.city)}</span>
      <span class="ip-cam-meta-country">${escapeHtml(this.activeCam.country)}</span>
      ${this.activeCam.type ? `<span class="ip-cam-type-badge">${escapeHtml(this.activeCam.type)}</span>` : ''}
    `;
    wrapper.appendChild(metaBar);

    this.createCamEntry(this.activeCam, wrapper);

    const switcher = document.createElement('div');
    switcher.className = 'webcam-switcher';

    const backBtn = document.createElement('button');
    backBtn.className = 'webcam-feed-btn webcam-back-btn';
    backBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg> Grid';
    backBtn.addEventListener('click', () => this.setViewMode('grid'));
    switcher.appendChild(backBtn);

    this.filteredCams.forEach(cam => {
      const btn = document.createElement('button');
      btn.className = `webcam-feed-btn${cam.id === this.activeCam.id ? ' active' : ''}`;
      btn.textContent = cam.city;
      btn.addEventListener('click', () => {
        this.activeCam = cam;
        this.savePrefs();
        this.render();
      });
      switcher.appendChild(btn);
    });

    this.content.appendChild(wrapper);
    this.content.appendChild(switcher);
  }

  private destroyEntries(): void {
    this.camEntries.forEach(entry => {
      if (entry.refreshTimer) clearInterval(entry.refreshTimer);
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      entry.img.src = '';
      entry.img.remove();
    });
    this.camEntries.clear();
  }

  private setupIntersectionObserver(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        const wasVisible = this.isVisible;
        this.isVisible = entries.some(e => e.isIntersecting);
        if (this.isVisible && !wasVisible) {
          this.render();
        } else if (!this.isVisible && wasVisible) {
          this.destroyEntries();
          this.content.innerHTML = `<div class="webcam-placeholder">${escapeHtml(t('components.ipCameras.paused'))}</div>`;
        }
      },
      { threshold: 0.1 }
    );
    this.observer.observe(this.element);
  }

  public refresh(): void {
    if (this.isVisible) {
      this.camEntries.forEach(entry => {
        if (!entry.isOffline) {
          entry.img.src = this.snapshotSrc(entry.cam);
        }
      });
    }
  }

  public destroy(): void {
    this.observer?.disconnect();
    this.destroyEntries();
    super.destroy();
  }
}
