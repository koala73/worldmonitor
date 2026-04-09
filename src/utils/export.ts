import type { NewsItem, ClusteredEvent, MarketData, CyberThreat, Monitor } from '@/types';
import type { PredictionMarket } from '@/services/prediction';
import type { IntelligenceCache } from '@/app/app-context';
import type { GpsJamData } from '@/services/gps-interference';
import type { ConvergenceCard } from '@/services/correlation-engine';
import { t } from '@/services/i18n';

type ExportFormat = 'json' | 'csv';

export interface ExportMeta {
  exportedAt: string;
  note: string;
}

export interface ExportData {
  meta?: ExportMeta;
  timestamp: number;
  news?: NewsItem[];
  newsClusters?: ClusteredEvent[];
  newsByCategory?: Record<string, NewsItem[]>;
  markets?: MarketData[];
  predictions?: PredictionMarket[];
  intelligence?: IntelligenceCache;
  cyberThreats?: CyberThreat[];
  gpsJamming?: GpsJamData;
  convergenceCards?: Omit<ConvergenceCard, 'assessment'>[];
  monitors?: Monitor[];
}

// Strip LLM-derived threat annotations so AI does not feed back into itself.
// Keyword and ML (local model) classifications are retained.
function sanitizeNewsItem(item: NewsItem): NewsItem {
  if (item.threat?.source !== 'llm') return item;
  const { threat: _t, ...rest } = item;
  return rest as NewsItem;
}

function sanitizeCluster(cluster: ClusteredEvent): ClusteredEvent {
  return {
    ...cluster,
    threat: cluster.threat?.source === 'llm' ? undefined : cluster.threat,
    allItems: cluster.allItems.map(sanitizeNewsItem),
  };
}

function sanitizeData(data: ExportData): ExportData {
  return {
    ...data,
    news: data.news?.map(sanitizeNewsItem),
    newsClusters: data.newsClusters?.map(sanitizeCluster),
    newsByCategory: data.newsByCategory
      ? Object.fromEntries(
          Object.entries(data.newsByCategory).map(([k, items]) => [k, items.map(sanitizeNewsItem)]),
        )
      : undefined,
  };
}

export function exportToJSON(data: ExportData, filename = 'worldmonitor-export'): void {
  const jsonStr = JSON.stringify(sanitizeData(data), null, 2);
  downloadFile(jsonStr, `${filename}.json`, 'application/json');
}

