import { execFile } from 'child_process';
import { promisify } from 'util';
import { type RawChunk } from './types.js';

const execFileAsync = promisify(execFile);

interface PythonNode {
  type: 'function' | 'class' | 'module_docstring';
  name: string;
  start_line: number;
  end_line: number;
}

/**
 * Chunk a Python file by invoking the bundled `py_chunker.py` helper via a
 * child process.  The helper uses `ast.parse` to extract function / class
 * boundaries and returns JSON to stdout.
 *
 * If Python is unavailable the function throws and `index.ts` falls back to
 * the sliding-window chunker.
 */
export async function chunkPython(filePath: string, content: string): Promise<RawChunk[]> {
  const helperPath = new URL('../../scripts/py_chunker.py', import.meta.url).pathname;

  let stdout: string;
  try {
    const result = await execFileAsync('python3', [helperPath, filePath], {
      input: content,
      encoding: 'utf8',
      timeout: 10_000,
    });
    stdout = result.stdout;
  } catch (err: any) {
    throw new Error(`py_chunker failed: ${err.message}`);
  }

  const nodes: PythonNode[] = JSON.parse(stdout);
  const lines = content.split('\n');

  return nodes.map((node) => {
    const start = node.start_line - 1; // 0-based for slicing
    const end = node.end_line;         // exclusive
    const chunkContent = lines.slice(start, end).join('\n').trim();

    return {
      content: chunkContent,
      meta: {
        filePath,
        startLine: node.start_line,
        endLine: node.end_line,
        language: 'python',
        symbols: node.name ? [node.name] : [],
      },
    };
  });
}
