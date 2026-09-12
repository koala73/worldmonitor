# TARGET-001 — RSS Proxy SSRF Review

## Target
`worldmonitor-main/api/rss-proxy.js` (and helpers `api/_rss-allowed-domain-match.js`, `api/_rss-allowed-domains.js`, `api/_rss-fetch-headers.js`)

---

## Request Flow

```
HTTP GET /api/rss-proxy?url=<target_feed_url>
   │
   ├── 1. Origin & Method Check (CORS allowlist & GET enforcement)
   ├── 2. API Key Validation (`validateApiKey(req)`)
   ├── 3. Rate Limit Check (`checkRateLimit(req)`)
   ├── 4. Input URL Parsing (`new URL(feedUrl)`)
   ├── 5. Protocol Verification (`assertHttpProtocol(parsedUrl)` -> http: / https:)
   ├── 6. Domain Allowlist Verification (`isAllowedDomain(parsedUrl.hostname)`)
   ├── 7. Request Execution (`fetchWithTimeout` with `redirect: 'manual'`)
   │      └── Redirect Loop (Max 3 redirects):
   │             ├── Read `Location` header
   │             ├── Resolve target URL (`new URL(location, currentUrl)`)
   │             └── Re-verify Protocol & Domain Allowlist (`assertAllowedRedirect(redirectUrl)`)
   └── 8. Response Sanitization & Delivery
```

---

## Input Handling

- **Query Parameter**: Extracts target RSS URL via `requestUrl.searchParams.get('url')`.
- **Parsing**: Instantiates `new URL(feedUrl)`. Malformed URLs return immediate `HTTP 400 Invalid url parameter` response without throwing unhandled exceptions.
- **Header Injection Defense**: Headers passed upstream are generated deterministically by `rssFetchHeadersForHost(currentUrl.hostname)` (`User-Agent`, `Accept`). User-controlled headers are not passed to upstream requests.

---

## URL Validation

- **Protocol Restriction**: `assertHttpProtocol()` strictly requires `http:` or `https:`. File (`file://`), gopher (`gopher://`), dict (`dict://`), and internal protocols are rejected with `HTTP 400`.
- **Domain Allowlisting**: `isAllowedDomain()` checks the target hostname against `RSS_ALLOWED_DOMAINS` (`api/_rss-allowed-domains.js`), an explicit whitelist of ~250 trusted RSS publisher hostnames (e.g., `bbc.co.uk`, `reuters.com`, `news.google.com`).
- **`www.` Prefix Normalization**: `hostMatchForms()` tests exact hostname, bare domain, and `www.` prefixed domain against the allowlist to prevent bypasses or unnecessary blocks.
- **Localhost & Private IP Block**: Any input specifying `localhost`, `127.0.0.1`, `10.x.x.x`, `172.16.x.x`, `192.168.x.x`, `169.254.169.254` (cloud metadata), or `[::1]` fails `isAllowedDomain()` and is rejected with `HTTP 403 Domain not allowed`.

---

## Network Request

- Executes requests using Vercel edge runtime `fetchWithTimeout()` with explicit timeouts (12 seconds default, 20 seconds for Google News).
- Emits response with restrictive headers:
  - `'Content-Type': 'text/plain; charset=utf-8'` (prevents browser XML/HTML execution as document).
  - `'X-Content-Type-Options': 'nosniff'`
  - `'Content-Security-Policy': "sandbox; default-src 'none'"`
  - `'Cache-Control': 'private, max-age=180'`

---

## Redirect Handling

- Uses `redirect: 'manual'` to intercept HTTP 301, 302, 303, 307, and 308 redirects.
- Limits maximum redirects to `MAX_DIRECT_REDIRECTS = 3`.
- **Per-Redirect Re-Validation**:
  ```js
  function assertAllowedRedirect(url) {
    assertHttpProtocol(url, 'Redirect protocol not allowed', 403);
    if (!isAllowedDomain(url.hostname)) {
      throw new RssProxyPolicyError('Redirect to disallowed domain');
    }
  }
  ```
  Every redirect target URL is parsed and passed to `assertAllowedRedirect()`. If an allowed public feed attempts to redirect to a private IP (`169.254.169.254`), localhost, or non-whitelisted domain, the request is immediately aborted with `HTTP 403 Redirect to disallowed domain`.

---

## DNS Handling

- Domain allowlist validation is performed **before** DNS resolution.
- Because arbitrary domain names cannot be passed to the proxy, attacker-controlled domains pointing to internal IP addresses (DNS rebinding) are blocked prior to network resolution unless the domain is present in the static allowlist `RSS_ALLOWED_DOMAINS`.

---

## Security Controls Summary

1. **Protocol Assertion**: Enforces `http:` / `https:`.
2. **Domain Allowlisting**: Restricts fetch destinations to an explicit static registry.
3. **Manual Redirect Interception**: Prevents open-redirect SSRF by validating every redirect destination against the domain allowlist.
4. **Header & Context Isolation**: Prevents internal request header propagation.
5. **Response Sandboxing**: Serves content as `text/plain` with CSP `sandbox` to eliminate client-side XSS risks.

---

## Potential Weakness

No design flaws or security bypasses were identified in `api/rss-proxy.js`.

---

## Evidence

- **Protocol Guard**: [api/rss-proxy.js](file:///c:/Users/varun/OneDrive/Documents/personals/SIH%2026163/worldmonitor/worldmonitor-main/api/rss-proxy.js#L54-L58)
- **Domain Guard**: [api/rss-proxy.js](file:///c:/Users/varun/OneDrive/Documents/personals/SIH%2026163/worldmonitor/worldmonitor-main/api/rss-proxy.js#L112-L115)
- **Redirect Re-Validation Guard**: [api/rss-proxy.js](file:///c:/Users/varun/OneDrive/Documents/personals/SIH%2026163/worldmonitor/worldmonitor-main/api/rss-proxy.js#L60-L67)
- **Domain Match Predicate**: [api/_rss-allowed-domain-match.js](file:///c:/Users/varun/OneDrive/Documents/personals/SIH%2026163/worldmonitor/worldmonitor-main/api/_rss-allowed-domain-match.js#L26-L32)

---

## Safe Validation Plan

Because static source inspection conclusively proves `api/rss-proxy.js` enforces strict protocol checks, domain allowlisting, and per-redirect validation, local runtime exploitation testing is **unnecessary**.

For automated verification purposes, unit tests in `api/rss-proxy.test.mjs` already assert that non-allowlisted domains and invalid protocols return HTTP 403/400.

---

## Classification

**SOURCE-PROTECTED**

---

## Conclusion

**No vulnerability established.**

`api/rss-proxy.js` implements defense-in-depth security controls against Server-Side Request Forgery (SSRF), including protocol restrictions, domain allowlisting, and strict per-redirect re-validation.
