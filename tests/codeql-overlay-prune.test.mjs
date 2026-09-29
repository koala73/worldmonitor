import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, pruneOverlayBases, selectStaleOverlayBases } from '../.github/scripts/prune-codeql-overlay-bases.mjs';

const REF = 'refs/heads/main';
const SHA_A = '24077eb00d97c7f0aa4a6891b6898052eccca6aa';
const SHA_B = '176db4f43aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const JS_HASH = '673738e94a8102ad';
const RUBY_HASH = 'a995aa4f0b162902';

let nextId = 1;
function base({ hash = JS_HASH, langs = 'javascript', cli = '2.27.1', sha = SHA_A, runId = 36543343381, attempt = 1, createdAt, ref = REF, size = 1_300_000_000 }) {
  return {
    id: nextId++,
    key: `codeql-overlay-base-database-1-${hash}-${langs}-${cli}-${sha}-${runId}-${attempt}`,
    ref,
    createdAt,
    sizeInBytes: size,
  };
}
const ids = entries => entries.map(entry => entry.id).sort((a, b) => a - b);

test('keeps the newest base in a group and marks older ones stale', () => {
  const old = base({ createdAt: '2026-09-27T03:40:00Z', runId: 100 });
  const mid = base({ createdAt: '2026-09-28T03:40:00Z', runId: 200, sha: SHA_B });
  const newest = base({ createdAt: '2026-09-29T03:40:00Z', runId: 300 });
  const result = selectStaleOverlayBases([mid, newest, old], REF);
  assert.deepEqual(ids(result.keep), [newest.id]);
  assert.deepEqual(ids(result.stale), ids([old, mid]));
  assert.deepEqual(result.ignored, []);
});

test('groups by job hash and by language set independently', () => {
  const jsOld = base({ createdAt: '2026-09-27T03:40:00Z', runId: 100 });
  const jsNew = base({ createdAt: '2026-09-28T03:40:00Z', runId: 200 });
  const ruby = base({ hash: RUBY_HASH, langs: 'ruby', createdAt: '2026-09-20T03:40:00Z', runId: 50 });
  const otherJob = base({ hash: 'ffffffffffffffff', createdAt: '2026-09-21T03:40:00Z', runId: 60 });
  const multiLang = base({ langs: 'javascript_python', createdAt: '2026-09-22T03:40:00Z', runId: 70 });
  const result = selectStaleOverlayBases([jsOld, jsNew, ruby, otherJob, multiLang], REF);
  assert.deepEqual(ids(result.keep), ids([jsNew, ruby, otherJob, multiLang]));
  assert.deepEqual(ids(result.stale), [jsOld.id]);
});

test('an older-CLI base is stale once a newer-CLI base exists in the same group', () => {
  const oldCli = base({ cli: '2.27.1', createdAt: '2026-09-27T03:40:00Z', runId: 100 });
  const newCli = base({ cli: '2.28.0', createdAt: '2026-09-28T03:40:00Z', runId: 200 });
  const result = selectStaleOverlayBases([oldCli, newCli], REF);
  assert.deepEqual(ids(result.keep), [newCli.id]);
  assert.deepEqual(ids(result.stale), [oldCli.id]);
});

test('createdAt ties break on numeric runId, then on attempt', () => {
  const at = '2026-09-28T03:40:00Z';
  const lowRun = base({ createdAt: at, runId: 99999999999 });
  const highRun = base({ createdAt: at, runId: 100000000000 });
  assert.deepEqual(ids(selectStaleOverlayBases([highRun, lowRun], REF).keep), [highRun.id]);
  const firstAttempt = base({ createdAt: at, runId: 5, attempt: 2 });
  const retry = base({ createdAt: at, runId: 5, attempt: 10 });
  const result = selectStaleOverlayBases([retry, firstAttempt], REF);
  assert.deepEqual(ids(result.keep), [retry.id]);
  assert.deepEqual(ids(result.stale), [firstAttempt.id]);
});

test('unparseable keys are never deleted and are reported as ignored', () => {
  const good = base({ createdAt: '2026-09-28T03:40:00Z' });
  const odd = [
    { id: nextId++, key: 'codeql-overlay-base-database-1-673738e94a8102ad-javascript', ref: REF, createdAt: '2026-01-01T00:00:00Z', sizeInBytes: 1 },
    { id: nextId++, key: `codeql-overlay-base-database-2-XYZ-javascript-2.27.1-${SHA_A}-1-1`, ref: REF, createdAt: '2026-01-01T00:00:00Z', sizeInBytes: 1 },
    { id: nextId++, key: `codeql-overlay-base-database-1-${JS_HASH}-javascript-2.27.1-${SHA_A}-1-1-extra`, ref: REF, createdAt: '2026-01-01T00:00:00Z', sizeInBytes: 1 },
  ];
  const result = selectStaleOverlayBases([good, ...odd], REF);
  assert.deepEqual(ids(result.keep), [good.id]);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(ids(result.ignored), ids(odd));
});

test('entries on other refs are ignored, never deleted', () => {
  const main = base({ createdAt: '2026-09-28T03:40:00Z', runId: 200 });
  const prOlder = base({ createdAt: '2026-09-20T03:40:00Z', runId: 100, ref: 'refs/pull/8717/merge' });
  const result = selectStaleOverlayBases([main, prOlder], REF);
  assert.deepEqual(ids(result.keep), [main.id]);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(ids(result.ignored), [prOlder.id]);
});

test('an empty list is a no-op', () => {
  assert.deepEqual(selectStaleOverlayBases([], REF), { keep: [], stale: [], ignored: [] });
});

