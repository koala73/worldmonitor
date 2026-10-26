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

/** Profile facts as served next to provenance. Null when the outlet has no reviewed profile. */
export interface OutletProfileFields {
  homeCountry: string | null;
  audience: OutletAudience | null;
  language: string | null;
  ownershipClass: OwnershipClass | null;
}

export function outletProfileFields(sourceName: string): OutletProfileFields {
  const profile = getOutletProfile(sourceName);
  return {
    homeCountry: profile?.country ?? null,
    audience: profile?.audience ?? null,
    language: profile?.language ?? null,
    ownershipClass: profile?.ownershipClass ?? null,
  };
}

function profileClause(fields: OutletProfileFields): string {
  if (!fields.homeCountry) return 'Outlet profile: none recorded.';
  return `Home ${fields.homeCountry}; ${fields.audience} audience; language ${fields.language}; ownership ${fields.ownershipClass}.`;
}

/**
 * Adds the outlet profile to a provenance object. A prose `summary`, when
 * present, keeps its existing clauses and gains one profile clause at the end.
 */
export function withOutletProfile<T extends object>(
  sourceName: string,
  provenance: T,
): T & OutletProfileFields {
  const fields = outletProfileFields(sourceName);
  const summary = (provenance as { summary?: unknown }).summary;
  return {
    ...provenance,
    ...fields,
    ...(typeof summary === 'string' ? { summary: `${summary} ${profileClause(fields)}` } : {}),
  };
}

export const OUTLET_PROFILE_OUTPUT_PROPERTIES = {
  homeCountry: { type: ['string', 'null'], description: `ISO 3166-1 alpha-2 country the outlet is based in, ${INTERNATIONAL_HOME} for intergovernmental or multi-publisher sources, EU for EU institutions. Null when no profile is recorded.` },
  audience: { type: ['string', 'null'], enum: [...OUTLET_AUDIENCES, null], description: 'Who the outlet writes for: domestic (its home country), international (a global or foreign readership), diaspora (one foreign country or its diaspora, from outside it). Null when no profile is recorded.' },
  language: { type: ['string', 'null'], description: 'ISO 639-1 language of the ingested content. Null when no profile is recorded.' },
  ownershipClass: { type: ['string', 'null'], enum: [...OWNERSHIP_CLASSES, null], description: 'Who owns the outlet. unreviewed means not established (e.g. multi-publisher searches, anonymous channels). Ownership only: not a rating of editorial independence or lean. Null when no profile is recorded.' },
} as const;

export const OUTLET_PROFILE_REQUIRED = ['homeCountry', 'audience', 'language', 'ownershipClass'] as const;
