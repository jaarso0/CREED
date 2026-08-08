import * as path from 'path';
import { ReferenceCandidate, Symbol, Scope, Containment } from '../semantic-model/types.js';
import { SymbolRegistry } from '../registry/registry.js';
import { isRangeContained } from '../registry/registry.js';

export class ScopeResolver {
  private registry: SymbolRegistry;
  private containments: Containment[];

  constructor(registry: SymbolRegistry, containments: Containment[]) {
    this.registry = registry;
    this.containments = containments;
  }

  public resolveScope(
    candidate: ReferenceCandidate,
    resolvedImports: Map<string, Symbol>
  ): { symbol: Symbol; method: 'scope' | 'qualified_name' | 'global_fallback' } | undefined {
    const { filePath, range, rawName, qualifierChain } = candidate;
    const nameToLookUp = qualifierChain[0] || rawName;

    // `this.x` / `self.x`: resolve the receiver to the enclosing class of the referencing
    // symbol, then resolve the rest of the chain through it (member method, or a field whose
    // declared type carries the next hop). Without this, `this.graph.getNode(...)` and
    // `self.foo()` never resolve and pollute the unresolved-reference list / undercount impact.
    if ((qualifierChain[0] === 'this' || qualifierChain[0] === 'self') && qualifierChain.length > 1) {
      const enclosingClass = this.findEnclosingClass(candidate.fromSymbolId);
      if (enclosingClass) {
        const member = this.resolveChain(enclosingClass, qualifierChain, 1, resolvedImports);
        if (member) {
          return { symbol: member, method: 'scope' };
        }
      }
      // Don't fall through to treating "this"/"self" as a global name — it never is.
      return undefined;
    }

    // Find all scopes in the file
    const fileSymbols = this.registry.byFile.lookup(filePath);
    const fileScopes: Scope[] = [];

    // We walk through all scopes to find containing ones
    // Note: SymbolRegistry holds rawScopes internally, but we can also query ScopeIndex or scan raw scopes.
    // Let's find the innermost containing scope from ScopeIndex or by checking all scopes in the registry.
    const innermostScope = this.getInnermostScope(filePath, range);

    let currentScope = innermostScope;
    while (currentScope) {
      const scopeSymbols = this.registry.byScope.getSymbolsInScope(currentScope.id);

      // Look for a symbol declared in this scope matching the first chain element
      const matchedBase = scopeSymbols.find(s => s.name === nameToLookUp);
      if (matchedBase) {
        if (qualifierChain.length > 1) {
          const resolvedMember = this.resolveChain(matchedBase, qualifierChain, 1, resolvedImports);
          if (resolvedMember) {
            return { symbol: resolvedMember, method: 'scope' };
          }
        } else {
          return { symbol: matchedBase, method: 'scope' };
        }
      }

      // Local (function/method-body) variables never became Symbols, so they can't show up
      // in scopeSymbols above — check the resolver-only local type binding for this scope's
      // owner instead, so `localVar.method()` still resolves through its declared type.
      if (!matchedBase && qualifierChain.length > 1 && currentScope.ownerSymbolId) {
        const localBinding = this.registry.localBindings.lookup(currentScope.ownerSymbolId, nameToLookUp);
        if (localBinding) {
          const typeSymbol = this.resolveTypeSymbol(localBinding.declaredType.qualifierChain, filePath, resolvedImports);
          if (typeSymbol) {
            const resolvedMember = this.resolveChain(typeSymbol, qualifierChain, 1, resolvedImports);
            if (resolvedMember) {
              return { symbol: resolvedMember, method: 'scope' };
            }
          }
        }
      }

      // Walk up the scope parent chain
      if (currentScope.parentScopeId) {
        currentScope = this.registry.byScope.getScopeById(currentScope.parentScopeId);
      } else {
        currentScope = undefined;
      }
    }

    // Check file-level imports (if imported in the same file)
    // Support prefix matching for dotted Python imports (e.g. import a.b -> qualifier chain a.b.c)
    for (let len = qualifierChain.length; len >= 1; len--) {
      const prefix = qualifierChain.slice(0, len).join('.');
      const resolvedImport = resolvedImports.get(prefix);
      if (resolvedImport) {
        const resolvedMember = this.resolveChain(resolvedImport, qualifierChain, len, resolvedImports);
        if (resolvedMember) {
          return { symbol: resolvedMember, method: 'scope' };
        }
      }
    }

    // Fall back to best-effort qualified name lookup (qualified_name method)
    const category = this.getLanguageCategory(filePath);
    if (qualifierChain.length > 1) {
      const qname = qualifierChain.join('.');
      const qnameMatches = this.registry.byQualifiedName.lookup(qname).filter(
        s => this.getLanguageCategory(s.filePath) === category
      );
      if (qnameMatches.length > 0) {
        // Return first match
        return { symbol: qnameMatches[0], method: 'qualified_name' };
      }
    }

    // Final fallback: global lookup by name (global_fallback method)
    const nameMatches = this.registry.byName.lookup(nameToLookUp).filter(
      s => this.getLanguageCategory(s.filePath) === category
    );
    // Prefer non-file, non-project symbols first
    const cleanMatches = nameMatches.filter(s => s.kind !== 'file' && s.kind !== 'project');
    const bestMatch = cleanMatches[0] || nameMatches[0];

    if (bestMatch) {
      if (qualifierChain.length > 1) {
        const resolvedMember = this.resolveChain(bestMatch, qualifierChain, 1, resolvedImports);
        if (resolvedMember) {
          return { symbol: resolvedMember, method: 'global_fallback' };
        }
      }
      return { symbol: bestMatch, method: 'global_fallback' };
    }

    // Builtins fallback
    const BUILTINS = new Set([
      'print', 'len', 'str', 'int', 'float', 'dict', 'list', 'set', 'tuple', 'range', 'enumerate',
      'zip', 'getattr', 'setattr', 'hasattr', 'any', 'all', 'min', 'max', 'sum', 'open', 'type',
      'id', 'map', 'filter', 'next', 'iter', 'repr', 'Exception', 'ValueError', 'TypeError', 'KeyError',
      'bool', 'abs', 'round', 'pow', 'divmod', 'sorted', 'reversed', 'slice', 'ord', 'chr',
      'isinstance', 'issubclass', 'callable', 'locals', 'globals', 'hash', 'classmethod', 'staticmethod',
      'property', 'super', 'object',
      'console', 'log', 'error', 'warn', 'info', 'dir', 'Math', 'Date', 'JSON', 'Map', 'Set', 'Promise',
      'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Error', 'setTimeout', 'setInterval',
      'clearTimeout', 'clearInterval', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
      'decodeURIComponent'
    ]);

    if (BUILTINS.has(nameToLookUp)) {
      const extSymbolId = `external::builtin::${nameToLookUp}`;
      let extSymbol = this.registry.byId.lookup(extSymbolId);
      if (!extSymbol) {
        extSymbol = {
          id: extSymbolId,
          kind: 'function',
          name: nameToLookUp,
          qualifiedName: nameToLookUp,
          filePath: 'builtin',
          range: candidate.range,
          exported: true,
          visibility: 'public',
          metadata: { external: true }
        };
        this.registry.byId.add(extSymbol);
        this.registry.byName.add(extSymbol);
        this.registry.byQualifiedName.add(extSymbol);
      }

      if (qualifierChain.length > 1) {
        const resolvedMember = this.resolveChain(extSymbol, qualifierChain, 1, resolvedImports);
        if (resolvedMember) {
          return { symbol: resolvedMember, method: 'global_fallback' };
        }
      }
      return { symbol: extSymbol, method: 'global_fallback' };
    }

    return undefined;
  }

