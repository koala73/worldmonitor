// Picks the editorial content each digest surface reads (l10n PR 3/7).
// Canonical values stay English and feed the subject line, the parity log
// and the webhook. Channel values feed email, Telegram, Slack, Discord and
// Teams, and are the localized copies when the brief was localized.

/**
 * @param {{ brief: any, aiDigestEnabled: boolean, ruleAiDigestEnabled: boolean | undefined }} input
 * @returns {{ lang: string, canonicalSynthesis: any, canonicalLead: string | null,
 *             channelSynthesis: any, channelLead: string | null }}
 */
export function selectDigestChannelContent({ brief, aiDigestEnabled, ruleAiDigestEnabled }) {
  const lang = typeof brief?.lang === 'string' && brief.lang.length > 0 ? brief.lang : 'en';
  // synthesisLevel comes from the compose pass; a missing brief reads as the L3 stub.
  const synthesisLevel = brief?.synthesisLevel ?? 3;
  if (!aiDigestEnabled || ruleAiDigestEnabled === false || synthesisLevel === 3) {
    return { lang, canonicalSynthesis: null, canonicalLead: null, channelSynthesis: null, channelLead: null };
  }
  const canonicalSynthesis = brief?.synthesis ?? null;
  const canonicalLead = canonicalSynthesis?.lead ?? null;
  const localized = brief?.localizedSynthesis ?? null;
  const channelSynthesis = localized ?? canonicalSynthesis;
  const channelLead = localized ? (localized.lead ?? null) : canonicalLead;
  return { lang, canonicalSynthesis, canonicalLead, channelSynthesis, channelLead };
}
