// Local text embeddings via @huggingface/transformers (transformers.js).
// The model is downloaded on first use (~120 MB) into ~/.cache/huggingface/.
// Brute-force cosine search over a few thousand chunks is fast enough that
// we don't need a vector index here.

let pipePromise = null;

const MODEL_ID = 'Xenova/multilingual-e5-small';
const MODEL_NAME = 'multilingual-e5-small';

export function getModelName() { return MODEL_NAME; }

export async function getEmbedder() {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Stay completely offline-friendly: only fetch from the HF hub on miss.
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      return pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
    })();
  }
  return pipePromise;
}

/**
 * Returns a normalized Float32Array for the given text.
 * For e5 models, callers should pass `kind` so we apply the conventional
 * "passage:" / "query:" prefix.
 */
export async function embed(text, kind = 'passage') {
  const p = await getEmbedder();
  const prefix = kind === 'query' ? 'query: ' : 'passage: ';
  const out = await p(prefix + text, { pooling: 'mean', normalize: true });
  return out.data; // Float32Array (384 dim)
}

/** Split a long text into overlapping chunks, paragraph-aware. */
export function chunkText(text, { size = 700, overlap = 120, maxChunks = 30 } = {}) {
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paragraphs) {
    if ((cur + '\n\n' + p).length <= size || !cur) {
      cur = cur ? cur + '\n\n' + p : p;
      if (cur.length > size) {
        // Single paragraph overflowed; hard-split it.
        for (let i = 0; i < cur.length; i += size - overlap) {
          chunks.push(cur.slice(i, i + size));
          if (chunks.length >= maxChunks) return chunks;
        }
        cur = '';
      }
    } else {
      chunks.push(cur);
      if (chunks.length >= maxChunks) return chunks;
      cur = p.length > size ? '' : p;
      if (p.length > size) {
        for (let i = 0; i < p.length; i += size - overlap) {
          chunks.push(p.slice(i, i + size));
          if (chunks.length >= maxChunks) return chunks;
        }
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks.slice(0, maxChunks);
}

/** Cosine similarity. Both vectors must already be L2-normalized. */
export function cosine(a, b) {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

export function vecToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToVec(buf) {
  // Copy into a fresh Float32Array so its byteOffset is 0 (better-sqlite3 buffers
  // are not guaranteed to be aligned for typed array views).
  const aligned = new Uint8Array(buf);
  return new Float32Array(aligned.buffer);
}
