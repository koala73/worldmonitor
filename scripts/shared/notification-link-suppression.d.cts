export interface ParsedSuppressionEntries {
  urls: Set<string>;
  hosts: Set<string>;
}

export const HOST_ENTRY_PREFIX: string;
export function normalizeSuppressedUrl(raw: unknown): string | null;
export function normalizeSuppressedHost(raw: unknown): string | null;
export function parseSuppressionEntries(entries: unknown): ParsedSuppressionEntries;
export function isLinkSuppressed(candidate: unknown, parsed: ParsedSuppressionEntries): boolean;
