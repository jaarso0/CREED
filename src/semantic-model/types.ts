// ════════════════════════════════════════════
// PRIMITIVES
// ════════════════════════════════════════════

export interface Range {
  start: Position;
  end: Position;
}

export interface Position {
  line: number;                  // 0-indexed
  column: number;                // 0-indexed
}


// ════════════════════════════════════════════
// SYMBOL — a named entity in the codebase
// ════════════════════════════════════════════

export type SymbolKind =
  | 'project'                    // root node — CONTAINS every file
  | 'file'
  | 'module'
  | 'package'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'function'
  | 'method'
  | 'variable'
  | 'type_alias';

export type SymbolVisibility =
  | 'public'
  | 'private'
  | 'protected'
  | 'internal';                  // TS internal, Python _ convention

export interface Symbol {
  id: string;                    // path-anchored: "services/user.py::UserService::save"
  kind: SymbolKind;
  name: string;                  // simple: "save"
  qualifiedName: string;         // display-only: "UserService.save"
  filePath: string;              // relative to project root
  range: Range;
  exported: boolean;
  visibility: SymbolVisibility;
  metadata: Record<string, unknown>;  // extensible — agent provenance, annotations, etc.
}


// ════════════════════════════════════════════
// SCOPE — first-class, not hacked into resolver
// ════════════════════════════════════════════
//
// Scope membership is DERIVED, not stored.
// A symbol belongs to a scope when:
//   Symbol.filePath === Scope.filePath && Symbol.range ⊆ Scope.range
// This avoids dual-mutation (inserting into both Symbol and Scope).
// A ScopeIndex can be built in Stage 3 for fast lookups.
// ════════════════════════════════════════════

export type ScopeKind =
  | 'global'                     // file/module level
  | 'class'                      // class body
  | 'function'                   // function/method body
  | 'block';                     // if/for/while/with

export interface Scope {
  id: string;                    // deterministic
  kind: ScopeKind;
  parentScopeId: string | null;  // null = global scope
  ownerSymbolId: string | null;  // which symbol created this scope (class, function)
  filePath: string;
  range: Range;
  metadata: Record<string, unknown>;  // extensible
}


// ════════════════════════════════════════════
// CONTAINMENT — structural ownership
// ════════════════════════════════════════════

export type ContainmentKind = 'owns' | 'declares' | 'has_member';

export interface Containment {
  parentId: string;              // containing symbol ID
  childId: string;               // contained symbol ID
  kind: ContainmentKind;
}


// ════════════════════════════════════════════
// REFERENCE — unresolved and resolved
// ════════════════════════════════════════════

export type ReferenceKind =
  | 'call'
  | 'import'
  | 'inherit'
  | 'implement'
  | 'type_use'
  | 'instantiate'
  | 'renders';       // JSX: a component renders another component (<Child /> in its markup)

// Output of Stage 2 (extraction) — we know WHAT was referenced, not WHERE it points
export interface ReferenceCandidate {
  id: string;
  fromSymbolId: string;          // who is making this reference
  kind: ReferenceKind;
  rawName: string;               // "user.save" — literally what was in the source
  qualifierChain: string[];      // ["user", "save"] — split for resolution
  importPath?: string;           // "./services/user" — only for import references
  astNodeType: string;           // "call_expression", "new_expression" — for debugging
  filePath: string;
  range: Range;
  metadata: Record<string, unknown>;  // extensible
}

// How the resolver arrived at its answer
export type ResolutionMethod =
  | 'import'                     // resolved via import path → file → exported symbol
  | 'scope'                      // resolved by walking scope chain
  | 'qualified_name'             // resolved via qualified name index match
  | 'global_fallback';           // best-effort name match (lowest confidence)

// Output of Stage 4 (resolution) — we know exactly WHERE it points
export interface ResolvedReference {
  candidateId: string;           // back-link to the original candidate
  fromSymbolId: string;
  toSymbolId: string;            // THE ANSWER: what symbol this actually refers to
  kind: ReferenceKind;
  resolutionMethod: ResolutionMethod;  // HOW we got here — far more debuggable than a float
}


// ════════════════════════════════════════════
// LOCAL TYPE BINDING — instance type of a function/method-local variable
// ════════════════════════════════════════════
//
// Local (block/function-scoped) variables never become Symbols — they'd
// pollute name/qualified-name search and the graph with throwaway names.
// But we still need to know "inside function F, the local named `expander`
// holds a GraphExpander" so Stage 4 can resolve `expander.expand(...)`.
// These bindings are resolver-only plumbing: never merged into the graph.

export interface LocalTypeBinding {
  ownerSymbolId: string;         // the function/method Symbol whose body declares this local
  name: string;                  // local variable name
  filePath: string;
  range: Range;                  // range of the declaration, for future shadowing resolution
  declaredType: {
    qualifierChain: string[];
    rawName: string;
  };
}


// ════════════════════════════════════════════
// DIAGNOSTIC — pipeline health & debugging
// ════════════════════════════════════════════

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export type DiagnosticKind =
  | 'unresolved_import'
  | 'unresolved_reference'
  | 'duplicate_symbol'
  | 'ambiguous_reference'
  | 'broken_containment'
  | 'parse_error';

export interface Diagnostic {
  kind: DiagnosticKind;
  severity: DiagnosticSeverity;
  message: string;
  filePath: string;
  range?: Range;                 // optional — some diagnostics are file-level
  relatedSymbolIds?: string[];   // symbols involved
  relatedCandidateId?: string;   // if this diagnostic is about a reference
}


// ════════════════════════════════════════════
// PARTIAL SEMANTIC MODEL — one per file
// ════════════════════════════════════════════

export interface PartialSemanticModel {
  filePath: string;
  symbols: Symbol[];
  scopes: Scope[];
  containments: Containment[];
  references: ReferenceCandidate[];   // unresolved at this stage
  diagnostics: Diagnostic[];          // parse errors, extraction warnings
  localTypeBindings: LocalTypeBinding[];
}


// ════════════════════════════════════════════
// SEMANTIC MODEL — the real artifact
// ════════════════════════════════════════════

export interface SemanticModel {
  // The project root symbol
  project: Symbol;                     // kind: 'project', the root node
  
  // Merged from all PartialSemanticModels
  symbols: Symbol[];
  scopes: Scope[];
  containments: Containment[];         // includes Project CONTAINS File edges
  
  // From resolution
  resolvedReferences: ResolvedReference[];
  unresolvedReferences: ReferenceCandidate[];  // kept for diagnostics
  
  // Pipeline health
  diagnostics: Diagnostic[];
  
  // Metadata
  projectRoot: string;
  createdAt: string;              // ISO timestamp
  fileCount: number;
  symbolCount: number;
}
