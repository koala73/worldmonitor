import { resolveCountryCode } from '../../shared/country-code-resolve';
import { RpcValidationError } from './billing-denial';

/** Bound on the caller-supplied value echoed back in a resolution failure. */
const MAX_ECHOED_COUNTRY_INPUT = 64;

export function echoCountryInput(raw: unknown): string {
  // Never stringify a non-string. `String(x)` runs the value's own toString /
  // valueOf, and `{"toString":"x"}` is legal JSON a caller can send: the
  // shadowed, non-callable toString makes String() throw
  // `TypeError: Cannot convert object to primitive value`. That turns this
  // guard — whose whole job is to produce a clean 400 — into a 500. Describing
  // the type is also more useful to the caller than `[object Object]`.
  const text = typeof raw === 'string' ? raw.trim() : `<non-string ${typeof raw}>`;
  return text.length > MAX_ECHOED_COUNTRY_INPUT
    ? `${text.slice(0, MAX_ECHOED_COUNTRY_INPUT)}…`
    : text;
}

export const COUNTRY_ARG_HINT =
  'Pass an ISO 3166-1 alpha-2 code (e.g. "IQ"), an alpha-3 code ("IRQ"), or an English country name ("Iraq").';

export function requireCountryCode(raw: unknown, operation: string, field = 'country_code'): string {
  const resolved = resolveCountryCode(raw);
  if (resolved) return resolved;
  throw new RpcValidationError(operation, [{
    field,
    description: `Could not resolve ${JSON.stringify(echoCountryInput(raw))} to a country. ${COUNTRY_ARG_HINT}`,
  }]);
}

/** Omitted optional filters retain the unfiltered result; invalid entries do not. */
export function resolveCountryFilter(raw: unknown, field: string): string[] {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value) => requireCountryCode(value, 'country-filter', field).toLowerCase());
}
