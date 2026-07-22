import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Importing the sidecar module installs its patched globalThis.fetch.
import { __testing__ } from '../src-tauri/sidecar/local-api-server.mjs';

const { registerSidecarAllowedPrivateFetchOrigins, MAX_CONCURRENT_UPSTREAM } = __testing__;

// Regression test for #5441: an upstream that sends headers and then stalls or
// truncates mid-body must REJECT the wrapped fetch (releasing its semaphore
// slot), never leave the Promise pending. Pre-fix, each such response leaked
// one of the MAX_CONCURRENT_UPSTREAM slots until every data fetch wedged.
describe('sidecar fetch semaphore', () => {
  let server;
  let port;
  let unregister;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/stall') {
        // Headers + partial body, then kill the socket: 'end' never fires.
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
        res.write('partial');
        setTimeout(() => res.socket.destroy(), 25);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    unregister = registerSidecarAllowedPrivateFetchOrigins(port);
  });

  after(async () => {
    unregister?.();
    await new Promise((resolve) => server.close(resolve));
  });

  it('rejects stalled/truncated responses instead of hanging, and releases every slot', async () => {
    const stalled = Array.from({ length: MAX_CONCURRENT_UPSTREAM + 1 }, () =>
      fetch(`http://127.0.0.1:${port}/stall`).then(
        () => 'resolved',
        () => 'rejected',
      ),
    );

    // Pre-fix these promises never settle; race a watchdog so the test fails
    // fast and explicitly instead of timing out.
    const outcome = await Promise.race([
      Promise.all(stalled),
      new Promise((resolve) => setTimeout(() => resolve('WEDGED'), 8000)),
    ]);

    assert.notEqual(outcome, 'WEDGED', 'stalled upstream responses left fetches pending (semaphore leak)');
    for (const result of outcome) assert.equal(result, 'rejected');

    // All slots must be free again: a healthy fetch goes straight through.
    const healthy = await Promise.race([
      fetch(`http://127.0.0.1:${port}/ok`),
      new Promise((resolve) => setTimeout(() => resolve('WEDGED'), 4000)),
    ]);
    assert.notEqual(healthy, 'WEDGED', 'healthy fetch blocked: semaphore slots were not released');
    assert.equal(healthy.status, 200);
    assert.equal(await healthy.text(), 'ok');
  });
});
