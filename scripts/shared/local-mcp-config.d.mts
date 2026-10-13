export interface LocalMcpServer {
  name: string;
  url: URL;
  headers: Record<string, string>;
}
export const LOCAL_MCP_FETCH: unique symbol;
type Environment = Record<string, string | undefined>;
export function localMcpServerName(raw: unknown): string | null;
export function getLocalMcpServer(name: unknown, env?: Environment): LocalMcpServer | null;
export function getLocalMcpOrigins(env?: Environment): string[];
export function isLocalMcpUrlAllowed(url: URL, server: LocalMcpServer | null, options?: { sseEndpoint?: boolean }): boolean;
