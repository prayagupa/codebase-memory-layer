import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface MemoryLayerConfig {
  /** Glob patterns of files to index. */
  include: string[];
  /** Glob patterns of files to exclude. */
  exclude: string[];
  /** Embedding model key or absolute path to a local .onnx file. */
  embeddingModel: string;
  /** Number of chunks returned per retrieval query. */
  topK: number;
  /** Maximum tokens allowed for injected context. */
  tokenBudget: number;
  /** Token overlap used by the sliding-window fallback chunker. */
  chunkOverlapTokens: number;
  /** Whether to exclude chunks matching secret/API-key patterns. */
  secretPatternDetection: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: Readonly<MemoryLayerConfig> = {
  include: ['**/*.{ts,js,tsx,jsx,py,go,java,md}'],
  exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/.git/**'],
  embeddingModel: 'nomic-embed-code',
  topK: 8,
  tokenBudget: 4096,
  chunkOverlapTokens: 40,
  secretPatternDetection: true,
};

// ---------------------------------------------------------------------------
// Loader — reads VS Code workspace configuration
// ---------------------------------------------------------------------------

export function loadConfig(): MemoryLayerConfig {
  const cfg = vscode.workspace.getConfiguration('memory');

  return {
    include: cfg.get<string[]>('include', DEFAULT_CONFIG.include),
    exclude: cfg.get<string[]>('exclude', DEFAULT_CONFIG.exclude),
    embeddingModel: cfg.get<string>('embeddingModel', DEFAULT_CONFIG.embeddingModel),
    topK: cfg.get<number>('topK', DEFAULT_CONFIG.topK),
    tokenBudget: cfg.get<number>('tokenBudget', DEFAULT_CONFIG.tokenBudget),
    chunkOverlapTokens: cfg.get<number>(
      'chunkOverlapTokens',
      DEFAULT_CONFIG.chunkOverlapTokens,
    ),
    secretPatternDetection: cfg.get<boolean>(
      'secretPatternDetection',
      DEFAULT_CONFIG.secretPatternDetection,
    ),
  };
}

// ---------------------------------------------------------------------------
// Secret-pattern regex (used by Embedder / ContextProvider to gate chunks)
// ---------------------------------------------------------------------------

/** Patterns that suggest the chunk contains a hardcoded secret. */
const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}/i,
  /(?:secret|token|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}/i,
  /(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*['"][^'"]{16,}/i,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{36}/, // GitHub personal access token
];

export function containsSecret(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content));
}
