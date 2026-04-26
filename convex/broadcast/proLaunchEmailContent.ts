/**
 * Locked PRO-launch email content.
 *
 * The body was finalised on 2026-04-26 with Elie. Source-of-truth copy
 * lives in this file (not in code review comments or chat history) so
 * future re-sends can reproduce the exact wording.
 *
 * If the copy needs to change for re-broadcasting, EDIT THIS FILE in a
 * separate PR — don't change it inline as part of operational work.
 */

export const PRO_LAUNCH_FROM = "Elie from WorldMonitor <news@worldmonitor.app>";
export const PRO_LAUNCH_REPLY_TO = "elie@worldmonitor.app";
export const PRO_LAUNCH_SUBJECT = "You waitlisted WorldMonitor PRO. It's live.";

// Primary CTA destination. UTMs scoped to this campaign so we can attribute
// conversions in analytics. Update if the upgrade page moves.
export const PRO_LAUNCH_UPGRADE_URL =
  "https://worldmonitor.app/pro?utm_source=resend&utm_medium=email&utm_campaign=pro-launch&utm_content=launch-email";

// CAN-SPAM physical address. Required in every commercial email footer.
// Update if the company physical address changes.
export const PRO_LAUNCH_PHYSICAL_ADDRESS = "WorldMonitor FZ LLC, Dubai - United Arab Emirates";

// Token Resend auto-fills with the per-recipient unsubscribe URL.
const UNSUBSCRIBE_TOKEN = "{{{RESEND_UNSUBSCRIBE_URL}}}";

/**
 * Plain-text fallback. Renders cleanly when the recipient's client
 * blocks HTML, when forwarded into Slack/Teams threads, and as the
 * deliverability spam-filter input. Should communicate the same value
 * as the HTML version, not be a stripped-down preview of it.
 */
export const PRO_LAUNCH_TEXT = `I'm Elie, founder of WorldMonitor. PRO launched today (https://worldmonitor.app/pro). I'm writing because you signed up a month ago, when the product was smaller and different.

Here's what it is now.

WorldMonitor stopped being only a real-time monitoring dashboard, though it still excels at that. It's also a research tool now. It tracks what's happening, and it forecasts what happens next: scenario probabilities on conflicts, market reactions to a headline you paste in, supply-chain shock paths, country stability trajectories. You read the present and stress-test the future in the same place.

The dashboard grew sideways. Conflicts stream live alongside sanctions, regime shifts, GPS jamming, displacement, climate anomalies. Bilateral trade flows, tariff trends, chokepoint indices, route disruption, cost-shock simulations, stability scoring across 31 countries on 40+ indicators. AI stock analysis with price targets, backtesting, a scanner for tickers trending on Reddit. Live aircraft tracking, civilian and military: fighter scrambles over the Taiwan Strait, carrier strike groups in the Persian Gulf, special-ops by callsign, 100+ airports for delays and cascades. Useful when something breaks at 3 a.m. and a price chart won't tell you why.

It grew a dedicated energy variant. energy.worldmonitor.app: live traffic and exposure on the four major shipping chokepoints, tanker positions in real time, 631 oil and gas pipelines mapped, EU gas storage, refinery utilization, retail fuel.

It grew a new way to interact with it. Describe any visualization in plain language: "crude oil versus gold today," "worst international flight delays right now." The AI builds it as a live widget on your dashboard. Save as many as you want.

And it became something your AI can use. WorldMonitor is accessible via REST API and MCP server. Connect it to Claude, ChatGPT, or Cursor in three minutes, and 28 live data tools become available inside your AI chat. Ask Claude "what's happening in the Taiwan Strait right now" and it pulls real-time data instead of training-set memories.

More than half of this didn't exist 45 days ago. The open-source repo (https://github.com/koala73/worldmonitor) crossed 50,000 GitHub stars in the same window. That's the build pace.

Most of it is in the free dashboard. PRO is where the two things you just read about earn their keep:

AI Widget Builder. Plain language, live widget on your dashboard. Save as many as you want.

Native AI context. MCP server plus a 27-endpoint REST API. Plug it into Claude, ChatGPT, Cursor, or anything you're building.

Also included:
- WM Analyst. AI analyst with the full signal stack: ticker, country, sector, sanctions package. Ask it what you'd Google for an hour.
- Critical Event Alerts. Pings to Telegram, Discord, Slack, email, browser push, or any webhook when your watch list breaks. Configurable sensitivity, quiet hours, AI digests daily or weekly.
- AI Market Implications. Paste a headline, get a read on which assets, sectors, and currencies move.
- Latest Brief. Magazine-style daily read on the last 24h of geopolitics and markets.
- AI Stock Analysis, backtesting, and the Reddit ticker scanner.

Code EARLYWM30: 30% off any PRO plan, 30 days. If anything above made you think "I'd check this every morning," that's your nudge.

→ Upgrade to PRO: https://worldmonitor.app/pro?utm_source=resend&utm_medium=email&utm_campaign=pro-launch&utm_content=launch-email

If not, reply and tell me what was missing. That's the one I'll act on.

Elie

—

Unsubscribe: ${UNSUBSCRIBE_TOKEN}
${PRO_LAUNCH_PHYSICAL_ADDRESS}
`;

