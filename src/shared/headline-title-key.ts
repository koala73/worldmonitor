/**
 * The form of a headline used to match and de-duplicate it: case, punctuation
 * and spacing are ignored. Shared by the headline-history search (server) and
 * the Cmd+K merge with loaded news (browser) so both agree on "same title".
 */
export function headlineTitleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
