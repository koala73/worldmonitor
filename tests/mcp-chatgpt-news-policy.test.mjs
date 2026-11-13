/**
 * OpenAI's review on 2026-11-13 rejected the ChatGPT app for summarizing or
 * aggregating news from third-party publishers. WorldMonitor reads headlines
 * from RSS; summaries are an opt-in action. For ChatGPT only:
 *   - the summary tools (get_world_brief, get_country_brief,
 *     analyze_news_headlines) are hidden from tools/list, calls and
 *     describe_tool, and prompts drop the steps that call them;
 *   - news results carry pointers only: title, publisher, link and time stay,
 *     article snippets, LLM briefs and publisher body text go.
 * Every other client, Codex included, is unchanged.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpHandler } from '../api/mcp/handler.ts';
import { CHATGPT_HIDDEN_TOOLS } from '../api/mcp/host-policy.ts';
import { CHATGPT_POINTER_ONLY_TOOLS, pointerOnlyNewsResult } from '../api/mcp/chatgpt-news.ts';
import { CHATGPT_TOOL_LIST_RESPONSE, TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { AGENT_GUIDE, CHATGPT_AGENT_GUIDE, CHATGPT_MODERN_SERVER_INSTRUCTIONS, CHATGPT_SERVER_INSTRUCTIONS } from '../api/mcp/constants.ts';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const CHATGPT_UA = 'openai-mcp/1.0.0';
const SUMMARY_TOOLS = ['get_world_brief', 'get_country_brief', 'analyze_news_headlines'];

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
beforeEach(() => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function invoke(body, userAgent) {
  const { deps } = makeProDeps();
  const response = await mcpHandler(proReq('POST', body, userAgent ? { 'User-Agent': userAgent } : {}), deps);
  return response.json();
}

describe('summary tools are hidden from ChatGPT', () => {
  it('the hidden set holds the three summary tools, and each exists', () => {
    for (const name of SUMMARY_TOOLS) {
      assert.ok(CHATGPT_HIDDEN_TOOLS.has(name), name);
      assert.ok(TOOL_REGISTRY.some((tool) => tool.name === name), `${name} is a real tool`);
    }
  });

  it('tools/list leaves them out for ChatGPT only', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const chatgpt = (await invoke(list, CHATGPT_UA)).result.tools.map((tool) => tool.name);
    const claude = (await invoke(list, 'Claude-User')).result.tools.map((tool) => tool.name);
    const codex = (await invoke(list, 'openai-mcp/1.0.0 (Codex)')).result.tools.map((tool) => tool.name);
    for (const name of SUMMARY_TOOLS) {
      assert.equal(chatgpt.includes(name), false, `ChatGPT: ${name}`);
      assert.equal(CHATGPT_TOOL_LIST_RESPONSE.some((tool) => tool.name === name), false);
      assert.ok(claude.includes(name), `Claude: ${name}`);
      assert.ok(codex.includes(name), `Codex: ${name}`);
    }
  });

  it('calling one from ChatGPT is an unknown tool and fetches nothing', async () => {
    let fetched = 0;
    globalThis.fetch = async () => { fetched += 1; return Response.json({}); };
    for (const name of SUMMARY_TOOLS) {
      const body = await invoke(callBody(name, { country_code: 'DE', headlines: ['a'] }), CHATGPT_UA);
      assert.equal(body.error?.code, -32602, `${name}: ${JSON.stringify(body).slice(0, 200)}`);
      assert.match(body.error.message, new RegExp(`^Unknown tool: ${name}`));
    }
    assert.equal(fetched, 0);
  });

  it('describe_tool does not reveal them to ChatGPT', async () => {
    for (const name of SUMMARY_TOOLS) {
      const body = await invoke(callBody('describe_tool', { tool_name: name }), CHATGPT_UA);
      const result = body.result.structuredContent;
      assert.equal(result.error, 'unknown_tool', name);
      assert.equal(result.available.includes(name), false);
    }
  });

  it('instructions, the agent guide and tool copy sent to ChatGPT name no hidden tool', async () => {
    const hidden = new RegExp(`\\b(?:${SUMMARY_TOOLS.join('|')})\\b`);
    for (const [label, text] of [
      ['instructions', CHATGPT_SERVER_INSTRUCTIONS],
      ['modern instructions', CHATGPT_MODERN_SERVER_INSTRUCTIONS],
      ['guide', CHATGPT_AGENT_GUIDE],
      ...CHATGPT_TOOL_LIST_RESPONSE.map((tool) => [tool.name, JSON.stringify(tool)]),
    ]) assert.doesNotMatch(text, hidden, label);
    // Claude's guide keeps the routing.
    assert.match(AGENT_GUIDE, /get_world_brief for one written summary/);
  });

  it('no prompt sent to ChatGPT names a hidden tool', async () => {
    const list = await invoke({ jsonrpc: '2.0', id: 1, method: 'prompts/list', params: {} }, CHATGPT_UA);
    assert.ok(list.result.prompts.length > 0);
    for (const prompt of list.result.prompts) {
      const args = Object.fromEntries(prompt.arguments.filter((arg) => arg.required).map((arg) => [arg.name, 'DE']));
      const got = await invoke({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: prompt.name, arguments: args } }, CHATGPT_UA);
      const text = JSON.stringify(got.result ?? got.error);
      for (const name of SUMMARY_TOOLS) assert.equal(text.includes(name), false, `${prompt.name} names ${name}`);
    }
    // Claude keeps the country-brief step.
    const claude = await invoke({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'country-briefing', arguments: { iso2: 'DE' } } }, 'Claude-User');
    assert.match(JSON.stringify(claude.result ?? claude.error), /get_country_brief/);
  });
});

describe('news results reach ChatGPT as pointers', () => {
  it('get_news_intelligence drops the LLM brief, its sources and RSS snippets', () => {
    const result = {
      cached_at: '2026-11-13T00:00:00Z',
      data: {
        insights: {
          worldBrief: 'A summary', briefStoryLines: ['line'], worldBriefSources: [{ title: 't' }], briefProvider: 'p', briefModel: 'm',
          topStories: [{ primaryTitle: 'Headline', primarySource: 'Reuters', primaryLink: 'https://x.test/a', snippet: 'Body text' }],
        },
        'gdelt-intel': { topics: [{ articles: [{ title: 'T', url: 'https://x.test/b', source: 'S', date: 'd', image: 'https://x.test/i.jpg' }] }] },
      },
    };
    const out = pointerOnlyNewsResult('get_news_intelligence', result);
    const text = JSON.stringify(out);
    for (const key of ['worldBrief', 'briefStoryLines', 'worldBriefSources', 'briefProvider', 'briefModel', 'snippet', 'image']) {
      assert.equal(text.includes(`"${key}"`), false, key);
    }
    assert.deepEqual(out.data.insights.topStories[0], { primaryTitle: 'Headline', primarySource: 'Reuters', primaryLink: 'https://x.test/a' });
    assert.deepEqual(out.data['gdelt-intel'].topics[0].articles[0], { title: 'T', url: 'https://x.test/b', source: 'S', date: 'd' });
    assert.equal(out.cached_at, result.cached_at);
    // The input is not mutated (the panel cache keeps the full read).
    assert.equal(result.data.insights.worldBrief, 'A summary');
  });

  it('open_news_dashboard drops snippets and tells the view analysis is off', () => {
    const out = pointerOnlyNewsResult('open_news_dashboard', {
      categories: { conflict: { items: [{ source: 'BBC', title: 'H', link: 'https://x.test', publishedAt: 1, snippet: 'Lead paragraph' }] } },
      requestedView: {},
    });
    assert.deepEqual(out.categories.conflict.items[0], { source: 'BBC', title: 'H', link: 'https://x.test', publishedAt: 1 });
    assert.equal(out.headlineAnalysis, false);
  });

  it('intel-history records keep their required summary field, emptied', () => {
    for (const name of ['search_intel_history', 'get_intel_timeline', 'get_similar_events']) {
      const out = pointerOnlyNewsResult(name, { records: [{ title: 'T', summary: 'Publisher text', sourceUrl: 'https://x.test' }], partial: false });
      assert.deepEqual(out.records[0], { title: 'T', summary: '', sourceUrl: 'https://x.test' }, name);
    }
  });

  it('climate news items lose their RSS summary; other climate datasets keep theirs', () => {
    const out = pointerOnlyNewsResult('get_climate_data', {
      data: {
        'news-intelligence': { items: [{ title: 'Heatwave', url: 'https://x.test/c', source: 'Carbon Brief', publishedAt: 1, summary: 'RSS description text' }] },
        anomalies: { summary: 'kept: computed by WorldMonitor' },
      },
    });
    assert.deepEqual(out.data['news-intelligence'].items[0], { title: 'Heatwave', url: 'https://x.test/c', source: 'Carbon Brief', publishedAt: 1 });
    assert.equal(out.data.anomalies.summary, 'kept: computed by WorldMonitor');
  });

  it('fleet body text and stock news summaries go', () => {
    assert.deepEqual(
      pointerOnlyNewsResult('get_country_brief_section', { value: { report: { vessels: [{ name: 'USS X', activityDescription: 'USNI text' }] } } }),
      { value: { report: { vessels: [{ name: 'USS X' }] } } },
    );
    assert.deepEqual(pointerOnlyNewsResult('get_stock_research', { symbol: 'AAPL', newsSummary: 'LLM text', headlines: ['h'] }), { symbol: 'AAPL', headlines: ['h'] });
  });

  it('other tools pass through untouched', () => {
    const result = { data: { summary: 'kept', snippet: 'kept' } };
    assert.equal(pointerOnlyNewsResult('get_market_data', result), result);
    assert.equal(CHATGPT_POINTER_ONLY_TOOLS.has('get_market_data'), false);
  });

  it('a ChatGPT call gets the pointer result; Claude gets the full result', async () => {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /search-intel-history/);
      return Response.json({
        records: [{ id: '1', domain: 'conflict', resource: 'r', country: 'UA', category: 'battle', title: 'Headline', summary: 'Publisher body text', sourceUrl: 'https://x.test/a', occurredAt: 1, ingestedAt: 1, score: 0.9 }],
        query: 'strikes', partial: false, upstreamUnavailable: false,
      });
    };
    const call = callBody('search_intel_history', { query: 'strikes' });
    const chatgpt = await invoke(call, CHATGPT_UA);
    assert.equal(chatgpt.result?.structuredContent?.records?.[0]?.summary, '', JSON.stringify(chatgpt).slice(0, 300));
    assert.equal(chatgpt.result.structuredContent.records[0].title, 'Headline');
    assert.equal(JSON.stringify(chatgpt.result).includes('Publisher body text'), false, 'no body text in any block');

    const claude = await invoke(call, 'Claude-User');
    assert.equal(claude.result.structuredContent.records[0].summary, 'Publisher body text');
  });
});

describe('skills are not offered to ChatGPT', () => {
  // The skills are HTTP recipes for API-key clients: they link the plans page
  // and name the hidden summary tools.
  it('initialize and server/discover leave out the skills extension for ChatGPT only', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
    const extensions = async (ua) => (await invoke(init, ua)).result.capabilities.extensions;
    assert.equal('io.modelcontextprotocol/skills' in await extensions(CHATGPT_UA), false);
    assert.ok('io.modelcontextprotocol/ui' in await extensions(CHATGPT_UA));
    assert.ok('io.modelcontextprotocol/skills' in await extensions('Claude-User'));
    assert.ok('io.modelcontextprotocol/skills' in await extensions('openai-mcp/1.0.0 (Codex)'));
  });

  it('skills/list, skills/get and skill:// reads are refused for ChatGPT only', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'skills/list', params: {} };
    assert.equal((await invoke(list, CHATGPT_UA)).error?.code, -32601);
    const skills = (await invoke(list, 'Claude-User')).result.skills;
    assert.ok(skills.length > 0);
    const uri = skills[0].uri;
    assert.equal((await invoke({ jsonrpc: '2.0', id: 2, method: 'skills/get', params: { uri } }, CHATGPT_UA)).error?.code, -32601);
    const read = { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'skill://fetch-news-digest/SKILL.md' } };
    assert.equal((await invoke(read, CHATGPT_UA)).error?.code, -32602);
    assert.match((await invoke(read, 'Claude-User')).result.contents[0].text, /analyze_news_headlines/);
  });

  it('instructions and the guide ChatGPT reads do not describe skills discovery', () => {
    for (const text of [CHATGPT_SERVER_INSTRUCTIONS, CHATGPT_MODERN_SERVER_INSTRUCTIONS, CHATGPT_AGENT_GUIDE]) {
      assert.doesNotMatch(text, /skills\/list|skill:\/\//);
    }
    assert.match(AGENT_GUIDE, /skills\/list/);
  });
});
