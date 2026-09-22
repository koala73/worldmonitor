// `tools/list` advertises each tool's outputSchema as
// `{ type: 'object', anyOf: [<documented shape>, <projection / soft-envelope shapes>] }`
// so a strict client accepts every response kind (api/mcp/structured-content.ts).
// Tests that assert on a tool's documented shape read it from here.
export function documentedOutputSchema(publicTool) {
  const schema = publicTool?.outputSchema;
  if (!schema || schema.type !== 'object' || !Array.isArray(schema.anyOf)) {
    throw new Error(`${publicTool?.name ?? 'tool'}: outputSchema is not the advertised { type: 'object', anyOf: [...] } form`);
  }
  return schema.anyOf[0];
}
