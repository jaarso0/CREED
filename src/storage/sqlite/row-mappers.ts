import {
  Symbol as KGSymbol,
  SymbolKind,
  SymbolVisibility,
  Scope,
  ScopeKind,
  Containment,
  ContainmentKind,
  ReferenceCandidate,
  ReferenceKind,
  ResolvedReference,
  ResolutionMethod,
  Diagnostic,
  DiagnosticKind,
  DiagnosticSeverity,
  Range
} from '../../semantic-model/types.js';

/**
 * The only module that knows how domain objects map onto columns. Range flattening
 * and metadata JSON encoding live here and nowhere else, so a schema change is a
 * change to this file plus schema.ts.
 *
 * Null handling deliberately matches the old JSON storage: a NULL column becomes an
 * absent key, not an explicit `undefined`. JSON.stringify dropped those keys, so
 * mirroring it keeps round-trips byte-identical to the previous behaviour.
 */

// ── shared helpers ──────────────────────────────────────────────────────────

interface RangeCols {
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

function rangeToCols(range: Range): RangeCols {
  return {
    start_line: range.start.line,
    start_col: range.start.column,
    end_line: range.end.line,
    end_col: range.end.column
  };
}

function colsToRange(row: RangeCols): Range {
  return {
    start: { line: row.start_line, column: row.start_col },
    end: { line: row.end_line, column: row.end_col }
  };
}

function encodeMetadata(metadata: Record<string, unknown> | undefined): string {
  return JSON.stringify(metadata ?? {});
}

function decodeMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A corrupt metadata blob shouldn't take down a whole index load; the symbol
    // is still structurally useful without it.
    return {};
  }
}

// ── Symbol ──────────────────────────────────────────────────────────────────

export interface SymbolRow extends RangeCols {
  id: string;
  kind: string;
  name: string;
  name_lower: string;
  qualified_name: string;
  qualified_name_lower: string;
  file_path: string;
  exported: number;
  visibility: string;
  metadata: string;
  is_project: number;
}

export function symbolToRow(symbol: KGSymbol, isProject = false): SymbolRow {
  return {
    id: symbol.id,
    kind: symbol.kind,
    name: symbol.name,
    name_lower: symbol.name.toLowerCase(),
    qualified_name: symbol.qualifiedName,
    qualified_name_lower: symbol.qualifiedName.toLowerCase(),
    file_path: symbol.filePath,
    ...rangeToCols(symbol.range),
    exported: symbol.exported ? 1 : 0,
    visibility: symbol.visibility,
    metadata: encodeMetadata(symbol.metadata),
    is_project: isProject ? 1 : 0
  };
}

export function rowToSymbol(row: SymbolRow): KGSymbol {
  return {
    id: row.id,
    kind: row.kind as SymbolKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    range: colsToRange(row),
    exported: row.exported === 1,
    visibility: row.visibility as SymbolVisibility,
    metadata: decodeMetadata(row.metadata)
  };
}

// ── Scope ───────────────────────────────────────────────────────────────────

export interface ScopeRow extends RangeCols {
  id: string;
  kind: string;
  parent_scope_id: string | null;
  owner_symbol_id: string | null;
  file_path: string;
  metadata: string;
}

export function scopeToRow(scope: Scope): ScopeRow {
  return {
    id: scope.id,
    kind: scope.kind,
    parent_scope_id: scope.parentScopeId,
    owner_symbol_id: scope.ownerSymbolId,
    file_path: scope.filePath,
    ...rangeToCols(scope.range),
    metadata: encodeMetadata(scope.metadata)
  };
}

export function rowToScope(row: ScopeRow): Scope {
  return {
    id: row.id,
    kind: row.kind as ScopeKind,
    // These two are `string | null` in the domain type — null is meaningful
    // (a global scope has no parent), so it is preserved rather than dropped.
    parentScopeId: row.parent_scope_id,
    ownerSymbolId: row.owner_symbol_id,
    filePath: row.file_path,
    range: colsToRange(row),
    metadata: decodeMetadata(row.metadata)
  };
}

// ── Containment ─────────────────────────────────────────────────────────────

export interface ContainmentRow {
  parent_id: string;
  child_id: string;
  kind: string;
}

export function containmentToRow(containment: Containment): ContainmentRow {
  return {
    parent_id: containment.parentId,
    child_id: containment.childId,
    kind: containment.kind
  };
}

export function rowToContainment(row: ContainmentRow): Containment {
  return {
    parentId: row.parent_id,
    childId: row.child_id,
    kind: row.kind as ContainmentKind
  };
}

// ── ResolvedReference ───────────────────────────────────────────────────────

