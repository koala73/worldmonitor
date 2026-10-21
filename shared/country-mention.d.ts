export interface CountryMentionTerms {
  /** Uppercase ISO-3166 alpha-2 code. */
  code: string;
  /** Normalized names and aliases (compare against normalizeMentionText output). */
  names: string[];
  /** Raw-cased demonyms, matched case-sensitively. */
  demonyms: string[];
  /** Normalized phrases removed from the text before the name match. */
  exclusions: string[];
}

export const CODE_TOKEN_ALLOWLIST: ReadonlySet<string>;
export function normalizeMentionText(text: string): string;
export function countryDisplayName(code: string): string;
export function countryMentionTerms(code: string): CountryMentionTerms;
export function mentionsCountry(rawText: string, terms: CountryMentionTerms): boolean;
