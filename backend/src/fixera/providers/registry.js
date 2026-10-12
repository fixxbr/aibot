// Builds the provider list from environment configuration. API keys stay server-side.
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';

const textOnly = new Set((process.env.FIXERA_TEXT_ONLY_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean));

/** Human-readable problems with provider settings, shown at startup and by `npm run check`. */
export function providerConfigWarnings(cfg) {
  const p = cfg.providers;
  const w = [];
  const pairs = [['openrouter', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL'], ['openai', 'OPENAI_API_KEY', 'OPENAI_MODEL'], ['gemini', 'GEMINI_API_KEY', 'GEMINI_MODEL']];
  for (const [name, keyVar, modelVar] of pairs) {
    if (p[name].apiKey && !p[name].model) w.push(`${keyVar} is set but ${modelVar} is empty, so ${name} is disabled. Set ${modelVar} to a vision-capable model.`);
    if (!p[name].apiKey && p[name].model) w.push(`${modelVar} is set but ${keyVar} is empty, so ${name} is disabled.`);
  }
  if (!p.openrouter.apiKey && !p.anthropic.apiKey && !p.openai.apiKey && !p.gemini.apiKey) {
    w.push('No AI provider key is set. Add one of OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY.');
  }
  return w;
}

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
  for (const prov of providers) prov.timeoutMs = p[prov.name]?.timeoutMs;
  const order = p.order;
  return providers.sort((a, b) => rank(order, a.name) - rank(order, b.name));
}

const rank = (order, name) => (order.includes(name) ? order.indexOf(name) : order.length);
