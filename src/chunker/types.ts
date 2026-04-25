/**
 * Chunk metadata carried alongside the raw content string.
 */
export interface ChunkMeta {
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  symbols: string[];
}

export interface RawChunk {
  content: string;
  meta: ChunkMeta;
}
