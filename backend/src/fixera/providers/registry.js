// Builds the provider list from environment configuration. API keys stay server-side.
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';

const textOnly = new Set((process.env.FIXERA_TEXT_ONLY_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean));

export function createProvidersFromConfig(cfg) {
  const p = cfg.providers;
  const providers = [];
  if (p.openrouter.apiKey && p.openrouter.model) {
    providers.push(
      createOpenAICompatibleProvider({
        name: 'openrouter',
        apiKey: p.openrouter.apiKey,
        model: p.openrouter.model,
        baseUrl: p.openrouter.baseUrl,
        vision: !textOnly.has(p.openrouter.model),
        extraHeaders: { 'HTTP-Referer': 'https://fixbridge.us', 'X-Title': 'Fixera AI' },
      }),
    );
  }
  if (p.anthropic.apiKey) providers.push(createAnthropicProvider(p.anthropic));
  if (p.openai.apiKey && p.openai.model) {
    providers.push(createOpenAICompatibleProvider({ name: 'openai', apiKey: p.openai.apiKey, model: p.openai.model, baseUrl: p.openai.baseUrl, vision: !textOnly.has(p.openai.model) }));
  }
  if (p.gemini.apiKey && p.gemini.model) {
    providers.push(createGeminiProvider({ apiKey: p.gemini.apiKey, model: p.gemini.model, baseUrl: p.gemini.baseUrl, vision: !textOnly.has(p.gemini.model) }));
  }
  const order = p.order;
  return providers.sort((a, b) => rank(order, a.name) - rank(order, b.name));
}

const rank = (order, name) => (order.includes(name) ? order.indexOf(name) : order.length);
