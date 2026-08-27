import { SKILL_ENTRIES, SKILL_RESOURCES } from './generated';
import { rpcError, rpcOk } from '../rpc';

const entriesByUri = new Map<string, (typeof SKILL_ENTRIES)[number]>(
  SKILL_ENTRIES.map((entry) => [entry.uri, entry]),
);

type SkillResource =
  | { mimeType: string; text: string }
  | { mimeType: string; blob: string };

export function buildSkillsListResponse(
  id: unknown,
  params: unknown,
  corsHeaders: Record<string, string>,
): Response {
  const cursor = (params as { cursor?: unknown } | null)?.cursor;
  if (cursor !== undefined) {
    return rpcError(id, -32602, 'Invalid params: skills/list has no further pages', corsHeaders);
  }
  return rpcOk(id, { resultType: 'complete', skills: SKILL_ENTRIES }, corsHeaders);
}

export function buildSkillsGetResponse(
  id: unknown,
  params: unknown,
  corsHeaders: Record<string, string>,
): Response {
  const uri = (params as { uri?: unknown } | null)?.uri;
  if (typeof uri !== 'string') {
    return rpcError(id, -32602, 'Invalid params: missing skill uri', corsHeaders);
  }
  const skill = entriesByUri.get(uri);
  if (!skill) return rpcError(id, -32602, `Unknown skill uri "${uri}".`, corsHeaders);
  return rpcOk(id, { resultType: 'complete', skill }, corsHeaders);
}

export function isSkillResourceUri(uri: unknown): uri is keyof typeof SKILL_RESOURCES {
  return typeof uri === 'string' && Object.prototype.hasOwnProperty.call(SKILL_RESOURCES, uri);
}

export function isSkillUri(uri: unknown): uri is string {
  return typeof uri === 'string' && uri.startsWith('skill://');
}

export function buildSkillResourceRead(
  id: unknown,
  uri: keyof typeof SKILL_RESOURCES,
  corsHeaders: Record<string, string>,
): Response {
  const resource = SKILL_RESOURCES[uri] as SkillResource;
  const content = 'text' in resource
    ? { text: resource.text }
    : { blob: resource.blob };
  return rpcOk(id, {
    contents: [{ uri, mimeType: resource.mimeType, ...content }],
  }, corsHeaders);
}
