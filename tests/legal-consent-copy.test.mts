/**
 * The checkout consent line has to render as a sentence with two working links
 * in every locale we ship (#6976).
 *
 * The failure this guards is quiet and bad: a translation that drops or mangles
 * a `{{token}}` renders the raw placeholder to a buyer, inside a legal notice,
 * in a language nobody on the team reads — and the assent it evidences is the
 * thing the whole EULA rests on.
 *
 * It runs against the REAL splitter the component uses and the REAL locale
 * files, not a copy of either.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { hasBothLegalLinks, splitLegalConsent } from '../pro-test/src/components/legal-consent-parts.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const LOCALES_DIR = join(root, 'pro-test/src/locales');

function localeFiles() {
  return readdirSync(LOCALES_DIR).filter((file) => file.endsWith('.json')).sort();
}

describe('splitLegalConsent', () => {
  it('splits a sentence into text and both links', () => {
    const parts = splitLegalConsent('By subscribing you agree to the {{eula}} and the {{privacy}}.');
    assert.deepEqual(parts, [
      { kind: 'text', value: 'By subscribing you agree to the ' },
      { kind: 'link', slot: 'eula' },
      { kind: 'text', value: ' and the ' },
      { kind: 'link', slot: 'privacy' },
      { kind: 'text', value: '.' },
    ]);
  });

  it('handles a token at the very start and end', () => {
    assert.deepEqual(splitLegalConsent('{{eula}}·{{privacy}}'), [
      { kind: 'link', slot: 'eula' },
      { kind: 'text', value: '·' },
      { kind: 'link', slot: 'privacy' },
    ]);
  });

  it('leaves an unknown placeholder as text rather than dropping it', () => {
    const parts = splitLegalConsent('see {{terms}} and {{eula}}');
    assert.deepEqual(parts.filter((part) => part.kind === 'link'), [{ kind: 'link', slot: 'eula' }]);
    assert.ok(parts.some((part) => part.kind === 'text' && part.value.includes('{{terms}}')));
  });

  it('reports a translation that lost a token', () => {
    assert.equal(hasBothLegalLinks(splitLegalConsent('By subscribing you agree to the {{eula}}.')), false);
    assert.equal(hasBothLegalLinks(splitLegalConsent('… {{eula}} … {{privacy}}')), true);
  });
});

describe('checkout consent copy, every /pro locale', () => {
  const files = localeFiles();

  it('ships more than the English source', () => {
    assert.ok(files.length > 20, `expected the full locale set, found ${files.length}`);
  });

  for (const file of files) {
    it(`${file} renders both links and visible words`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const template = locale.pricing?.legalConsent;
      assert.ok(template, `${file} is missing pricing.legalConsent`);

      const parts = splitLegalConsent(template);
      assert.ok(hasBothLegalLinks(parts), `${file} lost a {{token}}: ${template}`);

      // A raw placeholder anywhere else in the rendered text means a token was
      // corrupted (spacing, wrong name) and will be shown to the buyer.
      const rendered = parts.filter((part) => part.kind === 'text').map((part) => part.value).join('');
      assert.doesNotMatch(rendered, /\{\{|\}\}/, `${file} would render a raw placeholder: ${template}`);
      assert.match(rendered, /\S/, `${file} has no visible sentence around the links`);

      for (const key of ['legalConsentEula', 'legalConsentPrivacy']) {
        const label = locale.pricing?.[key];
        assert.ok(label && label.trim().length > 0, `${file} is missing pricing.${key}`);
        assert.doesNotMatch(label, /\{\{|\}\}/, `${file}: pricing.${key} contains a placeholder`);
      }
    });
  }
});
