export const LOCAL_LOGISTICS_CATEGORIES = ['shelter', 'hospital', 'pharmacy', 'fuel', 'water'] as const;

export type LogisticsCategory = typeof LOCAL_LOGISTICS_CATEGORIES[number];
export type LogisticsFreshness = 'fresh' | 'recent' | 'stale';
export type LogisticsStatus = 'open' | 'limited' | 'unknown';
export type LogisticsHazardCompatibility = 'general' | 'evacuation' | 'medical' | 'supply';

export interface LogisticsNode {
  id: string;
  category: LogisticsCategory;
  name: string;
  lat: number;
  lon: number;
  distanceKm: number;
  source: string;
  freshness: LogisticsFreshness;
  status: LogisticsStatus;
  hazardCompatibility: LogisticsHazardCompatibility;
  fetchedAt: Date;
  address?: string;
  url?: string;
}

export interface LocalLogisticsSnapshot {
  placeId: string;
  placeName: string;
  categories: LogisticsCategory[];
  nodes: LogisticsNode[];
  fetchedAt: Date;
  isStale: boolean;
  staleAgeMs: number;
  source: 'network' | 'offline-cache';
}

export const LOCAL_LOGISTICS_CATEGORY_LABELS: Record<LogisticsCategory, string> = {
  shelter: 'Shelter',
  hospital: 'Hospital',
  pharmacy: 'Pharmacy',
  fuel: 'Fuel',
  water: 'Water',
};
