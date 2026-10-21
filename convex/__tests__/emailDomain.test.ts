import { describe, expect, test } from "vitest";
import { extractDomain, sameDomain, isCorporateDomain } from "../lib/emailDomain";

describe("emailDomain", () => {
  test("isCorporateDomain rejects free/consumer providers", () => {
    expect(isCorporateDomain("user@gmail.com")).toBe(false);
    expect(isCorporateDomain("user@outlook.com")).toBe(false);
    expect(isCorporateDomain("user@yahoo.com")).toBe(false);
    expect(isCorporateDomain("user@proton.me")).toBe(false);
    // Case-insensitive: the domain is lowercased before the free-list check.
    expect(isCorporateDomain("User@GMAIL.com")).toBe(false);
  });

  test("isCorporateDomain rejects disposable domains", () => {
    // mailinator is a classic throwaway provider; mailchecker.isValid() -> false.
    expect(isCorporateDomain("x@mailinator.com")).toBe(false);
  });

  test("isCorporateDomain accepts a real corporate domain", () => {
    expect(isCorporateDomain("x@acme.com")).toBe(true);
    expect(isCorporateDomain("jane.doe@acme.com")).toBe(true);
  });

  test("sameDomain is case-insensitive and rejects cross-domain", () => {
    expect(sameDomain("a@Acme.com", "b@acme.com")).toBe(true);
    expect(sameDomain("a@acme.com", "b@other.com")).toBe(false);
    // A malformed side can never match.
    expect(sameDomain("a@acme.com", "not-an-email")).toBe(false);
  });

  test("extractDomain returns the lowercased domain for well-formed emails", () => {
    expect(extractDomain("a@Acme.com")).toBe("acme.com");
    expect(extractDomain("  x@ACME.COM  ")).toBe("acme.com");
  });

  test("extractDomain returns null for malformed emails", () => {
    expect(extractDomain("")).toBeNull();
    expect(extractDomain("no-at")).toBeNull();
    expect(extractDomain("a@")).toBeNull();
    expect(extractDomain("@b.com")).toBeNull();
    expect(extractDomain("a@b@c.com")).toBeNull();
  });

  test("isCorporateDomain is false for malformed emails", () => {
    expect(isCorporateDomain("")).toBe(false);
    expect(isCorporateDomain("no-at")).toBe(false);
    expect(isCorporateDomain("a@")).toBe(false);
    expect(isCorporateDomain("@b.com")).toBe(false);
    // Domain without a dot is not corporate even though it has a local + domain.
    expect(isCorporateDomain("a@localhost")).toBe(false);
  });
});
