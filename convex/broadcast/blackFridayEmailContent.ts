/**
 * Black Friday 2026 email content: 70% off Pro against paying monthly
 * ($144 for the first year of Pro Yearly), ending 2026-12-04 23:45 UTC.
 *
 * Content only. Nothing here sends, and nothing imports this module yet:
 * the send and wave code are wired separately.
 *
 * The figures and the end date are written out in the copy, not computed, so
 * the wording stays reviewable and survives `ACTIVE_PROMO = null` after the
 * offer. convex/__tests__/blackFridayEmailContent.test.ts pins them to
 * shared/promo-campaign.ts and the product catalog.
 *
 * Versions:
 *   - new-buyer        free accounts and waitlist contacts (`recipient`)
 *   - lapsed           former subscribers
 *   - monthly-switch   active Pro Monthly subscribers, in-place switch
 *   - last-day         4 December reminder for new-buyer and lapsed
 *   - last-day-switch  4 December reminder for monthly-switch
 *
 * Locales: en, zh (Simplified), fr, tr, es, de. Everyone else gets en.
 *
 * Unsubscribe: the default link is Resend's broadcast token, as in
 * proLaunchEmailContent.ts. A per-user sender passes `unsubscribeUrl` (the
 * "marketing" list URL from lib/emailUnsubscribe.ts) instead.
 */

import { EMAIL_ACCENT, escapeEmailHtml } from "../../shared/email-frame";
import {
  PRO_LAUNCH_FROM,
  PRO_LAUNCH_PHYSICAL_ADDRESS,
  PRO_LAUNCH_REPLY_TO,
} from "./proLaunchEmailContent";

export const BLACK_FRIDAY_FROM = PRO_LAUNCH_FROM;
export const BLACK_FRIDAY_REPLY_TO = PRO_LAUNCH_REPLY_TO;
export const BLACK_FRIDAY_PHYSICAL_ADDRESS = PRO_LAUNCH_PHYSICAL_ADDRESS;

/** Token Resend Broadcasts replace with the per-recipient unsubscribe URL. */
export const RESEND_UNSUBSCRIBE_TOKEN = "{{{RESEND_UNSUBSCRIBE_URL}}}";

/** The offer as the copy states it. Pinned to the promo config by the tests. */
export const BLACK_FRIDAY_OFFER = {
  campaignId: "black-friday-2026",
  /** First year of Pro Yearly, in cents. */
  promoCents: 14400,
  /** Pro Yearly renewal price, in cents. */
  listCents: 35999,
  /** Pro Monthly price, in cents. */
  monthlyCents: 3999,
  /** Twelve monthly payments, in cents. */
  monthlyTotalCents: 47988,
  /** The first-year price per month, in cents. */
  perMonthCents: 1200,
  /** Percent saved against twelve monthly payments. */
  savingsVsMonthlyPct: 70,
  /** First instant the offer is no longer available. */
  endsAtMs: Date.UTC(2026, 11, 4, 23, 45, 0),
} as const;

export const BLACK_FRIDAY_LOCALES = ["en", "zh", "fr", "tr", "es", "de"] as const;
export type BlackFridayLocale = (typeof BLACK_FRIDAY_LOCALES)[number];

export const BLACK_FRIDAY_VERSIONS = [
  "new-buyer",
  "lapsed",
  "monthly-switch",
  "last-day",
  "last-day-switch",
] as const;
export type BlackFridayVersion = (typeof BLACK_FRIDAY_VERSIONS)[number];

/** Why the recipient is on the list. Changes the footer line and one note. */
export type BlackFridayRecipient = "account" | "waitlist";

const UTM = "utm_source=email&utm_medium=broadcast&utm_campaign=black-friday-2026";
const SITE = "https://www.worldmonitor.app";

/** True for the versions whose CTA is the in-place switch in Settings. */
export function isSwitchVersion(version: BlackFridayVersion): boolean {
  return version === "monthly-switch" || version === "last-day-switch";
}

/**
 * The primary CTA. Buyers land on the /pro pricing cards, which open on
 * yearly billing while the offer runs. Pro Monthly subscribers land on the
 * dashboard with Settings open on Account (`?settings=account`), where the
 * switch button is; the email also names that path as a fallback.
 */
export function blackFridayCtaUrl(version: BlackFridayVersion): string {
  const query = `${UTM}&utm_content=${version}`;
  return isSwitchVersion(version)
    ? `${SITE}/dashboard?settings=account&${query}`
    : `${SITE}/pro?${query}#pricing`;
}

/**
 * APP LABELS: the dashboard's own strings, quoted in the switch emails so the
 * reader looks for the words the app shows. Keep these byte-identical to
 * src/locales/<locale>.json:
 *   switchToYearly  settings.account.switchYearly.entryLabel
 *   settings        header.tabSettings
 *   account         settings.sections.account
 * Values are from PR #11463 at 43e266ca42. If the app's strings change, change
 * them here and nowhere else.
 */
export const BLACK_FRIDAY_APP_LABELS: Record<
  BlackFridayLocale,
  { switchToYearly: string; settings: string; account: string }
> = {
  en: { switchToYearly: "Switch to yearly", settings: "Settings", account: "Account" },
  zh: { switchToYearly: "切换为年付", settings: "设置", account: "账户" },
  fr: { switchToYearly: "Passer à l'abonnement annuel", settings: "Paramètres", account: "Compte" },
  tr: { switchToYearly: "Yıllık plana geç", settings: "Ayarlar", account: "Hesap" },
  es: { switchToYearly: "Cambiar a facturación anual", settings: "Ajustes", account: "Cuenta" },
  de: { switchToYearly: "Auf jährlich umstellen", settings: "Einstellungen", account: "Konto" },
};

/** The fallback line naming where the switch button is, with the app's labels. */
export function blackFridaySwitchPath(locale: BlackFridayLocale): string {
  const labels = BLACK_FRIDAY_APP_LABELS[locale];
  return BLACK_FRIDAY_COPY[locale].switchPath
    .replace("{settings}", labels.settings)
    .replace("{account}", labels.account)
    .replace("{switchToYearly}", labels.switchToYearly);
}

/**
 * The email locale for a BCP 47 tag or bare language code. Traditional
 * Chinese tags get English: the zh copy is Simplified only.
 */
export function pickBlackFridayLocale(tag: string | null | undefined): BlackFridayLocale {
  if (typeof tag !== "string") return "en";
  const parts = tag.trim().toLowerCase().split(/[-_]/);
  const primary = parts[0] ?? "";
  if (primary === "zh") {
    const traditional = parts.slice(1).some((part) => ["hant", "tw", "hk", "mo"].includes(part));
    return traditional ? "en" : "zh";
  }
  return (BLACK_FRIDAY_LOCALES as readonly string[]).includes(primary) ? (primary as BlackFridayLocale) : "en";
}

