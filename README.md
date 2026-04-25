# Codebase Memory Layer

A locally-running VS Code extension that gives GitHub Copilot **persistent, semantic awareness of your codebase** across sessions — no source code ever leaves your machine.

---

## How it works

1. On activation, the extension indexes every file in your workspace into a local SQLite vector database.
2. A file watcher keeps the index up-to-date as you save files.
3. When you chat with Copilot, the most semantically relevant code chunks are automatically retrieved and injected as context.

---

## Requirements

- **VS Code** 1.90 or later
- **Node.js** 18 or later (for building / running tests)
- **Python 3** (optional — enables more accurate Python chunking via `ast.parse`)

---

## Installation

### 1. Clone and install dependencies

```bash
git clone https://github.com/your-org/codebase-memory-layer.git
cd codebase-memory-layer
npm install --legacy-peer-deps
```

### 2. Build the extension

```bash
npm run build
```

### 3. Open in VS Code

```bash
code .
```

Press **F5** to launch an Extension Development Host with the extension loaded.

---

## Usage

### Chat participant — `@memory`

Open the Copilot Chat panel and prefix your message with `@memory`:

```
@memory  How does the authentication flow work in this codebase?
@memory  Where is the database connection pool initialised?
@memory  Explain the retry logic in the HTTP client.
```

The agent will:
1. Embed your question.
2. Search the local index for the most relevant code chunks.
3. Prepend those chunks as grounded context before forwarding your message to the Copilot model.
4. Stream the answer back with source file references.

---

### Copilot tool — `codebase-memory`

When GitHub Copilot is running in **agentic / tool-use mode**, it can invoke the `codebase-memory` tool automatically. No extra setup is needed — Copilot will call it whenever it judges that codebase context would improve the answer.

You can also invoke it explicitly in a Copilot Chat tool call:

```
Use the codebase-memory tool to find all usages of the UserService class.
```

---

### Commands

Access these from the Command Palette (**⇧⌘P** / **Ctrl+Shift+P**):

| Command | Description |
|---|---|
| `Codebase Memory: Re-index Workspace` | Triggers a full re-index of all workspace files. Run this after large refactors or pulling many changes. |
| `Codebase Memory: Clear Index` | Deletes the entire local index. The extension will re-index automatically on next activation. |
| `Codebase Memory: Show Index Stats` | Prints total chunk count and the top files by chunk count to the **Codebase Memory** output channel. |

---

## Configuration

All settings live under the `memory` namespace in VS Code settings (`settings.json`):

```jsonc
{
  // Glob patterns of files to include in the index (default shown)
  "memory.include": ["**/*.{ts,js,tsx,jsx,py,go,java,md}"],

  // Glob patterns to exclude (node_modules, build output, etc.)
  "memory.exclude": ["**/node_modules/**", "**/dist/**", "**/out/**", "**/.git/**"],

  // Number of chunks returned per query (1–32, default 8)
  "memory.topK": 8,

  // Maximum tokens of injected context per Copilot request (default 4096)
  "memory.tokenBudget": 4096,

  // Embedding model key or absolute path to a local .onnx file
  "memory.embeddingModel": "nomic-embed-code",

  // Token overlap used by the sliding-window fallback chunker (default 40)
  "memory.chunkOverlapTokens": 40,

  // Exclude chunks that look like they contain secrets / API keys (default true)
  "memory.secretPatternDetection": true
}
```

### Excluding files or directories

Add patterns to `memory.exclude`, or just use a `.gitignore` file — the extension
respects it automatically.

```jsonc
{
  "memory.exclude": [
    "**/node_modules/**",
    "**/dist/**",
    "**/fixtures/**",     // test fixture data
    "src/generated/**"    // auto-generated code
  ]
}
```

---

## Development

### Run tests

```bash
npm test
```

### Watch mode (rebuild on save)

```bash
npm run watch
```

### Project structure

```
src/
├── extension.ts          # activate / deactivate entry point
├── config.ts             # MemoryLayerConfig + secret-pattern detection
├── watcher.ts            # FileWatcher (debounced, .gitignore-aware)
├── indexingPipeline.ts   # Orchestrates chunk → embed → store
├── embedder.ts           # ONNX Runtime embedding model wrapper
├── vectorStore.ts        # sql.js SQLite store with cosine-similarity search
├── retrieval.ts          # RetrievalEngine (multi-signal query, post-filters)
├── contextProvider.ts    # VS Code lm tool + @memory chat participant
└── chunker/
    ├── index.ts          # Chunker dispatcher
    ├── treeSitter.ts     # TS/JS AST chunking via tree-sitter
    ├── pythonAst.ts      # Python chunking via child-process py_chunker.py
    ├── fallback.ts       # Sliding-window fallback
    └── types.ts          # RawChunk / ChunkMeta interfaces
scripts/
└── py_chunker.py         # Python AST helper (called by pythonAst.ts)
test/
├── chunker.test.ts
├── embedder.test.ts
└── retrieval.test.ts
```

---

## Privacy & security

- **No source code egress** — raw file content is never sent to any remote endpoint. Only the final assembled prompt (which may include retrieved snippets) travels to the Copilot API, exactly as it does today.
- **Local model** — the ONNX embedding model runs fully in-process; zero network calls.
- **Workspace isolation** — each workspace root gets its own index partition.
- **Secret detection** — chunks matching common secret patterns (API keys, tokens, private keys) are excluded from context injection by default. Disable with `"memory.secretPatternDetection": false`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `@memory` returns no results | Run **Codebase Memory: Re-index Workspace** from the Command Palette. |
| Responses feel stale after a large refactor | Run **Re-index Workspace** or restart VS Code (activation triggers a background re-index if the index is empty). |
| Python files not chunked accurately | Ensure `python3` is on your `PATH`; the extension falls back to the sliding-window chunker if Python is unavailable. |
| High memory usage | Reduce `memory.topK` or add more patterns to `memory.exclude`. |
| Want to see what's indexed | Run **Show Index Stats** — output appears in the *Codebase Memory* output channel. |
