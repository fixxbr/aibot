// OpenAI Chat Completions adapter. Also used for OpenRouter, which exposes the same API
// and routes to many model vendors behind one key.
import { fetchJson, parseJsonText, ProviderError } from './errors.js';

export function createOpenAICompatibleProvider({ name, apiKey, model, baseUrl, vision = true, extraHeaders = {} }) {
  return {
    name,
    model,
    capabilities: { vision, structuredOutput: true },
    async generate({ system, messages, jsonSchema, timeoutMs, signal, model: modelOverride }) {
      const { $schema, ...schema } = jsonSchema;
      const body = {
        model: modelOverride || model,
        messages: [{ role: 'system', content: system }, ...messages.map(toOpenAIMessage)],
        response_format: { type: 'json_schema', json_schema: { name: 'fixera_assessment', strict: true, schema } },
      };
      const data = await fetchJson(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: JSON.stringify(body),
        timeoutMs,
        signal,
        provider: name,
      });
      const choice = data.choices?.[0];
      if (choice?.message?.refusal) throw new ProviderError('refused', `${name} declined the request`);
      if (choice?.finish_reason === 'length') throw new ProviderError('invalid_output', `${name} output truncated`);
      return {
        output: parseJsonText(choice?.message?.content, name),
        model: data.model || model,
        usage: { input_tokens: data.usage?.prompt_tokens ?? null, output_tokens: data.usage?.completion_tokens ?? null },
      };
    },

    // Raw completion for the engine gateway: caller-defined prompt, text out.
    async complete({ system, messages, json, temperature, maxTokens, timeoutMs, signal, model: modelOverride }) {
      const body = {
        model: modelOverride || model,
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map(toOpenAIMessage)],
      };
      if (json) body.response_format = { type: 'json_object' };
      if (temperature != null) body.temperature = temperature;
      if (maxTokens) body.max_tokens = maxTokens;
      const data = await fetchJson(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: JSON.stringify(body),
        timeoutMs,
        signal,
        provider: name,
      });
      const choice = data.choices?.[0];
      if (choice?.message?.refusal) throw new ProviderError('refused', `${name} declined the request`);
      if (choice?.finish_reason === 'length') throw new ProviderError('invalid_output', `${name} output truncated`);
      const text = choice?.message?.content;
      if (!text) throw new ProviderError('invalid_output', `${name} returned no content`);
      return { text, model: data.model || body.model, requestId: data.id || null, usage: { input_tokens: data.usage?.prompt_tokens ?? null, output_tokens: data.usage?.completion_tokens ?? null } };
    },
  };
}

function toOpenAIMessage(m) {
  return {
    role: m.role,
    content: m.content.map((part) =>
      part.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}`, detail: 'high' } }
        : { type: 'text', text: part.text },
    ),
  };
}
