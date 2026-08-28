import * as path from 'path';
import { ReferenceCandidate, Symbol } from '../semantic-model/types.js';
import { SymbolRegistry } from '../registry/registry.js';
import { languageCategory } from '../parse/lang-detect.js';

/**
 * Resolves reference candidates of kind 'import' to their corresponding target symbols.
 */
export class ImportResolver {
  private registry: SymbolRegistry;

  constructor(registry: SymbolRegistry) {
    this.registry = registry;
  }

  public resolveImport(candidate: ReferenceCandidate): Symbol | undefined {
    if (candidate.kind !== 'import' || !candidate.importPath) {
      return undefined;
    }

    const { filePath, importPath, rawName } = candidate;

    let resolvedSym: Symbol | undefined;
    switch (languageCategory(filePath)) {
      case 'python':
        resolvedSym = this.resolvePythonImport(filePath, importPath, rawName, candidate);
        break;
      // C# `using` names a namespace the same way a Java import names a package: a dotted
      // path already flattened to slashes by the normalizer.
      case 'java':
      case 'csharp':
        resolvedSym = this.resolveJavaImport(filePath, importPath, rawName, candidate);
        break;
      // Go imports a package directory, not a file — its own resolver.
      case 'go':
        resolvedSym = this.resolveGoImport(filePath, importPath, rawName, candidate);
        break;
      // `#include "repo.h"` and `source("utils.R")` are both plain relative file paths,
      // which is exactly what the HTML resolver already does.
      case 'html':
      case 'cpp':
        resolvedSym = this.resolveHtmlImport(filePath, importPath, rawName, candidate);
        break;
      case 'r':
        resolvedSym = this.resolveRImport(filePath, importPath, rawName, candidate);
        break;
      default:
        resolvedSym = this.resolveTypeScriptImport(filePath, importPath, rawName, candidate);
    }

    if (resolvedSym) {
      return resolvedSym;
    }

    // Intercept unresolved external imports (standard libraries & third-party packages)
    if (!this.isInternalPath(importPath)) {
      const lookupName = (candidate.metadata?.importedName as string) || rawName;
      const extSymbolId = `external::${importPath.replace(/\\/g, '/')}::${lookupName}`;

      let extSymbol = this.registry.byId.lookup(extSymbolId);
      if (!extSymbol) {
        extSymbol = {
          id: extSymbolId,
          kind: lookupName[0] === lookupName[0].toUpperCase() && lookupName[0] !== lookupName[0].toLowerCase() ? 'class' : 'variable',
          name: lookupName,
          qualifiedName: `${importPath.replace(/\//g, '.')}.${lookupName}`,
          filePath: 'external',
          range: candidate.range,
          exported: true,
          visibility: 'public',
          metadata: { external: true }
        };
        this.registry.byId.add(extSymbol);
        this.registry.byName.add(extSymbol);
        this.registry.byQualifiedName.add(extSymbol);
      }
      return extSymbol;
    }

    return undefined;
  }

  private isInternalPath(importPath: string): boolean {
    const normPath = importPath.replace(/\\/g, '/');
    const firstSegment = normPath.split('/')[0];
    if (!firstSegment) return false;

    // Check if any file symbol in the registry starts with the first segment
    const allSymbols = this.registry.byId.values();
    const fileSymbols = allSymbols.filter(s => s.kind === 'file');
    return fileSymbols.some(s => {
      const normalizedFile = s.filePath.replace(/\\/g, '/');
      const fileSegment = normalizedFile.split('/')[0];
      return fileSegment === firstSegment;
    });
  }