  private getInnermostScope(filePath: string, range: Range): Scope | undefined {
    // Every scope in the file is a candidate, regardless of whether anything declared
    // directly inside it became a full Symbol — a function body containing only local
    // variables and calls (no nested declarations) still needs its own scope to be found.
    const scopes = this.registry.byScope
      .getScopesForFile(filePath)
      .filter(s => isRangeContained(range, s.range));

    if (scopes.length === 0) return undefined;

    // Sort by range size (smallest first)
    scopes.sort((a, b) => {
      const sizeA = (a.range.end.line - a.range.start.line) * 10000 + (a.range.end.column - a.range.start.column);
      const sizeB = (b.range.end.line - b.range.start.line) * 10000 + (b.range.end.column - b.range.start.column);
      return sizeA - sizeB;
    });

    return scopes[0];
  }

  private resolveChain(
    startSymbol: Symbol,
    chain: string[],
    index: number,
    resolvedImports?: Map<string, Symbol>
  ): Symbol | undefined {
    if (index >= chain.length) return startSymbol;

    const memberName = chain[index];
    const nextSymbol = this.resolveMember(startSymbol, memberName, resolvedImports);
    if (!nextSymbol) return undefined;

    return this.resolveChain(nextSymbol, chain, index + 1, resolvedImports);
  }

