// Regression guard for #5074 — OpenSky OAuth/data fetch through the residential
// proxy must reuse the tunnel's already-TLS socket via `createConnection`, NOT `socket:`.
//
// proxyConnectTunnel() (scripts/_proxy-utils.cjs) returns a socket that is ALREADY
// tls.connect()-wrapped to the target (opensky) over the CONNECT tunnel. Passing it
// to https.request/https.get as `socket: tlsSocket` makes the https layer wrap it in
// a SECOND TLS handshake → the inner encrypted response is read as a TLS handshake
// record → EPROTO "tls_validate_record_header: wrong version number". The whole
// OpenSky flight path (auth token + states fetch) then fails every tick (opensky=0).
//
// The working sibling proxyFetch() in _proxy-utils.cjs consumes the same tunnel with
// `createConnection: () => tlsSocket`, which reuses the socket as-is (no double wrap).
// This test locks the two OpenSky proxy call sites onto that correct pattern.
//
// The double-TLS mechanism itself is proven separately (a self-contained repro:
// https.request({socket: alreadyTlsSocket}) → EPROTO; {createConnection:()=>sock} → 200).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

test('OpenSky proxy fetches never pass an already-TLS tunnel socket via `socket:` (double-TLS → EPROTO #5074)', () => {
  const antipattern = SRC.match(/socket:\s*tlsSocket/g) || [];
  assert.equal(
    antipattern.length,
    0,
    `Found ${antipattern.length} "socket: tlsSocket" occurrence(s). proxyConnectTunnel returns an ` +
    `already-TLS socket; passing it as \`socket:\` to https.request double-wraps TLS and throws ` +
    `EPROTO "wrong version number". Use \`createConnection: () => tlsSocket\` instead (see proxyFetch).`,
  );
});

test('both OpenSky proxy fetches (token + data) reuse the tunnel socket via createConnection', () => {
  const good = SRC.match(/createConnection:\s*\(\)\s*=>\s*tlsSocket/g) || [];
  // One for _attemptOpenSkyTokenFetch (OAuth token), one for _openskyRawFetch (states data).
  assert.ok(
    good.length >= 2,
    `Expected >= 2 "createConnection: () => tlsSocket" call sites (OpenSky token + data fetch); found ${good.length}.`,
  );
});
