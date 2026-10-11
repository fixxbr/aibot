// Optional embedding provider for semantic retrieval. Dimension must match 002_vector.sql.
import { fetchJson } from '../providers/errors.js';

export const EMBEDDING_DIMS = 1536;

export function createEmbedder(config) {
  if (config.embeddings.provider === 'openai' && config.providers.openai.apiKey) {
    const { apiKey, baseUrl } = config.providers.openai;
    return {
      model: config.embeddings.model,
      async embed(texts) {
        const data = await fetchJson(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: config.embeddings.model, input: texts, dimensions: EMBEDDING_DIMS }),
          timeoutMs: 30_000,
          provider: 'openai-embeddings',
        });
        return data.data.map((d) => d.embedding);
      },
    };
  }
  return null;
}

export const toVectorLiteral = (v) => `[${v.join(',')}]`;
