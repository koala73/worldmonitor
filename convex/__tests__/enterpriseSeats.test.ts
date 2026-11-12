/**
 * Self-serve Enterprise seats (convex/enterpriseSeats.ts): the account admin
 * invites, lists and removes; the invitee accepts the emailed token.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { signBusinessInviteToken, signEnterpriseInviteToken } from "../lib/identitySigning";

const modules = import.meta.glob("../**/*.ts");

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTRACT_END = NOW + 365 * DAY_MS;
const ADMIN = "user_hexion_admin";
const MEMBER = "user_hexion_member";
const INVITEE = "user_hexion_invitee";
const OTHER = "user_other_company";

const identity = (userId: string, email: string) => ({
  subject: userId,
  tokenIdentifier: `clerk|${userId}`,
  email,
});
const ADMIN_ID = identity(ADMIN, "admin@hexion.com");
const MEMBER_ID = identity(MEMBER, "member@hexion.com");
const INVITEE_ID = identity(INVITEE, "new.person@hexion.com");

const BASE_ACCOUNT = {
  name: "Hexion",
  contractStart: NOW - DAY_MS,
  contractEnd: CONTRACT_END,
  dailyRequestAllowance: 10_000,
  perMinuteBurst: 300,
  monthlyInputTokens: 15_000_000,
  monthlyOutputTokens: 3_000_000,
  overagePerThousandRequestsUsd: 3,
  overagePerMillionInputTokensUsd: 4,
  overagePerMillionOutputTokensUsd: 20,
  seatCap: 3,
  allowedProviders: ["anthropic"],
};

type T = ReturnType<typeof convexTest>;

async function setup(overrides: Partial<typeof BASE_ACCOUNT> = {}) {
  const t = convexTest(schema, modules);
  const { accountId } = await t.mutation(internal.enterpriseAccounts.createAccount, { ...BASE_ACCOUNT, ...overrides });
  await t.mutation(internal.enterpriseAccounts.addMemberByUserId, { accountId, userId: ADMIN, role: "admin" });
  await t.mutation(internal.enterpriseAccounts.addMemberByUserId, { accountId, userId: MEMBER });
  return { t, accountId: accountId as Id<"enterpriseAccounts"> };
}

async function invite(t: T, email: string) {
  const { invited } = await t.withIdentity(ADMIN_ID).mutation(api.enterpriseSeats.inviteMembers, { emails: [email] });
  return invited[0]!;
}

async function row(t: T, memberId: string) {
  return t.run((ctx) => ctx.db.get(memberId as Id<"enterpriseMembers">));
}