  private resolvePythonImport(
    filePath: string,
    importPath: string,
    rawName: string,
    candidate: ReferenceCandidate
  ): Symbol | undefined {
    // Handle relative imports (e.g. from .local import config -> importPath is "/local" or similar)
    let dotsCount = 0;
    while (dotsCount < importPath.length && importPath[dotsCount] === '/') {
      dotsCount++;
    }

    let resolvedImportPath = importPath;
    if (dotsCount > 0) {
      const dir = path.dirname(filePath);
      let targetDir = dir;
      for (let i = 0; i < dotsCount - 1; i++) {
        targetDir = path.dirname(targetDir);
      }
      const rest = importPath.substring(dotsCount);
      resolvedImportPath = path.join(targetDir, rest).replace(/\\/g, '/');
      // normalize leading './' if any
      if (resolvedImportPath.startsWith('./')) {
        resolvedImportPath = resolvedImportPath.substring(2);
      }
    }

    const candidates = [
      resolvedImportPath,
      resolvedImportPath + '.py',
      resolvedImportPath + '/__init__.py',
      resolvedImportPath.replace(/\//g, '.') // dotted notation
    ];

    let targetFileSymbol: Symbol | undefined;
    for (const cand of candidates) {
      const match = this.registry.byModule.lookup(cand);
      if (match) {
        targetFileSymbol = match;
        break;
      }
    }

    if (!targetFileSymbol) {
      // Best effort check by searching for file symbol that matches module name in path
      const allSymbols = this.registry.byId.values();
      targetFileSymbol = allSymbols.find(
        s => s.kind === 'file' && s.filePath.replace(/\.py$/, '').endsWith(resolvedImportPath)
      );
    }

    const lookupName = (candidate.metadata?.importedName as string) || rawName;

    if (targetFileSymbol) {
      // If we are importing the module itself directly
      if (candidate.astNodeType === 'import_statement') {
        return targetFileSymbol;
      }

      // Find the imported symbol in that file
      const fileSymbols = this.registry.byFile.lookup(targetFileSymbol.filePath);

      // Match by name or qualifiedName
      const match = fileSymbols.find(
        s => s.kind !== 'file' && s.exported && (s.name === lookupName || s.qualifiedName === lookupName)
      );
      if (match) return match;

      // If we are importing the module itself as a fallback
      if (targetFileSymbol.name === lookupName || targetFileSymbol.filePath.endsWith(lookupName + '.py')) {
        return targetFileSymbol;
      }
    }

    // Try a global lookup of the name among exported symbols if path-based resolution fails
    const globalMatches = this.registry.byName.lookup(lookupName);
    const category = this.getLanguageCategory(filePath);
    const exportedMatch = globalMatches.find(s =>
      s.kind !== 'file' && s.exported && this.getLanguageCategory(s.filePath) === category
    );
    if (exportedMatch) return exportedMatch;

    return undefined;
  }

  private resolveTypeScriptImport(
    filePath: string,
    importPath: string,
    rawName: string,
    candidate: ReferenceCandidate
  ): Symbol | undefined {
    // For TS/JS: import { UserService } from './services/user.js'
    // Calculate path relative to current file's directory
    const dir = path.dirname(filePath);
    const relativeTarget = path.join(dir, importPath).replace(/\\/g, '/');

    // Try absolute path if importPath is a absolute/alias path (fallback)
    const candidates = [
      relativeTarget,
      relativeTarget + '.ts',
      relativeTarget + '.tsx',
      relativeTarget + '.js',
      relativeTarget + '.jsx',
      relativeTarget + '/index.ts',
      relativeTarget + '/index.tsx',
      relativeTarget + '/index.js'
    ];

    let targetFileSymbol: Symbol | undefined;
    for (const cand of candidates) {
      const match = this.registry.byModule.lookup(cand);
      if (match) {
        targetFileSymbol = match;
        break;
      }
    }

    // Fallback: look up by matching any part of file path
    if (!targetFileSymbol) {
      const cleanImportPath = importPath.replace(/^[\.\/]+/, '');
      const allSymbols = this.registry.byId.values();
      targetFileSymbol = allSymbols.find(
        s => s.kind === 'file' && s.filePath.replace(/\.[jt]sx?$/, '').endsWith(cleanImportPath)
      );
    }

    const lookupName = (candidate.metadata?.importedName as string) || rawName;

    if (targetFileSymbol) {
      // Find the imported symbol in that file
      const fileSymbols = this.registry.byFile.lookup(targetFileSymbol.filePath);

      const match = fileSymbols.find(
        s => s.kind !== 'file' && s.exported && (s.name === lookupName || s.qualifiedName === lookupName)
      );
      if (match) return match;
    }

    // Fallback: look up globally by name
    const globalMatches = this.registry.byName.lookup(lookupName);
    const category = this.getLanguageCategory(filePath);
    const exportedMatch = globalMatches.find(s =>
      s.kind !== 'file' && s.exported && this.getLanguageCategory(s.filePath) === category
    );
    if (exportedMatch) return exportedMatch;

    return undefined;
  }

  /**
   * Go imports a *package*, which is a directory — `import "myapp/repo"` pulls in every file
   * under `myapp/repo/`, not a file called `repo`. So the match is on the containing
   * directory, and the imported name is looked up across all files in it.
   *
   * The name resolved is the package name; the symbols inside are reached by the call
   * resolver through `pkg.Symbol` qualifier chains, not by the import itself.
   */
  private resolveGoImport(
    filePath: string,
    importPath: string,
    rawName: string,
    candidate: ReferenceCandidate
  ): Symbol | undefined {
    const cleanImportPath = importPath.replace(/^[\.\/]+/, '').replace(/\/+$/, '');
    const lookupName = (candidate.metadata?.importedName as string) || rawName;

    // A Go import path is module-qualified — `gofixture/service` for a package that lives in
    // `service/` on disk, because `gofixture` is the module name from go.mod, not a
    // directory. Since go.mod isn't parsed, try the path with leading segments progressively
    // dropped and take the most specific directory that matches.
    const segments = cleanImportPath.split('/').filter(Boolean);
    const candidateDirs: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      candidateDirs.push(segments.slice(i).join('/'));
    }

    const allSymbols = this.registry.byId.values();
    let packageFiles: Symbol[] = [];
    for (const dirCandidate of candidateDirs) {
      packageFiles = allSymbols.filter(s => {
        if (s.kind !== 'file') return false;
        const dir = path.dirname(s.filePath.replace(/\\/g, '/'));
        return dir === dirCandidate || dir.endsWith('/' + dirCandidate);
      });
      if (packageFiles.length > 0) break;
    }

    for (const fileSymbol of packageFiles) {
      const fileSymbols = this.registry.byFile.lookup(fileSymbol.filePath);
      const match = fileSymbols.find(
        s => s.kind !== 'file' && s.exported && (s.name === lookupName || s.qualifiedName === lookupName)
      );
      if (match) return match;
    }

    // The package resolved but nothing inside it matched by name: point at one of its files
    // so the import edge still lands somewhere real.
    if (packageFiles.length > 0) return packageFiles[0];

    const globalMatches = this.registry.byName.lookup(lookupName);
    const category = this.getLanguageCategory(filePath);
    const exportedMatch = globalMatches.find(s =>
      s.kind !== 'file' && s.exported && this.getLanguageCategory(s.filePath) === category
    );
    if (exportedMatch) return exportedMatch;

    return undefined;
  }

