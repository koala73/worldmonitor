// Turkish writes the percent sign before the number ("%70 indirim"), not after
// it ("70% indirim"). Machine translation copies the English order, and the
// live /pro Black Friday strip shipped "70% indirim" that way. This guards the
// Turkish catalogs for /pro and the dashboard.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Sign-first locales: the sign must precede the number or placeholder. */
const SIGN_FIRST_LOCALES = ['tr'];
const CATALOG_DIRS = ['pro-test/src/locales', 'src/locales'];

function flatten(value, prefix = '', out = []) {
  if (typeof value === 'string') out.push([prefix, value]);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

// A number or a {{placeholder}} directly followed by "%" (optionally after a space).
const NUMBER_THEN_SIGN = /(?:\d|\}\})[\s  ]?%/;

describe('percent sign order in sign-first locales', () => {
  for (const dir of CATALOG_DIRS) {
    for (const locale of SIGN_FIRST_LOCALES) {
      it(`${dir}/${locale}.json puts % before the number`, () => {
        const catalog = JSON.parse(readFileSync(join(ROOT, dir, `${locale}.json`), 'utf8'));
        const offenders = flatten(catalog)
          .filter(([, text]) => NUMBER_THEN_SIGN.test(text))
          .map(([key, text]) => `${key}: ${text}`);
        assert.deepEqual(offenders, [], 'Write "%70", not "70%":\n' + offenders.join('\n'));
      });
    }
  }

  it('/pro Turkish Black Friday strip reads "%{{savings}} indirim"', () => {
    const promo = JSON.parse(readFileSync(join(ROOT, 'pro-test/src/locales/tr.json'), 'utf8')).pricing.promo;
    assert.match(promo.stripHeadline, /%\{\{savings\}\} indirim/);
    assert.match(promo.stripHeadlineYearlyOnly, /%\{\{percent\}\} indirim/);
    assert.match(promo.badge, /^%\{\{percent\}\} indirim$/);
  });
});
