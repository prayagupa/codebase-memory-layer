import * as vscode from 'vscode';
import { RetrievalEngine, type RetrievalResult } from './retrieval.js';
import { type StoredChunk } from './vectorStore.js';
import { type MemoryLayerConfig } from './config.js';

// ---------------------------------------------------------------------------
// Approx chars-per-token for budget estimation (no tokeniser dependency)
// ---------------------------------------------------------------------------
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// ContextProvider
// ---------------------------------------------------------------------------

export class ContextProvider {
  constructor(
    private readonly engine: RetrievalEngine,
    private readonly config: MemoryLayerConfig,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  // -------------------------------------------------------------------------
  // Register VS Code lm tool
  // -------------------------------------------------------------------------

  registerTool(context: vscode.ExtensionContext): void {
    const tool = vscode.lm.registerTool<{ query: string }>('codebase-memory', {
      description:
        'Retrieves semantically relevant code snippets from the local codebase index.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language or code query.',
          },
        },
        required: ['query'],
      },
      invoke: async (input, _token) => {
        const results = await this.engine.retrieve(input.input.query);
        const text = this.formatChunks(results);
        return new vscode.lm.ToolResult([new vscode.lm.TextPart(text)]);
      },
    });

    context.subscriptions.push(tool);
  }

  // -------------------------------------------------------------------------
  // Register chat participant
  // -------------------------------------------------------------------------

  registerChatParticipant(context: vscode.ExtensionContext): void {
    const participant = vscode.chat.createChatParticipant(
      'memory.assistant',
      async (
        req: vscode.ChatRequest,
        _ctx: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
      ) => {
        // 1. Retrieve relevant chunks
        const results = await this.engine.retrieve(req.prompt);
        const contextBlock = this.formatChunks(results);

        // 2. Build messages — prepend retrieved context
        const messages = [
          vscode.LanguageModelChatMessage.User(
            `[Codebase Context]\n${contextBlock}\n\n[User Request]\n${req.prompt}`,
          ),
        ];

        // 3. Forward to the user-selected Copilot model
        const model = req.model;
        let response: vscode.LanguageModelChatResponse;
        try {
          response = await model.sendRequest(messages, {}, token);
        } catch (err) {
          stream.markdown(`> ⚠️ Language model error: ${err}`);
          return;
        }

        for await (const part of response.text) {
          stream.markdown(part);
        }
      },
    );

    participant.iconPath = new vscode.ThemeIcon('database');
    context.subscriptions.push(participant);
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  formatChunks(results: RetrievalResult[]): string {
    const budgetChars = this.config.tokenBudget * CHARS_PER_TOKEN;
    let usedChars = 0;
    const parts: string[] = [];

    for (const { chunk, score } of results) {
      const block = formatSingleChunk(chunk, score);
      if (usedChars + block.length > budgetChars) break;
      parts.push(block);
      usedChars += block.length;
    }

    return parts.join('\n\n');
  }
}

// ---------------------------------------------------------------------------
// Helper: format a single chunk as a fenced code block
// ---------------------------------------------------------------------------

function formatSingleChunk(chunk: StoredChunk, score: number): string {
  const header = `// ${chunk.file_path}:${chunk.start_line}-${chunk.end_line}  (score: ${score.toFixed(3)})`;
  return `\`\`\`${chunk.language}\n${header}\n${chunk.content}\n\`\`\``;
}
