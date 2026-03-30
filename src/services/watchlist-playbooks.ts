export interface WatchSignals {
  criticalNews?: number;
  protests?: number;
  militaryFlights?: number;
  militaryVessels?: number;
  outages?: number;
  aisDisruptions?: number;
  satelliteFires?: number;
  temporalAnomalies?: number;
  cyberThreats?: number;
  earthquakes?: number;
  displacementOutflow?: number;
  climateStress?: number;
  conflictEvents?: number;
  activeStrikes?: number;
  orefSirens?: number;
  orefHistory24h?: number;
  aviationDisruptions?: number;
  travelAdvisories?: number;
  travelAdvisoryMaxLevel?: string | null;
  gpsJammingHexes?: number;
}

export interface WatchlistCountry {
  code: string;
  name: string;
  addedAt: number;
}

export interface WatchlistStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

export interface WatchlistPlaybookInput {
  code: string;
  name: string;
  score: number;
  trend: 'rising' | 'stable' | 'falling';
  signals: WatchSignals;
}

export interface WatchlistPlaybook {
  severity: 'critical' | 'high' | 'medium' | 'low';
  scenario:
    | 'war-escalation'
    | 'cyber-disruption'
    | 'infrastructure-shock'
    | 'disaster-response'
    | 'civil-unrest'
    | 'steady-watch';
  title: string;
  summary: string;
  nextActions: string[];
  priorityPanels: string[];
  signalScore: number;
}

export interface RankedWatchCountry {
  code: string;
  name: string;
  score: number;
  addedAt?: number;
  playbook: WatchlistPlaybook;
}

interface PlaybookOption {
  scenario: WatchlistPlaybook['scenario'];
  signalScore: number;
  title: string;
  summary: string;
  nextActions: string[];
  priorityPanels: string[];
}

