import { describe, expect, test } from "vitest";
import {
  BLACK_FRIDAY_APP_LABELS,
  BLACK_FRIDAY_COPY,
  BLACK_FRIDAY_LOCALES,
  BLACK_FRIDAY_OFFER,
  BLACK_FRIDAY_PHYSICAL_ADDRESS,
  BLACK_FRIDAY_VERSIONS,
  RESEND_UNSUBSCRIBE_TOKEN,
  blackFridayCtaUrl,
  blackFridaySwitchPath,
  isSwitchVersion,
  pickBlackFridayLocale,
  renderBlackFridayEmail,
  type BlackFridayLocale,
  type BlackFridayLocaleCopy,
  type BlackFridayVersion,
} from "../broadcast/blackFridayEmailContent";
import { PRO_LAUNCH_HTML, PRO_LAUNCH_TEXT } from "../broadcast/proLaunchEmailContent";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import {
  ACTIVE_PROMO,
  formatUsdCents,
  promoDisplayPrices,
  type PromoCampaign,
} from "../../shared/promo-campaign";

const CASES = BLACK_FRIDAY_VERSIONS.flatMap((version) =>
  BLACK_FRIDAY_LOCALES.map((locale) => [version, locale] as [BlackFridayVersion, BlackFridayLocale]),
);

/** The end date as each locale writes it. All name 4 December 2026, 23:45 UTC. */
const END_DATE: Record<BlackFridayLocale, RegExp> = {
  en: /December 4, 2026,? at 23:45 UTC/,
  zh: /2026 年 12 月 4 日）?\s?(UTC 时间 )?23:45/,
  fr: /4 décembre 2026,? à 23 h 45 UTC/,
  tr: /4 Aralık 2026, saat 23:45'te \(UTC\)/,
  es: /4 de diciembre de 2026,? a las 23:45 UTC/,
  de: /4\. Dezember 2026,? um 23:45 Uhr UTC/,
};

const CANCEL_ANYTIME: Record<BlackFridayLocale, string> = {
  en: "Cancel anytime",
  zh: "可随时取消",
  fr: "Annulez à tout moment",
  tr: "İstediğiniz zaman iptal edebilirsiniz",
  es: "Cancela en cualquier momento",
  de: "Jederzeit kündbar",
};

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => (match[1] ?? "").replace(/&amp;/g, "&"));
}

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<title>[\s\S]*?<\/title>/, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&middot;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function copyStrings(copy: BlackFridayLocaleCopy): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === "string") flat[key] = value;
  }
  copy.steps.forEach((step, index) => {
    flat[`steps.${index}`] = step;
  });
  for (const version of BLACK_FRIDAY_VERSIONS) {
    for (const [key, value] of Object.entries(copy.versions[version])) flat[`${version}.${key}`] = value;
  }
  return flat;
}

