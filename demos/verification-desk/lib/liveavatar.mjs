// HeyGen LiveAvatar, FULL mode, following LiveAvatar's integration guide
// (github.com/heygen-com/liveavatar-agent-skills, full-mode-guide.md):
//   - X-API-KEY on the backend only; the browser gets a one-session token.
//   - A context is required: without context_id the avatar is silent, with no
//     error. If LIVEAVATAR_CONTEXT_ID is unset, one is created once and cached.
//   - LIVEAVATAR_SANDBOX=1 uses LiveAvatar's free sandbox avatar (~1 min sessions).
// The desk only uses repeat(): the avatar says the desk's lines word for word.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const CONTEXT_CACHE = path.join(DATA_DIR, 'liveavatar-context.json');
export const SANDBOX_AVATAR_ID = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';
export const OPENING_TEXT = 'WorldMonitor desk. Live.';

const CONTEXT = {
  name: 'WorldMonitor Verification Desk',
  prompt: 'You are the on-stage anchor of the WorldMonitor Verification Desk. You only say the exact lines the desk sends you. Never improvise, never answer questions, never call a claim true or false.',
  opening_text: OPENING_TEXT,
};

const base = () => process.env.LIVEAVATAR_API_URL || 'https://api.liveavatar.com';
export const apiKey = () => process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY || '';
export const sandbox = () => process.env.LIVEAVATAR_SANDBOX === '1';
export const avatarId = () => process.env.LIVEAVATAR_AVATAR_ID || (sandbox() ? SANDBOX_AVATAR_ID : '');
export const configured = () => Boolean(apiKey() && avatarId());

async function call(method, route, body) {
  const res = await fetch(`${base()}${route}`, {
    method,
    headers: { 'X-API-KEY': apiKey(), 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'WorldMonitor-VerificationDesk/1.0' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text for the error */ }
  if (!res.ok) throw new Error(`LiveAvatar ${method} ${route} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json ?? {};
}

/** The context id: .env, else the cached one, else a new one (created once). */
export async function ensureContext() {
  if (process.env.LIVEAVATAR_CONTEXT_ID) return { id: process.env.LIVEAVATAR_CONTEXT_ID, from: 'env' };
  if (existsSync(CONTEXT_CACHE)) {
    const cached = JSON.parse(await readFile(CONTEXT_CACHE, 'utf8'));
    if (cached.id) return { id: cached.id, from: 'cache' };
  }
  const json = await call('POST', '/v1/contexts', CONTEXT);
  const id = json?.data?.id ?? json?.id;
  if (!id) throw new Error(`LiveAvatar context: no id in ${JSON.stringify(json).slice(0, 200)}`);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONTEXT_CACHE, JSON.stringify({ id, created: new Date().toISOString() }, null, 2));
  return { id, from: 'created' };
}

export async function tokenBody() {
  if (process.env.LIVEAVATAR_TOKEN_BODY) return JSON.parse(process.env.LIVEAVATAR_TOKEN_BODY);
  const context = await ensureContext();
  return {
    mode: 'FULL',
    ...(sandbox() ? { is_sandbox: true } : {}),
    avatar_id: avatarId(),
    avatar_persona: {
      ...(process.env.LIVEAVATAR_VOICE_ID ? { voice_id: process.env.LIVEAVATAR_VOICE_ID } : {}),
      context_id: context.id,
      language: process.env.LIVEAVATAR_LANGUAGE || 'en',
    },
  };
}

/** A one-session token for the browser SDK (which starts the session itself). */
export async function createToken() {
  if (!configured()) throw new Error('Set LIVEAVATAR_API_KEY and LIVEAVATAR_AVATAR_ID (or LIVEAVATAR_SANDBOX=1) in .env');
  const json = await call('POST', '/v1/sessions/token', await tokenBody());
  const token = json?.data?.session_token ?? json?.session_token;
  if (!token) throw new Error(`LiveAvatar token: no session_token in ${JSON.stringify(json).slice(0, 200)}`);
  return { session_token: token, session_id: json?.data?.session_id ?? null };
}

/** id + name rows from GET /v1/avatars or /v1/voices, whatever the list's wrapper. */
export async function list(kind) {
  const json = await call('GET', `/v1/${kind}`);
  const rows = [json?.data, json?.data?.results, json?.data?.items, json?.data?.[kind], json?.results, json?.[kind]].find(Array.isArray) ?? [];
  return rows.map((r) => ({ id: r.id ?? r.avatar_id ?? r.voice_id, name: r.name ?? r.display_name ?? '', type: r.type ?? r.avatar_type ?? '' }));
}
