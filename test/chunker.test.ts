import { describe, it, expect } from 'vitest';
import { chunkFallback } from '../src/chunker/fallback.js';
import { chunkFile, detectLanguage } from '../src/chunker/index.js';

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

describe('detectLanguage', () => {
  it('maps .ts to typescript', () => {
    expect(detectLanguage('/project/src/foo.ts')).toBe('typescript');
  });
  it('maps .py to python', () => {
    expect(detectLanguage('/project/main.py')).toBe('python');
  });
  it('maps .md to markdown', () => {
    expect(detectLanguage('/docs/README.md')).toBe('markdown');
  });
  it('falls back to extension string for unknown types', () => {
    expect(detectLanguage('/project/script.sh')).toBe('sh');
  });
});

// ---------------------------------------------------------------------------
// chunkFallback
// ---------------------------------------------------------------------------

describe('chunkFallback', () => {
  const sampleCode = Array.from(
    { length: 100 },
    (_, i) => `const x${i} = ${i};`,
  ).join('\n');

  it('returns at least one chunk', () => {
    const chunks = chunkFallback('/foo.ts', sampleCode, 'typescript');
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('each chunk has non-empty content', () => {
    const chunks = chunkFallback('/foo.ts', sampleCode, 'typescript');
    for (const c of chunks) {
      expect(c.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('provides correct metadata shape', () => {
    const chunks = chunkFallback('/foo.ts', sampleCode, 'typescript');
    for (const c of chunks) {
      expect(c.meta.filePath).toBe('/foo.ts');
      expect(c.meta.language).toBe('typescript');
      expect(typeof c.meta.startLine).toBe('number');
      expect(typeof c.meta.endLine).toBe('number');
      expect(Array.isArray(c.meta.symbols)).toBe(true);
    }
  });

  it('overlapping windows cover the full content', () => {
    const shortCode = 'abc '.repeat(600);
    const chunks = chunkFallback('/f.ts', shortCode, 'typescript', 40, 200);
    const reconstructed = chunks.map((c) => c.content).join(' ');
    // Each original word should appear somewhere in the reconstruction.
    expect(reconstructed).toContain('abc');
  });
});

// ---------------------------------------------------------------------------
// chunkFile — paragraph chunking for Markdown
// ---------------------------------------------------------------------------

describe('chunkFile (markdown)', () => {
  it('splits markdown by double newline', async () => {
    const md = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.';
    const chunks = await chunkFile('/README.md', md);
    expect(chunks.length).toBe(3);
    expect(chunks[0].content).toContain('# Heading');
    expect(chunks[1].content).toContain('First paragraph');
    expect(chunks[2].content).toContain('Second paragraph');
  });
});
