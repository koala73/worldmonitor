import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CODE_TOKEN_ALLOWLIST,
  countryDisplayName,
  countryMentionTerms,
  mentionsCountry,
  normalizeMentionText,
} from '../shared/country-mention.js';

const mentions = (code, text) => mentionsCountry(text, countryMentionTerms(code));

// The one matcher behind the server's shared brief grounding, the MCP
// get_country_brief tool and the crawlable-corpus freeze (#7748). Every case
// below is a shape seen in a real digest or a real frozen brief.
describe('country mention matcher', () => {
  it('matches display names on word boundaries, case-insensitively', () => {
    assert.equal(mentions('NO', 'Norway boosts energy exports'), true);
    assert.equal(mentions('NO', 'norway boosts energy exports'), true);
    assert.equal(mentions('IN', 'shipment from Indiana port'), false, '"india" inside "Indiana" is not India');
    assert.equal(mentions('OM', 'Roman ruins reopen'), false, '"oman" inside "Roman" is not Oman');
    assert.equal(mentions('ML', 'Somalia drought worsens'), false, '"mali" inside "Somalia" is not Mali');
  });

  it('never treats a bare ISO code as a country unless it is on the allowlist', () => {
    assert.deepEqual([...CODE_TOKEN_ALLOWLIST], ['US']);
    assert.equal(mentions('US', 'US announces sanctions package'), true);
    assert.equal(mentions('US', 'tell us more about the plan'), false);
    // Contaminations the code-token matcher published on live country pages.
    assert.equal(mentions('AU', 'Sudanese anti-war forces reject AU backing for El Burhan dialogue'), false);
    assert.equal(mentions('ET', 'ChatGPT, Grok and Claude all went down at 2pm ET'), false);
    assert.equal(mentions('CM', "Punjab faces greater threat from other provinces: CM Maryam"), false);
    assert.equal(mentions('GM', 'GM vs. Ford: a century-old rivalry'), false);
    assert.equal(mentions('TV', 'TV ratings slump'), false);
    assert.equal(mentions('IN', 'Rally IN Europe ends'), false);
    assert.equal(mentions('NO', 'NO deal reached in talks'), false);
    assert.equal(mentions('AT', 'Explosion AT refinery injures three'), false);
  });

  it('reaches countries through aliases the display name misses', () => {
    assert.equal(mentions('GB', 'UK inflation cools'), true);
    assert.equal(mentions('GB', 'Britain and the EU reset ties'), true);
    assert.equal(mentions('AE', 'UAE hosts climate summit'), true);
    assert.equal(mentions('TR', 'Türkiye raises rates'), true);
    assert.equal(mentions('TR', 'Turkey raises rates'), true);
    assert.equal(mentions('CI', 'Côte d’Ivoire cocoa exports rise'), true);
    assert.equal(mentions('CI', "Cote d'Ivoire cocoa exports rise"), true);
    assert.equal(mentions('CI', 'Ivory Coast cocoa exports rise'), true);
    assert.equal(mentions('MM', 'Myanmar junta extends emergency'), true, 'ICU says "Myanmar (Burma)"');
    assert.equal(mentions('MM', 'Burma sanctions renewed'), true);
    assert.equal(mentions('CD', 'DR Congo fighting displaces thousands'), true, 'ICU says "Congo - Kinshasa"');
    assert.equal(mentions('CD', 'DRC signs minerals deal'), true);
    assert.equal(mentions('PS', 'Gaza ceasefire talks resume'), true);
    assert.equal(mentions('BA', 'Bosnia election dispute'), true, 'ICU says "Bosnia & Herzegovina"');
    assert.equal(mentions('TT', 'Trinidad gas deal signed'), true);
    assert.equal(mentions('US', 'U.S. Treasury yields climb'), true);
  });

  it('matches demonyms case-sensitively', () => {
    assert.equal(mentions('KZ', 'Kazakh elections: another stage of modernization'), true);
    assert.equal(mentions('LT', 'Lithuanian parliament speaker urges contacts'), true);
    assert.equal(mentions('SD', 'Sudanese anti-war forces reject dialogue'), true);
    assert.equal(mentions('ET', 'Ethiopian Airlines adds routes'), true);
    assert.equal(mentions('PL', 'Polish parliament votes on budget'), true);
    assert.equal(mentions('PL', 'How to polish the silverware'), false, 'lowercase "polish" is a verb');
    assert.equal(mentions('TH', 'Thai baht steadies'), true);
    assert.equal(mentions('TH', 'best thai restaurants'), false, 'lowercase "thai" is a cuisine');
  });

  it('removes exclusion phrases before the name match', () => {
    assert.equal(mentions('SD', 'South Sudan peace talks resume'), false);
    assert.equal(mentions('SS', 'South Sudan peace talks resume'), true);
    assert.equal(mentions('SD', 'Sudan and South Sudan reopen border'), true, 'a genuine Sudan mention survives the exclusion');
    assert.equal(mentions('GN', 'Papua New Guinea quake kills dozens'), false);
    assert.equal(mentions('GN', 'Equatorial Guinea oil output falls'), false);
    assert.equal(mentions('GN', 'Guinea-Bissau coup attempt foiled'), false, 'the hyphenated spelling is scrubbed too');
    assert.equal(mentions('GW', 'Guinea-Bissau coup attempt foiled'), true);
    assert.equal(mentions('GN', 'Guinea junta sets election date'), true);
    assert.equal(mentions('KR', "Democratic People's Republic of Korea tests missile"), false, '"republic of korea" sits inside the DPRK name');
    assert.equal(mentions('KP', "Democratic People's Republic of Korea tests missile"), true);
    assert.equal(mentions('KR', 'Republic of Korea hosts summit'), true);
    assert.equal(mentions('PG', 'Papua New Guinea quake kills dozens'), true);
    assert.equal(mentions('IE', 'Northern Ireland assembly returns'), false);
    assert.equal(mentions('IE', 'Northern Irish parties resume talks'), false, 'the exclusion covers the demonym path too');
    assert.equal(mentions('IE', 'Ireland budget surplus grows'), true);
    assert.equal(mentions('SD', 'South Sudanese forces regroup near Juba'), false, '"South Sudanese" must not reach "Sudanese"');
    assert.equal(mentions('SS', 'South Sudanese forces regroup near Juba'), true);
    assert.equal(mentions('MX', 'New Mexico wildfire spreads'), false);
    assert.equal(mentions('WS', 'American Samoa storm damage'), false);
    assert.equal(mentions('IN', 'Indian Ocean tsunami warning lifted'), false);
    assert.equal(mentions('FR', 'French Open final draws record crowd'), false);
    assert.equal(mentions('GB', 'British Columbia wildfires spread'), false);
    assert.equal(mentions('NL', 'Holland America cruise rerouted'), false);
    assert.equal(mentions('FR', 'French regulator opens inquiry'), true);
    assert.equal(mentions('CG', 'Democratic Republic of the Congo election delayed'), false, '"republic of the congo" sits inside the DRC name');
    assert.equal(mentions('CD', 'Democratic Republic of the Congo election delayed'), true);
    assert.equal(mentions('CG', 'Republic of the Congo election delayed'), true);
    assert.equal(mentions('CG', 'Brazzaville and Kinshasa: the two Congos'), false, 'bare "Congo" belongs to neither');
  });

  it('keeps Turks and Caicos reporting out of Turkey grounding', () => {
    const title = 'Turks and Caicos announces budget';
    assert.equal(mentions('TR', title), false);
    assert.equal(mentions('TC', title), true);
    assert.equal(mentions('TR', 'Turks and Caicos signs agreement with Turkey'), true);
    assert.equal(mentions('TR', 'Turks vote in national election'), true);
  });

  it('keeps Niger and Nigeria apart', () => {
    assert.equal(mentions('NE', 'Nigeria swears in new president'), false);
    assert.equal(mentions('NG', 'Niger coup leaders meet ECOWAS'), false);
    assert.equal(mentions('NE', 'Nigerien junta expels envoy'), true);
    assert.equal(mentions('NG', 'Nigerian naira slides'), true);
  });

  it('normalizes text the way names are stored', () => {
    assert.equal(normalizeMentionText("Côte d'Ivoire & São Tomé"), 'cote d ivoire and sao tome');
    assert.equal(normalizeMentionText('  Timor-Leste  (Dili) '), 'timor leste dili');
  });

  it('resolves display names and rejects unknown codes', () => {
    assert.equal(countryDisplayName('NO'), 'Norway');
    assert.equal(countryDisplayName('no'), 'Norway');
    assert.equal(countryDisplayName('XX'), '');
    assert.equal(countryDisplayName(''), '');
    assert.deepEqual(countryMentionTerms('XX').names, [], 'an echoed code must not become a word-match term');
  });

  it('yields at least one name for every country the corpus indexes', () => {
    const snapshot = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/crawlable-live-pulse-fixture.json'), 'utf8'));
    const missing = Object.keys(snapshot.countries).filter((code) => countryMentionTerms(code).names.length === 0);
    assert.deepEqual(missing, []);
  });

  it('never carries a bare two-letter code or the ICU echo as a name', () => {
    const snapshot = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/crawlable-live-pulse-fixture.json'), 'utf8'));
    for (const code of Object.keys(snapshot.countries)) {
      for (const name of countryMentionTerms(code).names) {
        assert.ok(name.length >= 2 && name !== code.toLowerCase(), `${code} carries an unsafe name term "${name}"`);
        assert.ok(!/[()&-]/.test(name), `${code} carries an un-normalized name term "${name}"`);
      }
    }
  });
});
