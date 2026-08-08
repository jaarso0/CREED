import * as fs from 'fs/promises';
import * as path from 'path';
import { detectLanguage, Language } from './lang-detect.js';
import { ParsedFile } from './parsed-file.js';
import { parserRegistry } from './parser-registry.js';

const DEFAULT_EXCLUDE = new Set([
  'node_modules',
  'dist',
  'build',
  '__pycache__',
  '.git',
  'venv',
  '.venv',
  'env',
  '.env',
]);

/**
 * A helper to match path against simple .gitignore patterns.
 */
class GitIgnoreMatcher {
  private rules: { regex: RegExp; negate: boolean; dirOnly: boolean }[] = [];

  constructor(content: string) {
    const lines = content.split(/\r?\n/);
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;

      let negate = false;
      if (line.startsWith('!')) {
        negate = true;
        line = line.slice(1);
      }

      const dirOnly = line.endsWith('/');
      if (dirOnly) {
        line = line.slice(0, -1);
      }

      // Convert simple glob pattern to RegExp
      // Escape special characters except *, ?, [!...]
      let regexStr = line
        .replace(/[-\/\\^$+?.()|[\]{}]/g, '\\$&') // escape regex chars
        .replace(/\\\*/g, '.*')                    // * -> .*
        .replace(/\\\?/g, '.');                    // ? -> .
      
      // If it has no slashes, match anywhere in path (i.e. starts with .* / or is boundary)
      if (!line.includes('/')) {
        regexStr = '(^|/)' + regexStr + '($|/)';
      } else {
        // If it starts with a slash, match from start
        if (line.startsWith('/')) {
          regexStr = '^' + regexStr.slice(1);
        } else {
          regexStr = '(^|/)' + regexStr;
        }
      }

      try {
        const regex = new RegExp(regexStr);
        this.rules.push({ regex, negate, dirOnly });
      } catch (err) {
        // Ignore malformed patterns
      }
    }
  }

  public shouldIgnore(relativePath: string, isDirectory: boolean): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    let ignored = false;

    for (const rule of this.rules) {
      if (rule.dirOnly && !isDirectory) continue;
      
      if (rule.regex.test(normalized)) {
        ignored = !rule.negate;
      }
    }

    return ignored;
  }
}

/**
 * A supported source file that has been located and read, but not yet parsed.
 *
 * Splitting discovery from parsing is what lets the pipeline hash a file's contents
 * and decide whether it needs parsing at all. Reading was already unavoidable, so
 * hashing costs almost nothing while parse+extract — the expensive part — becomes
 * skippable for unchanged files.
 */
export interface SourceFile {
  filePath: string;
  absolutePath: string;
  language: Language;
  sourceCode: string;
  mtimeMs: number;
}

/** Parses one already-read source file into a tree-sitter AST. */
export function parseSourceFile(file: SourceFile): ParsedFile {
  const parser = parserRegistry.getParser(file.language);
  // tree-sitter's Node binding defaults to a ~32KB parse buffer and throws
  // "Invalid argument" on larger inputs — silently dropping every file over
  // that size from the graph. Size the buffer to the source (with headroom).
  const bufferSize = Buffer.byteLength(file.sourceCode, 'utf8') + 4096;
  const tree = parser.parse(file.sourceCode, undefined, { bufferSize });

  return {
    filePath: file.filePath,
    absolutePath: file.absolutePath,
    language: file.language,
    tree,
    sourceCode: file.sourceCode
  };
}

/**
 * Walks a directory recursively and returns every supported source file, read but
 * unparsed. Honours the same exclusions as `parseProject`.
 */
export async function walkProject(projectRoot: string): Promise<SourceFile[]> {
  const normalizedRoot = path.resolve(projectRoot);
  const sourceFiles: SourceFile[] = [];

  let gitignoreMatcher: GitIgnoreMatcher | null = null;
  try {
    const gitignorePath = path.join(normalizedRoot, '.gitignore');
    const content = await fs.readFile(gitignorePath, 'utf-8');
    gitignoreMatcher = new GitIgnoreMatcher(content);
  } catch (err) {
    // No .gitignore, that's fine
  }

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(normalizedRoot, fullPath);
      const isDirectory = entry.isDirectory();

      if (DEFAULT_EXCLUDE.has(entry.name.toLowerCase())) continue;
      if (entry.name.startsWith('.') && entry.name !== '.' && entry.name !== '..') continue;
      if (gitignoreMatcher && gitignoreMatcher.shouldIgnore(relativePath, isDirectory)) continue;

      if (isDirectory) {
        await walk(fullPath);
        continue;
      }

      const lang = detectLanguage(entry.name);
      if (!lang) continue;

      try {
        const sourceCode = await fs.readFile(fullPath, 'utf-8');
        const stat = await fs.stat(fullPath);
        sourceFiles.push({
          filePath: relativePath.replace(/\\/g, '/'),
          absolutePath: fullPath.replace(/\\/g, '/'),
          language: lang,
          sourceCode,
          mtimeMs: stat.mtimeMs
        });
      } catch (err) {
        console.error(`Failed to read file ${fullPath}:`, err);
      }
    }
  }

  await walk(normalizedRoot);
  return sourceFiles;
}

/**
 * Walks a directory recursively and parses supported files.
 */
export async function parseProject(projectRoot: string): Promise<ParsedFile[]> {
  const normalizedRoot = path.resolve(projectRoot);
  const parsedFiles: ParsedFile[] = [];

  // Try to load gitignore
  let gitignoreMatcher: GitIgnoreMatcher | null = null;
  try {
    const gitignorePath = path.join(normalizedRoot, '.gitignore');
    const content = await fs.readFile(gitignorePath, 'utf-8');
    gitignoreMatcher = new GitIgnoreMatcher(content);
  } catch (err) {
    // No .gitignore, that's fine
  }

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(normalizedRoot, fullPath);
      const isDirectory = entry.isDirectory();

      // Skip default excluded folders
      if (DEFAULT_EXCLUDE.has(entry.name.toLowerCase())) continue;

      // Skip dotfiles/hidden folders (except current dir references)
      if (entry.name.startsWith('.') && entry.name !== '.' && entry.name !== '..') continue;

      // Respect .gitignore
      if (gitignoreMatcher && gitignoreMatcher.shouldIgnore(relativePath, isDirectory)) {
        continue;
      }

      if (isDirectory) {
        await walk(fullPath);
      } else {
        const lang = detectLanguage(entry.name);
        if (lang) {
          try {
            const sourceCode = await fs.readFile(fullPath, 'utf-8');
            const parser = parserRegistry.getParser(lang);
            // tree-sitter's Node binding defaults to a ~32KB parse buffer and throws
            // "Invalid argument" on larger inputs — silently dropping every file over
            // that size from the graph. Size the buffer to the source (with headroom).
            const bufferSize = Buffer.byteLength(sourceCode, 'utf8') + 4096;
            const tree = parser.parse(sourceCode, undefined, { bufferSize });
            
            // Normalize path slashes to forward slashes for the semantic model
            const normRelative = relativePath.replace(/\\/g, '/');
            const normAbsolute = fullPath.replace(/\\/g, '/');

            parsedFiles.push({
              filePath: normRelative,
              absolutePath: normAbsolute,
              language: lang,
              tree,
              sourceCode,
            });
          } catch (err) {
            // Keep going, but log parse warning if needed
            console.error(`Failed to parse file ${fullPath}:`, err);
          }
        }
      }
    }
  }

  await walk(normalizedRoot);
  return parsedFiles;
}
