/**
 * Tests for convex/lib/identitySigning.ts business-invite and checkout
 * login-email token helpers.
 *
 * These are pure crypto tests; they do not need the Convex runtime because
 * the helpers have no Convex imports.
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
  CHECKOUT_LOGIN_EMAIL_CLOCK_SKEW_MS,
  CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS,
  signBusinessInviteToken,
  signCheckoutLoginEmail,
  signUserId,
  verifyBusinessInviteToken,
  verifyCheckoutLoginEmail,
  verifyUserId,
} from "../lib/identitySigning";

const TEST_SECRET = "test-business-invite-secret-minimum-32-bytes-long";

describe("business invite token signing/verification", () => {
  beforeEach(() => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SECRET;
  });

  test("round-trips a valid token", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345678";
    const token = await signBusinessInviteToken(grantId);
    const ok = await verifyBusinessInviteToken(grantId, token);
    expect(ok).toBe(true);
  });

  test("rejects an expired token", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345679";
    const token = await signBusinessInviteToken(grantId);
    // The token has a fixed 14-day TTL, so tamper the expiry segment to a
    // timestamp in the past to simulate expiration without waiting.
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    parts[1] = String(Date.now() - 1000);
    const expiredToken = parts.join(".");
    const ok = await verifyBusinessInviteToken(grantId, expiredToken);
    expect(ok).toBe(false);
  });

  test("rejects a token verified against a different grantId", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345680";
    const token = await signBusinessInviteToken(grantId);
    const ok = await verifyBusinessInviteToken(
      "k57c5e0m000000000000000000000000",
      token,
    );
    expect(ok).toBe(false);
  });

  test("rejects a tampered expiry timestamp", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345681";
    const token = await signBusinessInviteToken(grantId);
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    parts[1] = String(Date.now() + 86_400_000);
    const tampered = parts.join(".");
    const ok = await verifyBusinessInviteToken(grantId, tampered);
    expect(ok).toBe(false);
  });

  test("rejects a token with a wrong/legacy version", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345682";
    const token = await signBusinessInviteToken(grantId);
    const parts = token.split(".");
    parts[0] = "v0";
    const legacy = parts.join(".");
    const ok = await verifyBusinessInviteToken(grantId, legacy);
    expect(ok).toBe(false);
  });

  test("rejects a malformed token", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345683";
    const ok = await verifyBusinessInviteToken(grantId, "not-a-token");
    expect(ok).toBe(false);
  });

  test("rejects a token signed for a different purpose (domain separation)", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345684";
    const token = await signBusinessInviteToken(grantId);
    // A foreign version label should break verification even if the signature
    // format happens to be parseable.
    const parts = token.split(".");
    parts[0] = "v1-claim";
    const foreign = parts.join(".");
    const ok = await verifyBusinessInviteToken(grantId, foreign);
    expect(ok).toBe(false);
  });

  test("rejects an undefined token", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345685";
    const ok = await verifyBusinessInviteToken(grantId, undefined);
    expect(ok).toBe(false);
  });

  test("throws when signing an empty grantId", async () => {
    await expect(signBusinessInviteToken("")).rejects.toThrow(
      /business invite token requires a non-empty grantId/,
    );
  });

  test("throws when signing a grantId containing the delimiter", async () => {
    await expect(signBusinessInviteToken("grant.with.dots")).rejects.toThrow(
      /business invite grantId must not contain/,
    );
  });
});

// ---------------------------------------------------------------------------
// #6335 — checkout login-email token. Both the issuing and the verifying clock
// are parameters, never Date.now(), so every boundary below is exercisable.
// ---------------------------------------------------------------------------

describe("checkout login-email token signing/verification", () => {
  const USER = "user_login_email_001";
  const EMAIL = "login@example.com";
  const ISSUED_AT = new Date("2026-03-21T10:00:00Z").getTime();

  beforeEach(() => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SECRET;
  });

  test("round-trips the exact userId + email that were signed", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    expect(await verifyCheckoutLoginEmail(USER, EMAIL, token, ISSUED_AT)).toBe("valid");
  });

  test("rejects the same email under a different userId", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    expect(
      await verifyCheckoutLoginEmail("user_other_002", EMAIL, token, ISSUED_AT),
    ).toBe("invalid");
  });

  test("rejects a swapped email under the signed userId", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    expect(
      await verifyCheckoutLoginEmail(USER, "attacker@example.com", token, ISSUED_AT),
    ).toBe("invalid");
  });

  test("rejects a case-changed email — the signature covers the exact bytes", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    expect(
      await verifyCheckoutLoginEmail(USER, "Login@example.com", token, ISSUED_AT),
    ).toBe("invalid");
  });

  // The field boundary is length-prefixed, so no (userId, email) pair can be
  // re-cut into another pair with the same signing payload.
  //
  // The inputs below are chosen so that WITHOUT the length prefix the two pairs
  // would produce a byte-identical payload — `user:a` + ":" + `b@example.com`
  // and `user` + ":" + `a:b@example.com` both concatenate to
  // `user:a:b@example.com`. A userId containing the separator is what makes the
  // collision constructible at all; a colon-free userId (every real Clerk id)
  // cannot collide even unprefixed, so testing with one would assert nothing
  // about this guard. Verified by mutation: dropping `${userId.length}:` from
  // the payload turns this test red.
  test("rejects a userId/email split moved across the field boundary", async () => {
    const token = await signCheckoutLoginEmail("user:a", "b@example.com", ISSUED_AT);
    expect(
      await verifyCheckoutLoginEmail("user:a", "b@example.com", token, ISSUED_AT),
    ).toBe("valid");
    expect(
      await verifyCheckoutLoginEmail("user", "a:b@example.com", token, ISSUED_AT),
    ).toBe("invalid");
  });

  // Aging out is `expired`, NOT `invalid` — the caller logs the two at
  // different volumes because a mature subscription produces the former on
  // every `subscription.updated`, by design.
  test("accepts a token at the exact max-age boundary and expires one past it", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    expect(
      await verifyCheckoutLoginEmail(
        USER,
        EMAIL,
        token,
        ISSUED_AT + CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS,
      ),
    ).toBe("valid");
    expect(
      await verifyCheckoutLoginEmail(
        USER,
        EMAIL,
        token,
        ISSUED_AT + CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS + 1,
      ),
    ).toBe("expired");
  });

  // An implausibly future-dated token could only have come from our own signer,
  // so it is a clock anomaly worth a warning — `invalid`, not `expired`.
  test("tolerates reverse clock skew up to the allowance and no further", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    expect(
      await verifyCheckoutLoginEmail(
        USER,
        EMAIL,
        token,
        ISSUED_AT - CHECKOUT_LOGIN_EMAIL_CLOCK_SKEW_MS,
      ),
    ).toBe("valid");
    expect(
      await verifyCheckoutLoginEmail(
        USER,
        EMAIL,
        token,
        ISSUED_AT - CHECKOUT_LOGIN_EMAIL_CLOCK_SKEW_MS - 1,
      ),
    ).toBe("invalid");
  });

  // The signature is checked BEFORE the age window, so a forged token cannot
  // launder itself into the quiet `expired` bucket by carrying an old issuedAt.
  // Without that ordering this returns "expired" and the tamper warning is lost.
  test("a forged old token is invalid, never merely expired", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    const [version, issuedAtRaw] = token.split(".");
    const forged = `${version}.${issuedAtRaw}.${"0".repeat(64)}`;
    expect(
      await verifyCheckoutLoginEmail(
        USER,
        EMAIL,
        forged,
        ISSUED_AT + CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS + 1,
      ),
    ).toBe("invalid");
    // Same for a real signature replayed onto a different account past the window.
    expect(
      await verifyCheckoutLoginEmail(
        "user_other_002",
        EMAIL,
        token,
        ISSUED_AT + CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS + 1,
      ),
    ).toBe("invalid");
  });

  test("rejects a tampered issuedAt segment", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    parts[1] = String(ISSUED_AT + 60_000);
    expect(
      await verifyCheckoutLoginEmail(USER, EMAIL, parts.join("."), ISSUED_AT),
    ).toBe("invalid");
  });

  // `Number("+1774087200000")` parses fine and is a safe integer, so the later
  // `Number.isSafeInteger` backstop accepts it — only the `^\d+$` test rejects
  // the non-canonical spelling. Because verification re-signs over the PARSED
  // number, the original signature still matches, so this token would verify
  // without the digits-only guard. The generic "not-a-number" case below cannot
  // show that: NaN is caught by the backstop, giving two paths to one verdict.
  test("rejects a non-canonical numeric issuedAt that still parses and verifies", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    const [version, issuedAtRaw, signature] = token.split(".");
    expect(Number(`+${issuedAtRaw}`)).toBe(ISSUED_AT);
    expect(
      await verifyCheckoutLoginEmail(
        USER,
        EMAIL,
        `${version}.+${issuedAtRaw}.${signature}`,
        ISSUED_AT,
      ),
    ).toBe("invalid");
  });

  test.each([
    ["a wrong version label", (parts: string[]) => { parts[0] = "v0"; }],
    ["a foreign version label", (parts: string[]) => { parts[0] = "v1-claim"; }],
    ["a non-numeric issuedAt", (parts: string[]) => { parts[1] = "not-a-number"; }],
    ["an empty signature", (parts: string[]) => { parts[2] = ""; }],
    ["an extra segment", (parts: string[]) => { parts.push("extra"); }],
  ])("rejects %s", async (_label, mutate) => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    const parts = token.split(".");
    mutate(parts);
    expect(
      await verifyCheckoutLoginEmail(USER, EMAIL, parts.join("."), ISSUED_AT),
    ).toBe("invalid");
  });

  test.each([
    ["a malformed token", "not-a-token"],
    ["an empty token", ""],
    ["an undefined token", undefined],
  ])("rejects %s", async (_label, token) => {
    expect(await verifyCheckoutLoginEmail(USER, EMAIL, token, ISSUED_AT)).toBe("invalid");
  });

  // Without the `Number.isFinite(nowMs)` guard this is a silent bypass, not a
  // crash: `NaN - issuedAt` is NaN, and both `NaN > MAX_AGE` and
  // `NaN < -SKEW` are false, so an ancient token would sail through the age
  // window entirely. The guard is the only thing that makes it fail closed.
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects a non-finite verifying clock (%s)", async (_label, clock) => {
    const ancient = await signCheckoutLoginEmail(
      USER,
      EMAIL,
      ISSUED_AT - CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS * 52,
    );
    expect(await verifyCheckoutLoginEmail(USER, EMAIL, ancient, clock)).toBe("invalid");
  });

  test("rejects an empty userId or email", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    expect(await verifyCheckoutLoginEmail("", EMAIL, token, ISSUED_AT)).toBe("invalid");
    expect(await verifyCheckoutLoginEmail(USER, "", token, ISSUED_AT)).toBe("invalid");
  });

  // Domain separation: a wm_user_id_sig is a bare hex HMAC, so it must not
  // parse as — nor be replayable as — a login-email token, and vice versa.
  test("does not accept a wm_user_id signature as a login-email token", async () => {
    const userSig = await signUserId(USER);
    expect(await verifyCheckoutLoginEmail(USER, EMAIL, userSig, ISSUED_AT)).toBe("invalid");
    expect(
      await verifyCheckoutLoginEmail(USER, EMAIL, `v1.${ISSUED_AT}.${userSig}`, ISSUED_AT),
    ).toBe("invalid");
  });

  // The other direction. Both tokens share one signing secret, so a login-email
  // signature reaching the identity bridge as `wm_user_id_sig` would let a
  // buyer's own token stand in for the identity proof the webhook attributes on.
  test("a login-email signature is not accepted as a wm_user_id signature", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    const [, , loginEmailSig] = token.split(".");
    expect(await verifyUserId(USER, loginEmailSig)).toBe(false);
    expect(await verifyUserId(USER, token)).toBe(false);
  });

  test("throws when signing without an email or userId", async () => {
    await expect(signCheckoutLoginEmail("", EMAIL, ISSUED_AT)).rejects.toThrow(
      /requires a non-empty userId/,
    );
    await expect(signCheckoutLoginEmail(USER, "", ISSUED_AT)).rejects.toThrow(
      /requires a non-empty email/,
    );
  });

  test("throws when signing with a non-integer issuedAt", async () => {
    await expect(signCheckoutLoginEmail(USER, EMAIL, Number.NaN)).rejects.toThrow(
      /requires a non-negative integer issuedAt/,
    );
    await expect(signCheckoutLoginEmail(USER, EMAIL, 1.5)).rejects.toThrow(
      /requires a non-negative integer issuedAt/,
    );
  });

  // The verifier parses issuedAt with `^\d+$`, which has no sign — so a signer
  // that accepted a negative value could mint a token this module's own
  // verifier always calls invalid.
  test("throws rather than minting a token its own verifier would reject", async () => {
    await expect(signCheckoutLoginEmail(USER, EMAIL, -1)).rejects.toThrow(
      /requires a non-negative integer issuedAt/,
    );
  });

  test("fails closed when the signing secret is absent", async () => {
    const token = await signCheckoutLoginEmail(USER, EMAIL, ISSUED_AT);
    delete process.env.DODO_IDENTITY_SIGNING_SECRET;
    expect(await verifyCheckoutLoginEmail(USER, EMAIL, token, ISSUED_AT)).toBe("invalid");
  });
});
