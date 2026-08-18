/**
 * #6716 — SERVER_INSTRUCTIONS is a CONTRACT, not prose.
 *
 * It is delivered to every MCP client on `initialize` and is the one channel
 * that reliably reaches the model (hosts compress tool descriptions to their
 * first sentence and many drop `outputSchema` entirely). An agent branches on
 * what it says. So a stanza that contradicts another stanza — or contradicts
 * the code — makes agents reject valid calls or recommend an upgrade the caller
 * does not need.
 *
 * That is exactly what shipped: the access stanza told agents that signed-in
 * free accounts may call cache-backed tools and to branch on
 * `_meta["worldmonitor/access"]`, while the resources stanza still asserted
 * that a template read "consumes the Pro daily quota IDENTICALLY … there is no
 * free path around the cap via those resources". Both cannot be true, and the
 * code sides with the first: `buildResourceResponse` forwards
 * `freeAccountAllowance` into `dispatchToolsCall`, so a free caller's
 * cache-backed template read spends the free allowance.
 *
 * These assertions pin the agreement rather than the wording, so a copy edit
 * stays free but a contradiction does not.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { SERVER_INSTRUCTIONS } from '../api/mcp/constants.ts';
import { MCP_UPGRADE_URL } from '../api/mcp/upgrade.ts';
import {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
} from '../api/mcp/upgrade-constants.ts';

// SERVER_INSTRUCTIONS is already the joined wire string; split it back into
// stanzas so a per-stanza assertion can name which one it is about.
const TEXT = SERVER_INSTRUCTIONS;
const STANZAS = TEXT.split('\n').filter(Boolean);

describe('SERVER_INSTRUCTIONS — internal consistency (#6716)', () => {
  it('does not claim resource templates have no free path', () => {
    // The specific sentence that contradicted the access stanza. Asserting on
    // the CLAIM (a denial that no free path exists) rather than the sentence
    // keeps rewording free.
    assert.equal(
      /no free path around the cap/i.test(TEXT),
      false,
      'resource templates DO honour the free-account allowance — buildResourceResponse '
      + 'forwards freeAccountAllowance into dispatchToolsCall',
    );
  });

  it('describes template reads as metered by the caller-applicable allowance', () => {
    const resourcesStanza = STANZAS.find((line) => line.includes('resources/templates/list'));
    assert.ok(resourcesStanza, 'the resources stanza must exist');
    assert.match(
      resourcesStanza,
      /free-account allowance|worldmonitor\/access/,
      'a template read must be described the same way the equivalent tools/call is',
    );
  });

  it('states the free allowance exactly once and consistently with the constants', () => {
    // A number that drifts from the enforced constant is the same class of bug
    // as the contradiction above: the agent plans against a limit that is not
    // the one the meter applies.
    assert.ok(
      TEXT.includes(`${FREE_ACCOUNT_REQUESTS_PER_DAY} request windows/day`),
      `instructions must quote the enforced ${FREE_ACCOUNT_REQUESTS_PER_DAY} request windows/day`,
    );
    assert.ok(
      TEXT.includes(`${FREE_ACCOUNT_CALLS_PER_DAY} calls/day`),
      `instructions must quote the enforced ${FREE_ACCOUNT_CALLS_PER_DAY} calls/day`,
    );
  });

  it('advertises the free taste only alongside the cache-backed restriction', () => {
    // The allowance covers cache-backed tools only; dispatch refuses anything
    // that fetches downstream with -32002 upgrade-required. Promising a free
    // taste without that qualifier sends agents at tools they cannot call.
    const accessStanza = STANZAS.find((line) => /free taste/i.test(line));
    assert.ok(accessStanza, 'the access stanza must exist');
    assert.match(accessStanza, /CACHED-data|cache-backed/i);
    assert.match(accessStanza, /live-fetch tools stay Pro-only|upgrade-required/i);
  });

  it('carries the attributed upgrade URL agents are told to send users to', () => {
    assert.ok(TEXT.includes(MCP_UPGRADE_URL), 'the upgrade URL must be the shared constant');
  });
});
