import { describe, expect, test } from "vitest";
import {
  collectSignatureCandidates,
  computeSvixSignature,
  decodeSvixSecret,
  MAX_SIGNATURE_CANDIDATES,
  STANDARD_WEBHOOK_HEADER_NAMES,
  SVIX_HEADER_NAMES,
  timingSafeEqualStrings,
  verifySvixSignature,
} from "../lib/svixVerify";

const SECRET_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const SECRET_BODY = btoa(String.fromCharCode(...SECRET_BYTES));
const SECRET = `whsec_${SECRET_BODY}`;
const PAYLOAD = JSON.stringify({ type: "user.deleted", data: { id: "user_1" } });
const NOW = 1_800_000_000;

async function signedHeaders(
  overrides: Partial<Record<"id" | "timestamp" | "signature", string | null>> = {},
  names = SVIX_HEADER_NAMES,
): Promise<Headers> {
  const id = overrides.id === undefined ? "msg_1" : overrides.id;
  const timestamp = overrides.timestamp === undefined ? String(NOW) : overrides.timestamp;
  const signature =
    overrides.signature === undefined
      ? `v1,${await computeSvixSignature(SECRET, id ?? "", timestamp ?? "", PAYLOAD)}`
      : overrides.signature;
  const headers = new Headers();
  if (id !== null) headers.set(names.id, id);
  if (timestamp !== null) headers.set(names.timestamp, timestamp);
  if (signature !== null) headers.set(names.signature, signature);
  return headers;
}

describe("timingSafeEqualStrings", () => {
  test("equal strings compare equal; different or different-length strings do not", async () => {
    expect(await timingSafeEqualStrings("abc", "abc")).toBe(true);
    expect(await timingSafeEqualStrings("abc", "abd")).toBe(false);
    expect(await timingSafeEqualStrings("abc", "abcd")).toBe(false);
    expect(await timingSafeEqualStrings("", "")).toBe(true);
  });
});

describe("decodeSvixSecret", () => {
  test("strips only an anchored whsec_ prefix and accepts a bare base64 body", () => {
    expect(decodeSvixSecret(SECRET)).toEqual(SECRET_BYTES);
    expect(decodeSvixSecret(SECRET_BODY)).toEqual(SECRET_BYTES);
  });

  test("does not strip the prefix from inside the body (the unanchored replace bug)", () => {
    // `"whsec_"` sits after a real prefix; an unanchored replace would remove
    // the leading one and leave a body that is not base64, while the anchored
    // strip removes exactly one leading prefix. Both then hand the remaining
    // string to atob, so the observable difference is which string it sees.
    const doubled = `whsec_${SECRET_BODY}`;
    expect(decodeSvixSecret(doubled)).toEqual(SECRET_BYTES);
    expect(() => decodeSvixSecret("whsec_whsec_AAAA")).toThrow();
  });
});

describe("collectSignatureCandidates", () => {
  test("keeps v1 values in order and drops other versions, empty values and malformed parts", () => {
    expect(collectSignatureCandidates("v1,aaa v2,bbb v1, v1,ccc,extra v1,ddd")).toEqual(["aaa", "ddd"]);
  });

  test("is bounded by MAX_SIGNATURE_CANDIDATES", () => {
    const parts = Array.from({ length: MAX_SIGNATURE_CANDIDATES + 3 }, (_, i) => `v1,sig${i}`);
    expect(collectSignatureCandidates(parts.join(" "))).toHaveLength(MAX_SIGNATURE_CANDIDATES);
    expect(collectSignatureCandidates(parts.join(" "), 2)).toEqual(["sig0", "sig1"]);
  });
});

