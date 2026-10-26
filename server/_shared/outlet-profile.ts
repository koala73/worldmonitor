/**
 * Outlet profile: where an outlet is based, who it writes for, in what
 * language, and who owns it.
 *
 * Canonical data: shared/outlet-profile.json, one reviewed entry per source
 * name. The key space is the same flat name space SOURCE_TIERS uses, so an RSS
 * feed and a Telegram channel or X account with the same name are one outlet.
 * tests/outlet-profile-completeness.test.mts keeps the file closed-world over
 * every catalog outlet.
 *
 * Server and MCP code only. shared/source-provenance.ts is bundled into the
 * browser through src/config/feeds.ts, so the profile is joined here instead.
 */
import outletProfileData from '../../shared/outlet-profile.json';

export const OUTLET_AUDIENCES = ['domestic', 'international', 'diaspora'] as const;
export type OutletAudience = typeof OUTLET_AUDIENCES[number];

/**
 * Coarse ownership, reviewed per outlet. It deliberately stops short of an
 * editorial-independence judgement; State Media Monitor's licensed seven-class
 * typology is served at runtime to entitled callers instead.
 */
export const OWNERSHIP_CLASSES = ['state', 'public-service', 'private', 'nonprofit', 'intergovernmental', 'unreviewed'] as const;
export type OwnershipClass = typeof OWNERSHIP_CLASSES[number];

/** Home country for intergovernmental and multinational outlets. */
export const INTERNATIONAL_HOME = 'INTL';

export interface OutletProfile {
  /** ISO 3166-1 alpha-2, or INTL. */
  country: string;
  audience: OutletAudience;
  /** ISO 639-1 content language. */
  language: string;
  ownershipClass: OwnershipClass;
  /** Why a non-obvious tag was chosen. */
  note?: string;
}

const PROFILES: Readonly<Record<string, OutletProfile>> = Object.freeze(
  Object.fromEntries(
    Object.entries(outletProfileData as Record<string, unknown>)
      .filter(([name]) => !name.startsWith('_')),
  ) as Record<string, OutletProfile>,
);

export function getOutletProfile(sourceName: string): OutletProfile | null {
  return Object.prototype.hasOwnProperty.call(PROFILES, sourceName) ? PROFILES[sourceName]! : null;
}

export function outletProfileNames(): string[] {
  return Object.keys(PROFILES);
}
