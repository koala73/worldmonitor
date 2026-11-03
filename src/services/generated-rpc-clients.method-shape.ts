import type { createLazyRpcClientConstructor } from './generated-rpc-clients';

// Compile-time proof for #4550. The lazy proxy answers every property read
// with an async invoker before the real client is loaded, so it can only stand
// in for a client whose public members are all async methods. A public field,
// getter, or sync method would be typed as a value while the proxy hands back
// a function (`if (client.enabled)` would always be truthy). The constraint on
// createLazyRpcClientConstructor must reject those shapes; each case below
// fails typecheck if the constraint is loosened.

class AsyncMethodsOnlyClient {
  private baseURL = '';
  async ping(): Promise<string> { return this.baseURL; }
}

class ClientWithPublicField {
  baseURL = '';
  async ping(): Promise<string> { return 'pong'; }
}

class ClientWithPublicGetter {
  get enabled(): boolean { return true; }
  async ping(): Promise<string> { return 'pong'; }
}

class ClientWithSyncMethod {
  ping(): string { return 'pong'; }
}

class ClientWithOptionalMethod {
  ping?: () => Promise<string>;
}

export type LazyRpcClientAcceptsAsyncMethodsOnly = typeof createLazyRpcClientConstructor<AsyncMethodsOnlyClient>;

// @ts-expect-error -- a public field would read as a function through the proxy.
export type LazyRpcClientRejectsPublicField = typeof createLazyRpcClientConstructor<ClientWithPublicField>;

// @ts-expect-error -- a public getter would read as a function through the proxy.
export type LazyRpcClientRejectsPublicGetter = typeof createLazyRpcClientConstructor<ClientWithPublicGetter>;

// @ts-expect-error -- the proxy always returns a Promise, so a sync method's return type would lie.
export type LazyRpcClientRejectsSyncMethod = typeof createLazyRpcClientConstructor<ClientWithSyncMethod>;

// @ts-expect-error -- an optional method always reads as defined through the proxy.
export type LazyRpcClientRejectsOptionalMethod = typeof createLazyRpcClientConstructor<ClientWithOptionalMethod>;
