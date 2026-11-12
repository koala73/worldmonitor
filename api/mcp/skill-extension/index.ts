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
  let offset = 0;
  if (cursor !== undefined) {
    const parsed = typeof cursor === 'string' ? decodeSkillsCursor(cursor) : null;
    if (parsed === null) {
      return rpcError(id, -32602, 'Invalid params: unknown skills/list cursor', corsHeaders);
    }
    offset = parsed;
  }
  const skills = SKILL_ENTRIES.slice(offset, offset + SKILLS_LIST_PAGE_SIZE);
  const next = offset + SKILLS_LIST_PAGE_SIZE;
  return rpcOk(id, {
    resultType: 'complete',
    skills,
    ...(next < SKILL_ENTRIES.length ? { nextCursor: encodeSkillsCursor(next) } : {}),
  }, corsHeaders);
}

// SEP-2640 lets skills/list paginate like the base list methods. Small pages
// keep each response within publishing checkers' per-page skill bound; every
// entry stays atomic (its resources set is never split across pages).
export const SKILLS_LIST_PAGE_SIZE = 5;
const SKILLS_CURSOR_PREFIX = 'skills:';

function encodeSkillsCursor(offset: number): string {
  return `${SKILLS_CURSOR_PREFIX}${offset}`;
}

function decodeSkillsCursor(cursor: string): number | null {
  if (!cursor.startsWith(SKILLS_CURSOR_PREFIX)) return null;
  const raw = cursor.slice(SKILLS_CURSOR_PREFIX.length);
  if (!/^[1-9]\d{0,5}$/.test(raw)) return null;
  const offset = Number(raw);
  return offset < SKILL_ENTRIES.length && offset % SKILLS_LIST_PAGE_SIZE === 0 ? offset : null;
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
