import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { VectorStore } from '../src/vectorStore.js';
import { type EmbeddedChunk } from '../src/embedder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<EmbeddedChunk> = {}): EmbeddedChunk {
  const embedding = new Float32Array(768).fill(0);
  embedding[0] = 1; // unit vector in dimension 0
  return {
    id: 'abc123',
    filePath: '/project/src/foo.ts',
    startLine: 1,
    endLine: 10,
    language: 'typescript',
    content: 'function hello() { return "world"; }',
    symbols: ['hello'],
    embedding,
    contentHash: 'deadbeef',
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VectorStore
// ---------------------------------------------------------------------------

describe('VectorStore', () => {
  let store: VectorStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
    store = new VectorStore(tmpDir);
    store.open();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts with zero chunks', () => {
    expect(store.count()).toBe(0);
  });

  it('upserts a chunk and increments count', () => {
    store.upsert(makeChunk());
    expect(store.count()).toBe(1);
  });

  it('upsert is idempotent for the same id', () => {
    store.upsert(makeChunk());
    store.upsert(makeChunk());
    expect(store.count()).toBe(1);
  });

  it('stores and retrieves content hash', () => {
    const chunk = makeChunk({ id: 'test-id', contentHash: 'myhash' });
    store.upsert(chunk);
    expect(store.getContentHash('test-id')).toBe('myhash');
  });

  it('returns undefined for unknown id', () => {
    expect(store.getContentHash('unknown')).toBeUndefined();
  });

  it('deletes by file path', () => {
    store.upsert(makeChunk({ id: 'id1', filePath: '/a/b.ts' }));
    store.upsert(makeChunk({ id: 'id2', filePath: '/a/c.ts' }));
    store.deleteByFile('/a/b.ts');
    expect(store.count()).toBe(1);
  });

  it('search returns results in descending score order', () => {
    // Insert two chunks: one whose embedding matches the query, one that doesn't.
    const queryVec = new Float32Array(768).fill(0);
    queryVec[0] = 1; // query points in dimension 0

    const matchEmb = new Float32Array(768).fill(0);
    matchEmb[0] = 1; // cosine similarity = 1

    const noMatchEmb = new Float32Array(768).fill(0);
    noMatchEmb[1] = 1; // cosine similarity = 0

    store.upsert(makeChunk({ id: 'match', embedding: matchEmb }));
    store.upsert(makeChunk({ id: 'no-match', embedding: noMatchEmb }));

    const results = store.search(queryVec, 2);
    expect(results[0].chunk.id).toBe('match');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
