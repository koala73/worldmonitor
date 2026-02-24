/**
 * Browser shim for @loaders.gl/worker-utils ChildProcessProxy.
 * loaders.gl exposes this Node-only utility from its root index, which can
 * trigger bundler warnings in browser builds even when not used at runtime.
 */
export default class ChildProcessProxy {
  async start(): Promise<{}> {
    throw new Error('ChildProcessProxy is not available in browser environments.');
  }

  async stop(): Promise<void> {}

  async exit(_statusCode: number = 0): Promise<void> {}
}
