import { clampInt } from '../../../_shared/constants';

// Paging resolution for list-tech-events, shared by fetchTechEvents and
// filterEvents so both surfaces agree.
//
// The generated REST decoder maps an omitted int32 query param to 0, which is
// also a valid explicit value. Handler code passes query-param presence so we
// can default omitted values while preserving the documented "0 clamps to 1"
// behavior for callers that explicitly send zero.
export interface TechEventsPagingPresence {
  hasLimit?: boolean;
  hasDays?: boolean;
}

function valueOrDefault(value: number | undefined, fallback: number, isPresent: boolean | undefined): number {
  if (isPresent === false || value === undefined) return fallback;
  return value;
}

export function resolveTechEventsPaging(
  req: { limit?: number; days?: number },
  presence: TechEventsPagingPresence = {},
): {
  limit: number;
  days: number;
} {
  return {
    limit: clampInt(valueOrDefault(req.limit, 50, presence.hasLimit), 50, 1, 200),
    days: clampInt(valueOrDefault(req.days, 90, presence.hasDays), 90, 1, 365),
  };
}