export interface BlackFridayVersionCopy {
  subject: string;
  preheader: string;
  headline: string;
  intro: string;
  cta: string;
}

export interface BlackFridayLocaleCopy {
  /** Joins the two halves of the card line (", " or the full-width comma). */
  listSep: string;
  /** Between a label and its value in the plain text. */
  colon: string;
  /** Small label beside the logo. */
  kicker: string;
  /** Beside the price: what $144 buys. */
  cardFirstYear: string;
  /** The monthly reference the 70% is measured against. */
  cardInstead: string;
  cardPerMonth: string;
  renews: string;
  ends: string;
  /** Under the button, for buyers. */
  checkoutNote: string;
  /** Extra sentence for waitlist contacts, who have no account yet. */
  waitlistNote: string;
  /** Under the button, for the in-place switch. */
  switchNote: string;
  /**
   * Where the switch button is, as a fallback when the deep link does not
   * open Settings. `{settings}`, `{account}` and `{switchToYearly}` are filled
   * from BLACK_FRIDAY_APP_LABELS.
   */
  switchPath: string;
  stepsTitle: string;
  steps: readonly [string, string, string];
  /** One sentence on the switch, for the last-day reminder. */
  switchSummary: string;
  proLine: string;
  reply: string;
  reasonAccount: string;
  reasonWaitlist: string;
  unsubscribe: string;
  versions: Record<BlackFridayVersion, BlackFridayVersionCopy>;
}

const EN: BlackFridayLocaleCopy = {
  listSep: ", ",
  colon: ": ",
  kicker: "Black Friday",
  cardFirstYear: "First year of Pro Yearly",
  cardInstead: "instead of $479.88 paying monthly",
  cardPerMonth: "$12 a month, billed yearly",
  renews: "Renews at $359.99/year. Cancel anytime.",
  ends: "Offer ends December 4, 2026 at 23:45 UTC.",
  checkoutNote:
    "The discount is applied at checkout. There is no code to enter. Prices are in US dollars; taxes or VAT may be added at checkout.",
  waitlistNote: "Checkout asks you to create a WorldMonitor account first.",
  switchNote:
    "The discount is applied when you switch. There is no code to enter. Prices are in US dollars; taxes or VAT may be added.",
  switchPath: "The button opens {settings} → {account} in the dashboard. Choose “{switchToYearly}” there.",
  stepsTitle: "What happens when you switch",
  steps: [
    "Your plan changes to Pro Yearly immediately.",
    "You are charged now: $144 for the first year, less the unused part of this month. You see the exact amount before you confirm.",
    "It is the same subscription. No new one is created, and your billing period restarts on the day you switch.",
  ],
  switchSummary:
    "Switching moves your current subscription to Pro Yearly immediately. The charge is prorated: $144 less the unused part of this month. No new subscription is created.",
  proLine:
    "Pro includes WM Analyst chat, AI stock analysis and backtesting, alert rules with a scheduled AI digest, and MCP access for Claude and other AI clients.",
  reply: "Questions? Reply to this email.",
  reasonAccount: "You are receiving this email because you have a WorldMonitor account.",
  reasonWaitlist: "You are receiving this email because you joined the WorldMonitor waitlist.",
  unsubscribe: "Unsubscribe",
  versions: {
    "new-buyer": {
      subject: "70% off WorldMonitor Pro until December 4",
      preheader:
        "$144 for the first year of Pro Yearly instead of $479.88 paying monthly. Renews at $359.99/year. Cancel anytime.",
      headline: "70% off Pro",
      intro: "The first year of Pro Yearly is $144. That is $12 a month, against $39.99 a month paying monthly.",
      cta: "Get Pro for $144",
    },
    lapsed: {
      subject: "Come back to WorldMonitor Pro: $144 for the first year",
      preheader:
        "70% off Pro against paying monthly, until December 4. Renews at $359.99/year. Cancel anytime.",
      headline: "70% off Pro",
      intro:
        "Your Pro subscription ended. If you want it back, the first year of Pro Yearly is $144 until December 4. That is $12 a month, against $39.99 a month paying monthly.",
      cta: "Come back to Pro",
    },
    "monthly-switch": {
      subject: "Switch to Pro Yearly: $12 a month instead of $39.99",
      preheader:
        "$144 for the first year, then $359.99/year. Cancel anytime. Offer ends December 4, 2026 at 23:45 UTC.",
      headline: "70% off Pro",
      intro:
        "You pay $39.99 a month for Pro. Switch to Pro Yearly by December 4 and the first year is $144, which is $12 a month.",
      cta: "Switch to yearly",
    },
    "last-day": {
      subject: "Last day: 70% off WorldMonitor Pro ends today at 23:45 UTC",
      preheader: "$144 for the first year of Pro Yearly. Renews at $359.99/year. Cancel anytime.",
      headline: "Last day: 70% off Pro",
      intro:
        "The Black Friday price ends today, December 4, 2026, at 23:45 UTC. After that, Pro Yearly is $359.99 a year.",
      cta: "Get Pro for $144",
    },
    "last-day-switch": {
      subject: "Last day to switch to Pro Yearly at $12 a month",
      preheader:
        "$144 for the first year, then $359.99/year. Cancel anytime. Offer ends today at 23:45 UTC.",
      headline: "Last day: 70% off Pro",
      intro:
        "The Black Friday price ends today, December 4, 2026, at 23:45 UTC. You pay $39.99 a month for Pro; on Pro Yearly the first year is $144, which is $12 a month.",
      cta: "Switch to yearly",
    },
  },
};

