// Transport proof for the AISStream watchdog's central design choice:
// teardown must be ws.terminate(), never a graceful close().
//
// This is the assumption the reverted watchdog got wrong. It is pinned here
// against a real black-hole peer — a server that completes the websocket
// handshake and then never speaks again, which is exactly how AISStream fails
// (upstream: handshake succeeds, no frames, no error, no close). Everything
// runs on an ephemeral localhost port; no network access is involved.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import WebSocketImpl from 'ws';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * A websocket peer that upgrades the connection and then goes silent forever.
 * It never sends frames and never answers a close frame, so a graceful close
 * handshake can never complete.
 */
function startBlackHoleServer() {
  let liveConnections = 0;
  /** Every accepted socket, so teardown can destroy the wedged ones. */
  const accepted = new Set();
  const server = net.createServer((socket) => {
    liveConnections += 1;
    accepted.add(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      if (!buffer.includes('\r\n\r\n')) return;
      const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(buffer)?.[1]?.trim();
      if (!key) return;
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      buffer = '';
      // ...and then nothing, ever. Incoming CLOSE frames are ignored.
    });
    socket.on('close', () => {
      liveConnections -= 1;
      accepted.delete(socket);
    });
    socket.on('error', () => {});
  });

  return {
    server,
    listen: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(`ws://127.0.0.1:${server.address().port}`));
    }),
    get liveConnections() { return liveConnections; },
    close: () => new Promise((resolve) => {
      // A socket this suite deliberately wedged in CLOSING keeps the event loop
      // alive forever; server.close() only stops new accepts, so the wedged
      // connections have to be destroyed by hand.
      for (const socket of [...accepted]) socket.destroy();
      accepted.clear();
      server.close(() => resolve());
    }),
  };
}

/** Resolve to true if `event` fires on `emitter` within `ms`. */
function firedWithin(subscribe, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    subscribe(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const blackHole = startBlackHoleServer();
const url = await blackHole.listen();
after(() => blackHole.close());

test('ws.terminate() hard-aborts a black-holed socket and frees the connection slot', async () => {
  const socket = new WebSocketImpl(url);
  await new Promise((resolve) => socket.once('open', resolve));
  assert.equal(socket.readyState, WebSocketImpl.OPEN);
  assert.equal(typeof socket.terminate, 'function', 'the adapter depends on terminate()');
  assert.equal(blackHole.liveConnections, 1);

  const closed = firedWithin((done) => socket.once('close', done), 1_000);
  const startedAt = Date.now();
  socket.terminate();

  assert.equal(await closed, true, 'terminate() must complete against a silent peer');
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(socket.readyState, WebSocketImpl.CLOSED);

  // The TCP connection is genuinely gone — this is what protects AISStream's
  // one-connection-per-key limit when the watchdog recycles.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(blackHole.liveConnections, 0, 'the socket slot must actually be released');
});

test('the built-in WebSocket close() never completes on a black-holed socket', async () => {
  // This is the regression that wedged the reverted watchdog: Node's global
  // WebSocket exposes no terminate(), and close() waits for a close frame the
  // dead peer will never send. If a future Node release fixes this, the
  // assertion below fails loudly and the design can be revisited.
  assert.equal(typeof WebSocket, 'function');
  assert.equal(
    typeof (new WebSocket(url)).terminate, 'undefined',
    'built-in WebSocket has no hard-abort; that is why ws is a dependency',
  );

  const socket = new WebSocket(url);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  assert.equal(socket.readyState, WebSocket.OPEN);

  const closed = firedWithin(
    (done) => socket.addEventListener('close', done, { once: true }),
    1_500,
  );
  socket.close(1000, 'watchdog recycle');
  assert.equal(socket.readyState, WebSocket.CLOSING);

  assert.equal(await closed, false, 'close() hangs in CLOSING — measured well past 30s by hand');
  assert.equal(socket.readyState, WebSocket.CLOSING, 'the socket slot is never handed back');
});

test('a terminated socket hands the single connection slot straight to its replacement', async () => {
  const first = new WebSocketImpl(url);
  await new Promise((resolve) => first.once('open', resolve));
  first.terminate();
  await new Promise((resolve) => first.once('close', resolve));

  // The watchdog's reconnect happens right here; it must not be refused.
  const second = new WebSocketImpl(url);
  await new Promise((resolve) => second.once('open', resolve));
  assert.equal(second.readyState, WebSocketImpl.OPEN);

  second.terminate();
  await new Promise((resolve) => second.once('close', resolve));
});
