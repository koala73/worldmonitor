#!/usr/bin/env node
/**
 * Count the ⌘K command palette population from src/config/commands.ts source.
 *
 * The palette is populated at runtime by getAllCommands(): the static COMMANDS
 * registry plus two commands (map + brief) per ISO country code. The module
 * pulls in i18n and other browser-bound imports, so — like every docs-stats
 * inventory — it is measured from source text instead of imported. Each count
 * is cross-checked against a second trait every entry carries, so a reformatted
 * registry fails closed rather than quietly understating what the palette shows.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS_RE = /export const COMMANDS(?::\s*Command\[\])?\s*=\s*\[([\s\S]*?)\n\];/;
const ISO_CODES_RE = /const ISO_CODES(?::\s*[^=]+)?\s*=\s*\[([\s\S]*?)\n\];/;

export function commandPaletteCommandCount({ source = readCommandsSource() } = {}) {
  const commandsBlock = source.match(COMMANDS_RE);
  if (!commandsBlock) {
    throw new Error('command-palette-count: could not isolate the COMMANDS array in src/config/commands.ts');
  }
  const ids = (commandsBlock[1].match(/\bid:\s*'/g) || []).length;
  const icons = (commandsBlock[1].match(/\bicon:\s*'/g) || []).length;
  if (ids === 0 || ids !== icons) {
    throw new Error(
      `command-palette-count: counted ${ids} id entries but ${icons} icon entries in COMMANDS — the registry layout changed`,
    );
  }

  const codesBlock = source.match(ISO_CODES_RE);
  if (!codesBlock) {
    throw new Error('command-palette-count: could not isolate the ISO_CODES array in src/config/commands.ts');
  }
  const quoted = [...codesBlock[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
  const codes = quoted.filter((value) => /^[A-Z]{2}$/.test(value));
  if (codes.length === 0 || codes.length !== quoted.length) {
    throw new Error(
      `command-palette-count: ISO_CODES yielded ${codes.length} two-letter codes of ${quoted.length} quoted strings — the registry layout changed`,
    );
  }
  return ids + 2 * codes.length;
}

function readCommandsSource() {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'config', 'commands.ts'),
    'utf8',
  );
}