test('parseArgs requires --ref and reads --dry-run', () => {
  assert.deepEqual(parseArgs(['--ref', REF, '--dry-run']), { ref: REF, dryRun: true });
  assert.deepEqual(parseArgs(['--ref', REF]), { ref: REF, dryRun: false });
  assert.throws(() => parseArgs([]), /--ref/);
  assert.throws(() => parseArgs(['--ref']), /--ref/);
  assert.throws(() => parseArgs(['--ref', REF, '--force']), /--force/);
});

function fakeGh(entries, deleteResults) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    assert.equal(cmd, 'gh');
    if (args[0] === 'cache' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(entries), stderr: '' };
    if (args[0] === 'cache' && args[1] === 'delete') return deleteResults[args[2]] ?? { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { run, calls };
}

test('runner deletes only stale ids, treats not-found as done, and fails after attempting every delete', () => {
  const keep = base({ createdAt: '2026-09-29T03:40:00Z', runId: 400, size: 10 });
  const gone = base({ createdAt: '2026-09-26T03:40:00Z', runId: 100, size: 3 });
  const broken = base({ createdAt: '2026-09-27T03:40:00Z', runId: 200, size: 5 });
  const ok = base({ createdAt: '2026-09-28T03:40:00Z', runId: 300, size: 7 });
  const unparsed = { id: nextId++, key: 'codeql-overlay-base-database-garbage', ref: REF, createdAt: '2026-01-01T00:00:00Z', sizeInBytes: 1 };
  const { run, calls } = fakeGh([keep, gone, broken, ok, unparsed], {
    [gone.id]: { status: 1, stdout: '', stderr: `X Could not find a cache matching ${gone.id} in koala73/worldmonitor\n` },
    [broken.id]: { status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration\n' },
  });
  const lines = [];
  const result = pruneOverlayBases({ ref: REF, run, log: line => lines.push(line) });

  const listCall = calls.find(call => call[2] === 'list');
  assert.deepEqual(listCall, ['gh', 'cache', 'list', '--ref', REF, '--key', 'codeql-overlay-base-database-', '--limit', '1000', '--json', 'id,key,ref,createdAt,sizeInBytes']);
  const deleted = calls.filter(call => call[2] === 'delete').map(call => Number(call[3])).sort((a, b) => a - b);
  assert.deepEqual(deleted, ids([gone, broken, ok]));
  assert.equal(result.exitCode, 1);
  assert.equal(result.kept, 1);
  assert.equal(result.deleted, 2);
  assert.equal(result.freed, 3 + 7);
  assert.ok(lines.some(line => line.includes(String(broken.id)) && /403/.test(line)), lines.join('\n'));
  assert.match(lines.at(-1), /kept 1, deleted 2, freed 10 bytes/);
});

test('runner succeeds when every stale delete lands, and dry-run deletes nothing', () => {
  const keep = base({ createdAt: '2026-09-29T03:40:00Z', runId: 400 });
  const stale = base({ createdAt: '2026-09-28T03:40:00Z', runId: 300, size: 42 });
  const live = fakeGh([keep, stale], {});
  assert.equal(pruneOverlayBases({ ref: REF, run: live.run, log() {} }).exitCode, 0);

  const dry = fakeGh([keep, stale], {});
  const lines = [];
  const result = pruneOverlayBases({ ref: REF, dryRun: true, run: dry.run, log: line => lines.push(line) });
  assert.equal(result.exitCode, 0);
  assert.equal(dry.calls.filter(call => call[2] === 'delete').length, 0);
  assert.ok(lines.some(line => line.includes(String(stale.id))));
  assert.match(lines.at(-1), /dry run/);
});

test('a delete that fails to spawn counts as that entry failing, and later deletes still run', () => {
  const keep = base({ createdAt: '2026-09-29T03:40:00Z', runId: 400 });
  const unspawnable = base({ createdAt: '2026-09-27T03:40:00Z', runId: 200, size: 5 });
  const later = base({ createdAt: '2026-09-28T03:40:00Z', runId: 300, size: 7 });
  const { run, calls } = fakeGh([keep, unspawnable, later], {
    [unspawnable.id]: { error: Object.assign(new Error('spawnSync gh EAGAIN'), { code: 'EAGAIN' }) },
  });
  const lines = [];
  const result = pruneOverlayBases({ ref: REF, run, log: line => lines.push(line) });
  assert.deepEqual(ids(calls.filter(call => call[2] === 'delete').map(call => ({ id: Number(call[3]) }))), ids([unspawnable, later]));
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.exitCode, 1);
  assert.ok(lines.some(line => line.includes(String(unspawnable.id)) && /EAGAIN/.test(line)), lines.join('\n'));
});

test('runner annotates keys it cannot parse, so a key-format change cannot silently stop pruning', () => {
  const unparsed = { id: nextId++, key: 'codeql-overlay-base-database-2-673738e94a8102ad-javascript-2.28.0-rc1-x-1-1', ref: REF, createdAt: '2026-09-29T00:00:00Z', sizeInBytes: 1 };
  const { run } = fakeGh([unparsed], {});
  const lines = [];
  pruneOverlayBases({ ref: REF, run, log: line => lines.push(line) });
  assert.ok(lines.some(line => line.startsWith('::warning') && line.includes(unparsed.key)), lines.join('\n'));
});

test('runner fails when the cache listing fails', () => {
  const run = () => ({ status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' });
  assert.throws(() => pruneOverlayBases({ ref: REF, run, log() {} }), /401/);
});
