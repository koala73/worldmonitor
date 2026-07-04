// Blocklist for resolved IP addresses (SSRF defence). Callers pass either a
// literal IP (from a DNS answer) or a hostname (pre-resolution short-circuit);
// hostnames that are not IP literals fall through and return false.
//
// IPv6 is decoded numerically so every textual spelling (compressed `::`,
// fully expanded, upper/lowercase, and embedded-IPv4 forms) is classified the
// same way. Embedded-IPv4 encodings (v4-mapped, NAT64, IPv4-compatible, 6to4)
// are decoded to their embedded IPv4 and run through the IPv4 blocklist so a
// private/reserved v4 cannot be smuggled through an IPv6 wrapper.

function isBlockedIpv4(a: number, b: number, c: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 deprecated 6to4
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isBlockedDottedIpv4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return isBlockedIpv4(a, b, c);
}

// Decode two consecutive 16-bit IPv6 hextets that carry an embedded IPv4
// (hi = first two octets, lo = last two octets) and run the IPv4 blocklist.
function isBlockedEmbeddedIpv4(hi: number, lo: number): boolean {
  return isBlockedIpv4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff);
}

// Expand any textual IPv6 spelling into exactly 8 numeric hextets, or return
// null if the input is not a well-formed IPv6 literal. Handles `::`
// compression and a trailing dotted-quad IPv4 (e.g. ::ffff:1.2.3.4).
function expandIpv6(input: string): number[] | null {
  let s = input;
  const pct = s.indexOf('%'); // strip zone id (fe80::1%eth0)
  if (pct !== -1) s = s.slice(0, pct);
  if (!s.includes(':')) return null;

  // Convert a trailing dotted-quad IPv4 suffix into two hextets.
  const dotMatch = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotMatch) {
    const dotted = dotMatch[1];
    if (dotted === undefined) return null; // unreachable (capture group), satisfies TS
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const [o0, o1, o2, o3] = octets as [number, number, number, number];
    const hextets = [
      (((o0 << 8) | o1) >>> 0).toString(16),
      (((o2 << 8) | o3) >>> 0).toString(16),
    ].join(':');
    s = s.slice(0, s.length - dotted.length) + hextets;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null; // more than one `::` is invalid

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  if (halves.length === 2) {
    const head = parseGroups(halves[0] ?? '');
    const tail = parseGroups(halves[1] ?? '');
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // `::` must stand for at least one hextet
    return [...head, ...new Array(missing).fill(0), ...tail];
  }

  const groups = parseGroups(s);
  if (groups === null || groups.length !== 8) return null;
  return groups;
}

export function isBlockedResolvedAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');

  // Literal dotted IPv4.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    return isBlockedDottedIpv4(normalized);
  }

  const groups = expandIpv6(normalized);
  if (!groups) return false; // not an IP literal (e.g. a hostname) — nothing to block here
  const [g0, g1, g2, , , g5, g6, g7] = groups as
    [number, number, number, number, number, number, number, number];

  // :: (unspecified) and ::1 (loopback).
  const highSevenZero = groups.slice(0, 7).every(part => part === 0);
  if (highSevenZero && (g7 === 0 || g7 === 1)) return true;

  // Reserved / internal IPv6 ranges (mask the leading hextet).
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation

  // Embedded-IPv4 forms — decode the embedded IPv4 and run the v4 blocklist.
  if (groups.slice(0, 5).every(part => part === 0) && g5 === 0xffff) {
    return isBlockedEmbeddedIpv4(g6, g7); // ::ffff:0:0/96 v4-mapped (dotted + hex)
  }
  if (g0 === 0x64 && g1 === 0xff9b && groups.slice(2, 6).every(part => part === 0)) {
    return isBlockedEmbeddedIpv4(g6, g7); // 64:ff9b::/96 NAT64
  }
  if (groups.slice(0, 6).every(part => part === 0)) {
    return isBlockedEmbeddedIpv4(g6, g7); // ::/96 IPv4-compatible (:: and ::1 handled above)
  }
  if (g0 === 0x2002) {
    return isBlockedEmbeddedIpv4(g1, g2); // 2002::/16 6to4 (embedded v4 in bits 16-48)
  }

  return false;
}
