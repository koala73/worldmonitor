// Fake `claude` CLI for shim tests. Records each invocation (argv + stdin) to
// STUB_LOG as JSON lines, then prints either a `--output-format json` result or
// `stream-json` events, mirroring the real headless Claude Code output shapes.
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;

if (process.env.STUB_LOG) {
  appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, stdin }) + '\n');
}

const sleepMs = Number(process.env.STUB_SLEEP_MS || 0);
if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));

const usage = {
  input_tokens: 10,
  cache_creation_input_tokens: 5,
  cache_read_input_tokens: 20,
  output_tokens: 7,
};

if (argv.includes('stream-json')) {
  const events = [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'STUB ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'STREAM' } } },
    {
      type: 'result', subtype: 'success', is_error: false,
      result: 'STUB STREAM', stop_reason: 'end_turn', usage,
    },
  ];
  for (const e of events) process.stdout.write(JSON.stringify(e) + '\n');
} else {
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: process.env.STUB_RESPONSE || 'STUB_RESPONSE',
    stop_reason: process.env.STUB_STOP_REASON || 'end_turn',
    usage,
  }) + '\n');
}
