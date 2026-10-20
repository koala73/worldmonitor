import { fetchAircraftEmergencies } from '@/services/aircraft-emergencies';
import { startSmartPollLoop, type SmartPollLoopHandle } from '@/services/runtime';
import {
  EMERGENCY_CODES, EMERGENCY_CONDITIONS, OBSERVATION_MAX_AGE_MS, POSITION_MAX_AGE_MS,
  emergencyMarkerPosition, isFresh, reconcileEmergencies,
  type EmergencyCode, type EmergencyMapMarker, type EmergencyRecord, type EmergencySnapshot,
} from '../../shared/aircraft-emergencies';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, value: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}
// Ages tick every few seconds. They live in their own spans, filled after each
// render, so the rest of the panel is rebuilt only when its content changes.
function clock(time: number): HTMLSpanElement {
  const element = node('span', time > 0 ? new Date(time).toISOString() : 'Unknown');
  if (time > 0) {
    const age = node('span', '');
    age.dataset.ageAt = String(time);
    element.append(' ', age);
  }
  return element;
}

function withFreshness(time: HTMLElement, fresh: boolean): HTMLElement {
  time.append(` · ${fresh ? 'fresh' : 'stale or unknown'}`);
  return time;
}

export class AircraftEmergencyLayer {
  private element = document.createElement('section');
  private loop?: SmartPollLoopHandle;
  private ticker?: ReturnType<typeof setInterval>;
  private enabled = false;
  private snapshot: EmergencySnapshot = { observations: [], feeds: [] };
  private records: EmergencyRecord[] = [];
  private unknownReceipts = new Map<string, number>();
  private selected = '';
  private lastMarkers = '';
  private lastView = '';

  constructor(private container: HTMLElement, private paint: (markers: EmergencyMapMarker[]) => void) {
    this.element.className = 'aircraft-emergency-layer';
    this.element.setAttribute('aria-label', 'Aircraft emergencies');
    this.container.addEventListener('aircraft-emergency-select', this.select);
  }

  private select = (event: Event): void => {
    this.selected = (event as CustomEvent<string>).detail;
    this.render();
  };

  setEnabled(enabled: boolean): void {
    const detached = !this.element.isConnected;
    if (enabled && detached) { this.container.appendChild(this.element); this.lastMarkers = ''; this.lastView = ''; }
    this.element.hidden = !enabled;
    if (enabled === this.enabled) { if (enabled && detached) this.render(); return; }
    this.enabled = enabled;
    if (!enabled) {
      this.loop?.stop();
      this.loop = undefined;
      clearInterval(this.ticker);
      this.paint([]);
      this.lastMarkers = '';
      this.lastView = '';
      return;
    }
    this.render();
    this.loop = startSmartPollLoop(async ({ signal }) => {
      const result = await fetchAircraftEmergencies(signal);
      if (!this.enabled || signal?.aborted) return;
      this.snapshot = result;
      this.render();
    }, { intervalMs: 60_000, pauseWhenHidden: true, refreshOnVisible: true, runImmediately: true });
    this.ticker = setInterval(() => { if (!document.hidden) this.render(); }, 5_000);
  }