async function planKey(t: T, userId: string) {
  return (await t.query(internal.entitlements.getEntitlementsByUserId, { userId })).planKey;
}

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "test-enterprise-invite-secret");
  vi.stubEnv("RESEND_API_KEY", "test-resend-key");
  fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ id: "resend-ok" }), { status: 200 }),
  );
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  fetchMock.mockRestore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("inviteMembers", () => {
  test("creates a pending seat with a 14-day expiry and emails a link bound to it", async () => {
    const { t, accountId } = await setup();
    const result = await invite(t, "New.Person@Hexion.com ");
    expect(result).toMatchObject({ email: "new.person@hexion.com", status: "created" });
    expect(await row(t, result.memberId)).toMatchObject({
      accountId,
      email: "new.person@hexion.com",
      status: "pending",
      role: "member",
      inviteExpiresAt: NOW + 14 * DAY_MS,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const resendCalls = fetchMock.mock.calls.filter((call) => String(call[0]) === "https://api.resend.com/emails");
    expect(resendCalls).toHaveLength(1);
    const body = JSON.parse(String((resendCalls[0]![1] as RequestInit).body));
    expect(body.to).toEqual(["new.person@hexion.com"]);
    expect(body.html).toContain(`accept-enterprise-invite=${encodeURIComponent(result.memberId)}`);
  });

  test("only the account admin can invite", async () => {
    const { t } = await setup();
    await expect(
      t.withIdentity(MEMBER_ID).mutation(api.enterpriseSeats.inviteMembers, { emails: ["x@hexion.com"] }),
    ).rejects.toThrow(/NOT_ACCOUNT_ADMIN/);
    await expect(
      t.withIdentity(identity(OTHER, "someone@other.com"))
        .mutation(api.enterpriseSeats.inviteMembers, { emails: ["x@hexion.com"] }),
    ).rejects.toThrow(/NOT_ACCOUNT_ADMIN/);
  });

  test("pending invites count toward the seat cap and expired ones free their seat", async () => {
    const { t } = await setup({ seatCap: 3 });
    await invite(t, "third@hexion.com");
    await expect(invite(t, "fourth@hexion.com")).rejects.toThrow(/SEAT_CAP_REACHED/);
    vi.setSystemTime(NOW + 14 * DAY_MS + 1);
    expect((await invite(t, "fourth@hexion.com")).status).toBe("created");
  });

  test("invite and withdraw cannot loop: a rolling daily cap bounds invite emails", async () => {
    const { t } = await setup({ seatCap: 3 });
    // Seat cap 3 with admin + member leaves one seat, so every invite below is
    // withdrawn before the next; only the daily cap can stop the loop.
    for (let i = 0; i < 20; i++) {
      const { memberId } = await invite(t, `loop${i}@hexion.com`);
      await t.withIdentity(ADMIN_ID).mutation(api.enterpriseSeats.removeMember, {
        memberId: memberId as Id<"enterpriseMembers">,
      });
    }
    await expect(invite(t, "loop20@hexion.com")).rejects.toThrow(/INVITE_RATE_LIMITED/);
    vi.setSystemTime(NOW + DAY_MS + 1);
    expect((await invite(t, "loop20@hexion.com")).status).toBe("created");
  });

  test("an account larger than the daily cap can still fill every seat in one day", async () => {
    const { t } = await setup({ seatCap: 32 });
    const emails = Array.from({ length: 30 }, (_, i) => `seat${i}@hexion.com`);
    for (let i = 0; i < emails.length; i += 10) {
      await t.withIdentity(ADMIN_ID).mutation(api.enterpriseSeats.inviteMembers, { emails: emails.slice(i, i + 10) });
    }
    const view = await t.withIdentity(ADMIN_ID).query(api.enterpriseSeats.listMySeats, {});
    expect(view?.seatsUsed).toBe(32);
  });

  test("an invite email that was not sent shows on the roster", async () => {
    const { t } = await setup({ seatCap: 5 });
    vi.stubEnv("RESEND_API_KEY", "");
    const { memberId } = await invite(t, "unsent@hexion.com");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const view = await t.withIdentity(ADMIN_ID).query(api.enterpriseSeats.listMySeats, {});
    expect(view?.seats.find((s) => s.memberId === memberId)).toMatchObject({ status: "pending", emailFailed: true });

    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 500 }));
    const second = await invite(t, "bounced@hexion.com");
    await t.finishAllScheduledFunctions(vi.runAllTimers).catch(() => {});
    const after = await t.withIdentity(ADMIN_ID).query(api.enterpriseSeats.listMySeats, {});
    expect(after?.seats.find((s) => s.memberId === second.memberId)?.emailFailed).toBe(true);
    expect(after?.seats.find((s) => s.memberId === memberId)?.emailFailed).toBe(true);
  });

  test("re-inviting a pending or active address reports it and creates nothing", async () => {
    const { t } = await setup({ seatCap: 5 });
    const first = await invite(t, "third@hexion.com");
    const again = await invite(t, "third@hexion.com");
    expect(again).toEqual({ email: "third@hexion.com", memberId: first.memberId, status: "already_pending" });
    await t.run((ctx) => ctx.db.insert("customers", {
      userId: MEMBER,
      email: "member@hexion.com",
      dodoCustomerId: "cus_member",
      createdAt: NOW,
      updatedAt: NOW,
    } as never));
    expect((await invite(t, "member@hexion.com")).status).toBe("already_active");
  });

  test("rejects free-mail invitees, self-invites and an ended contract", async () => {
    const { t, accountId } = await setup();
    await expect(invite(t, "someone@gmail.com")).rejects.toThrow(/INVITEE_DOMAIN_NOT_CORPORATE/);
    await expect(invite(t, "admin@hexion.com")).rejects.toThrow(/CANNOT_INVITE_SELF/);
    await t.mutation(internal.enterpriseAccounts.updateAccount, { accountId, contractEnd: NOW + 1 });
    vi.setSystemTime(NOW + 2);
    await expect(invite(t, "late@hexion.com")).rejects.toThrow(/CONTRACT_ENDED/);
  });
});

