export interface CountryMentionTerms {
  /** Uppercase ISO-3166 alpha-2 code. */
  code: string;
  /** Normalized names and aliases (compare against normalizeMentionText output). */
  names: string[];
  /** Raw-cased demonyms, matched case-sensitively. */
  demonyms: string[];
  /** Normalized phrases removed from the text before the name match, including longer words they start. */
  exclusions: string[];
  /** Normalized phrases removed only as whole phrases. Optional for hand-built terms. */
  wordExclusions?: string[];
  /** Names that need a co-term or a proper-noun mention to count. Empty treats every name as strong. */
  weakNames?: string[];
  /** The weak name is also a first name, so a mention next to another capitalized word is a person. */
  weakFirstName?: boolean;
  /** Normalized terms that confirm a weak name. */
  coTerms?: string[];
}

export const AMBIGUOUS_COUNTRY_TERMS: Readonly<Record<string, { firstName?: boolean; weak: readonly string[]; co: readonly string[] }>>;

export const CODE_TOKEN_ALLOWLIST: ReadonlySet<string>;
export function normalizeMentionText(text: string): string;
export function countryDisplayName(code: string): string;
export function countryMentionTerms(code: string): CountryMentionTerms;
export function mentionsCountry(rawText: string, terms: CountryMentionTerms): boolean;
export function localizedCountryNames(code: string, language: string): string[];
export function mentionsLocalizedCountry(rawText: string, names: readonly string[], language: string): boolean;
