import { toApiUrl } from '@/services/runtime';
import { fetchWeatherAlerts, type WeatherAlert } from '@/services/weather';
import { CITY_COORDS, type CityCoord } from '../../api/data/city-coords.ts';

export interface SportsLeague {
  id: string;
  sport: string;
  name: string;
  shortName: string;
  country?: string;
  tableSupported?: boolean;
}

export interface SportsLeagueOption {
  id: string;
  sport: string;
  name: string;
  shortName: string;
  country?: string;
  alternateName?: string;
}

export interface SportsLeagueDetails extends SportsLeagueOption {
  country?: string;
  currentSeason?: string;
  formedYear?: string;
  badge?: string;
  description?: string;
  tableSupported?: boolean;
}

export interface SportsEvent {
  idEvent: string;
  idLeague?: string;
  strLeague?: string;
  strSeason?: string;
  strSport?: string;
  strEvent?: string;
  strHomeTeam?: string;
  strAwayTeam?: string;
  strHomeBadge?: string;
  strAwayBadge?: string;
  strStatus?: string;
  strProgress?: string;
  strVenue?: string;
  strCity?: string;
  strCountry?: string;
  strRound?: string;
  strTimestamp?: string;
  dateEvent?: string;
  strTime?: string;
  intHomeScore?: string;
  intAwayScore?: string;
  lat?: number;
  lng?: number;
}

export interface SportsFixtureGroup {
  league: SportsLeague;
  events: SportsEvent[];
}

export interface SportsStandingRow {
  rank: number;
  team: string;
  badge?: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalDifference: number;
  points: number;
  form?: string;
  note?: string;
  season?: string;
}

export interface SportsTableGroup {
  league: SportsLeague;
  season?: string;
  updatedAt?: string;
  rows: SportsStandingRow[];
}

export interface SportsEventStat {
  label: string;
  homeValue?: string;
  awayValue?: string;
}

export interface SportsStatSnapshot {
  league: SportsLeague;
  event: SportsEvent;
  stats: SportsEventStat[];
}

export interface SportsFixtureSearchMatch {
  league: SportsLeague;
  event: SportsEvent;
}

export interface SportsFixtureMapMarker {
  id: string;
  eventId: string;
  leagueId?: string;
  leagueName: string;
  leagueShortName: string;
  sport: string;
  title: string;
  homeTeam?: string;
  awayTeam?: string;
  homeBadge?: string;
  awayBadge?: string;
  venue: string;
  venueCity?: string;
  venueCountry?: string;
  venueCapacity?: string;
  venueSurface?: string;
  round?: string;
  season?: string;
  startTime?: string;
  startLabel: string;
  lat: number;
  lng: number;
  fixtureCount?: number;
  competitionCount?: number;
  sports?: string[];
  fixtures?: SportsFixtureMapMarker[];
}

export interface SportsFixtureInsightStat {
  label: string;
  value: string;
}

export interface SportsFixturePopupContext {
  prediction: string;
  weather: string;
  story: string;
  stats: SportsFixtureInsightStat[];
}

export interface SportsFixtureVisualMeta {
  icon: string;
  colorHex: string;
  colorRgba: [number, number, number, number];
}

export interface SportsLeagueCenterData {
  league: SportsLeagueDetails;
  seasons: string[];
  selectedSeason?: string;
  table: SportsTableGroup | null;
  tableAvailable: boolean;
  recentEvents: SportsEvent[];
  upcomingEvents: SportsEvent[];
  statSnapshot: SportsStatSnapshot | null;
}

export interface NbaStandingRow {
  rank: number;
  seed: number;
  team: string;
  abbreviation: string;
  badge?: string;
  wins: number;
  losses: number;
  winPercent: string;
  gamesBehind: string;
  homeRecord: string;
  awayRecord: string;
  pointsFor: string;
  pointsAgainst: string;
  differential: string;
  streak: string;
  lastTen: string;
  clincher?: string;
  conference: string;
}

export interface NbaStandingsGroup {
  name: string;
  rows: NbaStandingRow[];
}

export interface NbaStandingsData {
  leagueName: string;
  seasonDisplay: string;
  updatedAt: string;
  groups: NbaStandingsGroup[];
}

export interface MotorsportStandingRow {
  rank: number;
  name: string;
  code?: string;
  team?: string;
  badge?: string;
  teamBadge?: string;
  teamColor?: string;
  driverNumber?: string;
  points: number;
  wins: number;
  nationality?: string;
}

export interface MotorsportRaceSummary {
  raceName: string;
  round: string;
  date: string;
  time?: string;
  circuitName?: string;
  locality?: string;
  country?: string;
  lat?: number;
  lng?: number;
  winner?: string;
  podium: string[];
  fastestLap?: string;
}

export interface FormulaOneStandingsData {
  leagueName: string;
  season: string;
  round: string;
  updatedAt: string;
  driverStandings: MotorsportStandingRow[];
  constructorStandings: MotorsportStandingRow[];
  lastRace: MotorsportRaceSummary | null;
  nextRace: MotorsportRaceSummary | null;
}

export interface SportsPlayerSearchResult {
  id: string;
  name: string;
  alternateName?: string;
  sport?: string;
  team?: string;
  secondaryTeam?: string;
  nationality?: string;
  position?: string;
  status?: string;
  number?: string;
  thumb?: string;
  cutout?: string;
}

export interface SportsPlayerDetails extends SportsPlayerSearchResult {
  banner?: string;
  fanart?: string;
  birthDate?: string;
  birthLocation?: string;
  description?: string;
  height?: string;
  weight?: string;
  gender?: string;
  handedness?: string;
  signedDate?: string;
  signing?: string;
  agent?: string;
  outfitter?: string;
  kit?: string;
  website?: string;
  facebook?: string;
  twitter?: string;
  instagram?: string;
  youtube?: string;
}

const REQUEST_TIMEOUT_MS = 12_000;

function formatLocalCalendarDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function buildLocalSportsDateWindow(date: Date): string[] {
  return [-1, 0, 1].map((offset) => formatLocalCalendarDate(addLocalDays(date, offset)));
}

function buildSportsEventShapeKey(event: SportsEvent): string {
  const normalizedLeague = normalizeLeagueLookup(event.strLeague);
  const normalizedTitle = normalizeLeagueLookup(event.strEvent || [event.strHomeTeam, event.strAwayTeam].filter(Boolean).join(' vs '));
  const normalizedVenue = normalizeLeagueLookup(event.strVenue);
  const timestamp = parseEventTimestamp(event);
  return [
    normalizedLeague,
    normalizedTitle,
    normalizedVenue,
    Number.isFinite(timestamp) && timestamp !== Number.MAX_SAFE_INTEGER ? String(timestamp) : (event.dateEvent || ''),
  ].join('|');
}

function dedupeSportsEvents(events: SportsEvent[]): SportsEvent[] {
  const deduped: SportsEvent[] = [];
  const seenIds = new Set<string>();
  const seenShapes = new Set<string>();

  for (const event of sortEventsAscending(events)) {
    const eventId = toOptionalString(event.idEvent);
    const shapeKey = buildSportsEventShapeKey(event);
    if (eventId && seenIds.has(eventId)) continue;
    if (shapeKey && seenShapes.has(shapeKey)) continue;
    if (eventId) seenIds.add(eventId);
    if (shapeKey) seenShapes.add(shapeKey);
    deduped.push(event);
  }

  return deduped;
}

function isEventOnLocalCalendarDate(event: SportsEvent, targetDateStr: string): boolean {
  const timestamp = parseEventTimestamp(event);
  if (timestamp !== Number.MAX_SAFE_INTEGER) {
    return formatLocalCalendarDate(new Date(timestamp)) === targetDateStr;
  }
  return (event.dateEvent || '') === targetDateStr;
}

function filterEventsToLocalCalendarDate(events: SportsEvent[], targetDateStr: string): SportsEvent[] {
  return dedupeSportsEvents(events.filter((event) => isEventOnLocalCalendarDate(event, targetDateStr)));
}

function buildSportsFixtureGroupKey(leagueName: string | undefined, sport: string | undefined, fallbackId?: string): string {
  const normalizedLeague = normalizeLeagueLookup(leagueName);
  const normalizedSport = normalizeLeagueLookup(sport);
  if (normalizedLeague && normalizedSport) return `${normalizedSport}:${normalizedLeague}`;
  if (fallbackId) return `id:${fallbackId}`;
  return `${normalizedSport || 'sport'}:${normalizedLeague || 'league'}`;
}

const FEATURED_TABLE_LEAGUES: SportsLeague[] = [
  { id: '4328', sport: 'Soccer', name: 'English Premier League', shortName: 'EPL', country: 'England', tableSupported: true },
  { id: '4335', sport: 'Soccer', name: 'Spanish La Liga', shortName: 'La Liga', country: 'Spain', tableSupported: true },
  { id: '4331', sport: 'Soccer', name: 'German Bundesliga', shortName: 'Bundesliga', country: 'Germany', tableSupported: true },
];



const EUROPEAN_TOP_FOOTBALL_SPECS: FeaturedLeagueSpec[] = [
  { label: 'English Premier League', sport: 'Soccer', aliases: ['english premier league', 'premier league', 'epl'] },
  { label: 'Spanish La Liga', sport: 'Soccer', aliases: ['spanish la liga', 'la liga', 'laliga'] },
  { label: 'German Bundesliga', sport: 'Soccer', aliases: ['german bundesliga', 'bundesliga'] },
  { label: 'Italian Serie A', sport: 'Soccer', aliases: ['italian serie a', 'serie a'] },
  { label: 'French Ligue 1', sport: 'Soccer', aliases: ['french ligue 1', 'ligue 1'] },
  { label: 'Dutch Eredivisie', sport: 'Soccer', aliases: ['dutch eredivisie', 'eredivisie'] },
  { label: 'Portuguese Primeira Liga', sport: 'Soccer', aliases: ['portuguese primeira liga', 'primeira liga', 'liga portugal'] },
];

type FeaturedLeagueSpec = {
  label: string;
  sport?: string;
  aliases: string[];
};

const MOTORSPORT_SPECS: FeaturedLeagueSpec[] = [
  { label: 'Formula 1', sport: 'Motorsport', aliases: ['formula 1', 'f1'] },
  { label: 'NASCAR Cup Series', sport: 'Motorsport', aliases: ['nascar cup series', 'nascar'] },
  { label: 'World Rally Championship', sport: 'Motorsport', aliases: ['world rally championship', 'wrc', 'rally'] },
];

export const NBA_LEAGUE_ID = '4387';

const SPORTS_FIXTURE_SPORT_PRIORITY = new Map<string, number>([
  ['Soccer', 0],
  ['Basketball', 1],
  ['Ice Hockey', 2],
  ['Baseball', 3],
  ['American Football', 4],
  ['Motorsport', 5],
  ['Tennis', 6],
  ['Cricket', 7],
  ['Mixed', 8],
]);

const SPORTS_TEAM_LABEL_STOPWORDS = new Set([
  'ac',
  'afc',
  'bc',
  'basketball',
  'cf',
  'club',
  'fc',
  'football',
  'sc',
  'sporting',
  'team',
]);

const LIVE_EVENT_STATUS_MARKERS = [
  'live',
  'in progress',
  'halftime',
  'quarter',
  'period',
  'overtime',
  'extra time',
  'started',
];

