import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBED_API_KEY_PLACEHOLDER,
  EMBED_CREDENTIAL_READY_TYPE,
  EMBED_CREDENTIAL_SOURCE,
  waitForEmbeddingApiKey,
  type EmbedCredentialHost,
} from '../src/embed/embed-credential';

class FakeEmbedHost implements EmbedCredentialHost {
  readonly parentMessages: Array<{ message: unknown; targetOrigin: string }> = [];
  readonly parent = {
    postMessage: (message: unknown, targetOrigin: string): void => {
      this.parentMessages.push({ message, targetOrigin });
    },
  };

  private readonly listeners = new Set<(event: MessageEvent) => void>();
  private timeoutHandler: (() => void) | null = null;

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  setTimeout(handler: () => void, _timeout: number): number {
    this.timeoutHandler = handler;
    return 1;
  }

  emit(data: unknown, source: unknown = this.parent, origin = ''): void {
    const event = { data, source, origin } as MessageEvent;
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  fireTimeout(): void {
    this.timeoutHandler?.();
  }

  get listening(): boolean {
    return this.listeners.size > 0;
  }
}

describe('waitForEmbeddingApiKey', () => {
  it('posts a ready handshake to the parent and resolves the parent credential', async () => {
    const host = new FakeEmbedHost();
    const pending = waitForEmbeddingApiKey(3_000, host);

    assert.equal(host.listening, true);
    assert.deepEqual(host.parentMessages, [{
      message: { source: EMBED_CREDENTIAL_SOURCE, type: EMBED_CREDENTIAL_READY_TYPE },
      targetOrigin: '*',
    }]);

    host.emit({
      source: EMBED_CREDENTIAL_SOURCE,
      type: 'credential',
      key: 'wm_0123456789abcdef0123456789abcdef01234567',
    });

    assert.equal(await pending, 'wm_0123456789abcdef0123456789abcdef01234567');
    assert.equal(host.listening, false);
  });

  it('pins the handshake and credential to the embedding parent origin', async () => {
    const host = new FakeEmbedHost();
    const parentOrigin = 'https://partner.example';
    const pending = waitForEmbeddingApiKey(3_000, host, parentOrigin);

    assert.deepEqual(host.parentMessages, [{
      message: { source: EMBED_CREDENTIAL_SOURCE, type: EMBED_CREDENTIAL_READY_TYPE },
      targetOrigin: parentOrigin,
    }]);

    const credential = {
      source: EMBED_CREDENTIAL_SOURCE,
      type: 'credential',
      key: 'wm_0123456789abcdef0123456789abcdef01234567',
    };
    host.emit(credential, host.parent, 'https://attacker.example');
    assert.equal(host.listening, true);

    host.emit(credential, host.parent, parentOrigin);
    assert.equal(await pending, credential.key);
  });

  it('ignores the placeholder, wrong source, and non-parent senders until timeout', async () => {
    const host = new FakeEmbedHost();
    const pending = waitForEmbeddingApiKey(3_000, host);

    host.emit({ source: 'other', type: 'credential', key: 'wm_0123456789abcdef0123456789abcdef01234567' });
    host.emit({
      source: EMBED_CREDENTIAL_SOURCE,
      type: 'credential',
      key: EMBED_API_KEY_PLACEHOLDER,
    });
    host.emit(
      { source: EMBED_CREDENTIAL_SOURCE, type: 'credential', key: 'wm_0123456789abcdef0123456789abcdef01234567' },
      {},
    );

    host.fireTimeout();
    assert.equal(await pending, null);
    assert.equal(host.listening, false);
  });
});
