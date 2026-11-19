// Which editorial content each digest surface reads (l10n PR 3/7, #10884).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectDigestChannelContent } from '../scripts/lib/digest-channel-content.mjs';

const canonical = { lead: 'English lead.', threads: [], signals: [] };
const localized = { lead: 'Résumé.', threads: [], signals: [] };

describe('selectDigestChannelContent', () => {
  it('channel content is localized while canonical content stays English', () => {
    const out = selectDigestChannelContent({
      brief: { synthesisLevel: 1, synthesis: canonical, localizedSynthesis: localized, lang: 'fr' },
      aiDigestEnabled: true,
      ruleAiDigestEnabled: true,
    });
    assert.equal(out.lang, 'fr');
    assert.equal(out.canonicalLead, 'English lead.');
    assert.equal(out.canonicalSynthesis, canonical);
    assert.equal(out.channelLead, 'Résumé.');
    assert.equal(out.channelSynthesis, localized);
  });

  it('falls back to canonical content when no localized synthesis exists', () => {
    const out = selectDigestChannelContent({
      brief: { synthesisLevel: 2, synthesis: canonical },
      aiDigestEnabled: true,
      ruleAiDigestEnabled: undefined,
    });
    assert.equal(out.lang, 'en');
    assert.equal(out.channelLead, 'English lead.');
    assert.equal(out.channelSynthesis, canonical);
  });

  it('returns no editorial content for L3, opt-out, AI off, or a compose miss', () => {
    const brief = { synthesisLevel: 3, synthesis: canonical, localizedSynthesis: localized, lang: 'fr' };
    for (const input of [
      { brief, aiDigestEnabled: true, ruleAiDigestEnabled: true },
      { brief: { ...brief, synthesisLevel: 1 }, aiDigestEnabled: true, ruleAiDigestEnabled: false },
      { brief: { ...brief, synthesisLevel: 1 }, aiDigestEnabled: false, ruleAiDigestEnabled: true },
      { brief: undefined, aiDigestEnabled: true, ruleAiDigestEnabled: true },
    ]) {
      const out = selectDigestChannelContent(input);
      assert.equal(out.canonicalLead, null);
      assert.equal(out.channelLead, null);
      assert.equal(out.channelSynthesis, null);
    }
  });
});