const ZH: BlackFridayLocaleCopy = {
  listSep: "，",
  colon: "：",
  kicker: "黑色星期五",
  cardFirstYear: "Pro 年度版首年",
  cardInstead: "而非按月支付的 $479.88",
  cardPerMonth: "相当于每月 $12，按年计费",
  renews: "之后按 $359.99/年续费。可随时取消。",
  ends: "优惠截至 UTC 时间 2026 年 12 月 4 日 23:45。",
  checkoutNote: "折扣将在结账时自动生效，无需输入优惠码。价格以美元计价；结账时可能另加税费或增值税。",
  waitlistNote: "结账前需要先创建 WorldMonitor 账户。",
  switchNote: "折扣将在切换时自动生效，无需输入优惠码。价格以美元计价；可能另加税费或增值税。",
  switchPath: "上方按钮会打开仪表板中的“{settings}”→“{account}”页面，请在该页面点击“{switchToYearly}”。",
  stepsTitle: "切换后会发生什么",
  steps: [
    "您的套餐立即变为 Pro 年度版。",
    "立即扣款：首年 $144，减去本月未使用部分的费用。确认前您会看到确切金额。",
    "仍是您原来的订阅，不会另建新订阅。计费周期从切换当天重新开始。",
  ],
  switchSummary:
    "切换会立即将您现有的订阅变为 Pro 年度版。费用按比例计算：$144 减去本月未使用部分的费用。不会新建订阅。",
  proLine: "Pro 包含 WM Analyst 聊天、AI 股票分析与回测、告警规则与定时 AI 摘要，以及面向 Claude 等 AI 客户端的 MCP 访问。",
  reply: "有疑问？直接回复此邮件即可。",
  reasonAccount: "您收到此邮件，是因为您拥有 WorldMonitor 账户。",
  reasonWaitlist: "您收到此邮件，是因为您加入了 WorldMonitor 候补名单。",
  unsubscribe: "退订",
  versions: {
    "new-buyer": {
      subject: "WorldMonitor Pro 立省 70%，优惠截至 12 月 4 日",
      preheader: "Pro 年度版首年 $144，而非按月支付的 $479.88。之后按 $359.99/年续费，可随时取消。",
      headline: "Pro 立省 70%",
      intro: "Pro 年度版首年只需 $144，相当于每月 $12；按月支付则是每月 $39.99。",
      cta: "以 $144 订阅 Pro",
    },
    lapsed: {
      subject: "重新订阅 WorldMonitor Pro：首年 $144",
      preheader: "与按月支付相比，Pro 立省 70%，优惠截至 12 月 4 日。之后按 $359.99/年续费，可随时取消。",
      headline: "Pro 立省 70%",
      intro:
        "您的 Pro 订阅已结束。如果想重新订阅，12 月 4 日优惠截止前，Pro 年度版首年只需 $144，相当于每月 $12；按月支付则是每月 $39.99。",
      cta: "重新订阅 Pro",
    },
    "monthly-switch": {
      subject: "改为 Pro 年度版：每月 $12，而非 $39.99",
      preheader: "首年 $144，之后 $359.99/年。可随时取消。优惠截至 UTC 时间 2026 年 12 月 4 日 23:45。",
      headline: "Pro 立省 70%",
      intro: "您目前按月支付 Pro，每月 $39.99。在 12 月 4 日优惠截止前改为 Pro 年度版，首年只需 $144，相当于每月 $12。",
      cta: "切换为年付",
    },
    "last-day": {
      subject: "最后一天：WorldMonitor Pro 立省 70%，今天 UTC 时间 23:45 截止",
      preheader: "Pro 年度版首年 $144。之后按 $359.99/年续费，可随时取消。",
      headline: "最后一天：Pro 立省 70%",
      intro: "黑色星期五优惠价将于今天（2026 年 12 月 4 日）UTC 时间 23:45 结束。之后 Pro 年度版恢复为 $359.99/年。",
      cta: "以 $144 订阅 Pro",
    },
    "last-day-switch": {
      subject: "最后一天：改为 Pro 年度版，每月 $12",
      preheader: "首年 $144，之后 $359.99/年。可随时取消。优惠今天 UTC 时间 23:45 截止。",
      headline: "最后一天：Pro 立省 70%",
      intro:
        "黑色星期五优惠价将于今天（2026 年 12 月 4 日）UTC 时间 23:45 结束。您目前按月支付 Pro，每月 $39.99；改为 Pro 年度版后，首年只需 $144，相当于每月 $12。",
      cta: "切换为年付",
    },
  },
};

