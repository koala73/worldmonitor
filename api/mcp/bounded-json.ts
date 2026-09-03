export const MAX_MCP_PROXY_JSON_CONTAINERS = 50_000;
export const MAX_MCP_PROXY_JSON_DEPTH = 128;

export class McpProxyJsonLimitError extends SyntaxError {}

export class McpProxyJsonDepthError extends McpProxyJsonLimitError {
  readonly maxDepth: number;

  constructor(maxDepth: number) {
    super(`MCP proxy JSON exceeds ${maxDepth} nesting levels`);
    this.name = 'McpProxyJsonDepthError';
    this.maxDepth = maxDepth;
  }
}

export class McpProxyJsonContainerError extends McpProxyJsonLimitError {
  readonly maxContainers: number;

  constructor(maxContainers: number) {
    super(`MCP proxy JSON exceeds ${maxContainers} object or array containers`);
    this.name = 'McpProxyJsonContainerError';
    this.maxContainers = maxContainers;
  }
}

export function parseMcpProxyJson(text: string) {
  let containers = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      containers += 1;
      if (containers > MAX_MCP_PROXY_JSON_CONTAINERS) {
        throw new McpProxyJsonContainerError(MAX_MCP_PROXY_JSON_CONTAINERS);
      }
      depth += 1;
      if (depth > MAX_MCP_PROXY_JSON_DEPTH) {
        throw new McpProxyJsonDepthError(MAX_MCP_PROXY_JSON_DEPTH);
      }
    } else if (char === '}' || char === ']') {
      depth -= 1;
    }
  }

  return JSON.parse(text);
}
