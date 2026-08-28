import { PYTHON_QUERIES } from './python-queries.js';
import { TYPESCRIPT_QUERIES, TSX_QUERIES } from './typescript-queries.js';
import { JAVASCRIPT_QUERIES } from './javascript-queries.js';
import { JAVA_QUERIES } from './java-queries.js';
import { HTML_QUERIES } from './html-queries.js';
import { GO_QUERIES } from './go-queries.js';
import { CSHARP_QUERIES } from './csharp-queries.js';
import { CPP_QUERIES } from './cpp-queries.js';
import { R_QUERIES } from './r-queries.js';

export const QUERY_REGISTRY: Record<string, string> = {
  python: PYTHON_QUERIES,
  typescript: TYPESCRIPT_QUERIES,   // plain TS grammar — no JSX nodes
  javascript: JAVASCRIPT_QUERIES,   // JS grammar supports JSX; queries include it
  tsx: TSX_QUERIES,                 // TS + JSX patterns
  jsx: JAVASCRIPT_QUERIES,
  java: JAVA_QUERIES,
  html: HTML_QUERIES,
  go: GO_QUERIES,
  csharp: CSHARP_QUERIES,
  cpp: CPP_QUERIES,                 // also serves C — tree-sitter-cpp is a superset
  r: R_QUERIES
};
