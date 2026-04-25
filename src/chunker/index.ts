import * as path from 'path';
import { type RawChunk } from './types.js';
import { chunkWithTreeSitter } from './treeSitter.js';
import { chunkPython } from './pythonAst.js';
import { chunkFallback } from './fallback.js';

export { type RawChunk, type ChunkMeta } from './types.js';

/** Supported languages that get AST-aware chunking. */
const TREE_SITTER_LANGUAGES = new Set(['typescript', 'javascript', 'tsx', 'jsx']);
const PYTHON_LANGUAGES = new Set(['python']);

/**
 * Derive a simple language key from a file path.
 */
export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    go: 'go',
    java: 'java',
    md: 'markdown',
    txt: 'plaintext',
  };
  return map[ext] ?? ext;
}

/**
 * Dispatch to the appropriate chunker for `filePath`.
 *
 * @param filePath  Absolute path to the source file.
 * @param content   Full text content of the file.
 * @param overlapTokens  Token overlap for the fallback chunker.
 */
export async function chunkFile(
  filePath: string,
  content: string,
  overlapTokens = 40,
): Promise<RawChunk[]> {
  const language = detectLanguage(filePath);

  if (TREE_SITTER_LANGUAGES.has(language)) {
    try {
      return await chunkWithTreeSitter(filePath, content, language);
    } catch {
      // fall through to fallback
    }
  }

  if (PYTHON_LANGUAGES.has(language)) {
    try {
      return await chunkPython(filePath, content);
    } catch {
      // fall through to fallback
    }
  }

  // Markdown / plaintext — paragraph boundaries
  if (language === 'markdown' || language === 'plaintext') {
    return chunkByParagraph(filePath, content, language);
  }

  return chunkFallback(filePath, content, language, overlapTokens);
}

// ---------------------------------------------------------------------------
// Paragraph chunker (Markdown / plaintext)
// ---------------------------------------------------------------------------

function chunkByParagraph(filePath: string, content: string, language: string): RawChunk[] {
  const chunks: RawChunk[] = [];
  const paragraphs = content.split(/\n\n+/);
  let currentLine = 1;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      currentLine += para.split('\n').length;
      continue;
    }

    const lineCount = para.split('\n').length;
    chunks.push({
      content: trimmed,
      meta: {
        filePath,
        startLine: currentLine,
        endLine: currentLine + lineCount - 1,
        language,
        symbols: [],
      },
    });
    currentLine += lineCount;
  }

  return chunks;
}
