import { describe, expect, test } from "vitest";
import { enterpriseInviteEmailHtml } from "../enterpriseSeats";
import { businessInviteEmailHtml, teamAccessEndedEmailHtml } from "../payments/businessSeats";
import { stuckPaymentEmailHtml } from "../payments/billing";
import { disabledChannelNotice } from "../notificationChannels";
import { unattributedPaymentEmail } from "../payments/unattributedPayments";

/** The designed frame (shared/email-frame.ts), not a bare white page. */
function expectWorldMonitorFrame(html: string, kicker: string): void {
  expect(html).toMatch(/^<!DOCTYPE html>/);
  expect(html).toContain("android-chrome-192x192.png");
  expect(html).toContain("WORLD MONITOR");
  expect(html).toContain('<body style="margin: 0; padding: 0; background: #111;">');
  expect(html).toContain(`>${kicker}</span>`);
  expect(html).toContain('href="https://worldmonitor.app"');
  expect(html).not.toMatch(/<style/i);
  expect(html).not.toMatch(/display:\s*flex/);
  expect(html).not.toMatch(/color:\s*#111;\s*line-height/);
}

describe("customer emails use the WorldMonitor frame", () => {
  test("enterprise invite", () => {
    const html = enterpriseInviteEmailHtml({
      adminEmail: "admin@acme.example",
      accountName: "Acme <Corp>",
      inviteeEmail: "new@acme.example",
      acceptUrl: "https://www.worldmonitor.app/dashboard?accept-enterprise-invite=m1&token=t1",
    });
    expectWorldMonitorFrame(html, "Team invite");
    expect(html).toContain("Acme &lt;Corp&gt;");
    expect(html).not.toContain("Acme <Corp>");
    expect(html).toContain('href="https://www.worldmonitor.app/dashboard?accept-enterprise-invite=m1&amp;token=t1"');
    expect(html).toContain(">Accept invite</a>");
    expect(html).toContain("This invite expires in 14 days.");
  });

  test("business invite", () => {
    const html = businessInviteEmailHtml({
      ownerEmail: "owner@acme.example",
      acceptUrl: "https://www.worldmonitor.app/dashboard?accept-business-invite=g1&token=t1",
      expiryNote: "This invite expires on 1 Dec 2026.",
    });
    expectWorldMonitorFrame(html, "Team invite");
    expect(html).toContain("owner@acme.example");
    expect(html).toContain(">Accept invite</a>");
    expect(html).toContain("This invite expires on 1 Dec 2026.");
  });

  test("team access ended", () => {
    const html = teamAccessEndedEmailHtml();
    expectWorldMonitorFrame(html, "Team access");
    expect(html).toContain("Team access ended");
    expect(html).toContain('href="https://worldmonitor.app/pro"');
    expect(html).toContain(">View plans</a>");
  });

  test("stuck checkout", () => {
    const html = stuckPaymentEmailHtml({
      planName: "Pro <Monthly>",
      checkoutUrl: "https://checkout.example/pay?a=1&b=2",
      supportEmail: "support@worldmonitor.app",
    });
    expectWorldMonitorFrame(html, "Billing");
    expect(html).toContain("Pro &lt;Monthly&gt;");
    expect(html).toContain('href="https://checkout.example/pay?a=1&amp;b=2"');
    expect(html).toContain(">Continue checkout</a>");
    expect(html).toContain('href="mailto:support@worldmonitor.app"');
  });

  test("notification channel disabled", () => {
    const { text, html } = disabledChannelNotice({
      channelType: "slack",
      error: "<invalid_token>",
      firstFailedAt: Date.UTC(2026, 10, 1, 12),
    });
    expect(text).toContain("Your slack notification channel was disabled after delivery failures.");
    expect(text).toContain("https://www.worldmonitor.app/dashboard?settings=notifications");
    expectWorldMonitorFrame(html, "Alert settings");
    expect(html).toContain("&lt;invalid_token&gt;");
    expect(html).not.toContain("<invalid_token>");
    expect(html).toContain("2026-11-01T12:00:00.000Z");
    expect(html).toContain('href="https://www.worldmonitor.app/dashboard?settings=notifications"');
  });
});

describe("ops emails use the WorldMonitor frame", () => {
  test("unattributed paid event", () => {
    const { subject, html } = unattributedPaymentEmail({
      charged: true,
      eventType: "payment.succeeded",
      amount: 3900,
      currency: "USD",
      customerEmail: "buyer@<x>.example",
      dodoPaymentId: "pay_1",
    }, "row_1");
    expect(subject).toBe("[WM] ACTION REQUIRED — paid but unattributed (39.00 USD)");
    expectWorldMonitorFrame(html, "Ops alert");
    expect(html).toContain("Unattributed PAID event");
    expect(html).toContain("buyer@&lt;x&gt;.example");
    expect(html).toContain("39.00 USD");
    expect(html).toContain("row_1");
    expect(html).not.toContain(">Name</td>");
  });

  test("unattributed failed payment", () => {
    const { subject, html } = unattributedPaymentEmail({ charged: false, eventType: "payment.failed" }, "row_2");
    expect(subject).toBe("[WM] Buyer could not pay — unattributed payment.failed");
    expectWorldMonitorFrame(html, "Ops alert");
    expect(html).toContain("Unattributed failed payment");
  });
});
