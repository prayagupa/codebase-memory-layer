import * as vscode from 'vscode';
import { Embedder } from './embedder.js';
import { VectorStore, type StoredChunk, type SearchResult } from './vectorStore.js';
import { type MemoryLayerConfig } from './config.js';

// ---------------------------------------------------------------------------
// Retrieval result type (public-facing)
// ---------------------------------------------------------------------------

export interface RetrievalResult {
  chunk: StoredChunk;
  score: number;
}

// ---------------------------------------------------------------------------
// RetrievalEngine
// ---------------------------------------------------------------------------

const RECENCY_BOOST = 0.05;
const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class RetrievalEngine {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly config: MemoryLayerConfig,
  ) {}

  /**
   * Build a composite query from multiple editor signals and retrieve the
   * top-K most semantically relevant chunks.
   */
  async retrieve(userMessage: string): Promise<RetrievalResult[]> {
    const query = this.buildQuery(userMessage);
    const queryEmbedding = await this.embedder.embedQuery(query);

    let results = this.store.search(queryEmbedding, this.config.topK * 3);

    // Post-filters
    results = this.applyRecencyBoost(results);
    results = this.boostSameLanguage(results);
    results = this.deduplicate(results);

    // Return only topK after re-ranking.
    return results.slice(0, this.config.topK);
  }

  // -------------------------------------------------------------------------
  // Query construction
  // -------------------------------------------------------------------------

  private buildQuery(userMessage: string): string {
    const parts: string[] = [];

    // 1. Active editor selection (highest signal)
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.document.getText(editor.selection);
      if (selection.trim().length > 0) {
        parts.push(`[Selected code]\n${selection.slice(0, 500)}`);
      }

      // 2. Symbols visible in the current file
      const visibleText = editor.document.getText(
        new vscode.Range(
          editor.visibleRanges[0]?.start ?? new vscode.Position(0, 0),
          editor.visibleRanges[0]?.end ?? new vscode.Position(0, 0),
        ),
      );
      if (visibleText.trim().length > 0) {
        parts.push(`[Visible code]\n${visibleText.slice(0, 500)}`);
      }
    }

    // 3. User message (always included)
    parts.push(`[User request]\n${userMessage}`);

    return parts.join('\n\n');
  }

  // -------------------------------------------------------------------------
  // Post-processing
  // -------------------------------------------------------------------------

  private applyRecencyBoost(results: SearchResult[]): SearchResult[] {
    const now = Date.now();
    return results.map((r) => {
      const isRecent = now - r.chunk.updated_at < RECENCY_WINDOW_MS;
      return { ...r, score: r.score + (isRecent ? RECENCY_BOOST : 0) };
    });
  }

  private boostSameLanguage(results: SearchResult[]): SearchResult[] {
    const activeLanguage = vscode.window.activeTextEditor?.document.languageId;
    if (!activeLanguage) return results;

    return results.map((r) => ({
      ...r,
      score: r.score + (r.chunk.language === activeLanguage ? 0.03 : 0),
    }));
  }

  private deduplicate(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    const deduped: SearchResult[] = [];

    // Sort highest score first before deduplication.
    const sorted = [...results].sort((a, b) => b.score - a.score);

    for (const r of sorted) {
      // Deduplicate by file + start_line combo to avoid showing the same
      // function body from two nearly-identical chunks.
      const key = `${r.chunk.file_path}:${r.chunk.start_line}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(r);
      }
    }

    return deduped;
  }
}
