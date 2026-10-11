-- Optional semantic retrieval. Applied only when the pgvector extension can be created
-- (Neon supports it). Without it, Fixera falls back to PostgreSQL full-text search.
-- @requires-extension vector
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT;
