import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { createHostCountryDownload, CountryDownloadRequestError, COUNTRY_EXPORT_TEXT_BYTES, COUNTRY_EXPORT_REQUEST_BYTES } from '../src/utils/country-text-download';

const capability = { protocolVersion: '2026-01-26', hostCapabilities: { downloadFile: {} } };
const artifact = { filename: 'country-evidence-CA-2026-10-06.md', mimeType: 'text/markdown;charset=utf-8' as const, content: 'Canada\nSource: USGS\nObservation: unknown\nRetained: 2026-10-06T05:57:35Z\n' };
test('absent, malformed and incompatible capability sends no speculative host request', async () => {
  let calls = 0;
  for (const initialized of [undefined, null, [], {}, { protocolVersion: '2026-01-26' }, { ...capability, protocolVersion: 'other' }, ...[null, true, [], 'yes', 1].map(downloadFile => ({ ...capability, hostCapabilities: { downloadFile } }))]) {
    const deliver = createHostCountryDownload(() => initialized, async () => { calls++; return {}; });
    assert.deepEqual(await deliver(artifact, new AbortController().signal), { state: 'unsupported' });
  }
  assert.equal(calls, 0);
});
test('advertised inline text preserves filename, MIME, provenance and exact snapshot bytes', async () => {
  const calls: unknown[] = [];
  const deliver = createHostCountryDownload(() => capability, async (method, params) => { calls.push({ method, params }); return {}; });
  assert.deepEqual(await deliver(artifact, new AbortController().signal), { state: 'host-accepted' });
  assert.deepEqual(calls, [{ method: 'ui/download-file', params: { contents: [{ type: 'resource', resource: { uri: `file:///${artifact.filename}`, mimeType: artifact.mimeType, text: artifact.content } }] } }]);
  assert.equal(/receipt|token|arguments|resource_link/.test(JSON.stringify(calls)), false);
});
test('returned denial, malformed result, RPC error, timeout and closure have truthful outcomes without retries', async () => {
  for (const [value, state] of [[{}, 'host-accepted'], [{ isError: false }, 'host-accepted'], [{ isError: true }, 'error'], [undefined, 'unconfirmed'], [null, 'unconfirmed'], [[], 'unconfirmed'], [{ isError: 'false' }, 'unconfirmed'], [true, 'unconfirmed']] as const) {
    let calls = 0;
    const deliver = createHostCountryDownload(() => capability, async () => { calls++; return value; });
    assert.deepEqual(await deliver(artifact, new AbortController().signal), { state }); assert.equal(calls, 1);
  }
  for (const [kind, state] of [['rpc', 'error'], ['timeout', 'unconfirmed'], ['closed', 'unconfirmed']] as const) {
    let calls = 0;
    const deliver = createHostCountryDownload(() => capability, async () => { calls++; throw new CountryDownloadRequestError(kind); });
    assert.deepEqual(await deliver(artifact, new AbortController().signal), { state }); assert.equal(calls, 1);
  }
});
test('cancellation before send and while waiting never becomes accepted', async () => {
  const controller = new AbortController(); let calls = 0;
  const deliver = createHostCountryDownload(() => capability, async () => { calls++; controller.abort(); return {}; });
  assert.deepEqual(await deliver(artifact, controller.signal), { state: 'unconfirmed' }); assert.equal(calls, 1);
  assert.deepEqual(await deliver(artifact, controller.signal), { state: 'unconfirmed' }); assert.equal(calls, 1);
});
test('bounds UTF8 artifact and serialized request separately, without truncation or a host call', async () => {
  let calls = 0;
  const deliver = createHostCountryDownload(() => capability, async () => { calls++; return {}; });
  for (const changed of [{ ...artifact, filename: '../private.md' }, { ...artifact, content: '\uD800' }, { ...artifact, content: 'é'.repeat(COUNTRY_EXPORT_TEXT_BYTES / 2 + 1) }, { ...artifact, content: '\u0000'.repeat(COUNTRY_EXPORT_TEXT_BYTES / 2) }]) {
    assert.deepEqual(await deliver(changed, new AbortController().signal), { state: 'error' });
  }
  assert.equal(calls, 0);
  assert.deepEqual(await deliver({ ...artifact, content: 'a'.repeat(COUNTRY_EXPORT_TEXT_BYTES) }, new AbortController().signal), { state: 'host-accepted' });
});

test('actual bridge request lifecycle handles RPC rejection, malformed reply, timer, close and late reply', async () => {
  const source = readFileSync('src/plugin-country-main.ts', 'utf8');
  const request = source.slice(source.indexOf('  function request('), source.indexOf('  async function call('));
  const receive = source.slice(source.indexOf("    if (typeof message.id === 'number'"), source.indexOf("    if (message.method === 'ui/notifications/tool-input')"));
  const close = source.slice(source.indexOf('    for (const call of pending.values())'), source.indexOf('    pending.clear(); source.clearLoadedData();'));
  for (const outcome of ['rpc', 'malformed', 'timeout', 'closed', 'cancelled', 'accepted'] as const) {
    const messages: Array<{ id?: number; method: string; params: object }> = [];
    const timers: Array<() => void> = [];
    const harness = vm.runInNewContext(stripTypeScriptTypes(`
      const pending = new Map(); let nextId=1; const send=message=>messages.push(message);
      ${request}
      ({request, receive(message){${receive}}, close(){${close}pending.clear();}, pending})
    `, { mode: 'strip' }), { messages, timers, CountryDownloadRequestError, COUNTRY_EXPORT_REQUEST_BYTES, TextEncoder,
      setTimeout: (callback: () => void, ms: number) => { assert.equal(ms, 30000); timers.push(callback); return timers.length; }, clearTimeout: () => {} });
    const controller = new AbortController();
    const result = createHostCountryDownload(() => capability, harness.request)(artifact, controller.signal);
    assert.equal(messages[0]?.method, 'ui/download-file');
    if (outcome === 'rpc') harness.receive({ id: 1, error: { code: -32603, message: 'private host detail' } });
    if (outcome === 'malformed') harness.receive({ id: 1, result: null });
    if (outcome === 'timeout') timers[0]!();
    if (outcome === 'closed') harness.close();
    if (outcome === 'cancelled') controller.abort();
    if (outcome === 'accepted') harness.receive({ id: 1, result: {} });
    assert.deepEqual(await result, { state: outcome === 'accepted' ? 'host-accepted' : outcome === 'rpc' ? 'error' : 'unconfirmed' });
    assert.equal(harness.pending.size, 0);
    harness.receive({ id: 1, result: {} });
    assert.equal(messages.filter(message => message.method === 'ui/download-file').length, 1);
    if (outcome === 'cancelled') assert.equal(messages.filter(message => message.method === 'notifications/cancelled').length, 1);
    const sent = messages.length;
    await assert.rejects(harness.request('ui/download-file', { contents: ['x'.repeat(COUNTRY_EXPORT_REQUEST_BYTES)] }, new AbortController().signal), (error: unknown) => error instanceof CountryDownloadRequestError && error.kind === 'size');
    assert.equal(messages.length, sent); assert.equal(harness.pending.size, 0);
  }
});
