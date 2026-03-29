/**
 * FEMA Disaster Declarations and Open Shelter Registry
 * Public API — no authentication required
 * https://www.fema.gov/api/open/v2/
 *
 * Two endpoints:
 *  - DisasterDeclarationsSummaries: officially declared federal disasters
 *    triggering FEMA Individual/Public Assistance programs
 *  - OpenedShelters: FEMA-managed emergency shelters currently accepting evacuees
 *
 * A FEMA declaration is the clearest US government signal that a disaster is
 * serious enough to warrant federal response resources.
 */

export type FemaDeclarationType =
  | 'DR'   // Major Disaster Declaration
  | 'EM'   // Emergency Declaration
  | 'FM'   // Fire Management Assistance Grant
  | 'FS';  // Fire Suppression Authorization

export type FemaIncidentType =
  | 'Flood'
  | 'Hurricane'
  | 'Tornado'
  | 'Earthquake'
  | 'Wildfire'
  | 'Winter Storm'
  | 'Severe Storm'
  | 'Tsunami'
  | 'Typhoon'
  | 'Other';

export interface FemaDeclaration {
  id: string;
  disasterNumber: number;
  declarationType: FemaDeclarationType;
  incidentType: FemaIncidentType | string;
  declarationTitle: string;
  state: string;
  stateFips: string;
  incidentBeginDate: Date;
  incidentEndDate: Date | null;
  declarationDate: Date;
  closeoutDate: Date | null;
  isOpen: boolean;
  ihProgramDeclared: boolean;   // Individual Assistance
  iaProgramDeclared: boolean;   // Individual Assistance (alternate field)
  paProgramDeclared: boolean;   // Public Assistance
  hmProgramDeclared: boolean;   // Hazard Mitigation
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface FemaShelter {
  id: string;
  shelterName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number | null;
  lon: number | null;
  capacity: number | null;
  currentOccupancy: number | null;
  disasterNumber: number | null;
  shelterStatus: 'Open' | 'Closed' | 'Full' | string;
  acceptingEvacuees: boolean;
  petFriendly: boolean;
  accessibilityCompliant: boolean;
}

const FEMA_API = 'https://www.fema.gov/api/open/v2';
const CACHE_TTL_DECLARATIONS = 15 * 60 * 1000;  // 15 min
const CACHE_TTL_SHELTERS = 5 * 60 * 1000;       // 5 min

let declarationsCache: { items: FemaDeclaration[]; fetchedAt: number } | null = null;
let sheltersCache: { items: FemaShelter[]; fetchedAt: number } | null = null;

function declarationSeverity(type: FemaDeclarationType, incidentType: string): FemaDeclaration['severity'] {
  if (type === 'DR') {
    const i = incidentType.toLowerCase();
    if (i.includes('earthquake') || i.includes('tsunami') || i.includes('hurricane') || i.includes('typhoon')) return 'critical';
    if (i.includes('flood') || i.includes('tornado') || i.includes('wildfire')) return 'high';
    return 'medium';
  }
  if (type === 'EM') return 'high';
  if (type === 'FM' || type === 'FS') return 'medium';
  return 'low';
}

interface FemaApiDeclaration {
  disasterNumber?: number;
  declarationType?: string;
  incidentType?: string;
  declarationTitle?: string;
  state?: string;
  stateFips?: string;
  incidentBeginDate?: string;
  incidentEndDate?: string;
  declarationDate?: string;
  closeoutDate?: string;
  closeoutDatetime?: string;
  ihProgramDeclared?: boolean;
  iaProgramDeclared?: boolean;
  paProgramDeclared?: boolean;
  hmProgramDeclared?: boolean;
  disasterCloseoutDate?: string;
}

interface FemaApiShelter {
  shelterId?: string;
  shelterName?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  capacity?: number;
  currentOccupancy?: number;
  disasterNumber?: number;
  shelterStatus?: string;
  acceptingEvacuees?: boolean;
  petFriendly?: boolean;
  ada?: boolean;
}

interface FemaApiResponse<T> {
  DisasterDeclarationsSummaries?: T[];
  OpenedShelters?: T[];
  metadata?: { count: number };
}

export async function fetchFemaDeclarations(daysBack = 90): Promise<FemaDeclaration[]> {
  if (declarationsCache && Date.now() - declarationsCache.fetchedAt < CACHE_TTL_DECLARATIONS) {
    return declarationsCache.items;
  }

  try {
    const since = new Date(Date.now() - daysBack * 24 * 3_600_000).toISOString().slice(0, 10);
    const url = `${FEMA_API}/DisasterDeclarationsSummaries?$filter=declarationDate ge '${since}'&$orderby=declarationDate desc&$top=100&$format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json' } });
    if (!res.ok) return declarationsCache?.items ?? [];

    const data: FemaApiResponse<FemaApiDeclaration> = await res.json();
    const raw = data.DisasterDeclarationsSummaries ?? [];

    const items: FemaDeclaration[] = raw.map(d => {
      const declType = (d.declarationType ?? 'DR') as FemaDeclarationType;
      const incType = d.incidentType ?? 'Other';
      const isOpen = !d.closeoutDate && !d.closeoutDatetime && !d.disasterCloseoutDate;
      return {
        id: `fema-${d.disasterNumber ?? Math.random()}`,
        disasterNumber: d.disasterNumber ?? 0,
        declarationType: declType,
        incidentType: incType,
        declarationTitle: d.declarationTitle ?? '',
        state: d.state ?? '',
        stateFips: d.stateFips ?? '',
        incidentBeginDate: d.incidentBeginDate ? new Date(d.incidentBeginDate) : new Date(),
        incidentEndDate: d.incidentEndDate ? new Date(d.incidentEndDate) : null,
        declarationDate: d.declarationDate ? new Date(d.declarationDate) : new Date(),
        closeoutDate: (d.closeoutDate || d.disasterCloseoutDate)
          ? new Date(d.closeoutDate ?? d.disasterCloseoutDate!)
          : null,
        isOpen,
        ihProgramDeclared: d.ihProgramDeclared ?? false,
        iaProgramDeclared: d.iaProgramDeclared ?? false,
        paProgramDeclared: d.paProgramDeclared ?? false,
        hmProgramDeclared: d.hmProgramDeclared ?? false,
        url: `https://www.fema.gov/disaster/${d.disasterNumber}`,
        severity: declarationSeverity(declType, incType),
      };
    });

    declarationsCache = { items, fetchedAt: Date.now() };
    return items;
  } catch {
    return declarationsCache?.items ?? [];
  }
}

