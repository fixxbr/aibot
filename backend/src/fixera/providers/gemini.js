// Google Gemini adapter (generateContent REST API) with inline image data.
import { fetchJson, parseJsonText, ProviderError } from './errors.js';

export function createGeminiProvider({ apiKey, model, baseUrl, vision = true }) {
  return {
    name: 'gemini',
    model,
    capabilities: { vision, structuredOutput: true },
    async generate({ system, messages, jsonSchema, timeoutMs, signal, model: modelOverride }) {
      const useModel = modelOverride || model;
      const { $schema, ...schema } = jsonSchema;
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: m.content.map((p) => (p.type === 'image' ? { inline_data: { mime_type: p.mediaType, data: p.data } } : { text: p.text })),
        })),
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema },
      };
      const data = await fetchJson(`${baseUrl}/models/${encodeURIComponent(useModel)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        timeoutMs,
        signal,
        provider: 'gemini',
      });
      const cand = data.candidates?.[0];
      if (!cand || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(cand.finishReason) || data.promptFeedback?.blockReason) {
        throw new ProviderError('refused', 'gemini declined the request');
      }
      if (cand.finishReason === 'MAX_TOKENS') throw new ProviderError('invalid_output', 'gemini output truncated');
      const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
      return {
        output: parseJsonText(text, 'gemini'),
        model: data.modelVersion || useModel,
        usage: { input_tokens: data.usageMetadata?.promptTokenCount ?? null, output_tokens: data.usageMetadata?.candidatesTokenCount ?? null },
      };
    },

    async complete({ system, messages, json, temperature, maxTokens, timeoutMs, signal, model: modelOverride }) {
      const useModel = modelOverride || model;
      const generationConfig = {};
      if (json) generationConfig.responseMimeType = 'application/json';
      if (temperature != null) generationConfig.temperature = temperature;
      if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
      const body = {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: mergeRoles(messages).map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: m.content.map((p) => (p.type === 'image' ? { inline_data: { mime_type: p.mediaType, data: p.data } } : { text: p.text })),
        })),
        generationConfig,
      };
      const data = await fetchJson(`${baseUrl}/models/${encodeURIComponent(useModel)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        timeoutMs,
        signal,
        provider: 'gemini',
      });
      const cand = data.candidates?.[0];
      if (!cand || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(cand.finishReason) || data.promptFeedback?.blockReason) {
        throw new ProviderError('refused', 'gemini declined the request');
      }
      if (cand.finishReason === 'MAX_TOKENS') throw new ProviderError('invalid_output', 'gemini output truncated');
      const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
      if (!text) throw new ProviderError('invalid_output', 'gemini returned no content');
      return { text, model: data.modelVersion || useModel, requestId: data.responseId || null, usage: { input_tokens: data.usageMetadata?.promptTokenCount ?? null, output_tokens: data.usageMetadata?.candidatesTokenCount ?? null } };
    },
  };
}

// Gemini and Anthropic need alternating turns; merge consecutive messages from the same role.
export function mergeRoles(messages) {
  const out = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last && last.role === m.role) last.content = [...last.content, ...m.content];
    else out.push({ role: m.role, content: [...m.content] });
  }
  return out;
}