const FR: BlackFridayLocaleCopy = {
  listSep: ", ",
  colon: "\u00a0: ",
  kicker: "Black Friday",
  cardFirstYear: "Première année de Pro Annuel",
  cardInstead: "au lieu de $479.88 en paiement mensuel",
  cardPerMonth: "soit $12 par mois, facturé annuellement",
  renews: "Renouvellement à $359.99/an. Annulez à tout moment.",
  ends: "L'offre se termine le 4 décembre 2026 à 23\u00a0h\u00a045 UTC.",
  checkoutNote:
    "La réduction est appliquée automatiquement au moment du paiement. Aucun code à saisir. Prix en dollars américains\u00a0; des taxes ou la TVA peuvent s'y ajouter.",
  waitlistNote: "Vous devrez d'abord créer un compte WorldMonitor pour payer.",
  switchNote:
    "La réduction est appliquée automatiquement lors du changement. Aucun code à saisir. Prix en dollars américains\u00a0; des taxes ou la TVA peuvent s'ajouter.",
  switchPath: "Ce bouton ouvre {settings} → {account} dans le tableau de bord. Cliquez ensuite sur «\u00a0{switchToYearly}\u00a0».",
  stepsTitle: "Ce qui se passe quand vous passez à l'annuel",
  steps: [
    "Votre abonnement passe immédiatement à Pro Annuel.",
    "Vous êtes débité tout de suite\u00a0: $144 pour la première année, moins la part non utilisée du mois en cours. Le montant exact s'affiche avant que vous confirmiez.",
    "C'est le même abonnement\u00a0: aucun nouvel abonnement n'est créé. Votre période de facturation redémarre le jour du changement.",
  ],
  switchSummary:
    "Le changement fait passer immédiatement votre abonnement actuel à Pro Annuel. Le montant est calculé au prorata\u00a0: $144 moins la part non utilisée du mois en cours. Aucun nouvel abonnement n'est créé.",
  proLine:
    "Pro comprend le chat WM Analyst, l'analyse boursière et le backtesting par IA, les règles d'alerte avec un résumé IA planifié et l'accès MCP pour Claude et d'autres clients IA.",
  reply: "Une question\u00a0? Répondez à cet e-mail.",
  reasonAccount: "Vous recevez cet e-mail parce que vous avez un compte WorldMonitor.",
  reasonWaitlist: "Vous recevez cet e-mail parce que vous vous êtes inscrit sur la liste d'attente de WorldMonitor.",
  unsubscribe: "Se désabonner",
  versions: {
    "new-buyer": {
      subject: "70\u00a0% de réduction sur WorldMonitor Pro jusqu'au 4 décembre",
      preheader:
        "$144 pour la première année de Pro Annuel au lieu de $479.88 en paiement mensuel. Renouvellement à $359.99/an. Annulez à tout moment.",
      headline: "70\u00a0% de réduction sur Pro",
      intro:
        "La première année de Pro Annuel est à $144, soit $12 par mois, contre $39.99 par mois en paiement mensuel.",
      cta: "Passer à Pro pour $144",
    },
    lapsed: {
      subject: "Revenez à WorldMonitor Pro\u00a0: $144 la première année",
      preheader:
        "70\u00a0% de réduction sur Pro par rapport au paiement mensuel, jusqu'au 4 décembre. Renouvellement à $359.99/an. Annulez à tout moment.",
      headline: "70\u00a0% de réduction sur Pro",
      intro:
        "Votre abonnement Pro a pris fin. Si vous souhaitez vous réabonner, la première année de Pro Annuel est à $144 jusqu'au 4 décembre. Cela revient à $12 par mois, contre $39.99 par mois en paiement mensuel.",
      cta: "Revenir à Pro",
    },
    "monthly-switch": {
      subject: "Passez à Pro Annuel\u00a0: $12 par mois au lieu de $39.99",
      preheader:
        "$144 la première année, puis $359.99/an. Annulez à tout moment. L'offre se termine le 4 décembre 2026 à 23\u00a0h\u00a045 UTC.",
      headline: "70\u00a0% de réduction sur Pro",
      intro:
        "Vous payez actuellement $39.99 par mois pour Pro. Passez à Pro Annuel d'ici le 4 décembre\u00a0: la première année vous coûtera $144, soit $12 par mois.",
      cta: "Passer à l'abonnement annuel",
    },
    "last-day": {
      subject: "Dernier jour\u00a0: 70\u00a0% de réduction sur WorldMonitor Pro, jusqu'à 23\u00a0h\u00a045 UTC aujourd'hui",
      preheader: "$144 pour la première année de Pro Annuel. Renouvellement à $359.99/an. Annulez à tout moment.",
      headline: "Dernier jour\u00a0: 70\u00a0% de réduction sur Pro",
      intro:
        "Le prix Black Friday prend fin aujourd'hui, le 4 décembre 2026, à 23\u00a0h\u00a045 UTC. Ensuite, Pro Annuel revient à $359.99 par an.",
      cta: "Passer à Pro pour $144",
    },
    "last-day-switch": {
      subject: "Dernier jour pour passer à Pro Annuel à $12 par mois",
      preheader:
        "$144 la première année, puis $359.99/an. Annulez à tout moment. L'offre se termine aujourd'hui à 23\u00a0h\u00a045 UTC.",
      headline: "Dernier jour\u00a0: 70\u00a0% de réduction sur Pro",
      intro:
        "Le prix Black Friday prend fin aujourd'hui, le 4 décembre 2026, à 23\u00a0h\u00a045 UTC. Vous payez actuellement $39.99 par mois pour Pro\u00a0; avec Pro Annuel, la première année est à $144, soit $12 par mois.",
      cta: "Passer à l'abonnement annuel",
    },
  },
};

const TR: BlackFridayLocaleCopy = {
  listSep: ", ",
  colon: ": ",
  kicker: "Kara Cuma",
  cardFirstYear: "Pro Yıllık'ın ilk yılı",
  cardInstead: "aylık ödemedeki $479.88 yerine",
  cardPerMonth: "ayda $12, yıllık faturalandırılır",
  renews: "Yılda $359.99 olarak yenilenir. İstediğiniz zaman iptal edebilirsiniz.",
  ends: "Teklif 4 Aralık 2026, saat 23:45'te (UTC) sona eriyor.",
  checkoutNote:
    "İndirim ödeme sırasında otomatik olarak uygulanır. Kod girmeniz gerekmez. Fiyatlar ABD doları cinsindendir; ödeme sırasında vergi veya KDV eklenebilir.",
  waitlistNote: "Ödeme için önce bir WorldMonitor hesabı oluşturmanız gerekir.",
  switchNote:
    "İndirim geçiş sırasında otomatik olarak uygulanır. Kod girmeniz gerekmez. Fiyatlar ABD doları cinsindendir; vergi veya KDV eklenebilir.",
  switchPath: "Bu düğme, panoda {settings} → {account} bölümünü açar. Ardından “{switchToYearly}” düğmesine tıklayın.",
  stepsTitle: "Geçiş yaptığınızda ne olur",
  steps: [
    "Planınız hemen Pro Yıllık'a geçer.",
    "Ücret hemen tahsil edilir: ilk yıl için $144; bu ayın kullanılmayan kısmı bu tutardan düşülür. Onaylamadan önce kesin tutarı görürsünüz.",
    "Aboneliğiniz aynı kalır; yeni bir abonelik oluşturulmaz. Faturalandırma döneminiz geçiş yaptığınız gün yeniden başlar.",
  ],
  switchSummary:
    "Geçiş, mevcut aboneliğinizi hemen Pro Yıllık'a çevirir. Ücret orantılı olarak hesaplanır: $144 tutarından bu ayın kullanılmayan kısmı düşülür. Yeni bir abonelik oluşturulmaz.",
  proLine:
    "Pro; WM Analyst sohbetini, yapay zekâ destekli hisse senedi analizini ve geriye dönük testi, uyarı kurallarını ve zamanlanmış yapay zekâ özetini, ayrıca Claude ve diğer yapay zekâ istemcileri için MCP erişimini içerir.",
  reply: "Sorunuz mu var? Bu e-postayı yanıtlayın.",
  reasonAccount: "Bu e-postayı WorldMonitor hesabınız olduğu için alıyorsunuz.",
  reasonWaitlist: "Bu e-postayı WorldMonitor bekleme listesine katıldığınız için alıyorsunuz.",
  unsubscribe: "Abonelikten çık",
  versions: {
    "new-buyer": {
      subject: "WorldMonitor Pro'da %70 indirim, 4 Aralık'a kadar",
      preheader:
        "Pro Yıllık'ın ilk yılı, aylık ödemedeki $479.88 yerine $144. Yılda $359.99 olarak yenilenir. İstediğiniz zaman iptal edebilirsiniz.",
      headline: "Pro'da %70 indirim",
      intro: "Pro Yıllık'ın ilk yılı $144. Bu, ayda $12 eder; aylık ödemede ise ayda $39.99.",
      cta: "$144 ile Pro'ya geçin",
    },
    lapsed: {
      subject: "WorldMonitor Pro'ya geri dönün: ilk yıl $144",
      preheader:
        "Aylık ödemeye göre Pro'da %70 indirim, 4 Aralık'a kadar. Yılda $359.99 olarak yenilenir. İstediğiniz zaman iptal edebilirsiniz.",
      headline: "Pro'da %70 indirim",
      intro:
        "Pro aboneliğiniz sona erdi. Geri dönmek isterseniz, 4 Aralık'a kadar Pro Yıllık'ın ilk yılı $144. Bu, ayda $12 eder; aylık ödemede ise ayda $39.99.",
      cta: "Pro'ya geri dönün",
    },
    "monthly-switch": {
      subject: "Pro Yıllık'a geçin: ayda $39.99 yerine $12",
      preheader:
        "İlk yıl $144, sonrasında yılda $359.99. İstediğiniz zaman iptal edebilirsiniz. Teklif 4 Aralık 2026, saat 23:45'te (UTC) sona eriyor.",
      headline: "Pro'da %70 indirim",
      intro:
        "Pro için ayda $39.99 ödüyorsunuz. 4 Aralık'a kadar Pro Yıllık'a geçerseniz ilk yıl $144 olur; bu da ayda $12 eder.",
      cta: "Yıllık plana geçin",
    },
    "last-day": {
      subject: "Son gün: WorldMonitor Pro'da %70 indirim bugün 23:45'te (UTC) bitiyor",
      preheader:
        "Pro Yıllık'ın ilk yılı $144. Yılda $359.99 olarak yenilenir. İstediğiniz zaman iptal edebilirsiniz.",
      headline: "Son gün: Pro'da %70 indirim",
      intro:
        "Kara Cuma fiyatı bugün, 4 Aralık 2026, saat 23:45'te (UTC) sona eriyor. Sonrasında Pro Yıllık yeniden yılda $359.99 olur.",
      cta: "$144 ile Pro'ya geçin",
    },
    "last-day-switch": {
      subject: "Ayda $12 ile Pro Yıllık'a geçmek için son gün",
      preheader:
        "İlk yıl $144, sonrasında yılda $359.99. İstediğiniz zaman iptal edebilirsiniz. Teklif bugün 23:45'te (UTC) sona eriyor.",
      headline: "Son gün: Pro'da %70 indirim",
      intro:
        "Kara Cuma fiyatı bugün, 4 Aralık 2026, saat 23:45'te (UTC) sona eriyor. Pro için ayda $39.99 ödüyorsunuz; Pro Yıllık'ta ilk yıl $144 olur, bu da ayda $12 eder.",
      cta: "Yıllık plana geçin",
    },
  },
};

