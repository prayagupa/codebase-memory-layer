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
  symbols: string;
  content_hash: string;
  updated_at: number;
}

export interface SearchResult {
  chunk: StoredChunk;
  score: number;
}

// ---------------------------------------------------------------------------
// VectorStore — backed by sql.js (pure-WASM SQLite, no native build needed)
// ---------------------------------------------------------------------------

export class VectorStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db!: any;
  private dbPath: string;

  constructor(storagePath: string) {
    this.dbPath = path.join(storagePath, 'memory.db');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async open(): Promise<void> {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    // sql.js factory is async (loads WASM).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js') as (opts?: object) => Promise<any>;
    const wasmDir = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist');
    const SQL = await initSqlJs({ locateFile: (f: string) => path.join(wasmDir, f) });

    if (fs.existsSync(this.dbPath)) {
      const buf = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buf);
    } else {
      this.db = new SQL.Database();
    }

    this.applySchema();
  }

  save(): void {
    const data: Uint8Array = this.db.export();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  close(): void {
    this.save();
    this.db?.close();
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  upsert(chunk: EmbeddedChunk): void {
    this.db.run(
      `INSERT INTO chunks (id,file_path,start_line,end_line,language,content,symbols,content_hash,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         file_path=excluded.file_path,start_line=excluded.start_line,
         end_line=excluded.end_line,language=excluded.language,content=excluded.content,
         symbols=excluded.symbols,content_hash=excluded.content_hash,updated_at=excluded.updated_at`,
      [chunk.id, chunk.filePath, chunk.startLine, chunk.endLine, chunk.language,
       chunk.content, JSON.stringify(chunk.symbols), chunk.contentHash, chunk.updatedAt],
    );
    this.db.run(
      `INSERT INTO chunk_embeddings (id,embedding) VALUES (?,?)
       ON CONFLICT(id) DO UPDATE SET embedding=excluded.embedding`,
      [chunk.id, float32ToUint8(chunk.embedding)],
    );
  }

  upsertMany(chunks: EmbeddedChunk[]): void {
    for (const c of chunks) this.upsert(c);
    this.save();
  }

  deleteByFile(filePath: string): void {
    this.db.run('DELETE FROM chunks WHERE file_path=?', [filePath]);
    this.save();
  }

  deleteStaleChunks(filePath: string, updatedAt: number): void {
    this.db.run('DELETE FROM chunks WHERE file_path=? AND updated_at<?', [filePath, updatedAt]);
    this.save();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getContentHash(id: string): string | undefined {
    const res = this.db.exec('SELECT content_hash FROM chunks WHERE id=?', [id]);
    if (!res.length || !res[0].values.length) return undefined;
    return res[0].values[0][0] as string;
  }

  search(queryEmbedding: Float32Array, topK: number): SearchResult[] {
    const embRes = this.db.exec('SELECT id,embedding FROM chunk_embeddings');
    if (!embRes.length) return [];

    const rows: [string, Uint8Array][] = embRes[0].values;
    const scored = rows.map(([id, blob]) => ({
      id,
      score: dotProduct(queryEmbedding, uint8ToFloat32(blob)),
    }));
    scored.sort((a, b) => b.score - a.score);
    const topIds = scored.slice(0, topK).map((s) => s.id);
    if (!topIds.length) return [];

    const ph = topIds.map(() => '?').join(',');
    const chunkRes = this.db.exec(
      `SELECT id,file_path,start_line,end_line,language,content,symbols,content_hash,updated_at
       FROM chunks WHERE id IN (${ph})`,
      topIds,
    );
    if (!chunkRes.length) return [];

    const cols: string[] = chunkRes[0].columns;
    const chunkMap = new Map<string, StoredChunk>();
    for (const row of chunkRes[0].values as unknown[][]) {
      const obj: Record<string, unknown> = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      chunkMap.set(obj['id'] as string, obj as unknown as StoredChunk);
    }

    return scored.slice(0, topK).flatMap((s) => {
      const chunk = chunkMap.get(s.id);
      return chunk ? [{ chunk, score: s.score }] : [];
    });
  }

  count(): number {
    const res = this.db.exec('SELECT COUNT(*) FROM chunks');
    if (!res.length) return 0;
    return res[0].values[0][0] as number;
  }

  countByFile(): { filePath: string; count: number }[] {
    const res = this.db.exec(
      'SELECT file_path, COUNT(*) AS cnt FROM chunks GROUP BY file_path ORDER BY cnt DESC',
    );
    if (!res.length) return [];
    return (res[0].values as [string, number][]).map(([fp, cnt]) => ({
      filePath: fp,
      count: cnt,
    }));
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private applySchema(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
      symbols TEXT NOT NULL DEFAULT '[]', content_hash TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_fp ON chunks(file_path)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_ua ON chunks(updated_at)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS chunk_embeddings (
      id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL
    )`);
  }
}

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

function float32ToUint8(arr: Float32Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function uint8ToFloat32(buf: Uint8Array): Float32Array {
  const aligned = new ArrayBuffer(buf.byteLength);
  new Uint8Array(aligned).set(buf);
  return new Float32Array(aligned);
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
