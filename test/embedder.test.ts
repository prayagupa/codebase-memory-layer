import { describe, it, expect } from 'vitest';
import { sha256, chunkId } from '../src/embedder.js';

// ---------------------------------------------------------------------------
// sha256
// ---------------------------------------------------------------------------

describe('sha256', () => {
  it('returns a 64-character hex string', () => {
    expect(sha256('hello world')).toHaveLength(64);
    expect(sha256('hello world')).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic', () => {
    expect(sha256('test')).toBe(sha256('test'));
  });

  it('differs for different inputs', () => {
    expect(sha256('foo')).not.toBe(sha256('bar'));
  });
});

// ---------------------------------------------------------------------------
// chunkId
// ---------------------------------------------------------------------------

describe('chunkId', () => {
  it('is deterministic', () => {
    expect(chunkId('/src/foo.ts', 42)).toBe(chunkId('/src/foo.ts', 42));
  });

  it('differs for different file paths', () => {
    expect(chunkId('/src/foo.ts', 1)).not.toBe(chunkId('/src/bar.ts', 1));
  });

  it('differs for different start lines', () => {
    expect(chunkId('/src/foo.ts', 1)).not.toBe(chunkId('/src/foo.ts', 2));
  });

  it('returns a 64-character hex string', () => {
    expect(chunkId('/src/foo.ts', 10)).toHaveLength(64);
  });
});