const ES: BlackFridayLocaleCopy = {
  listSep: ", ",
  colon: ": ",
  kicker: "Black Friday",
  cardFirstYear: "Primer año de Pro Anual",
  cardInstead: "en lugar de $479.88 pagando mensualmente",
  cardPerMonth: "$12 al mes, facturado anualmente",
  renews: "Se renueva a $359.99 al año. Cancela en cualquier momento.",
  ends: "La oferta termina el 4 de diciembre de 2026 a las 23:45 UTC.",
  checkoutNote:
    "El descuento se aplica automáticamente al pagar. No hay que introducir ningún código. Precios en dólares estadounidenses; al pagar pueden añadirse impuestos o IVA.",
  waitlistNote: "Para pagar, primero tendrás que crear una cuenta de WorldMonitor.",
  switchNote:
    "El descuento se aplica automáticamente al cambiar. No hay que introducir ningún código. Precios en dólares estadounidenses; pueden añadirse impuestos o IVA.",
  switchPath: "Este botón abre {settings} → {account} en el panel. Después, haz clic en «{switchToYearly}».",
  stepsTitle: "Qué ocurre al cambiar",
  steps: [
    "Tu plan pasa a Pro Anual de inmediato.",
    "Se te cobra en el momento: $144 por el primer año, menos la parte no utilizada de este mes. Verás el importe exacto antes de confirmar.",
    "Es la misma suscripción: no se crea una nueva. Tu periodo de facturación se reinicia el día del cambio.",
  ],
  switchSummary:
    "Al cambiar, tu suscripción actual pasa a Pro Anual de inmediato. El cobro se prorratea: $144 menos la parte no utilizada de este mes. No se crea una suscripción nueva.",
  proLine:
    "Pro incluye el chat WM Analyst, análisis de acciones y backtesting con IA, reglas de alerta con un resumen de IA programado y acceso MCP para Claude y otros clientes de IA.",
  reply: "¿Tienes preguntas? Responde a este correo.",
  reasonAccount: "Recibes este correo porque tienes una cuenta de WorldMonitor.",
  reasonWaitlist: "Recibes este correo porque te uniste a la lista de espera de WorldMonitor.",
  unsubscribe: "Darse de baja",
  versions: {
    "new-buyer": {
      subject: "70\u00a0% de descuento en WorldMonitor Pro hasta el 4 de diciembre",
      preheader:
        "$144 por el primer año de Pro Anual en lugar de $479.88 pagando mensualmente. Se renueva a $359.99 al año. Cancela en cualquier momento.",
      headline: "70\u00a0% de descuento en Pro",
      intro: "El primer año de Pro Anual cuesta $144. Son $12 al mes, frente a $39.99 al mes pagando mensualmente.",
      cta: "Obtener Pro por $144",
    },
    lapsed: {
      subject: "Vuelve a WorldMonitor Pro: $144 el primer año",
      preheader:
        "70\u00a0% de descuento en Pro frente al pago mensual, hasta el 4 de diciembre. Se renueva a $359.99 al año. Cancela en cualquier momento.",
      headline: "70\u00a0% de descuento en Pro",
      intro:
        "Tu suscripción a Pro terminó. Si quieres recuperarla, el primer año de Pro Anual cuesta $144 hasta el 4 de diciembre. Son $12 al mes, frente a $39.99 al mes pagando mensualmente.",
      cta: "Volver a Pro",
    },
    "monthly-switch": {
      subject: "Cámbiate a Pro Anual: $12 al mes en lugar de $39.99",
      preheader:
        "$144 el primer año, después $359.99 al año. Cancela en cualquier momento. La oferta termina el 4 de diciembre de 2026 a las 23:45 UTC.",
      headline: "70\u00a0% de descuento en Pro",
      intro:
        "Pagas $39.99 al mes por Pro. Si te cambias a Pro Anual a más tardar el 4 de diciembre, el primer año cuesta $144, es decir, $12 al mes.",
      cta: "Cambiar a facturación anual",
    },
    "last-day": {
      subject: "Último día: 70\u00a0% de descuento en WorldMonitor Pro, hasta hoy a las 23:45 UTC",
      preheader: "$144 por el primer año de Pro Anual. Se renueva a $359.99 al año. Cancela en cualquier momento.",
      headline: "Último día: 70\u00a0% de descuento en Pro",
      intro:
        "El precio de Black Friday termina hoy, 4 de diciembre de 2026, a las 23:45 UTC. Después, Pro Anual vuelve a costar $359.99 al año.",
      cta: "Obtener Pro por $144",
    },
    "last-day-switch": {
      subject: "Último día para cambiarte a Pro Anual por $12 al mes",
      preheader:
        "$144 el primer año, después $359.99 al año. Cancela en cualquier momento. La oferta termina hoy a las 23:45 UTC.",
      headline: "Último día: 70\u00a0% de descuento en Pro",
      intro:
        "El precio de Black Friday termina hoy, 4 de diciembre de 2026, a las 23:45 UTC. Pagas $39.99 al mes por Pro; con Pro Anual, el primer año cuesta $144, es decir, $12 al mes.",
      cta: "Cambiar a facturación anual",
    },
  },
};

