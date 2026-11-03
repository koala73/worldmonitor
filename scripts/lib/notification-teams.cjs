'use strict';

// Microsoft Teams delivery (#9215). Shared by the realtime relay
// (scripts/notification-relay.cjs) and the digest cron
// (scripts/seed-digest-notifications.mjs).
//
// Teams receives through a Workflows "When a Teams webhook request is
// received" trigger. Its documented body is a `message` with Adaptive Card
// attachments (learn.microsoft.com/connectors/teams, "Microsoft Teams
// Webhook"). Teams rejects messages over 28 KB (learn.microsoft.com/
// microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook).

// Read through the module object, not destructured, so tests can stub the
// network layer the same way they do for the relay's other senders.
const ssrf = require('./notification-webhook-ssrf.cjs');
const { classifyNotificationLink, isFirstPartyNotificationHost, NOTIFY_DASHBOARD_URL } = require('../shared/notify-fields.cjs');
const { corroborationText } = require('./corroboration-text.cjs');

const TEAMS_MAX_PAYLOAD_BYTES = 27 * 1024;
// 1.2 renders on every Teams client, including mobile.
const ADAPTIVE_CARD_VERSION = '1.2';
const SEVERITY_COLORS = { critical: 'Attention', high: 'Warning', medium: 'Accent', low: 'Default', info: 'Default' };

/**
 * Adaptive Card TextBlocks and FactSet values render a Markdown subset, so a
 * headline could render `[verify your account](https://evil)` as a link.
 * Untrusted text therefore goes only into RichTextBlock TextRuns, which the
 * Adaptive Card spec renders without Markdown. Fixed copy may use TextBlock.
 *
 * @param {Array<string | { text: string; weight?: string; color?: string; isSubtle?: boolean; size?: string }>} runs
 */
function richText(runs, options = {}) {
  const inlines = runs
    .map(run => (typeof run === 'string' ? { text: run } : run))
    .filter(run => typeof run.text === 'string' && run.text.length > 0)
    .map(run => ({ type: 'TextRun', ...run }));
  return { type: 'RichTextBlock', inlines, ...options };
}

function severityLabel(severity) {
  const value = typeof severity === 'string' && severity.trim() ? severity.trim().toLowerCase() : 'high';
  return value.slice(0, 20);
}

function severityColor(severity) {
  return SEVERITY_COLORS[severityLabel(severity)] ?? 'Default';
}

/**
 * Display name for an ISO 3166-1 alpha-2 code ("Iran (IR)"), or null when the
 * value is not a resolvable region code.
 */
function describeCountry(code) {
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code.trim())) return null;
  const iso2 = code.trim().toUpperCase();
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(iso2);
    return name ? `${name} (${iso2})` : iso2;
  } catch {
    return iso2;
  }
}

/**
 * Button for a link. Off-origin links name their host on the button: the
 * card has no other place to show where the click goes, and the text sinks
 * enforce the same disclosure (`(source: host)`).
 */
function linkAction(rawLink, articleTitle = 'Open original report') {
  const classified = classifyNotificationLink(rawLink);
  if (classified.kind === 'absent') return null;
  if (classified.kind === 'dashboard') {
    return { type: 'Action.OpenUrl', title: 'Open WorldMonitor', url: NOTIFY_DASHBOARD_URL };
  }
  const title = isFirstPartyNotificationHost(classified.host)
    ? articleTitle
    : `${articleTitle} (${classified.host})`;
  return { type: 'Action.OpenUrl', title, url: classified.url };
}

function wrapCard(body, actions) {
  const content = {
    type: 'AdaptiveCard',
    version: ADAPTIVE_CARD_VERSION,
    body,
    msteams: { width: 'Full' },
  };
  if (actions.length > 0) content.actions = actions;
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }],
  };
}

/**
 * Real-time alert card. Every text field must already be shaped by the
 * relay's notify-field sanitizers; this function only lays them out.
 *
 * @param {{ title: string; severity?: string; countryCode?: string | null;
 *   source?: string; coverage?: string; description?: string; link?: string;
 *   eventType?: string; impact?: string }} alert
 *   `coverage` is the #9213 corroboration token ("3 independent publishers").
 */