/**
 * HTML version. Inline styles only — most email clients strip <style>
 * blocks, so layout must work without them. Tested narrative-first:
 * single column, system-font stack, generous line-height for legibility.
 */
export const PRO_LAUNCH_HTML = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff;color:#111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;">
<div style="max-width:620px;margin:0 auto;padding:32px 24px;">
<p>I'm Elie, founder of WorldMonitor. <a href="https://worldmonitor.app/pro?utm_source=resend&utm_medium=email&utm_campaign=pro-launch&utm_content=opener" style="color:#0066cc;">PRO launched today</a>. I'm writing because you signed up a month ago, when the product was smaller and different.</p>
<p>Here's what it is now.</p>
<p>WorldMonitor stopped being only a real-time monitoring dashboard, though it still excels at that. It's also a research tool now. It tracks what's happening, and it forecasts what happens next: scenario probabilities on conflicts, market reactions to a headline you paste in, supply-chain shock paths, country stability trajectories. You read the present and stress-test the future in the same place.</p>
<p><strong>The dashboard grew sideways.</strong> Conflicts stream live alongside sanctions, regime shifts, GPS jamming, displacement, climate anomalies. Bilateral trade flows, tariff trends, chokepoint indices, route disruption, cost-shock simulations, stability scoring across 31 countries on 40+ indicators. AI stock analysis with price targets, backtesting, a scanner for tickers trending on Reddit. Live aircraft tracking, civilian and military: fighter scrambles over the Taiwan Strait, carrier strike groups in the Persian Gulf, special-ops by callsign, 100+ airports for delays and cascades. Useful when something breaks at 3 a.m. and a price chart won't tell you why.</p>
<p><strong>It grew a dedicated energy variant.</strong> <a href="https://energy.worldmonitor.app" style="color:#0066cc;">energy.worldmonitor.app</a>: live traffic and exposure on the four major shipping chokepoints, tanker positions in real time, 631 oil and gas pipelines mapped, EU gas storage, refinery utilization, retail fuel.</p>
<p><strong>It grew a new way to interact with it.</strong> Describe any visualization in plain language: <em>"crude oil versus gold today," "worst international flight delays right now."</em> The AI builds it as a live widget on your dashboard. Save as many as you want.</p>
<p><strong>And it became something your AI can use.</strong> WorldMonitor is accessible via REST API and MCP server. Connect it to Claude, ChatGPT, or Cursor in three minutes, and 28 live data tools become available inside your AI chat. Ask Claude <em>"what's happening in the Taiwan Strait right now"</em> and it pulls real-time data instead of training-set memories.</p>
<p>More than half of this didn't exist 45 days ago. The <a href="https://github.com/koala73/worldmonitor" style="color:#0066cc;">open-source repo</a> crossed 50,000 GitHub stars in the same window. That's the build pace.</p>
<p>Most of it is in the free dashboard. PRO is where the two things you just read about earn their keep:</p>
<p><strong>AI Widget Builder.</strong> Plain language, live widget on your dashboard. Save as many as you want.</p>
<p><strong>Native AI context.</strong> MCP server plus a 27-endpoint REST API. Plug it into Claude, ChatGPT, Cursor, or anything you're building.</p>
<p>Also included:</p>
<ul style="padding-left:20px;">
<li><strong>WM Analyst.</strong> AI analyst with the full signal stack: ticker, country, sector, sanctions package. Ask it what you'd Google for an hour.</li>
<li><strong>Critical Event Alerts.</strong> Pings to Telegram, Discord, Slack, email, browser push, or any webhook when your watch list breaks. Configurable sensitivity, quiet hours, AI digests daily or weekly.</li>
<li><strong>AI Market Implications.</strong> Paste a headline, get a read on which assets, sectors, and currencies move.</li>
<li><strong>Latest Brief.</strong> Magazine-style daily read on the last 24h of geopolitics and markets.</li>
<li><strong>AI Stock Analysis</strong>, backtesting, and the Reddit ticker scanner.</li>
</ul>
<p>Code <strong>EARLYWM30</strong>: 30% off any PRO plan, 30 days. If anything above made you think <em>"I'd check this every morning,"</em> that's your nudge.</p>
<p style="margin:24px 0;text-align:center;">
<a href="https://worldmonitor.app/pro?utm_source=resend&utm_medium=email&utm_campaign=pro-launch&utm_content=cta-button" style="display:inline-block;background:#111;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;">Upgrade to PRO with EARLYWM30 →</a>
</p>
<p>If not, reply and tell me what was missing. That's the one I'll act on.</p>
<p>Elie</p>
<hr style="border:none;border-top:1px solid #ddd;margin:32px 0 16px;">
<p style="font-size:12px;color:#777;line-height:1.5;">
<a href="${UNSUBSCRIBE_TOKEN}" style="color:#777;">Unsubscribe</a><br>
${PRO_LAUNCH_PHYSICAL_ADDRESS}
</p>
</div>
</body></html>`;
