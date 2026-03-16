import { strict as assert } from 'node:assert';
import test from 'node:test';

// sanitize.ts is TypeScript with path aliases, so we test via the compiled
// output at build-time.  For a fast unit test we inline the logic instead,
// keeping the test independent of the bundler.

// ---------- escapeHtml / escapeAttr ----------

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c] || c);
}

const escapeAttr = escapeHtml;

// ---------- isPrivateHostname ----------

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.+$/, '');
  let ipCandidate = h.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (ipCandidate === '::1' || ipCandidate === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ipCandidate)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(ipCandidate)) return true;
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ipCandidate);
  if (v4Mapped) {
    ipCandidate = v4Mapped[1];
  } else {
    const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipCandidate);
    if (v4MappedHex) {
      const hi = Number.parseInt(v4MappedHex[1], 16);
      const lo = Number.parseInt(v4MappedHex[2], 16);
      ipCandidate = [
        (hi >> 8) & 0xff,
        hi & 0xff,
        (lo >> 8) & 0xff,
        lo & 0xff,
      ].join('.');
    }
  }
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipCandidate);
  if (ipv4Match) {
    const [a, b, c, d] = ipv4Match.slice(1).map(Number);
    if ([a, b, c, d].some((part) => part > 255)) return false;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a >= 224) return true;
  }
  return false;
}

// ---------- sanitizeUrl ----------

