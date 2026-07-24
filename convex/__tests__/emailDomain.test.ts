import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDomain, sameDomain, isCorporateDomain } from "../lib/emailDomain";

test("isCorporateDomain rejects free/consumer providers", () => {
  assert.equal(isCorporateDomain("user@gmail.com"), false);
  assert.equal(isCorporateDomain("user@outlook.com"), false);
  assert.equal(isCorporateDomain("user@yahoo.com"), false);
  assert.equal(isCorporateDomain("user@proton.me"), false);
  // Case-insensitive: the domain is lowercased before the free-list check.
  assert.equal(isCorporateDomain("User@GMAIL.com"), false);
});

test("isCorporateDomain rejects disposable domains", () => {
  // mailinator is a classic throwaway provider; mailchecker.isValid() -> false.
  assert.equal(isCorporateDomain("x@mailinator.com"), false);
});

test("isCorporateDomain accepts a real corporate domain", () => {
  assert.equal(isCorporateDomain("x@acme.com"), true);
  assert.equal(isCorporateDomain("jane.doe@acme.com"), true);
});

test("sameDomain is case-insensitive and rejects cross-domain", () => {
  assert.equal(sameDomain("a@Acme.com", "b@acme.com"), true);
  assert.equal(sameDomain("a@acme.com", "b@other.com"), false);
  // A malformed side can never match.
  assert.equal(sameDomain("a@acme.com", "not-an-email"), false);
});

test("extractDomain returns the lowercased domain for well-formed emails", () => {
  assert.equal(extractDomain("a@Acme.com"), "acme.com");
  assert.equal(extractDomain("  x@ACME.COM  "), "acme.com");
});

test("extractDomain returns null for malformed emails", () => {
  assert.equal(extractDomain(""), null);
  assert.equal(extractDomain("no-at"), null);
  assert.equal(extractDomain("a@"), null);
  assert.equal(extractDomain("@b.com"), null);
  assert.equal(extractDomain("a@b@c.com"), null);
});

test("isCorporateDomain is false for malformed emails", () => {
  assert.equal(isCorporateDomain(""), false);
  assert.equal(isCorporateDomain("no-at"), false);
  assert.equal(isCorporateDomain("a@"), false);
  assert.equal(isCorporateDomain("@b.com"), false);
  // Domain without a dot is not corporate even though it has a local + domain.
  assert.equal(isCorporateDomain("a@localhost"), false);
});
