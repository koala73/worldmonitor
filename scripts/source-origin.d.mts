export const INTERNATIONAL_FILTER: 'intl';

export function inferOriginFromHost(host: string): string | null | undefined;
export function resolveHostOrigin(host: string): string | null | undefined;
export function resolveSourceOrigin(input?: {
  provider?: string;
  hosts?: string[];
}): string | null;
export function sourceOriginLabel(code: string | null | undefined): string;
export function sourceOriginFilterValue(code: string | null | undefined): string;
export function catalogCountryOptions(sourceCatalog: Array<{
  originCountry?: string | null;
}>): Array<{ code: string; name: string }>;
export function assertKnownOriginCode(code: string | null | undefined, label: string): void;