const WATCHLIST_STORAGE_KEY = 'wm-country-watchlist-v1';
const SEVERITY_RANK: Record<WatchlistPlaybook['severity'], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function getTravelSeverityBoost(level: string | null | undefined): number {
  switch (level) {
    case 'do-not-travel': {
      return 10;
    }
    case 'reconsider': {
      return 6;
    }
    case 'caution': {
      return 3;
    }
    default: {
      return 0;
    }
  }
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function safeParseCountries(raw: string | null): WatchlistCountry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as WatchlistCountry[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((country) => typeof country?.code === 'string' && typeof country?.name === 'string')
      .map((country) => ({
        code: normalizeCode(country.code),
        name: country.name,
        addedAt: Number.isFinite(country.addedAt) ? country.addedAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

function sortCountries(countries: WatchlistCountry[]): WatchlistCountry[] {
  // eslint-disable-next-line unicorn/no-array-sort
  return [...countries].sort((a, b) => b.addedAt - a.addedAt || a.code.localeCompare(b.code));
}

function nextAddedAt(countries: WatchlistCountry[]): number {
  const now = Date.now();
  const latestAddedAt = countries.reduce((max, country) => Math.max(max, country.addedAt), 0);
  return now > latestAddedAt ? now : latestAddedAt + 1;
}

function defaultStorage(): WatchlistStorageLike | null {
  try {
    if (
      typeof localStorage !== 'undefined'
      && typeof localStorage.getItem === 'function'
      && typeof localStorage.setItem === 'function'
    ) {
      return localStorage;
    }
  } catch {}
  return null;
}

function emitWatchlistChanged(countries: WatchlistCountry[]): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent('wm:watchlist-changed', { detail: countries }));
}

export function createWatchlistStore(storage: WatchlistStorageLike | null = defaultStorage()) {
  let cache = safeParseCountries(storage?.getItem(WATCHLIST_STORAGE_KEY) ?? null);
  const listeners = new Set<(countries: WatchlistCountry[]) => void>();

  const notify = () => {
    const snapshot = sortCountries(cache);
    listeners.forEach((listener) => listener(snapshot));
    emitWatchlistChanged(snapshot);
  };

  const persist = () => {
    if (!storage) return;
    if (cache.length === 0) {
      storage.removeItem?.(WATCHLIST_STORAGE_KEY);
      return;
    }
    storage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(cache));
  };

  return {
    getCountries(): WatchlistCountry[] {
      return sortCountries(cache);
    },
    isWatched(code: string): boolean {
      const normalizedCode = normalizeCode(code);
      return cache.some((country) => country.code === normalizedCode);
    },
    addCountry(country: Pick<WatchlistCountry, 'code' | 'name'>): WatchlistCountry[] {
      const normalizedCode = normalizeCode(country.code);
      const existing = cache.find((entry) => entry.code === normalizedCode);
      const withoutExisting = cache.filter((entry) => entry.code !== normalizedCode);
      cache = [
        {
          code: normalizedCode,
          name: country.name,
          addedAt: existing?.addedAt ?? nextAddedAt(cache),
        },
        ...withoutExisting,
      ];
      persist();
      notify();
      return sortCountries(cache);
    },
    removeCountry(code: string): WatchlistCountry[] {
      const normalizedCode = normalizeCode(code);
      cache = cache.filter((country) => country.code !== normalizedCode);
      persist();
      notify();
      return sortCountries(cache);
    },
    toggleCountry(country: Pick<WatchlistCountry, 'code' | 'name'>): boolean {
      if (this.isWatched(country.code)) {
        this.removeCountry(country.code);
        return false;
      }
      this.addCountry(country);
      return true;
    },
    subscribe(listener: (countries: WatchlistCountry[]) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const singletonStore = createWatchlistStore();

export function getWatchedCountries(): WatchlistCountry[] {
  return singletonStore.getCountries();
}

export function isCountryWatched(code: string): boolean {
  return singletonStore.isWatched(code);
}

export function addCountryToWatchlist(country: Pick<WatchlistCountry, 'code' | 'name'>): WatchlistCountry[] {
  return singletonStore.addCountry(country);
}

export function removeCountryFromWatchlist(code: string): WatchlistCountry[] {
  return singletonStore.removeCountry(code);
}

export function toggleCountryWatchlist(country: Pick<WatchlistCountry, 'code' | 'name'>): boolean {
  return singletonStore.toggleCountry(country);
}

export function subscribeWatchlist(listener: (countries: WatchlistCountry[]) => void): () => void {
  return singletonStore.subscribe(listener);
}

export function evaluateWatchlistPlaybook(input: WatchlistPlaybookInput): WatchlistPlaybook {
  const signals = input.signals;
  const warScore =
    (signals.activeStrikes ?? 0) * 8 +
    (signals.conflictEvents ?? 0) * 2 +
    (signals.militaryFlights ?? 0) * 1.2 +
    (signals.militaryVessels ?? 0) * 1.5 +
    (signals.criticalNews ?? 0) * 2 +
    (signals.gpsJammingHexes ?? 0) * 1.5 +
    (signals.orefSirens ?? 0) * 2.5 +
    getTravelSeverityBoost(signals.travelAdvisoryMaxLevel);

  const cyberScore =
    (signals.cyberThreats ?? 0) * 3 +
    (signals.outages ?? 0) * 2.5 +
    (signals.temporalAnomalies ?? 0) * 2 +
    (signals.aviationDisruptions ?? 0) * 1.25;

  const infrastructureScore =
    (signals.outages ?? 0) * 2 +
    (signals.aisDisruptions ?? 0) * 2.5 +
    (signals.aviationDisruptions ?? 0) * 2 +
    (signals.travelAdvisories ?? 0) * 1.1;

  const disasterScore =
    (signals.earthquakes ?? 0) * 7 +
    (signals.satelliteFires ?? 0) * 2 +
    (signals.climateStress ?? 0) * 0.9 +
    Math.min(12, (signals.displacementOutflow ?? 0) / 250_000);

  const unrestScore =
    (signals.protests ?? 0) * 2 +
    (signals.criticalNews ?? 0) * 1.5 +
    (signals.travelAdvisories ?? 0) * 1 +
    (input.trend === 'rising' ? 3 : 0);

  const options: PlaybookOption[] = [
    {
      scenario: 'war-escalation',
      signalScore: warScore,
      title: `${input.name} escalation playbook`,
      summary: 'Conflict indicators are converging across military, strike, and headline signals.',
      nextActions: [
        'Monitor maritime chokepoints and cable routes.',
        'Keep strategic posture and active alerts pinned.',
        'Watch travel advisories and siren activity for spillover.',
      ],
      priorityPanels: ['watchlist', 'alert-center', 'strategic-risk', 'strategic-posture', 'cii', 'live-news'],
    },
    {
      scenario: 'cyber-disruption',
      signalScore: cyberScore,
      title: `${input.name} cyber disruption playbook`,
      summary: 'Cyber and connectivity signals point to operational degradation rather than a headline-only spike.',
      nextActions: [
        'Keep communications and security panels open together.',
        'Track whether outages broaden into aviation or payment disruptions.',
        'Watch for follow-on infrastructure incidents.',
      ],
      priorityPanels: ['watchlist', 'alert-center', 'comms-health', 'cyber-threats', 'security-advisories', 'live-news'],
    },
    {
      scenario: 'infrastructure-shock',
      signalScore: infrastructureScore,
      title: `${input.name} infrastructure shock playbook`,
      summary: 'Transport and connectivity disruptions are strong enough to merit direct infrastructure monitoring.',
      nextActions: [
        'Watch ports, aviation, and communications for knock-on effects.',
        'Check supply chain and market exposure if outages persist.',
        'Escalate if advisories or AIS disruptions spread.',
      ],
      priorityPanels: ['watchlist', 'alert-center', 'cascade', 'comms-health', 'supply-chain', 'markets'],
    },
    {
      scenario: 'disaster-response',
      signalScore: disasterScore,
      title: `${input.name} disaster response playbook`,
      summary: 'Natural hazard indicators suggest infrastructure strain and humanitarian exposure.',
      nextActions: [
        'Keep hazard, displacement, and air quality panels in view.',
        'Check whether transport or comms outages are spreading.',
        'Watch for a second-wave humanitarian signal.',
      ],
      priorityPanels: ['watchlist', 'alert-center', 'earthquakes', 'satellite-fires', 'gdacs-alerts', 'displacement'],
    },
    {
      scenario: 'civil-unrest',
      signalScore: unrestScore,
      title: `${input.name} civil unrest playbook`,
      summary: 'Public unrest and headline pressure are elevated enough to watch for state response or spillover.',
      nextActions: [
        'Keep the country instability and live-news panels nearby.',
        'Watch whether protests start colliding with outages or travel advisories.',
        'Escalate if military or cyber signals join the cluster.',
      ],
      priorityPanels: ['watchlist', 'alert-center', 'cii', 'live-news', 'gdelt-intel', 'politics'],
    },
  ];

  // eslint-disable-next-line unicorn/no-array-sort
  const rankedOptions = [...options].sort((a, b) => b.signalScore - a.signalScore);
  const selected = rankedOptions[0] ?? {
    scenario: 'steady-watch' as const,
    signalScore: 0,
    title: `${input.name} steady watch`,
    summary: 'No single crisis pattern dominates yet; maintain baseline awareness.',
    nextActions: [
      'Track the watchlist for trend changes.',
      'Keep strategic risk and live news available.',
      'Promote the country if new conflict, cyber, or disaster signals appear.',
    ],
    priorityPanels: ['watchlist', 'alert-center', 'strategic-risk', 'insights', 'live-news'],
  };

  const severityThreshold = Math.max(selected.signalScore, input.score + (input.trend === 'rising' ? 4 : 0));
  let severity: WatchlistPlaybook['severity'] = 'low';
  if (severityThreshold >= 32) severity = 'critical';
  else if (severityThreshold >= 20) severity = 'high';
  else if (severityThreshold >= 10) severity = 'medium';

  return {
    severity,
    scenario: selected.scenario,
    title: selected.title,
    summary: selected.summary,
    nextActions: selected.nextActions,
    priorityPanels: selected.priorityPanels,
    signalScore: Math.round(selected.signalScore),
  };
}

export function rankWatchedCountries<T extends RankedWatchCountry>(entries: T[]): T[] {
  // eslint-disable-next-line unicorn/no-array-sort
  return [...entries].sort((a, b) => {
    const severityDelta = SEVERITY_RANK[b.playbook.severity] - SEVERITY_RANK[a.playbook.severity];
    if (severityDelta !== 0) return severityDelta;
    const signalDelta = b.playbook.signalScore - a.playbook.signalScore;
    if (signalDelta !== 0) return signalDelta;
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    return (b.addedAt ?? 0) - (a.addedAt ?? 0);
  });
}
