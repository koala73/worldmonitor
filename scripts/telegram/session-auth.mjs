#!/usr/bin/env node
/**
 * Generate a TELEGRAM_SESSION (GramJS StringSession) for the Railway Telegram OSINT poller.
 *
 * Usage (local only):
 *   cd scripts
 *   npm install
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... node telegram/session-auth.mjs
 *
 * Output:
 *   Prints TELEGRAM_SESSION=... to stdout.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const apiId = parseInt(String(process.env.TELEGRAM_API_ID || ''), 10);
const apiHash = String(process.env.TELEGRAM_API_HASH || '');

if (!apiId || !apiHash) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH. Get them from https://my.telegram.org/apps');
  process.exit(1);
}

const rl = readline.createInterface({ input, output });

try {
  const phoneNumber = (await rl.question('Phone number (with country code, e.g. +971...): ')).trim();
  const password = (await rl.question('2FA password (press enter if none): ')).trim();

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });

  await client.start({
    phoneNumber: async () => phoneNumber,
    password: async () => password || undefined,
    phoneCode: async () => (await rl.question('Verification code from Telegram: ')).trim(),
    onError: (err) => console.error(err),
  });

  const session = client.session.save();
  console.log('\n✅ Generated session. Add this as a Railway secret:');
  console.log(`TELEGRAM_SESSION=${session}`);

  await client.disconnect();
} finally {
  rl.close();
}
