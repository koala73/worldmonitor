/**
 * Renders a media check (#9096) as escaped markup for the /verify page. It
 * reports what the file's content credentials declare and where TinEye has
 * seen the image. No wording here calls media genuine, fake or original.
 */
import { MEDIA_WORDING } from '../../shared/media-provenance-contract.js';
import type { MediaCheckOutcome, MediaProvenance } from '@/services/media-provenance';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

const ACTION_NAMES: Readonly<Record<string, string>> = {
  'c2pa.created': 'Created',
  'c2pa.opened': 'Opened',
  'c2pa.edited': 'Edited',
  'c2pa.cropped': 'Cropped',
  'c2pa.resized': 'Resized',
  'c2pa.color_adjustments': 'Colour adjusted',
  'c2pa.filtered': 'Filtered',
  'c2pa.drawing': 'Drawn on',
  'c2pa.placed': 'Content placed',
  'c2pa.removed': 'Content removed',
  'c2pa.converted': 'Converted',
  'c2pa.transcoded': 'Transcoded',
  'c2pa.published': 'Published',
  'c2pa.watermarked': 'Watermarked',
};

function actionName(action: string): string {
  return ACTION_NAMES[action] ?? action.replace(/^c2pa\./, '').replace(/[_.]/g, ' ');
}

function dateOnly(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

function credentialsHtml(result: MediaProvenance): string {
  const c = result.credentials;
  if (!c || c.state === 'none') return `<p class="mc-note">${escapeHtml(MEDIA_WORDING.noCredentials)}</p>`;
  if (c.state !== 'found') return `<p class="mc-note">${escapeHtml(MEDIA_WORDING.unreadableCredentials)}</p>`;
  const signer = c.signer || c.signerCommonName || 'an unnamed signer';
  const trust = c.signerTrust === 'trusted'
    ? 'The signer is on the C2PA trust list this check uses.'
    : c.signerTrust === 'untrusted' ? MEDIA_WORDING.untrustedSigner : MEDIA_WORDING.unknownTrust;
  const lines = [
    // A signer name is whatever the certificate says; only a trusted signer is stated as fact.
    c.signerTrust === 'trusted'
      ? `<p class="mc-headline">Content credentials found: signed by <strong>${escapeHtml(signer)}</strong></p>`
      : `<p class="mc-headline">Content credentials found. They name the signer as <strong>${escapeHtml(signer)}</strong>.</p>`,
    `<p class="mc-note">${escapeHtml(trust)}</p>`,
  ];
  if (c.contentChangedAfterSigning) lines.push(`<p class="mc-warning">${escapeHtml(MEDIA_WORDING.changedAfterSigning)}</p>`);
  else if (c.validationState === 'invalid') lines.push(`<p class="mc-warning">${escapeHtml(MEDIA_WORDING.failedValidation)}</p>`);
  if (c.declaresAiGeneration) lines.push(`<p class="mc-ai">${escapeHtml(MEDIA_WORDING.aiDeclared)}</p>`);
  const facts: string[] = [];
  if (c.claimGenerator) facts.push(`<li>Made with: ${escapeHtml(c.claimGenerator)}</li>`);
  const signed = dateOnly(c.signedAt);
  if (signed) facts.push(`<li>Signed on: ${escapeHtml(signed)}</li>`);
  if (c.ingredientCount > 0) facts.push(`<li>Built from ${c.ingredientCount} source file${c.ingredientCount === 1 ? '' : 's'}</li>`);
  if (facts.length) lines.push(`<ul class="mc-facts">${facts.join('')}</ul>`);
  if (c.actions.length) {
    const steps = c.actions.map((a) => `<li>${escapeHtml(actionName(a.action))}${a.softwareAgent ? ` with ${escapeHtml(a.softwareAgent)}` : ''}</li>`).join('');
    lines.push(`<p class="mc-subtitle">What the credentials say was done</p><ol class="mc-actions">${steps}</ol>`);
  }
  return lines.join('');
}

function earliestHtml(result: MediaProvenance): string {
  const e = result.earliest;
  const state = e?.state ?? 'unavailable';
  if (state === 'unsupported-media') return `<p class="mc-note">${escapeHtml(MEDIA_WORDING.earliestUnsupported)}</p>`;
  if (state === 'not-configured') return `<p class="mc-note">${escapeHtml(MEDIA_WORDING.earliestNotConfigured)}</p>`;
  if (state === 'cap-reached') return `<p class="mc-note">${escapeHtml(MEDIA_WORDING.earliestCapReached)}</p>`;
  if (state !== 'ok' || !e) return `<p class="mc-note">${escapeHtml(MEDIA_WORDING.earliestUnavailable)}</p>`;
  if (e.copies.length === 0) return `<p class="mc-note">${escapeHtml(MEDIA_WORDING.earliestNone)}</p>`;
  const [first] = e.copies;
  const rows = e.copies.map((copy) => {
    const href = sanitizeUrl(copy.pageUrl);
    const domain = escapeHtml(copy.domain);
    const link = href ? `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${domain}</a>` : domain;
    return `<li><span class="mc-date">${escapeHtml(copy.crawlDate)}</span> ${link}</li>`;
  }).join('');
  const more = e.totalMatches > e.copies.length ? `<p class="mc-note">TinEye reports ${e.totalMatches} matching images in all.</p>` : '';
  return `<p class="mc-headline">Earliest copy TinEye has seen: <strong>${escapeHtml(first!.crawlDate)}</strong>, ${escapeHtml(first!.domain)}</p>
    <ol class="mc-copies">${rows}</ol>${more}`;
}

export function renderMediaCheckHtml(outcome: MediaCheckOutcome | null): string {
  let body: string;
  if (outcome === null) {
    body = '<p class="mc-note">Checking the file… This can take a few minutes.</p>';
  } else if (outcome.kind === 'needs-sign-in') {
    body = '<p class="mc-note">Checking images and video is part of WorldMonitor Pro. Sign in to check this link.</p><button type="button" class="mc-signin" data-media-signin>Sign in</button>';
  } else if (outcome.kind === 'needs-pro') {
    body = '<p class="mc-note">Checking images and video is part of WorldMonitor Pro.</p><a class="mc-upgrade" href="/pro">See WorldMonitor Pro</a>';
  } else if (outcome.kind === 'failed') {
    body = `<p class="mc-note">${escapeHtml(outcome.error)}</p>`;
  } else if (outcome.kind === 'unavailable') {
    body = '<p class="mc-note">The media check could not run right now. Try again in a few minutes.</p>';
  } else {
    const r = outcome.result;
    const kind = r.mediaType.startsWith('video/') ? 'video' : 'image';
    body = `<p class="mc-file">Checked ${kind} (${escapeHtml(r.mediaType)}, ${Math.max(1, Math.round(r.bytes / 1024))} KB), fetched ${escapeHtml(dateOnly(r.fetchedAt))}</p>
      <h3 class="mc-section">Content credentials</h3>${credentialsHtml(r)}
      <h3 class="mc-section">Earliest copy</h3>${earliestHtml(r)}
      ${r.caveats.map((caveat) => `<p class="vc-caveat">${escapeHtml(caveat)}</p>`).join('')}`;
  }
  return `<section class="vc-media" aria-labelledby="vc-media-title" aria-live="polite">
      <h2 id="vc-media-title" class="mc-title">Image and video check</h2>
      ${body}
    </section>`;
}