describe("acceptInvite", () => {
  async function invited() {
    const ctx = await setup({ seatCap: 5 });
    const { memberId } = await invite(ctx.t, "new.person@hexion.com");
    const stored = await row(ctx.t, memberId);
    const token = await signEnterpriseInviteToken(memberId, stored!.inviteExpiresAt!);
    return { ...ctx, memberId: memberId as Id<"enterpriseMembers">, token };
  }

  test("the invited address joins the account and resolves to Enterprise", async () => {
    const { t, memberId, token } = await invited();
    expect(await planKey(t, INVITEE)).toBe("free");
    const result = await t.withIdentity(INVITEE_ID).mutation(api.enterpriseSeats.acceptInvite, { memberId, token });
    expect(result).toEqual({ ok: true, status: "joined" });
    expect(await row(t, memberId)).toMatchObject({ status: "active", userId: INVITEE, joinedAt: NOW });
    expect(await planKey(t, INVITEE)).toBe("enterprise");
    const routing = await t.query(internal.entitlements.getAiRoutingPolicyByUserId, { userId: INVITEE });
    expect(routing?.allowedProviders).toEqual(["anthropic"]);
  });

  test("a different signed-in address cannot accept", async () => {
    const { t, memberId, token } = await invited();
    await expect(
      t.withIdentity(identity(OTHER, "intruder@hexion.com")).mutation(api.enterpriseSeats.acceptInvite, { memberId, token }),
    ).rejects.toThrow(/INVITE_EMAIL_MISMATCH/);
    expect((await row(t, memberId))?.status).toBe("pending");
  });

  test("a forged, wrong-row or Business token is refused", async () => {
    const { t, memberId, token } = await invited();
    const expiresAt = NOW + 14 * DAY_MS;
    for (const bad of [
      `${token}0`,
      await signEnterpriseInviteToken("some_other_row", expiresAt),
      await signBusinessInviteToken(memberId, expiresAt),
    ]) {
      await expect(
        t.withIdentity(INVITEE_ID).mutation(api.enterpriseSeats.acceptInvite, { memberId, token: bad }),
      ).rejects.toThrow(/INVALID_INVITE_TOKEN/);
    }
  });

  test("an invite is single-use and expires", async () => {
    const { t, memberId, token } = await invited();
    await t.withIdentity(INVITEE_ID).mutation(api.enterpriseSeats.acceptInvite, { memberId, token });
    await expect(
      t.withIdentity(INVITEE_ID).mutation(api.enterpriseSeats.acceptInvite, { memberId, token }),
    ).rejects.toThrow(/INVITE_ALREADY_USED/);

    const { memberId: second } = await invite(t, "late@hexion.com");
    const secondToken = await signEnterpriseInviteToken(second, NOW + 14 * DAY_MS);
    vi.setSystemTime(NOW + 14 * DAY_MS + 1);
    await expect(
      t.withIdentity(identity("user_late", "late@hexion.com"))
        .mutation(api.enterpriseSeats.acceptInvite, { memberId: second as Id<"enterpriseMembers">, token: secondToken }),
    ).rejects.toThrow(/INVITE_EXPIRED/);
  });

  test("an active member of another account cannot accept", async () => {
    const { t, memberId, token } = await invited();
    const { accountId: other } = await t.mutation(internal.enterpriseAccounts.createAccount, { ...BASE_ACCOUNT, name: "Other" });
    await t.mutation(internal.enterpriseAccounts.addMemberByUserId, { accountId: other, userId: INVITEE });
    await expect(
      t.withIdentity(INVITEE_ID).mutation(api.enterpriseSeats.acceptInvite, { memberId, token }),
    ).rejects.toThrow(/ALREADY_MEMBER_OF_ANOTHER_ACCOUNT/);
  });
});