const DE: BlackFridayLocaleCopy = {
  listSep: ", ",
  colon: ": ",
  kicker: "Black Friday",
  cardFirstYear: "Erstes Jahr Pro Yearly",
  cardInstead: "statt $479.88 bei monatlicher Zahlung",
  cardPerMonth: "$12 pro Monat, jährlich abgerechnet",
  renews: "Verlängert sich für $359.99/Jahr. Jederzeit kündbar.",
  ends: "Das Angebot endet am 4. Dezember 2026 um 23:45 Uhr UTC.",
  checkoutNote:
    "Der Rabatt wird an der Kasse automatisch abgezogen. Sie müssen keinen Code eingeben. Preise in US-Dollar; an der Kasse können Steuern oder Mehrwertsteuer hinzukommen.",
  waitlistNote: "Vor der Zahlung legen Sie ein WorldMonitor-Konto an.",
  switchNote:
    "Der Rabatt wird beim Wechsel automatisch abgezogen. Sie müssen keinen Code eingeben. Preise in US-Dollar; Steuern oder Mehrwertsteuer können hinzukommen.",
  switchPath: "Die Schaltfläche öffnet im Dashboard {settings} → {account}. Wählen Sie dort „{switchToYearly}“.",
  stepsTitle: "Was beim Wechsel passiert",
  steps: [
    "Ihr Abo wechselt sofort zu Pro Yearly.",
    "Die Zahlung wird sofort fällig: $144 für das erste Jahr, abzüglich des ungenutzten Teils des laufenden Monats. Den genauen Betrag sehen Sie, bevor Sie bestätigen.",
    "Es bleibt dasselbe Abo; es wird kein neues angelegt. Ihr Abrechnungszeitraum beginnt am Tag des Wechsels neu.",
  ],
  switchSummary:
    "Der Wechsel stellt Ihr bestehendes Abo sofort auf Pro Yearly um. Der Betrag wird anteilig berechnet: $144 abzüglich des ungenutzten Teils des laufenden Monats. Es wird kein neues Abo angelegt.",
  proLine:
    "Pro umfasst den WM-Analyst-Chat, KI-Aktienanalyse und Backtesting, Warnregeln mit zeitgesteuerter KI-Zusammenfassung sowie MCP-Zugriff für Claude und andere KI-Clients.",
  reply: "Fragen? Antworten Sie einfach auf diese E-Mail.",
  reasonAccount: "Sie erhalten diese E-Mail, weil Sie ein WorldMonitor-Konto haben.",
  reasonWaitlist: "Sie erhalten diese E-Mail, weil Sie sich auf die WorldMonitor-Warteliste gesetzt haben.",
  unsubscribe: "Abmelden",
  versions: {
    "new-buyer": {
      subject: "70\u00a0% Rabatt auf WorldMonitor Pro bis zum 4. Dezember",
      preheader:
        "$144 für das erste Jahr Pro Yearly statt $479.88 bei monatlicher Zahlung. Verlängert sich für $359.99/Jahr. Jederzeit kündbar.",
      headline: "70\u00a0% Rabatt auf Pro",
      intro:
        "Das erste Jahr Pro Yearly kostet $144. Das sind $12 pro Monat statt $39.99 pro Monat bei monatlicher Zahlung.",
      cta: "Pro für $144 abonnieren",
    },
    lapsed: {
      subject: "Zurück zu WorldMonitor Pro: $144 im ersten Jahr",
      preheader:
        "70\u00a0% Rabatt auf Pro gegenüber monatlicher Zahlung, bis zum 4. Dezember. Verlängert sich für $359.99/Jahr. Jederzeit kündbar.",
      headline: "70\u00a0% Rabatt auf Pro",
      intro:
        "Ihr Pro-Abo ist beendet. Wenn Sie es wieder nutzen möchten: Bis zum 4. Dezember kostet das erste Jahr Pro Yearly $144. Das sind $12 pro Monat statt $39.99 pro Monat bei monatlicher Zahlung.",
      cta: "Zurück zu Pro",
    },
    "monthly-switch": {
      subject: "Zu Pro Yearly wechseln: $12 pro Monat statt $39.99",
      preheader:
        "$144 im ersten Jahr, danach $359.99/Jahr. Jederzeit kündbar. Das Angebot endet am 4. Dezember 2026 um 23:45 Uhr UTC.",
      headline: "70\u00a0% Rabatt auf Pro",
      intro:
        "Sie zahlen $39.99 pro Monat für Pro. Wenn Sie bis zum 4. Dezember zu Pro Yearly wechseln, kostet das erste Jahr $144, also $12 pro Monat.",
      cta: "Auf jährlich umstellen",
    },
    "last-day": {
      subject: "Letzter Tag: 70\u00a0% Rabatt auf WorldMonitor Pro endet heute um 23:45 Uhr UTC",
      preheader: "$144 für das erste Jahr Pro Yearly. Verlängert sich für $359.99/Jahr. Jederzeit kündbar.",
      headline: "Letzter Tag: 70\u00a0% Rabatt auf Pro",
      intro:
        "Der Black-Friday-Preis endet heute, am 4. Dezember 2026, um 23:45 Uhr UTC. Danach kostet Pro Yearly wieder $359.99 pro Jahr.",
      cta: "Pro für $144 abonnieren",
    },
    "last-day-switch": {
      subject: "Letzter Tag: für $12 pro Monat zu Pro Yearly wechseln",
      preheader:
        "$144 im ersten Jahr, danach $359.99/Jahr. Jederzeit kündbar. Das Angebot endet heute um 23:45 Uhr UTC.",
      headline: "Letzter Tag: 70\u00a0% Rabatt auf Pro",
      intro:
        "Der Black-Friday-Preis endet heute, am 4. Dezember 2026, um 23:45 Uhr UTC. Sie zahlen $39.99 pro Monat für Pro; mit Pro Yearly kostet das erste Jahr $144, also $12 pro Monat.",
      cta: "Auf jährlich umstellen",
    },
  },
};