export function exportToCSV(data: ExportData, filename = 'worldmonitor-export'): void {
  const clean = sanitizeData(data);
  const lines: string[] = [];

  lines.push(`# WorldMonitor Export — ${new Date(clean.timestamp).toISOString()}`);
  lines.push('# Note: CSV is a structured summary. Use JSON export for full fidelity.');
  if (clean.meta?.note) lines.push(`# ${clean.meta.note}`);
  lines.push('');

  // News — prefer raw items over clusters; clusters lose individual sources
  const newsItems = clean.news ?? [];
  if (newsItems.length > 0) {
    lines.push('=== NEWS ===');
    lines.push('Title,Source,Link,Published,IsAlert,ThreatLevel,ThreatCategory');
    newsItems.forEach(item => {
      lines.push(csvRow([
        item.title,
        item.source,
        item.link,
        item.pubDate?.toISOString() || '',
        String(item.isAlert),
        item.threat?.level ?? '',
        item.threat?.category ?? '',
      ]));
    });
    lines.push('');
  }

  if (clean.markets && clean.markets.length > 0) {
    lines.push('=== MARKETS ===');
    lines.push('Symbol,Name,Price,Change');
    clean.markets.forEach(m => {
      lines.push(csvRow([m.symbol, m.name, String(m.price ?? ''), String(m.change ?? '')]));
    });
    lines.push('');
  }

  if (clean.predictions && clean.predictions.length > 0) {
    lines.push('=== PREDICTIONS ===');
    lines.push('Title,Yes Price,Volume');
    clean.predictions.forEach(p => {
      lines.push(csvRow([p.title, String(p.yesPrice), String(p.volume ?? '')]));
    });
    lines.push('');
  }

  const intel = clean.intelligence;
  if (intel) {
    if (intel.protests?.events && intel.protests.events.length > 0) {
      lines.push('=== PROTESTS ===');
      lines.push('Title,Country,EventType,Severity,Time');
      intel.protests.events.forEach(e => {
        lines.push(csvRow([e.title, e.country, e.eventType, e.severity, e.time.toISOString()]));
      });
      lines.push('');
    }

    if (intel.earthquakes && intel.earthquakes.length > 0) {
      lines.push('=== EARTHQUAKES ===');
      lines.push('Place,Magnitude,DepthKm,OccurredAt,URL');
      intel.earthquakes.forEach(e => {
        lines.push(csvRow([e.place, String(e.magnitude), String(e.depthKm), new Date(e.occurredAt * 1000).toISOString(), e.sourceUrl]));
      });
      lines.push('');
    }

    if (intel.outages && intel.outages.length > 0) {
      lines.push('=== INTERNET OUTAGES ===');
      lines.push('Title,Country,Severity,PubDate,Link');
      intel.outages.forEach(o => {
        lines.push(csvRow([o.title, o.country, o.severity, o.pubDate.toISOString(), o.link]));
      });
      lines.push('');
    }

    if (intel.flightDelays && intel.flightDelays.length > 0) {
      lines.push('=== FLIGHT DELAYS ===');
      lines.push('Airport,IATA,City,Country,DelayType,Severity,AvgDelayMin,Source');
      intel.flightDelays.forEach(d => {
        lines.push(csvRow([d.name, d.iata, d.city, d.country, d.delayType, d.severity, String(d.avgDelayMinutes), d.source]));
      });
      lines.push('');
    }

    if (intel.military?.flights && intel.military.flights.length > 0) {
      lines.push('=== MILITARY FLIGHTS ===');
      lines.push('Callsign,HexCode,AircraftType,Operator,Country,Lat,Lon');
      intel.military.flights.forEach(f => {
        lines.push(csvRow([f.callsign, f.hexCode, f.aircraftType, f.operator, f.operatorCountry, String(f.lat), String(f.lon)]));
      });
      lines.push('');
    }

    if (intel.military?.vessels && intel.military.vessels.length > 0) {
      lines.push('=== MILITARY VESSELS ===');
      lines.push('Name,MMSI,Country,VesselType,Lat,Lon');
      intel.military.vessels.forEach(v => {
        lines.push(csvRow([v.name, v.mmsi, v.operatorCountry, v.vesselType, String(v.lat), String(v.lon)]));
      });
      lines.push('');
    }

    if (intel.iranEvents && intel.iranEvents.length > 0) {
      lines.push('=== IRAN EVENTS ===');
      lines.push('Title,Category,Location,Severity,Timestamp');
      intel.iranEvents.forEach(e => {
        lines.push(csvRow([e.title, e.category, e.locationName, e.severity, e.timestamp]));
      });
      lines.push('');
    }

    if (intel.orefAlerts) {
      lines.push('=== OREF ALERTS ===');
      lines.push('ActiveAlerts,History24h');
      lines.push(csvRow([String(intel.orefAlerts.alertCount), String(intel.orefAlerts.historyCount24h)]));
      lines.push('');
    }

    if (intel.advisories && intel.advisories.length > 0) {
      lines.push('=== SECURITY ADVISORIES ===');
      lines.push('Title,Source,Level,Country,PubDate,Link');
      intel.advisories.forEach(a => {
        lines.push(csvRow([a.title, a.source, a.level ?? '', a.country ?? '', a.pubDate.toISOString(), a.link]));
      });
      lines.push('');
    }

    if (intel.radiation?.observations && intel.radiation.observations.length > 0) {
      lines.push('=== RADIATION MONITORING ===');
      lines.push('Location,Country,Value,Unit,ObservedAt');
      intel.radiation.observations.forEach(s => {
        lines.push(csvRow([s.location, s.country, String(s.value), s.unit, s.observedAt.toISOString()]));
      });
      lines.push('');
    }

    if (intel.imageryScenes && intel.imageryScenes.length > 0) {
      lines.push('=== SATELLITE IMAGERY ===');
      lines.push('ID,Satellite,DateTime,ResolutionM,Mode');
      intel.imageryScenes.forEach(s => {
        lines.push(csvRow([s.id, s.satellite, s.datetime, String(s.resolutionM), s.mode]));
      });
      lines.push('');
    }

    if (intel.sanctions) {
      lines.push('=== SANCTIONS ===');
      lines.push('# See JSON export for full sanctions data');
      lines.push(`TotalCount,${intel.sanctions.totalCount}`);
      lines.push(`SDNCount,${intel.sanctions.sdnCount}`);
      lines.push(`NewEntries,${intel.sanctions.newEntryCount}`);
      lines.push('');
    }

    if (intel.thermalEscalation) {
      lines.push('=== THERMAL ESCALATION ===');
      lines.push('# See JSON export for full thermal data');
      lines.push(`ClusterCount,${intel.thermalEscalation.summary.clusterCount}`);
      lines.push(`ElevatedCount,${intel.thermalEscalation.summary.elevatedCount}`);
      lines.push('');
    }

    if (intel.usniFleet) {
      lines.push('=== USNI FLEET ===');
      lines.push('# See JSON export for full fleet data');
      lines.push(`Vessels,${intel.usniFleet.vessels?.length ?? 0}`);
      lines.push('');
    }

    if (intel.aircraftPositions && intel.aircraftPositions.length > 0) {
      lines.push('=== AIRCRAFT POSITIONS ===');
      lines.push(`# ${intel.aircraftPositions.length} positions — see JSON for full data`);
      lines.push('');
    }
  }

  if (clean.cyberThreats && clean.cyberThreats.length > 0) {
    lines.push('=== CYBER THREATS ===');
    lines.push('Indicator,Type,Severity,Country,Source,FirstSeen');
    clean.cyberThreats.forEach(c => {
      lines.push(csvRow([c.indicator, c.indicatorType, String(c.severity), c.country ?? '', c.source, c.firstSeen ?? '']));
    });
    lines.push('');
  }

  if (clean.gpsJamming) {
    lines.push('=== GPS JAMMING ===');
    lines.push('FetchedAt,TotalHexes,HighCount,MediumCount');
    const s = clean.gpsJamming.stats;
    lines.push(csvRow([clean.gpsJamming.fetchedAt, String(s.totalHexes), String(s.highCount), String(s.mediumCount)]));
    lines.push('# Per-hex data available in JSON export');
    lines.push('');
  }

  if (clean.convergenceCards && clean.convergenceCards.length > 0) {
    lines.push('=== SIGNAL CONVERGENCE ===');
    lines.push('Domain,Title,Score,Trend,Countries');
    clean.convergenceCards.forEach(c => {
      lines.push(csvRow([c.domain, c.title, String(c.score), c.trend, c.countries.join(';')]));
    });
    lines.push('');
  }

  if (clean.monitors && clean.monitors.length > 0) {
    lines.push('=== MONITORS ===');
    lines.push('Name,Keywords,Color');
    clean.monitors.forEach(m => {
      lines.push(csvRow([m.name ?? '', m.keywords.join(';'), m.color]));
    });
    lines.push('');
  }

  downloadFile(lines.join('\n'), `${filename}.csv`, 'text/csv');
}