const ESPN_FIXTURE_COMPETITIONS: EspnCompetitionSpec[] = [
  { id: 'eng.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'eng.1', name: 'English Premier League', shortName: 'EPL', country: 'England' },
  { id: 'esp.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'esp.1', name: 'Spanish La Liga', shortName: 'La Liga', country: 'Spain' },
  { id: 'ger.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'ger.1', name: 'German Bundesliga', shortName: 'Bundesliga', country: 'Germany' },
  { id: 'ita.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'ita.1', name: 'Italian Serie A', shortName: 'Serie A', country: 'Italy' },
  { id: 'fra.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'fra.1', name: 'French Ligue 1', shortName: 'Ligue 1', country: 'France' },
  { id: 'ned.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'ned.1', name: 'Dutch Eredivisie', shortName: 'Eredivisie', country: 'Netherlands' },
  { id: 'por.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'por.1', name: 'Portuguese Primeira Liga', shortName: 'Primeira Liga', country: 'Portugal' },
  { id: 'usa.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'usa.1', name: 'Major League Soccer', shortName: 'MLS', country: 'United States' },
  { id: 'mex.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'mex.1', name: 'Liga MX', shortName: 'Liga MX', country: 'Mexico' },
  { id: 'eng.2', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'eng.2', name: 'English Championship', shortName: 'Championship', country: 'England' },
  { id: 'eng.3', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'eng.3', name: 'English League One', shortName: 'League One', country: 'England' },
  { id: 'sco.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'sco.1', name: 'Scottish Premiership', shortName: 'Premiership', country: 'Scotland' },
  { id: 'arg.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'arg.1', name: 'Argentine Primera División', shortName: 'Primera', country: 'Argentina' },
  { id: 'uefa.champions', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'uefa.champions', name: 'UEFA Champions League', shortName: 'UCL', country: 'Europe' },
  { id: 'fifa.world', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'fifa.world', name: 'FIFA World Cup', shortName: 'World Cup', country: 'International' },
  { id: 'uefa.euro', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'uefa.euro', name: 'UEFA European Championship', shortName: 'Euro', country: 'Europe' },
  { id: 'nba', sport: 'Basketball', sportPath: 'basketball', leaguePath: 'nba', name: 'NBA', shortName: 'NBA', country: 'United States' },
  { id: 'nhl', sport: 'Ice Hockey', sportPath: 'hockey', leaguePath: 'nhl', name: 'NHL', shortName: 'NHL', country: 'United States' },
  { id: 'mlb', sport: 'Baseball', sportPath: 'baseball', leaguePath: 'mlb', name: 'MLB', shortName: 'MLB', country: 'United States' },
  { id: 'nfl', sport: 'American Football', sportPath: 'football', leaguePath: 'nfl', name: 'NFL', shortName: 'NFL', country: 'United States' },
];

type EspnCompetitionSpec = {
  id: string;
  sport: SportsLeague['sport'];
  sportPath: 'soccer' | 'basketball' | 'hockey' | 'baseball' | 'football';
  leaguePath: string;
  name: string;
  shortName: string;
  country?: string;
};

const ESPN_STATS_COMPETITIONS: EspnCompetitionSpec[] = [
  { id: 'eng.1', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'eng.1', name: 'English Premier League', shortName: 'EPL', country: 'England' },
  { id: 'uefa.champions', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'uefa.champions', name: 'UEFA Champions League', shortName: 'UCL', country: 'Europe' },
  { id: 'nba', sport: 'Basketball', sportPath: 'basketball', leaguePath: 'nba', name: 'NBA', shortName: 'NBA', country: 'United States' },
];

const ESPN_MAJOR_TOURNAMENTS: EspnCompetitionSpec[] = [
  { id: 'uefa.champions', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'uefa.champions', name: 'UEFA Champions League', shortName: 'UCL', country: 'Europe' },
  { id: 'fifa.world', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'fifa.world', name: 'FIFA World Cup', shortName: 'World Cup', country: 'International' },
  { id: 'uefa.euro', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'uefa.euro', name: 'UEFA European Championship', shortName: 'Euro', country: 'Europe' },
  { id: 'conmebol.america', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'conmebol.america', name: 'Copa America', shortName: 'Copa America', country: 'South America' },
  { id: 'conmebol.libertadores', sport: 'Soccer', sportPath: 'soccer', leaguePath: 'conmebol.libertadores', name: 'CONMEBOL Libertadores', shortName: 'Libertadores', country: 'South America' },
];

const ESPN_ALL_COMPETITIONS: EspnCompetitionSpec[] = Array.from(
  new Map<string, EspnCompetitionSpec>(
    [
      ...ESPN_FIXTURE_COMPETITIONS,
      ...ESPN_STATS_COMPETITIONS,
      ...ESPN_MAJOR_TOURNAMENTS,
    ].map((spec) => [spec.id, spec]),
  ).values(),
);

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type SportsDataProvider = 'thesportsdb' | 'espn' | 'espnsite' | 'jolpica' | 'openf1';

const responseCache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

export function resetSportsServiceCacheForTests(): void {
  responseCache.clear();
  inFlight.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function toNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function toInteger(value: unknown): number {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(numeric) ? numeric : 0;
}

function buildLeagueShortName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'League';
  if (trimmed.length <= 14) return trimmed;
  return trimmed
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 10) || trimmed.slice(0, 10);
}

function normalizeLeagueLookup(value: string | undefined): string {
  return (value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreFeaturedLeagueMatch(league: SportsLeagueOption, spec: FeaturedLeagueSpec): number {
  if (spec.sport && league.sport !== spec.sport) return -1;

  const haystacks = [
    normalizeLeagueLookup(league.name),
    normalizeLeagueLookup(league.shortName),
    normalizeLeagueLookup(league.alternateName),
  ].filter(Boolean);

  const aliases = spec.aliases.map((alias) => normalizeLeagueLookup(alias)).filter(Boolean);
  let best = -1;

  for (const alias of aliases) {
    for (const haystack of haystacks) {
      if (!haystack) continue;
      if (haystack === alias) {
        best = Math.max(best, 100);
        continue;
      }
      if (haystack.startsWith(alias)) {
        best = Math.max(best, 90);
        continue;
      }
      if (haystack.includes(alias)) {
        best = Math.max(best, 80);
        continue;
      }
      if (alias.includes(haystack) && haystack.length >= 4) {
        best = Math.max(best, 60);
      }
    }
  }

  return best;
}

async function resolveFeaturedLeagueOptions(specs: FeaturedLeagueSpec[]): Promise<SportsLeagueOption[]> {
  const leagues = await fetchAllSportsLeagues();
  const seen = new Set<string>();
  const resolved: SportsLeagueOption[] = [];

  for (const spec of specs) {
    let bestMatch: SportsLeagueOption | null = null;
    let bestScore = -1;

    for (const league of leagues) {
      const score = scoreFeaturedLeagueMatch(league, spec);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = league;
      }
    }

    if (!bestMatch || bestScore < 0 || seen.has(bestMatch.id)) continue;
    seen.add(bestMatch.id);
    resolved.push(bestMatch);
  }

  return resolved;
}

function getCached<T>(key: string): T | null {
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return cached.value as T;
}

function setCached<T>(key: string, value: T, ttlMs: number): T {
  responseCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  return value;
}

async function fetchSportsApiJson<T>(provider: SportsDataProvider, path: string, ttlMs: number): Promise<T> {
  const cacheKey = `json:${provider}:${path}`;
  const cached = getCached<T>(cacheKey);
  if (cached) return cached;

  const existing = inFlight.get(cacheKey) as Promise<T> | undefined;
  if (existing) return existing;

  const request = (async () => {
    const response = await fetch(
      toApiUrl(`/api/sports-data?provider=${provider}&path=${encodeURIComponent(path)}`),
      {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Sports data request failed (${response.status})`);
    }
    const json = await response.json() as T;
    return setCached(cacheKey, json, ttlMs);
  })();

  inFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function fetchSportsApiText(provider: SportsDataProvider, path: string, ttlMs: number): Promise<string> {
  const cacheKey = `text:${provider}:${path}`;
  const cached = getCached<string>(cacheKey);
  if (cached) return cached;

  const existing = inFlight.get(cacheKey) as Promise<string> | undefined;
  if (existing) return existing;

  const request = (async () => {
    const response = await fetch(
      toApiUrl(`/api/sports-data?provider=${provider}&path=${encodeURIComponent(path)}`),
      {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Sports data request failed (${response.status})`);
    }
    const text = await response.text();
    return setCached(cacheKey, text, ttlMs);
  })();

  inFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function fetchSportsDbJson<T>(path: string, ttlMs: number): Promise<T> {
  return fetchSportsApiJson<T>('thesportsdb', path, ttlMs);
}

async function fetchEspnText(path: string, ttlMs: number): Promise<string> {
  return fetchSportsApiText('espn', path, ttlMs);
}

async function fetchEspnSiteJson<T>(path: string, ttlMs: number): Promise<T> {
  return fetchSportsApiJson<T>('espnsite', path, ttlMs);
}

async function fetchJolpicaJson<T>(path: string, ttlMs: number): Promise<T> {
  return fetchSportsApiJson<T>('jolpica', path, ttlMs);
}

async function fetchOpenF1Json<T>(path: string, ttlMs: number): Promise<T> {
  return fetchSportsApiJson<T>('openf1', path, ttlMs);
}

function sortEventsAscending(events: SportsEvent[]): SportsEvent[] {
  return [...events].sort((a, b) => {
    const aTime = parseEventTimestamp(a);
    const bTime = parseEventTimestamp(b);
    return aTime - bTime;
  });
}

export function parseEventTimestamp(event: Pick<SportsEvent, 'strTimestamp' | 'dateEvent' | 'strTime'>): number {
  if (event.strTimestamp) {
    const ts = Date.parse(event.strTimestamp);
    if (!Number.isNaN(ts)) return ts;
  }
  if (event.dateEvent && event.strTime) {
    const combined = Date.parse(`${event.dateEvent}T${event.strTime}`);
    if (!Number.isNaN(combined)) return combined;
  }
  if (event.dateEvent) {
    const dateOnly = Date.parse(`${event.dateEvent}T00:00:00`);
    if (!Number.isNaN(dateOnly)) return dateOnly;
  }
  return Number.MAX_SAFE_INTEGER;
}

function sortEventsDescending(events: SportsEvent[]): SportsEvent[] {
  return [...events].sort((a, b) => parseEventTimestamp(b) - parseEventTimestamp(a));
}

function mapLeagueOption(raw: Record<string, unknown>): SportsLeagueOption | null {
  const id = toOptionalString(raw.idLeague);
  const name = toOptionalString(raw.strLeague);
  const sport = toOptionalString(raw.strSport);
  if (!id || !name || !sport) return null;

  return {
    id,
    name,
    sport,
    shortName: buildLeagueShortName(name),
    country: toOptionalString(raw.strCountry),
    alternateName: toOptionalString(raw.strLeagueAlternate),
  };
}

function mapLeagueDetails(raw: Record<string, unknown>): SportsLeagueDetails | null {
  const base = mapLeagueOption(raw);
  if (!base) return null;

  return {
    ...base,
    country: toOptionalString(raw.strCountry),
    currentSeason: toOptionalString(raw.strCurrentSeason),
    formedYear: toOptionalString(raw.intFormedYear),
    badge: toOptionalString(raw.strBadge),
    description: toOptionalString(raw.strDescriptionEN),
  };
}

function seasonSortScore(value: string): number {
  const matches = value.match(/\d{4}/g);
  if (!matches?.length) return Number.MIN_SAFE_INTEGER;
  const years = matches
    .map((part) => Number.parseInt(part, 10))
    .filter((year) => Number.isFinite(year));
  if (!years.length) return Number.MIN_SAFE_INTEGER;
  return Math.max(...years) * 10_000 + Math.min(...years);
}

function sortSeasonsDescending(seasons: string[]): string[] {
  return [...seasons].sort((a, b) => {
    const scoreDiff = seasonSortScore(b) - seasonSortScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return b.localeCompare(a);
  });
}

function resolveSelectedSeason(requestedSeason: string | undefined, seasons: string[], currentSeason?: string): string | undefined {
  if (requestedSeason && seasons.includes(requestedSeason)) return requestedSeason;
  if (requestedSeason && !seasons.length) return requestedSeason;
  if (currentSeason) return currentSeason;
  return seasons[0];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function readFirstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = toOptionalNumber(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeCompetitorName(value: string | undefined): string {
  return normalizeLeagueLookup(value)
    .replace(/\b(fc|cf|ac|sc|club|basketball|football)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCountryLookup(value: string | undefined): string {
  const normalized = normalizeLeagueLookup(value);
  if (!normalized) return '';

  switch (normalized) {
    case 'united states':
    case 'us':
      return 'usa';
    case 'united kingdom':
    case 'great britain':
    case 'england':
    case 'scotland':
    case 'wales':
      return 'uk';
    case 'united arab emirates':
      return 'uae';
    default:
      return normalized;
  }
}

function isLikelyLiveSportsEvent(event: Pick<SportsEvent, 'strStatus' | 'strProgress' | 'intHomeScore' | 'intAwayScore'>): boolean {
  const status = `${event.strStatus || ''} ${event.strProgress || ''}`.toLowerCase();
  if (!status) return false;
  if (LIVE_EVENT_STATUS_MARKERS.some((marker) => status.includes(marker))) return true;
  if ((event.intHomeScore || event.intAwayScore) && !status.includes('final')) return true;
  return false;
}

function scoreSportsFixtureSearchMatch(query: string, league: SportsLeague, event: SportsEvent): number {
  const normalizedQuery = normalizeLeagueLookup(query);
  if (!normalizedQuery) return 0;

  const fields = [
    event.strEvent,
    [event.strHomeTeam, event.strAwayTeam].filter(Boolean).join(' vs '),
    event.strHomeTeam,
    event.strAwayTeam,
    event.strLeague,
    league.name,
    league.shortName,
    league.country,
    event.strVenue,
  ]
    .map((value) => normalizeLeagueLookup(value))
    .filter(Boolean);

  let score = 0;
  for (const field of fields) {
    if (field === normalizedQuery) {
      score = Math.max(score, 140);
      continue;
    }
    if (field.startsWith(normalizedQuery)) {
      score = Math.max(score, 100);
      continue;
    }
    if (field.includes(normalizedQuery)) {
      score = Math.max(score, 75);
      continue;
    }
    if (normalizedQuery.startsWith(field) && field.length >= 5) {
      score = Math.max(score, 45);
    }
  }

  const queryTokens = normalizedQuery.split(' ').filter((token) => token.length >= 2);
  if (queryTokens.length > 1) {
    const tokenHits = queryTokens.reduce((hits, token) => (
      fields.some((field) => field.includes(token)) ? hits + 1 : hits
    ), 0);
    score += tokenHits * 18;
  }

  if (isLikelyLiveSportsEvent(event)) score += 24;
  if (event.intHomeScore || event.intAwayScore) score += 8;

  return score;
}

function formatSportsFixtureStartLabel(event: Pick<SportsEvent, 'strTimestamp' | 'dateEvent' | 'strTime'>): string {
  const timestamp = parseEventTimestamp(event);
  if (timestamp !== Number.MAX_SAFE_INTEGER) {
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  if (event.dateEvent && event.strTime) return `${event.dateEvent} ${event.strTime}`;
  return event.dateEvent || event.strTime || 'TBD';
}

export function getSportsFixtureVisualMeta(sport: string): SportsFixtureVisualMeta {
  switch (sport) {
    case 'Mixed':
      return { icon: '🏟️', colorHex: '#f8fafc', colorRgba: [248, 250, 252, 220] };
    case 'Soccer':
    case 'Football':
      return { icon: '⚽', colorHex: '#22c55e', colorRgba: [34, 197, 94, 210] };
    case 'American Football':
      return { icon: '🏈', colorHex: '#f59e0b', colorRgba: [245, 158, 11, 210] };
    case 'Basketball':
      return { icon: '🏀', colorHex: '#f97316', colorRgba: [249, 115, 22, 210] };
    case 'Baseball':
      return { icon: '⚾', colorHex: '#fb923c', colorRgba: [251, 146, 60, 210] };
    case 'Ice Hockey':
    case 'Hockey':
      return { icon: '🏒', colorHex: '#60a5fa', colorRgba: [96, 165, 250, 210] };
    case 'Tennis':
      return { icon: '🎾', colorHex: '#38bdf8', colorRgba: [56, 189, 248, 210] };
    case 'Cricket':
      return { icon: '🏏', colorHex: '#a78bfa', colorRgba: [167, 139, 250, 210] };
    case 'Motorsport':
      return { icon: '🏁', colorHex: '#eab308', colorRgba: [234, 179, 8, 210] };
    default:
      return { icon: '🎯', colorHex: '#eab308', colorRgba: [234, 179, 8, 210] };
  }
}

export function isSportsFixtureHubMarker(marker: Pick<SportsFixtureMapMarker, 'fixtureCount' | 'fixtures'>): boolean {
  return Math.max(marker.fixtureCount ?? 0, marker.fixtures?.length ?? 0) > 1;
}

function countSportsFixtures(marker: Pick<SportsFixtureMapMarker, 'fixtureCount' | 'fixtures'>): number {
  return Math.max(marker.fixtureCount ?? 0, marker.fixtures?.length ?? 0, 1);
}

function truncateSportsLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}\u2026`;
}

function compactSportsCompetitorLabel(name: string | undefined, maxLength: number): string {
  const cleaned = (name || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxLength) return cleaned;

  const parts = cleaned.split(' ').filter(Boolean);
  const meaningfulParts = parts.filter((part) => !SPORTS_TEAM_LABEL_STOPWORDS.has(part.toLowerCase()));
  const preferredParts = meaningfulParts.length > 0 ? meaningfulParts : parts;
  const lastPart = preferredParts[preferredParts.length - 1] || '';
  if (lastPart && lastPart.length <= maxLength) return lastPart;

  const firstPart = preferredParts[0] || '';
  const firstLastLabel = [firstPart, lastPart]
    .filter(Boolean)
    .filter((part, index, source) => index === 0 || part !== source[index - 1])
    .join(' ');
  if (firstLastLabel && firstLastLabel.length <= maxLength + 4) return firstLastLabel;

  const initials = preferredParts
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase();
  if (initials.length >= 2 && initials.length <= maxLength) return initials;

  return truncateSportsLabel(cleaned, maxLength);
}

function flattenSportsFixtureMarkers(markers: SportsFixtureMapMarker[]): SportsFixtureMapMarker[] {
  return sortSportsFixtureMapMarkers(markers.flatMap((marker) => {
    if (marker.fixtures?.length) return flattenSportsFixtureMarkers(marker.fixtures);
    return [{
      ...marker,
      fixtureCount: 1,
      competitionCount: 1,
      sports: [marker.sport],
      fixtures: undefined,
    }];
  }));
}

export function getSportsFixtureDisplayLabel(marker: SportsFixtureMapMarker, compact = false): string {
  const fixtureCount = countSportsFixtures(marker);
  const maxLength = compact ? 26 : 38;

  if (fixtureCount > 1) {
    const venueLabel = marker.venueCity || marker.venue || marker.venueCountry || '';
    const summary = venueLabel ? `${fixtureCount} fixtures \u00b7 ${venueLabel}` : `${fixtureCount} fixtures`;
    return truncateSportsLabel(summary, maxLength);
  }

  const home = compactSportsCompetitorLabel(marker.homeTeam, compact ? 10 : 14);
  const away = compactSportsCompetitorLabel(marker.awayTeam, compact ? 10 : 14);
  if (home && away) return truncateSportsLabel(`${home} vs ${away}`, maxLength);

  return truncateSportsLabel(
    marker.title || marker.venueCity || marker.venue || marker.leagueShortName || marker.sport,
    maxLength,
  );
}

export function getSportsFixtureSubLabel(marker: SportsFixtureMapMarker): string {
  const parts: string[] = [];
  const fixtureCount = countSportsFixtures(marker);

  if (fixtureCount > 1) {
    if (marker.sports && marker.sports.length > 0 && marker.sports.length <= 2) {
      parts.push(marker.sports.join(' \u00b7 '));
    } else {
      parts.push(marker.leagueShortName === 'MULTI' ? 'Multi-sport' : marker.leagueShortName || marker.sport);
    }
  } else if (marker.leagueShortName) {
    parts.push(marker.leagueShortName);
  }

  if (marker.venueCity) parts.push(marker.venueCity);
  else if (marker.venueCountry) parts.push(marker.venueCountry);

  if (marker.startLabel) parts.push(marker.startLabel);

  return truncateSportsLabel(parts.filter(Boolean).join(' \u00b7 '), 52);
}

export function getSportsFixtureRenderPriority(marker: SportsFixtureMapMarker): number {
  const fixtureCount = countSportsFixtures(marker);
  let score = fixtureCount * 6;
  score += (marker.competitionCount ?? 1) * 2;
  score += Math.max(0, 10 - (SPORTS_FIXTURE_SPORT_PRIORITY.get(marker.sport) ?? 8));
  if (marker.homeTeam && marker.awayTeam) score += 4;
  if (marker.venueCity) score += 1;

  const timestamp = marker.startTime ? Date.parse(marker.startTime) : Number.NaN;
  if (Number.isFinite(timestamp)) {
    const hoursUntil = Math.abs(timestamp - Date.now()) / (60 * 60 * 1000);
    if (hoursUntil <= 6) score += 3;
    else if (hoursUntil <= 18) score += 2;
    else if (hoursUntil <= 30) score += 1;
  }

  return score;
}

export function buildSportsFixtureAggregateMarker(
  markers: SportsFixtureMapMarker[],
  overrides: Partial<SportsFixtureMapMarker> = {},
): SportsFixtureMapMarker {
  const fixtures = flattenSportsFixtureMarkers(markers);
  const [earliestFixture] = fixtures;
  if (!earliestFixture) {
    throw new Error('Sports fixture aggregate cannot be built from an empty marker list');
  }

  if (fixtures.length === 1 && Object.keys(overrides).length === 0) return earliestFixture;

  const sports = uniqueStrings(fixtures.map((fixture) => fixture.sport));
  const competitions = uniqueStrings(fixtures.map((fixture) => fixture.leagueName));
  const [primarySport] = sports;
  const [primaryCompetition] = competitions;
  const fixtureCount = fixtures.length;
  const defaultTitle = fixtureCount > 1 ? `${fixtureCount} fixtures` : earliestFixture.title;
  const defaultStartLabel = fixtureCount > 1
    ? `${earliestFixture.startLabel} \u2022 ${fixtureCount} fixtures`
    : earliestFixture.startLabel;
  const centerLat = fixtures.reduce((sum, fixture) => sum + fixture.lat, 0) / fixtureCount;
  const centerLng = fixtures.reduce((sum, fixture) => sum + fixture.lng, 0) / fixtureCount;

  return {
    ...earliestFixture,
    ...overrides,
    id: overrides.id ?? `sports-fixture-hub:${fixtures.map((fixture) => fixture.eventId).join(',')}`,
    title: overrides.title ?? defaultTitle,
    leagueName: overrides.leagueName ?? (competitions.length === 1 && primaryCompetition ? primaryCompetition : `${competitions.length} competitions`),
    leagueShortName: overrides.leagueShortName ?? (competitions.length === 1 ? earliestFixture.leagueShortName : 'MULTI'),
    sport: overrides.sport ?? (sports.length === 1 && primarySport ? primarySport : 'Mixed'),
    startLabel: overrides.startLabel ?? defaultStartLabel,
    lat: overrides.lat ?? centerLat,
    lng: overrides.lng ?? centerLng,
    fixtureCount: overrides.fixtureCount ?? fixtureCount,
    competitionCount: overrides.competitionCount ?? competitions.length,
    sports: overrides.sports ?? sports,
    fixtures,
  };
}

const CITY_COORDINATE_ENTRIES: CityCoordinateEntry[] = Object.entries(CITY_COORDS).map(([key, coord]) => ({
  normalizedKey: normalizeLeagueLookup(key),
  normalizedCountry: normalizeCountryLookup(coord.country),
  coord,
})).filter((entry) => !!entry.normalizedKey);

const COUNTRY_COORDINATE_SUMMARIES = new Map<string, CountryCoordinateSummary>();
for (const entry of CITY_COORDINATE_ENTRIES) {
  const existing = COUNTRY_COORDINATE_SUMMARIES.get(entry.normalizedCountry);
  if (!existing) {
    COUNTRY_COORDINATE_SUMMARIES.set(entry.normalizedCountry, {
      lat: entry.coord.lat,
      lng: entry.coord.lng,
      samples: 1,
    });
    continue;
  }

  const samples = existing.samples + 1;
  COUNTRY_COORDINATE_SUMMARIES.set(entry.normalizedCountry, {
    lat: ((existing.lat * existing.samples) + entry.coord.lat) / samples,
    lng: ((existing.lng * existing.samples) + entry.coord.lng) / samples,
    samples,
  });
}

type SportsVenueProfile = {
  name: string;
  city?: string;
  country?: string;
  capacity?: string;
  surface?: string;
  lat?: number;
  lng?: number;
};

type SportsFixtureCandidate = {
  league: SportsLeague;
  event: SportsEvent;
};

type CityCoordinateEntry = {
  normalizedKey: string;
  normalizedCountry: string;
  coord: CityCoord;
};

type CountryCoordinateSummary = {
  lat: number;
  lng: number;
  samples: number;
};

const SPORT_COORDINATE_FALLBACKS: Record<string, { lat: number; lng: number }> = {
  soccer: { lat: 50.1109, lng: 8.6821 },
  basketball: { lat: 39.8283, lng: -98.5795 },
  'ice hockey': { lat: 45.4215, lng: -75.6972 },
  baseball: { lat: 39.0119, lng: -98.4842 },
  'american football': { lat: 39.0119, lng: -98.4842 },
  motorsport: { lat: 46.8182, lng: 8.2275 },
  tennis: { lat: 48.8566, lng: 2.3522 },
  cricket: { lat: 22.9734, lng: 78.6569 },
};

function mapVenueProfile(raw: Record<string, unknown>): SportsVenueProfile | null {
  const name = toOptionalString(raw.strVenue) || toOptionalString(raw.strLocation);
  if (!name) return null;

  const lat = readFirstNumber(raw, ['strLatitude', 'strLat', 'strGeoLat', 'strVenueLatitude']);
  const lng = readFirstNumber(raw, ['strLongitude', 'strLon', 'strLng', 'strGeoLong', 'strVenueLongitude']);
  const hasCoords = lat !== undefined && lng !== undefined && !(lat === 0 && lng === 0);

  return {
    name,
    city: toOptionalString(raw.strCity) || toOptionalString(raw.strLocation),
    country: toOptionalString(raw.strCountry),
    capacity: toOptionalString(raw.intCapacity),
    surface: toOptionalString(raw.strSurface),
    lat: hasCoords ? lat : undefined,
    lng: hasCoords ? lng : undefined,
  };
}

function hashFixtureSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function wrapLongitude(value: number): number {
  if (value > 180) return value - 360;
  if (value < -180) return value + 360;
  return value;
}

function applyFixtureCoordinateJitter(lat: number, lng: number, seed: string): { lat: number; lng: number } {
  const hash = hashFixtureSeed(seed);
  const latOffset = (((hash % 1000) / 999) - 0.5) * 1.2;
  const lngOffset = ((((Math.floor(hash / 1000)) % 1000) / 999) - 0.5) * 1.8;
  const lngScale = Math.max(0.45, Math.cos((lat * Math.PI) / 180));

  return {
    lat: Math.max(-80, Math.min(80, lat + latOffset)),
    lng: wrapLongitude(lng + (lngOffset / lngScale)),
  };
}

function resolveKnownCityCoordinate(city: string | undefined, country: string | undefined): { lat: number; lng: number } | null {
  const normalizedCity = normalizeLeagueLookup(city);
  if (!normalizedCity) return null;

  const normalizedCountry = normalizeCountryLookup(country);
  let best: CityCoordinateEntry | null = null;
  let bestScore = -1;

  for (const entry of CITY_COORDINATE_ENTRIES) {
    let score = -1;
    if (entry.normalizedKey === normalizedCity) score = 100;
    else if (entry.normalizedKey.startsWith(normalizedCity) || normalizedCity.startsWith(entry.normalizedKey)) score = 80;
    else if (entry.normalizedKey.includes(normalizedCity) || normalizedCity.includes(entry.normalizedKey)) score = 60;
    if (score < 0) continue;
    if (normalizedCountry && entry.normalizedCountry === normalizedCountry) score += 40;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return best ? { lat: best.coord.lat, lng: best.coord.lng } : null;
}

function resolveFallbackFixtureCoordinate(event: SportsEvent, league: SportsLeague): { lat: number; lng: number } | null {
  const cityCoordinate = resolveKnownCityCoordinate(event.strCity, event.strCountry || league.country);
  if (cityCoordinate) return cityCoordinate;

  const normalizedCountry = normalizeCountryLookup(event.strCountry || league.country);
  const countrySummary = normalizedCountry ? COUNTRY_COORDINATE_SUMMARIES.get(normalizedCountry) : null;
  if (!countrySummary) return null;

  return applyFixtureCoordinateJitter(
    countrySummary.lat,
    countrySummary.lng,
    `${event.idEvent}:${event.strEvent || event.strHomeTeam || ''}:${event.strCity || event.strCountry || league.name}`,
  );
}

function resolveSportFallbackCoordinate(event: SportsEvent, league: SportsLeague): { lat: number; lng: number } | null {
  const sportKey = normalizeLeagueLookup(event.strSport || league.sport);
  const fallback = sportKey ? SPORT_COORDINATE_FALLBACKS[sportKey] : null;
  if (!fallback) return null;
  return applyFixtureCoordinateJitter(
    fallback.lat,
    fallback.lng,
    `${event.idEvent}:${event.strEvent || event.strHomeTeam || ''}:${league.name}:${sportKey}`,
  );
}

async function fetchVenueProfilesByName(venueName: string): Promise<SportsVenueProfile[]> {
  const trimmed = venueName.trim();
  if (!trimmed) return [];
  const payload = await fetchSportsDbJson<{ venues?: unknown }>(`/searchvenues.php?v=${encodeURIComponent(trimmed)}`, 6 * 60 * 60 * 1000);
  return asArray(payload.venues)
    .map(mapVenueProfile)
    .filter((venue): venue is SportsVenueProfile => !!venue && venue.lat !== undefined && venue.lng !== undefined);
}

function scoreVenueProfile(venue: SportsVenueProfile, event: SportsEvent, league: SportsLeague): number {
  const normalizedVenue = normalizeLeagueLookup(venue.name);
  const normalizedEventVenue = normalizeLeagueLookup(event.strVenue);
  const normalizedCity = normalizeLeagueLookup(event.strCity);
  const normalizedCountry = normalizeLeagueLookup(event.strCountry || league.country);
  let score = 0;

  if (normalizedVenue && normalizedEventVenue) {
    if (normalizedVenue === normalizedEventVenue) score += 100;
    else if (normalizedVenue.includes(normalizedEventVenue) || normalizedEventVenue.includes(normalizedVenue)) score += 70;
  }

  if (normalizedCity && normalizeLeagueLookup(venue.city) === normalizedCity) score += 25;
  if (normalizedCountry && normalizeLeagueLookup(venue.country) === normalizedCountry) score += 20;
  return score;
}

async function resolveEventVenueProfile(event: SportsEvent, league: SportsLeague): Promise<SportsVenueProfile | null> {
  const inlineVenue: SportsVenueProfile | null = event.strVenue
    ? {
      name: event.strVenue,
      city: event.strCity,
      country: event.strCountry || league.country,
      lat: event.lat,
      lng: event.lng,
    }
    : null;

  if (inlineVenue?.lat !== undefined && inlineVenue.lng !== undefined) {
    return inlineVenue;
  }

  const fallbackCoordinate = resolveFallbackFixtureCoordinate(event, league);
  if (fallbackCoordinate) {
    return {
      name: event.strVenue || event.strCity || event.strEvent || league.name,
      city: event.strCity,
      country: event.strCountry || league.country,
      lat: fallbackCoordinate.lat,
      lng: fallbackCoordinate.lng,
    };
  }

  const sportFallbackCoordinate = resolveSportFallbackCoordinate(event, league);
  if (!event.strVenue) {
    if (!sportFallbackCoordinate) return null;
    return {
      name: event.strVenue || event.strCity || event.strEvent || league.name,
      city: event.strCity,
      country: event.strCountry || league.country,
      lat: sportFallbackCoordinate.lat,
      lng: sportFallbackCoordinate.lng,
    };
  }

  const venues = await fetchVenueProfilesByName(event.strVenue).catch(() => []);
  if (!venues.length) {
    if (inlineVenue?.lat !== undefined && inlineVenue.lng !== undefined) return inlineVenue;
    if (!sportFallbackCoordinate) return inlineVenue;
    return {
      name: inlineVenue?.name || event.strVenue,
      city: inlineVenue?.city || event.strCity,
      country: inlineVenue?.country || event.strCountry || league.country,
      lat: sportFallbackCoordinate.lat,
      lng: sportFallbackCoordinate.lng,
    };
  }

  return venues
    .slice()
    .sort((a, b) => scoreVenueProfile(b, event, league) - scoreVenueProfile(a, event, league))[0] || inlineVenue;
}

function pickSportsFixtureCandidates(groups: SportsFixtureGroup[]): SportsFixtureCandidate[] {
  const all = groups
    .flatMap((group) => group.events.map((event) => ({ league: group.league, event } satisfies SportsFixtureCandidate)))
    .sort((a, b) => {
      const timeDiff = parseEventTimestamp(a.event) - parseEventTimestamp(b.event);
      if (timeDiff !== 0) return timeDiff;
      return a.league.name.localeCompare(b.league.name);
    });

  const selected: SportsFixtureCandidate[] = [];
  const used = new Set<string>();

  for (const candidate of all) {
    if (used.has(candidate.event.idEvent)) continue;
    used.add(candidate.event.idEvent);
    selected.push(candidate);
  }

  return selected;
}

function findStandingRowByTeam<T extends { team?: string; abbreviation?: string }>(rows: T[], teamName: string | undefined): T | null {
  const normalized = normalizeCompetitorName(teamName);
  if (!normalized) return null;

  let best: T | null = null;
  let bestScore = -1;

  for (const row of rows) {
    const candidates = [
      normalizeCompetitorName(row.team),
      normalizeCompetitorName(row.abbreviation),
    ].filter(Boolean);

    let score = -1;
    for (const candidate of candidates) {
      if (candidate === normalized) score = Math.max(score, 100);
      else if (candidate.startsWith(normalized) || normalized.startsWith(candidate)) score = Math.max(score, 80);
      else if (candidate.includes(normalized) || normalized.includes(candidate)) score = Math.max(score, 60);
    }

    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }

  return bestScore >= 60 ? best : null;
}

function isSameFixturePair(event: SportsEvent, homeTeam: string | undefined, awayTeam: string | undefined): boolean {
  const eventHome = normalizeCompetitorName(event.strHomeTeam);
  const eventAway = normalizeCompetitorName(event.strAwayTeam);
  const expectedHome = normalizeCompetitorName(homeTeam);
  const expectedAway = normalizeCompetitorName(awayTeam);
  if (!eventHome || !eventAway || !expectedHome || !expectedAway) return false;
  return (
    (eventHome === expectedHome && eventAway === expectedAway)
    || (eventHome === expectedAway && eventAway === expectedHome)
  );
}

function formatLastMeeting(event: SportsEvent): string {
  const home = event.strHomeTeam || 'Home';
  const away = event.strAwayTeam || 'Away';
  const score = event.intHomeScore && event.intAwayScore ? `${event.intHomeScore}-${event.intAwayScore}` : 'Result pending';
  return `${home} ${score} ${away} (${formatSportsFixtureStartLabel(event)})`;
}

function formatRecentFixtureEvent(event: SportsEvent): string {
  if (event.strHomeTeam && event.strAwayTeam) return formatLastMeeting(event);
  return `${event.strEvent || event.strLeague || 'Recent event'} (${formatSportsFixtureStartLabel(event)})`;
}

function getEventWinnerName(event: SportsEvent): string | null {
  const homeScore = toOptionalNumber(event.intHomeScore);
  const awayScore = toOptionalNumber(event.intAwayScore);
  if (homeScore === undefined || awayScore === undefined || homeScore === awayScore) return null;
  return homeScore > awayScore ? event.strHomeTeam || null : event.strAwayTeam || null;
}

function isFormulaOneFixture(marker: SportsFixtureMapMarker): boolean {
  const labels = [marker.leagueName, marker.leagueShortName].map((value) => normalizeLeagueLookup(value));
  return labels.some((label) => label === 'formula 1' || label === 'f1' || label.includes('formula 1'));
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusKm = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180)
    * Math.cos((lat2 * Math.PI) / 180)
    * Math.sin(dLon / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isUnitedStatesVenue(country: string | undefined): boolean {
  const normalized = normalizeLeagueLookup(country);
  return normalized === 'united states' || normalized === 'usa' || normalized === 'us';
}

function summarizeFixtureWeather(marker: SportsFixtureMapMarker, alerts: WeatherAlert[]): string {
  if (!alerts.length) return 'Live weather context is unavailable right now.';
  if (!isUnitedStatesVenue(marker.venueCountry)) {
    return 'Weather alerts are only wired for the U.S. feed in this view.';
  }

  let nearest: WeatherAlert | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const alert of alerts) {
    const [lon, lat] = alert.centroid ?? alert.coordinates[0] ?? [];
    const latValue = Number(lat);
    const lonValue = Number(lon);
    if (!Number.isFinite(latValue) || !Number.isFinite(lonValue)) continue;
    const distanceKm = haversineDistanceKm(marker.lat, marker.lng, latValue, lonValue);
    if (distanceKm < nearestDistance) {
      nearest = alert;
      nearestDistance = distanceKm;
    }
  }

  if (!nearest || nearestDistance > 140) return 'No nearby U.S. weather alert in the current feed.';
  return `${nearest.severity} ${nearest.event} roughly ${Math.round(nearestDistance)} km from the venue.`;
}

function buildFootballPrediction(
  marker: SportsFixtureMapMarker,
  homeRow: SportsStandingRow | null,
  awayRow: SportsStandingRow | null,
): string {
  if (!homeRow || !awayRow) return 'Form context is thin, so this looks closer to a venue-and-momentum match than a clear mismatch.';
  const pointsDelta = homeRow.points - awayRow.points;
  const rankDelta = awayRow.rank - homeRow.rank;
  if (pointsDelta >= 10 || rankDelta >= 5) return `${marker.homeTeam || 'The home side'} hold the stronger table profile and should carry the sharper control into kickoff.`;
  if (pointsDelta <= -10 || rankDelta <= -5) return `${marker.awayTeam || 'The away side'} arrive with the cleaner season profile and project as the more stable side.`;
  if (Math.abs(pointsDelta) <= 3 && Math.abs(rankDelta) <= 2) return 'This projects as a tight swing fixture where one transition or set piece could decide it.';
  return `${pointsDelta >= 0 ? marker.homeTeam || 'The home side' : marker.awayTeam || 'The away side'} have the marginal table edge, but the gap is still live enough for an upset.`;
}

function buildFootballStory(
  homeRow: SportsStandingRow | null,
  awayRow: SportsStandingRow | null,
  lastMeeting: SportsEvent | null,
): string {
  if (homeRow && awayRow) {
    if (homeRow.rank <= 4 || awayRow.rank <= 4) return 'The table pressure is high here: European qualification stakes make every point expensive.';
    if (Math.abs(homeRow.rank - awayRow.rank) <= 2) return 'These sides sit close enough in the table for one result to move the narrative immediately.';
    if (homeRow.rank >= 15 || awayRow.rank >= 15) return 'The subtext is survival pressure, so game state and nerves matter as much as talent.';
  }
  if (lastMeeting) return `The last meeting finished ${formatLastMeeting(lastMeeting)}, so there is recent reference for how the matchup can tilt.`;
  return 'The story is less about raw talent and more about who controls the tempo first.';
}

function buildNbaPrediction(
  marker: SportsFixtureMapMarker,
  homeRow: NbaStandingRow | null,
  awayRow: NbaStandingRow | null,
): string {
  if (!homeRow || !awayRow) return 'Without a clean standings read, this projects as a rhythm and shot-variance game more than a locked result.';
  const homePct = Number.parseFloat(homeRow.winPercent);
  const awayPct = Number.parseFloat(awayRow.winPercent);
  const pctDelta = homePct - awayPct;
  if (pctDelta >= 0.12) return `${marker.homeTeam || 'The home team'} carry the stronger season baseline and should enter as the favorite.`;
  if (pctDelta <= -0.12) return `${marker.awayTeam || 'The away team'} bring the better season trend and look better positioned on paper.`;
  if (Math.abs(pctDelta) <= 0.04) return 'The records say this should stay live into the fourth quarter.';
  return `${pctDelta >= 0 ? marker.homeTeam || 'The home team' : marker.awayTeam || 'The away team'} have the slight edge, but recent form still matters more than broad season record here.`;
}

function buildNbaStory(
  homeRow: NbaStandingRow | null,
  awayRow: NbaStandingRow | null,
  lastMeeting: SportsEvent | null,
): string {
  if (homeRow && awayRow && (homeRow.clincher || awayRow.clincher)) {
    return 'Playoff positioning is already part of the story, so rotation choices and late-game urgency could swing the feel of this one.';
  }
  if (homeRow && awayRow && homeRow.lastTen !== awayRow.lastTen) {
    return `Recent form split matters here: ${homeRow.team} are ${homeRow.lastTen} lately, while ${awayRow.team} are ${awayRow.lastTen}.`;
  }
  if (lastMeeting) return `Their latest direct result was ${formatLastMeeting(lastMeeting)}, which gives this rematch some built-in edge.`;
  return 'Watch pace control and bench shot creation more than headline narratives here.';
}

function buildTennisPrediction(lastMeeting: SportsEvent | null): string {
  const winner = lastMeeting ? getEventWinnerName(lastMeeting) : null;
  if (winner) return `${winner} carry the most recent head-to-head edge, but serve quality and break-point conversion should still decide the match.`;
  return 'Serve hold rate and return pressure should matter more here than any broad pre-match narrative.';
}

function buildTennisStory(marker: SportsFixtureMapMarker, lastMeeting: SportsEvent | null): string {
  if (lastMeeting) return `The previous meeting was ${formatLastMeeting(lastMeeting)}, so the question is whether that matchup pattern repeats.`;
  if (marker.venueSurface) return `${marker.venueSurface} conditions could reshape the balance between first-strike serving and baseline rallies.`;
  return 'Watch first-serve percentage and break-point conversion more than generic form lines here.';
}

function buildCricketPrediction(lastMeeting: SportsEvent | null): string {
  const winner = lastMeeting ? getEventWinnerName(lastMeeting) : null;
  if (winner) return `${winner} have the recent result edge, but toss, powerplay control, and death-over execution should still swing the fixture.`;
  return 'This looks likely to turn on the powerplay and final overs more than a clean pre-match mismatch.';
}

function buildCricketStory(lastMeeting: SportsEvent | null): string {
  if (lastMeeting) return `The previous meeting was ${formatLastMeeting(lastMeeting)}, so batting tempo and bowling control are the obvious repeat themes.`;
  return 'Toss, conditions, and who wins the middle overs are the main storylines here.';
}

function buildGenericFixturePrediction(marker: SportsFixtureMapMarker, lastMeeting: SportsEvent | null): string {
  const winner = lastMeeting ? getEventWinnerName(lastMeeting) : null;
  if (winner) return `${winner} own the most recent direct result, but this still profiles as a live matchup once venue conditions kick in.`;
  return `${marker.venue} becomes a meaningful variable here, so execution on the day matters more than thin historical context.`;
}

function buildGenericFixtureStory(marker: SportsFixtureMapMarker, lastMeeting: SportsEvent | null): string {
  if (lastMeeting) return `The clearest recent signal is ${formatLastMeeting(lastMeeting)}, which gives this fixture an immediate reference point.`;
  return `${marker.venue} is the main storyline variable, so local conditions and fast starts should shape the feel of this one.`;
}

function buildMotorsportPrediction(marker: SportsFixtureMapMarker, f1: FormulaOneStandingsData | null): string {
  if (!isFormulaOneFixture(marker) || !f1) {
    return 'Track position, clean execution, and changing conditions should matter more than broad historical trend here.';
  }
  const leader = f1.driverStandings[0];
  if (leader) return `${leader.name} still defines the championship pace, but qualifying and tyre management will shape this race weekend.`;
  return 'Qualifying and race-day execution should set the edge more than pure season standings.';
}

function buildMotorsportStory(marker: SportsFixtureMapMarker, f1: FormulaOneStandingsData | null): string {
  if (!isFormulaOneFixture(marker)) {
    return `${marker.venue} puts the emphasis on setup, track position, and who adapts fastest over the weekend.`;
  }
  if (!f1) return `${marker.venue} puts the emphasis on track conditions, weekend setup, and who handles the pressure best.`;
  if (f1.lastRace?.winner) return `The last race went to ${f1.lastRace.winner}, so the next question is whether that momentum travels into ${marker.venue}.`;
  if (f1.nextRace?.circuitName) return `${f1.nextRace.circuitName} now becomes the next checkpoint in the title narrative.`;
  return `${marker.venue} becomes the next control point in the championship story.`;
}

function mapEvent(raw: Record<string, unknown>): SportsEvent {
  return {
    idEvent: String(raw.idEvent ?? ''),
    idLeague: raw.idLeague ? String(raw.idLeague) : undefined,
    strLeague: raw.strLeague ? String(raw.strLeague) : undefined,
    strSeason: raw.strSeason ? String(raw.strSeason) : undefined,
    strSport: raw.strSport ? String(raw.strSport) : undefined,
    strEvent: raw.strEvent ? String(raw.strEvent) : undefined,
    strHomeTeam: raw.strHomeTeam ? String(raw.strHomeTeam) : undefined,
    strAwayTeam: raw.strAwayTeam ? String(raw.strAwayTeam) : undefined,
    strHomeBadge: toOptionalString(raw.strHomeBadge) || toOptionalString(raw.strHomeTeamBadge),
    strAwayBadge: toOptionalString(raw.strAwayBadge) || toOptionalString(raw.strAwayTeamBadge),
    strStatus: raw.strStatus ? String(raw.strStatus) : undefined,
    strProgress: raw.strProgress ? String(raw.strProgress) : undefined,
    strVenue: raw.strVenue ? String(raw.strVenue) : undefined,
    strCity: toOptionalString(raw.strCity),
    strCountry: toOptionalString(raw.strCountry),
    strRound: raw.intRound ? String(raw.intRound) : raw.strRound ? String(raw.strRound) : undefined,
    strTimestamp: raw.strTimestamp ? String(raw.strTimestamp) : undefined,
    dateEvent: raw.dateEvent ? String(raw.dateEvent) : undefined,
    strTime: raw.strTime ? String(raw.strTime) : undefined,
    intHomeScore: raw.intHomeScore ? String(raw.intHomeScore) : undefined,
    intAwayScore: raw.intAwayScore ? String(raw.intAwayScore) : undefined,
    lat: readFirstNumber(raw, ['strLatitude', 'strLat', 'strGeoLat']),
    lng: readFirstNumber(raw, ['strLongitude', 'strLon', 'strLng', 'strGeoLong']),
  };
}

function mapStandingRow(row: Record<string, unknown>): SportsStandingRow {
  return {
    rank: toNumber(row.intRank),
    team: String(row.strTeam ?? 'Unknown'),
    badge: row.strBadge ? String(row.strBadge) : undefined,
    played: toNumber(row.intPlayed),
    wins: toNumber(row.intWin),
    draws: toNumber(row.intDraw),
    losses: toNumber(row.intLoss),
    goalDifference: toNumber(row.intGoalDifference),
    points: toNumber(row.intPoints),
    form: row.strForm ? String(row.strForm) : undefined,
    note: row.strDescription ? String(row.strDescription) : undefined,
    season: row.strSeason ? String(row.strSeason) : undefined,
  };
}

function mapEspnCompetitionOption(spec: EspnCompetitionSpec): SportsLeagueOption {
  return {
    id: spec.id,
    sport: spec.sport,
    name: spec.name,
    shortName: spec.shortName,
  };
}

function mapEspnCompetitionDetails(spec: EspnCompetitionSpec, seasonLabel?: string): SportsLeagueDetails {
  return {
    ...mapEspnCompetitionOption(spec),
    country: spec.country,
    currentSeason: seasonLabel,
  };
}

function mapEspnCompetitionLeague(spec: EspnCompetitionSpec): SportsLeague {
  return {
    id: spec.id,
    sport: spec.sport,
    name: spec.name,
    shortName: spec.shortName,
    country: spec.country,
  };
}

function resolveEspnCompetitionSpec(leagueId?: string, leagueName?: string): EspnCompetitionSpec | null {
  const byId = (leagueId || '').trim();
  if (byId) {
    const exact = ESPN_ALL_COMPETITIONS.find((spec) => spec.id === byId);
    if (exact) return exact;
  }

  const normalizedLeagueId = normalizeLeagueLookup(leagueId);
  if (normalizedLeagueId) {
    const exact = ESPN_ALL_COMPETITIONS.find((spec) => normalizeLeagueLookup(spec.id) === normalizedLeagueId);
    if (exact) return exact;
  }

  const normalizedLeagueName = normalizeLeagueLookup(leagueName);
  if (normalizedLeagueName) {
    const byName = ESPN_ALL_COMPETITIONS.find((spec) => {
      const haystacks = [
        normalizeLeagueLookup(spec.name),
        normalizeLeagueLookup(spec.shortName),
      ];
      return haystacks.some((haystack) => haystack === normalizedLeagueName || haystack.includes(normalizedLeagueName));
    });
    if (byName) return byName;
  }

  return null;
}

function buildEspnSiteScoreboardPath(spec: EspnCompetitionSpec, dateStr?: string): string {
  const base = `/${spec.sportPath}/${spec.leaguePath}/scoreboard`;
  return dateStr ? `${base}?dates=${dateStr.replace(/-/g, '')}` : base;
}

function buildEspnSiteSummaryPath(spec: EspnCompetitionSpec, eventId: string): string {
  return `/${spec.sportPath}/${spec.leaguePath}/summary?event=${encodeURIComponent(eventId)}`;
}

function extractEspnTeamLogo(team: Record<string, unknown> | null): string | undefined {
  if (!team) return undefined;
  const direct = toOptionalString(team.logo);
  if (direct) return direct;
  const logos = asArray(team.logos);
  return toOptionalString(logos[0]?.href);
}

function pickEspnCompetitor(
  competitors: Record<string, unknown>[],
  homeAway: 'home' | 'away',
  fallbackIndex: number,
): Record<string, unknown> | null {
  return competitors.find((competitor) => toOptionalString(competitor.homeAway) === homeAway)
    || competitors[fallbackIndex]
    || null;
}

function mapEspnScoreboardEvent(spec: EspnCompetitionSpec, raw: Record<string, unknown>): SportsEvent | null {
  const competition = asArray(raw.competitions)[0];
  if (!competition) return null;

  const competitors = asArray(competition.competitors);
  const home = pickEspnCompetitor(competitors, 'home', 0);
  const away = pickEspnCompetitor(competitors, 'away', 1);
  const homeTeam = home && isRecord(home.team) ? home.team : null;
  const awayTeam = away && isRecord(away.team) ? away.team : null;
  const status = isRecord(competition.status) ? competition.status : null;
  const statusType = status && isRecord(status.type) ? status.type : null;
  const venue = isRecord(competition.venue)
    ? competition.venue
    : asArray(competition.venues)[0];
  const venueAddress = venue && isRecord(venue.address) ? venue.address : null;
  const week = isRecord(raw.week) ? raw.week : null;
  const seasonType = isRecord(raw.seasonType) ? raw.seasonType : null;
  const timestamp = toOptionalString(competition.date) || toOptionalString(raw.date);
  const eventId = toOptionalString(raw.id);
  if (!eventId || !timestamp) return null;

  return {
    idEvent: eventId,
    idLeague: spec.id,
    strLeague: spec.name,
    strSeason: toOptionalString(raw.seasonDisplay),
    strSport: spec.sport,
    strEvent: toOptionalString(raw.name),
    strHomeTeam: toOptionalString(homeTeam?.displayName) || toOptionalString(homeTeam?.shortDisplayName),
    strAwayTeam: toOptionalString(awayTeam?.displayName) || toOptionalString(awayTeam?.shortDisplayName),
    strHomeBadge: extractEspnTeamLogo(homeTeam),
    strAwayBadge: extractEspnTeamLogo(awayTeam),
    strStatus: toOptionalString(statusType?.description),
    strProgress: toOptionalString(statusType?.detail) || toOptionalString(statusType?.shortDetail),
    strVenue: toOptionalString(venue?.fullName),
    strCity: toOptionalString(venueAddress?.city),
    strCountry: toOptionalString(venueAddress?.country) || spec.country,
    strRound: toOptionalString(week?.text) || toOptionalString(seasonType?.name),
    strTimestamp: timestamp,
    dateEvent: timestamp.slice(0, 10),
    strTime: timestamp.includes('T') ? timestamp.split('T')[1] : undefined,
    intHomeScore: toOptionalString(home?.score),
    intAwayScore: toOptionalString(away?.score),
    lat: readFirstNumber(venue || {}, ['latitude', 'lat']),
    lng: readFirstNumber(venue || {}, ['longitude', 'lng', 'lon']),
  };
}

function pickEspnRecentOrLiveEvent(events: SportsEvent[]): SportsEvent | null {
  return pickEspnRecentEvents(events, 1)[0] ?? null;
}

function pickEspnRecentEvents(events: SportsEvent[], limit = 3): SportsEvent[] {
  const active = events.filter((event) => {
    const status = (event.strStatus || '').toLowerCase();
    return status.includes('final') || status.includes('live') || status.includes('extra') || status.includes('full time');
  });
  return sortEventsDescending(active).slice(0, limit);
}

function pickEspnUpcomingEvents(events: SportsEvent[], limit?: number): SportsEvent[] {
  const sorted = sortEventsAscending(events);
  return limit ? sorted.slice(0, limit) : sorted;
}

function mapEspnCompetitionEventsFromPayload(spec: EspnCompetitionSpec, payload: Record<string, unknown>): SportsEvent[] {
  const leagues = asArray(payload.leagues);
  const season = isRecord(leagues[0]?.season) ? leagues[0]?.season : null;
  const seasonLabel = toOptionalString(season?.displayName) || toOptionalString(season?.year);
  return asArray(payload.events)
    .map((event) => mapEspnScoreboardEvent(spec, { ...event, seasonDisplay: seasonLabel }))
    .filter((event): event is SportsEvent => !!event);
}

async function fetchEspnCompetitionEvents(spec: EspnCompetitionSpec, dateStr?: string): Promise<SportsEvent[]> {
  const payload = await fetchEspnSiteJson<Record<string, unknown>>(buildEspnSiteScoreboardPath(spec, dateStr), 5 * 60 * 1000);
  return mapEspnCompetitionEventsFromPayload(spec, payload);
}

async function fetchEspnEventStats(spec: EspnCompetitionSpec, event: SportsEvent): Promise<SportsEventStat[]> {
  const payload = await fetchEspnSiteJson<Record<string, unknown>>(buildEspnSiteSummaryPath(spec, event.idEvent), 2 * 60 * 1000);
  const boxscore = isRecord(payload.boxscore) ? payload.boxscore : null;
  const teams = boxscore ? asArray(boxscore.teams) : [];
  const home = teams.find((team) => toOptionalString(team.homeAway) === 'home') || teams[0];
  const away = teams.find((team) => toOptionalString(team.homeAway) === 'away') || teams[1];
  const homeStats = asArray(home?.statistics);
  const awayStats = asArray(away?.statistics);

  if (!homeStats.length || !awayStats.length) {
    return buildFallbackStats(event);
  }

  const byName = new Map<string, Record<string, unknown>>();
  for (const stat of awayStats) {
    const name = toOptionalString(stat.name);
    if (name) byName.set(name, stat);
  }

  const stats: SportsEventStat[] = [];
  for (const homeStat of homeStats) {
    const name = toOptionalString(homeStat.name);
    if (!name) continue;
    const awayStat = byName.get(name);
    if (!awayStat) continue;
    const homeValue = toOptionalString(homeStat.displayValue);
    const awayValue = toOptionalString(awayStat.displayValue);
    if (!homeValue && !awayValue) continue;
    stats.push({
      label: toOptionalString(homeStat.label) || toOptionalString(homeStat.abbreviation) || name,
      homeValue,
      awayValue,
    });
    if (stats.length >= 6) break;
  }

  return stats.length ? stats : buildFallbackStats(event);
}

export async function fetchAllSportsLeagues(): Promise<SportsLeagueOption[]> {
  const payload = await fetchSportsDbJson<{ leagues?: unknown }>('/all_leagues.php', 6 * 60 * 60 * 1000);
  return asArray(payload.leagues)
    .map(mapLeagueOption)
    .filter((league): league is SportsLeagueOption => !!league)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchMajorTournamentLeagueOptions(): Promise<SportsLeagueOption[]> {
  return ESPN_MAJOR_TOURNAMENTS.map(mapEspnCompetitionOption);
}

export async function fetchMotorsportLeagueOptions(): Promise<SportsLeagueOption[]> {
  return resolveFeaturedLeagueOptions(MOTORSPORT_SPECS);
}

export async function fetchSportsLeagueDetails(leagueId: string): Promise<SportsLeagueDetails | null> {
  const payload = await fetchSportsDbJson<{ leagues?: unknown }>(`/lookupleague.php?id=${leagueId}`, 60 * 60 * 1000);
  return asArray(payload.leagues)
    .map(mapLeagueDetails)
    .find((league): league is SportsLeagueDetails => !!league) || null;
}

export async function fetchSportsLeagueSeasons(leagueId: string): Promise<string[]> {
  const payload = await fetchSportsDbJson<{ seasons?: unknown }>(`/search_all_seasons.php?id=${leagueId}`, 60 * 60 * 1000);
  const seasons = asArray(payload.seasons)
    .map((season) => toOptionalString(season.strSeason))
    .filter((season): season is string => !!season);
  return sortSeasonsDescending(uniqueStrings(seasons));
}

async function fetchLeagueTableData(league: SportsLeague, season?: string): Promise<SportsTableGroup | null> {
  const seasonQuery = season ? `&s=${encodeURIComponent(season)}` : '';
  const payload = await fetchSportsDbJson<{ table?: unknown }>(`/lookuptable.php?l=${league.id}${seasonQuery}`, 10 * 60 * 1000);
  const rawRows = asArray(payload.table);
  const rows = rawRows
    .map(mapStandingRow)
    .filter((row) => row.rank > 0)
    .sort((a, b) => a.rank - b.rank);

  if (!rows.length) return null;

  return {
    league,
    season: rows[0]?.season || season,
    updatedAt: toOptionalString(rawRows[0]?.dateUpdated),
    rows,
  };
}

async function fetchLeagueRecentEvents(leagueId: string, limit = 5): Promise<SportsEvent[]> {
  const payload = await fetchSportsDbJson<{ results?: unknown }>(`/eventslast.php?id=${leagueId}`, 10 * 60 * 1000);
  return sortEventsDescending(asArray(payload.results).map(mapEvent))
    .filter((event) => event.idEvent)
    .slice(0, limit);
}

async function fetchLeagueUpcomingEvents(leagueId: string, limit = 5): Promise<SportsEvent[]> {
  const payload = await fetchSportsDbJson<{ events?: unknown; results?: unknown }>(`/eventsnext.php?id=${leagueId}`, 5 * 60 * 1000);
  const rawEvents = asArray(payload.events).length ? asArray(payload.events) : asArray(payload.results);
  return sortEventsAscending(rawEvents.map(mapEvent))
    .filter((event) => event.idEvent)
    .slice(0, limit);
}

async function fetchSportsDbDailyEventsForSport(sport: string, targetDate: Date): Promise<SportsEvent[]> {
  const targetDateStr = formatLocalCalendarDate(targetDate);
  const payloads = await Promise.all(
    buildLocalSportsDateWindow(targetDate).map((dateStr) =>
      fetchSportsDbJson<{ events?: unknown }>(`/eventsday.php?d=${dateStr}&s=${encodeURIComponent(sport)}`, 5 * 60 * 1000)
        .catch(() => ({ events: [] }))
    ),
  );

  const events = payloads
    .flatMap((payload) => asArray(payload.events))
    .map(mapEvent)
    .filter((event) => event.idEvent);

  return filterEventsToLocalCalendarDate(events, targetDateStr);
}

async function fetchEspnCompetitionDailyEvents(spec: EspnCompetitionSpec, targetDate: Date): Promise<SportsEvent[]> {
  const targetDateStr = formatLocalCalendarDate(targetDate);
  const [datedEvents, genericEvents] = await Promise.all([
    fetchEspnCompetitionEvents(spec, targetDateStr).catch(() => []),
    fetchEspnCompetitionEvents(spec).catch(() => []),
  ]);

  return filterEventsToLocalCalendarDate([...datedEvents, ...genericEvents], targetDateStr);
}

async function fetchFormulaOneNextRaceSummary(): Promise<MotorsportRaceSummary | null> {
  const payload = await fetchJolpicaJson<Record<string, unknown>>('/ergast/f1/current/next.json', 30 * 60 * 1000).catch(() => null);
  const mrData = payload && isRecord(payload.MRData) ? payload.MRData : null;
  const raceTable = mrData && isRecord(mrData.RaceTable) ? mrData.RaceTable : null;
  return mapMotorsportRaceSummary(asArray(raceTable?.Races)[0] || {});
}

function mapMotorsportRaceToSportsEvent(race: MotorsportRaceSummary | null): SportsEvent | null {
  if (!race) return null;
  const timestamp = race.time ? `${race.date}T${race.time}` : `${race.date}T00:00:00Z`;
  return {
    idEvent: `jolpica-f1-${race.round}`,
    idLeague: 'formula1',
    strLeague: 'Formula 1',
    strSeason: undefined,
    strSport: 'Motorsport',
    strEvent: race.raceName,
    strVenue: race.circuitName || race.raceName,
    strCity: race.locality,
    strCountry: race.country,
    strRound: race.round,
    strTimestamp: timestamp,
    dateEvent: race.date,
    strTime: race.time,
    lat: race.lat,
    lng: race.lng,
  };
}

async function fetchDailyMotorsportSupplementGroups(targetDate: Date): Promise<SportsFixtureGroup[]> {
  const targetDateStr = formatLocalCalendarDate(targetDate);
  const nextRaceEvent = mapMotorsportRaceToSportsEvent(await fetchFormulaOneNextRaceSummary());
  if (!nextRaceEvent || !isEventOnLocalCalendarDate(nextRaceEvent, targetDateStr)) return [];
  return [{
    league: {
      id: 'formula1',
      sport: 'Motorsport',
      name: 'Formula 1',
      shortName: 'F1',
      country: nextRaceEvent.strCountry,
    },
    events: [nextRaceEvent],
  }];
}

function mergeSportsFixtureGroup(
  groupsByLeague: Map<string, SportsFixtureGroup>,
  league: SportsLeague,
  event: SportsEvent,
): void {
  const storageKey = buildSportsFixtureGroupKey(event.strLeague || league.name, event.strSport || league.sport, league.id);
  let group = groupsByLeague.get(storageKey);
  if (!group) {
    group = {
      league: {
        ...league,
        name: event.strLeague || league.name,
        sport: event.strSport || league.sport,
        country: event.strCountry || league.country,
      },
      events: [],
    };
    groupsByLeague.set(storageKey, group);
  }

  const shapeKey = buildSportsEventShapeKey(event);
  if (group.events.some((existing) => existing.idEvent === event.idEvent || buildSportsEventShapeKey(existing) === shapeKey)) return;
  group.events.push(event);
}

async function fetchEspnFixtureFallbackGroups(): Promise<SportsFixtureGroup[]> {
  const responses = await Promise.all(
    ESPN_FIXTURE_COMPETITIONS.map(async (spec) => {
      const league = mapEspnCompetitionLeague(spec);
      const events = pickEspnUpcomingEvents(await fetchEspnCompetitionEvents(spec).catch(() => []));
      return { league, events } satisfies SportsFixtureGroup;
    }),
  );

  return responses.filter((group) => group.events.length > 0);
}

export async function fetchFeaturedSportsFixtures(): Promise<SportsFixtureGroup[]> {
  const targetDate = new Date();
  const theSportsDbSports = ['Soccer', 'Motorsport', 'Tennis', 'Cricket'];
  const tsdbPromises = theSportsDbSports.map((sport) => fetchSportsDbDailyEventsForSport(sport, targetDate));

  const espnPromises = ESPN_FIXTURE_COMPETITIONS.map(async (spec) => {
    const league = mapEspnCompetitionLeague(spec);
    const events = pickEspnUpcomingEvents(await fetchEspnCompetitionDailyEvents(spec, targetDate).catch(() => []));
    return { league, events } satisfies SportsFixtureGroup;
  });

  const [tsdbEventBuckets, espnResponses, motorsportSupplementGroups] = await Promise.all([
    Promise.all(tsdbPromises),
    Promise.all(espnPromises),
    fetchDailyMotorsportSupplementGroups(targetDate).catch(() => []),
  ]);

  const groupsByLeague = new Map<string, SportsFixtureGroup>();

  for (const group of espnResponses) {
    group.events.forEach((event) => mergeSportsFixtureGroup(groupsByLeague, group.league, event));
  }

  for (const event of tsdbEventBuckets.flat()) {
    if (!event.idLeague || !event.strLeague || !event.strSport) continue;
    mergeSportsFixtureGroup(groupsByLeague, {
      id: `tsdb-${event.idLeague}`,
      sport: event.strSport,
      name: event.strLeague,
      shortName: buildLeagueShortName(event.strLeague),
      country: event.strCountry,
    }, event);
  }

  for (const group of motorsportSupplementGroups) {
    group.events.forEach((event) => mergeSportsFixtureGroup(groupsByLeague, group.league, event));
  }

  const groups = Array.from(groupsByLeague.values())
    .map((group) => ({
      ...group,
      events: pickEspnUpcomingEvents(dedupeSportsEvents(group.events)),
    }))
    .filter((group) => group.events.length > 0);

  return groups.sort((a, b) => {
    const sportDiff = (SPORTS_FIXTURE_SPORT_PRIORITY.get(a.league.sport) ?? 9) - (SPORTS_FIXTURE_SPORT_PRIORITY.get(b.league.sport) ?? 9);
    if (sportDiff !== 0) return sportDiff;
    const timeDiff = parseEventTimestamp(a.events[0] || {}) - parseEventTimestamp(b.events[0] || {});
    if (timeDiff !== 0) return timeDiff;
    return a.league.name.localeCompare(b.league.name);
  });
}

export async function searchFeaturedSportsFixtures(query: string, limit = 20): Promise<SportsFixtureSearchMatch[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];
  const maxResults = Math.min(Math.max(limit, 1), 30);

  const [featuredGroups, fallbackGroups] = await Promise.all([
    fetchFeaturedSportsFixtures().catch(() => []),
    fetchEspnFixtureFallbackGroups().catch(() => []),
  ]);

  const seen = new Set<string>();
  const scored: Array<{ league: SportsLeague; event: SportsEvent; score: number }> = [];
  const candidates = [...featuredGroups, ...fallbackGroups]
    .flatMap((group) => group.events.map((event) => ({ league: group.league, event })));

  for (const candidate of candidates) {
    const key = candidate.event.idEvent || buildSportsEventShapeKey(candidate.event);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const score = scoreSportsFixtureSearchMatch(trimmedQuery, candidate.league, candidate.event);
    if (score <= 0) continue;
    scored.push({ ...candidate, score });
  }

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const liveDiff = Number(isLikelyLiveSportsEvent(b.event)) - Number(isLikelyLiveSportsEvent(a.event));
      if (liveDiff !== 0) return liveDiff;
      return parseEventTimestamp(a.event) - parseEventTimestamp(b.event);
    })
    .slice(0, maxResults)
    .map(({ league, event }) => ({ league, event }));
}

async function buildSportsFixtureMapMarkers(groups: SportsFixtureGroup[]): Promise<SportsFixtureMapMarker[]> {
  const candidates = pickSportsFixtureCandidates(groups);
  const markers: Array<SportsFixtureMapMarker | null> = await Promise.all(
    candidates.map(async ({ league, event }) => {
      const venue = await resolveEventVenueProfile(event, league);
      if (venue?.lat === undefined || venue.lng === undefined) return null;

      return {
        id: `sports-fixture:${event.idEvent}`,
        eventId: event.idEvent,
        leagueId: event.idLeague || league.id,
        leagueName: event.strLeague || league.name,
        leagueShortName: league.shortName,
        sport: event.strSport || league.sport,
        title: event.strEvent || [event.strHomeTeam, event.strAwayTeam].filter(Boolean).join(' vs ') || league.name,
        homeTeam: event.strHomeTeam,
        awayTeam: event.strAwayTeam,
        homeBadge: event.strHomeBadge,
        awayBadge: event.strAwayBadge,
        venue: venue.name,
        venueCity: venue.city || event.strCity,
        venueCountry: venue.country || event.strCountry || league.country,
        venueCapacity: venue.capacity,
        venueSurface: venue.surface,
        round: event.strRound,
        season: event.strSeason,
        startTime: event.strTimestamp || (event.dateEvent ? `${event.dateEvent}T${event.strTime || '00:00:00'}` : undefined),
        startLabel: formatSportsFixtureStartLabel(event),
        lat: venue.lat,
        lng: venue.lng,
      } satisfies SportsFixtureMapMarker;
    }),
  );

  return markers.filter((marker): marker is SportsFixtureMapMarker => !!marker);
}

function sortSportsFixtureMapMarkers(markers: SportsFixtureMapMarker[]): SportsFixtureMapMarker[] {
  return markers
    .slice()
    .sort((a, b) => {
      const aTime = a.startTime ? Date.parse(a.startTime) : Number.MAX_SAFE_INTEGER;
      const bTime = b.startTime ? Date.parse(b.startTime) : Number.MAX_SAFE_INTEGER;
      return (Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER) - (Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER);
    });
}

function buildSportsFixtureLeagueHubs(markers: SportsFixtureMapMarker[]): SportsFixtureMapMarker[] {
  const grouped = new Map<string, SportsFixtureMapMarker[]>();

  for (const marker of sortSportsFixtureMapMarkers(markers)) {
    const key = buildSportsFixtureGroupKey(marker.leagueName, marker.sport, marker.leagueId || marker.leagueName);
    const group = grouped.get(key);
    if (group) group.push(marker);
    else grouped.set(key, [marker]);
  }

  return sortSportsFixtureMapMarkers(
    Array.from(grouped.values())
      .map((group) => {
        const first = group[0]!;
        const fixtureCount = group.reduce((sum, item) => sum + countSportsFixtures(item), 0);
        const isMultiFixtureLeague = fixtureCount > 1;
        return buildSportsFixtureAggregateMarker(group, {
          id: `sports-fixture-league:${first.leagueId || normalizeLeagueLookup(first.leagueName) || first.eventId}`,
          eventId: first.eventId,
          leagueId: first.leagueId,
          leagueName: first.leagueName,
          leagueShortName: first.leagueShortName,
          sport: first.sport,
          title: isMultiFixtureLeague
            ? `${first.leagueShortName || first.leagueName} · ${fixtureCount} fixtures`
            : first.title,
          fixtureCount,
          competitionCount: 1,
          sports: [first.sport],
        });
      })
      .filter((marker) => marker.fixtureCount && marker.fixtureCount > 0),
  );
}

export async function fetchSportsFixtureMapMarkers(): Promise<SportsFixtureMapMarker[]> {
  const primaryMarkers = buildSportsFixtureLeagueHubs(await buildSportsFixtureMapMarkers(await fetchFeaturedSportsFixtures()));
  if (primaryMarkers.length > 0) {
    return primaryMarkers;
  }

  const fallbackMarkers = buildSportsFixtureLeagueHubs(await buildSportsFixtureMapMarkers(await fetchEspnFixtureFallbackGroups()));
  return fallbackMarkers;
}

export async function fetchFeaturedSportsTables(): Promise<SportsTableGroup[]> {
  const responses = await Promise.all(
    FEATURED_TABLE_LEAGUES.map(async (league) => {
      const table = await fetchLeagueTableData(league);
      if (!table) return null;
      return {
        ...table,
        rows: table.rows.slice(0, 5),
      };
    }),
  );

  return responses.filter((group): group is SportsTableGroup => !!group && group.rows.length > 0);
}

function mapLeagueOptionToLeague(option: SportsLeagueOption): SportsLeague {
  return {
    id: option.id,
    sport: option.sport,
    name: option.name,
    shortName: option.shortName,
  };
}

export async function fetchEuropeanFootballTopLeagueTables(): Promise<SportsTableGroup[]> {
  const leagues = await resolveFeaturedLeagueOptions(EUROPEAN_TOP_FOOTBALL_SPECS);
  const responses = await Promise.all(
    leagues.map(async (option) => {
      const league = mapLeagueOptionToLeague(option);
      return fetchLeagueTableData(league).catch(() => null);
    }),
  );

  return responses.filter((table): table is SportsTableGroup => !!table && table.rows.length > 0);
}

async function fetchEventStats(eventId: string): Promise<SportsEventStat[]> {
  const payload = await fetchSportsDbJson<{ eventstats?: unknown }>(`/lookupeventstats.php?id=${eventId}`, 10 * 60 * 1000);
  return asArray(payload.eventstats)
    .map((stat) => ({
      label: String(stat.strStat ?? ''),
      homeValue: stat.intHome ? String(stat.intHome) : undefined,
      awayValue: stat.intAway ? String(stat.intAway) : undefined,
    }))
    .filter((stat) => stat.label && (stat.homeValue || stat.awayValue))
    .slice(0, 4);
}

async function fetchSportsDbEventById(eventId: string): Promise<SportsEvent | null> {
  const payload = await fetchSportsDbJson<{ events?: unknown }>(`/lookupevent.php?id=${encodeURIComponent(eventId)}`, 2 * 60 * 1000);
  return asArray(payload.events)
    .map(mapEvent)
    .find((event) => event.idEvent === eventId) || null;
}

function buildFallbackStats(event: SportsEvent): SportsEventStat[] {
  const stats: SportsEventStat[] = [];
  if (event.intHomeScore || event.intAwayScore) {
    stats.push({
      label: 'Score',
      homeValue: event.intHomeScore ?? '-',
      awayValue: event.intAwayScore ?? '-',
    });
  }
  if (event.strRound) {
    stats.push({
      label: 'Round',
      homeValue: event.strRound,
      awayValue: event.strSeason ?? '',
    });
  }
  if (event.strStatus || event.strProgress) {
    stats.push({
      label: 'Status',
      homeValue: event.strStatus ?? 'Final',
      awayValue: event.strProgress ?? '',
    });
  }

  if (stats.length === 0) {
    stats.push({
      label: 'Status',
      homeValue: event.strStatus || 'Scheduled',
      awayValue: event.strProgress || formatSportsFixtureStartLabel(event),
    });
  }

  return stats;
}

export async function fetchSportsFixtureSnapshot(eventId: string, leagueId?: string, leagueName?: string): Promise<SportsStatSnapshot | null> {
  const trimmedEventId = eventId.trim();
  if (!trimmedEventId) return null;
  const cacheKey = `sports-fixture-snapshot:${leagueId || ''}:${trimmedEventId}`;
  const cached = getCached<SportsStatSnapshot>(cacheKey);
  if (cached) return cached;

  const spec = resolveEspnCompetitionSpec(leagueId, leagueName);
  if (spec) {
    const targetDate = formatLocalCalendarDate(new Date());
    const [datedEvents, genericEvents] = await Promise.all([
      fetchEspnCompetitionEvents(spec, targetDate).catch(() => []),
      fetchEspnCompetitionEvents(spec).catch(() => []),
    ]);
    const event = dedupeSportsEvents([...datedEvents, ...genericEvents])
      .find((candidate) => candidate.idEvent === trimmedEventId);

    if (event) {
      let stats = await fetchEspnEventStats(spec, event).catch(() => []);
      if (stats.length === 0) stats = buildFallbackStats(event);
      if (stats.length > 0) {
        const snapshot: SportsStatSnapshot = {
          league: mapEspnCompetitionLeague(spec),
          event,
          stats,
        };
        return setCached(cacheKey, snapshot, 90 * 1000);
      }
    }
  }

  const event = await fetchSportsDbEventById(trimmedEventId).catch(() => null);
  if (!event) return null;

  let stats = await fetchEventStats(trimmedEventId).catch(() => []);
  if (stats.length === 0) stats = buildFallbackStats(event);
  if (stats.length === 0) return null;

  const resolvedLeagueName = event.strLeague || leagueName || spec?.name || 'Sports';
  const snapshot: SportsStatSnapshot = {
    league: {
      id: event.idLeague || leagueId || spec?.id || `event:${trimmedEventId}`,
      sport: event.strSport || spec?.sport || 'Sports',
      name: resolvedLeagueName,
      shortName: spec?.shortName || buildLeagueShortName(resolvedLeagueName),
      country: event.strCountry || spec?.country,
    },
    event,
    stats,
  };
  return setCached(cacheKey, snapshot, 90 * 1000);
}

export async function fetchFeaturedSportsStats(): Promise<SportsStatSnapshot[]> {
  const snapshots = await Promise.all(
    ESPN_STATS_COMPETITIONS.map(async (spec) => {
      const league = mapEspnCompetitionLeague(spec);
      const event = pickEspnRecentOrLiveEvent(await fetchEspnCompetitionEvents(spec).catch(() => []));
      if (!event) return null;

      const stats = await fetchEspnEventStats(spec, event).catch(() => buildFallbackStats(event));

      return {
        league,
        event,
        stats,
      } satisfies SportsStatSnapshot;
    }),
  );

  return snapshots.filter((snapshot): snapshot is SportsStatSnapshot => !!snapshot && snapshot.stats.length > 0);
}

export async function fetchMajorTournamentCenterData(tournamentId: string): Promise<SportsLeagueCenterData | null> {
  const spec = ESPN_MAJOR_TOURNAMENTS.find((entry) => entry.id === tournamentId);
  if (!spec) return null;

  const rawPayload = await fetchEspnSiteJson<Record<string, unknown>>(buildEspnSiteScoreboardPath(spec), 5 * 60 * 1000);
  const events = mapEspnCompetitionEventsFromPayload(spec, rawPayload);
  const recentEvents = pickEspnRecentEvents(events, 5);
  const recentEvent = recentEvents[0] || null;
  const upcomingEvents = pickEspnUpcomingEvents(events, 5);
  const leagues = asArray(rawPayload.leagues);
  const season = isRecord(leagues[0]?.season) ? leagues[0]?.season : null;
  const seasonLabel = toOptionalString(season?.displayName) || toOptionalString(season?.year);
  const statSnapshot = recentEvent
    ? {
      league: mapEspnCompetitionLeague(spec),
      event: recentEvent,
      stats: await fetchEspnEventStats(spec, recentEvent).catch(() => buildFallbackStats(recentEvent)),
    } satisfies SportsStatSnapshot
    : null;

  return {
    league: mapEspnCompetitionDetails(spec, seasonLabel),
    seasons: seasonLabel ? [seasonLabel] : [],
    selectedSeason: seasonLabel,
    table: null,
    tableAvailable: false,
    recentEvents,
    upcomingEvents,
    statSnapshot: statSnapshot && statSnapshot.stats.length > 0 ? statSnapshot : null,
  };
}

function mapSportsPlayerSearchResult(raw: Record<string, unknown>): SportsPlayerSearchResult | null {
  const id = toOptionalString(raw.idPlayer);
  const name = toOptionalString(raw.strPlayer);
  if (!id || !name) return null;

  return {
    id,
    name,
    alternateName: toOptionalString(raw.strPlayerAlternate),
    sport: toOptionalString(raw.strSport),
    team: toOptionalString(raw.strTeam),
    secondaryTeam: toOptionalString(raw.strTeam2),
    nationality: toOptionalString(raw.strNationality),
    position: toOptionalString(raw.strPosition),
    status: toOptionalString(raw.strStatus),
    number: toOptionalString(raw.strNumber),
    thumb: toOptionalString(raw.strThumb),
    cutout: toOptionalString(raw.strCutout),
  };
}

function mapSportsPlayerDetails(raw: Record<string, unknown>): SportsPlayerDetails | null {
  const base = mapSportsPlayerSearchResult(raw);
  if (!base) return null;

  return {
    ...base,
    banner: toOptionalString(raw.strBanner),
    fanart: uniqueStrings([
      toOptionalString(raw.strFanart1),
      toOptionalString(raw.strFanart2),
      toOptionalString(raw.strFanart3),
      toOptionalString(raw.strFanart4),
    ])[0],
    birthDate: toOptionalString(raw.dateBorn),
    birthLocation: toOptionalString(raw.strBirthLocation),
    description: toOptionalString(raw.strDescriptionEN),
    height: toOptionalString(raw.strHeight),
    weight: toOptionalString(raw.strWeight),
    gender: toOptionalString(raw.strGender),
    handedness: toOptionalString(raw.strSide),
    signedDate: toOptionalString(raw.dateSigned),
    signing: toOptionalString(raw.strSigning),
    agent: toOptionalString(raw.strAgent),
    outfitter: toOptionalString(raw.strOutfitter),
    kit: toOptionalString(raw.strKit),
    website: toOptionalString(raw.strWebsite),
    facebook: toOptionalString(raw.strFacebook),
    twitter: toOptionalString(raw.strTwitter),
    instagram: toOptionalString(raw.strInstagram),
    youtube: toOptionalString(raw.strYoutube),
  };
}

function scoreSportsPlayerSearchResult(player: SportsPlayerSearchResult, query: string): number {
  const normalizedQuery = normalizeLeagueLookup(query);
  const exactName = normalizeLeagueLookup(player.name);
  const alternateName = normalizeLeagueLookup(player.alternateName);
  const team = normalizeLeagueLookup(player.team);
  let score = 0;

  if (exactName === normalizedQuery || alternateName === normalizedQuery) score += 120;
  else if (exactName.startsWith(normalizedQuery) || alternateName.startsWith(normalizedQuery)) score += 80;
  else if (exactName.includes(normalizedQuery) || alternateName.includes(normalizedQuery)) score += 60;

  if (team && normalizedQuery && team.includes(normalizedQuery)) score += 20;
  if ((player.status || '').toLowerCase() === 'active') score += 15;
  if (player.team) score += 5;
  if (player.thumb || player.cutout) score += 3;
  return score;
}

export async function fetchSportsPlayerSearch(query: string): Promise<SportsPlayerSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const payload = await fetchSportsDbJson<{ player?: unknown; player_contracts?: unknown; player_honours?: unknown; players?: unknown }>(
    `/searchplayers.php?p=${encodeURIComponent(trimmedQuery)}`,
    30 * 60 * 1000,
  );
  const rawPlayers = asArray(payload.player).length
    ? asArray(payload.player)
    : asArray(payload.players);

  return rawPlayers
    .map(mapSportsPlayerSearchResult)
    .filter((player): player is SportsPlayerSearchResult => !!player)
    .sort((a, b) => scoreSportsPlayerSearchResult(b, trimmedQuery) - scoreSportsPlayerSearchResult(a, trimmedQuery) || a.name.localeCompare(b.name))
    .slice(0, 8);
}

export async function fetchSportsPlayerDetails(playerId: string): Promise<SportsPlayerDetails | null> {
  const trimmedId = playerId.trim();
  if (!trimmedId) return null;

  const payload = await fetchSportsDbJson<{ players?: unknown }>(`/lookupplayer.php?id=${encodeURIComponent(trimmedId)}`, 60 * 60 * 1000);
  return asArray(payload.players)
    .map(mapSportsPlayerDetails)
    .find((player): player is SportsPlayerDetails => !!player) || null;
}

export async function fetchLeagueCenterData(leagueId: string, season?: string): Promise<SportsLeagueCenterData | null> {
  const details = await fetchSportsLeagueDetails(leagueId);
  if (!details) return null;

  const [seasons, recentEvents, upcomingEvents] = await Promise.all([
    fetchSportsLeagueSeasons(leagueId).catch(() => []),
    fetchLeagueRecentEvents(leagueId, 5).catch(() => []),
    fetchLeagueUpcomingEvents(leagueId, 5).catch(() => []),
  ]);

  const selectedSeason = resolveSelectedSeason(season, seasons, details.currentSeason);

  let table: SportsTableGroup | null = null;
  try {
    table = await fetchLeagueTableData(details, selectedSeason);
  } catch {
    table = null;
  }

  if (!table && seasons.length > 0) {
    const fallbackSeason = seasons[0];
    if (fallbackSeason && fallbackSeason !== selectedSeason) {
      try {
        table = await fetchLeagueTableData(details, fallbackSeason);
      } catch {
        table = null;
      }
    }
  }

  if (!table && selectedSeason) {
    try {
      table = await fetchLeagueTableData(details);
    } catch {
      table = null;
    }
  }

  let statSnapshot: SportsStatSnapshot | null = null;
  const recentEvent = recentEvents[0];
  if (recentEvent) {
    let stats: SportsEventStat[] = [];
    try {
      stats = await fetchEventStats(recentEvent.idEvent);
    } catch {
      stats = [];
    }
    if (stats.length === 0) {
      stats = buildFallbackStats(recentEvent);
    }
    if (stats.length > 0) {
      statSnapshot = {
        league: details,
        event: recentEvent,
        stats,
      };
    }
  }

  return {
    league: {
      ...details,
      tableSupported: table ? true : details.tableSupported,
    },
    seasons,
    selectedSeason,
    table,
    tableAvailable: !!table,
    recentEvents,
    upcomingEvents,
    statSnapshot,
  };
}

export async function fetchSportsFixturePopupContext(marker: SportsFixtureMapMarker): Promise<SportsFixturePopupContext> {
  const cacheKey = `sports-fixture-popup:${marker.eventId}`;
  const cached = getCached<SportsFixturePopupContext>(cacheKey);
  if (cached) return cached;

  const request = (async () => {
    const weatherPromise = fetchWeatherAlerts().catch(() => []);

    if (marker.sport === 'Soccer' && marker.leagueId) {
      const [center, alerts] = await Promise.all([
        fetchLeagueCenterData(marker.leagueId).catch(() => null),
        weatherPromise,
      ]);

      const rows = center?.table?.rows ?? [];
      const homeRow = findStandingRowByTeam(rows, marker.homeTeam) as SportsStandingRow | null;
      const awayRow = findStandingRowByTeam(rows, marker.awayTeam) as SportsStandingRow | null;
      const lastMeeting = (center?.recentEvents ?? []).find((event) => event.idEvent !== marker.eventId && isSameFixturePair(event, marker.homeTeam, marker.awayTeam)) || null;
      const stats: SportsFixtureInsightStat[] = [];

      if (homeRow && awayRow) {
        stats.push({
          label: 'Table',
          value: `${marker.homeTeam || 'Home'} #${homeRow.rank} (${homeRow.points} pts) vs ${marker.awayTeam || 'Away'} #${awayRow.rank} (${awayRow.points} pts)`,
        });
        stats.push({
          label: 'Goal Diff',
          value: `${homeRow.goalDifference >= 0 ? '+' : ''}${homeRow.goalDifference} vs ${awayRow.goalDifference >= 0 ? '+' : ''}${awayRow.goalDifference}`,
        });
        if (homeRow.form || awayRow.form) {
          stats.push({
            label: 'Form',
            value: `${homeRow.form || '—'} vs ${awayRow.form || '—'}`,
          });
        }
      }

      if (lastMeeting) {
        stats.push({
          label: 'Last Meeting',
          value: formatLastMeeting(lastMeeting),
        });
      }

      return setCached(cacheKey, {
        prediction: buildFootballPrediction(marker, homeRow, awayRow),
        weather: summarizeFixtureWeather(marker, alerts),
        story: buildFootballStory(homeRow, awayRow, lastMeeting),
        stats,
      }, 10 * 60 * 1000);
    }

    if (marker.sport === 'Basketball') {
      const [standings, center, alerts] = await Promise.all([
        fetchNbaStandingsData().catch(() => null),
        marker.leagueId ? fetchLeagueCenterData(marker.leagueId).catch(() => null) : Promise.resolve(null),
        weatherPromise,
      ]);

      const rows = standings?.groups.flatMap((group) => group.rows) ?? [];
      const homeRow = findStandingRowByTeam(rows, marker.homeTeam) as NbaStandingRow | null;
      const awayRow = findStandingRowByTeam(rows, marker.awayTeam) as NbaStandingRow | null;
      const lastMeeting = (center?.recentEvents ?? []).find((event) => event.idEvent !== marker.eventId && isSameFixturePair(event, marker.homeTeam, marker.awayTeam)) || null;
      const stats: SportsFixtureInsightStat[] = [];

      if (homeRow && awayRow) {
        stats.push({
          label: 'Record',
          value: `${homeRow.team} ${homeRow.wins}-${homeRow.losses} vs ${awayRow.team} ${awayRow.wins}-${awayRow.losses}`,
        });
        stats.push({
          label: 'Last 10',
          value: `${homeRow.lastTen} vs ${awayRow.lastTen}`,
        });
        stats.push({
          label: 'Differential',
          value: `${homeRow.differential} vs ${awayRow.differential}`,
        });
      }

      if (lastMeeting) {
        stats.push({
          label: 'Last Meeting',
          value: formatLastMeeting(lastMeeting),
        });
      }

      return setCached(cacheKey, {
        prediction: buildNbaPrediction(marker, homeRow, awayRow),
        weather: summarizeFixtureWeather(marker, alerts),
        story: buildNbaStory(homeRow, awayRow, lastMeeting),
        stats,
      }, 10 * 60 * 1000);
    }

    if (marker.sport === 'Motorsport') {
      const wantsF1Context = isFormulaOneFixture(marker);
      const [f1, alerts] = await Promise.all([
        wantsF1Context ? fetchFormulaOneStandingsData().catch(() => null) : Promise.resolve(null),
        weatherPromise,
      ]);

      const stats: SportsFixtureInsightStat[] = [];
      if (marker.round) stats.push({ label: 'Round', value: marker.round });
      if (marker.season) stats.push({ label: 'Season', value: marker.season });
      if (marker.venueSurface) stats.push({ label: 'Surface', value: marker.venueSurface });
      if (f1?.driverStandings[0]) {
        stats.push({
          label: 'Championship',
          value: `${f1.driverStandings[0].name} leads on ${f1.driverStandings[0].points} pts`,
        });
      }
      if (f1?.lastRace?.winner) {
        stats.push({
          label: 'Last Race',
          value: `${f1.lastRace.raceName}: ${f1.lastRace.winner}`,
        });
      }

      return setCached(cacheKey, {
        prediction: buildMotorsportPrediction(marker, f1),
        weather: summarizeFixtureWeather(marker, alerts),
        story: buildMotorsportStory(marker, f1),
        stats,
      }, 10 * 60 * 1000);
    }

    const [center, alerts] = await Promise.all([
      marker.leagueId ? fetchLeagueCenterData(marker.leagueId).catch(() => null) : Promise.resolve(null),
      weatherPromise,
    ]);

    const recentEvents = center?.recentEvents ?? [];
    const lastMeeting = recentEvents.find((event) => event.idEvent !== marker.eventId && isSameFixturePair(event, marker.homeTeam, marker.awayTeam)) || null;
    const latestResult = recentEvents.find((event) => event.idEvent !== marker.eventId) || null;
    const stats: SportsFixtureInsightStat[] = [];

    if (marker.round) stats.push({ label: 'Round', value: marker.round });
    if (marker.season) stats.push({ label: 'Season', value: marker.season });
    if (marker.venueSurface) stats.push({ label: 'Surface', value: marker.venueSurface });
    if (lastMeeting) {
      stats.push({
        label: 'Last Meeting',
        value: formatLastMeeting(lastMeeting),
      });
    } else if (latestResult) {
      stats.push({
        label: 'Latest Result',
        value: formatRecentFixtureEvent(latestResult),
      });
    }

    let prediction = buildGenericFixturePrediction(marker, lastMeeting);
    let story = buildGenericFixtureStory(marker, lastMeeting);

    if (marker.sport === 'Tennis') {
      prediction = buildTennisPrediction(lastMeeting);
      story = buildTennisStory(marker, lastMeeting);
    } else if (marker.sport === 'Cricket') {
      prediction = buildCricketPrediction(lastMeeting);
      story = buildCricketStory(lastMeeting);
    }

    return setCached(cacheKey, {
      prediction,
      weather: summarizeFixtureWeather(marker, alerts),
      story,
      stats,
    }, 10 * 60 * 1000);
  })();

  return request;
}

function getEspnPageStandingValue(
  stats: unknown[],
  headers: Record<string, unknown>,
  type: string,
  fallback = '—',
): string {
  const matchingHeaders = Object.values(headers)
    .filter(isRecord)
    .filter((header) => toOptionalString(header.t) === type)
    .sort((a, b) => toInteger(a.i) - toInteger(b.i));

  for (const header of matchingHeaders) {
    const index = toInteger(header.i);
    const value = toOptionalString(stats[index]);
    if (value) return value;
  }

  return fallback;
}

function normalizeEspnStandingStatKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapEspnStandingStats(stats: unknown[]): Map<string, string> {
  const mapped = new Map<string, string>();

  for (const rawStat of stats) {
    if (!isRecord(rawStat)) continue;
    const value = toOptionalString(rawStat.displayValue)
      || toOptionalString(rawStat.formatted)
      || toOptionalString(rawStat.summary)
      || toOptionalString(rawStat.value);
    if (!value) continue;

    const keys = [
      toOptionalString(rawStat.name),
      toOptionalString(rawStat.abbreviation),
      toOptionalString(rawStat.shortDisplayName),
      toOptionalString(rawStat.displayName),
      toOptionalString(rawStat.type),
    ]
      .filter((key): key is string => !!key)
      .map(normalizeEspnStandingStatKey)
      .filter((key) => key.length > 0);

    for (const key of keys) {
      if (!mapped.has(key)) mapped.set(key, value);
    }
  }

  return mapped;
}

function getEspnApiStandingValue(
  mappedStats: Map<string, string>,
  aliases: string[],
  fallback = '—',
): string {
  for (const alias of aliases) {
    const value = mappedStats.get(normalizeEspnStandingStatKey(alias));
    if (value) return value;
  }
  return fallback;
}

function mapNbaStandingEntryFromEspnApi(
  entry: Record<string, unknown>,
  conference: string,
  rank: number,
): NbaStandingRow | null {
  const team = isRecord(entry.team) ? entry.team : null;
  if (!team) return null;

  const teamName = toOptionalString(team.displayName) || toOptionalString(team.shortDisplayName) || toOptionalString(team.name);
  if (!teamName) return null;

  const mappedStats = mapEspnStandingStats(asArray(entry.stats));
  const parsedRank = toInteger(entry.position) || toInteger(getEspnApiStandingValue(mappedStats, ['rank'], String(rank))) || rank;
  const parsedSeed = toInteger(getEspnApiStandingValue(mappedStats, ['playoffseed', 'seed'], String(parsedRank))) || parsedRank;
  const clincher = getEspnApiStandingValue(mappedStats, ['clincher'], '');

  return {
    rank: parsedRank,
    seed: parsedSeed,
    team: teamName,
    abbreviation: toOptionalString(team.abbreviation) || toOptionalString(team.abbrev) || '',
    badge: extractEspnTeamLogo(team),
    wins: toInteger(getEspnApiStandingValue(mappedStats, ['wins', 'win'], '0')),
    losses: toInteger(getEspnApiStandingValue(mappedStats, ['losses', 'loss'], '0')),
    winPercent: getEspnApiStandingValue(mappedStats, ['winpercent', 'pct', 'winpct']),
    gamesBehind: getEspnApiStandingValue(mappedStats, ['gamesbehind', 'gb']),
    homeRecord: getEspnApiStandingValue(mappedStats, ['home']),
    awayRecord: getEspnApiStandingValue(mappedStats, ['road', 'away']),
    pointsFor: getEspnApiStandingValue(mappedStats, ['avgpointsfor', 'pointsforpergame', 'ppg']),
    pointsAgainst: getEspnApiStandingValue(mappedStats, ['avgpointsagainst', 'pointsagainstpergame', 'oppg']),
    differential: getEspnApiStandingValue(mappedStats, ['differential', 'pointdifferential']),
    streak: getEspnApiStandingValue(mappedStats, ['streak']),
    lastTen: getEspnApiStandingValue(mappedStats, ['lasttengames', 'last10']),
    clincher: clincher || undefined,
    conference,
  };
}

function mapNbaStandingsFromEspnSiteApi(payload: Record<string, unknown>): NbaStandingsData | null {
  const children = asArray(payload.children);
  const mappedGroups = (children.length > 0
    ? children.map((group, index) => {
      const standings = isRecord(group.standings) ? group.standings : group;
      const rows = asArray(standings.entries)
        .map((entry, entryIndex) => mapNbaStandingEntryFromEspnApi(entry, toOptionalString(group.name) || toOptionalString(group.abbreviation) || `Conference ${index + 1}`, entryIndex + 1))
        .filter((row): row is NbaStandingRow => !!row);

      return {
        name: toOptionalString(group.name) || toOptionalString(group.abbreviation) || `Conference ${index + 1}`,
        rows,
      } satisfies NbaStandingsGroup;
    })
    : (() => {
      const standings = isRecord(payload.standings) ? payload.standings : payload;
      const rows = asArray(standings.entries)
        .map((entry, index) => mapNbaStandingEntryFromEspnApi(entry, 'NBA', index + 1))
        .filter((entry): entry is NbaStandingRow => !!entry);
      return [{
        name: 'NBA',
        rows,
      } satisfies NbaStandingsGroup];
    })()
  ).filter((group) => group.rows.length > 0);

  if (!mappedGroups.length) return null;

  const season = isRecord(payload.season) ? payload.season : null;
  return {
    leagueName: toOptionalString(payload.name) || 'NBA',
    seasonDisplay: toOptionalString(season?.displayName) || toOptionalString(season?.year) || '',
    updatedAt: new Date().toISOString(),
    groups: mappedGroups,
  };
}

function extractEspnFittState(html: string): Record<string, unknown> | null {
  const match = html.match(/window\['__espnfitt__'\]=(\{.*?\});<\/script>/s);
  if (!match?.[1]) return null;

  try {
    const parsed = JSON.parse(match[1]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapNbaStandingEntryFromEspnPage(
  entry: Record<string, unknown>,
  headers: Record<string, unknown>,
  conference: string,
  rank: number,
): NbaStandingRow | null {
  const team = isRecord(entry.team) ? entry.team : null;
  if (!team) return null;

  const teamName = toOptionalString(team.displayName) || toOptionalString(team.shortDisplayName) || toOptionalString(team.name);
  if (!teamName) return null;

  const stats = Array.isArray(entry.stats) ? entry.stats : [];
  const clincher = getEspnPageStandingValue(stats, headers, 'clincher', '');

  return {
    rank,
    seed: toInteger(getEspnPageStandingValue(stats, headers, 'playoffseed', String(rank))) || rank,
    team: teamName,
    abbreviation: toOptionalString(team.abbrev) || toOptionalString(team.abbreviation) || '',
    badge: toOptionalString(team.logo),
    wins: toInteger(getEspnPageStandingValue(stats, headers, 'wins', '0')),
    losses: toInteger(getEspnPageStandingValue(stats, headers, 'losses', '0')),
    winPercent: getEspnPageStandingValue(stats, headers, 'winpercent'),
    gamesBehind: getEspnPageStandingValue(stats, headers, 'gamesbehind'),
    homeRecord: getEspnPageStandingValue(stats, headers, 'home'),
    awayRecord: getEspnPageStandingValue(stats, headers, 'road'),
    pointsFor: getEspnPageStandingValue(stats, headers, 'avgpointsfor'),
    pointsAgainst: getEspnPageStandingValue(stats, headers, 'avgpointsagainst'),
    differential: getEspnPageStandingValue(stats, headers, 'differential'),
    streak: getEspnPageStandingValue(stats, headers, 'streak'),
    lastTen: getEspnPageStandingValue(stats, headers, 'lasttengames'),
    clincher: clincher || undefined,
    conference,
  };
}

export async function fetchNbaStandingsData(): Promise<NbaStandingsData | null> {
  try {
    const payload = await fetchEspnSiteJson<Record<string, unknown>>('/basketball/nba/standings', 5 * 60 * 1000);
    const parsed = mapNbaStandingsFromEspnSiteApi(payload);
    if (parsed) return parsed;
  } catch {
    // Fall back to ESPN web page parsing if the site API is unavailable.
  }

  const html = await fetchEspnText('/nba/standings', 5 * 60 * 1000);
  const state = extractEspnFittState(html);
  if (!state) return null;

  const page = isRecord(state.page) ? state.page : null;
  const content = page && isRecord(page.content) ? page.content : null;
  const standings = content && isRecord(content.standings) ? content.standings : null;
  const groupedStandings = standings && isRecord(standings.groups) ? standings.groups : null;
  const groups = groupedStandings ? asArray(groupedStandings.groups) : [];
  const headers = groupedStandings && isRecord(groupedStandings.headers) ? groupedStandings.headers : {};
  const currentSeason = standings && isRecord(standings.currentSeason) ? standings.currentSeason : null;
  const md = standings && isRecord(standings.md) ? standings.md : null;

  const mappedGroups = groups
    .map((group) => {
      const rows = asArray(group.standings)
        .map((entry, index) => mapNbaStandingEntryFromEspnPage(entry, headers, toOptionalString(group.name) || 'Conference', index + 1))
        .filter((row): row is NbaStandingRow => !!row);

      return {
        name: toOptionalString(group.name) || 'Conference',
        rows,
      } satisfies NbaStandingsGroup;
    })
    .filter((group) => group.rows.length > 0);

  if (!mappedGroups.length) return null;

  return {
    leagueName: toOptionalString(standings?.leagueNameApi) || toOptionalString(md?.nm) || 'NBA',
    seasonDisplay: toOptionalString(currentSeason?.displayName) || toOptionalString(md?.ssn) || '',
    updatedAt: new Date().toISOString(),
    groups: mappedGroups,
  };
}

function mapMotorsportStandingRow(raw: Record<string, unknown>): MotorsportStandingRow | null {
  const driver = isRecord(raw.Driver) ? raw.Driver : null;
  const constructorEntry = isRecord(raw.Constructor) ? raw.Constructor : null;
  const constructors = Array.isArray(raw.Constructors) ? raw.Constructors.filter(isRecord) : [];

  const position = toInteger(raw.position);
  const name = driver
    ? [toOptionalString(driver.givenName), toOptionalString(driver.familyName)].filter(Boolean).join(' ')
    : toOptionalString(constructorEntry?.name);
  if (!position || !name) return null;

  return {
    rank: position,
    name,
    code: toOptionalString(driver?.code),
    team: driver ? (toOptionalString(constructorEntry?.name) || toOptionalString(constructors[0]?.name)) : undefined,
    driverNumber: toOptionalString(driver?.permanentNumber),
    points: toInteger(raw.points),
    wins: toInteger(raw.wins),
    nationality: toOptionalString(driver?.nationality) || toOptionalString(constructorEntry?.nationality),
  };
}

type OpenF1DriverRecord = {
  driverNumber?: string;
  fullName?: string;
  headshotUrl?: string;
};

const F1_TEAM_ASSETS: Array<{ aliases: string[]; path: string; color: string }> = [
  { aliases: ['mclaren'], path: '/sports/f1/teams/mclaren.svg', color: 'FF8000' },
  { aliases: ['ferrari', 'scuderia ferrari'], path: '/sports/f1/teams/ferrari.svg', color: 'DC0000' },
  { aliases: ['mercedes', 'mercedes-amg', 'mercedes amg petronas'], path: '/sports/f1/teams/mercedes.svg', color: '27F4D2' },
  { aliases: ['red bull', 'red bull racing'], path: '/sports/f1/teams/red-bull.svg', color: '3671C6' },
  { aliases: ['williams', 'williams racing'], path: '/sports/f1/teams/williams.svg', color: '64C4FF' },
  { aliases: ['aston martin', 'aston martin aramco'], path: '/sports/f1/teams/aston-martin.svg', color: '229971' },
  { aliases: ['alpine', 'bwt alpine'], path: '/sports/f1/teams/alpine.svg', color: '0093CC' },
  { aliases: ['haas', 'haas f1 team'], path: '/sports/f1/teams/haas.svg', color: 'B6BABD' },
  { aliases: ['sauber', 'kick sauber', 'stake f1 team kick sauber'], path: '/sports/f1/teams/sauber.svg', color: '52E252' },
  { aliases: ['racing bulls', 'rb f1 team', 'visa cash app rb', 'visa cash app racing bulls'], path: '/sports/f1/teams/racing-bulls.svg', color: '6692FF' },
];

function normalizeMotorsportLookup(value: string | undefined): string {
  return (value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveF1TeamAsset(teamName: string | undefined): { badge?: string; color?: string } | null {
  const normalized = normalizeMotorsportLookup(teamName);
  if (!normalized) return null;

  for (const team of F1_TEAM_ASSETS) {
    if (team.aliases.some((alias) => normalized === alias || normalized.includes(alias))) {
      return {
        badge: team.path,
        color: team.color,
      };
    }
  }

  return null;
}

function mapOpenF1DriverRecord(raw: Record<string, unknown>): OpenF1DriverRecord | null {
  const driverNumber = toOptionalString(raw.driver_number);
  const fullName = toOptionalString(raw.full_name);
  if (!driverNumber && !fullName) return null;

  return {
    driverNumber,
    fullName,
    headshotUrl: toOptionalString(raw.headshot_url),
  };
}

async function fetchOpenF1DriverAssets(): Promise<OpenF1DriverRecord[]> {
  const payload = await fetchOpenF1Json<unknown[]>('/v1/drivers?session_key=latest', 6 * 60 * 60 * 1000);
  return asArray(payload)
    .map(mapOpenF1DriverRecord)
    .filter((record): record is OpenF1DriverRecord => !!record);
}

function enrichMotorsportRowsWithAssets(
  rows: MotorsportStandingRow[],
  driverAssets: OpenF1DriverRecord[],
): MotorsportStandingRow[] {
  const byNumber = new Map<string, OpenF1DriverRecord>();
  const byName = new Map<string, OpenF1DriverRecord>();

  for (const asset of driverAssets) {
    if (asset.driverNumber) byNumber.set(asset.driverNumber, asset);
    const normalizedName = normalizeMotorsportLookup(asset.fullName);
    if (normalizedName) byName.set(normalizedName, asset);
  }

  return rows.map((row) => {
    const driverAsset = row.driverNumber
      ? byNumber.get(row.driverNumber)
      : byName.get(normalizeMotorsportLookup(row.name));
    const baseTeamName = row.team || row.name;
    const teamAsset = resolveF1TeamAsset(baseTeamName);
    const isDriverRow = !!row.driverNumber;

    return {
      ...row,
      badge: driverAsset?.headshotUrl || (!isDriverRow ? teamAsset?.badge : undefined),
      team: baseTeamName,
      teamBadge: teamAsset?.badge,
      teamColor: teamAsset?.color,
    };
  });
}

function formatRaceDriverName(raw: Record<string, unknown>): string {
  const driver = isRecord(raw.Driver) ? raw.Driver : null;
  if (!driver) return 'Unknown';
  return [toOptionalString(driver.givenName), toOptionalString(driver.familyName)].filter(Boolean).join(' ') || 'Unknown';
}

function mapMotorsportRaceSummary(raw: Record<string, unknown>): MotorsportRaceSummary | null {
  const circuit = isRecord(raw.Circuit) ? raw.Circuit : null;
  const location = circuit && isRecord(circuit.Location) ? circuit.Location : null;
  const results = asArray(raw.Results);
  const podium = results.slice(0, 3).map((result) => {
    const position = toOptionalString(result.position) || '';
    return `${position}. ${formatRaceDriverName(result)}`.trim();
  }).filter(Boolean);
  const fastestLapResult = results.find((result) => {
    const lap = isRecord(result.FastestLap) ? result.FastestLap : null;
    return toOptionalString(lap?.rank) === '1';
  });

  const raceName = toOptionalString(raw.raceName);
  const round = toOptionalString(raw.round);
  const date = toOptionalString(raw.date);
  if (!raceName || !round || !date) return null;

  return {
    raceName,
    round,
    date,
    time: toOptionalString(raw.time),
    circuitName: toOptionalString(circuit?.circuitName),
    locality: toOptionalString(location?.locality),
    country: toOptionalString(location?.country),
    lat: toOptionalNumber(location?.lat),
    lng: toOptionalNumber(location?.long),
    winner: podium[0]?.replace(/^\d+\.\s*/, ''),
    podium,
    fastestLap: fastestLapResult ? formatRaceDriverName(fastestLapResult) : undefined,
  };
}

export async function fetchFormulaOneStandingsData(): Promise<FormulaOneStandingsData | null> {
  const [driverPayload, constructorPayload, lastRacePayload, nextRacePayload, openF1Drivers] = await Promise.all([
    fetchJolpicaJson<Record<string, unknown>>('/ergast/f1/current/driverStandings.json', 5 * 60 * 1000).catch(() => null),
    fetchJolpicaJson<Record<string, unknown>>('/ergast/f1/current/constructorStandings.json', 5 * 60 * 1000).catch(() => null),
    fetchJolpicaJson<Record<string, unknown>>('/ergast/f1/current/last/results.json', 5 * 60 * 1000).catch(() => null),
    fetchJolpicaJson<Record<string, unknown>>('/ergast/f1/current/next.json', 30 * 60 * 1000).catch(() => null),
    fetchOpenF1DriverAssets().catch(() => []),
  ]);

  const driverMrData = driverPayload && isRecord(driverPayload.MRData) ? driverPayload.MRData : null;
  const constructorMrData = constructorPayload && isRecord(constructorPayload.MRData) ? constructorPayload.MRData : null;
  const lastMrData = lastRacePayload && isRecord(lastRacePayload.MRData) ? lastRacePayload.MRData : null;
  const nextMrData = nextRacePayload && isRecord(nextRacePayload.MRData) ? nextRacePayload.MRData : null;

  const driverTable = driverMrData && isRecord(driverMrData.StandingsTable) ? driverMrData.StandingsTable : null;
  const constructorTable = constructorMrData && isRecord(constructorMrData.StandingsTable) ? constructorMrData.StandingsTable : null;
  const driverList = driverTable ? asArray(driverTable.StandingsLists) : [];
  const constructorList = constructorTable ? asArray(constructorTable.StandingsLists) : [];
  const driverStandings = enrichMotorsportRowsWithAssets(
    asArray(driverList[0]?.DriverStandings)
    .map(mapMotorsportStandingRow)
    .filter((row): row is MotorsportStandingRow => !!row),
    openF1Drivers,
  );
  const constructorStandings = enrichMotorsportRowsWithAssets(
    asArray(constructorList[0]?.ConstructorStandings)
    .map(mapMotorsportStandingRow)
    .filter((row): row is MotorsportStandingRow => !!row),
    openF1Drivers,
  );

  if (!driverStandings.length && !constructorStandings.length) return null;

  const lastRaceTable = lastMrData && isRecord(lastMrData.RaceTable) ? lastMrData.RaceTable : null;
  const nextRaceTable = nextMrData && isRecord(nextMrData.RaceTable) ? nextMrData.RaceTable : null;
  const lastRace = mapMotorsportRaceSummary(asArray(lastRaceTable?.Races)[0] || {});
  const nextRace = mapMotorsportRaceSummary(asArray(nextRaceTable?.Races)[0] || {});

  return {
    leagueName: 'Formula 1',
    season: toOptionalString(driverTable?.season) || toOptionalString(constructorTable?.season) || '',
    round: toOptionalString(driverTable?.round) || toOptionalString(lastRaceTable?.round) || '',
    updatedAt: new Date().toISOString(),
    driverStandings,
    constructorStandings,
    lastRace,
    nextRace,
  };
}