  private resolveMember(
    parentSymbol: Symbol,
    memberName: string,
    resolvedImports?: Map<string, Symbol>
  ): Symbol | undefined {
    const childEdges = this.containments.filter(c => c.parentId === parentSymbol.id);
    for (const edge of childEdges) {
      const child = this.registry.byId.lookup(edge.childId);
      if (child && child.name === memberName) {
        return child;
      }
    }

    // Instance member access: `parentSymbol` is a variable (e.g. `const registry = new Foo()`),
    // so its own containments are empty — the member actually lives on its declared type's class.
    // Hop to the class symbol and retry the member lookup there.
    if (parentSymbol.kind === 'variable') {
      const declaredType = parentSymbol.metadata?.declaredType as
        | { qualifierChain: string[] }
        | undefined;
      if (declaredType && declaredType.qualifierChain.length > 0) {
        const typeSymbol = this.resolveTypeSymbol(
          declaredType.qualifierChain,
          parentSymbol.filePath,
          resolvedImports
        );
        if (typeSymbol && typeSymbol.id !== parentSymbol.id) {
          const member = this.resolveMember(typeSymbol, memberName, resolvedImports);
          if (member) return member;
        }

        // The declared type isn't a project class/interface — it's a stdlib type (Map, Set,
        // Promise) or something from a dependency (`Database` from better-sqlite3). Synthesize
        // an external symbol for it, exactly as the BUILTINS path in resolveScope does for
        // bare `console.log`. Without this the whole chain is dropped, which is why
        // `this.fileCache.clear()` on a `Map` field appeared as an unresolved reference.
        if (!typeSymbol) {
          const external = this.externalTypeSymbol(declaredType.qualifierChain, parentSymbol);
          if (external) {
            const member = this.resolveMember(external, memberName, resolvedImports);
            if (member) return member;
          }
        }
      }
    }

    // Dynamic member resolution for external symbols
    if (parentSymbol.metadata?.external) {
      const childId = `${parentSymbol.id}::${memberName}`;
      let child = this.registry.byId.lookup(childId);
      if (!child) {
        child = {
          id: childId,
          kind: memberName[0] === memberName[0].toUpperCase() && memberName[0] !== memberName[0].toLowerCase() ? 'class' : 'method',
          name: memberName,
          qualifiedName: `${parentSymbol.qualifiedName}.${memberName}`,
          filePath: parentSymbol.filePath,
          range: parentSymbol.range,
          exported: true,
          visibility: 'public',
          metadata: { external: true }
        };
        this.registry.byId.add(child);
        this.registry.byName.add(child);
        this.registry.byQualifiedName.add(child);
        this.containments.push({
          parentId: parentSymbol.id,
          childId: child.id,
          kind: 'has_member'
        });
      }
      return child;
    }

    return undefined;
  }

