/**
 * Shared Resend contacts/segments helpers used by audienceExport.ts
 * (full-audience push) and audienceWaveExport.ts (per-wave push).
 *
 * Lives at `_resendContacts.ts` (leading underscore mirrors the api/
 * convention for shared utility files; Convex itself doesn't enforce a
 * naming rule, the underscore is documentation that this isn't a public
 * action/query/mutation).
 *
 * Three API quirks are encoded here so both callers behave identically:
 *
 *   1. Resend's `POST /contacts` accepts a `segments: [{ id }]` body but
 *      DOES NOT apply that field on the duplicate-shaped 422 path. So a
 *      contact that already exists globally would not be added to our
 *      segment via the create call alone — we have to follow up with an
 *      explicit `POST /contacts/{email}/segments/{segmentId}`. Without
 *      that follow-up, anyone who's already a Resend contact (e.g.,
 *      from a prior import) silently gets skipped from our send. This
 *      was caught in PR #3431 review.
 *
 *   2. The 422 duplicate-error shape is heuristically matched on `name`
 *      and `message` because Resend doesn't pin the field — see
 *      `isDuplicateContactError` below.
 *
 *   3. A duplicate contact can be globally unsubscribed. Read its contact
 *      state before attaching it to a segment, and fail closed if that
 *      state is absent or malformed.
 */

export const RESEND_API_BASE = "https://api.resend.com";
export const USER_AGENT =
  "WorldMonitor-PROLaunchExporter/1.0 (+https://worldmonitor.app)";

/**
 * Heuristic for distinguishing duplicate-shaped 422 responses from other
 * 422-flavored validation errors (missing segment, invalid email,
 * unauthorized field, etc., which the caller wants to count as `failed`
 * and log).
 *
 * Resend's error shape on 422 is `{ name, message, statusCode }`.
 * Duplicate responses use names like `email_already_exists` /
 * `contact_already_exists` and messages mentioning "already". Match
 * generously on the message in case the `name` evolves.
 */
export function isDuplicateContactError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.toLowerCase() : "";
  const message = typeof obj.message === "string" ? obj.message.toLowerCase() : "";
  if (name.includes("already_exists") || name.includes("duplicate")) return true;
  if (/already (exists|in (the )?(audience|segment))|duplicate/.test(message))
    return true;
  return false;
}

function parseContactUnsubscribed(body: unknown): boolean | null {
  if (!body || typeof body !== "object") return null;
  const { unsubscribed } = body as { unsubscribed?: unknown };
  return typeof unsubscribed === "boolean" ? unsubscribed : null;
}

export type UpsertOutcome =
  | { kind: "created" }
  | { kind: "linkedExisting" }
  | { kind: "alreadyInSegment" }
  | { kind: "unsubscribed" }
  | { kind: "failed"; reason: string };

/**
 * Two-step contact-to-segment upsert. A globally unsubscribed existing
 * contact returns `unsubscribed` without being attached to `segmentId`.
 * See the file docstring for the API quirks this handles.
 */
export async function upsertContactToSegment(
  apiKey: string,
  email: string,
  segmentId: string,
): Promise<UpsertOutcome> {
  const createRes = await fetch(`${RESEND_API_BASE}/contacts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      email,
      segments: [{ id: segmentId }],
    }),
  });

  if (createRes.ok) return { kind: "created" };

  if (createRes.status === 422) {
    const createBody = await createRes.json().catch(() => null);
    if (!isDuplicateContactError(createBody)) {
      return {
        kind: "failed",
        reason: "POST /contacts 422 (non-duplicate)",
      };
    }

    // Contact exists globally. Read its consent state before attaching it
    // to our segment. Resend documents the contact lookup by email.
    const contactRes = await fetch(
      `${RESEND_API_BASE}/contacts/${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
        },
      },
    );
    if (!contactRes.ok) {
      return {
        kind: "failed",
        reason: `GET /contacts/{email} ${contactRes.status}`,
      };
    }
    const contactBody = await contactRes.json().catch(() => null);
    const unsubscribed = parseContactUnsubscribed(contactBody);
    if (unsubscribed === null) {
      return {
        kind: "failed",
        reason: "GET /contacts/{email} response missing boolean unsubscribed",
      };
    }
    if (unsubscribed) return { kind: "unsubscribed" };

    // The globally subscribed contact can be attached to our segment. Resend
    // does not document a conditional attach, so this cannot be atomic with
    // a later provider-side consent change.
    const addRes = await fetch(
      `${RESEND_API_BASE}/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
        },
      },
    );

    if (addRes.ok) return { kind: "linkedExisting" };

    if (addRes.status === 422) {
      const addBody = await addRes.json().catch(() => null);
      if (isDuplicateContactError(addBody)) return { kind: "alreadyInSegment" };
      return {
        kind: "failed",
        reason: "POST /contacts/{email}/segments/{id} 422 (non-duplicate)",
      };
    }

    return {
      kind: "failed",
      reason: `POST /contacts/{email}/segments/{id} ${addRes.status}`,
    };
  }

  return {
    kind: "failed",
    reason: `POST /contacts ${createRes.status}`,
  };
}

/**
 * Create a Resend segment by name. Returns the new segment id.
 *
 * `POST /segments` accepts a `name` only — segments are membership
 * lists, not query-defined (verified against Resend docs). Naming
 * convention for PRO-launch waves: `pro-launch-${waveLabel}` (e.g.
 * `pro-launch-wave-2`).
 */
export async function createSegment(
  apiKey: string,
  name: string,
): Promise<string> {
  const res = await fetch(`${RESEND_API_BASE}/segments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(
      `[createSegment] Resend POST /segments ${res.status}: ${body}`,
    );
  }

  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!json?.id) {
    throw new Error(
      `[createSegment] Resend response missing id: ${JSON.stringify(json)}`,
    );
  }
  return json.id;
}
