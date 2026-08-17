/**
 * Storage-independent Company Monitoring evidence policy.
 *
 * This module intentionally does no database access. Convex duplicates the
 * returned rows under an account + company key before any lookup is possible.
 */

import { COMPANY_MONITORING_LIMITS } from "./company-monitoring-contract";

export const COMPANY_MONITORING_EVIDENCE_POLICY = Object.freeze({
  version: "cm-evidence-selection-v1",
  fingerprintVersion: "cm-evidence-fingerprint-v1",
  occurrenceVersion: "cm-occurrence-v1",
  candidateTtlMs: 72 * 60 * 60 * 1000,
  maxReferences: COMPANY_MONITORING_LIMITS.maxEvidenceReferences,
  minimumBlockingAuthority: "independent_source" as const,
});

export type CompanyEvidenceProvider = "exa" | "x";
export type CompanyEvidenceSourceAuthority =
  | "verified_first_party"
  | "independent_source"
  | "low_authority";
export type CompanyEvidenceIndependence =
  | "first_party"
  | "independent"
  | "syndicated"
  | "unknown";

export interface AttributionClaim {
  claimId: string;
  type:
    | "alias"
    | "domain"
    | "legal_identifier"
    | "x_account_id"
    | "x_handle"
    | "location"
    | "customer_reference";
  value: string;
  trustState: "unverified" | "verified" | "expired" | "rejected";
  allowedUses?: Array<"discovery" | "attribution" | "primary_evidence">;
  expiresAt?: number;
}

export interface EvidenceSubject {
  companyId: string;
  name: string;
  claims: AttributionClaim[];
}

export interface ProviderEvidence {
  provider: CompanyEvidenceProvider;
  providerLocator: string;
  queryVersion?: string;
  url?: string;
  title?: string;
  text?: string;
  author?: string;
  authorAccountId?: string;
  publishedAt: number;
  observedAt: number;
  expiresAt?: number;
  candidateCompanyIds: string[];
  verifiedCompanyIds?: string[];
  sourceAuthority: CompanyEvidenceSourceAuthority;
}

export interface NormalizedCompanyEvidence {
  ownerAccountId: string;
  companyId: string;
  provider: CompanyEvidenceProvider;
  providerLocator: string;
  queryVersion?: string;
  providerLocatorHash: string;
  providerOrigin: string;
  providerOriginFingerprint: string;
  contentFingerprint: string;
  evidenceFingerprint: string;
  occurrenceDedupeKey: string;
  matchedClaimIds: string[];
  sourceAuthority: CompanyEvidenceSourceAuthority;
  independence: CompanyEvidenceIndependence;
  url?: string;
  title?: string;
  text?: string;
  author?: string;
  authorAccountId?: string;
  publishedAt: number;
  observedAt: number;
  expiresAt?: number;
}

export interface NormalizedCompanyCandidate {
  ownerAccountId: string;
  companyId: string;
  occurrenceDedupeKey: string;
  state: "pending_classification";
  firstDiscoveredAt: number;
  firstDiscoveredPath: string;
  attemptCount: number;
  expiresAt: number;
  observationBlocking: boolean;
  referenceEvidenceFingerprints: string[];
  referenceCount: number;
  referencesTruncated: boolean;
  selectionPolicyVersion: string;
}

