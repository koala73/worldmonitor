/**
 * Renders a claim evidence card (#9092) as escaped markup for the /verify page.
 * Every sentence describes coverage: who reported it, how independent they are,
 * and which figures they state. No wording here calls a claim true or false.
 */
import type { ClaimCard, ClaimCardHeadline, FactCheckResult } from '@/services/verify-claim';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { TIER_DOCS_HREF } from '@/utils/tier-docs';

export type VerdictView = {
  readonly tone: 'corroborated' | 'single' | 'low-tier' | 'not-found';
  readonly title: string;
  readonly body: string;
};

export function claimVerdictView(card: ClaimCard): VerdictView {
  if (card.state === 'not-found') {
    return {
      tone: 'not-found',
      title: 'Not in WorldMonitor\'s current sources',
      body: 'No headline in the live digest reports this. That does not make it false: it may be too new, too local, or worded differently. Try the key names and numbers.',
    };
  }
  const { state, publishers } = card.corroboration;
  switch (state) {
    case 'corroborated':
      return {
        tone: 'corroborated',
        title: `Reported by ${publishers} independent publishers`,
        body: 'Separate newsrooms are carrying this story. Syndicated copies of one outlet count once.',
      };
    case 'single-publisher':
      return {
        tone: 'single',
        title: 'Only one publisher is reporting this',
        body: 'Every matching headline traces back to one newsroom, even where it appears under several feeds. Wait for independent pickup.',
      };
    case 'tier4-only':
      return {
        tone: 'low-tier',
        title: 'Only low-tier sources report this',
        body: 'Every outlet carrying it is an aggregator or blog (tier 4). No wire service or major outlet has it yet.',
      };
    default:
      return {
        tone: 'not-found',
        title: 'Coverage could not be assessed',
        body: 'Matching headlines were found, but their publishers could not be identified.',
      };
  }
}

export function tierChipHtml(tier: ClaimCardHeadline['tier']): string {
  const titles: Record<number, string> = {
    1: 'Tier 1: Wire services and official bodies',
    2: 'Tier 2: Major outlets',
    3: 'Tier 3: Specialist, regional and think-tank sources',
    4: 'Tier 4: Aggregators and blogs',
  };
  return tier === null
    ? '<span class="tier-chip tier-none" title="Tier not declared: not yet reviewed">T?</span>'
    : `<span class="tier-chip tier-${tier}" title="${escapeHtml(titles[tier] ?? '')}">T${tier}</span>`;
}

/** The provenance badge a headline carries, or '' for a reviewed low-risk source. */
export function provenanceBadgeHtml(headline: ClaimCardHeadline): string {
  const title = escapeHtml(headline.summary);
  if (headline.risk === 'high') {
    const label = headline.type === 'gov' ? 'Official government' : 'State media';
    return `<span class="prov-badge prov-high" title="${title}">${label}</span>`;
  }
  if (headline.risk === 'medium') return `<span class="prov-badge prov-medium" title="${title}">Caution</span>`;
  if (headline.risk === 'unknown') return `<span class="prov-badge prov-unknown" title="${title}">Unreviewed source</span>`;
  if (headline.stateAffiliated) {
    return `<span class="prov-badge prov-medium" title="${title}">State-affiliated: ${escapeHtml(headline.stateAffiliated)}</span>`;
  }
  return '';
}

