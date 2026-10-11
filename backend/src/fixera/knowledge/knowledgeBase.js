// Knowledge Base: reviewed, reusable repair knowledge. Only approved documents are ever
// retrieved for homeowner assessments. Private property data never lives here.

import { hasVectorSupport } from '../../db/migrate.js';
import { toVectorLiteral } from './embeddings.js';

const STOP = new Set('the a an and or but of to in on at for with is are was were be been it its this that my our your i we you they he she them there here not no yes do does did have has had from by as so if when then than too very can could would should will just about into over under after before again also some any all more most other such only own same few'.split(' '));

export function chunkText(text, maxChars = 1200) {
  const sections = [];
  let heading = null;
  let buf = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ heading, content: body });
    buf = [];
  };
  for (const line of String(text).split(/\r?\n/)) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      flush();
      heading = h[1].trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  // Split long sections on paragraph boundaries.
  const chunks = [];
  for (const s of sections) {
    let cur = '';
    for (const para of s.content.split(/\n\s*\n/)) {
      if (cur && (cur.length + para.length) > maxChars) {
        chunks.push({ heading: s.heading, content: cur.trim() });
        cur = '';
      }
      cur += (cur ? '\n\n' : '') + para;
    }
    if (cur.trim()) chunks.push({ heading: s.heading, content: cur.trim() });
  }
  return chunks;
}

export function keywordQuery(text) {
  const words = [...new Set(String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter((w) => !STOP.has(w)).slice(0, 30);
  return words.join(' | ');
}

export function createKnowledgeBase({ db, embedder }) {
  let vectorReady;
  const vectorEnabled = async () => {
    if (!embedder) return false;
    if (vectorReady === undefined) vectorReady = await hasVectorSupport(db);
    return vectorReady;
  };

  async function ingest({ title, sourceType, sourceRef, category, equipmentType, brand, modelPattern, text, createdBy, reviewState = 'draft' }) {
    const chunks = chunkText(text);
    if (!chunks.length) throw new Error('Document has no content');
    let embeddings = null;
    if (await vectorEnabled()) embeddings = await embedder.embed(chunks.map((c) => `${title}\n${c.heading || ''}\n${c.content}`));
    return db.tx(async (q) => {
      const { rows } = await q.query(
        `INSERT INTO knowledge_documents (title, source_type, source_ref, category, equipment_type, brand, model_pattern, review_state, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [title, sourceType, sourceRef || null, category || null, equipmentType || null, brand || null, modelPattern || null, reviewState, createdBy || null],
      );
      const doc = rows[0];
      for (const [i, c] of chunks.entries()) {
        const tsvText = [title, equipmentType, brand, c.heading, c.content].filter(Boolean).join(' ');
        if (embeddings) {
          await q.query(
            `INSERT INTO knowledge_chunks (document_id, seq, heading, content, tsv, embedding, embedding_model)
             VALUES ($1,$2,$3,$4,to_tsvector('english',$5),$6::vector,$7)`,
            [doc.id, i + 1, c.heading, c.content, tsvText, toVectorLiteral(embeddings[i]), embedder.model],
          );
        } else {
          await q.query(
            `INSERT INTO knowledge_chunks (document_id, seq, heading, content, tsv) VALUES ($1,$2,$3,$4,to_tsvector('english',$5))`,
            [doc.id, i + 1, c.heading, c.content, tsvText],
          );
        }
      }
      return { ...doc, chunk_count: chunks.length };
    });
  }

  async function setReviewState(documentId, state, reviewerId) {
    const { rows } = await db.query(
      `UPDATE knowledge_documents SET review_state = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1 RETURNING *`,
      [documentId, state, reviewerId],
    );
    return rows[0] || null;
  }

  /** Hybrid retrieval over approved documents: full-text always, vectors when available. */
  async function retrieve({ query, category, equipmentType, brand, limit = 6 }) {
    const kw = keywordQuery([query, equipmentType, brand].filter(Boolean).join(' '));
    const results = new Map();
    const fuse = (rows, weight) =>
      rows.forEach((r, rank) => {
        const prev = results.get(r.id) || { ...r, score: 0 };
        prev.score += weight / (60 + rank);
        results.set(r.id, prev);
      });
    const filter = `d.review_state = 'approved' AND (d.category IS NULL OR d.category = $2)`;
    if (kw) {
      const { rows } = await db.query(
        `SELECT k.id, k.heading, k.content, d.id AS document_id, d.title, d.source_type, d.source_ref, d.brand, d.equipment_type,
                ts_rank_cd(k.tsv, to_tsquery('english', $1)) +
                  CASE WHEN $3::text IS NOT NULL AND d.brand ILIKE $3 THEN 0.5 ELSE 0 END AS rank
           FROM knowledge_chunks k JOIN knowledge_documents d ON d.id = k.document_id
          WHERE ${filter} AND k.tsv @@ to_tsquery('english', $1)
          ORDER BY rank DESC LIMIT $4`,
        [kw, category, brand || null, limit * 2],
      );
      fuse(rows, 1);
    }
    if (await vectorEnabled()) {
      const [emb] = await embedder.embed([query]);
      const { rows } = await db.query(
        `SELECT k.id, k.heading, k.content, d.id AS document_id, d.title, d.source_type, d.source_ref, d.brand, d.equipment_type
           FROM knowledge_chunks k JOIN knowledge_documents d ON d.id = k.document_id
          WHERE ${filter} AND k.embedding IS NOT NULL
          ORDER BY k.embedding <=> $1::vector LIMIT $3`,
        [toVectorLiteral(emb), category, limit * 2],
      );
      fuse(rows, 1);
    }
    return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ rank, score, ...r }) => r);
  }

  return { ingest, setReviewState, retrieve };
}
