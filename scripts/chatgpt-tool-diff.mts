// Lists how the tools ChatGPT receives differ from the version OpenAI last
// approved, for the "what changed" notes of a plugin resubmission.
//
//   npx tsx scripts/chatgpt-tool-diff.mts                 report against the approved snapshot
//   npx tsx scripts/chatgpt-tool-diff.mts --write         record the current list as approved
//   npx tsx scripts/chatgpt-tool-diff.mts --write --source tools.json --version 2.11.8 --commit <sha>
//
// The snapshot keeps a hash per tool field, not the definitions: the full
// ChatGPT tools/list is about 700 KB.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CHATGPT_TOOL_LIST_RESPONSE } from '../api/mcp/registry/index.ts';

const SNAPSHOT_PATH = new URL('./data/chatgpt-reviewed-tools.json', import.meta.url);
const FIELDS = ['title', 'description', 'inputSchema', 'outputSchema', 'annotations', '_meta'] as const;

type Field = (typeof FIELDS)[number];
type ToolHashes = Partial<Record<Field, string>>;
interface Snapshot {
  version: string;
  commit: string;
  tools: Record<string, ToolHashes>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashTools(tools: ReadonlyArray<Record<string, unknown>>): Record<string, ToolHashes> {
  const out: Record<string, ToolHashes> = {};
  for (const tool of [...tools].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const hashes: ToolHashes = {};
    for (const field of FIELDS) {
      if (tool[field] !== undefined) hashes[field] = createHash('sha256').update(canonical(tool[field])).digest('hex').slice(0, 16);
    }
    out[String(tool.name)] = hashes;
  }
  return out;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv.includes('--write')) {
  const source = arg('--source');
  const tools = source
    ? Object.values(JSON.parse(readFileSync(source, 'utf8')) as Record<string, Record<string, unknown>>)
    : (CHATGPT_TOOL_LIST_RESPONSE as unknown as Array<Record<string, unknown>>);
  const version = arg('--version') ?? JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')).version;
  const commit = arg('--commit') ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const snapshot: Snapshot = { version, commit, tools: hashTools(tools) };
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`recorded ${Object.keys(snapshot.tools).length} tools as approved in ${version} (${commit.slice(0, 10)})`);
} else {
  const approved = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
  const current = hashTools(CHATGPT_TOOL_LIST_RESPONSE as unknown as Array<Record<string, unknown>>);
  const added = Object.keys(current).filter((name) => !approved.tools[name]);
  const removed = Object.keys(approved.tools).filter((name) => !current[name]);
  const changed = Object.keys(current)
    .filter((name) => approved.tools[name])
    .map((name) => ({ name, fields: FIELDS.filter((field) => current[name][field] !== approved.tools[name][field]) }))
    .filter(({ fields }) => fields.length > 0);

  console.log(`ChatGPT tools compared with approved ${approved.version} (${approved.commit.slice(0, 10)}): ${Object.keys(current).length} now, ${Object.keys(approved.tools).length} approved`);
  console.log(`\nAdded (${added.length})`);
  for (const name of added) console.log(`- ${name}`);
  console.log(`\nRemoved (${removed.length})`);
  for (const name of removed) console.log(`- ${name}`);
  console.log(`\nChanged (${changed.length})`);
  for (const { name, fields } of changed) console.log(`- ${name}: ${fields.join(', ')}`);
}
