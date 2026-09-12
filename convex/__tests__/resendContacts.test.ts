import { afterEach, describe, expect, test, vi } from "vitest";
import { upsertContactToSegment } from "../broadcast/_resendContacts";

const EMAIL = "unsubscribed@example.com";
const SEGMENT_ID = "seg_test";

describe("Resend contact upsert consent handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("omits the subscription state when it creates a contact", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "contact_created" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upsertContactToSegment("resend_test_key", EMAIL, SEGMENT_ID),
    ).resolves.toEqual({ kind: "created" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/contacts");
    expect(JSON.parse(String(init.body))).toEqual({
      email: EMAIL,
      segments: [{ id: SEGMENT_ID }],
    });
  });

  test("does not add an existing globally-unsubscribed contact to a segment", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "contact_already_exists",
        message: "Contact already exists",
      }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        email: EMAIL,
        unsubscribed: true,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upsertContactToSegment("resend_test_key", EMAIL, SEGMENT_ID),
    ).resolves.toEqual({ kind: "unsubscribed" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://api.resend.com/contacts/unsubscribed%40example.com",
    );
  });

  test("adds an existing subscribed contact after reading its status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "contact_already_exists",
        message: "Contact already exists",
      }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        email: EMAIL,
        unsubscribed: false,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upsertContactToSegment("resend_test_key", EMAIL, SEGMENT_ID),
    ).resolves.toEqual({ kind: "linkedExisting" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]![0]).toBe(
      "https://api.resend.com/contacts/unsubscribed%40example.com/segments/seg_test",
    );
  });

  test("fails closed when the existing contact response lacks a boolean subscription state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "contact_already_exists",
        message: "Contact already exists",
      }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: EMAIL }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upsertContactToSegment("resend_test_key", EMAIL, SEGMENT_ID),
    ).resolves.toMatchObject({ kind: "failed" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not expose a Resend contact-read error body", async () => {
    const providerBody = "provider diagnostic for unsubscribed@example.com";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "contact_already_exists",
        message: "Contact already exists",
      }), { status: 422 }))
      .mockResolvedValueOnce(new Response(providerBody, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertContactToSegment(
      "resend_test_key",
      EMAIL,
      SEGMENT_ID,
    );

    expect(result).toEqual({
      kind: "failed",
      reason: "GET /contacts/{email} 500",
    });
    expect(JSON.stringify(result)).not.toContain(providerBody);
  });
});
