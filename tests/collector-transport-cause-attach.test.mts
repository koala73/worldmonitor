import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TRANSPORT_HREF = new URL('../src/services/analytics-collector-transport.ts', import.meta.url).href;

const _store = new Map<string, string>();
before(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => _store.get(k) ?? null,
        setItem: (k: string, v: string) => { _store.set(k, v); },
        removeItem: (k: string) => { _store.delete(k); },
      },
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    },
  });
});

const {
  CollectorTransportError,
  collectorFailureFromError,
} = await import('../src/services/analytics-collector-transport.ts');

function constructUnderNonExtensibleError(): { status: number | null; stdout: string; stderr: string } {
  const code = `
    const NativeError = Error;
    globalThis.Error = new Proxy(NativeError, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);
        Object.preventExtensions(instance);
        return instance;
      },
    });

    const store = new Map();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key) => store.get(key) ?? null,
          setItem: (key, value) => { store.set(key, value); },
          removeItem: (key) => { store.delete(key); },
        },
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      },
    });

    const { CollectorTransportError, collectorFailureFromError } = await import(${JSON.stringify(TRANSPORT_HREF)});
    const wrapped = new CollectorTransportError(new TypeError('Failed to fetch'));
    const cause = wrapped.cause;
    console.log('RESULT ' + JSON.stringify({
      name: wrapped.name,
      message: wrapped.message,
      failure: collectorFailureFromError(wrapped),
      causeName: cause instanceof Error ? cause.name : typeof cause,
      causeMessage: cause instanceof Error ? cause.message : String(cause),
    }));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: process.env.PATH },
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

describe('CollectorTransportError cause attach (WORLDMONITOR-12E)', () => {
  it('wraps a network TypeError without throwing, and classification still unwraps cause', () => {
    const cause = new TypeError('Failed to fetch');
    const wrapped = new CollectorTransportError(cause);
    assert.equal(wrapped.name, 'CollectorTransportError');
    assert.equal(wrapped.message, 'Umami collector beacon transport rejected: Failed to fetch');
    assert.equal(wrapped.cause, cause);
    assert.deepEqual(collectorFailureFromError(wrapped), { kind: 'network' });
  });

  it('still classifies a wrapped TimeoutError after a frozen cause value', () => {
    const cause = Object.freeze(Object.assign(new Error('collector deadline elapsed'), {
      name: 'TimeoutError',
      collectorLatchRaced: true,
    }));
    const wrapped = new CollectorTransportError(cause);
    assert.deepEqual(collectorFailureFromError(wrapped), { kind: 'timeout', raced: true });
  });

  it('does not throw Cannot add property cause when Error returns a non-extensible instance', () => {
    const child = constructUnderNonExtensibleError();
    const line = child.stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '));
    assert.ok(
      line,
      `CollectorTransportError construction must settle, got status ${String(child.status)}\n${child.stdout}\n${child.stderr}`,
    );
    const result = JSON.parse(line.slice('RESULT '.length)) as {
      name: string;
      message: string;
      failure: { kind: string };
      causeName: string;
      causeMessage: string;
    };
    assert.equal(result.name, 'CollectorTransportError');
    assert.equal(result.message, 'Umami collector beacon transport rejected: Failed to fetch');
    assert.deepEqual(result.failure, { kind: 'network' });
    assert.equal(result.causeName, 'TypeError');
    assert.equal(result.causeMessage, 'Failed to fetch');
  });
});