export interface ResolvedReferenceRow {
  candidate_id: string;
  from_symbol_id: string;
  to_symbol_id: string;
  kind: string;
  resolution_method: string;
}

export function resolvedReferenceToRow(ref: ResolvedReference): ResolvedReferenceRow {
  return {
    candidate_id: ref.candidateId,
    from_symbol_id: ref.fromSymbolId,
    to_symbol_id: ref.toSymbolId,
    kind: ref.kind,
    resolution_method: ref.resolutionMethod
  };
}

export function rowToResolvedReference(row: ResolvedReferenceRow): ResolvedReference {
  return {
    candidateId: row.candidate_id,
    fromSymbolId: row.from_symbol_id,
    toSymbolId: row.to_symbol_id,
    kind: row.kind as ReferenceKind,
    resolutionMethod: row.resolution_method as ResolutionMethod
  };
}

// ── ReferenceCandidate (unresolved) ─────────────────────────────────────────

export interface ReferenceCandidateRow extends RangeCols {
  id: string;
  from_symbol_id: string;
  kind: string;
  raw_name: string;
  qualifier_chain: string;
  import_path: string | null;
  ast_node_type: string;
  file_path: string;
  metadata: string;
}

export function referenceCandidateToRow(ref: ReferenceCandidate): ReferenceCandidateRow {
  return {
    id: ref.id,
    from_symbol_id: ref.fromSymbolId,
    kind: ref.kind,
    raw_name: ref.rawName,
    qualifier_chain: JSON.stringify(ref.qualifierChain ?? []),
    import_path: ref.importPath ?? null,
    ast_node_type: ref.astNodeType,
    file_path: ref.filePath,
    ...rangeToCols(ref.range),
    metadata: encodeMetadata(ref.metadata)
  };
}

export function rowToReferenceCandidate(row: ReferenceCandidateRow): ReferenceCandidate {
  const candidate: ReferenceCandidate = {
    id: row.id,
    fromSymbolId: row.from_symbol_id,
    kind: row.kind as ReferenceKind,
    rawName: row.raw_name,
    qualifierChain: parseStringArray(row.qualifier_chain),
    astNodeType: row.ast_node_type,
    filePath: row.file_path,
    range: colsToRange(row),
    metadata: decodeMetadata(row.metadata)
  };
  // Optional field: only set when present, so the shape matches what
  // JSON.parse produced for models written by the old storage.
  if (row.import_path !== null) {
    candidate.importPath = row.import_path;
  }
  return candidate;
}

// ── Diagnostic ──────────────────────────────────────────────────────────────

export interface DiagnosticRow {
  kind: string;
  severity: string;
  message: string;
  file_path: string;
  start_line: number | null;
  start_col: number | null;
  end_line: number | null;
  end_col: number | null;
  related_symbol_ids: string | null;
  related_candidate_id: string | null;
}

export function diagnosticToRow(diagnostic: Diagnostic): DiagnosticRow {
  const range = diagnostic.range ? rangeToCols(diagnostic.range) : null;
  return {
    kind: diagnostic.kind,
    severity: diagnostic.severity,
    message: diagnostic.message,
    file_path: diagnostic.filePath,
    start_line: range ? range.start_line : null,
    start_col: range ? range.start_col : null,
    end_line: range ? range.end_line : null,
    end_col: range ? range.end_col : null,
    related_symbol_ids: diagnostic.relatedSymbolIds
      ? JSON.stringify(diagnostic.relatedSymbolIds)
      : null,
    related_candidate_id: diagnostic.relatedCandidateId ?? null
  };
}

export function rowToDiagnostic(row: DiagnosticRow): Diagnostic {
  const diagnostic: Diagnostic = {
    kind: row.kind as DiagnosticKind,
    severity: row.severity as DiagnosticSeverity,
    message: row.message,
    filePath: row.file_path
  };

  // range, relatedSymbolIds and relatedCandidateId are all optional on Diagnostic.
  // Assign only when stored, mirroring JSON's omit-undefined behaviour.
  if (row.start_line !== null && row.start_col !== null && row.end_line !== null && row.end_col !== null) {
    diagnostic.range = colsToRange({
      start_line: row.start_line,
      start_col: row.start_col,
      end_line: row.end_line,
      end_col: row.end_col
    });
  }
  if (row.related_symbol_ids !== null) {
    diagnostic.relatedSymbolIds = parseStringArray(row.related_symbol_ids);
  }
  if (row.related_candidate_id !== null) {
    diagnostic.relatedCandidateId = row.related_candidate_id;
  }

  return diagnostic;
}

// ── misc ────────────────────────────────────────────────────────────────────

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