describe("the offer the copy states matches the promo config", () => {
  test("prices come out of the catalog and the promo arithmetic", () => {
    const annual = PRODUCT_CATALOG.pro_annual?.priceCents;
    const monthly = PRODUCT_CATALOG.pro_monthly?.priceCents;
    expect(annual).toBe(BLACK_FRIDAY_OFFER.listCents);
    expect(monthly).toBe(BLACK_FRIDAY_OFFER.monthlyCents);
    expect(BLACK_FRIDAY_OFFER.monthlyTotalCents).toBe(12 * BLACK_FRIDAY_OFFER.monthlyCents);

    // The campaign as it ran, written out so retiring ACTIVE_PROMO leaves this test standing.
    const campaign: PromoCampaign = {
      id: BLACK_FRIDAY_OFFER.campaignId,
      discountCode: "BLACKFRIDAY",
      productId: "pdt_0NbttMIfjLWC10jHQWYgJ",
      planKey: "pro_annual",
      monthlyPlanKey: "pro_monthly",
      percentOff: 60,
      startsAtMs: Date.UTC(2026, 10, 26, 0, 0, 0),
      endsAtMs: BLACK_FRIDAY_OFFER.endsAtMs,
    };
    const prices = promoDisplayPrices(
      campaign,
      BLACK_FRIDAY_OFFER.listCents / 100,
      BLACK_FRIDAY_OFFER.monthlyCents / 100,
    );
    expect(prices).toEqual({
      listCents: BLACK_FRIDAY_OFFER.listCents,
      promoCents: BLACK_FRIDAY_OFFER.promoCents,
      perMonthCents: BLACK_FRIDAY_OFFER.perMonthCents,
      monthlyTotalCents: BLACK_FRIDAY_OFFER.monthlyTotalCents,
      savingsVsMonthlyPct: BLACK_FRIDAY_OFFER.savingsVsMonthlyPct,
    });
    expect(formatUsdCents(BLACK_FRIDAY_OFFER.promoCents)).toBe("$144");
    expect(formatUsdCents(BLACK_FRIDAY_OFFER.listCents)).toBe("$359.99");
    expect(formatUsdCents(BLACK_FRIDAY_OFFER.monthlyTotalCents)).toBe("$479.88");
    expect(formatUsdCents(BLACK_FRIDAY_OFFER.perMonthCents)).toBe("$12");
  });

  test("the end instant is 4 December 2026, 23:45 UTC", () => {
    expect(new Date(BLACK_FRIDAY_OFFER.endsAtMs).toISOString()).toBe("2026-12-04T23:45:00.000Z");
  });

  // Skips itself once the campaign is retired (ACTIVE_PROMO = null or a new one).
  test.runIf(ACTIVE_PROMO?.id === BLACK_FRIDAY_OFFER.campaignId)("the running promotion is this offer", () => {
    expect(ACTIVE_PROMO?.endsAtMs).toBe(BLACK_FRIDAY_OFFER.endsAtMs);
    expect(ACTIVE_PROMO?.percentOff).toBe(60);
    expect(ACTIVE_PROMO?.planKey).toBe("pro_annual");
    expect(ACTIVE_PROMO?.monthlyPlanKey).toBe("pro_monthly");
    expect(PRODUCT_CATALOG.pro_annual?.dodoProductId).toBe(ACTIVE_PROMO?.productId);
  });
});

