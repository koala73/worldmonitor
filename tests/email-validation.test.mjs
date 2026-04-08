import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch globally for MX record checks so tests don't hit real DNS
const originalFetch = globalThis.fetch;

function mockFetch(mxResponse) {
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('cloudflare-dns.com')) {
      return { ok: true, json: async () => mxResponse };
    }
    return originalFetch(url);
  };
}

// Import after fetch is available (module is Edge-compatible, no node: imports)
const { validateEmail } = await import('../api/_email-validation.js');

describe('validateEmail', () => {
  beforeEach(() => {
    // Default: pretend every domain has MX records
    mockFetch({ Answer: [{ type: 15, data: '10 mx.example.com.' }] });
  });

  it('accepts a valid gmail address', async () => {
    const result = await validateEmail('user@gmail.com');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts addresses with unusual but valid TLDs', async () => {
    const result = await validateEmail('user@company.photography');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('rejects disposable domain (guerrillamail)', async () => {
    const result = await validateEmail('test@guerrillamail.com');
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('Disposable'));
  });

  it('rejects disposable domain (yopmail)', async () => {
    const result = await validateEmail('test@yopmail.com');
    assert.strictEqual(result.valid, false);
  });

  it('rejects disposable domain (passmail.net)', async () => {
    const result = await validateEmail('worldmonitor.foo@passmail.net');
    assert.strictEqual(result.valid, false);
  });

  it('rejects offensive local part containing slur', async () => {
    const result = await validateEmail('ihateniggers@gmail.com');
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'Email address not accepted');
  });

  it('rejects offensive compound word in local part', async () => {
    const result = await validateEmail('fuckfaggot@example.com');
    assert.strictEqual(result.valid, false);
  });

  it('rejects offensive domain', async () => {
    const result = await validateEmail('user@nigger.edu');
    assert.strictEqual(result.valid, false);
  });

  it('rejects typo TLD .con', async () => {
    const result = await validateEmail('user@gmail.con');
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('typo'));
  });

  it('rejects typo TLD .coma', async () => {
    const result = await validateEmail('user@gmail.coma');
    assert.strictEqual(result.valid, false);
  });

  it('rejects typo TLD .comhade', async () => {
    const result = await validateEmail('alishakertube55.net@gmail.comhade');
    assert.strictEqual(result.valid, false);
  });

  it('rejects domain with no MX records', async () => {
    mockFetch({ Status: 0 }); // no Answer array
    const result = await validateEmail('user@nonexistent-domain-xyz.com');
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('does not accept mail'));
  });

  it('fails open when DNS lookup errors', async () => {
    globalThis.fetch = async () => { throw new Error('network error'); };
    const result = await validateEmail('user@flaky-dns.com');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('fails open when DNS returns non-OK status', async () => {
    globalThis.fetch = async () => ({ ok: false });
    const result = await validateEmail('user@whatever.com');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('rejects email with no @ sign', async () => {
    const result = await validateEmail('invalidemail');
    assert.strictEqual(result.valid, false);
  });

  it('rejects email with nothing before @', async () => {
    const result = await validateEmail('@gmail.com');
    assert.strictEqual(result.valid, false);
  });

  it('is case-insensitive for disposable domains', async () => {
    const result = await validateEmail('test@GUERRILLAMAIL.COM');
    assert.strictEqual(result.valid, false);
  });

  it('allows duck.com (privacy relay, not disposable)', async () => {
    const result = await validateEmail('user@duck.com');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('allows simplelogin.com (privacy relay, not disposable)', async () => {
    const result = await validateEmail('alias@simplelogin.com');
    assert.deepStrictEqual(result, { valid: true });
  });
});

// ── CSV parser tests ─────────────────────────────────────────────────────────
// Extract parseCsvLine by reading the script source and evaluating just the function.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptSrc = readFileSync(resolve(__dirname, '../scripts/import-bounced-emails.mjs'), 'utf-8');

// Extract the parseCsvLine function body from the script
const fnStart = scriptSrc.indexOf('function parseCsvLine(line)');
const fnBodyStart = scriptSrc.indexOf('{', fnStart);
let braceDepth = 0;
let fnEnd = fnBodyStart;
for (let i = fnBodyStart; i < scriptSrc.length; i++) {
  if (scriptSrc[i] === '{') braceDepth++;
  if (scriptSrc[i] === '}') braceDepth--;
  if (braceDepth === 0) { fnEnd = i + 1; break; }
}
const fnSource = scriptSrc.slice(fnStart, fnEnd);
const parseCsvLine = new Function('line', fnSource.replace('function parseCsvLine(line)', 'return (function(line)') + ')(line)');

describe('parseCsvLine (RFC 4180)', () => {
  it('parses simple comma-separated fields', () => {
    const result = parseCsvLine('a,b,c');
    assert.deepStrictEqual(result, ['a', 'b', 'c']);
  });

  it('parses fields with quoted commas', () => {
    const result = parseCsvLine('id,"Hello, World",value');
    assert.deepStrictEqual(result, ['id', 'Hello, World', 'value']);
  });

  it('handles escaped quotes inside quoted fields', () => {
    const result = parseCsvLine('"she said ""hi""",normal');
    assert.deepStrictEqual(result, ['she said "hi"', 'normal']);
  });

  it('handles empty fields', () => {
    const result = parseCsvLine('a,,c,,e');
    assert.deepStrictEqual(result, ['a', '', 'c', '', 'e']);
  });

  it('parses the Resend CSV header correctly', () => {
    const header = 'id,created_at,subject,from,to,cc,bcc,reply_to,last_event,sent_at,scheduled_at,api_key_id';
    const fields = parseCsvLine(header);
    assert.strictEqual(fields.length, 12);
    assert.strictEqual(fields[4], 'to');
    assert.strictEqual(fields[8], 'last_event');
  });

  it('parses a Resend data row with angle brackets in from field', () => {
    const row = 'abc-123,2026-03-10,You\'re on the Pro waitlist,World Monitor <noreply@worldmonitor.app>,test@gmail.com,,,,bounced,2026-03-10,,key-123';
    const fields = parseCsvLine(row);
    assert.strictEqual(fields[4], 'test@gmail.com');
    assert.strictEqual(fields[8], 'bounced');
  });

  it('handles quoted subject with comma', () => {
    const row = 'abc,"Subject, with comma","World Monitor <noreply@worldmonitor.app>",test@example.com,,,,bounced';
    const fields = parseCsvLine(row);
    assert.strictEqual(fields[1], 'Subject, with comma');
    assert.strictEqual(fields[7], 'bounced');
  });
});
