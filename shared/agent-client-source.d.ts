export type AgentClientSource = 'claude' | 'chatgpt' | 'cursor' | 'gemini' | 'grok-bot' | 'other';

export interface AgentRefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const AGENT_CLIENT_SOURCES: ReadonlyArray<AgentClientSource>;
export const AGENT_REF_PREFIX: 'agent';
export const AGENT_REF_PATTERN: RegExp;
export const AGENT_REF_STORAGE_KEY: string;
export const AGENT_REF_TTL_MS: number;
export const MAX_CLIENT_NAME_LENGTH: number;
export const UNKNOWN_CLIENT_NAME: 'Unknown Client';
export const AGENT_REF_COOKIE_DOMAIN: 'worldmonitor.app';

export function normalizeAgentRef(raw: unknown): string | null;
export function classifyAgentClient(hint: unknown): AgentClientSource | null;
export function classifyAgentClientHints(hints: Iterable<unknown>): AgentClientSource | null;
export function agentSourceFromRef(ref: unknown): AgentClientSource | null;
export function sanitizeClientName(raw: unknown): string | null;
export function captureAgentRefFromSearch(search: string, storage: AgentRefStorage | null | undefined, now?: number): string | null;
export function loadAgentRef(storage: AgentRefStorage | null | undefined, now?: number): string | null;
export function clearAgentRef(storage: AgentRefStorage | null | undefined): void;
export function agentRefCookieStorage(
  doc: { cookie: string },
  loc: { hostname: string; protocol: string },
): AgentRefStorage;
export function agentRefColumns(raw: unknown): { ref: string; source: AgentClientSource } | null;
export function mcpGrantName(clientName: unknown): string;
export function mcpGrantClientSource(grantName: unknown): AgentClientSource | null;