export const BLACK_FRIDAY_COPY: Record<BlackFridayLocale, BlackFridayLocaleCopy> = {
  en: EN,
  zh: ZH,
  fr: FR,
  tr: TR,
  es: ES,
  de: DE,
};

// The frame's palette (shared/email-frame.ts), as solid colours: Outlook
// ignores rgba, and a solid dark surface is what dark-mode clients leave alone.
const PAGE_BG = "#111111";
const PANEL_BG = "#0d0d0d";
const FOOTER_BG = "#0a0a0a";
const CARD_BG = "#101b14";
const CARD_BORDER = "#2a6e45";
const RULE = "#1f1f1f";
const TEXT = "#e5e5e5";
const MUTED = "#a3a3a3";
const FAINT = "#8a8a8a";
const LOGO_URL = "https://www.worldmonitor.app/favico/android-chrome-192x192.png";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

const PROMO_PRICE = "$144";
const MONTHLY_TOTAL = "$479.88";

/**
 * Capitals in the string, not `text-transform`: Gmail strips the `lang`
 * attribute, and CSS uppercasing then gets the Turkish dotted I wrong.
 */
function upper(text: string, locale: BlackFridayLocale): string {
  return text.toLocaleUpperCase(locale);
}

function row(innerHtml: string, padding: string, extra = ""): string {
  return `<tr><td style="padding: ${padding}; font-family: ${FONT};${extra}">${innerHtml}</td></tr>`;
}

function paragraph(text: string, color: string = TEXT, size = 16): string {
  return `<p style="margin: 0; font-size: ${size}px; line-height: 1.55; color: ${color};">${escapeEmailHtml(text)}</p>`;
}

/**
 * A full-width button. The cell carries the colour and, for Outlook, the
 * padding (`mso-padding-alt`); everywhere else the link itself is the padded
 * block, so the whole button is the hit target.
 */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" bgcolor="${EMAIL_ACCENT}" style="background: ${EMAIL_ACCENT}; border-radius: 4px; mso-padding-alt: 16px 24px;"><a href="${escapeEmailHtml(href)}" style="display: block; padding: 16px 24px; font-family: ${FONT}; font-size: 16px; line-height: 1.25; font-weight: 700; color: #0a0a0a; text-decoration: none; border-radius: 4px;">${escapeEmailHtml(label)}</a></td></tr></table>`;
}

