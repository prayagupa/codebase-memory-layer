import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chunkFile } from './chunker/index.js';
import { Embedder, chunkId, sha256 } from './embedder.js';
import { VectorStore } from './vectorStore.js';
import { containsSecret } from './config.js';
import { type MemoryLayerConfig } from './config.js';

// ---------------------------------------------------------------------------
// IndexingPipeline
// ---------------------------------------------------------------------------

export class IndexingPipeline {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly config: MemoryLayerConfig,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  /**
   * Index (or re-index) a single file.
   */
  async indexFile(fsPath: string): Promise<void> {
    let content: string;
    try {
      content = fs.readFileSync(fsPath, 'utf8');
    } catch {
      this.log(`Skipping unreadable file: ${fsPath}`);
      return;
    }

    const rawChunks = await chunkFile(fsPath, content, this.config.chunkOverlapTokens);

    // Filter chunks that contain secrets if detection is enabled.
    const safeChunks = this.config.secretPatternDetection
      ? rawChunks.filter((c) => !containsSecret(c.content))
      : rawChunks;

    if (safeChunks.length === 0) {
      this.log(`No chunks produced for: ${path.basename(fsPath)}`);
      return;
    }

    const now = Date.now();

    // Skip embedding for chunks whose content hash hasn't changed.
    const chunksToEmbed = safeChunks.filter((c) => {
      const existingHash = this.store.getContentHash(
        chunkId(fsPath, c.meta.startLine),
      );
      return existingHash !== sha256(c.content);
    });

    if (chunksToEmbed.length > 0) {
      const embedded = await this.embedder.embedChunks(chunksToEmbed);
      this.store.upsertMany(embedded);
    }

    // Delete stale chunks for this file (chunks from an older version).
    this.store.deleteStaleChunks(fsPath, now);

    this.log(`Indexed ${safeChunks.length} chunks from ${path.basename(fsPath)}`);
  }

  /**
   * Remove all index entries for a deleted file.
   */
  async removeFile(fsPath: string): Promise<void> {
    this.store.deleteByFile(fsPath);
    this.log(`Removed index entries for: ${path.basename(fsPath)}`);
  }

  /**
   * Perform a full workspace index (initial or forced re-index).
   * Runs in a background progress notification so as not to block the UI.
   */
  async fullIndex(workspaceRoot: string): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Codebase Memory: Indexing…',
        cancellable: true,
      },
      async (progress, token) => {
        const files = await collectFiles(workspaceRoot, this.config);
        const total = files.length;
        let done = 0;

        for (const file of files) {
          if (token.isCancellationRequested) break;
          await this.indexFile(file);
          done++;
          progress.report({
            message: `${done}/${total} files`,
            increment: (1 / total) * 100,
          });
        }

        this.log(`Full index complete: ${done} files processed.`);
      },
    );
  }

  private log(msg: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectFiles(
  workspaceRoot: string,
  config: MemoryLayerConfig,
): Promise<string[]> {
  const includes = config.include.map((g) => new vscode.RelativePattern(workspaceRoot, g));
  const results: string[] = [];

  for (const pattern of includes) {
    const uris = await vscode.workspace.findFiles(
      pattern,
      `{${config.exclude.join(',')}}`,
    );
    results.push(...uris.map((u) => u.fsPath));
  }

  return [...new Set(results)];
}