describe.each(CASES)("%s in %s", (version, locale) => {
  const email = renderBlackFridayEmail({ version, locale });
  const parts: Array<[string, string]> = [
    ["html", visibleText(email.html)],
    ["text", email.text],
  ];

  test("has a subject and a preheader of sensible length", () => {
    expect(email.locale).toBe(locale);
    expect(email.subject.length).toBeGreaterThan(8);
    expect(email.subject.length).toBeLessThanOrEqual(90);
    expect(email.subject).not.toMatch(/[!]|\bFREE\b/);
    expect(email.preheader.length).toBeGreaterThan(30);
    expect(email.preheader.length).toBeLessThanOrEqual(160);
    expect(email.html).toContain(email.preheader.replace(/&/g, "&amp;").replace(/'/g, "&#39;"));
  });

  test.each(parts)("%s states the price, the renewal, the end and the cancel terms", (_name, body) => {
    expect(body).toContain("$144");
    expect(body).toContain("$359.99");
    expect(body).toContain("$479.88");
    expect(body).toMatch(END_DATE[locale]);
    expect(body).toContain(CANCEL_ANYTIME[locale]);
    // Tax can be added, so $144 is never "total"; and nothing promises money back.
    expect(body).not.toMatch(/\$144 total|refund|money[- ]back|rembours|erstatt|reembols|iade|退款/i);
  });

  test("the renewal terms sit in the offer card, above the button", () => {
    // lastIndexOf: some preheaders quote the same sentence.
    const renews = email.html.lastIndexOf(BLACK_FRIDAY_COPY[locale].renews.replace(/'/g, "&#39;"));
    const cta = email.html.indexOf(`href="${email.ctaUrl.replace(/&/g, "&amp;")}"`);
    expect(renews).toBeGreaterThan(0);
    expect(cta).toBeGreaterThan(renews);
    // Only the end date stands between the renewal line and the button.
    expect(visibleText(email.html.slice(renews, cta)).replace(/\s+/g, " ").length).toBeLessThan(200);
  });

  test("has exactly one CTA button, a working URL with the campaign UTM params", () => {
    const url = new URL(email.ctaUrl);
    expect(email.ctaUrl).toBe(blackFridayCtaUrl(version));
    expect(url.origin).toBe("https://www.worldmonitor.app");
    expect(url.pathname).toBe(isSwitchVersion(version) ? "/dashboard" : "/pro");
    expect(url.hash).toBe(isSwitchVersion(version) ? "" : "#pricing");
    expect(url.searchParams.get("utm_source")).toBe("email");
    expect(url.searchParams.get("utm_medium")).toBe("broadcast");
    expect(url.searchParams.get("utm_campaign")).toBe("black-friday-2026");
    expect(url.searchParams.get("utm_content")).toBe(version);

    expect(hrefs(email.html).filter((href) => href === email.ctaUrl)).toHaveLength(1);
    expect(email.html.match(/mso-padding-alt/g)).toHaveLength(1);
    expect(email.text).toContain(email.ctaUrl);
    // Raw ampersands in an href break strict parsers.
    expect(email.html).not.toMatch(/href="[^"]*&(?!amp;)[^"]*"/);
  });

  test("carries the unsubscribe token the broadcast pipeline fills, and the sender address", () => {
    expect(PRO_LAUNCH_HTML).toContain(`href="${RESEND_UNSUBSCRIBE_TOKEN}"`);
    expect(PRO_LAUNCH_TEXT).toContain(RESEND_UNSUBSCRIBE_TOKEN);
    expect(email.html).toContain(`href="${RESEND_UNSUBSCRIBE_TOKEN}"`);
    expect(email.text).toContain(RESEND_UNSUBSCRIBE_TOKEN);
    expect(email.html).toContain(BLACK_FRIDAY_PHYSICAL_ADDRESS);
    expect(email.text).toContain(BLACK_FRIDAY_PHYSICAL_ADDRESS);
    expect(visibleText(email.html)).toContain(BLACK_FRIDAY_COPY[locale].unsubscribe);
  });

  test("leaves no template placeholder unfilled", () => {
    for (const body of [email.html, email.text, email.subject, email.preheader]) {
      const rest = body.split(RESEND_UNSUBSCRIBE_TOKEN).join("");
      expect(rest).not.toMatch(/\{\{|\}\}|\$\{|undefined|\[object/);
    }
    const perUser = renderBlackFridayEmail({
      version,
      locale,
      unsubscribeUrl: "https://example.convex.site/email/unsubscribe?t=v1.abc.def&x=1",
    });
    expect(perUser.html).not.toMatch(/\{\{|\}\}/);
    expect(perUser.text).not.toMatch(/\{\{|\}\}/);
    expect(perUser.html).toContain('href="https://example.convex.site/email/unsubscribe?t=v1.abc.def&amp;x=1"');
    expect(perUser.text).toContain("https://example.convex.site/email/unsubscribe?t=v1.abc.def&x=1");
  });

  test("is client-safe markup: tables, inline styles, hosted logo only", () => {
    expect(email.html).toMatch(/^<!DOCTYPE html>/);
    expect(email.html).toContain(`<html lang="${locale === "zh" ? "zh-Hans" : locale}">`);
    expect(email.html).not.toMatch(/<style|<script|<link|@import|@font-face|background-image|url\(/i);
    expect(email.html).not.toMatch(/display:\s*(flex|grid)|position:\s*(absolute|fixed)|rgba\(/);
    expect(email.html).toContain("max-width: 600px");
    expect(email.html).toContain('width="600"');
    expect(email.html).toContain('<meta name="color-scheme" content="dark">');
    const images = [...email.html.matchAll(/<img[^>]*src="([^"]+)"[^>]*>/g)];
    expect(images.map((match) => match[1])).toEqual([
      "https://www.worldmonitor.app/favico/android-chrome-192x192.png",
    ]);
    expect(images[0]?.[0]).toMatch(/width="32" height="32" alt=""/);
    for (const table of email.html.match(/<table[^>]*>/g) ?? []) expect(table).toContain('role="presentation"');
  });

  test("the switch versions describe the in-place change; the others do not", () => {
    const copy = BLACK_FRIDAY_COPY[locale];
    const html = visibleText(email.html);
    if (isSwitchVersion(version)) {
      const labels = BLACK_FRIDAY_APP_LABELS[locale];
      const path = blackFridaySwitchPath(locale);
      expect(path).not.toMatch(/[{}]/);
      for (const label of [labels.switchToYearly, labels.settings, labels.account]) expect(path).toContain(label);
      expect(html).toContain(path);
      expect(email.text).toContain(path);
      expect(new URL(email.ctaUrl).searchParams.get("settings")).toBe("account");
      const detail = version === "monthly-switch" ? copy.steps.join(" ") : copy.switchSummary;
      for (const sentence of version === "monthly-switch" ? copy.steps : [copy.switchSummary]) {
        expect(html).toContain(sentence);
        expect(email.text).toContain(sentence);
      }
      // The prorated charge is named with its base price.
      expect(detail).toContain("$144");
    } else {
      expect(visibleText(email.html)).not.toContain(blackFridaySwitchPath(locale));
      expect(email.text).not.toContain(blackFridaySwitchPath(locale));
      expect(new URL(email.ctaUrl).searchParams.has("settings")).toBe(false);
      expect(email.text).toContain(copy.checkoutNote);
    }
  });
});

describe("non-English copy is fully translated", () => {
  // Brand and product names and the legal address.
  const ALLOWED = [
    BLACK_FRIDAY_PHYSICAL_ADDRESS,
    "WorldMonitor",
    "WORLD MONITOR",
    "worldmonitor.app",
    "Black Friday",
    "BLACK FRIDAY",
    "Pro Yearly",
    "WM Analyst",
    "WM-Analyst-Chat",
    "Claude",
  ];
  // Words that are English and nothing else in zh, fr, tr, es or de. Words
  // shared with one of them (code, taxes, plan, chat, an, dollars, clients, part, exact, dashboard) are left out.
  const ENGLISH = new Set(
    (
      "the and your you year yearly month monthly off renews renew cancel anytime ends offer first billed " +
      "checkout unsubscribe switch settings account today get with instead paying added price prices day " +
      "last back come subscription reply email this that is are of before until then now charge charged " +
      "for at to from when what happens new same receiving because have joined waitlist discount applied " +
      "there enter may be which against after ended want it if less unused see amount " +
      "confirm created billing period restarts immediately changes includes stock analysis alert rules " +
      "scheduled digest access other questions choose open"
    ).split(" "),
  );

  test.each(BLACK_FRIDAY_LOCALES.filter((locale) => locale !== "en"))("%s has no leftover English", (locale) => {
    for (const version of BLACK_FRIDAY_VERSIONS) {
      for (const recipient of ["account", "waitlist"] as const) {
        const email = renderBlackFridayEmail({ version, locale, recipient });
        for (const body of [visibleText(email.html), email.text, email.subject, email.preheader]) {
          let rest = body.replace(/https?:\/\/\S+/g, " ").split(RESEND_UNSUBSCRIBE_TOKEN).join(" ");
          for (const phrase of ALLOWED) rest = rest.split(phrase).join(" ");
          const words = rest.toLowerCase().match(/\p{L}+/gu) ?? [];
          expect(words.filter((word) => ENGLISH.has(word))).toEqual([]);
        }
      }
    }
  });

  test("every string differs from its English source, and none is empty", () => {
    const english = copyStrings(BLACK_FRIDAY_COPY.en);
    // Deliberately the same: the site keeps "Black Friday" in fr, es and de, and
    // these three locales punctuate lists and labels as English does.
    const sameAsEnglish: Record<string, readonly BlackFridayLocale[]> = {
      kicker: ["fr", "es", "de"],
      listSep: ["fr", "tr", "es", "de"],
      colon: ["tr", "es", "de"],
    };
    for (const locale of BLACK_FRIDAY_LOCALES) {
      const strings = copyStrings(BLACK_FRIDAY_COPY[locale]);
      expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
      for (const [key, value] of Object.entries(strings)) {
        expect(value.trim(), `${locale}.${key}`).not.toBe("");
        if (locale === "en") continue;
        if (sameAsEnglish[key]?.includes(locale)) expect(value, `${locale}.${key}`).toBe(english[key]);
        else expect(value, `${locale}.${key}`).not.toBe(english[key]);
      }
    }
  });

  test("zh is written in Han script, with full-width punctuation between clauses", () => {
    for (const [key, value] of Object.entries(copyStrings(BLACK_FRIDAY_COPY.zh))) {
      expect(value, key).toMatch(/\p{Script=Han}|^[，：]$/u);
      expect(value, key).not.toMatch(/\p{Script=Han}[,;:!?]\s?\p{Script=Han}/u);
    }
    const email = renderBlackFridayEmail({ version: "new-buyer", locale: "zh" });
    expect(visibleText(email.html)).toContain("Pro 年度版首年，而非按月支付的 $479.88");
  });

  test("Turkish capitals are written out, not left to CSS", () => {
    const html = renderBlackFridayEmail({ version: "monthly-switch", locale: "tr" }).html;
    expect(html).toContain("GEÇİŞ YAPTIĞINIZDA NE OLUR");
    expect(html).toContain("KARA CUMA");
    expect(html).not.toContain("text-transform");
  });
});

describe("recipient and locale selection", () => {
  test("waitlist contacts get their own reason line and the account note", () => {
    for (const locale of BLACK_FRIDAY_LOCALES) {
      const copy = BLACK_FRIDAY_COPY[locale];
      const account = renderBlackFridayEmail({ version: "new-buyer", locale });
      const waitlist = renderBlackFridayEmail({ version: "new-buyer", locale, recipient: "waitlist" });
      expect(account.text).toContain(copy.reasonAccount);
      expect(account.text).not.toContain(copy.waitlistNote);
      expect(waitlist.text).toContain(copy.reasonWaitlist);
      expect(waitlist.text).toContain(copy.waitlistNote);
      expect(waitlist.text).not.toContain(copy.reasonAccount);
      expect(visibleText(waitlist.html)).toContain(copy.waitlistNote);
      expect(waitlist.subject).toBe(account.subject);
      expect(waitlist.ctaUrl).toBe(account.ctaUrl);
    }
  });

  test("picks the locale from a tag, English for everyone else", () => {
    expect(pickBlackFridayLocale("fr")).toBe("fr");
    expect(pickBlackFridayLocale("fr-CA")).toBe("fr");
    expect(pickBlackFridayLocale("DE_de")).toBe("de");
    expect(pickBlackFridayLocale(" tr ")).toBe("tr");
    expect(pickBlackFridayLocale("es-419")).toBe("es");
    expect(pickBlackFridayLocale("zh")).toBe("zh");
    expect(pickBlackFridayLocale("zh-CN")).toBe("zh");
    expect(pickBlackFridayLocale("zh-Hans-SG")).toBe("zh");
    for (const tag of ["zh-TW", "zh-Hant", "zh-HK", "zh_MO", "en", "en-GB", "ja", "ar", "pt-BR", "", "xx", null, undefined]) {
      expect(pickBlackFridayLocale(tag)).toBe("en");
    }
    expect(renderBlackFridayEmail({ version: "lapsed", locale: "ja" }).subject).toBe(
      BLACK_FRIDAY_COPY.en.versions.lapsed.subject,
    );
  });
});

describe("app labels quoted in the switch emails", () => {
  test("are the dashboard's strings, translated in every non-English locale", () => {
    expect(BLACK_FRIDAY_APP_LABELS).toEqual({
      en: { switchToYearly: "Switch to yearly", settings: "Settings", account: "Account" },
      zh: { switchToYearly: "切换为年付", settings: "设置", account: "账户" },
      fr: { switchToYearly: "Passer à l'abonnement annuel", settings: "Paramètres", account: "Compte" },
      tr: { switchToYearly: "Yıllık plana geç", settings: "Ayarlar", account: "Hesap" },
      es: { switchToYearly: "Cambiar a facturación anual", settings: "Ajustes", account: "Cuenta" },
      de: { switchToYearly: "Auf jährlich umstellen", settings: "Einstellungen", account: "Konto" },
    });
  });

  test("the email takes them from the constants, not from its own copy", () => {
    for (const locale of BLACK_FRIDAY_LOCALES) {
      const template = BLACK_FRIDAY_COPY[locale].switchPath;
      for (const token of ["{settings}", "{account}", "{switchToYearly}"]) expect(template).toContain(token);
      const labels = BLACK_FRIDAY_APP_LABELS[locale];
      for (const label of Object.values(labels)) expect(template).not.toContain(label);
    }
  });
});