describe("removeMember and listMySeats", () => {
  test("the admin removes an active member, who falls back to free at once", async () => {
    const { t } = await setup();
    expect(await planKey(t, MEMBER)).toBe("enterprise");
    const seats = await t.withIdentity(ADMIN_ID).query(api.enterpriseSeats.listMySeats, {});
    const target = seats!.seats.find((s) => !s.isSelf)!;
    const result = await t.withIdentity(ADMIN_ID).mutation(api.enterpriseSeats.removeMember, {
      memberId: target.memberId,
    });
    expect(result).toEqual({ ok: true, status: "removed" });
    expect(await planKey(t, MEMBER)).toBe("free");
    const after = await t.withIdentity(ADMIN_ID).query(api.enterpriseSeats.listMySeats, {});
    expect(after!.seatsUsed).toBe(1);
  });

  test("the admin withdraws a pending invite, which can then no longer be accepted", async () => {
    const { t } = await setup();
    const { memberId } = await invite(t, "new.person@hexion.com");
    const token = await signEnterpriseInviteToken(memberId, NOW + 14 * DAY_MS);
    await t.withIdentity(ADMIN_ID).mutation(api.enterpriseSeats.removeMember, {
      memberId: memberId as Id<"enterpriseMembers">,
    });
    await expect(
      t.withIdentity(INVITEE_ID).mutation(api.enterpriseSeats.acceptInvite, {
        memberId: memberId as Id<"enterpriseMembers">,
        token,
      }),
    ).rejects.toThrow(/INVITE_ALREADY_USED/);
  });

  test("the admin cannot remove themselves, a member cannot remove anyone, nor can another account's admin", async () => {
    const { t } = await setup();
    const seats = (await t.withIdentity(ADMIN_ID).query(api.enterpriseSeats.listMySeats, {}))!.seats;
    const self = seats.find((s) => s.isSelf)!;
    const other = seats.find((s) => !s.isSelf)!;
    await expect(
      t.withIdentity(ADMIN_ID).mutation(api.enterpriseSeats.removeMember, { memberId: self.memberId }),
    ).rejects.toThrow(/CANNOT_REMOVE_SELF/);
    await expect(
      t.withIdentity(MEMBER_ID).mutation(api.enterpriseSeats.removeMember, { memberId: self.memberId }),
    ).rejects.toThrow(/NOT_ACCOUNT_ADMIN/);

    const { accountId: rival } = await t.mutation(internal.enterpriseAccounts.createAccount, { ...BASE_ACCOUNT, name: "Rival" });
    await t.mutation(internal.enterpriseAccounts.addMemberByUserId, { accountId: rival, userId: OTHER, role: "admin" });
    await expect(
      t.withIdentity(identity(OTHER, "boss@rival.com")).mutation(api.enterpriseSeats.removeMember, { memberId: other.memberId }),
    ).rejects.toThrow(/MEMBER_NOT_FOUND/);
    expect(await planKey(t, MEMBER)).toBe("enterprise");
  });

  test("members see the account and seat count but not the roster; non-members get null", async () => {
    const { t } = await setup();
    await invite(t, "new.person@hexion.com");
    const asAdmin = await t.withIdentity(ADMIN_ID).query(api.enterpriseSeats.listMySeats, {});
    expect(asAdmin).toMatchObject({ accountName: "Hexion", isAdmin: true, seatCap: 3, seatsUsed: 3 });
    expect(asAdmin!.seats.map((s) => s.status).sort()).toEqual(["active", "active", "pending"]);
    const asMember = await t.withIdentity(MEMBER_ID).query(api.enterpriseSeats.listMySeats, {});
    expect(asMember).toMatchObject({ accountName: "Hexion", isAdmin: false, seatsUsed: 3, seats: [] });
    expect(await t.withIdentity(identity(OTHER, "x@other.com")).query(api.enterpriseSeats.listMySeats, {})).toBeNull();
  });

  test("an expired invite lists as expired and stops counting", async () => {
    const { t } = await setup();
    await invite(t, "new.person@hexion.com");
    vi.setSystemTime(NOW + 15 * DAY_MS);
    const seats = await t.withIdentity(ADMIN_ID).query(api.enterpriseSeats.listMySeats, {});
    expect(seats!.seatsUsed).toBe(2);
    expect(seats!.seats.filter((s) => s.status === "expired")).toHaveLength(1);
  });
});
