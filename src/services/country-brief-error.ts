export class CountrySectionError extends Error {
  constructor(public readonly state: 'locked' | 'unavailable', message: string) { super(message); }
}

// -31002 is -32002 as MCP 2026-07-28 clients receive it.
const DENIED_RPC_CODES: ReadonlySet<number> = new Set([-32001, -32002, -31002]);

/** Whether a host RPC error means the connection is not allowed this section. */
export function isDeniedRpcError(error: { code?: unknown; message?: unknown }): boolean {
  return (typeof error.code === 'number' && DENIED_RPC_CODES.has(error.code))
    || /subscription|billing|entitlement|scope|unauthoriz|forbidden/i.test(JSON.stringify(error));
}

