/**
 * The WorldMonitor email frame for Convex and server/ senders: preheader,
 * accent bar, logo header with a kicker on the right, body, footer. Same
 * markup as the relay's alert emails (scripts/lib/notification-email-html.cjs
 * `emailShell`), so every email we send looks like one product.
 *
 * Inline styles only, no <style> block and no flexbox, so it renders the same
 * across clients. Helpers escape their text arguments; arguments named `html`
 * are inserted as-is and must already be escaped. No imports: it is bundled
 * into the Convex deploy and the edge API.
 */

export const EMAIL_ACCENT = "#4ade80";
export const EMAIL_RED = "#ef4444";
export const EMAIL_AMBER = "#f59e0b";

const LOGO_URL = "https://www.worldmonitor.app/favico/android-chrome-192x192.png";
const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeEmailHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The heading and the muted line under it, at the top of the body. */
export function emailHeading(title: string, introHtml?: string): string {
  return `<div style="font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 8px; line-height: 1.35;">${escapeEmailHtml(title)}</div>
      ${introHtml ? `<div style="font-size: 14px; color: #888; line-height: 1.5; margin-bottom: 20px;">${introHtml}</div>` : `<div style="height: 12px;"></div>`}`;
}

/** A dark card with a colored left edge and an optional uppercase label. */
export function emailCard(html: string, opts: { label?: string; color?: string } = {}): string {
  const label = opts.label
    ? `<div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 700; margin-bottom: 8px;">${escapeEmailHtml(opts.label)}</div>\n        `
    : "";
  return `<div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid ${opts.color ?? EMAIL_ACCENT}; padding: 16px 20px; margin-bottom: 12px;">
        ${label}${html}
      </div>`;
}

export function emailParagraph(html: string): string {
  return `<div style="font-size: 14px; color: #ccc; line-height: 1.6; margin: 0 0 8px;">${html}</div>`;
}

/** Small muted text, for notes under a button or inside a card. */
export function emailNote(html: string): string {
  return `<div style="font-size: 12px; color: #777; line-height: 1.5; margin: 8px 0 0;">${html}</div>`;
}

export function emailButton(href: string, label: string, color: string = EMAIL_ACCENT): string {
  const text = color === EMAIL_RED ? "#fff" : "#0a0a0a";
  return `<div style="padding: 16px 0 8px;"><a href="${escapeEmailHtml(href)}" style="display: inline-block; background: ${color}; color: ${text}; padding: 12px 28px; text-decoration: none; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 3px;">${escapeEmailHtml(label)}</a></div>`;
}

/** One label/value row for emailFacts. The value is already-escaped HTML. */
export function emailFactRow(label: string, valueHtml: string): string {
  return `<tr><td style="padding: 6px 12px 6px 0; width: 110px; vertical-align: top; font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1.5px;">${escapeEmailHtml(label)}</td><td style="padding: 6px 0; vertical-align: top; font-size: 13px; color: #ccc; line-height: 1.45; word-break: break-word;">${valueHtml}</td></tr>`;
}

export function emailFacts(rowsHtml: string): string {
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation">${rowsHtml}</table>`;
}

/**
 * The whole document. `kicker` is the small label right of the logo
 * ("Billing", "Team invite", "Ops alert"). `footerNote` is the reason this
 * email was sent, shown under the footer links.
 */
export function emailFrame(args: {
  preheader: string;
  kicker: string;
  bodyHtml: string;
  accent?: string;
  footerNote?: string;
}): string {
  const accent = args.accent ?? EMAIL_ACCENT;
  const footerNote = args.footerNote
    ? `\n      <p style="font-size: 10px; color: #444; margin: 8px 0 0; line-height: 1.5;">${args.footerNote}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>WorldMonitor</title>
</head>
<body style="margin: 0; padding: 0; background: #111;">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: #111;">${escapeEmailHtml(args.preheader)}</div>
<div style="font-family: ${FONT_STACK}; background: #111; color: #e0e0e0; padding: 0;">
  <div style="max-width: 680px; margin: 0 auto;">
    <div style="background: ${accent}; height: 3px;"></div>
    <div style="background: #0d0d0d; padding: 32px 36px 24px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="margin-bottom: 28px;">
        <tr>
          <td style="vertical-align: middle;">
            <table cellpadding="0" cellspacing="0" border="0" role="presentation">
              <tr>
                <td style="width: 36px; height: 36px; vertical-align: middle;">
                  <img src="${LOGO_URL}" width="36" height="36" alt="WorldMonitor" style="border-radius: 50%; display: block;" />
                </td>
                <td style="padding-left: 10px;">
                  <div style="font-size: 15px; font-weight: 800; color: #fff; letter-spacing: -0.3px;">WORLD MONITOR</div>
                </td>
              </tr>
            </table>
          </td>
          <td style="text-align: right; vertical-align: middle;">
            <span style="font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 1px;">${escapeEmailHtml(args.kicker)}</span>
          </td>
        </tr>
      </table>
      ${args.bodyHtml}
    </div>
    <div style="background: #0a0a0a; border-top: 1px solid #1a1a1a; padding: 20px 36px; text-align: center;">
      <div style="margin-bottom: 12px;">
        <a href="https://x.com/worldmonitorai" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">X / Twitter</a>
        <a href="https://github.com/koala73/worldmonitor" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">GitHub</a>
      </div>
      <p style="font-size: 10px; color: #444; margin: 0; line-height: 1.5;">
        <a href="https://worldmonitor.app" style="color: ${EMAIL_ACCENT}; text-decoration: none;">worldmonitor.app</a>
      </p>${footerNote}
    </div>
  </div>
</div>
</body>
</html>`;
}
