# Cyber threat network information

Expand **Network information** in an IP-based Cyber Threat popup to request passive network context. Domain and URL indicators keep their original type and are not resolved. Opening a marker alone makes no network lookup. The indicator IP is sent by the server to RIPEstat; the browser does not contact the provider directly. No host scans are performed.

Threat-feed observations remain separate from network context. RIPEstat's `prefix-overview` supplies origin ASNs, reported ASN holders and the routing prefix. A less-specific match is labelled explicitly. `reverse-dns-ip` supplies an optional DNS hostname, not proof of ownership. The popup does not infer an ISP's legal identity, registered organization, city or physical host location. Missing fields show “Not available”. Threat observation, routing-data and retrieval times are distinct. Cached retrieval timestamps do not advance.

## Provider activation

The integration is **disabled by default**. Before setting `RIPESTAT_NETWORK_INFO_ENABLED=true` on the server, obtain written permission from RIPE NCC for WorldMonitor's intended commercial reuse and redistribution. [RIPEstat service terms](https://www.ripe.net/about-us/legal/ripestat-service-terms-and-conditions/) section 3.3 restricts commercial reuse and redistribution. This setting records an operator decision; it does not grant a license. Unset it to stop provider requests and reads from the lookup cache. This change does not activate or deploy the integration.

Attribution in the popup names RIPEstat / RIPE NCC and RIS / WHOIS, with a link to the queried resource. The requests identify `sourceapp=worldmonitor` and include a User-Agent. Follow the [API usage rules](https://stat.ripe.net/docs/data-api/ripestat-data-api): register regular usage over 1,000 requests/day before increasing the limits.

## Limits and fallback

- Gateway: 20 requests/minute per caller under the existing endpoint policy, fail closed.
- Provider work: six cache-miss lookups/hour per caller, then four lookups/minute and 450/day across the deployment, each with at most two provider calls. Caller identity uses the gateway's trusted client-IP key. All budgets fail closed when Redis is missing or degraded. Cache hits do not consume provider budgets. Caller refusals do not cache a failure for other callers sharing the same IP indicator.
- Shared cache: 24 hours per canonical public IP, with in-flight deduplication. Provider failures receive the shared helper's short negative-cache cooldown rather than a day-long success entry.
- Both provider calls share a five-second timeout. Reverse-DNS failure preserves available routing data. The browser request has a 15-second timeout.
- Gateway responses are `no-store`, so disabling the provider is not delayed by a browser/CDN cache. Successful server cache entries retain their original lookup time.
- There is one lookup per popup expansion lifecycle; collapse/reopen does not repeat it. Reopen the marker to retry after failure. Late responses cannot replace another popup's content.

## Verification

`server/__tests__/cyber-network-info.test.ts` covers opt-in, public IPv4/IPv6 validation, canonical cache keys, budgets, multiple ASNs, partial responses and provider failure. `tests/dom/map-popup-cyber-network.test.mts` covers on-demand binding, escaped text and stale-response isolation. `e2e/cyber-network-popup.spec.ts` uses the existing map popup harness with controlled RPC responses for English/German at 1280px and 390px, clipboard actions, overflow and failure/recovery.

Browser proof covers Chromium and the shared popup DOM. It does not prove native Windows/WebView2 rendering, deployed gateway behavior, provider authorization, or production availability. The sample IP and Telia fields are test examples, not current threat attribution.
