/**
 * AI agents a user can connect to the World Monitor MCP server, and the
 * fastest verified path into each one. Rendered by Settings → AI Agents and
 * mirrored by docs/mcp-quickstart.mdx (tests/mcp-agent-clients.test.mts keeps
 * the two in step).
 *
 * Only actions checked against the live client belong here:
 * - `link`: opens the client with World Monitor already filled in. Claude's
 *   add-connector dialog reads `connectorName`/`connectorUrl`; Cursor and
 *   VS Code publish web install redirects that hand off to the desktop app.
 * - `command`: one line to paste into a terminal agent.
 * - `url`: clients with no prefill link; the user pastes the server URL.
 *
 * Dependency-free so docs tests can import it without the browser graph.
 */

export const MCP_SERVER_URL = 'https://worldmonitor.app/mcp';
export const MCP_SERVER_NAME = 'worldmonitor';
const DISPLAY_NAME = 'World Monitor';

export type McpAgentClientId =
  | 'claude'
  | 'chatgpt'
  | 'cursor'
  | 'vscode'
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'grok'
  | 'other';

export type McpAgentAction =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'command'; command: string }
  | { kind: 'url'; openLabel?: string; openHref?: string };

export interface McpAgentClient {
  id: McpAgentClientId;
  name: string;
  /** What happens after the action, in one short sentence. */
  hint: string;
  action: McpAgentAction;
}

export const CLAUDE_CONNECTOR_URL =
  'https://claude.ai/customize/connectors?modal=add-custom-connector'
  + `&connectorName=${encodeURIComponent(DISPLAY_NAME)}`
  + `&connectorUrl=${encodeURIComponent(MCP_SERVER_URL)}`;

export const CURSOR_INSTALL_URL =
  `https://cursor.com/install-mcp?name=${MCP_SERVER_NAME}`
  + `&config=${encodeURIComponent(btoa(JSON.stringify({ url: MCP_SERVER_URL })))}`;

export const VSCODE_INSTALL_URL =
  `https://vscode.dev/redirect/mcp/install?name=${MCP_SERVER_NAME}`
  + `&config=${encodeURIComponent(JSON.stringify({ type: 'http', url: MCP_SERVER_URL }))}`;

export const MCP_AGENT_CLIENTS: readonly McpAgentClient[] = [
  {
    id: 'claude',
    name: 'Claude',
    hint: 'Opens Claude with World Monitor filled in. Click Continue, then Add, and sign in. Works in the desktop, web and mobile apps.',
    action: { kind: 'link', label: 'Add to Claude', href: CLAUDE_CONNECTOR_URL },
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    hint: 'In ChatGPT, open Plugins, click +, choose Add custom MCP server, paste the URL and pick OAuth.',
    action: { kind: 'url' },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    hint: 'Opens Cursor to install. Click Needs login next to World Monitor to sign in.',
    action: { kind: 'link', label: 'Add to Cursor', href: CURSOR_INSTALL_URL },
  },
  {
    id: 'vscode',
    name: 'VS Code',
    hint: 'Opens VS Code to install for GitHub Copilot. Sign in when VS Code asks.',
    action: { kind: 'link', label: 'Add to VS Code', href: VSCODE_INSTALL_URL },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    hint: 'Run in a terminal, then type /mcp in Claude Code and choose Authenticate.',
    action: { kind: 'command', command: `claude mcp add --transport http ${MCP_SERVER_NAME} ${MCP_SERVER_URL}` },
  },
  {
    id: 'codex',
    name: 'Codex',
    hint: 'Run in a terminal. The login step opens your browser to sign in.',
    action: {
      kind: 'command',
      command: `codex mcp add ${MCP_SERVER_NAME} --url ${MCP_SERVER_URL} && codex mcp login ${MCP_SERVER_NAME}`,
    },
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    hint: `Run in a terminal, then type /mcp auth ${MCP_SERVER_NAME} inside Gemini CLI.`,
    action: {
      kind: 'command',
      command: `gemini mcp add --scope user --transport http ${MCP_SERVER_NAME} ${MCP_SERVER_URL}`,
    },
  },
  {
    id: 'grok',
    name: 'Grok',
    hint: 'In Connectors, click New Connector, choose Custom and paste the URL. Needs a paid Grok plan.',
    action: { kind: 'url', openLabel: 'Open Grok', openHref: 'https://grok.com/connectors' },
  },
  {
    id: 'other',
    name: 'Other apps',
    hint: 'Perplexity, Le Chat, Microsoft 365 Copilot and most MCP apps take this URL as a custom connector.',
    action: { kind: 'url' },
  },
];
