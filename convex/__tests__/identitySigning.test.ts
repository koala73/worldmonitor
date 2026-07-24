/**
 * Tests for convex/lib/identitySigning.ts business-invite token helpers.
 *
 * These are pure crypto tests and run with node:test via tsx; they do not
 * need the Convex runtime because the helpers have no Convex imports.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  signBusinessInviteToken,
  verifyBusinessInviteToken,
} from "../lib/identitySigning";

const TEST_SECRET = "test-business-invite-secret-minimum-32-bytes-long";

describe("business invite token signing/verification", () => {
  before(() => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SECRET;
  });

  it("round-trips a valid token", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345678";
    const token = await signBusinessInviteToken(grantId);
    const ok = await verifyBusinessInviteToken(grantId, token);
    assert.equal(ok, true);
  });

  it("rejects an expired token", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345679";
    const token = await signBusinessInviteToken(grantId);
    // The token has a fixed 14-day TTL, so tamper the expiry segment to a
    // timestamp in the past to simulate expiration without waiting.
    const parts = token.split(".");
    assert.equal(parts.length, 3);
    parts[1] = String(Date.now() - 1000);
    const expiredToken = parts.join(".");
    const ok = await verifyBusinessInviteToken(grantId, expiredToken);
    assert.equal(ok, false);
  });

  it("rejects a token verified against a different grantId", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345680";
    const token = await signBusinessInviteToken(grantId);
    const ok = await verifyBusinessInviteToken(
      "k57c5e0m000000000000000000000000",
      token,
    );
    assert.equal(ok, false);
  });

  it("rejects a tampered expiry timestamp", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345681";
    const token = await signBusinessInviteToken(grantId);
    const parts = token.split(".");
    assert.equal(parts.length, 3);
    parts[1] = String(Date.now() + 86_400_000);
    const tampered = parts.join(".");
    const ok = await verifyBusinessInviteToken(grantId, tampered);
    assert.equal(ok, false);
  });

  it("rejects a token with a wrong/legacy version", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345682";
    const token = await signBusinessInviteToken(grantId);
    const parts = token.split(".");
    parts[0] = "v0";
    const legacy = parts.join(".");
    const ok = await verifyBusinessInviteToken(grantId, legacy);
    assert.equal(ok, false);
  });

  it("rejects a malformed token", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345683";
    const ok = await verifyBusinessInviteToken(grantId, "not-a-token");
    assert.equal(ok, false);
  });

  it("rejects a token signed for a different purpose (domain separation)", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345684";
    const token = await signBusinessInviteToken(grantId);
    // A foreign version label should break verification even if the signature
    // format happens to be parseable.
    const parts = token.split(".");
    parts[0] = "v1-claim";
    const foreign = parts.join(".");
    const ok = await verifyBusinessInviteToken(grantId, foreign);
    assert.equal(ok, false);
  });

  it("rejects an undefined token", async () => {
    const grantId = "k57c5e0m1234567890abcdef12345685";
    const ok = await verifyBusinessInviteToken(grantId, undefined);
    assert.equal(ok, false);
  });

  it("throws when signing an empty grantId", async () => {
    await assert.rejects(
      async () => signBusinessInviteToken(""),
      /business invite token requires a non-empty grantId/,
    );
  });

  it("throws when signing a grantId containing the delimiter", async () => {
    await assert.rejects(
      async () => signBusinessInviteToken("grant.with.dots"),
      /business invite grantId must not contain/,
    );
  });
});
