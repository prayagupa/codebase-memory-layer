import * as crypto from 'crypto';
import * as path from 'path';
import * as ort from 'onnxruntime-node';
import { type RawChunk } from './chunker/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmbeddedChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  content: string;
  symbols: string[];
  embedding: Float32Array;
  contentHash: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 32;
const EMBEDDING_DIM = 768;

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export class Embedder {
  private session: ort.InferenceSession | null = null;
  private modelPath: string;

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  /**
   * Lazy-load the ONNX inference session.
   */
  async init(): Promise<void> {
    if (this.session) return;
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }

  /**
   * Embed a batch of raw chunks and return `EmbeddedChunk` objects.
   */
  async embedChunks(chunks: RawChunk[]): Promise<EmbeddedChunk[]> {
    await this.init();
    const results: EmbeddedChunk[] = [];

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const embeddings = await this.runInference(batch.map((c) => c.content));

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const contentHash = sha256(chunk.content);
        results.push({
          id: chunkId(chunk.meta.filePath, chunk.meta.startLine),
          filePath: chunk.meta.filePath,
          startLine: chunk.meta.startLine,
          endLine: chunk.meta.endLine,
          language: chunk.meta.language,
          content: chunk.content,
          symbols: chunk.meta.symbols,
          embedding: embeddings[j],
          contentHash,
          updatedAt: Date.now(),
        });
      }
    }

    return results;
  }

  /**
   * Embed a single query string (used at retrieval time).
   */
  async embedQuery(query: string): Promise<Float32Array> {
    await this.init();
    const [embedding] = await this.runInference([query]);
    return embedding;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async runInference(texts: string[]): Promise<Float32Array[]> {
    if (!this.session) throw new Error('Embedder not initialised');

    // Tokenise using a simple whitespace tokeniser as a stand-in.
    // In production this would be replaced by the model's actual tokeniser.
    const { inputIds, attentionMask, maxLen } = tokenise(texts);

    const inputIdsTensor = new ort.Tensor(
      'int64',
      inputIds,
      [texts.length, maxLen],
    );
    const attentionMaskTensor = new ort.Tensor(
      'int64',
      attentionMask,
      [texts.length, maxLen],
    );

    const feeds: Record<string, ort.Tensor> = {
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor,
    };

    const results = await this.session.run(feeds);

    // Extract the pooled output or mean-pool the last_hidden_state.
    const outputKey = Object.keys(results)[0];
    const rawOutput = results[outputKey].data as Float32Array;

    const embeddings: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      const start = i * EMBEDDING_DIM;
      const vec = rawOutput.slice(start, start + EMBEDDING_DIM) as Float32Array;
      embeddings.push(normaliseL2(vec));
    }
    return embeddings;
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

export function chunkId(filePath: string, startLine: number): string {
  return sha256(`${filePath}:${startLine}`);
}

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function normaliseL2(vec: Float32Array): Float32Array {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm) as Float32Array;
}

// ---------------------------------------------------------------------------
// Minimal whitespace-based tokeniser (placeholder for real BPE tokeniser)
// ---------------------------------------------------------------------------

const MAX_SEQ_LEN = 512;
const PAD_ID = 0;
const UNK_ID = 1;

function tokenise(texts: string[]): {
  inputIds: BigInt64Array;
  attentionMask: BigInt64Array;
  maxLen: number;
} {
  // Build vocab on-the-fly (good enough for a local dev tool).
  const vocab = new Map<string, number>();
  const tokenised = texts.map((text) => {
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter(Boolean)
      .slice(0, MAX_SEQ_LEN)
      .map((token) => {
        if (!vocab.has(token)) vocab.set(token, vocab.size + 2);
        return vocab.get(token)!;
      });
  });

  const maxLen = Math.max(1, Math.min(MAX_SEQ_LEN, Math.max(...tokenised.map((t) => t.length))));

  const inputIds = new BigInt64Array(texts.length * maxLen).fill(BigInt(PAD_ID));
  const attentionMask = new BigInt64Array(texts.length * maxLen).fill(BigInt(0));

  for (let i = 0; i < tokenised.length; i++) {
    for (let j = 0; j < tokenised[i].length && j < maxLen; j++) {
      inputIds[i * maxLen + j] = BigInt(tokenised[i][j]);
      attentionMask[i * maxLen + j] = BigInt(1);
    }
  }

  return { inputIds, attentionMask, maxLen };
}