describe("verifySvixSignature", () => {
  test("accepts a correctly signed delivery under svix-* headers", async () => {
    const result = await verifySvixSignature(PAYLOAD, await signedHeaders(), SECRET, { nowSeconds: NOW });
    expect(result).toEqual({ ok: true });
  });

  test("accepts the same delivery under webhook-* header names", async () => {
    const headers = await signedHeaders({}, STANDARD_WEBHOOK_HEADER_NAMES);
    const rejectedAsSvix = await verifySvixSignature(PAYLOAD, headers, SECRET, { nowSeconds: NOW });
    expect(rejectedAsSvix).toEqual({ ok: false, reason: "missing_headers" });
    const accepted = await verifySvixSignature(PAYLOAD, headers, SECRET, {
      nowSeconds: NOW,
      headerNames: STANDARD_WEBHOOK_HEADER_NAMES,
    });
    expect(accepted).toEqual({ ok: true });
  });

  test("names each missing header as missing_headers", async () => {
    for (const key of ["id", "timestamp", "signature"] as const) {
      const result = await verifySvixSignature(PAYLOAD, await signedHeaders({ [key]: null }), SECRET, {
        nowSeconds: NOW,
      });
      expect(result, key).toEqual({ ok: false, reason: "missing_headers" });
    }
  });

  test("rejects a timestamp that is not integer seconds", async () => {
    // An empty header value reads as absent (missing_headers), so it is not in this list.
    for (const timestamp of ["abc", "1e9", "1.5", `${NOW}abc`, "-1"]) {
      const result = await verifySvixSignature(PAYLOAD, await signedHeaders({ timestamp }), SECRET, {
        nowSeconds: NOW,
      });
      expect(result, timestamp).toEqual({ ok: false, reason: "invalid_timestamp" });
    }
  });

  test("enforces the skew window on both sides with an inclusive boundary", async () => {
    const at = async (offset: number, skewSeconds = 300) =>
      verifySvixSignature(PAYLOAD, await signedHeaders({ timestamp: String(NOW + offset) }), SECRET, {
        nowSeconds: NOW,
        skewSeconds,
      });
    expect(await at(-300)).toEqual({ ok: true });
    expect(await at(300)).toEqual({ ok: true });
    expect(await at(-301)).toEqual({ ok: false, reason: "timestamp_too_old" });
    expect(await at(301)).toEqual({ ok: false, reason: "timestamp_too_new" });
    expect(await at(-31, 30)).toEqual({ ok: false, reason: "timestamp_too_old" });
  });

  test("rejects a wrong signature, a tampered payload and a foreign secret", async () => {
    const headers = await signedHeaders();
    expect(await verifySvixSignature(`${PAYLOAD} `, headers, SECRET, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: "no_matching_signature",
    });
    const other = `whsec_${btoa(String.fromCharCode(...SECRET_BYTES.map((b) => b ^ 0xff)))}`;
    expect(await verifySvixSignature(PAYLOAD, headers, other, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: "no_matching_signature",
    });
    const wrong = await signedHeaders({ signature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    expect(await verifySvixSignature(PAYLOAD, wrong, SECRET, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: "no_matching_signature",
    });
  });

  test("verifies through a key rotation but fails closed past the candidate cap", async () => {
    const real = await computeSvixSignature(SECRET, "msg_1", String(NOW), PAYLOAD);
    const rotation = await signedHeaders({ signature: `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1,${real}` });
    expect(await verifySvixSignature(PAYLOAD, rotation, SECRET, { nowSeconds: NOW })).toEqual({ ok: true });

    const padding = Array.from({ length: MAX_SIGNATURE_CANDIDATES }, (_, i) => `v1,${btoa(`pad${i}`)}`);
    const buried = await signedHeaders({ signature: [...padding, `v1,${real}`].join(" ") });
    expect(await verifySvixSignature(PAYLOAD, buried, SECRET, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: "no_matching_signature",
    });
  });

  test("ignores a malformed candidate instead of partially parsing it", async () => {
    const real = await computeSvixSignature(SECRET, "msg_1", String(NOW), PAYLOAD);
    const malformed = await signedHeaders({ signature: `v1,${real},extra` });
    expect(await verifySvixSignature(PAYLOAD, malformed, SECRET, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: "no_matching_signature",
    });
  });
});
