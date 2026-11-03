// Types for scripts/shared/cii-country-borders.mjs so server/*.ts consumers stay
// covered by `npm run typecheck:api` (tsconfig.api.json includes server/).

/** Territorial sea: 12 nautical miles, in km. */
export declare const CII_COASTAL_WATERS_KM: number;
/** The Tier-1 countries the border file covers, sorted. */
export declare const CII_BORDER_COUNTRIES: readonly string[];
/** Tier-1 row for an ISO2-tagged event: itself, its attributed row (PS -> IL), or null. */
export declare function ciiCountryForIso2(iso2: unknown): string | null;
/** True on land in the border file (Tier-1, or non-Tier-1 land near a Tier-1 country). */
export declare function ciiIsLand(lat: number, lon: number): boolean;
/**
 * ISO2 of the Tier-1 country at (lat, lon), or null when the point is on
 * non-Tier-1 land, farther than 12 nautical miles offshore, or not a number.
 */
export declare function ciiCountryAt(lat: number, lon: number): string | null;
