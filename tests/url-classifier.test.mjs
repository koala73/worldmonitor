// Pure-function tests for shared/url-classifier.js (U6).
//
// The classifier identifies static institutional landing pages on
// .gov/.mil/.int domains so the brief-filter denylist (U7) can drop them
// as a last line of defense, and the audit script (U6) can evict residual
// poisoned story:track:v1 entries.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInstitutionalStaticPage } from '../shared/url-classifier.js';

describe('isInstitutionalStaticPage — known contamination cases (true)', () => {
  it('Pentagon About/Section-508 (the original brief contamination)', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.defense.gov/About/Section-508/'),
      true,
    );
  });

  it('Pentagon Acquisition-Transformation-Strategy (no trailing slash)', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.defense.gov/Acquisition-Transformation-Strategy'),
      true,
    );
  });

  it('Pentagon About/ landing page', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.defense.gov/About/'),
      true,
    );
  });

  it('Pentagon /About bare segment (no trailing slash) — segment-boundary rule', () => {
    // P2 from PR #3419 review: under naive `startsWith('/About/')` this
    // would have returned false, missing the canonical landing-page form.
    // The pathMatchesPrefix segment rule treats '/About/' as a bucket
    // and matches both '/about' and '/about/anything'.
    assert.equal(
      isInstitutionalStaticPage('https://www.defense.gov/About'),
      true,
    );
  });

  it('Air Force /Strategy bare segment (no trailing slash)', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.af.mil/Strategy'),
      true,
    );
  });

  it('State Dept /Policy bare segment (no trailing slash)', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.state.gov/Policy'),
      true,
    );
  });

  it('does NOT over-match /aboutface (segment boundary enforced)', () => {
    // The segment rule rejects /aboutface even though /aboutface starts
    // with /about. Without the boundary check, every path that happens
    // to begin with the prefix letters would over-trigger.
    assert.equal(
      isInstitutionalStaticPage('https://www.defense.gov/aboutface'),
      false,
    );
  });

  it('does NOT over-match /strategist (segment boundary enforced)', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.af.mil/strategist'),
      false,
    );
  });

  it('Section-508 page on a different .gov host', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.state.gov/Section-508/'),
      true,
    );
  });

  it('Strategy page on .mil', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.af.mil/Strategy/Some-Page/'),
      true,
    );
  });

  it('case-insensitive path matching', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.defense.gov/ABOUT/something'),
      true,
    );
  });

  it('case-insensitive host matching', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.DEFENSE.GOV/About/x'),
      true,
    );
  });
});

describe('isInstitutionalStaticPage — legitimate news on institutional domains (false)', () => {
  it('Pentagon news article under /News/Releases/', () => {
    assert.equal(
      isInstitutionalStaticPage(
        'https://www.defense.gov/News/Releases/Release/Article/4123456/some-news/',
      ),
      false,
    );
  });

  it('whitehouse.gov press release path', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.whitehouse.gov/briefing-room/press-briefings/'),
      false,
    );
  });

  it('state.gov news page', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.state.gov/press-release-2026/'),
      false,
    );
  });
});

describe('isInstitutionalStaticPage — non-institutional hosts (false)', () => {
  it('CBS News tornado article', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.cbsnews.com/news/tornadoes-midwest/'),
      false,
    );
  });

  it('.com host with About path (path matches but host does not)', () => {
    assert.equal(
      isInstitutionalStaticPage('https://example.com/About/team'),
      false,
    );
  });

  it('Google News redirect URL (has news.google.com host, not .gov)', () => {
    assert.equal(
      isInstitutionalStaticPage(
        'https://news.google.com/articles/CBMiSWh0dHBzOi8v...',
      ),
      false,
    );
  });

  it('.org host (not in institutional set)', () => {
    assert.equal(
      isInstitutionalStaticPage('https://www.aclu.org/About/'),
      false,
    );
  });
});

describe('isInstitutionalStaticPage — defensive on bad input (false, no throw)', () => {
  it('empty string', () => {
    assert.equal(isInstitutionalStaticPage(''), false);
  });

  it('null', () => {
    assert.equal(isInstitutionalStaticPage(null), false);
  });

  it('undefined', () => {
    assert.equal(isInstitutionalStaticPage(undefined), false);
  });

  it('non-string (number)', () => {
    assert.equal(isInstitutionalStaticPage(42), false);
  });

  it('malformed URL', () => {
    assert.equal(isInstitutionalStaticPage('not a url'), false);
  });

  it('javascript: URL (non-http protocol)', () => {
    assert.equal(
      isInstitutionalStaticPage('javascript:alert(1)'),
      false,
    );
  });

  it('data: URL', () => {
    assert.equal(
      isInstitutionalStaticPage('data:text/html,<h1>hi</h1>'),
      false,
    );
  });
});

describe('isInstitutionalStaticPage — edge cases', () => {
  it('http (not https) institutional URL still classifies', () => {
    // Some legacy government sites still serve http; don't lose the
    // signal just because the protocol is unencrypted.
    assert.equal(
      isInstitutionalStaticPage('http://www.defense.gov/About/x'),
      true,
    );
  });

  it('institutional URL with no recognized path prefix passes through (false)', () => {
    // Conservative-by-design: must match BOTH host AND path. A bare
    // /News/ article on defense.gov is not flagged.
    assert.equal(
      isInstitutionalStaticPage('https://www.defense.gov/News/Article/123/'),
      false,
    );
  });
});
