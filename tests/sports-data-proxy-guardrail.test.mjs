import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createSportsDataProviders } from '../api/_sports-data-config.js';
import sportsDataHandler from '../api/sports-data.js';

const viteSrc = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const edgeSrc = readFileSync(new URL('../api/sports-data.js', import.meta.url), 'utf8');
const providers = createSportsDataProviders();

describe('sports data proxy guardrail (dev parity)', () => {
  it('loads provider allowlist from the shared config in both dev and edge handlers', () => {
    assert.match(viteSrc, /_sports-data-config\.js/);
    assert.match(edgeSrc, /_sports-data-config\.js/);
  });

  it('allows TheSportsDB fixture, event details, and venue lookup routes', () => {
    const thesportsdb = providers.thesportsdb;
    assert.ok(thesportsdb.endpoints.has('/eventsday.php'));
    assert.deepEqual([...thesportsdb.allowedParams['/eventsday.php']], ['d', 's']);
    assert.ok(thesportsdb.endpoints.has('/lookupevent.php'));
    assert.deepEqual([...thesportsdb.allowedParams['/lookupevent.php']], ['id']);
    assert.ok(thesportsdb.endpoints.has('/searchvenues.php'));
    assert.deepEqual([...thesportsdb.allowedParams['/searchvenues.php']], ['v']);
  });

  it('allows ESPN scoreboard date filters used by daily fixture loading', () => {
    const espnsite = providers.espnsite;
    assert.deepEqual([...espnsite.allowedParams['/soccer/eng.1/scoreboard']], ['dates']);
    assert.deepEqual([...espnsite.allowedParams['/basketball/nba/scoreboard']], ['dates']);
    assert.deepEqual([...espnsite.allowedParams['/hockey/nhl/scoreboard']], ['dates']);
    assert.deepEqual([...espnsite.allowedParams['/baseball/mlb/scoreboard']], ['dates']);
    assert.deepEqual([...espnsite.allowedParams['/football/nfl/scoreboard']], ['dates']);
  });

  it('allows ESPN NBA standings JSON endpoint with no query params', () => {
    const espnsite = providers.espnsite;
    assert.ok(espnsite.endpoints.has('/basketball/nba/standings'));
    assert.deepEqual([...espnsite.allowedParams['/basketball/nba/standings']], []);
  });

  it('returns 400 for invalid providers in the edge proxy', async () => {
    const request = new Request('https://worldmonitor.app/api/sports-data?provider=invalid&path=/all_leagues.php');
    const response = await sportsDataHandler(request);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid sports provider' });
  });

  it('passes TheSportsDB lookupevent route through the edge proxy', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    try {
      const request = new Request('https://worldmonitor.app/api/sports-data?provider=thesportsdb&path=/lookupevent.php?id=123');
      const response = await sportsDataHandler(request);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
