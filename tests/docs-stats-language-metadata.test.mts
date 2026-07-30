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

function buildHtml({ canonical, xdefault, alternates, jsonld } = {}) {
  const parts = [];
  parts.push(canonical ?? '<link rel="canonical" href="https://www.worldmonitor.app/dashboard" />');
  if (xdefault !== null) {
    parts.push(xdefault ?? '<link rel="alternate" hreflang="x-default" href="https://www.worldmonitor.app/dashboard" />');
  }
  parts.push(...(alternates ?? [
    '<link rel="alternate" hreflang="en" href="https://www.worldmonitor.app/dashboard" />',
  ]));
  parts.push(jsonld ?? '<script type="application/ld+json">\n{ "@type": "WebSite", "inLanguage": "en" }\n</script>');
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

  it('flags a missing English alternate', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      alternates: [],
    }));
    assert.ok(hit(failures, 'hreflang set must contain only x-default and en'));
    assert.ok(hit(failures, 'missing: en'));
  });

  it('flags a pseudo-localized query-string alternate', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      alternates: [
        '<link rel="alternate" hreflang="en" href="https://www.worldmonitor.app/dashboard" />',
        '<link rel="alternate" hreflang="fr" href="https://www.worldmonitor.app/dashboard?lang=fr" />',
      ],
    }));
    assert.ok(hit(failures, 'hreflang set must contain only x-default and en'));
    assert.ok(hit(failures, 'extra: fr'));
    assert.ok(hit(failures, 'query-string locale URLs must not be advertised'));
  });

  it('requires absolute, self-canonical alternate URLs', () => {
    let failures;
    assert.doesNotThrow(() => {
      failures = validateIndexLanguageMetadata(STATS, buildHtml({
        alternates: ['<link rel="alternate" hreflang="en" href="/dashboard" />'],
      }));
    });
    assert.ok(hit(failures, 'en hreflang href must be an absolute URL'));
    assert.ok(hit(failures, 'en hreflang href must equal the canonical URL'));
  });

  it('flags x-default and English alternates that drift from the canonical', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      xdefault: '<link rel="alternate" hreflang="x-default" href="https://www.worldmonitor.app/" />',
      alternates: ['<link rel="alternate" hreflang="en" href="https://www.worldmonitor.app/" />'],
    }));
    assert.ok(hit(failures, 'x-default hreflang href must equal the canonical URL'));
    assert.ok(hit(failures, 'en hreflang href must equal the canonical URL'));
  });

  it('flags WebSite structured data that claims languages other than the raw English document', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      jsonld: '<script type="application/ld+json">\n{ "@type": "WebSite", "inLanguage": ["en", "fa"] }\n</script>',
    }));
    assert.ok(hit(failures, 'WebSite inLanguage must describe the raw English document'));
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
