import { clampInt } from '../../../_shared/constants';

// Paging resolution for list-tech-events, shared by fetchTechEvents and
// filterEvents so both surfaces agree.
//
// An omitted query param decodes to 0 (Number(params.get("limit") ?? "0")), and
// clampInt treats a finite 0 as a value (→ min 1), NOT the fallback. Guard with
// `|| default` so an omitted param honors the documented "defaults to 50/90 when
// omitted" instead of collapsing to 1 (mirrors seismology `|| 500` and BLS
// `limit > 0 ? … : 60`). A negative value stays a real value and clamps to 1.
export function resolveTechEventsPaging(req: { limit?: number; days?: number }): {
  limit: number;
  days: number;
} {
  return {
    limit: clampInt(req.limit || 50, 50, 1, 200),
    days: clampInt(req.days || 90, 90, 1, 365),
  };
}