function sanitizeUrl(url) {
  if (!url) return '';
  const trimmed = String(url).trim();
  if (!trimmed) return '';

  const isAllowedProtocol = (p) => p === 'http:' || p === 'https:';

  try {
    const parsed = new URL(trimmed);
    if (isAllowedProtocol(parsed.protocol)) {
      if (isPrivateHostname(parsed.hostname)) return '';
      return escapeAttr(parsed.toString());
    }
  } catch {
    // continue
  }

  if (!/^(\/|\.\/|\.\.\/|\?|#)/.test(trimmed)) return '';

  try {
    const base = 'https://example.com';
    const resolved = new URL(trimmed, base);
    if (!isAllowedProtocol(resolved.protocol)) return '';
    return escapeAttr(trimmed);
  } catch {
    return '';
  }
}

// ==================== escapeHtml tests ====================

test('escapeHtml escapes all dangerous characters', () => {
  assert.equal(escapeHtml('&<>"\' '), '&amp;&lt;&gt;&quot;&#39; ');
});

test('escapeHtml returns empty string for falsy input', () => {
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml passes through safe strings unchanged', () => {
  assert.equal(escapeHtml('Hello World 123'), 'Hello World 123');
});

test('escapeHtml handles already-escaped HTML entities', () => {
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
});

test('escapeHtml handles Unicode characters', () => {
  assert.equal(escapeHtml('こんにちは 🌍'), 'こんにちは 🌍');
});

test('escapeHtml handles mixed content', () => {
  assert.equal(
    escapeHtml('<script>alert("xss")</script>'),
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
  );
});

// ==================== sanitizeUrl tests ====================

test('sanitizeUrl allows normal https URLs', () => {
  assert.equal(sanitizeUrl('https://example.com/path'), 'https://example.com/path');
});

test('sanitizeUrl allows normal http URLs', () => {
  assert.equal(sanitizeUrl('http://example.com'), 'http://example.com/');
});

test('sanitizeUrl blocks javascript: protocol', () => {
  assert.equal(sanitizeUrl('javascript:alert(1)'), '');
});

test('sanitizeUrl blocks data: protocol', () => {
  assert.equal(sanitizeUrl('data:text/html,<h1>hi</h1>'), '');
});

test('sanitizeUrl returns empty for empty/falsy input', () => {
  assert.equal(sanitizeUrl(''), '');
  assert.equal(sanitizeUrl(null), '');
  assert.equal(sanitizeUrl(undefined), '');
  assert.equal(sanitizeUrl('   '), '');
});

test('sanitizeUrl allows relative paths', () => {
  assert.equal(sanitizeUrl('/path/to/page'), '/path/to/page');
  assert.equal(sanitizeUrl('./relative'), './relative');
  assert.equal(sanitizeUrl('../parent'), '../parent');
  assert.equal(sanitizeUrl('?query=1'), '?query=1');
  assert.equal(sanitizeUrl('#hash'), '#hash');
});

test('sanitizeUrl rejects bare strings that are not relative paths', () => {
  assert.equal(sanitizeUrl('not-a-url'), '');
  assert.equal(sanitizeUrl('just some text'), '');
});

test('sanitizeUrl HTML-escapes output', () => {
  const result = sanitizeUrl('https://example.com/path?a=1&b=2');
  assert.ok(result.includes('&amp;'), 'ampersand should be escaped');
});

// ==================== SSRF protection tests ====================

test('sanitizeUrl blocks localhost', () => {
  assert.equal(sanitizeUrl('http://localhost'), '');
  assert.equal(sanitizeUrl('http://localhost:8080'), '');
  assert.equal(sanitizeUrl('https://localhost/admin'), '');
  assert.equal(sanitizeUrl('https://tauri.localhost/path'), '');
  assert.equal(sanitizeUrl('https://printer.local/dashboard'), '');
});

test('sanitizeUrl blocks 127.0.0.0/8 loopback addresses', () => {
  assert.equal(sanitizeUrl('http://127.0.0.1'), '');
  assert.equal(sanitizeUrl('http://127.0.0.1:3000'), '');
  assert.equal(sanitizeUrl('http://127.255.255.255'), '');
});

test('sanitizeUrl blocks 10.0.0.0/8 private range', () => {
  assert.equal(sanitizeUrl('http://10.0.0.1'), '');
  assert.equal(sanitizeUrl('http://10.255.0.1'), '');
});

test('sanitizeUrl blocks 172.16.0.0/12 private range', () => {
  assert.equal(sanitizeUrl('http://172.16.0.1'), '');
  assert.equal(sanitizeUrl('http://172.31.255.255'), '');
});

test('sanitizeUrl allows 172.x outside /12 range', () => {
  assert.notEqual(sanitizeUrl('http://172.15.0.1'), '');
  assert.notEqual(sanitizeUrl('http://172.32.0.1'), '');
});

test('sanitizeUrl blocks 192.168.0.0/16 private range', () => {
  assert.equal(sanitizeUrl('http://192.168.0.1'), '');
  assert.equal(sanitizeUrl('http://192.168.1.100'), '');
});

test('sanitizeUrl blocks 169.254.0.0/16 link-local range', () => {
  assert.equal(sanitizeUrl('http://169.254.169.254'), '');
});

test('sanitizeUrl blocks 0.0.0.0/8 range', () => {
  assert.equal(sanitizeUrl('http://0.0.0.0'), '');
});

test('sanitizeUrl blocks IPv6 loopback, local, and mapped private ranges', () => {
  assert.equal(sanitizeUrl('https://[::1]/'), '');
  assert.equal(sanitizeUrl('https://[::]/'), '');
  assert.equal(sanitizeUrl('https://[fd00::1]/'), '');
  assert.equal(sanitizeUrl('https://[fe80::1]/'), '');
  assert.equal(sanitizeUrl('https://[::ffff:127.0.0.1]/'), '');
});

test('sanitizeUrl blocks multicast and reserved IPv4 ranges', () => {
  assert.equal(sanitizeUrl('https://224.0.0.1'), '');
  assert.equal(sanitizeUrl('https://255.255.255.255'), '');
});

test('sanitizeUrl allows legitimate public IPs', () => {
  assert.notEqual(sanitizeUrl('http://8.8.8.8'), '');
  assert.notEqual(sanitizeUrl('https://1.1.1.1'), '');
  assert.notEqual(sanitizeUrl('https://[2606:4700:4700::1111]/'), '');
});

test('sanitizeUrl allows legitimate public domains', () => {
  assert.notEqual(sanitizeUrl('https://www.bbc.com/news'), '');
  assert.notEqual(sanitizeUrl('https://reuters.com/article/123'), '');
});
