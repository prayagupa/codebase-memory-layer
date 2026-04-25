import { type RawChunk } from './types.js';

const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Sliding-window fallback chunker.
 *
 * Splits `content` into windows of approximately `windowTokens` tokens with
 * `overlapTokens` tokens of overlap between consecutive windows.
 *
 * Used for languages without a dedicated AST chunker (Go, Java, etc.) or when
 * the AST chunker throws.
 */
export function chunkFallback(
  filePath: string,
  content: string,
  language: string,
  overlapTokens = 40,
  windowTokens = 200,
): RawChunk[] {
  const windowChars = windowTokens * APPROX_CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * APPROX_CHARS_PER_TOKEN;
  const lines = content.split('\n');

  // Build a char-offset → line-number lookup for fast line resolution.
  const lineStartOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStartOffsets.push(offset);
    offset += line.length + 1; // +1 for '\n'
  }

  function charOffsetToLine(charOffset: number): number {
    let lo = 0;
    let hi = lineStartOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStartOffsets[mid] <= charOffset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo + 1; // 1-based
  }

  const chunks: RawChunk[] = [];
  let start = 0;

  while (start < content.length) {
    const end = Math.min(start + windowChars, content.length);
    const chunkContent = content.slice(start, end).trim();

    if (chunkContent.length > 0) {
      chunks.push({
        content: chunkContent,
        meta: {
          filePath,
          startLine: charOffsetToLine(start),
          endLine: charOffsetToLine(end - 1),
          language,
          symbols: [],
        },
      });
    }

    if (end >= content.length) break;
    start = end - overlapChars;
  }

  return chunks;
}