function offerCard(copy: BlackFridayLocaleCopy): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${CARD_BG}" style="background: ${CARD_BG}; border: 1px solid ${CARD_BORDER}; border-radius: 4px;"><tr><td style="padding: 20px 20px 18px; font-family: ${FONT};">
<div style="font-size: 44px; line-height: 1.1; font-weight: 800; color: #ffffff; letter-spacing: -1px;">${PROMO_PRICE} <span style="font-size: 20px; font-weight: 400; color: ${FAINT}; letter-spacing: 0; text-decoration: line-through;">${MONTHLY_TOTAL}</span></div>
<div style="margin-top: 8px; font-size: 15px; line-height: 1.5; color: ${TEXT};">${escapeEmailHtml(copy.cardFirstYear + copy.listSep + copy.cardInstead)}</div>
<div style="margin-top: 2px; font-size: 15px; line-height: 1.5; font-weight: 700; color: ${EMAIL_ACCENT};">${escapeEmailHtml(copy.cardPerMonth)}</div>
<div style="margin-top: 14px; padding-top: 14px; border-top: 1px solid ${CARD_BORDER}; font-size: 15px; line-height: 1.5; font-weight: 700; color: #ffffff;">${escapeEmailHtml(copy.renews)}</div>
<div style="margin-top: 4px; font-size: 13px; line-height: 1.5; color: ${MUTED};">${escapeEmailHtml(copy.ends)}</div>
</td></tr></table>`;
}

function stepsBlock(copy: BlackFridayLocaleCopy, locale: BlackFridayLocale): string {
  const rows = copy.steps
    .map(
      (step, index) =>
        `<tr><td width="28" valign="top" style="width: 28px; padding: 0 0 10px; font-family: ${MONO}; font-size: 13px; line-height: 1.6; color: ${EMAIL_ACCENT};">${index + 1}.</td><td valign="top" style="padding: 0 0 10px; font-family: ${FONT}; font-size: 15px; line-height: 1.55; color: ${TEXT};">${escapeEmailHtml(step)}</td></tr>`,
    )
    .join("");
  return `<div style="font-family: ${MONO}; font-size: 12px; line-height: 1.4; letter-spacing: 1px; color: ${MUTED}; margin: 0 0 12px;">${escapeEmailHtml(upper(copy.stepsTitle, locale))}</div><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>`;
}

export interface BlackFridayEmailArgs {
  version: BlackFridayVersion;
  /** A BCP 47 tag or language code; anything unsupported renders English. */
  locale?: string | null;
  /** Default "account". Only "new-buyer" and "last-day" go to waitlist contacts. */
  recipient?: BlackFridayRecipient;
  /** Per-recipient unsubscribe URL. Default: Resend's broadcast token. */
  unsubscribeUrl?: string;
}

export interface BlackFridayEmail {
  locale: BlackFridayLocale;
  subject: string;
  preheader: string;
  html: string;
  text: string;
  ctaUrl: string;
}

function notesFor(
  copy: BlackFridayLocaleCopy,
  locale: BlackFridayLocale,
  version: BlackFridayVersion,
  recipient: BlackFridayRecipient,
): string[] {
  if (isSwitchVersion(version)) return [blackFridaySwitchPath(locale), copy.switchNote];
  return recipient === "waitlist" ? [copy.checkoutNote, copy.waitlistNote] : [copy.checkoutNote];
}

function renderText(args: {
  copy: BlackFridayLocaleCopy;
  locale: BlackFridayLocale;
  version: BlackFridayVersion;
  recipient: BlackFridayRecipient;
  ctaUrl: string;
  unsubscribeUrl: string;
}): string {
  const { copy, locale, version, recipient, ctaUrl, unsubscribeUrl } = args;
  const v = copy.versions[version];
  const lines: string[] = [
    v.headline,
    "",
    v.intro,
    "",
    `${PROMO_PRICE}${copy.colon}${copy.cardFirstYear}${copy.listSep}${copy.cardInstead}`,
    copy.cardPerMonth,
    copy.renews,
    copy.ends,
    "",
    `${v.cta}${copy.colon}${ctaUrl}`,
    "",
    ...notesFor(copy, locale, version, recipient),
  ];
  if (version === "monthly-switch") {
    lines.push("", `${copy.stepsTitle}${copy.colon.trimEnd()}`, ...copy.steps.map((step, index) => `${index + 1}. ${step}`));
  } else if (version === "last-day-switch") {
    lines.push("", copy.switchSummary);
  } else if (version !== "last-day") {
    lines.push("", copy.proLine);
  }
  lines.push(
    "",
    copy.reply,
    "",
    "--",
    recipient === "waitlist" ? copy.reasonWaitlist : copy.reasonAccount,
    `${copy.unsubscribe}${copy.colon}${unsubscribeUrl}`,
    BLACK_FRIDAY_PHYSICAL_ADDRESS,
    "",
  );
  return lines.join("\n");
}

function renderHtml(args: {
  copy: BlackFridayLocaleCopy;
  locale: BlackFridayLocale;
  version: BlackFridayVersion;
  recipient: BlackFridayRecipient;
  ctaUrl: string;
  unsubscribeUrl: string;
}): string {
  const { copy, locale, version, recipient, ctaUrl, unsubscribeUrl } = args;
  const v = copy.versions[version];
  // Resend's token is substituted before delivery and must stay byte-exact.
  const unsubscribeHref =
    unsubscribeUrl === RESEND_UNSUBSCRIBE_TOKEN ? unsubscribeUrl : escapeEmailHtml(unsubscribeUrl);
  const notes = notesFor(copy, locale, version, recipient)
    .map((note) => `<p style="margin: 0 0 6px; font-size: 13px; line-height: 1.55; color: ${MUTED};">${escapeEmailHtml(note)}</p>`)
    .join("");

  let detail = "";
  if (version === "monthly-switch") {
    detail = row(stepsBlock(copy, locale), "24px 24px 0");
  } else if (version === "last-day-switch") {
    detail = row(paragraph(copy.switchSummary, TEXT, 15), "20px 24px 0");
  } else if (version !== "last-day") {
    detail = row(paragraph(copy.proLine, TEXT, 15), "20px 24px 0");
  }

  const header = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td valign="middle" style="vertical-align: middle;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="32" valign="middle" style="width: 32px; vertical-align: middle;"><img src="${LOGO_URL}" width="32" height="32" alt="" style="display: block; width: 32px; height: 32px; border: 0; border-radius: 16px;" /></td>
<td valign="middle" style="padding-left: 10px; vertical-align: middle; font-family: ${FONT}; font-size: 14px; line-height: 1.2; font-weight: 800; letter-spacing: 0.2px; color: #ffffff; white-space: nowrap;">WORLD MONITOR</td>
</tr></table></td>
<td align="right" valign="middle" style="vertical-align: middle; text-align: right; font-family: ${MONO}; font-size: 11px; line-height: 1.2; letter-spacing: 1.5px; color: ${EMAIL_ACCENT};">${escapeEmailHtml(upper(copy.kicker, locale))}</td>
</tr></table>`;

  const footer = `<p style="margin: 0 0 8px; font-size: 12px; line-height: 1.6; color: ${FAINT};">${escapeEmailHtml(recipient === "waitlist" ? copy.reasonWaitlist : copy.reasonAccount)} <a href="${unsubscribeHref}" style="color: ${MUTED}; text-decoration: underline;">${escapeEmailHtml(copy.unsubscribe)}</a></p>
<p style="margin: 0; font-size: 12px; line-height: 1.6; color: ${FAINT};">${escapeEmailHtml(BLACK_FRIDAY_PHYSICAL_ADDRESS)} &middot; <a href="${SITE}" style="color: ${MUTED}; text-decoration: underline;">worldmonitor.app</a></p>`;

  return `<!DOCTYPE html>
<html lang="${locale === "zh" ? "zh-Hans" : locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<title>${escapeEmailHtml(v.subject)}</title>
</head>
<body bgcolor="${PAGE_BG}" style="margin: 0; padding: 0; background: ${PAGE_BG};">
<div style="display: none; max-height: 0; max-width: 0; overflow: hidden; opacity: 0; mso-hide: all; font-size: 1px; line-height: 1px; color: ${PAGE_BG};">${escapeEmailHtml(v.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${PAGE_BG}" style="background: ${PAGE_BG};"><tr><td align="center" style="padding: 0;">
<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${PANEL_BG}" style="width: 100%; max-width: 600px; margin: 0 auto; background: ${PANEL_BG};">
<tr><td height="3" bgcolor="${EMAIL_ACCENT}" style="height: 3px; background: ${EMAIL_ACCENT}; font-size: 0; line-height: 0;">&nbsp;</td></tr>
${row(header, "24px 24px 0")}
${row(`<h1 style="margin: 0; font-family: ${FONT}; font-size: 34px; line-height: 1.15; font-weight: 800; letter-spacing: -0.5px; color: #ffffff;">${escapeEmailHtml(v.headline)}</h1>`, "32px 24px 0")}
${row(paragraph(v.intro), "12px 24px 0")}
${row(offerCard(copy), "24px 24px 0")}
${row(button(ctaUrl, v.cta), "16px 24px 0")}
${row(notes, "12px 24px 0")}
${detail}
${row(paragraph(copy.reply, MUTED, 14), "20px 24px 32px")}
${row(footer, "20px 24px 24px", ` background: ${FOOTER_BG}; border-top: 1px solid ${RULE};`)}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
}

/** One version in one locale: subject, preheader, HTML and plain text. */
export function renderBlackFridayEmail(args: BlackFridayEmailArgs): BlackFridayEmail {
  const locale = pickBlackFridayLocale(args.locale);
  const copy = BLACK_FRIDAY_COPY[locale];
  const recipient: BlackFridayRecipient = args.recipient ?? "account";
  const unsubscribeUrl = args.unsubscribeUrl ?? RESEND_UNSUBSCRIBE_TOKEN;
  const ctaUrl = blackFridayCtaUrl(args.version);
  const v = copy.versions[args.version];
  return {
    locale,
    subject: v.subject,
    preheader: v.preheader,
    html: renderHtml({ copy, locale, version: args.version, recipient, ctaUrl, unsubscribeUrl }),
    text: renderText({ copy, locale, version: args.version, recipient, ctaUrl, unsubscribeUrl }),
    ctaUrl,
  };
}
