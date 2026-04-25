// Pin the FATF entry-page parser + listing extractor + publication-date
// inference. Plan 2026-04-25-004 §Component 3.
//
// Tests use realistic HTML fragments (NOT recorded-from-network fixtures
// because FATF rebuilds their site periodically). The fragment shapes
// mirror the patterns observed at
// `https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html`
// as of 2026-02-13. If FATF restructures the page, these tests fail
// loudly and the seeder's `find*Link` regex needs an update.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findPublicationLink,
  extractListedCountries,
  extractPublicationDate,
  validate,
  fetchViaWayback,
} from '../scripts/seed-fatf-listing.mjs';

describe('findPublicationLink — entry-page anchor scan', () => {
  const ENTRY_PAGE_2026 = `
    <html><body>
      <h2>Black & grey lists</h2>
      <p>Latest FATF actions:</p>
      <ul>
        <li><a href="/en/publications/Fatfrecommendations/high-risk-jurisdictions-2026.html">High-risk jurisdictions subject to a call for action — February 2026</a></li>
        <li><a href="/en/publications/Fatfrecommendations/increased-monitoring-feb-2026.html">Jurisdictions under increased monitoring — February 2026</a></li>
      </ul>
    </body></html>
  `;

  it('finds the "high-risk" (black list) publication URL', () => {
    const url = findPublicationLink(ENTRY_PAGE_2026, 'high-risk');
    assert.match(url, /high-risk-jurisdictions/);
    assert.match(url, /^https:\/\/www\.fatf-gafi\.org\//, 'must resolve relative href against FATF origin');
  });

  it('finds the "increased monitoring" (grey list) publication URL', () => {
    const url = findPublicationLink(ENTRY_PAGE_2026, 'increased monitoring');
    assert.match(url, /increased-monitoring/);
  });

  it('returns null when label is absent (loud failure for parser regression)', () => {
    const sterile = '<html><body><p>Nothing here</p></body></html>';
    assert.equal(findPublicationLink(sterile, 'high-risk'), null);
  });

  it('case-insensitive label match', () => {
    const url = findPublicationLink(ENTRY_PAGE_2026, 'HIGH-RISK');
    assert.ok(url);
  });
});

describe('extractListedCountries — country-name lookup from publication HTML', () => {
  // Build a minimal name lookup mirroring the structure of country-names.json.
  function buildLookup() {
    return new Map([
      ['north korea', 'KP'],
      ['democratic peoples republic of korea', 'KP'],
      ['iran', 'IR'],
      ['islamic republic of iran', 'IR'],
      ['myanmar', 'MM'],
      ['burma', 'MM'],
      ['nigeria', 'NG'],
      ['south africa', 'ZA'],
    ]);
  }

  it('extracts country names from H2 / strong tag patterns (FATF black-list page)', () => {
    const html = `
      <html><body>
        <h2>High-Risk Jurisdictions Subject to a Call for Action</h2>
        <p>Updated February 2026</p>
        <h3>Democratic People's Republic of Korea</h3>
        <p>The FATF urges members to apply enhanced due diligence...</p>
        <h3>Iran</h3>
        <p>Iran remains subject to a call for countermeasures.</p>
        <h3>Myanmar</h3>
      </body></html>
    `;
    const { listed } = extractListedCountries(html, buildLookup());
    assert.ok(listed.has('KP'), 'must extract DPRK');
    assert.ok(listed.has('IR'), 'must extract Iran');
    assert.ok(listed.has('MM'), 'must extract Myanmar');
  });

  it('extracts country names from grey-list publication (typical 15-25 countries)', () => {
    const html = `
      <html><body>
        <h2>Jurisdictions under Increased Monitoring</h2>
        <ul>
          <li>Nigeria</li>
          <li>South Africa</li>
        </ul>
      </body></html>
    `;
    const { listed } = extractListedCountries(html, buildLookup());
    assert.ok(listed.has('NG'));
    assert.ok(listed.has('ZA'));
  });

  it('ignores long paragraphs that happen to mention country names', () => {
    // Defensive: paragraph text > 80 chars is skipped to avoid false matches.
    const html = `
      <h3>Iran</h3>
      <p>The FATF expressed concern about Iran's continued failure to address financial system risks across many jurisdictions including but not limited to Iran's own. This is a long paragraph and should not match.</p>
    `;
    const { listed } = extractListedCountries(html, buildLookup());
    assert.ok(listed.has('IR'), 'h3 match still works');
    // The long paragraph mentioning Iran does NOT independently double-count.
    assert.equal(listed.size, 1);
  });

  it('flags short capitalized text nodes that look like missing country names', () => {
    // FATF introduces a new spelling not in country-names.json — must
    // surface as unmatchedCandidate so ops can extend the aliases map.
    const html = `
      <html><body>
        <h3>Mauretania</h3>  <!-- alternate spelling not in lookup -->
        <h3>Iran</h3>
      </body></html>
    `;
    const { listed, unmatchedCandidates } = extractListedCountries(html, buildLookup());
    assert.ok(listed.has('IR'), 'matched country still resolves');
    assert.ok(unmatchedCandidates.has('Mauretania'), 'unknown spelling surfaces as unmatched candidate');
  });

  it('does NOT flag known FATF section headers as unmatched', () => {
    const html = `
      <html><body>
        <h2>High-Risk Jurisdictions Subject to a Call for Action</h2>
        <h3>Iran</h3>
      </body></html>
    `;
    const { unmatchedCandidates } = extractListedCountries(html, buildLookup());
    // Section headers are too long (>80 chars after stripHtml is fine) AND
    // they're in the SECTION_NOISE allow-list. None should appear as
    // unmatched candidates.
    assert.equal(unmatchedCandidates.size, 0, 'section headers must not be flagged as unmatched country names');
  });
});

describe('extractPublicationDate — slug + header inference', () => {
  it('parses YYYY-MM from URL slug', () => {
    const date = extractPublicationDate(
      'https://www.fatf-gafi.org/en/publications/foo/high-risk-2026-02.html',
      '<html></html>',
    );
    assert.equal(date, '2026-02-01');
  });

  it('falls back to "February 2026" header when URL slug is dateless', () => {
    const date = extractPublicationDate(
      'https://www.fatf-gafi.org/en/publications/foo/high-risk.html',
      '<h2>High-Risk Jurisdictions — February 2026</h2>',
    );
    assert.equal(date, '2026-02-01');
  });

  it('falls back to current date when neither URL nor header has a date', () => {
    const date = extractPublicationDate(
      'https://www.fatf-gafi.org/en/publications/foo.html',
      '<html><body>No date here</body></html>',
    );
    // Just check it's a valid YYYY-MM-DD; can't pin the value because it's "today".
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('validate', () => {
  it('rejects payload missing the listings field', () => {
    assert.equal(validate({}), false);
  });

  it('rejects payload with no black-listed jurisdiction (DPRK has been on call-for-action since 2011)', () => {
    const onlyGrey = {};
    for (let i = 0; i < 15; i++) onlyGrey[`X${i.toString().padStart(2, '0')}`] = 'gray';
    assert.equal(validate({ listings: onlyGrey }), false);
  });

  it('rejects payload with too few grey-listed jurisdictions (parser likely failed)', () => {
    // Floor tightened from 8 → 12 — historical FATF grey-list size has
    // been 15+ since 2020. A grey count below 12 indicates real upstream
    // failure or parser drift.
    const listings = { KP: 'black' };
    for (let i = 0; i < 10; i++) listings[`X${i.toString().padStart(2, '0')}`] = 'gray';
    assert.equal(validate({ listings }), false);
  });

  it('accepts payload with at least 1 black + 12 grey', () => {
    const listings = { KP: 'black' };
    for (let i = 0; i < 14; i++) listings[`X${i.toString().padStart(2, '0')}`] = 'gray';
    assert.equal(validate({ listings }), true);
  });
});

// ── fetchViaWayback — Cloudflare-bypass fallback ─────────────────────────

describe('fetchViaWayback — Cloudflare-bypass via Wayback Machine', () => {
  const FATF_URL = 'https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html';
  // CDX response shape: [headerRow, ...snapshotRows]. Each snapshot row
  // is [urlkey, timestamp, original, mimetype, statuscode, digest, length].
  // Ordered timestamp-ascending — last row is most recent.
  function cdxResponse(...timestamps) {
    return {
      ok: true,
      json: async () => [
        ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
        ...timestamps.map((ts) => [
          'org,fatf-gafi)/en/countries/black-and-grey-lists.html',
          ts,
          FATF_URL,
          'text/html',
          '200',
          'DIGEST',
          '18000',
        ]),
      ],
    };
  }

  it('happy path: queries CDX for latest 200 snapshot, fetches it via id_ modifier, returns HTML', async () => {
    const calls = [];
    const fetchFn = async (url) => {
      calls.push(url);
      if (url.startsWith('https://web.archive.org/cdx/')) {
        return cdxResponse('20260224230921', '20260331230909', '20260403144947');
      }
      // Snapshot fetch — must use the LATEST timestamp + id_ modifier
      assert.match(url, /web\/20260403144947id_\//, 'must request the latest CDX timestamp with id_ modifier');
      return { ok: true, text: async () => '<html><body><h2>Black & grey lists</h2></body></html>' };
    };
    const html = await fetchViaWayback(FATF_URL, { fetchFn });
    assert.match(html, /Black & grey lists/);
    assert.equal(calls.length, 2, 'one CDX call + one snapshot call');
  });

  it('CDX URL is built with statuscode:200 filter, a from-date, AND limit=-1 (negative limit returns the most-recent capture)', async () => {
    let cdxUrl;
    const fetchFn = async (url) => {
      if (url.startsWith('https://web.archive.org/cdx/')) {
        cdxUrl = url;
        return cdxResponse('20260403144947');
      }
      return { ok: true, text: async () => '<html></html>' };
    };
    await fetchViaWayback(FATF_URL, { fetchFn, lookbackDays: 90 });
    assert.match(cdxUrl, /filter=statuscode%3A200|filter=statuscode:200/, 'CDX query must filter to status 200');
    assert.match(cdxUrl, /from=\d{8}/, 'CDX query must include a from-date floor');
    assert.match(cdxUrl, /output=json/);
    // Critical: CDX default ordering is timestamp-ASCENDING. A positive
    // `limit=N` returns the OLDEST N captures within the window — not the
    // newest. FATF accumulates well over 20 captures per 180-day window,
    // so a positive limit would silently serve a stale archived snapshot
    // even when a newer one exists. `limit=-1` = "last 1 capture" =
    // most-recent. Pin this so a future cleanup can't regress it.
    assert.match(cdxUrl, /[?&]limit=-1(&|$)/, 'CDX query MUST use negative limit (limit=-1) to get the most-recent snapshot, not the oldest within the window');
    assert.doesNotMatch(cdxUrl, /[?&]limit=(?!-)\d+/, 'CDX query must NOT use a positive limit — that returns the oldest captures and serves stale data');
  });

  it('throws clear error when Wayback has NO status-200 snapshots in window', async () => {
    const fetchFn = async (url) => {
      if (url.startsWith('https://web.archive.org/cdx/')) {
        // Only the header row, no actual snapshots.
        return { ok: true, json: async () => [['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length']] };
      }
      throw new Error('snapshot fetch should not be reached when CDX is empty');
    };
    await assert.rejects(
      fetchViaWayback(FATF_URL, { fetchFn }),
      /no status-200 snapshots/,
    );
  });

  it('throws when CDX itself is unreachable (HTTP 5xx) AND no proxy is configured', async () => {
    // Pass proxyAuth: null to disable the new proxy fallback so this
    // test stays focused on the direct-CDX failure mode. The proxy
    // fallback path is exercised in dedicated cases below.
    const fetchFn = async () => ({ ok: false, status: 503 });
    await assert.rejects(
      fetchViaWayback(FATF_URL, { fetchFn, proxyAuth: null }),
      /Wayback CDX direct failed.*HTTP 503.*no proxy configured/,
    );
  });

  it('throws when the snapshot itself returns non-200 AND no proxy is configured (e.g. Wayback re-fetched a Cloudflare 403)', async () => {
    const fetchFn = async (url) => {
      if (url.startsWith('https://web.archive.org/cdx/')) {
        return cdxResponse('20260403144947');
      }
      return { ok: false, status: 403 };
    };
    await assert.rejects(
      fetchViaWayback(FATF_URL, { fetchFn, proxyAuth: null }),
      /Wayback snapshot 20260403144947 direct failed.*HTTP 403.*no proxy configured/,
    );
  });

  it('rejects malformed CDX timestamps (defends against CDX schema drift)', async () => {
    const fetchFn = async (url) => {
      if (url.startsWith('https://web.archive.org/cdx/')) {
        return {
          ok: true,
          json: async () => [
            ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
            ['org,fatf-gafi)/x', 'NOT-A-TIMESTAMP', FATF_URL, 'text/html', '200', 'D', '1'],
          ],
        };
      }
      throw new Error('snapshot fetch should not run with malformed timestamp');
    };
    await assert.rejects(
      fetchViaWayback(FATF_URL, { fetchFn }),
      /malformed timestamp/,
    );
  });

  it('sends a User-Agent header on BOTH the CDX query and the snapshot fetch (AGENTS.md convention)', async () => {
    // AGENTS.md mandates "Always include `User-Agent` header in
    // server-side fetch calls". The direct FATF fetch sends CHROME_UA;
    // the Wayback path must match. archive.org doesn't usually block
    // header-less requests, but house-style consistency is the point —
    // and a future Wayback rate-limiter could reasonably enforce UA.
    const seenHeaders = [];
    const fetchFn = async (url, opts) => {
      seenHeaders.push({ url, ua: opts?.headers?.['User-Agent'] });
      if (url.startsWith('https://web.archive.org/cdx/')) {
        return cdxResponse('20260403144947');
      }
      return { ok: true, text: async () => '<html></html>' };
    };
    await fetchViaWayback(FATF_URL, { fetchFn });
    assert.equal(seenHeaders.length, 2, 'expected one CDX + one snapshot fetch');
    for (const { url, ua } of seenHeaders) {
      assert.ok(typeof ua === 'string' && ua.length > 0,
        `User-Agent must be set on ${url} (got: ${ua})`);
      // Pin that we're not sending some empty/sentinel value — it should
      // be the real CHROME_UA the rest of the seeder uses.
      assert.match(ua, /Mozilla\/5\.0/,
        `User-Agent on ${url} should be the canonical CHROME_UA, not a placeholder; got: ${ua}`);
    }
  });

  it('per-tier timeouts sum to a budget that fits in seed-bundle-macro.mjs FATF-Listing timeoutMs (no SIGTERM mid-fetch)', async () => {
    // Static-shape regression guard. Pre-PR-#3415 the tier timeouts were:
    //   direct 30s + proxy 30s + wayback 4×45s = 240s/URL
    //   × 3 URLs (entry sequential + black/grey parallel) = 480s end-to-end
    // while the section was capped at 120_000ms. That meant bundle-runner
    // would SIGTERM the seeder mid-fetch instead of letting runSeed reach
    // its graceful "Failed gracefully" path. This test pins the new
    // budget so a future cleanup can't silently regress it.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const seederSrc = readFileSync(resolve(here, '../scripts/seed-fatf-listing.mjs'), 'utf-8');
    const bundleSrc = readFileSync(resolve(here, '../scripts/seed-bundle-macro.mjs'), 'utf-8');
    // Direct fetch timeout — 10s ceiling; Cloudflare 403s in <1s when blocking.
    assert.match(seederSrc, /AbortSignal\.timeout\(10_000\)/, 'direct fetch must use 10s timeout (was 30s pre-fix)');
    // Proxy fetch timeout — 15s ceiling.
    assert.match(seederSrc, /timeoutMs:\s*15_000\s*\}\s*\)/, 'proxy fetch must use 15s timeoutMs (was 30s pre-fix)');
    // Wayback per-tier — 25s ceiling.
    assert.match(seederSrc, /WAYBACK_TIMEOUT_MS\s*=\s*25_000/, 'WAYBACK_TIMEOUT_MS must be 25s (was 45s pre-fix)');
    // Section timeoutMs — 300s, matches peer sections.
    assert.match(bundleSrc, /label:\s*'FATF-Listing'[^\n]*timeoutMs:\s*300_000/, 'FATF-Listing section must use 300_000 ms timeoutMs (was 120_000 pre-fix)');
  });

  it('falls back to CONNECT proxy when direct CDX query fails (Railway-egress rate-limit defense)', async () => {
    // Production observation 2026-04-25T20:35: Railway egress IPs hit
    // 20s+ timeouts on CDX while local desktop probes complete in <2s.
    // The same pool gets soft-rate-limited or routed slowly to
    // archive.org. Routing CDX through Decodo's residential proxy pool
    // bypasses that without changing the response shape.
    const fetchFn = async () => {
      // Direct CDX fails — simulate timeout/rate-limit.
      throw new Error('fetch failed');
    };
    const proxyCalls = [];
    const proxyFetcher = async (url, auth, opts) => {
      proxyCalls.push({ url, auth, opts });
      if (url.startsWith('https://web.archive.org/cdx/')) {
        // Return CDX response shape: header + 1 row.
        return {
          buffer: Buffer.from(JSON.stringify([
            ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
            ['org,fatf-gafi)/x', '20260403144947', FATF_URL, 'text/html', '200', 'D', '1'],
          ])),
        };
      }
      // Snapshot via proxy.
      return { buffer: Buffer.from('<html><body><h2>Wayback via proxy</h2></body></html>') };
    };
    const html = await fetchViaWayback(FATF_URL, {
      fetchFn,
      proxyFetcher,
      proxyAuth: 'test-user:test-pass@gate.decodo.com:7000',
    });
    assert.match(html, /Wayback via proxy/);
    // Both CDX and snapshot must have hit the proxy after direct failed.
    assert.equal(proxyCalls.length, 2, 'both CDX and snapshot must route through proxy after direct failure');
    assert.match(proxyCalls[0].url, /^https:\/\/web\.archive\.org\/cdx\//);
    assert.match(proxyCalls[1].url, /\/web\/20260403144947id_\//, 'snapshot proxy fetch must still use the id_ modifier + the CDX timestamp');
  });

  it('error message unwraps err.cause when both direct and proxy fail (operator-actionable diagnostics)', async () => {
    // The pre-fix error was "wayback=fetch failed" with no detail —
    // unactionable in production logs. The fix adds a describeErr
    // helper that pulls err.cause.code / err.cause.message so failures
    // surface DNS / TCP-reset / TLS-abort distinctions.
    const fetchFn = async () => {
      const err = new TypeError('fetch failed');
      err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND web.archive.org'), { code: 'ENOTFOUND' });
      throw err;
    };
    const proxyFetcher = async () => {
      const err = new Error('Proxy CONNECT: HTTP/1.1 407 Proxy Authentication Required');
      throw err;
    };
    await assert.rejects(
      fetchViaWayback(FATF_URL, {
        fetchFn,
        proxyFetcher,
        proxyAuth: 'test:test@proxy.example:7000',
      }),
      (err) => {
        // Error message must include BOTH the direct cause (ENOTFOUND
        // unwrapped) and the proxy error message — gives operators the
        // full failure surface in one log line.
        assert.match(err.message, /direct=.*ENOTFOUND/, `expected ENOTFOUND cause unwrapped; got: ${err.message}`);
        assert.match(err.message, /proxy=.*407/, `expected proxy 407 in message; got: ${err.message}`);
        return true;
      },
    );
  });

  it('uses id_ modifier (NOT the bare /web/timestamp/url path) — keeps the parser DOM byte-for-byte identical to direct FATF', async () => {
    // Without `id_`, Wayback prepends a ~3KB toolbar banner and rewrites
    // every href/src to /web/.../ paths. Both would break the existing
    // parser. This test pins the modifier so a future "cleanup" can't
    // silently regress to the broken bare form.
    let snapshotUrl;
    const fetchFn = async (url) => {
      if (url.startsWith('https://web.archive.org/cdx/')) {
        return cdxResponse('20260403144947');
      }
      snapshotUrl = url;
      return { ok: true, text: async () => '<html></html>' };
    };
    await fetchViaWayback(FATF_URL, { fetchFn });
    assert.match(snapshotUrl, /\/web\/\d{14}id_\//, 'snapshot URL MUST use the id_ modifier');
  });
});
