'use strict';

const { buildGenericLlmProvider, isGenericLlmSelected } = require('../shared/generic-llm-provider.mjs');

function getWidgetModelStatus(env = process.env) {
  const generic = isGenericLlmSelected(env);
  const configured = generic ? Boolean(buildGenericLlmProvider(env)) : Boolean(env.ANTHROPIC_API_KEY?.trim());
  return { provider: generic ? 'generic' : 'anthropic', model: generic ? env.LLM_MODEL : undefined, modelConfigured: configured, genericConfigured: generic && configured };
}

function textContent(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
}

function openAiMessages(system, messages) {
  const result = [];
  if (system) result.push({ role: 'system', content: textContent(system) });
  for (const message of messages || []) {
    if (!['user', 'assistant'].includes(message.role)) throw new Error('Unsupported widget message role');
    if (typeof message.content === 'string') {
      result.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = message.content || [];
    const text = textContent(blocks);
    if (message.role === 'assistant') {
      const toolCalls = blocks.filter(block => block.type === 'tool_use').map(block => ({
        id: block.id, type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      }));
      result.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // OpenAI requires one tool message per result, after the assistant's calls.
      for (const block of blocks.filter(block => block.type === 'tool_result')) {
        result.push({ role: 'tool', tool_call_id: block.tool_use_id, content: textContent(block.content) });
      }
      if (text) result.push({ role: 'user', content: text });
    }
  }
  return result;
}

/** Adapt only the text/tool subset used by the widget loop, without cloud fallback. */
function createGenericWidgetClient({ env = process.env, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const provider = buildGenericLlmProvider(env);
  if (!provider) throw new Error('Generic widget model is not configured');
  return { messages: { create: async (request, { signal } = {}) => {
    signal?.throwIfAborted();
    const tools = request.tools?.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }));
    const response = await fetchImpl(provider.apiUrl, {
      method: 'POST', headers: provider.headers(), signal,
      redirect: 'error',
      body: JSON.stringify({
        model: provider.model,
        messages: openAiMessages(request.system, request.messages),
        max_tokens: request.max_tokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(tools?.length ? { tools, tool_choice: request.tool_choice?.type === 'none' ? 'none' : 'auto' } : {}),
      }),
    });
    if (!response.ok) {
      const error = new Error(`Generic widget model returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const body = await response.json();
    const choice = body?.choices?.[0];
    if (!choice?.message) throw new Error('Generic widget model returned no message');
    const content = [];
    const text = textContent(choice.message.content);
    if (text) content.push({ type: 'text', text });
    for (const call of choice.message.tool_calls || []) {
      if (call.type !== 'function' || !call.id || !call.function?.name) throw new Error('Invalid widget tool call');
      let input;
      try { input = JSON.parse(call.function.arguments); } catch { throw new Error('Invalid widget tool arguments'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid widget tool arguments');
      content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
    }
    // Keep truncation authoritative: incomplete tool arguments must never execute.
    const stopReason = choice.finish_reason === 'length' ? 'max_tokens'
      : choice.finish_reason === 'content_filter' ? 'refusal'
        : content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    return {
      model: body.model || provider.model, content, stop_reason: stopReason,
      usage: { input_tokens: body.usage?.prompt_tokens || 0, output_tokens: body.usage?.completion_tokens || 0 },
    };
  } } };
}

module.exports = { createGenericWidgetClient, getWidgetModelStatus };
