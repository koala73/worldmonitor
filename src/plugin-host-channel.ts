// Set by the MCP App loader (api/mcp/ui/_plugin-loader.ts), which owns the host handshake.
export type PluginHostChannel = {
  initialized: Promise<unknown>;
  adopt(listener: (event: MessageEvent) => void): void;
};

export function loaderHostChannel(): PluginHostChannel | undefined {
  if (document.documentElement.dataset.wmPluginManagedBoot !== 'true') return undefined;
  return (window as Window & { wmPluginHost?: PluginHostChannel }).wmPluginHost;
}
