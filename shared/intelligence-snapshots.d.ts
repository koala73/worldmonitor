export const INTEL_TOPIC_IDS: readonly string[];
export const MIN_ADVISORY_COUNTRY_COVERAGE: number;

export interface SatelliteSnapshotRecord {
  id?: string;
  noradId?: string;
  name: string;
  country?: string;
  type?: string;
  alt?: number | string;
  velocity?: number | string;
  inclination?: number | string;
  line1: string;
  line2: string;
}
export interface AdvisorySnapshotRecord {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  sourceCountry: string;
  level?: string;
  country?: string;
}
export interface GdeltSnapshotArticle {
  title: string;
  url: string;
  source: string;
  date: string;
  image: string;
  language: string;
  tone: number;
}

export function isSatelliteRecord(item: unknown): item is SatelliteSnapshotRecord;
export function normalizeSatelliteSnapshot(value: unknown): { satellites: SatelliteSnapshotRecord[] } | null;
export function isAdvisoryRecord(item: unknown): item is AdvisorySnapshotRecord;
export function normalizeAdvisorySnapshot(value: unknown): {
  advisories: AdvisorySnapshotRecord[];
  byCountry: Record<string, string>;
} | null;
/** One government register's current level for one country. */
export interface AdvisoryRegisterLevelRecord {
  title: string;
  /** The government's advisory page for this country. */
  link: string;
  /** The register feed's own date for this advisory, or '' when it gave none. */
  pubDate: string;
  /** Register name, e.g. "US State Dept". */
  source: string;
  /** Issuing government: "US" or "AU". */
  sourceCountry: string;
  level: 'normal' | 'caution' | 'reconsider' | 'do-not-travel';
  /** ISO 3166-1 alpha-2 destination. */
  country: string;
}
export function isAdvisoryRegisterLevel(item: unknown): item is AdvisoryRegisterLevelRecord;
export function normalizeAdvisoryRegisterLevels(value: unknown): AdvisoryRegisterLevelRecord[];
export function isGdeltArticle(value: unknown): value is GdeltSnapshotArticle;
export function normalizeGdeltSearchResponse<T extends { articles: unknown[] }>(
  value: T,
): (Omit<T, 'articles'> & { articles: GdeltSnapshotArticle[] }) | null;
export function normalizeGdeltTopicSnapshot(value: unknown): {
  topics: Array<{ id: string; articles: GdeltSnapshotArticle[]; fetchedAt?: string }>;
} | null;
