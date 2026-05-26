import { describe, expect, test } from "vitest";
import { inferLocaleFromEmail } from "../broadcast/_localeHeuristic";

describe("inferLocaleFromEmail — known providers (high confidence)", () => {
  test("qq.com → zh", () => {
    expect(inferLocaleFromEmail("user@qq.com")).toBe("zh");
  });

  test("yahoo.co.jp → ja (provider beats TLD)", () => {
    // Critical: provider Map MUST take precedence over the .jp TLD branch.
    // If TLD-first ordering ever sneaks in, we still match "ja" by accident
    // for yahoo.co.jp — but the test that catches the bug is naver.com →
    // ko (TLD `.com` is unmapped; only the provider lookup can return ko).
    expect(inferLocaleFromEmail("user@yahoo.co.jp")).toBe("ja");
  });

  test("naver.com → ko (TLD .com unmapped; provider lookup is the only path)", () => {
    expect(inferLocaleFromEmail("user@naver.com")).toBe("ko");
  });

  test("yandex.ru → ru", () => {
    expect(inferLocaleFromEmail("user@yandex.ru")).toBe("ru");
  });
});

describe("inferLocaleFromEmail — TLD fallback (narrow list)", () => {
  test("custom .cn domain → zh", () => {
    expect(inferLocaleFromEmail("user@example.cn")).toBe("zh");
  });

  test("custom .jp domain → ja", () => {
    expect(inferLocaleFromEmail("user@example.jp")).toBe("ja");
  });

  test("custom .ru domain → ru", () => {
    expect(inferLocaleFromEmail("user@example.ru")).toBe("ru");
  });

  test("custom .kr domain → ko", () => {
    expect(inferLocaleFromEmail("user@example.kr")).toBe("ko");
  });
});

describe("inferLocaleFromEmail — unknown / null returns", () => {
  test("gmail.com → null (universal provider)", () => {
    expect(inferLocaleFromEmail("user@gmail.com")).toBeNull();
  });

  test(".fr TLD → null (deliberately dropped from v1 — too many English-fluent users)", () => {
    expect(inferLocaleFromEmail("user@example.fr")).toBeNull();
  });

  test(".de / .es / .it dropped from v1", () => {
    expect(inferLocaleFromEmail("user@example.de")).toBeNull();
    expect(inferLocaleFromEmail("user@example.es")).toBeNull();
    expect(inferLocaleFromEmail("user@example.it")).toBeNull();
  });

  test(".co.uk → null (not in provider Map, .uk not in TLD list)", () => {
    expect(inferLocaleFromEmail("user@example.co.uk")).toBeNull();
  });
});

describe("inferLocaleFromEmail — defensive parsing", () => {
  test("uppercase domain normalised", () => {
    expect(inferLocaleFromEmail("user@QQ.COM")).toBe("zh");
  });

  test("whitespace trimmed", () => {
    expect(inferLocaleFromEmail("  user@qq.com  ")).toBe("zh");
  });

  test("empty / null / undefined → null", () => {
    expect(inferLocaleFromEmail("")).toBeNull();
    expect(inferLocaleFromEmail(null)).toBeNull();
    expect(inferLocaleFromEmail(undefined)).toBeNull();
  });

  test("malformed (no @) → null", () => {
    expect(inferLocaleFromEmail("not-an-email")).toBeNull();
  });

  test("malformed (no domain after @) → null", () => {
    expect(inferLocaleFromEmail("user@")).toBeNull();
  });

  test("malformed (no dot in domain) → null", () => {
    expect(inferLocaleFromEmail("user@localhost")).toBeNull();
  });
});