  private render(): void {
    if (!this.enabled) return;
    const now = Date.now();
    this.records = reconcileEmergencies(this.records, this.snapshot, now, this.unknownReceipts);
    const markers = this.records.flatMap(record => {
      const position = emergencyMarkerPosition(record, now);
      return position ? [{ address: record.address, squawk: record.observations[0]!.squawk, lat: position.lat, lon: position.lon }] : [];
    });
    const serialized = JSON.stringify(markers);
    if (serialized !== this.lastMarkers) { this.paint(markers); this.lastMarkers = serialized; }
    const sourceOpen = this.element.querySelector('details')?.open ?? false;
    const view = document.createElement('section');
    view.append(node('h3', 'Aircraft emergencies'));
    const freshFeeds = this.snapshot.feeds.filter(feed => feed.status === 'available' && isFresh(feed.fetchedAt, now, OBSERVATION_MAX_AGE_MS));
    const available = EMERGENCY_CODES.every(code => freshFeeds.some(feed => feed.squawk === code));
    const status = this.snapshot.feeds.length === 0 ? 'Loading aircraft feeds…'
      : available ? (this.records.length ? `${this.records.length} reported aircraft`
        : this.snapshot.observations.length ? 'No current aircraft reports. Stale or unknown observations have expired.' : 'No matching squawks reported by this feed')
        : freshFeeds.length ? 'Partial data. Some squawk queries are unavailable or stale.' : 'Aircraft data unavailable or stale.';
    view.append(node('p', status), node('p', 'Reported transponder signals. Reception coverage is incomplete. No incident or resolution is confirmed.'));
    const feeds = node('details', '');
    feeds.open = sourceOpen;
    feeds.append(node('summary', 'Source and retrieval times'));
    for (const feed of this.snapshot.feeds) {
      const row = node('p', `${feed.source} (ODbL) · ${feed.squawk} · ${feed.status} · retrieved `);
      row.append(clock(feed.fetchedAt));
      feeds.append(row);
    }
    view.append(feeds);
    for (const record of this.records) {
      const observation = record.observations[0]!;
      const button = node('button', `${observation.squawk} · ${observation.callsign || observation.registration || record.address} · ${record.state}`);
      button.type = 'button';
      button.dataset.aircraftEmergency = record.address;
      button.setAttribute('aria-expanded', String(this.selected === record.address));
      button.onclick = () => { this.selected = this.selected === record.address ? '' : record.address; this.render(); };
      view.append(button);
      if (record.address !== this.selected) continue;
      const details = node('div', '');
      details.className = 'aircraft-emergency-details';
      details.append(node('p', record.state === 'current' ? 'Current reported signal' : record.state === 'conflict' ? 'Conflicting code reports. Current condition unknown.' : 'Stale or missing report. Current condition unknown.'));
      for (const report of record.observations) {
        details.append(node('h4', `${report.squawk} · ${EMERGENCY_CONDITIONS[report.squawk as EmergencyCode]}`));
        const rows: [string, string | Node][] = [
          ['Address', report.address], ['Callsign', report.callsign || 'Unknown'], ['Registration', report.registration || 'Unknown'],
          ['Aircraft type', report.aircraftType || 'Unknown'], ['Description', report.description || 'Unknown'],
          ['Military database flag', report.militaryFlag === 'set' ? 'Set' : report.militaryFlag === 'not_set' ? 'Not set' : 'Unknown'],
          ['Altitude', report.altitudeFt === undefined ? 'Unknown' : `${report.altitudeFt} ft`],
          ['Ground speed', report.groundSpeedKts === undefined ? 'Unknown' : `${report.groundSpeedKts} kt`],
          ['Source', `${report.source} (ODbL)`],
          ['Last message', withFreshness(clock(report.observedAt), isFresh(report.observedAt, now, OBSERVATION_MAX_AGE_MS))],
          ['Position', report.position ? `${report.position.lat}, ${report.position.lon}` : 'Unknown'],
          ['Position time', withFreshness(clock(report.position?.observedAt ?? 0), isFresh(report.position?.observedAt ?? 0, now, POSITION_MAX_AGE_MS))],
        ];
        const list = node('dl', '');
        for (const [label, value] of rows) {
          const cell = node('dd', '');
          cell.append(value);
          list.append(node('dt', label), cell);
        }
        details.append(list);
      }
      view.append(details);
    }
    const signature = view.innerHTML;
    if (signature !== this.lastView) {
      const focusedAddress = (document.activeElement as HTMLElement | null)?.dataset.aircraftEmergency;
      this.element.replaceChildren(...view.childNodes);
      this.lastView = signature;
      if (focusedAddress) [...this.element.querySelectorAll<HTMLButtonElement>('button[data-aircraft-emergency]')]
        .find(button => button.dataset.aircraftEmergency === focusedAddress)?.focus({ preventScroll: true });
    }
    for (const age of this.element.querySelectorAll<HTMLElement>('[data-age-at]')) {
      age.textContent = `(${Math.max(0, Math.floor((now - Number(age.dataset.ageAt)) / 1000))}s ago)`;
    }
  }

  destroy(): void {
    this.setEnabled(false);
    this.container.removeEventListener('aircraft-emergency-select', this.select);
    this.element.remove();
  }
}
