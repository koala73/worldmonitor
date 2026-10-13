// `/oref/alerts` and `/oref/history` are unauthenticated and serialize
// orefState.lastError. A curl failure's message is the full command line,
// which carries `-x http://user:pass@host:port`, so the relay must publish a
// fixed summary and keep the (redacted) detail in its log. The relay has no
// module exports, so this pins the source and exercises the redactor's regex.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in the relay`);
  const end = src.indexOf('\n}\n', start);
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end + 2)}; return ${name};`)();
}

test('poll failures publish a fixed summary, never the curl argv', () => {
  const assignments = [...src.matchAll(/orefState\.lastError = ([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(assignments.length >= 3, 'expected the poll-site assignments to still exist');
  for (const rhs of assignments) {
    assert.ok(
      rhs === 'null'
        || rhs.startsWith('orefPollFailure(')
        || rhs === "orefState.lastError || 'All siren sources unavailable'",
      `orefState.lastError must not be derived from an error message: ${rhs}`,
    );
  }
  assert.doesNotMatch(src, /orefState\.lastError = redactOrefError\(/);
});

test('orefPollFailure returns the public constant and logs the redacted detail', () => {
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    const redactOrefError = extractFunction('redactOrefError');
    const factory = new Function(
      'redactOrefError',
      `const OREF_PUBLIC_POLL_ERROR = 'OREF upstream fetch failed';
       ${src.slice(src.indexOf('function orefPollFailure('), src.indexOf('\n}\n', src.indexOf('function orefPollFailure(')) + 2)}
       return orefPollFailure;`,
    );
    const orefPollFailure = factory(redactOrefError);
    const credential = 'user:pa/ss wd';
    const err = Object.assign(new Error(`Command failed: curl -sS -x http://${credential}@proxy.example:9000 https://www.oref.org.il/x`), {
      stderr: Buffer.from(''),
    });

    const publicText = orefPollFailure('OREF poll error', err, credential);
    assert.equal(publicText, 'OREF upstream fetch failed');
    assert.equal(warned.length, 1);
    assert.doesNotMatch(warned[0], /pa\/ss|ss wd|user:/);
    assert.match(warned[0], /<redacted>@proxy\.example:9000/);
  } finally {
    console.warn = original;
  }
});

test('every relay call site passes the configured credential to the redactor', () => {
  const calls = [...src.matchAll(/(?<!function )(?:orefPollFailure|redactOrefError)\(([^;]*)\);/g)]
    .map((m) => m[1])
    .filter((args) => !args.startsWith('stderr || err?.message')); // the helper's own inner call forwards its parameter
  assert.ok(calls.length >= 3, `expected the three call sites, found ${calls.length}`);
  for (const args of calls) {
    assert.match(args, /,\s*OREF_PROXY_CREDENTIAL$/, `call must pass OREF_PROXY_CREDENTIAL: ${args}`);
  }
});

test('redactOrefError drops the literal configured credential, whatever characters it holds', () => {
  const redactOrefError = extractFunction('redactOrefError');
  const credential = 'user:pa/ss;il;;;@wd';
  assert.equal(
    redactOrefError(`curl: (7) via http://${credential}@proxy.example:9000/ failed`, credential),
    'curl: (7) via http://<redacted>@proxy.example:9000/ failed',
  );
});

test('redactOrefError still strips a pattern-shaped credential it was not configured with', () => {
  const redactOrefError = extractFunction('redactOrefError');
  assert.equal(
    redactOrefError('curl: (7) via http://user:p@ss;il;;;@proxy.example:9000/ failed', ''),
    'curl: (7) via http://<redacted>@proxy.example:9000/ failed',
  );
  assert.equal(redactOrefError('plain message without a proxy', ''), 'plain message without a proxy');
  assert.equal(redactOrefError(undefined, ''), '');
});

test('OREF_PROXY_CREDENTIAL is the user:pass part of OREF_PROXY_AUTH in either accepted form', () => {
  const block = src.slice(src.indexOf('const OREF_PROXY_CREDENTIAL = '), src.indexOf('})();', src.indexOf('const OREF_PROXY_CREDENTIAL = ')) + 5);
  const derive = (auth) => new Function('OREF_PROXY_AUTH', `${block}; return OREF_PROXY_CREDENTIAL;`)(auth);
  assert.equal(derive('user:pa/ss@wd@proxy.example:9000'), 'user:pa/ss@wd');
  assert.equal(derive('http://user:pass@proxy.example:9000'), 'user:pass');
  assert.equal(derive(''), '');
  assert.equal(derive('proxy.example:9000'), '');
});
