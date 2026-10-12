// Anthropic Claude adapter (official SDK). Images are sent as base64 image blocks.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ProviderError, parseJsonText } from './errors.js';
import { mergeRoles } from './gemini.js';

export function createAnthropicProvider(cfg) {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, maxRetries: 1 });
  return {
    name: 'anthropic',
    model: cfg.model,
    capabilities: { vision: true, structuredOutput: true },
    async generate({ system, messages, schema, timeoutMs, signal, model }) {
      const format = zodOutputFormat(schema);
      const params = {
        model: model || cfg.model,
        max_tokens: 32000,
        system,
        messages: messages.map(toAnthropicMessage),
        output_config: { effort: cfg.effort, format: { type: format.type, schema: format.schema } },
      };
      // Server-side refusal fallback: a declined request is re-run on Anthropic's recommended
      // fallback model inside the same call. Disable with ANTHROPIC_SERVER_FALLBACKS=false.
      if (cfg.serverFallbacks) {
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
      }
      let message;
      try {
        message = await client.beta.messages.stream(params, { timeout: timeoutMs, signal }).finalMessage();
      } catch (err) {
        throw mapError(err);
      }
      if (message.stop_reason === 'refusal') throw new ProviderError('refused', 'anthropic declined the request');
      if (message.stop_reason === 'max_tokens') throw new ProviderError('invalid_output', 'anthropic output truncated');
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return {
        output: parseJsonText(text, 'anthropic'),
        model: message.model,
        usage: { input_tokens: message.usage?.input_tokens ?? null, output_tokens: message.usage?.output_tokens ?? null },
      };
    },

    // Raw completion. Current Claude models reject sampling parameters, so temperature is not
    // forwarded; JSON is requested through the caller's prompt and checked by the engine.
    async complete({ system, messages, json, maxTokens, timeoutMs, signal, model }) {
      const params = {
        model: model || cfg.model,
        max_tokens: maxTokens || 16000,
        ...(system ? { system: json ? `${system}\n\nRespond with a single valid JSON object and nothing else.` : system } : json ? { system: 'Respond with a single valid JSON object and nothing else.' } : {}),
        messages: mergeRoles(messages).map(toAnthropicMessage),
        output_config: { effort: cfg.effort },
      };
      if (cfg.serverFallbacks) {
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
      }
      let message;
      try {
        message = await client.beta.messages.stream(params, { timeout: timeoutMs, signal }).finalMessage();
      } catch (err) {
        throw mapError(err);
      }
      if (message.stop_reason === 'refusal') throw new ProviderError('refused', 'anthropic declined the request');
      if (message.stop_reason === 'max_tokens') throw new ProviderError('invalid_output', 'anthropic output truncated');
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text) throw new ProviderError('invalid_output', 'anthropic returned no content');
      return { text, model: message.model, requestId: message.id || null, usage: { input_tokens: message.usage?.input_tokens ?? null, output_tokens: message.usage?.output_tokens ?? null } };
    },
  };
}

function toAnthropicMessage(m) {
  return {
    role: m.role,
    content: m.content.map((part) =>
      part.type === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }
        : { type: 'text', text: part.text },
    ),
  };
}

function mapError(err) {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'anthropic timed out', { retryable: true });
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', 'anthropic rejected credentials', { status: err.status });
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('rate_limited', 'anthropic rate limited', { retryable: true, status: 429 });
  if (err instanceof Anthropic.InternalServerError) return new ProviderError('unavailable', 'anthropic unavailable', { retryable: true, status: err.status });
  if (err instanceof Anthropic.BadRequestError) return new ProviderError('bad_request', `anthropic rejected request: ${err.message}`, { status: 400 });
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('network', 'anthropic network error', { retryable: true });
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('timeout', 'anthropic request aborted', { retryable: true });
  if (err instanceof Anthropic.APIError) return new ProviderError('unavailable', `anthropic error: ${err.message}`, { retryable: true, status: err.status });
  return err;
}
