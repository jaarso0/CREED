export type Language =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'java'
  | 'html'
  | 'go'
  | 'csharp'
  | 'cpp'
  | 'r';

export const EXTENSION_MAP: Record<string, Language> = {
  '.ts':  'typescript',
  '.tsx': 'tsx',
  '.js':  'javascript',
  '.jsx': 'jsx',
  '.py':  'python',
  '.java': 'java',
  '.html': 'html',
  '.go':  'go',
  '.cs':  'csharp',
  // C and C++ share one grammar: tree-sitter-cpp is a superset of tree-sitter-c, so a
  // plain C file parses correctly through it. `.h` is genuinely ambiguous between the two
  // and is claimed here for the same reason.
  '.cpp': 'cpp',
  '.cc':  'cpp',
  '.cxx': 'cpp',
  '.c':   'cpp',
  '.hpp': 'cpp',
  '.hh':  'cpp',
  '.hxx': 'cpp',
  '.h':   'cpp',
  // `.R` normalizes to `.r` — detectLanguage lowercases before lookup.
  '.r':   'r',
};

export function detectLanguage(filePath: string): Language | null {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_MAP[extension] || null;
}

/**
 * The language family a file belongs to, used by the resolvers to avoid matching a name
 * in one language against a same-named symbol in another. Dialects that genuinely share a
 * namespace collapse to one category (`.ts`/`.tsx`/`.js`/`.jsx`, and the C/C++ header and
 * source extensions); everything else stands alone.
 *
 * Single definition on purpose — ImportResolver and ScopeResolver each had their own copy,
 * and a language added to one but not the other silently fell into `unknown`, where every
 * new language matched every other one.
 */
export function languageCategory(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return 'unknown';
  const lang = EXTENSION_MAP[filePath.slice(dot).toLowerCase()];
  if (!lang) return 'unknown';
  if (lang === 'tsx' || lang === 'javascript' || lang === 'jsx') return 'typescript';
  return lang;
}