export interface CountryBriefExport {
  country: string;
  code: string;
  score?: number;
  level?: string;
  trend?: string;
  components?: { unrest: number; conflict: number; security: number; information: number };
  signals?: Record<string, number | string | null>;
  brief?: string;
  headlines?: Array<{ title: string; source: string; link: string; pubDate?: string }>;
  generatedAt: string;
}

export function exportCountryBriefJSON(data: CountryBriefExport): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadFile(JSON.stringify(data, null, 2), `country-brief-${data.code}-${timestamp}.json`, 'application/json');
}

export function exportCountryBriefCSV(data: CountryBriefExport): void {
  const lines: string[] = [];
  lines.push(`Country Brief: ${data.country} (${data.code})`);
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push('');
  if (data.score != null) {
    lines.push(`Score,${data.score}`);
    lines.push(`Level,${data.level || ''}`);
    lines.push(`Trend,${data.trend || ''}`);
  }
  if (data.components) {
    lines.push('');
    lines.push('Component,Value');
    lines.push(`Unrest,${data.components.unrest}`);
    lines.push(`Conflict,${data.components.conflict}`);
    lines.push(`Security,${data.components.security}`);
    lines.push(`Information,${data.components.information}`);
  }
  if (data.signals) {
    lines.push('');
    lines.push('Signal,Count');
    for (const [k, v] of Object.entries(data.signals)) {
      lines.push(csvRow([k, String(v)]));
    }
  }
  if (data.headlines && data.headlines.length > 0) {
    lines.push('');
    lines.push('Title,Source,Link,Published');
    data.headlines.forEach(h => lines.push(csvRow([h.title, h.source, h.link, h.pubDate || ''])));
  }
  if (data.brief) {
    lines.push('');
    lines.push('Intelligence Brief');
    lines.push(`"${data.brief.replace(/"/g, '""')}"`);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadFile(lines.join('\n'), `country-brief-${data.code}-${timestamp}.csv`, 'text/csv');
}

function csvRow(values: string[]): string {
  return values.map(v => `"${(v || '').replace(/"/g, '""')}"`).join(',');
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export class ExportPanel {
  private element: HTMLElement;
  private isOpen = false;
  private getData: () => ExportData;

  constructor(getDataFn: () => ExportData) {
    this.getData = getDataFn;
    this.element = document.createElement('div');
    this.element.className = 'export-panel-container';
    this.element.innerHTML = `
      <button class="export-btn" title="${t('common.exportData')}">⬇</button>
      <div class="export-menu hidden">
        <button class="export-option" data-format="csv">${t('common.exportCsv')}</button>
        <button class="export-option" data-format="json">${t('common.exportJson')}</button>
      </div>
    `;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    const btn = this.element.querySelector('.export-btn')!;
    const menu = this.element.querySelector('.export-menu')!;

    btn.addEventListener('click', () => {
      this.isOpen = !this.isOpen;
      menu.classList.toggle('hidden', !this.isOpen);
    });

    document.addEventListener('click', (e) => {
      if (!this.element.contains(e.target as Node)) {
        this.isOpen = false;
        menu.classList.add('hidden');
      }
    });

    this.element.querySelectorAll('.export-option').forEach(option => {
      option.addEventListener('click', () => {
        const format = (option as HTMLElement).dataset.format as ExportFormat;
        this.export(format);
        this.isOpen = false;
        menu.classList.add('hidden');
      });
    });
  }

  private export(format: ExportFormat): void {
    const data = this.getData();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `worldmonitor-${timestamp}`;

    if (format === 'json') {
      exportToJSON(data, filename);
    } else {
      exportToCSV(data, filename);
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
