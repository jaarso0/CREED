export interface Position {
  line: number;
  column: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export type SymbolKind =
  | 'project'
  | 'file'
  | 'module'
  | 'package'
  | 'class'
  | 'interface'
  | 'struct'
  | 'function'
  | 'method'
  | 'variable'
  | 'type_alias';

export type SymbolVisibility = 'public' | 'private' | 'protected' | 'internal';

export interface Symbol {
  id: string;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  range: Range;
  exported: boolean;
  visibility: SymbolVisibility;
  metadata: Record<string, any>;
}

export interface Scope {
  id: string;
  kind: string;
  parentScopeId: string | null;
  ownerSymbolId: string | null;
  filePath: string;
  range: Range;
  metadata: Record<string, any>;
}

export interface Containment {
  parentId: string;
  childId: string;
  kind: 'owns' | 'declares' | 'has_member';
}

export type ReferenceKind =
  | 'call'
  | 'import'
  | 'inherit'
  | 'implement'
  | 'type_use'
  | 'instantiate'
  | 'renders';

export interface ReferenceCandidate {
  id: string;
  fromSymbolId: string;
  kind: ReferenceKind;
  rawName: string;
  qualifierChain: string[];
  importPath?: string;
  astNodeType: string;
  filePath: string;
  range: Range;
  metadata: Record<string, any>;
}

export type ResolutionMethod =
  | 'import'
  | 'scope'
  | 'qualified_name'
  | 'global_fallback';

export interface ResolvedReference {
  candidateId: string;
  fromSymbolId: string;
  toSymbolId: string;
  kind: ReferenceKind;
  resolutionMethod: ResolutionMethod;
}

export interface Diagnostic {
  kind: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  filePath: string;
  range?: Range;
  relatedSymbolIds?: string[];
  relatedCandidateId?: string;
}

export interface SemanticModel {
  project: Symbol;
  symbols: Symbol[];
  scopes: Scope[];
  containments: Containment[];
  resolvedReferences: ResolvedReference[];
  unresolvedReferences: ReferenceCandidate[];
  diagnostics: Diagnostic[];
  projectRoot: string;
  createdAt: string;
  fileCount: number;
  symbolCount: number;
}
