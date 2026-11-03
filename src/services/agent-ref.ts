import { agentRefCookieStorage, type AgentRefStorage } from '../../shared/agent-client-source';

/**
 * Where the first-touch agent ref (`?ref=agent-claude`) is kept in this
 * browser: one cookie on the parent domain, so the dashboard on any variant
 * host reads the ref an agent link captured on www, and clearing it once it
 * has been used clears it everywhere. Null outside a browser.
 */
export function agentRefStorage(): AgentRefStorage | null {
  if (typeof document === 'undefined' || typeof location === 'undefined') return null;
  return agentRefCookieStorage(document, location);
}
