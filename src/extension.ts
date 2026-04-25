import * as vscode from 'vscode';
import * as path from 'path';
import { loadConfig } from './config.js';
import { Embedder } from './embedder.js';
import { VectorStore } from './vectorStore.js';
import { IndexingPipeline } from './indexingPipeline.js';
import { FileWatcher } from './watcher.js';
import { RetrievalEngine } from './retrieval.js';
import { ContextProvider } from './contextProvider.js';
import { loadGrammar } from './chunker/treeSitter.js';

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Codebase Memory');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Codebase Memory Layer activating…');

  // -------------------------------------------------------------------------
  // Load configuration
  // -------------------------------------------------------------------------
  let config = loadConfig();

  // Re-load config when user changes settings.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('memory')) {
        config = loadConfig();
        outputChannel.appendLine('Config reloaded.');
      }
    }),
  );

  // -------------------------------------------------------------------------
  // Initialise storage
  // -------------------------------------------------------------------------
  const storagePath = context.globalStorageUri.fsPath;
  const store = new VectorStore(storagePath);
  store.open();

  // -------------------------------------------------------------------------
  // Initialise embedding model
  // -------------------------------------------------------------------------
  const modelPath = resolveModelPath(context, config.embeddingModel);
  const embedder = new Embedder(modelPath);

  // Try to load tree-sitter grammars (non-fatal if WASM files missing).
  await tryLoadGrammars(context, outputChannel);

  // -------------------------------------------------------------------------
  // Build pipeline and watcher
  // -------------------------------------------------------------------------
  const pipeline = new IndexingPipeline(embedder, store, config, outputChannel);
  const watcher = new FileWatcher(pipeline, config.include, config.exclude);
  watcher.start();

  // -------------------------------------------------------------------------
  // Build retrieval + context provider
  // -------------------------------------------------------------------------
  const engine = new RetrievalEngine(embedder, store, config);
  const provider = new ContextProvider(engine, config, outputChannel);

  provider.registerTool(context);
  provider.registerChatParticipant(context);

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('codebaseMemory.reindex', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }
      await pipeline.fullIndex(workspaceRoot);
      vscode.window.showInformationMessage(
        `Codebase Memory: Index complete (${store.count()} chunks).`,
      );
    }),

    vscode.commands.registerCommand('codebaseMemory.clearIndex', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Clear the entire codebase memory index?',
        { modal: true },
        'Clear',
      );
      if (answer === 'Clear') {
        // Close and delete the DB file, then re-open with fresh schema.
        store.close();
        const dbPath = path.join(storagePath, 'memory.db');
        try {
          const fs = await import('fs');
          fs.unlinkSync(dbPath);
        } catch { /* already gone */ }
        store.open();
        vscode.window.showInformationMessage('Codebase Memory: Index cleared.');
      }
    }),

    vscode.commands.registerCommand('codebaseMemory.showStats', () => {
      const total = store.count();
      const byFile = store.countByFile().slice(0, 10);
      const lines = [
        `Total indexed chunks: ${total}`,
        '',
        'Top files by chunk count:',
        ...byFile.map((f) => `  ${path.basename(f.filePath)}: ${f.count}`),
      ].join('\n');
      outputChannel.appendLine('\n--- Index Stats ---\n' + lines);
      outputChannel.show();
    }),
  );

  // -------------------------------------------------------------------------
  // Run initial full index in the background
  // -------------------------------------------------------------------------
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot && store.count() === 0) {
    // Don't await — let it run in background.
    pipeline.fullIndex(workspaceRoot).catch((err) => {
      outputChannel.appendLine(`Full index failed: ${err}`);
    });
  }

  context.subscriptions.push({
    dispose() {
      watcher.dispose();
      store.close();
    },
  });

  outputChannel.appendLine('Codebase Memory Layer active.');
}

export function deactivate(): void {
  // Disposals are handled via context.subscriptions.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveModelPath(context: vscode.ExtensionContext, modelKey: string): string {
  // If the caller provides an absolute path, use it directly.
  if (path.isAbsolute(modelKey)) return modelKey;

  // Otherwise resolve relative to the extension's `models/` directory.
  return path.join(context.extensionPath, 'models', `${modelKey}.onnx`);
}

async function tryLoadGrammars(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const pairs: [string, string][] = [
    ['typescript', 'tree-sitter-typescript.wasm'],
    ['javascript', 'tree-sitter-javascript.wasm'],
  ];

  for (const [lang, wasmFile] of pairs) {
    const wasmPath = path.join(context.extensionPath, 'models', wasmFile);
    try {
      await loadGrammar(lang, wasmPath);
      outputChannel.appendLine(`Loaded grammar: ${lang}`);
    } catch {
      outputChannel.appendLine(
        `tree-sitter grammar not available for ${lang} — using fallback chunker.`,
      );
    }
  }
}
