// Minimal service-worker sandbox for exercising public/push-handler.js.
//
// Extracted from tests/brief-web-push.test.mjs so the relay suite can drive the
// SAME handler the worker suite does. That cross-module reach is the point: the
// relay and the worker each own half of the push click-URL contract, and until
// one test fed one half's output into the other, the two could disagree in
// production while both suites stayed green — which is exactly how the apex/www
// duplicate-tab regression shipped.
//
// The origin is a PARAMETER, not a constant. The old sandbox hardcoded the apex
// (`worldmonitor.app`), an origin the service worker is never served from — the
// apex 301s, including for the worker script — so every same-origin assertion
// passed against a topology production does not have.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The host the primary dashboard is actually served from. */
export const PRIMARY_ORIGIN = 'https://www.worldmonitor.app';

/** A vertical-subdomain install. Serves the same build, its own worker, its own push origin. */
export const VERTICAL_ORIGIN = 'https://tech.worldmonitor.app';

/** Both origins that origin-sensitive behaviour must be proven against. */
export const SERVING_ORIGINS = [PRIMARY_ORIGIN, VERTICAL_ORIGIN];

export function readHandlerSource() {
  return readFileSync(resolve(__dirname, '../../public/push-handler.js'), 'utf-8');
}

/**
 * Build a fake `self` + `clients` pair and record what the handler asked for.
 *
 * @param {string} origin The origin serving the worker. Defaults to the primary host.
 */
export function makeSwSandbox(origin = PRIMARY_ORIGIN) {
  const listeners = new Map();
  const shown = [];
  const windowClients = [];
  let opened = null;

  const self = {
    location: { origin },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    registration: {
      showNotification(title, opts) {
        shown.push({ title, opts });
        return Promise.resolve();
      },
    },
  };
  const clients = {
    matchAll: async () => windowClients,
    openWindow: async (url) => { opened = url; return { url }; },
  };
  return {
    self, clients, shown, windowClients, origin,
    get opened() { return opened; },
    emit(name, event) {
      const fns = listeners.get(name) ?? [];
      for (const fn of fns) fn(event);
    },
  };
}

export function loadHandlerInto(sandbox, source = readHandlerSource()) {
  const ctx = vm.createContext({
    self: sandbox.self,
    clients: sandbox.clients,
    URL,
  });
  vm.runInContext(source, ctx);
}

export function pushEvent(payload) {
  const waits = [];
  return {
    data: payload === null ? null : {
      json() { return typeof payload === 'string' ? JSON.parse(payload) : payload; },
      text() { return typeof payload === 'string' ? payload : JSON.stringify(payload); },
    },
    waitUntil(p) { waits.push(p); },
    waits,
  };
}

export function notifClickEvent(data) {
  let closed = false;
  const waits = [];
  return {
    notification: {
      data,
      close() { closed = true; },
    },
    waitUntil(p) { waits.push(p); },
    get closed() { return closed; },
    waits,
  };
}

/**
 * Add a window client already open at `url` (default: the sandbox's own origin
 * root) and expose what the handler did to it.
 */
export function addWindowClient(box, url = `${box.origin}/`) {
  const record = { navigated: null, focused: false };
  box.windowClients.push({
    url,
    focus() { record.focused = true; return this; },
    navigate(target) { record.navigated = target; return Promise.resolve(); },
  });
  return record;
}

/** Fire a notificationclick and wait for everything the handler registered. */
export async function clickNotification(box, data) {
  const ev = notifClickEvent(data);
  box.emit('notificationclick', ev);
  await Promise.all(ev.waits);
  return ev;
}