function buildTeamsAlertPayload(alert) {
  const severity = severityLabel(alert.severity);
  const color = severityColor(severity);
  const fact = (label, value) => richText([{ text: `${label}: `, weight: 'Bolder' }, value], { spacing: 'None' });

  const body = [
    {
      type: 'TextBlock',
      text: 'WorldMonitor alert',
      size: 'Small',
      weight: 'Bolder',
      color,
      wrap: true,
    },
    richText([{ text: alert.title, size: 'Medium', weight: 'Bolder' }]),
  ];
  if (alert.description) body.push(richText([{ text: alert.description, isSubtle: true }]));
  body.push(richText([{ text: 'Severity: ', weight: 'Bolder' }, { text: severity.toUpperCase(), weight: 'Bolder', color }], { spacing: 'Medium' }));
  const country = describeCountry(alert.countryCode);
  if (country) body.push(fact('Country', country));
  if (alert.source) body.push(fact('Source', alert.source));
  if (alert.coverage) body.push(fact('Coverage', alert.coverage));
  if (alert.eventType) body.push(fact('Type', alert.eventType));
  if (alert.impact) {
    body.push({ type: 'TextBlock', text: 'Impact', weight: 'Bolder', spacing: 'Medium' });
    body.push(richText([alert.impact]));
  }
  const action = linkAction(alert.link);
  return wrapCard(body, action ? [action] : []);
}

/**
 * Plain notice card: channel welcome / test send.
 *
 * @param {{ title: string; lines?: string[]; link?: string; linkTitle?: string }} notice
 */
function buildTeamsNoticePayload(notice) {
  return noticeCard(notice.title, (notice.lines ?? []).filter(Boolean), notice);
}

function noticeCard(title, lines, notice) {
  const action = notice.link ? linkAction(notice.link, notice.linkTitle) : null;
  const body = [richText([{ text: title, size: 'Medium', weight: 'Bolder' }])];
  for (const line of lines) body.push(richText([line], { spacing: 'Small' }));
  return wrapCard(body, action ? [action] : []);
}

/**
 * Notice split into as many cards as the Teams size limit needs, every line
 * kept, in order (the quiet-hours batch holds up to 100 alerts). Titles read
 * "<title> (part i of n)" when there is more than one card. A single line
 * larger than the limit gets a card of its own, which the sender refuses.
 *
 * @param {{ title: string; lines?: string[]; link?: string; linkTitle?: string }} notice
 * @returns {object[]}
 */
function buildTeamsNoticePayloads(notice) {
  const lines = (notice.lines ?? []).filter(Boolean);
  // Reserve room for the longest possible part suffix while packing.
  const reserve = ` (part ${lines.length} of ${lines.length})`;
  const chunks = [];
  let current = [];
  for (const line of lines) {
    const candidate = [...current, line];
    if (current.length > 0 && payloadBytes(noticeCard(notice.title + reserve, candidate, notice)) > TEAMS_MAX_PAYLOAD_BYTES) {
      chunks.push(current);
      current = [line];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  if (chunks.length === 1) return [noticeCard(notice.title, chunks[0], notice)];
  return chunks.map((chunk, i) => noticeCard(`${notice.title} (part ${i + 1} of ${chunks.length})`, chunk, notice));
}

function payloadBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload));
}

function digestStoryBlock(story) {
  const severity = severityLabel(story.severity);
  const sources = Array.isArray(story.sources) ? story.sources.filter(s => typeof s === 'string' && s) : [];
  const sourceList = sources.length > 0
    ? `${sources.slice(0, 3).join(', ')}${sources.length > 3 ? ` +${sources.length - 3}` : ''}`
    : '';
  // #9213 coverage, the same token the other digest channels print per item.
  const coverage = corroborationText(story.corroboration);
  const sourceText = [sourceList, coverage].filter(Boolean).join(' · ');
  const items = [richText([
    { text: `${severity.toUpperCase()}  `, weight: 'Bolder', color: severityColor(severity) },
    story.title,
  ])];
  if (sourceText) items.push(richText([{ text: sourceText, isSubtle: true, size: 'Small' }], { spacing: 'None' }));
  return { type: 'Container', separator: true, items };
}

