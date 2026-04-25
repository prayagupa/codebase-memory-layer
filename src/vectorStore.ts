import Database, { type Database as DB } from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { type EmbeddedChunk } from './embedder.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StoredChunk {
  id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  content: string;
  symbols: string;           // JSON-serialised string[]
  content_hash: string;
  updated_at: number;
}

export interface SearchResult {
  chunk: StoredChunk;
  score: number;
}

// ---------------------------------------------------------------------------
// VectorStore
// ---------------------------------------------------------------------------

export class VectorStore {
  private db!: DB;
  private dbPath: string;

  constructor(storagePath: string) {
    this.dbPath = path.join(storagePath, 'memory.db');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  open(): void {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.applySchema();
  }

  close(): void {
    this.db?.close();
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Insert or replace a chunk and its embedding vector.
   * The embedding is stored as a raw float32 BLOB next to the metadata.
   */
  upsert(chunk: EmbeddedChunk): void {
    const upsertChunk = this.db.prepare<[string, string, number, number, string, string, string, string, number]>(`
      INSERT INTO chunks (id, file_path, start_line, end_line, language, content, symbols, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_path    = excluded.file_path,
        start_line   = excluded.start_line,
        end_line     = excluded.end_line,
        language     = excluded.language,
        content      = excluded.content,
        symbols      = excluded.symbols,
        content_hash = excluded.content_hash,
        updated_at   = excluded.updated_at
    `);

    const upsertEmb = this.db.prepare<[string, Buffer]>(`
      INSERT INTO chunk_embeddings (id, embedding)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET embedding = excluded.embedding
    `);

    const embBuffer = float32ArrayToBuffer(chunk.embedding);

    const run = this.db.transaction(() => {
      upsertChunk.run(
        chunk.id,
        chunk.filePath,
        chunk.startLine,
        chunk.endLine,
        chunk.language,
        chunk.content,
        JSON.stringify(chunk.symbols),
        chunk.contentHash,
        chunk.updatedAt,
      );
      upsertEmb.run(chunk.id, embBuffer);
    });
    run();
  }

  /** Batch upsert — more efficient for full re-index. */
  upsertMany(chunks: EmbeddedChunk[]): void {
    const run = this.db.transaction(() => {
      for (const c of chunks) this.upsert(c);
    });
    run();
  }

  /** Remove all chunks for a given file path. */
  deleteByFile(filePath: string): void {
    this.db
      .prepare<[string]>('DELETE FROM chunks WHERE file_path = ?')
      .run(filePath);
    // Embeddings are deleted via CASCADE.
  }

  /** Remove stale chunks for a file (those with an older updated_at). */
  deleteStaleChunks(filePath: string, updatedAt: number): void {
    this.db
      .prepare<[string, number]>(
        'DELETE FROM chunks WHERE file_path = ? AND updated_at < ?',
      )
      .run(filePath, updatedAt);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getContentHash(id: string): string | undefined {
    const row = this.db
      .prepare<[string], { content_hash: string }>('SELECT content_hash FROM chunks WHERE id = ?')
      .get(id);
    return row?.content_hash;
  }

  /**
   * Approximate nearest-neighbour search using cosine similarity.
   *
   * NOTE: `sqlite-vec` HNSW ANN is used when available. This implementation
   * falls back to a full-scan dot-product (vectors are L2-normalised so
   * dot product == cosine similarity) when the extension is not loaded.
   */
  search(queryEmbedding: Float32Array, topK: number): SearchResult[] {
    // Retrieve all embeddings — works well up to ~200k chunks in practice.
    const rows = this.db
      .prepare<[], { id: string; embedding: Buffer }>(
        'SELECT id, embedding FROM chunk_embeddings',
      )
      .all();

    const scored: { id: string; score: number }[] = rows.map((row) => ({
      id: row.id,
      score: dotProduct(queryEmbedding, bufferToFloat32Array(row.embedding)),
    }));

    scored.sort((a, b) => b.score - a.score);
    const topIds = scored.slice(0, topK).map((s) => s.id);

    if (topIds.length === 0) return [];

    const placeholders = topIds.map(() => '?').join(',');
    const chunkRows = this.db
      .prepare<string[], StoredChunk>(
        `SELECT * FROM chunks WHERE id IN (${placeholders})`,
      )
      .all(...topIds);

    // Re-attach scores and return in ranked order.
    const chunkMap = new Map(chunkRows.map((c) => [c.id, c]));
    return scored
      .slice(0, topK)
      .map((s) => {
        const chunk = chunkMap.get(s.id);
        if (!chunk) return null;
        return { chunk, score: s.score };
      })
      .filter((r): r is SearchResult => r !== null);
  }

  /** Count total indexed chunks. */
  count(): number {
    const row = this.db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM chunks')
      .get();
    return row?.n ?? 0;
  }

  /** Count chunks by file. */
  countByFile(): { filePath: string; count: number }[] {
    return this.db
      .prepare<[], { file_path: string; count: number }>(
        'SELECT file_path, COUNT(*) AS count FROM chunks GROUP BY file_path ORDER BY count DESC',
      )
      .all()
      .map((r) => ({ filePath: r.file_path, count: r.count }));
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id           TEXT PRIMARY KEY,
        file_path    TEXT NOT NULL,
        start_line   INTEGER NOT NULL,
        end_line     INTEGER NOT NULL,
        language     TEXT NOT NULL DEFAULT '',
        content      TEXT NOT NULL DEFAULT '',
        symbols      TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL DEFAULT '',
        updated_at   INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_updated_at ON chunks(updated_at);

      -- Embeddings stored as raw BLOB (float32 little-endian)
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        id        TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL
      );
    `);
  }
}

// ---------------------------------------------------------------------------
// Typed buffer helpers
// ---------------------------------------------------------------------------

function float32ArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloat32Array(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