  private resolveJavaImport(
    filePath: string,
    importPath: string,
    rawName: string,
    candidate: ReferenceCandidate
  ): Symbol | undefined {
    const cleanImportPath = importPath.replace(/^[\.\/]+/, '');
    const isWildcard = cleanImportPath.endsWith('*');
    const lookupPath = isWildcard ? cleanImportPath.slice(0, -1) : cleanImportPath;

    const allSymbols = this.registry.byId.values();
    let targetFileSymbol: Symbol | undefined;

    if (!isWildcard) {
      // Extension-agnostic: this resolver serves C# (`.cs`) as well as Java.
      targetFileSymbol = allSymbols.find(
        s => s.kind === 'file' && s.filePath.replace(/\.[A-Za-z0-9]+$/, '').endsWith(lookupPath)
      );
    }

    const lookupName = (candidate.metadata?.importedName as string) || rawName;

    if (targetFileSymbol) {
      const fileSymbols = this.registry.byFile.lookup(targetFileSymbol.filePath);
      const match = fileSymbols.find(
        s => s.kind !== 'file' && s.exported && (s.name === lookupName || s.qualifiedName === lookupName)
      );
      if (match) return match;
    }

    // Fallback: look up globally by name
    const globalMatches = this.registry.byName.lookup(lookupName);
    const category = this.getLanguageCategory(filePath);
    const exportedMatch = globalMatches.find(s =>
      s.kind !== 'file' && s.exported && this.getLanguageCategory(s.filePath) === category
    );
    if (exportedMatch) return exportedMatch;

    return undefined;
  }

  /**
   * R's `source("R/utils.R")` is resolved against the working directory — in practice the
   * project root — not against the file doing the sourcing. Joining it to the caller's
   * directory the way every other language expects turns `R/utils.R` into `R/R/utils.R`, so
   * the root-relative reading is tried first and the file-relative one only as a fallback.
   *
   * `library(dplyr)` has no path at all and simply falls through to the external-package
   * handling in resolveImport.
   */
  private resolveRImport(
    filePath: string,
    importPath: string,
    rawName: string,
    candidate: ReferenceCandidate
  ): Symbol | undefined {
    const normalized = importPath.replace(/\\/g, '/').replace(/^\.\//, '');

    const direct = this.registry.byModule.lookup(normalized);
    if (direct) return direct;

    const allSymbols = this.registry.byId.values();
    const bySuffix = allSymbols.find(
      s => s.kind === 'file' && s.filePath.replace(/\\/g, '/').endsWith(normalized)
    );
    if (bySuffix) return bySuffix;

    return this.resolveHtmlImport(filePath, importPath, rawName, candidate);
  }

  private resolveHtmlImport(
    filePath: string,
    importPath: string,
    rawName: string,
    candidate: ReferenceCandidate
  ): Symbol | undefined {
    const dir = path.dirname(filePath);
    const relativeTarget = path.join(dir, importPath).replace(/\\/g, '/');

    const extIndex = relativeTarget.lastIndexOf('.');
    const targetNoExt = extIndex !== -1 ? relativeTarget.slice(0, extIndex) : relativeTarget;

    const candidates = [
      relativeTarget,
      targetNoExt,
      relativeTarget + '.ts',
      relativeTarget + '.tsx',
      relativeTarget + '.js',
      relativeTarget + '.jsx',
      relativeTarget + '/index.ts',
      relativeTarget + '/index.tsx',
      relativeTarget + '/index.js'
    ];

    for (const cand of candidates) {
      const match = this.registry.byModule.lookup(cand);
      if (match) {
        return match;
      }
    }

    // Fallback: look up by matching file suffix
    const cleanImportPath = importPath.replace(/^[\.\/]+/, '');
    const allSymbols = this.registry.byId.values();
    const targetFileSymbol = allSymbols.find(
      s => s.kind === 'file' && s.filePath.replace(/\.[a-zA-Z0-9]+$/, '').endsWith(cleanImportPath)
    );
    if (targetFileSymbol) {
      return targetFileSymbol;
    }

    return undefined;
  }

  private getLanguageCategory(filePath: string): string {
    return languageCategory(filePath);
  }
}
