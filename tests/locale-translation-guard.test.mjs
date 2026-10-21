import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractUrlTokens, validateTranslation } from '../scripts/translate-locales.mjs';

// validateTranslation rejects a translation that dropped, invented or rewrote an
// interpolation token, an HTML tag, or a URL/path. The URL arm has to tell a real
// path ("/docs/methodology") apart from a slash that is just punctuation between
// two words ("calls/day") — otherwise it rejects, deterministically and forever,
// every translation of a rate that reads naturally in the target language.

describe('translation validation', () => {
  describe('rate expressions are not paths', () => {
    const rates = [
      ['MCP + SDK: 250 calls/day (vs 50)', 'MCP + SDK: 250 Aufrufe pro Tag (statt 50)'],
      ['MCP + SDK access for Claude Desktop & other AI clients (50 calls/day)', 'Accès MCP + SDK pour Claude Desktop et autres clients IA (50 appels par jour)'],
      ['300 requests/minute', '300 richieste al minuto'],
      ['10,000 requests/day included', '10.000 solicitudes al día incluidas'],
      ['$69.99/mo', '69,99 $ al mes'],
    ];
    for (const [en, translated] of rates) {
      it(`accepts "${en.slice(0, 40)}"`, () => {
        assert.equal(validateTranslation(en, translated), true);
      });
    }
  });

  describe('a slash the target language introduces is not an invented path', () => {
    // The mirror of the rate case. German and French render a monthly price as
    // "69,99 $/Monat" / "39,99 $/mois" — the slash follows a space there, so it
    // looks far more like a path than the English "$69.99/mo" it came from, and
    // the translation gets rejected for INVENTING a URL.
    const priced = [
      ['From $39.99/mo · 2 months free when billed annually', 'Ab 39,99 $/Monat · 2 Monate gratis bei jährlicher Abrechnung'],
      ['From $39.99/mo · 2 months free when billed annually', 'À partir de 39,99 $/mois · 2 mois offerts en facturation annuelle'],
      [
        'Yes. Pro is for personal use. Pro Business ($69.99/mo) adds the commercial license, data export, 25 dashboards, and 250 MCP calls/day.',
        'Ja. Pro ist für den persönlichen Gebrauch. Pro Business (69,99 $/Monat) ergänzt die kommerzielle Lizenz, Datenexport, 25 Dashboards und 250 MCP-Aufrufe pro Tag.',
      ],
    ];
    for (const [en, translated] of priced) {
      it(`accepts "${translated.slice(0, 40)}"`, () => {
        assert.equal(validateTranslation(en, translated), true);
      });
    }
  });

  describe('real paths and URLs are still pinned', () => {
    // Every genuine bare path in both EN catalogs is multi-segment (/docs/...);
    // the only single-segment matches are the price suffixes "/mo" and "/yr",
    // which are not paths. That is what makes "has a second segment" a safe test
    // for a real path and a slash between two words.
    const REAL = 'Scores are explained at /docs/methodology/cii-risk-scores today';

    it('rejects dropping a multi-segment path', () => {
      assert.equal(validateTranslation(REAL, 'Die Werte werden heute erklärt'), false);
    });

    it('rejects rewriting a multi-segment path', () => {
      assert.equal(
        validateTranslation(REAL, 'Erklärt unter /docs/methodik/cii-risk-scores heute'),
        false,
      );
    });

    it('accepts a preserved multi-segment path', () => {
      assert.equal(
        validateTranslation(REAL, 'Heute erklärt unter /docs/methodology/cii-risk-scores hier'),
        true,
      );
    });
  });

  describe('host-qualified paths without a scheme', () => {
    // src/locales/en.json ships this verbatim. The slash follows the "p" of
    // ".app", so a rule that only requires a non-alphanumeric before the slash
    // stops seeing it — and there is no scheme, so the https arm never fires
    // either. The guard then accepts a translation that deletes the URL outright,
    // which is precisely what it exists to prevent.
    const REAL = 'See worldmonitor.app/docs/api-keys for step-by-step help.';

    it('rejects dropping a bare-domain URL', () => {
      assert.equal(validateTranslation(REAL, 'Weitere Hilfe finden Sie in der Dokumentation.'), false);
    });

    it('rejects rewriting a bare-domain URL', () => {
      assert.equal(
        validateTranslation(REAL, 'Siehe worldmonitor.app/fr/docs/cles-api für Hilfe.'),
        false,
      );
    });

    it('accepts a preserved bare-domain URL', () => {
      assert.equal(
        validateTranslation(REAL, 'Siehe worldmonitor.app/docs/api-keys für Schritt-für-Schritt-Hilfe.'),
        true,
      );
    });

    it('does not mistake a slash-separated word list for a host-qualified path', () => {
      assert.equal(validateTranslation('Cloud/on-prem/air-gap', 'Cloud/vor-Ort/Luftspalt'), true);
    });
  });

  describe('absolute URLs', () => {
    it('rejects a dropped URL', () => {
      assert.equal(
        validateTranslation('Read https://worldmonitor.app/pro now', 'Lisez maintenant'),
        false,
      );
    });

    it('rejects a rewritten URL', () => {
      assert.equal(
        validateTranslation('Read https://worldmonitor.app/pro now', 'Lisez https://worldmonitor.app/fr/pro'),
        false,
      );
    });

    it('accepts a preserved URL', () => {
      assert.equal(
        validateTranslation('Read https://worldmonitor.app/pro now', 'Lisez maintenant https://worldmonitor.app/pro'),
        true,
      );
    });
  });

  describe('pathological input', () => {
    it('does not blow up on a long dotted run', () => {
      // validateTranslation runs on MODEL output, which is unbounded, so its
      // patterns have to be linear-ish on adversarial input. A nested quantifier
      // over an overlapping class made this re-partition every dot boundary:
      // 4k dots took 616ms and 8k took 6.3s, roughly 10x per doubling.
      const evil = `a${'.a'.repeat(8000)}`;
      const started = Date.now();
      validateTranslation(evil, evil);
      assert.ok(
        Date.now() - started < 500,
        'validateTranslation should stay fast on a long dotted run; it took ' + (Date.now() - started) + 'ms',
      );
    });

    it('does not treat slash-separated abbreviations as a path', () => {
      // Real string from src/locales/de.json. Slashes joining abbreviations in a
      // German compound are punctuation, not a path — reading "/EU-/UN-..." as a
      // URL would reject any translation that reorders or rewords the list.
      const de = 'Länder, denen US-/EU-/UN-Wirtschaftssanktionen unterliegen';
      assert.deepEqual(extractUrlTokens(de), []);
      assert.equal(validateTranslation(de, 'Countries under US/EU/UN economic sanctions'), true);
    });

    it('does not treat a decimal followed by a unit as a URL', () => {
      // The host arm requires a real TLD-shaped last label, so "1.5/kg" is not a
      // host-qualified path and a translation may render it however it likes.
      assert.equal(validateTranslation('Density is 1.5/kg here', 'Dichte ist 1,5 pro kg hier'), true);
    });
  });

  describe('tokens and markup', () => {
    it('rejects a dropped interpolation token', () => {
      assert.equal(validateTranslation('{{count}} alerts', 'Warnungen'), false);
    });

    it('rejects a stripped HTML tag', () => {
      assert.equal(validateTranslation('<strong>Pro</strong> only', 'Nur Pro'), false);
    });

    it('accepts reordered markup with the same tag multiset', () => {
      assert.equal(
        validateTranslation('<strong>Pro</strong> only', 'Nur <strong>Pro</strong>'),
        true,
      );
    });
  });
});