export async function fetchFemaShelters(): Promise<FemaShelter[]> {
  if (sheltersCache && Date.now() - sheltersCache.fetchedAt < CACHE_TTL_SHELTERS) {
    return sheltersCache.items;
  }

  try {
    const url = `${FEMA_API}/OpenedShelters?$filter=shelterStatus eq 'Open'&$top=200&$format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json' } });
    if (!res.ok) return sheltersCache?.items ?? [];

    const data: FemaApiResponse<FemaApiShelter> = await res.json();
    const raw = data.OpenedShelters ?? [];

    const items: FemaShelter[] = raw.map(s => ({
      id: `shelter-${s.shelterId ?? `${s.shelterName}-${s.city}`}`,
      shelterName: s.shelterName ?? 'Unknown Shelter',
      address: s.address1 ?? '',
      city: s.city ?? '',
      state: s.state ?? '',
      zip: s.postalCode ?? '',
      lat: s.latitude ?? null,
      lon: s.longitude ?? null,
      capacity: s.capacity ?? null,
      currentOccupancy: s.currentOccupancy ?? null,
      disasterNumber: s.disasterNumber ?? null,
      shelterStatus: s.shelterStatus ?? 'Open',
      acceptingEvacuees: s.acceptingEvacuees ?? true,
      petFriendly: s.petFriendly ?? false,
      accessibilityCompliant: s.ada ?? false,
    }));

    sheltersCache = { items, fetchedAt: Date.now() };
    return items;
  } catch {
    return sheltersCache?.items ?? [];
  }
}

export function femaDeclarationTypeLabel(type: FemaDeclarationType): string {
  return { DR: 'Major Disaster', EM: 'Emergency', FM: 'Fire Mgmt Grant', FS: 'Fire Suppression' }[type] ?? type;
}

export function femaSeverityClass(severity: FemaDeclaration['severity']): string {
  return { critical: 'eq-row eq-major', high: 'eq-row eq-strong', medium: 'eq-row eq-moderate', low: 'eq-row' }[severity] ?? 'eq-row';
}
