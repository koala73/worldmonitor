/**
 * #6335 — the checkout stamps the authenticated login email into signed
 * metadata, so the activation webhook does not have to trust `users.email`
 * (refreshed only once per page load per userId).
 *
 * Lives in its own file because it mocks `../lib/dodo`: the sibling
 * checkout.test.ts deliberately runs with DODO_API_KEY unset so that reaching
 * the provider is itself an assertion, and a module-level mock there would
 * silently defeat that.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import { createDodoCheckoutSession } from "../lib/dodo";
import {
  CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS,
  verifyCheckoutLoginEmail,
  verifyUserId,
} from "../lib/identitySigning";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const SIGNING_SECRET = "checkout-login-email-test-signing-secret";
const PRODUCT_ID = "pdt_login_email_metadata";
const CLERK_USER = {
  subject: "user_login_email_metadata",
  tokenIdentifier: "clerk|user_login_email_metadata",
  email: "Fresh.Login@Example.com",
};

type StampedMetadata = Record<string, string>;

/** The metadata dictionary the action actually handed to the provider. */
function capturedMetadata(): StampedMetadata {
  expect(createDodoCheckoutSession).toHaveBeenCalledTimes(1);
  const payload = vi.mocked(createDodoCheckoutSession).mock.calls[0][0] as {
    metadata?: StampedMetadata;
  };
  return payload.metadata ?? {};
}

beforeEach(() => {
  process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
  vi.mocked(createDodoCheckoutSession).mockResolvedValue({
    checkout_url: "https://checkout.example/session",
  });
});

afterEach(() => {
  vi.mocked(createDodoCheckoutSession).mockReset();
  vi.restoreAllMocks();
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
});

describe("checkout stamps a signed login email (#6335)", () => {
  test("the authenticated action stamps a verifiable login email alongside the userId", async () => {
    const t = convexTest(schema, modules);

    await t
      .withIdentity(CLERK_USER)
      .action(api.payments.checkout.createCheckout, { productId: PRODUCT_ID });

    const metadata = capturedMetadata();
    // Case is preserved: the signature covers the exact bytes, and the local
    // part of an address is case-sensitive per RFC 5321.
    expect(metadata.wm_login_email).toBe("Fresh.Login@Example.com");
    expect(
      await verifyCheckoutLoginEmail(
        CLERK_USER.subject,
        metadata.wm_login_email,
        metadata.wm_login_email_sig,
        Date.now(),
      ),
    ).toBe("valid");
    // The pre-existing identity signature is untouched — folding the email into
    // it would strand every checkout session created before this deploy.
    expect(await verifyUserId(CLERK_USER.subject, metadata.wm_user_id_sig)).toBe(true);
  });

  test("the stamped token expires on the documented window, not never", async () => {
    const t = convexTest(schema, modules);

    await t
      .withIdentity(CLERK_USER)
      .action(api.payments.checkout.createCheckout, { productId: PRODUCT_ID });

    const metadata = capturedMetadata();
    const wellPastTheWindow = Date.now() + CHECKOUT_LOGIN_EMAIL_MAX_AGE_MS + 60_000;
    expect(
      await verifyCheckoutLoginEmail(
        CLERK_USER.subject,
        metadata.wm_login_email,
        metadata.wm_login_email_sig,
        wellPastTheWindow,
      ),
    ).toBe("expired");
  });

  // The production shape for a phone-only signup, or any session whose Clerk
  // JWT template omits the `email` claim. Driven through the PUBLIC action so
  // the `identity?.email` path itself is exercised, not just the relay's
  // explicit argument.
  test("the authenticated action stamps nothing when the identity carries no email", async () => {
    const t = convexTest(schema, modules);

    await t
      .withIdentity({
        subject: "user_no_email_claim",
        tokenIdentifier: "clerk|user_no_email_claim",
      })
      .action(api.payments.checkout.createCheckout, { productId: PRODUCT_ID });

    const metadata = capturedMetadata();
    expect(metadata.wm_login_email).toBeUndefined();
    expect(metadata.wm_login_email_sig).toBeUndefined();
    // Attribution is unaffected — the webhook still resolves the buyer.
    expect(metadata.wm_user_id).toBe("user_no_email_claim");
    expect(await verifyUserId("user_no_email_claim", metadata.wm_user_id_sig)).toBe(true);
  });

  test("the relay path stamps the email the edge gateway verified", async () => {
    const t = convexTest(schema, modules);

    await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: "user_relay_login_email",
      email: "  relay@example.com  ",
      productId: PRODUCT_ID,
    });

    const metadata = capturedMetadata();
    // Surrounding whitespace is stripped BEFORE signing, so the stamped value
    // and the signed value are the same bytes.
    expect(metadata.wm_login_email).toBe("relay@example.com");
    expect(
      await verifyCheckoutLoginEmail(
        "user_relay_login_email",
        metadata.wm_login_email,
        metadata.wm_login_email_sig,
        Date.now(),
      ),
    ).toBe("valid");
  });

  // The rejection case in the table below is 262 chars — far enough past the
  // 254 cap that `>` and `>=` are indistinguishable. These two pin the exact
  // edge so an off-by-one turns something red.
  test.each([
    ["exactly at the 254-char cap", 242, true],
    ["one char over the cap", 243, false],
  ])("a login email %s is stamped=%s", async (_label, localLength, shouldStamp) => {
    const email = `${"a".repeat(localLength)}@example.com`;
    expect(email.length).toBe(shouldStamp ? 254 : 255);
    const t = convexTest(schema, modules);

    await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: "user_login_email_length_edge",
      email,
      productId: PRODUCT_ID,
    });

    const metadata = capturedMetadata();
    expect(metadata.wm_login_email).toBe(shouldStamp ? email : undefined);
  });

  test.each([
    ["absent", undefined],
    ["blank", "   "],
    ["missing an @", "not-an-email"],
    ["double-@", "a@b@example.com"],
    ["missing a domain", "trailing@"],
    ["missing a local part", "@example.com"],
    ["whitespace-infixed", "spaced out@example.com"],
    ["over the RFC 5321 length cap", `${"a".repeat(250)}@example.com`],
  ])("an %s login email stamps nothing at all", async (_label, email) => {
    const t = convexTest(schema, modules);

    await t.action(internal.payments.checkout.internalCreateCheckout, {
      userId: "user_unusable_login_email",
      ...(email === undefined ? {} : { email }),
      productId: PRODUCT_ID,
    });

    const metadata = capturedMetadata();
    // Neither half: a bare email with no signature would be ignored by the
    // webhook anyway, but stamping it would put an unusable address on the
    // provider record for no benefit.
    expect(metadata.wm_login_email).toBeUndefined();
    expect(metadata.wm_login_email_sig).toBeUndefined();
    // The identity metadata the webhook actually attributes on is unaffected.
    expect(metadata.wm_user_id).toBe("user_unusable_login_email");
  });
});
