// Types for tests/helpers/mcp-pro-deps.mjs so e2e/*.ts consumers stay covered
// by `npm run typecheck:e2e`. Mirrors the scripts/shared/comtrade.d.mts
// precedent.

export declare const PRO_USER_ID: 'user_pro_xyz';
export declare const PRO_TOKEN_ID: 'k57mcptokenid';
export declare const PRO_BEARER: 'pro-bearer-uuid';
export declare const HMAC_SECRET: 'test-secret-mcp-internal-32-bytes-1234';
export declare const BASE_URL: 'https://worldmonitor.app/mcp';
export declare const ANON_DISCOVERY_URL: 'https://worldmonitor.app/.well-known/mcp';

export interface PipelineMockOptions {
  initialCount?: number;
  initialLimitFloor?: number | null;
  throwOnIncr?: boolean;
  throwOnEval?: boolean;
  decrFails?: boolean;
}

export interface PipelineMock {
  pipeline: (commands: unknown[][]) => Promise<Array<{ result: unknown }>>;
  ops: unknown[][][];
  store: Map<string, unknown>;
  readonly count: number;
  readonly limitFloor: number | null;
}

export declare function makePipelineMock(options?: PipelineMockOptions): PipelineMock;
export declare function makeProDeps(
  overrides?: Record<string, unknown> & { pipelineOpts?: PipelineMockOptions },
): { deps: Record<string, unknown>; pipe: PipelineMock };
export declare function proReq(
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request;
export declare function callBody(
  toolName: string,
  args?: Record<string, unknown>,
  id?: number,
): {
  jsonrpc: '2.0';
  id: number;
  method: 'tools/call';
  params: { name: string; arguments: Record<string, unknown> };
};
