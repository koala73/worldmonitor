import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateTranslation } from '../scripts/translate-locales.mjs';

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

  describe('real paths and URLs are still pinned', () => {
    it('rejects a dropped path', () => {
      assert.equal(validateTranslation('See /docs/methodology for details', 'Voir les détails'), false);
    });

    it('rejects a rewritten path', () => {
      assert.equal(
        validateTranslation('See /docs/methodology for details', 'Voir /docs/methodologie pour les détails'),
        false,
      );
    });

    it('accepts a preserved path', () => {
      assert.equal(
        validateTranslation('See /docs/methodology for details', 'Détails sous /docs/methodology'),
        true,
      );
    });

    it('rejects a dropped URL', () => {
      assert.equal(
        validateTranslation('Read https://worldmonitor.app/pro now', 'Lisez maintenant'),
        false,
      );
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
