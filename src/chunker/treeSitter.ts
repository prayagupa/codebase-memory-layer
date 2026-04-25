import * as path from 'path';
import { type RawChunk } from './types.js';

// tree-sitter is loaded lazily to avoid startup cost.
// The WASM grammar files must live in `models/` and be loaded by the caller once.
// We re-export a helper so `index.ts` can call `initTreeSitter()` during activation.

let Parser: typeof import('web-tree-sitter') | null = null;
const grammars = new Map<string, import('web-tree-sitter').Language>();

/**
 * Initialise tree-sitter and load the WASM grammar for a language.
 * Must be called once during extension activation before any chunking.
 */
export async function loadGrammar(language: string, wasmPath: string): Promise<void> {
  if (!Parser) {
    const TreeSitter = (await import('web-tree-sitter')).default;
    await TreeSitter.init();
    Parser = TreeSitter as unknown as typeof import('web-tree-sitter');
  }
  if (!grammars.has(language)) {
    const lang = await (Parser as any).Language.load(wasmPath);
    grammars.set(language, lang);
  }
}

/**
 * Chunk a TypeScript / JavaScript file using the tree-sitter AST.
 * Extracts function declarations, arrow functions, class declarations,
 * and top-level statements as individual chunks.
 */
export async function chunkWithTreeSitter(
  filePath: string,
  content: string,
  language: string,
): Promise<RawChunk[]> {
  if (!Parser) {
    throw new Error('tree-sitter not initialised — call loadGrammar() first.');
  }

  const grammar = grammars.get(language) ?? grammars.get('typescript');
  if (!grammar) {
    throw new Error(`No tree-sitter grammar loaded for language: ${language}`);
  }

  const parser = new (Parser as any)();
  parser.setLanguage(grammar);
  const tree = parser.parse(content);

  const chunks: RawChunk[] = [];
  const lines = content.split('\n');

  // Node types we want to extract as top-level chunks.
  const TARGET_TYPES = new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'class_declaration',
    'class_expression',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'export_statement',
    'lexical_declaration',
    'variable_declaration',
  ]);

  function visit(node: any): void {
    if (TARGET_TYPES.has(node.type)) {
      const startLine = node.startPosition.row; // 0-based
      const endLine = node.endPosition.row;
      const chunkLines = lines.slice(startLine, endLine + 1);
      const chunkContent = chunkLines.join('\n').trim();

      if (chunkContent.length < 10) {
        // Skip trivially small nodes
        return;
      }

      // Extract symbol name if available
      const symbols: string[] = [];
      const nameNode =
        node.childForFieldName?.('name') ??
        node.childForFieldName?.('declarator');
      if (nameNode?.text) {
        symbols.push(nameNode.text);
      }

      chunks.push({
        content: chunkContent,
        meta: {
          filePath,
          startLine: startLine + 1, // 1-based
          endLine: endLine + 1,
          language,
          symbols,
        },
      });
    } else {
      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i));
      }
    }
  }

  visit(tree.rootNode);

  // If tree-sitter produced no chunks fall back to the whole file as one chunk.
  if (chunks.length === 0) {
    chunks.push({
      content: content.trim(),
      meta: {
        filePath,
        startLine: 1,
        endLine: lines.length,
        language,
        symbols: [path.basename(filePath)],
      },
    });
  }

  return chunks;
}
