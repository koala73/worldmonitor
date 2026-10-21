export const MAX_MCP_PROXY_JSON_DEPTH = 128;

export class McpProxyJsonDepthError extends SyntaxError {
  readonly maxDepth: number;

  constructor(maxDepth: number) {
    super(`MCP proxy JSON exceeds ${maxDepth} nesting levels`);
    this.name = 'McpProxyJsonDepthError';
    this.maxDepth = maxDepth;
  }
}

export function parseMcpProxyJson(text: string) {
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