function relativeTime(iso: string | null, now: number): string {
  if (!iso) return '';
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function figuresHtml(card: ClaimCard): string {
  const { claimed, grounded, ungrounded } = card.figures;
  if (!card.found || claimed.length === 0) return '';
  const list = (values: readonly string[]) => values.map((v) => `<code>${escapeHtml(v)}</code>`).join(' ');
  const rows = [
    ungrounded.length > 0
      ? `<li class="fig-ungrounded"><strong>Not stated in matched coverage:</strong> ${list(ungrounded)}</li>`
      : '',
    grounded.length > 0
      ? `<li class="fig-grounded"><strong>Stated in matched coverage:</strong> ${list(grounded)}</li>`
      : '',
  ].join('');
  return `<section class="vc-section" aria-labelledby="vc-figures">
      <h2 id="vc-figures">Numbers and dates</h2>
      <ul class="fig-list">${rows}</ul>
      <p class="vc-note">Not stated means no matched headline gives that figure. It does not mean the figure is wrong.</p>
    </section>`;
}

function publishersHtml(card: ClaimCard): string {
  if (card.publishers.length === 0) return '';
  const rows = card.publishers.map((publisher) => {
    const extra = publisher.labelsUnlisted > 0 ? ` +${publisher.labelsUnlisted}` : '';
    const feeds = publisher.labels.length > 1 || publisher.labels[0] !== publisher.name
      ? `<span class="pub-feeds">via ${escapeHtml(publisher.labels.join(', '))}${extra}</span>`
      : '';
    return `<li>${tierChipHtml(publisher.tier)}<span class="pub-name">${escapeHtml(publisher.name)}</span>${feeds}</li>`;
  }).join('');
  const more = card.publishersUnlisted > 0 ? `<li class="pub-more">and ${card.publishersUnlisted} more</li>` : '';
  return `<section class="vc-section" aria-labelledby="vc-publishers">
      <h2 id="vc-publishers">Publishers</h2>
      <ul class="pub-list">${rows}${more}</ul>
      <p class="vc-note">Tiers rank sources; they do not judge this claim. <a href="${escapeHtml(TIER_DOCS_HREF)}" target="_blank" rel="noopener">How tiers are assigned</a></p>
    </section>`;
}

function headlinesHtml(card: ClaimCard, now: number): string {
  if (card.headlines.length === 0) return '';
  const rows = card.headlines.map((headline) => {
    const href = sanitizeUrl(headline.link);
    const title = escapeHtml(headline.title);
    const titleHtml = href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
    return `<li>
        <div class="hl-title">${titleHtml}</div>
        <div class="hl-meta">${tierChipHtml(headline.tier)}<span>${escapeHtml(headline.source)}</span><span class="hl-time">${escapeHtml(relativeTime(headline.publishedAt, now))}</span>${provenanceBadgeHtml(headline)}</div>
      </li>`;
  }).join('');
  return `<section class="vc-section" aria-labelledby="vc-headlines">
      <h2 id="vc-headlines">Matching headlines</h2>
      <ul class="hl-list">${rows}</ul>
    </section>`;
}

export function renderClaimCardHtml(card: ClaimCard, now = Date.now()): string {
  const verdict = claimVerdictView(card);
  const seen = card.found && card.firstSeen
    ? `<p class="vc-seen">First seen ${escapeHtml(relativeTime(card.firstSeen, now))}${card.lastUpdated && card.lastUpdated !== card.firstSeen ? ` · latest ${escapeHtml(relativeTime(card.lastUpdated, now))}` : ''} · ${card.matchedClusters} matching ${card.matchedClusters === 1 ? 'story' : 'stories'}</p>`
    : '';
  return `<article class="vc-card vc-${verdict.tone}" aria-live="polite">
      <p class="vc-claim">“${escapeHtml(card.claim)}”</p>
      <div class="vc-verdict">
        <h2 class="vc-verdict-title">${escapeHtml(verdict.title)}</h2>
        <p>${escapeHtml(verdict.body)}</p>
        ${seen}
      </div>
      ${figuresHtml(card)}
      ${publishersHtml(card)}
      ${headlinesHtml(card, now)}
      <p class="vc-caveat">${escapeHtml(card.caveat)}</p>
    </article>`;
}

/** Must equal FACT_CHECK_LABEL in server/_shared/fact-checks.ts (tests check it); kept here so the page does not bundle the allowlist. */
export const FACT_CHECK_LABEL = 'A published fact-check of a similar claim';

function factCheckDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : '';
}

/**
 * Published fact-checks (#9094), shown below the coverage card and never in
 * place of it. Each rating is quoted with the fact-checker, date and link, in
 * the fact-checker's words; no colour or wording here grades the claim.
 * `null` renders the loading state.
 */
export function renderFactChecksHtml(result: FactCheckResult | null): string {
  let body: string;
  if (result === null) {
    body = '<p class="vc-note">Looking for published fact-checks…</p>';
  } else if (result.state !== 'ok') {
    body = '<p class="vc-note">Published fact-checks could not be checked right now.</p>';
  } else if (result.factChecks.length === 0) {
    body = '<p class="vc-note">No published fact-check of a similar claim was found among IFCN-verified fact-checkers.</p>';
  } else {
    const rows = result.factChecks.map((check) => {
      const href = sanitizeUrl(check.url);
      const publisher = escapeHtml(check.publisher);
      const by = href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${publisher}</a>` : publisher;
      const date = factCheckDate(check.reviewedAt);
      return `<li>
          <p class="fc-label">${escapeHtml(FACT_CHECK_LABEL)}</p>
          <p class="fc-rating">Rated <strong>“${escapeHtml(check.rating)}”</strong> by ${by}${date ? ` on ${escapeHtml(date)}` : ''}</p>
          <p class="fc-claim">Claim they rated: “${escapeHtml(check.claimReviewed)}”</p>
        </li>`;
    }).join('');
    body = `<ul class="fc-list">${rows}</ul>`;
  }
  const caveat = result?.caveat ? `<p class="vc-caveat">${escapeHtml(result.caveat)}</p>` : '';
  return `<section class="vc-factchecks" aria-labelledby="vc-factchecks-title" aria-live="polite">
      <h2 id="vc-factchecks-title" class="fc-title">Published fact-checks</h2>
      ${body}
      ${caveat}
    </section>`;
}
