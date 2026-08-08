import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// OpenFlights airlines.dat is public domain. Update this SHA deliberately when
// refreshing the generated lookup so the input remains reproducible.
const SOURCE_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/1d574116457dd4bccf2d3838c4171b7960794dca/data/airlines.dat';
const USER_AGENT = 'worldmonitor-airline-code-generator (+https://github.com/koala73/worldmonitor)';
const FETCH_TIMEOUT_MS = 30_000;
const MIN_RETAINED_ENTRY_RATIO = 0.8;

const TARGET_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../server/_shared/airline-codes.ts',
);

const START_MARKER = '// --- BEGIN GENERATED AIRLINES ---';
const END_MARKER = '// --- END GENERATED AIRLINES ---';
const IATA_CODE = /^[A-Z0-9]{2}$/;
const ICAO_CODE = /^[A-Z]{3}$/;

// Lightweight CSV parser to handle quoted strings with commas.
export function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function collectAirlines(csvText) {
  const airlines = new Map();

  for (const line of csvText.split('\n')) {
    if (!line.trim()) continue;

    const fields = parseCSVLine(line);
    // OpenFlights format: ID, Name, Alias, IATA, ICAO, Callsign, Country, Active
    if (fields.length < 8) continue;

    const [, name, , rawIata, rawIcao, , , active] = fields;
    const iata = rawIata?.toUpperCase();
    const icao = rawIcao?.toUpperCase();

    if (active === 'Y' && IATA_CODE.test(iata) && ICAO_CODE.test(icao)) {
      airlines.set(icao, { iata, name });
    }
  }

  return airlines;
}

function buildGeneratedBlock(airlines) {
  const generatedLines = Array.from(airlines.keys())
    .sort()
    .map((icao) => {
      const data = airlines.get(icao);
      return `  ${JSON.stringify(icao)}: { iata: ${JSON.stringify(data.iata)}, name: ${JSON.stringify(data.name)} },`;
    });

  return `${START_MARKER}\nconst GENERATED: Record<string, { iata: string; name: string }> = {\n${generatedLines.join('\n')}\n};\n${END_MARKER}`;
}

function readGeneratedKeys(block) {
  const serializedKeyPattern = /^\s+("(?:\\.|[^"\\])*"):/gm;
  return new Set(
    Array.from(block.matchAll(serializedKeyPattern), ([, serializedKey]) => JSON.parse(serializedKey)),
  );
}

function shouldAllowLargeRemoval() {
  return process.env.WM_ALLOW_LARGE_AIRLINE_REMOVALS === '1';
}

export async function generateAirlineCodes({
  fetchFn = globalThis.fetch,
  logger = console,
  sourceUrl = SOURCE_URL,
  targetFile = TARGET_FILE,
  allowLargeRemoval = shouldAllowLargeRemoval(),
} = {}) {
  logger.log(`Fetching airline data from ${sourceUrl}...`);
  const response = await fetchFn(sourceUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch data: ${response.status} ${response.statusText}`);
  }

  const airlines = collectAirlines(await response.text());
  if (airlines.size === 0) {
    throw new Error('No valid active airline codes found; leaving the existing generated block unchanged.');
  }

  logger.log('Reading target file...');
  const fileContent = await fs.readFile(targetFile, 'utf-8');
  const startIndex = fileContent.indexOf(START_MARKER);
  const endIndex = fileContent.indexOf(END_MARKER);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error('Could not find an ordered GENERATED marker pair in the target file.');
  }

  const oldBlock = fileContent.substring(startIndex, endIndex);
  const oldKeys = readGeneratedKeys(oldBlock);
  const newKeys = new Set(airlines.keys());

  if (
    oldKeys.size > 0 &&
    newKeys.size < oldKeys.size * MIN_RETAINED_ENTRY_RATIO &&
    !allowLargeRemoval
  ) {
    throw new Error(
      `Refusing to replace ${oldKeys.size} entries with ${newKeys.size}. Set WM_ALLOW_LARGE_AIRLINE_REMOVALS=1 after reviewing the source to override.`,
    );
  }

  const added = Array.from(newKeys).filter((key) => !oldKeys.has(key)).length;
  const removed = Array.from(oldKeys).filter((key) => !newKeys.has(key)).length;
  const newBlock = buildGeneratedBlock(airlines);
  const updatedContent = fileContent.substring(0, startIndex) + newBlock + fileContent.substring(endIndex + END_MARKER.length);
  const temporaryTarget = `${targetFile}.tmp`;

  await fs.writeFile(temporaryTarget, updatedContent, 'utf-8');
  await fs.rename(temporaryTarget, targetFile);

  logger.log('\nUpdate complete');
  logger.log('---------------');
  logger.log(`Total entries written: ${newKeys.size}`);
  logger.log(`Added vs previous:     +${added}`);
  logger.log(`Removed vs previous:   -${removed}`);

  return { total: newKeys.size, added, removed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateAirlineCodes().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
