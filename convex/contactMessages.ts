import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Field length caps. Aligned with `server/worldmonitor/leads/v1/submit-contact.ts`,
// which already enforces these bounds at the edge — duplicating them here means
// a direct Convex client call (bypassing the edge) cannot fill the table with
// arbitrarily large blobs.
const MAX_NAME = 500;
const MAX_EMAIL = 254;          // RFC 5321
const MAX_ORG = 500;
const MAX_PHONE = 30;
const MAX_MESSAGE = 2000;
const MAX_SOURCE = 100;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per-email throttle. Convex mutations don't have a request IP, so we bucket
// by normalized email — a low-effort DoS would have to rotate emails to evade
// it, which already makes the spam less useful and tends to fail edge-side
// validation (free-email blocklist + Turnstile).
const PER_EMAIL_WINDOW_MS = 60 * 60 * 1000;   // 1h
const PER_EMAIL_LIMIT = 5;                    // submissions per email per window

// Strict policy: strip ALL C0 controls + DEL. Used for short single-line
// fields where CR/LF could enable header- or log-forging when the value is
// later interpolated into single-line output (email subjects, log lines).
const STRICT_CONTROL_RE = /[\x00-\x1F\x7F]/g;
// Multiline policy: preserve TAB (\x09), LF (\x0A). Used for `message` so
// enterprise-contact prose retains line breaks and indentation. CR (\x0D)
// stays stripped — Windows-style line endings collapse to LF, which is what
// downstream consumers (email subjects, log lines) expect.
const MULTILINE_CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F]/g;

function clip(
  value: string | undefined,
  max: number,
  opts: { preserveNewlines?: boolean } = {},
): string | undefined {
  if (value === undefined) return undefined;
  const re = opts.preserveNewlines ? MULTILINE_CONTROL_RE : STRICT_CONTROL_RE;
  const cleaned = value.replace(re, "").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, max);
}

export const submit = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    organization: v.optional(v.string()),
    phone: v.optional(v.string()),
    message: v.optional(v.string()),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    // Length / shape validation. Reject obviously-bogus input before
    // it reaches the table — also a defence against prompt-injection
    // payloads enormous enough to trip downstream LLM cost.
    const name = clip(args.name, MAX_NAME);
    const email = clip(args.email, MAX_EMAIL);
    const organization = clip(args.organization, MAX_ORG);
    const phone = clip(args.phone, MAX_PHONE);
    const message = clip(args.message, MAX_MESSAGE, { preserveNewlines: true });
    const source = clip(args.source, MAX_SOURCE) ?? "unknown";

    if (!name) throw new ConvexError("Name is required");
    if (!email || !EMAIL_RE.test(email)) {
      throw new ConvexError("Valid email is required");
    }

    const normalizedEmail = email.toLowerCase();

    // Throttle: cap recent submissions per email. Index lookup keeps this O(matches),
    // which the limit caps at PER_EMAIL_LIMIT + 1.
    const windowStart = Date.now() - PER_EMAIL_WINDOW_MS;
    const recent = await ctx.db
      .query("contactMessages")
      .withIndex("by_normalized_email_received", (q) =>
        q.eq("normalizedEmail", normalizedEmail).gte("receivedAt", windowStart),
      )
      .take(PER_EMAIL_LIMIT + 1);

    if (recent.length >= PER_EMAIL_LIMIT) {
      throw new ConvexError({
        kind: "rate_limited",
        message: "Too many recent submissions for this email; try again later.",
      });
    }

    await ctx.db.insert("contactMessages", {
      name,
      email,
      organization,
      phone,
      message,
      source,
      receivedAt: Date.now(),
      normalizedEmail,
    });
    return { status: "sent" as const };
  },
});
