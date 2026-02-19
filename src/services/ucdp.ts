import { createCircuitBreaker, fetchWithCache } from '@/utils';

export type ConflictIntensity = 'none' | 'minor' | 'war';

export interface UcdpConflictStatus {
  location: string;
  intensity: ConflictIntensity;
  conflictId?: number;
  conflictName?: string;
  year: number;
  typeOfConflict?: number;
  sideA?: string;
  sideB?: string;
}

interface UcdpApiConflict {
  conflictId: number;
  conflictName: string;
  location: string;
  year: number;
  intensityLevel: number;
  typeOfConflict: number;
  sideA: string;
  sideB: string;
}

// Map UCDP location names to ISO2 country codes
const UCDP_COUNTRY_MAP: Record<string, string> = {
  'Ukraine': 'UA', 'Russia (Soviet Union)': 'RU', 'Russia': 'RU',
  'Syria': 'SY', 'Yemen (North Yemen)': 'YE', 'Yemen': 'YE',
  'Myanmar (Burma)': 'MM', 'Myanmar': 'MM',
  'Israel': 'IL', 'Iran': 'IR',
  'Turkey (Ottoman Empire)': 'TR', 'Turkey': 'TR',
  'Pakistan': 'PK', 'India': 'IN',
  'China': 'CN', 'Saudi Arabia': 'SA',
  'United States of America': 'US', 'United States': 'US',
  'United Kingdom': 'GB', 'France': 'FR',
  'Germany': 'DE', 'Poland': 'PL',
  'Venezuela': 'VE', 'North Korea': 'KP',
  'Korea, North': 'KP', 'Taiwan': 'TW',
};

function mapIntensity(level: number): ConflictIntensity {
  if (level >= 2) return 'war';
  if (level >= 1) return 'minor';
  return 'none';
}

function resolveCountryCode(location: string): string | null {
  if (UCDP_COUNTRY_MAP[location]) return UCDP_COUNTRY_MAP[location];
  const lower = location.toLowerCase();
  for (const [name, code] of Object.entries(UCDP_COUNTRY_MAP)) {
    if (lower.includes(name.toLowerCase())) return code;
  }
  return null;
}

const ucdpBreaker = createCircuitBreaker<Map<string, UcdpConflictStatus>>({ name: 'UCDP Classifications' });

export async function fetchUcdpClassifications(): Promise<Map<string, UcdpConflictStatus>> {
  return ucdpBreaker.execute(async () => {
    const result = await fetchWithCache<{ conflicts?: UcdpApiConflict[] }>('/api/ucdp', {
      ttl: 300_000,
      headers: { Accept: 'application/json' },
    });
    const conflicts: UcdpApiConflict[] = result.conflicts || [];

    const byCountry = new Map<string, UcdpConflictStatus>();

    for (const c of conflicts) {
      const code = resolveCountryCode(c.location);
      if (!code) continue;

      const existing = byCountry.get(code);
      // Keep highest intensity / most recent
      if (!existing || c.year > existing.year ||
          (c.year === existing.year && c.intensityLevel > (existing.intensity === 'war' ? 2 : existing.intensity === 'minor' ? 1 : 0))) {
        byCountry.set(code, {
          location: c.location,
          intensity: mapIntensity(c.intensityLevel),
          conflictId: c.conflictId,
          conflictName: c.sideB || c.conflictName,
          year: c.year,
          typeOfConflict: c.typeOfConflict,
          sideA: c.sideA,
          sideB: c.sideB,
        });
      }
    }

    console.log(`[UCDP] ${byCountry.size} country classifications loaded`);
    return byCountry;
  }, new Map());
}