/**
 * Digest card. Mirrors the other digest channels: optional executive summary,
 * the stories the formatter shipped, and the brief magazine link. Stories are
 * dropped from the end, with a count, until the card fits Teams' 28 KB limit.
 *
 * @param {{ title: string; summary?: string | null; stories: Array<{ title: string;
 *   severity?: string; sources?: string[]; link?: string }>; briefUrl?: string | null }} digest
 */
function buildTeamsDigestPayload(digest) {
  const stories = Array.isArray(digest.stories) ? digest.stories.filter(s => s && s.title) : [];
  const actions = [];
  if (digest.briefUrl) {
    const action = linkAction(digest.briefUrl, 'Open your WorldMonitor Brief');
    if (action) actions.push(action);
  }
  actions.push({ type: 'Action.OpenUrl', title: 'Open dashboard', url: NOTIFY_DASHBOARD_URL });

  const build = (shown) => {
    const body = [richText([{ text: digest.title, size: 'Large', weight: 'Bolder' }])];
    if (digest.summary) {
      body.push({ type: 'TextBlock', text: 'Executive summary', weight: 'Bolder', spacing: 'Medium' });
      body.push(richText([digest.summary]));
    }
    body.push({
      type: 'TextBlock',
      text: `${stories.length} ${stories.length === 1 ? 'story' : 'stories'}`,
      weight: 'Bolder',
      spacing: 'Medium',
    });
    for (const story of stories.slice(0, shown)) body.push(digestStoryBlock(story));
    if (shown < stories.length) {
      body.push({ type: 'TextBlock', text: `… and ${stories.length - shown} more in the full brief`, wrap: true, isSubtle: true });
    }
    return wrapCard(body, actions);
  };

  let shown = stories.length;
  let payload = build(shown);
  while (shown > 0 && payloadBytes(payload) > TEAMS_MAX_PAYLOAD_BYTES) {
    shown -= 1;
    payload = build(shown);
  }
  return payload;
}

/**
 * POST a card to a Teams Workflows webhook.
 *
 * The URL must pass the Microsoft host allowlist and the DNS check, and the
 * connection is pinned to the vetted address. Redirects are not followed:
 * node:https does not follow them, and a 3xx is reported as a failure.
 *
 * @returns {Promise<{ ok: boolean; status: number | null; gone: boolean; error?: string }>}
 */
async function sendTeamsPayload(webhookUrl, payload, { userAgent, resolveHostname } = {}) {
  const reason = ssrf.blockedTeamsWebhookUrlReason(webhookUrl);
  if (reason) return { ok: false, status: null, gone: false, error: reason };
  let safeUrl;
  let resolvedAddresses;
  try {
    ({ url: safeUrl, resolvedAddresses } = resolveHostname
      ? await ssrf.assertNotificationWebhookDeliveryUrlSafe(webhookUrl, resolveHostname)
      : await ssrf.assertNotificationWebhookDeliveryUrlSafe(webhookUrl));
  } catch (err) {
    return { ok: false, status: null, gone: false, error: err instanceof Error ? err.message : String(err) };
  }
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 28 * 1024) {
    return { ok: false, status: null, gone: false, error: 'Teams payload exceeds 28 KB' };
  }
  try {
    const res = await ssrf.postJsonWithPinnedAddress(
      safeUrl,
      body,
      { 'Content-Type': 'application/json', 'User-Agent': userAgent ?? 'worldmonitor-relay/1.0' },
      resolvedAddresses,
    );
    // A deleted or disabled workflow answers 404; treat it like a revoked
    // Slack/Discord webhook so the relay stops posting to it.
    const gone = res.status === 404 || res.status === 410;
    return { ok: res.ok, status: res.status, gone, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
  } catch (err) {
    return { ok: false, status: null, gone: false, error: err instanceof Error ? err.message : String(err) };
  }
}

module.exports = {
  TEAMS_MAX_PAYLOAD_BYTES,
  buildTeamsAlertPayload,
  buildTeamsDigestPayload,
  buildTeamsNoticePayload,
  buildTeamsNoticePayloads,
  describeCountry,
  sendTeamsPayload,
};
