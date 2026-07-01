import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The validators are exported from the docs-stats gate; the module is
// import-safe (main() only runs when executed directly), so we can drive the
// failure branches with synthetic fixtures instead of the real, always-valid
// index.html.
import {
  validateIndexLanguageMetadata,
  validateSupportedLanguagesRegistry,
  parseSupportedLanguages,
} from '../scripts/docs-stats.mjs';

const EXPECTED = ['en', 'fa', 'fr'];
const STATS = { localeCodes: EXPECTED, locales: EXPECTED.length };

function buildHtml({ xdefault, locales, jsonld } = {}) {
  const parts = [];
  if (xdefault !== null) {
    parts.push(xdefault ?? '<link rel="alternate" hreflang="x-default" href="https://www.worldmonitor.app/dashboard" />');
  }
  parts.push(...(locales ?? [
    '<link rel="alternate" hreflang="en" href="https://www.worldmonitor.app/dashboard?lang=en" />',
    '<link rel="alternate" hreflang="fa" href="https://www.worldmonitor.app/dashboard?lang=fa" />',
    '<link rel="alternate" hreflang="fr" href="https://www.worldmonitor.app/dashboard?lang=fr" />',
  ]));
  parts.push(jsonld ?? '<script type="application/ld+json">\n{ "@type": "WebSite", "inLanguage": ["en", "fa", "fr"] }\n</script>');
  return parts.join('\n');
}

const hit = (failures, substr) => failures.some((f) => f.includes(substr));

describe('validateIndexLanguageMetadata', () => {
  it('returns no failures for consistent language metadata', () => {
    assert.deepEqual(validateIndexLanguageMetadata(STATS, buildHtml()), []);
  });

  it('flags a missing x-default hreflang link', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({ xdefault: null }));
    assert.ok(hit(failures, 'x-default hreflang link not found'));
  });

  it('flags an x-default href that carries a ?lang param', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      xdefault: '<link rel="alternate" hreflang="x-default" href="https://www.worldmonitor.app/dashboard?lang=en" />',
    }));
    assert.ok(hit(failures, 'x-default hreflang href must not set ?lang'));
  });

  it('flags an hreflang locale set that does not match src/locales', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      locales: [
        '<link rel="alternate" hreflang="en" href="https://www.worldmonitor.app/dashboard?lang=en" />',
        '<link rel="alternate" hreflang="fa" href="https://www.worldmonitor.app/dashboard?lang=fa" />',
      ],
    }));
    assert.ok(hit(failures, 'hreflang locale set does not match src/locales'));
    assert.ok(hit(failures, 'missing: fr'));
  });

  it('flags an hreflang href whose ?lang does not equal its code', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      locales: [
        '<link rel="alternate" hreflang="en" href="https://www.worldmonitor.app/dashboard?lang=en" />',
        '<link rel="alternate" hreflang="fa" href="https://www.worldmonitor.app/dashboard?lang=xx" />',
        '<link rel="alternate" hreflang="fr" href="https://www.worldmonitor.app/dashboard?lang=fr" />',
      ],
    }));
    assert.ok(hit(failures, 'hreflang fa href must use ?lang=fa'));
  });

  it('accepts a relative hreflang href without throwing (regression: URL() must not crash the gate)', () => {
    let failures;
    assert.doesNotThrow(() => {
      failures = validateIndexLanguageMetadata(STATS, buildHtml({
        locales: [
          '<link rel="alternate" hreflang="en" href="/dashboard?lang=en" />',
          '<link rel="alternate" hreflang="fa" href="/dashboard?lang=fa" />',
          '<link rel="alternate" hreflang="fr" href="/dashboard?lang=fr" />',
        ],
      }));
    });
    assert.deepEqual(failures, []);
  });

  it('flags a WebSite inLanguage array that does not match src/locales', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      jsonld: '<script type="application/ld+json">\n{ "@type": "WebSite", "inLanguage": ["en", "fa"] }\n</script>',
    }));
    assert.ok(hit(failures, 'WebSite inLanguage does not match src/locales'));
  });

  it('flags a missing WebSite JSON-LD block', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      jsonld: '<script type="application/ld+json">\n{ "@type": "WebApplication" }\n</script>',
    }));
    assert.ok(hit(failures, 'WebSite JSON-LD block not found'));
  });

  it('flags unparseable JSON-LD instead of throwing', () => {
    let failures;
    assert.doesNotThrow(() => {
      failures = validateIndexLanguageMetadata(STATS, buildHtml({
        jsonld: '<script type="application/ld+json">\n{ "@type": "WebSite", }\n</script>',
      }));
    });
    assert.ok(hit(failures, 'JSON-LD could not be parsed'));
  });
});

describe('validateSupportedLanguagesRegistry / parseSupportedLanguages', () => {
  const src = (codes) => `const SUPPORTED_LANGUAGES = [${codes.map((c) => `'${c}'`).join(', ')}] as const;`;

  it('parses the SUPPORTED_LANGUAGES literal array', () => {
    assert.deepEqual(parseSupportedLanguages(src(['en', 'fa', 'fr'])), ['en', 'fa', 'fr']);
  });

  it('returns no failures when the runtime list matches src/locales', () => {
    assert.deepEqual(validateSupportedLanguagesRegistry(STATS, src(['fr', 'en', 'fa'])), []);
  });

  it('flags drift between SUPPORTED_LANGUAGES and src/locales', () => {
    const failures = validateSupportedLanguagesRegistry(STATS, src(['en', 'fa']));
    assert.ok(hit(failures, 'SUPPORTED_LANGUAGES does not match src/locales'));
    assert.ok(hit(failures, 'missing: fr'));
  });

  it('flags an unparseable SUPPORTED_LANGUAGES declaration', () => {
    const failures = validateSupportedLanguagesRegistry(STATS, 'no array here');
    assert.ok(hit(failures, 'could not parse SUPPORTED_LANGUAGES'));
  });
});
