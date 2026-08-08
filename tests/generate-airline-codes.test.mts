import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateAirlineCodes } from '../scripts/generate-airline-codes.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatorPath = path.join(projectRoot, 'scripts/generate-airline-codes.mjs');
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

async function createTarget(entries: string[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worldmonitor-airlines-'));
  tempDirectories.push(directory);

  const targetFile = path.join(directory, 'airline-codes.ts');
  const content = `const OVERRIDE = { KEEP: { iata: 'KP', name: 'Keep Airline' } };
${'// --- BEGIN GENERATED AIRLINES ---'}
const GENERATED: Record<string, { iata: string; name: string }> = {
${entries.join('\n')}
};
${'// --- END GENERATED AIRLINES ---'}
const AIRLINES = new Map(Object.entries(GENERATED));
`;
  await fs.writeFile(targetFile, content, 'utf8');
  return { content, directory, targetFile };
}

function csvResponse(csv: string) {
  return new Response(csv, { status: 200 });
}

describe('generate-airline-codes', () => {
  it('filters invalid designators, safely serializes names, preserves overrides, and counts legacy keys', async () => {
    const { directory, targetFile } = await createTarget([
      '  "--+": { iata: "-+", name: "Invalid Legacy" },',
      '  "...": { iata: "..", name: "Invalid Legacy" },',
      '  "QTE": { iata: "Q1", name: "Old Quote Airline" },',
    ]);
    const requests: Array<[string, RequestInit]> = [];
    const result = await generateAirlineCodes({
      allowLargeRemoval: true,
      fetchFn: async (url, options) => {
        requests.push([String(url), options ?? {}]);
        return csvResponse([
          '1,"Quote, ""Air""",\\N,Q1,QTE,QUOTE,US,Y',
          '2,"Invalid IATA",\\N,--,ELK,ELK,US,Y',
          '3,"Invalid ICAO",\\N,AA,1A2,ONE,US,Y',
          '4,"Inactive",\\N,ZZ,ZZZ,ZED,US,N',
        ].join('\n'));
      },
      logger: { log() {} },
      targetFile,
    });

    const generated = await fs.readFile(targetFile, 'utf8');
    assert.deepEqual(result, { total: 1, added: 0, removed: 2 });
    assert.match(requests[0]?.[0] ?? '', /openflights\/1d574116457dd4bccf2d3838c4171b7960794dca\/data\/airlines\.dat$/);
    assert.equal(requests[0]?.[1].headers?.['User-Agent'], 'worldmonitor-airline-code-generator (+https://github.com/koala73/worldmonitor)');
    assert.ok(requests[0]?.[1].signal instanceof AbortSignal);
    assert.match(generated, /const OVERRIDE = \{ KEEP: \{ iata: 'KP', name: 'Keep Airline' \} \};/);
    assert.match(generated, /const GENERATED: Record/);
    assert.doesNotMatch(generated, /export const GENERATED|"ELK"|"1A2"|"--\+"|"\.\.\."/);
    assert.match(generated, /"QTE": \{ iata: "Q1", name: "Quote, \\"Air\\"" \},/);
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')), []);
  });

  it('keeps the existing target when the candidate is empty or removes too many entries', async () => {
    const { content, targetFile } = await createTarget([
      '  "AAA": { iata: "AA", name: "A" },',
      '  "BBB": { iata: "BB", name: "B" },',
      '  "CCC": { iata: "CC", name: "C" },',
      '  "DDD": { iata: "DD", name: "D" },',
      '  "EEE": { iata: "EE", name: "E" },',
    ]);
    const logger = { log() {} };

    await assert.rejects(
      generateAirlineCodes({ fetchFn: async () => csvResponse('1,"Invalid",\\N,--,ELK,ELK,US,Y'), logger, targetFile }),
      /No valid active airline codes found/,
    );
    assert.equal(await fs.readFile(targetFile, 'utf8'), content);

    await assert.rejects(
      generateAirlineCodes({ fetchFn: async () => csvResponse('1,"Only One",\\N,AA,AAA,AAA,US,Y'), logger, targetFile }),
      /WM_ALLOW_LARGE_AIRLINE_REMOVALS=1/,
    );
    assert.equal(await fs.readFile(targetFile, 'utf8'), content);
  });

  it('returns a failing process status when the CLI fetch fails', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worldmonitor-airline-cli-'));
    tempDirectories.push(directory);
    const preload = path.join(directory, 'mock-fetch.mjs');
    await fs.writeFile(preload, 'globalThis.fetch = async () => { throw new Error("simulated fetch failure"); };\n');

    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, generatorPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, 'close');

    assert.equal(exitCode, 1);
    assert.match(stderr, /simulated fetch failure/);
  });
});