  /**
   * Gets (creating once) an external stand-in symbol for a type declared in this project but
   * defined outside it — stdlib (`Map`, `Set`) or a dependency (`Database`).
   *
   * These are marked `external`, which makes `resolveMember` synthesize members on demand, so
   * `this.cache.get(...)` produces a real edge to `external::type::Map::get` rather than
   * vanishing. Edges to these are honest: they say "this goes somewhere outside the project"
   * instead of silently dropping the reference or, worse, name-matching onto an unrelated
   * project symbol.
   */
  private externalTypeSymbol(qualifierChain: string[], context: Symbol): Symbol | undefined {
    const name = qualifierChain[qualifierChain.length - 1];
    if (!name) return undefined;

    // Type names are capitalized by convention in every language this indexes. A lowercase
    // name here is far more likely to be a mis-parsed annotation than a real external type.
    if (name[0] !== name[0].toUpperCase() || name[0] === name[0].toLowerCase()) return undefined;

    const id = `external::type::${name}`;
    let symbol = this.registry.byId.lookup(id);
    if (!symbol) {
      symbol = {
        id,
        kind: 'class',
        name,
        qualifiedName: name,
        filePath: 'external',
        range: context.range,
        exported: true,
        visibility: 'public',
        metadata: { external: true }
      };
      this.registry.byId.add(symbol);
      this.registry.byName.add(symbol);
      this.registry.byQualifiedName.add(symbol);
    }
    return symbol;
  }

  /** Walk containment parents up from a symbol to the class/interface/struct that encloses it. */
  private findEnclosingClass(symbolId: string | undefined): Symbol | undefined {
    let current = symbolId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const parentEdge = this.containments.find(
        c => c.childId === current && (c.kind === 'has_member' || c.kind === 'owns')
      );
      if (!parentEdge) break;
      const parent = this.registry.byId.lookup(parentEdge.parentId);
      if (parent && (parent.kind === 'class' || parent.kind === 'interface' || parent.kind === 'struct')) {
        return parent;
      }
      current = parentEdge.parentId;
    }
    return undefined;
  }

  /**
   * Resolves a declared type name to its class/interface symbol.
   *
   * Ambiguity is the hazard here, not absence: a bare name lookup returns every same-named
   * type in the project, and taking the first one silently binds to whichever happened to
   * be indexed first. This repo has two `SymbolIndex` symbols — a class in registry.ts and
   * the interface in retrieval/symbol-index.ts — so `this.indexes.matchByName()` resolved
   * against the wrong one and failed. Worse than failing, a near-miss produces a *wrong*
   * edge that looks confident.
   *
   * Preference order: what the file actually imported under that name, then a type declared
   * in the same file, then a unique global match. An ambiguous global match resolves to
   * nothing rather than guessing.
   */
  private resolveTypeSymbol(
    qualifierChain: string[],
    filePath: string,
    resolvedImports?: Map<string, Symbol>
  ): Symbol | undefined {
    const category = this.getLanguageCategory(filePath);
    const isTypeKind = (s: Symbol) => s.kind === 'class' || s.kind === 'interface';
    const name = qualifierChain[qualifierChain.length - 1];

    // 1. The binding this file actually has for that name.
    const imported = resolvedImports?.get(qualifierChain.join('.')) ?? resolvedImports?.get(name);
    if (imported && isTypeKind(imported)) return imported;

    if (qualifierChain.length > 1) {
      const qname = qualifierChain.join('.');
      const qnameMatches = this.registry.byQualifiedName
        .lookup(qname)
        .filter(s => isTypeKind(s) && this.getLanguageCategory(s.filePath) === category);
      if (qnameMatches.length > 0) return qnameMatches[0];
    }

    const nameMatches = this.registry.byName
      .lookup(name)
      .filter(s => isTypeKind(s) && this.getLanguageCategory(s.filePath) === category);

    // 2. Declared in this very file.
    const sameFile = nameMatches.find(s => s.filePath === filePath);
    if (sameFile) return sameFile;

    // 3. Unambiguous project-wide. Several same-named types with no import to disambiguate
    // is a genuine unknown — returning one at random is how wrong edges get created.
    return nameMatches.length === 1 ? nameMatches[0] : undefined;
  }

  private getLanguageCategory(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.py') return 'python';
    if (ext === '.java') return 'java';
    if (ext === '.html') return 'html';
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return 'typescript';
    return 'unknown';
  }
}
