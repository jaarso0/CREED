import {
  ReferenceCandidate,
  ResolvedReference,
  Diagnostic,
  Symbol,
  Containment
} from '../semantic-model/types.js';
import { SymbolRegistry } from '../registry/registry.js';
import { ImportResolver } from './import-resolver.js';
import { ScopeResolver } from './scope-resolver.js';
import { createDiagnostic } from '../semantic-model/builder.js';

export interface ResolutionResult {
  resolved: ResolvedReference[];
  unresolved: ReferenceCandidate[];
  diagnostics: Diagnostic[];
}

export function resolveAll(
  references: ReferenceCandidate[],
  registry: SymbolRegistry,
  containments: Containment[]
): ResolutionResult {
  const resolved: ResolvedReference[] = [];
  const unresolved: ReferenceCandidate[] = [];
  const diagnostics: Diagnostic[] = [];

  const importResolver = new ImportResolver(registry);
  const scopeResolver = new ScopeResolver(registry, containments);

  // Group resolved imports by file: filePath -> Map<localName, targetSymbol>
  const fileResolvedImports = new Map<string, Map<string, Symbol>>();

  // ════════════════════════════════════════════
  // STAGE 1: RESOLVE IMPORTS FIRST
  // ════════════════════════════════════════════
  const importCandidates = references.filter(r => r.kind === 'import');
  for (const cand of importCandidates) {
    const resolvedSym = importResolver.resolveImport(cand);

    if (resolvedSym) {
      // Record resolved reference
      resolved.push({
        candidateId: cand.id,
        fromSymbolId: cand.fromSymbolId,
        toSymbolId: resolvedSym.id,
        kind: 'import',
        resolutionMethod: 'import'
      });

      // Save to file-level resolved imports map
      let fileMap = fileResolvedImports.get(cand.filePath);
      if (!fileMap) {
        fileMap = new Map<string, Symbol>();
        fileResolvedImports.set(cand.filePath, fileMap);
      }
      // Bind the import under the name call sites actually use. For TS/Java/Python that is
      // `rawName` and nothing more is needed, but Go, C++ and R import a *path*
      // (`"gofixture/service"`, `"user_repo.h"`) while the code refers to the package by its
      // final segment — so the resolved local name is registered as well. rawName is set
      // last so an explicit name always wins a collision.
      const importedName = cand.metadata?.importedName as string | undefined;
      if (importedName) fileMap.set(importedName, resolvedSym);
      fileMap.set(cand.rawName, resolvedSym);
    } else {
      unresolved.push(cand);
      diagnostics.push(
        createDiagnostic({
          kind: 'unresolved_import',
          severity: 'warning',
          message: `Unable to resolve import path or name for '${cand.rawName}' in ${cand.importPath || 'unknown path'}`,
          filePath: cand.filePath,
          range: cand.range,
          relatedCandidateId: cand.id
        })
      );
    }
  }

  // ════════════════════════════════════════════
  // STAGE 2: RESOLVE ALL OTHER REFERENCES
  // ════════════════════════════════════════════
  const nonImportCandidates = references.filter(r => r.kind !== 'import');
  for (const cand of nonImportCandidates) {
    const fileImports = fileResolvedImports.get(cand.filePath) || new Map<string, Symbol>();
    const res = scopeResolver.resolveScope(cand, fileImports);

    if (res) {
      // Determine resolution method
      // If we resolved it via import path match in Stage 2, the method was scope but we can mark it as import
      let finalMethod = res.method;
      if (res.method === 'scope') {
        const baseName = cand.qualifierChain[0] || cand.rawName;
        if (fileImports.has(baseName)) {
          finalMethod = 'import';
        }
      }

      resolved.push({
        candidateId: cand.id,
        fromSymbolId: cand.fromSymbolId,
        toSymbolId: res.symbol.id,
        kind: cand.kind,
        resolutionMethod: finalMethod
      });
    } else {
      unresolved.push(cand);

      // Only emit warnings for unresolvable references (excluding common native symbols like console or print)
      const isNativeSymbol = ['console', 'print', 'len', 'range', 'str', 'int', 'dict', 'list', 'set', 'true', 'false'].includes(cand.rawName.toLowerCase());
      if (!isNativeSymbol) {
        diagnostics.push(
          createDiagnostic({
            kind: 'unresolved_reference',
            severity: 'info', // set as info, since type inference is v2, many member lookups will degrade gracefully
            message: `Reference '${cand.rawName}' could not be resolved`,
            filePath: cand.filePath,
            range: cand.range,
            relatedCandidateId: cand.id
          })
        );
      }
    }
  }

  return {
    resolved,
    unresolved,
    diagnostics
  };
}