function canonicalWords(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodedPathname(parsedUrl: URL): string {
  try {
    return decodeURIComponent(parsedUrl.pathname);
  } catch {
    return parsedUrl.pathname;
  }
}

function canonicalContent(row: ProviderEvidence, parsedUrl: URL): string {
  const content = canonicalWords([row.title, row.text].filter(Boolean).join(" "));
  if (content) return content;
  const path = canonicalWords(decodedPathname(parsedUrl));
  return path || canonicalWords(row.providerLocator);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function companyEvidenceProviderLocatorHash(
  provider: CompanyEvidenceProvider,
  providerLocator: string,
): Promise<string> {
  return sha256({
    version: COMPANY_MONITORING_EVIDENCE_POLICY.fingerprintVersion,
    provider,
    locator: providerLocator,
  });
}

function domainContains(hostname: string, domain: string): boolean {
  const normalized = domain.toLocaleLowerCase("en-US").replace(/^www\./, "");
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function phrasePresent(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function claimStrength(
  claim: AttributionClaim,
  row: ProviderEvidence,
  parsedUrl: URL,
  searchable: string,
  now: number,
): number {
  if (!claim.allowedUses?.includes("attribution")) return 0;
  if (claim.trustState === "expired" || claim.trustState === "rejected") return 0;
  if (claim.expiresAt !== undefined && claim.expiresAt <= now) return 0;
  const value = canonicalWords(claim.value);
  if (!value) return 0;

  switch (claim.type) {
    case "domain": {
      const hostname = parsedUrl.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
      return domainContains(hostname, claim.value) || phrasePresent(searchable, value) ? 100 : 0;
    }
    case "legal_identifier":
      return phrasePresent(searchable, value) ? 100 : 0;
    case "x_account_id":
      return row.authorAccountId === claim.value ? 100 : 0;
    case "x_handle": {
      const handle = claim.value.replace(/^@/, "").toLocaleLowerCase("en-US");
      const author = row.author?.replace(/^@/, "").toLocaleLowerCase("en-US");
      return author === handle || phrasePresent(searchable, canonicalWords(handle)) ? 80 : 0;
    }
    case "alias": {
      const tokens = value.split(" ");
      if (value.length < 5 || (tokens.length === 1 && value.length < 6)) return 0;
      return phrasePresent(searchable, value) ? 50 : 0;
    }
    case "location":
    case "customer_reference":
      return 0;
  }
}

function attributionClaimSignature(claim: AttributionClaim): string {
  const value = claim.type === "domain"
    ? claim.value.toLocaleLowerCase("en-US").replace(/^www\./, "").replace(/\.$/, "")
    : claim.type === "x_handle"
      ? claim.value.replace(/^@/, "").toLocaleLowerCase("en-US")
      : canonicalWords(claim.value);
  return `${claim.type}\u0000${value}`;
}

function validRow(row: ProviderEvidence): URL | null {
  if (row.provider !== "exa" && row.provider !== "x") return null;
  if (!row.providerLocator || row.providerLocator !== row.providerLocator.trim()) return null;
  if (!Number.isSafeInteger(row.publishedAt) || !Number.isSafeInteger(row.observedAt)) return null;
  if (!Array.isArray(row.candidateCompanyIds) || row.candidateCompanyIds.length === 0) return null;
  if (!row.url) return null;
  try {
    const parsed = new URL(row.url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function directVerifiedMatches(row: ProviderEvidence, subjects: Map<string, EvidenceSubject>) {
  if (row.provider !== "x" || row.sourceAuthority !== "verified_first_party") return [];
  return [...new Set(row.verifiedCompanyIds ?? [])]
    .filter((companyId) => row.candidateCompanyIds.includes(companyId) && subjects.has(companyId))
    .sort();
}

function reverseMatches(
  row: ProviderEvidence,
  parsedUrl: URL,
  subjectMap: Map<string, EvidenceSubject>,
  now: number,
) {
  const direct = directVerifiedMatches(row, subjectMap);
  if (direct.length > 0) return direct.map((companyId) => ({ companyId, claimIds: [] }));

  const searchable = canonicalWords([
    row.title,
    row.text,
    row.author,
    row.authorAccountId,
    parsedUrl.hostname,
    decodedPathname(parsedUrl),
  ].filter(Boolean).join(" "));
  const matches = [...new Set(row.candidateCompanyIds)].sort().flatMap((companyId) => {
    const subject = subjectMap.get(companyId);
    if (!subject) return [];
    const hits = subject.claims
      .map((claim) => ({ claim, strength: claimStrength(claim, row, parsedUrl, searchable, now) }))
      .filter(({ strength }) => strength > 0)
      .sort((left, right) => right.strength - left.strength || left.claim.claimId.localeCompare(right.claim.claimId));
    if (hits.length === 0) return [];
    return [{
      companyId,
      strength: hits[0]!.strength,
      claimIds: hits.filter((hit) => hit.strength === hits[0]!.strength).map((hit) => hit.claim.claimId),
      strongHits: hits
        .filter((hit) => hit.strength >= 80)
        .map((hit) => ({
          claimId: hit.claim.claimId,
          signature: attributionClaimSignature(hit.claim),
        })),
    }];
  });
  const strong = matches.filter((match) => match.strength >= 80);
  if (strong.length > 0) {
    const companiesBySignature = new Map<string, Set<string>>();
    for (const match of strong) {
      for (const hit of match.strongHits) {
        const companies = companiesBySignature.get(hit.signature) ?? new Set<string>();
        companies.add(match.companyId);
        companiesBySignature.set(hit.signature, companies);
      }
    }
    return strong.flatMap(({ companyId, strongHits }) => {
      const uniqueClaimIds = strongHits
        .filter((hit) => companiesBySignature.get(hit.signature)?.size === 1)
        .map((hit) => hit.claimId)
        .sort();
      return uniqueClaimIds.length > 0 ? [{ companyId, claimIds: uniqueClaimIds }] : [];
    });
  }
  return matches.length === 1
    ? matches.map(({ companyId, claimIds }) => ({ companyId, claimIds }))
    : [];
}

function evidenceRank(row: NormalizedCompanyEvidence): [number, number, number, string] {
  const authority = row.sourceAuthority === "verified_first_party"
    ? 3
    : row.sourceAuthority === "independent_source"
      ? 2
      : 1;
  const independence = row.independence === "independent"
    ? 3
    : row.independence === "first_party"
      ? 2
      : row.independence === "unknown"
        ? 1
        : 0;
  return [authority, independence, row.publishedAt, row.evidenceFingerprint];
}

export function compareCompanyEvidence(
  left: NormalizedCompanyEvidence,
  right: NormalizedCompanyEvidence,
): number {
  const a = evidenceRank(left);
  const b = evidenceRank(right);
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2] || a[3].localeCompare(b[3]);
}

export function companyEvidenceCanBlockObservation(row: NormalizedCompanyEvidence): boolean {
  if (row.sourceAuthority === "low_authority") return false;
  if (row.independence === "syndicated" || row.independence === "unknown") return false;
  return row.sourceAuthority === "verified_first_party" ||
    row.sourceAuthority === COMPANY_MONITORING_EVIDENCE_POLICY.minimumBlockingAuthority;
}

export function projectCompanyMonitoringCandidate(
  rows: NormalizedCompanyEvidence[],
  occurrenceDedupeKey = rows[0]?.occurrenceDedupeKey,
): NormalizedCompanyCandidate {
  if (rows.length === 0 || occurrenceDedupeKey === undefined) {
    throw new Error("Company Monitoring candidate projection requires evidence");
  }
  const ranked = [...rows].sort(compareCompanyEvidence);
  const first = [...rows].sort((left, right) =>
    left.observedAt - right.observedAt ||
    left.evidenceFingerprint.localeCompare(right.evidenceFingerprint)
  )[0]!;
  const selected = ranked.slice(0, COMPANY_MONITORING_EVIDENCE_POLICY.maxReferences);
  return {
    ownerAccountId: first.ownerAccountId,
    companyId: first.companyId,
    occurrenceDedupeKey,
    state: "pending_classification",
    firstDiscoveredAt: first.observedAt,
    firstDiscoveredPath: `${first.provider}:${first.providerLocatorHash}`,
    attemptCount: 0,
    expiresAt: first.observedAt + COMPANY_MONITORING_EVIDENCE_POLICY.candidateTtlMs,
    observationBlocking: rows.some(companyEvidenceCanBlockObservation),
    referenceEvidenceFingerprints: selected.map((row) => row.evidenceFingerprint),
    referenceCount: ranked.length,
    referencesTruncated: ranked.length > selected.length,
    selectionPolicyVersion: COMPANY_MONITORING_EVIDENCE_POLICY.version,
  };
}

export async function normalizeCompanyEvidence(input: {
  ownerAccountId: string;
  subjects: EvidenceSubject[];
  evidence: ProviderEvidence[];
  now: number;
}): Promise<{ evidence: NormalizedCompanyEvidence[]; candidates: NormalizedCompanyCandidate[] }> {
  const subjectMap = new Map(input.subjects.map((subject) => [subject.companyId, subject]));
  const evidence: NormalizedCompanyEvidence[] = [];

  for (const row of input.evidence) {
    const parsedUrl = validRow(row);
    if (!parsedUrl) continue;
    const providerOrigin = row.provider === "x"
      ? row.authorAccountId ?? parsedUrl.hostname.toLocaleLowerCase("en-US")
      : parsedUrl.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    const contentIdentity = canonicalContent(row, parsedUrl);
    const [providerLocatorHash, providerOriginFingerprint, contentFingerprint] = await Promise.all([
      companyEvidenceProviderLocatorHash(row.provider, row.providerLocator),
      sha256({ version: COMPANY_MONITORING_EVIDENCE_POLICY.fingerprintVersion, provider: row.provider, origin: providerOrigin }),
      sha256({ version: COMPANY_MONITORING_EVIDENCE_POLICY.fingerprintVersion, content: contentIdentity }),
    ]);
    const matches = reverseMatches(row, parsedUrl, subjectMap, input.now);
    for (const match of matches) {
      const subject = subjectMap.get(match.companyId)!;
      const matchingOfficialClaims = subject.claims.filter((claim) =>
        claim.type === "domain" &&
        claim.allowedUses?.includes("attribution") &&
        domainContains(providerOrigin, claim.value)
      );
      const firstParty = row.provider === "x" || matchingOfficialClaims.length > 0;
      const sourceAuthority = row.provider === "x"
        ? row.sourceAuthority
        : firstParty
          ? matchingOfficialClaims.some((claim) =>
              claim.trustState === "verified" &&
              (claim.expiresAt === undefined || claim.expiresAt > input.now)
            )
            ? "verified_first_party" as const
            : "low_authority" as const
          : row.sourceAuthority;
      const evidenceFingerprint = await sha256({
        version: COMPANY_MONITORING_EVIDENCE_POLICY.fingerprintVersion,
        ownerAccountId: input.ownerAccountId,
        companyId: match.companyId,
        provider: row.provider,
        providerOriginFingerprint,
        contentFingerprint,
        providerLocatorHash,
      });
      const occurrenceDedupeKey = await sha256({
        version: COMPANY_MONITORING_EVIDENCE_POLICY.occurrenceVersion,
        ownerAccountId: input.ownerAccountId,
        companyId: match.companyId,
        contentFingerprint,
      });
      evidence.push({
        ownerAccountId: input.ownerAccountId,
        companyId: match.companyId,
        provider: row.provider,
        providerLocator: row.providerLocator,
        ...(row.queryVersion ? { queryVersion: row.queryVersion } : {}),
        providerLocatorHash,
        providerOrigin,
        providerOriginFingerprint,
        contentFingerprint,
        evidenceFingerprint,
        occurrenceDedupeKey,
        matchedClaimIds: [...match.claimIds].sort(),
        sourceAuthority,
        independence: firstParty ? "first_party" : sourceAuthority === "low_authority" ? "unknown" : "independent",
        ...(row.url ? { url: row.url } : {}),
        ...(row.title ? { title: row.title } : {}),
        ...(row.text ? { text: row.text } : {}),
        ...(row.author ? { author: row.author } : {}),
        ...(row.authorAccountId ? { authorAccountId: row.authorAccountId } : {}),
        publishedAt: row.publishedAt,
        observedAt: row.observedAt,
        ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
      });
    }
  }

  const occurrenceGroups = new Map<string, NormalizedCompanyEvidence[]>();
  for (const row of evidence) {
    const group = occurrenceGroups.get(row.occurrenceDedupeKey) ?? [];
    group.push(row);
    occurrenceGroups.set(row.occurrenceDedupeKey, group);
  }
  for (const group of occurrenceGroups.values()) {
    const independent = group
      .filter((row) => row.independence === "independent")
      .sort((left, right) =>
        left.publishedAt - right.publishedAt ||
        left.providerOriginFingerprint.localeCompare(right.providerOriginFingerprint) ||
        left.evidenceFingerprint.localeCompare(right.evidenceFingerprint)
      );
    for (const row of independent.slice(1)) row.independence = "syndicated";
  }

  evidence.sort((left, right) =>
    left.companyId.localeCompare(right.companyId) ||
    left.occurrenceDedupeKey.localeCompare(right.occurrenceDedupeKey) ||
    compareCompanyEvidence(left, right)
  );
  const candidates: NormalizedCompanyCandidate[] = [];
  for (const [occurrenceDedupeKey, rows] of [...occurrenceGroups.entries()].sort()) {
    candidates.push(projectCompanyMonitoringCandidate(rows, occurrenceDedupeKey));
  }
  candidates.sort((left, right) =>
    left.companyId.localeCompare(right.companyId) ||
    left.occurrenceDedupeKey.localeCompare(right.occurrenceDedupeKey)
  );
  return { evidence, candidates };
}
