// scripts/generate-airline-codes.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// OpenFlights airlines.dat - Public Domain
// Pinned to master, consider using a specific commit hash for strict auditability
const SOURCE_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';

const TARGET_FILE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../server/_shared/airline-codes.ts'
);

const START_MARKER = '// --- BEGIN GENERATED AIRLINES ---';
const END_MARKER = '// --- END GENERATED AIRLINES ---';

// Lightweight CSV parser to handle quoted strings with commas
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' && line[i + 1] === '"') {
            current += '"'; // Handle escaped quotes
            i++;
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

async function run() {
    console.log(`Fetching airline data from ${SOURCE_URL}...`);
    const response = await fetch(SOURCE_URL);
  
    if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.status} ${response.statusText}`);
    }
  
    const csvText = await response.text();
    const lines = csvText.split('\n');
    const newAirlines = new Map();

    for (const line of lines) {
        if (!line.trim()) continue;
    
        const fields = parseCSVLine(line);
        // OpenFlights Format: ID, Name, Alias, IATA, ICAO, Callsign, Country, Active
        if (fields.length < 8) continue;

        const [id, name, alias, iata, icao, callsign, country, active] = fields;

        if (
            active === 'Y' &&
            iata && iata.length === 2 && iata !== '\\N' && iata !== 'null' &&
            icao && icao.length === 3 && icao !== '\\N' && icao !== 'null'
        ) {
            newAirlines.set(icao, { iata, name });
        }
    }

    // Sort alphabetically by ICAO for a clean, deterministic diff
    const sortedIcaos = Array.from(newAirlines.keys()).sort();
  
    // Build the new TypeScript code block using JSON.stringify for safe escaping
    const generatedLines = sortedIcaos.map(icao => {
        const data = newAirlines.get(icao);
        return `  ${JSON.stringify(icao)}: { iata: ${JSON.stringify(data.iata)}, name: ${JSON.stringify(data.name)} },`;
    });

    const newBlock = `${START_MARKER}\nexport const GENERATED: Record<string, { iata: string; name: string }> = {\n${generatedLines.join('\n')}\n};\n${END_MARKER}`;

    console.log('Reading target file...');
    const fileContent = await fs.readFile(TARGET_FILE, 'utf-8');
  
    const startIndex = fileContent.indexOf(START_MARKER);
    const endIndex = fileContent.indexOf(END_MARKER);
  
    if (startIndex === -1 || endIndex === -1) {
        throw new Error('Could not find GENERATED markers in the target file.');
    }

    // Extract old keys for the summary diff
    const oldBlock = fileContent.substring(startIndex, endIndex);
    const oldKeys = new Set(Array.from(oldBlock.matchAll(/"([A-Z0-9]{3})":/g)).map(m => m[1]));
    const newKeys = new Set(sortedIcaos);

    let added = 0;
    let removed = 0;
  
    for (const key of newKeys) if (!oldKeys.has(key)) added++;
    for (const key of oldKeys) if (!newKeys.has(key)) removed++;

    // Replace the block
    const updatedContent = fileContent.substring(0, startIndex) + newBlock + fileContent.substring(endIndex + END_MARKER.length);
  
    await fs.writeFile(TARGET_FILE, updatedContent, 'utf-8');
  
    console.log('\n✅ Update Complete');
    console.log('-------------------');
    console.log(`Total entries written: ${newKeys.size}`);
    console.log(`Added vs previous:     +${added}`);
    console.log(`Removed vs previous:   -${removed}`);
}

run().catch(console.error);