import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import Ignore from 'ignore';
import { type IndexingPipeline } from './indexingPipeline.js';

// ---------------------------------------------------------------------------
// FileWatcher
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 300;

export class FileWatcher {
  private watchers: vscode.FileSystemWatcher[] = [];
  private debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
  private ig: ReturnType<typeof Ignore> | null = null;

  constructor(
    private readonly pipeline: IndexingPipeline,
    private readonly includePatterns: string[],
    private readonly excludePatterns: string[],
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    this.loadGitignore();

    for (const pattern of this.includePatterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      watcher.onDidCreate((uri) => this.schedule(uri.fsPath, 'create'));
      watcher.onDidChange((uri) => this.schedule(uri.fsPath, 'change'));
      watcher.onDidDelete((uri) => this.handleDelete(uri.fsPath));

      this.watchers.push(watcher);
    }
  }

  dispose(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    for (const timer of this.debounceMap.values()) clearTimeout(timer);
    this.debounceMap.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private schedule(fsPath: string, event: 'create' | 'change'): void {
    if (this.isExcluded(fsPath)) return;

    const existing = this.debounceMap.get(fsPath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.debounceMap.delete(fsPath);
      try {
        await this.pipeline.indexFile(fsPath);
      } catch (err) {
        console.error(`[MemoryLayer] Failed to index ${fsPath}: ${err}`);
      }
    }, DEBOUNCE_MS);

    this.debounceMap.set(fsPath, timer);
  }

  private handleDelete(fsPath: string): void {
    if (this.isExcluded(fsPath)) return;
    this.pipeline.removeFile(fsPath).catch((err) => {
      console.error(`[MemoryLayer] Failed to remove ${fsPath}: ${err}`);
    });
  }

  private isExcluded(fsPath: string): boolean {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return false;

    const relative = path.relative(workspaceRoot, fsPath);

    // Check user-configured exclude patterns
    for (const pattern of this.excludePatterns) {
      if (vscode.languages.match({ pattern }, vscode.Uri.file(fsPath) as any)) {
        return true;
      }
    }

    // Check .gitignore rules
    if (this.ig?.ignores(relative)) return true;

    return false;
  }

  private loadGitignore(): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return;

    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      this.ig = Ignore().add(content);
    } catch {
      // Ignore errors reading .gitignore
    }
  }
}
