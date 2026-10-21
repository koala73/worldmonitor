import { afterEach, describe, expect, test, vi } from "vitest";
import { coerceAmount } from "../payments/subscriptionHelpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coerceAmount", () => {
  test("passes through a finite number", () => {
    expect(coerceAmount(1999)).toBe(1999);
    expect(coerceAmount(0)).toBe(0);
    expect(coerceAmount(-50)).toBe(-50);
  });

  test("parses a numeric string (Dodo dispute payloads send amount as string)", () => {
    expect(coerceAmount("9999")).toBe(9999);
    expect(coerceAmount(" 1999 ")).toBe(1999);
    expect(coerceAmount("12.5")).toBe(12.5);
  });

  test("returns 0 for missing or empty values", () => {
    expect(coerceAmount(undefined)).toBe(0);
    expect(coerceAmount(null)).toBe(0);
    expect(coerceAmount("")).toBe(0);
    expect(coerceAmount("   ")).toBe(0);
  });

  test("warns and returns 0 for non-numeric garbage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(coerceAmount("not-an-amount")).toBe(0);
    expect(coerceAmount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(coerceAmount({ cents: 9999 })).toBe(0);
    expect(coerceAmount(true)).toBe(0);

    expect(warn).toHaveBeenCalled();
  });
});
