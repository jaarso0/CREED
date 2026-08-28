import { describe, test, expect } from 'vitest';
import * as path from 'path';
import { parseProject } from '../src/parse/walker.js';
import { detectLanguage, languageCategory } from '../src/parse/lang-detect.js';
import { extractorRegistry } from '../src/extract/extractor-registry.js';
import { Pipeline } from '../src/pipeline.js';
import { PartialSemanticModel } from '../src/semantic-model/types.js';

/**
 * Coverage for the languages added after the original TS/Python/Java/HTML set.
 *
 * Each language gets the same three questions asked of it: does the grammar load and
 * produce symbols, does the language's own notion of visibility survive extraction, and do
 * references resolve into real cross-file edges rather than dangling names. The fixtures are
 * deliberately small but structurally complete — a type, a member, a cross-file call.
 */

async function extractProject(fixture: string): Promise<Map<string, PartialSemanticModel>> {
  const files = await parseProject(path.resolve(`tests/fixtures/${fixture}`));
  const models = new Map<string, PartialSemanticModel>();
  for (const file of files) {
    models.set(file.filePath, extractorRegistry.getExtractor(file.language).extract(file));
  }
  return models;
}

describe('Language detection', () => {
  test('maps the added extensions to their languages', () => {
    expect(detectLanguage('main.go')).toBe('go');
    expect(detectLanguage('Program.cs')).toBe('csharp');
    expect(detectLanguage('main.cpp')).toBe('cpp');
    expect(detectLanguage('lib.hpp')).toBe('cpp');
    expect(detectLanguage('legacy.c')).toBe('cpp');
    expect(detectLanguage('analysis.R')).toBe('r');
    expect(detectLanguage('analysis.r')).toBe('r');
  });

  test('categories keep languages from matching each other by name', () => {
    // A category collision is what lets a Go `Insert` resolve to a C# `Insert`.
    const categories = ['a.go', 'a.cs', 'a.cpp', 'a.r', 'a.py', 'a.java'].map(languageCategory);
    expect(new Set(categories).size).toBe(categories.length);
    // C and C++ deliberately share one, as do the TS/JS dialects.
    expect(languageCategory('a.c')).toBe(languageCategory('a.hpp'));
    expect(languageCategory('a.tsx')).toBe(languageCategory('a.js'));
  });
});

describe('Go extraction', () => {
  test('indexes types, and files methods under their receiver', async () => {
    const models = await extractProject('go-project');
    const repo = models.get('repo/user_repo.go')!;
    expect(repo).toBeDefined();

    const structSym = repo.symbols.find(s => s.kind === 'struct' && s.name === 'UserRepo');
    expect(structSym).toBeDefined();

    // The receiver is what makes this a method rather than a free function — Go declares it
    // outside the struct body, so range containment alone would file it at file level.
    const method = repo.symbols.find(s => s.name === 'Insert');
    expect(method?.kind).toBe('method');
    expect(method?.qualifiedName).toBe('UserRepo.Insert');

    const service = models.get('service/user_service.go')!;
    expect(service.symbols.find(s => s.kind === 'interface' && s.name === 'Notifier')).toBeDefined();
    expect(service.symbols.find(s => s.kind === 'type_alias' && s.name === 'Handler')).toBeDefined();
  });

  test('reads exportedness off capitalization', async () => {
    const models = await extractProject('go-project');
    const repo = models.get('repo/user_repo.go')!;

    expect(repo.symbols.find(s => s.name === 'Insert')?.exported).toBe(true);
    expect(repo.symbols.find(s => s.name === 'count')?.exported).toBe(false);
    expect(repo.symbols.find(s => s.name === 'count')?.visibility).toBe('private');
  });

  test('strips quotes from import paths and skips builtin types', async () => {
    const models = await extractProject('go-project');
    const service = models.get('service/user_service.go')!;

    const imports = service.references.filter(r => r.kind === 'import');
    expect(imports.map(i => i.importPath)).toEqual(
      expect.arrayContaining(['fmt', 'gofixture/repo'])
    );
    // The raw token is `"fmt"` — the quotes must not survive into the graph.
    expect(imports.every(i => !i.rawName.includes('"'))).toBe(true);

    // `string`/`int` are builtins; a type_use edge to one can never resolve.
    const typeUses = service.references.filter(r => r.kind === 'type_use');
    expect(typeUses.every(r => r.rawName !== 'string' && r.rawName !== 'int')).toBe(true);
  });
});

describe('C# extraction', () => {
  test('nests declarations under their namespace', async () => {
    const models = await extractProject('csharp-project');
    const repo = models.get('Data/UserRepo.cs')!;

    const cls = repo.symbols.find(s => s.kind === 'class' && s.name === 'UserRepo');
    expect(cls?.qualifiedName).toBe('Fixture.Data.UserRepo');

    expect(repo.symbols.find(s => s.kind === 'interface' && s.name === 'IUserRepo')).toBeDefined();
    expect(repo.symbols.find(s => s.kind === 'enum' && s.name === 'Status')).toBeDefined();
    expect(repo.symbols.find(s => s.kind === 'struct' && s.name === 'Point')).toBeDefined();
  });

  test('splits a base list into inherit and implement', async () => {
    const models = await extractProject('csharp-project');
    const service = models.get('Services/UserService.cs')!;

    // `class UserService : BaseService, IUserRepo` — one base class, one interface, and no
    // syntax distinguishing them. The IPascalCase convention is what separates them.
    const inherits = service.references.filter(r => r.kind === 'inherit').map(r => r.rawName);
    const implementsRefs = service.references.filter(r => r.kind === 'implement').map(r => r.rawName);

    expect(inherits).toContain('BaseService');
    expect(implementsRefs).toContain('IUserRepo');
  });

  test('reads visibility from modifiers', async () => {
    const models = await extractProject('csharp-project');
    const service = models.get('Services/UserService.cs')!;

    expect(service.symbols.find(s => s.name === '_repo')?.visibility).toBe('private');
    expect(service.symbols.find(s => s.name === 'Log')?.visibility).toBe('protected');
    expect(service.symbols.find(s => s.name === 'Insert')?.visibility).toBe('public');
  });
});

describe('C++ extraction', () => {
  test('files out-of-line definitions under their class', async () => {
    const models = await extractProject('cpp-project');
    const impl = models.get('src/user_service.cpp')!;

    // `int UserService::Save(...)` is declared in the class body and defined outside it.
    const save = impl.symbols.filter(s => s.name === 'Save');
    expect(save).toHaveLength(1);           // the two must collapse, not double up
    expect(save[0].qualifiedName).toBe('fixture.UserService.Save');
    expect(save[0].kind).toBe('method');
  });

  test('reads access from the enclosing access specifier', async () => {
    const models = await extractProject('cpp-project');
    const header = models.get('src/user_repo.h')!;

    expect(header.symbols.find(s => s.name === 'Insert')?.visibility).toBe('public');
    expect(header.symbols.find(s => s.name === 'count_')?.visibility).toBe('private');
  });

  test('captures includes, bases and enums', async () => {
    const models = await extractProject('cpp-project');
    const header = models.get('src/user_repo.h')!;
    const impl = models.get('src/user_service.cpp')!;

    expect(header.symbols.find(s => s.kind === 'enum' && s.name === 'Color')).toBeDefined();
    expect(header.symbols.find(s => s.kind === 'struct' && s.name === 'User')).toBeDefined();

    const includes = impl.references.filter(r => r.kind === 'import').map(r => r.importPath);
    expect(includes).toContain('user_repo.h');
    // `<string>` and `"user_repo.h"` both arrive with delimiters attached.
    expect(includes.every(p => !p?.match(/["<>]/))).toBe(true);
  });
});

describe('R extraction', () => {
  test('treats an assigned function literal as a function, not a variable', async () => {
    const models = await extractProject('r-project');
    const utils = models.get('R/utils.R')!;

    // `normalize <- function(values)` matches both the function and the assignment pattern.
    const normalize = utils.symbols.filter(s => s.name === 'normalize');
    expect(normalize).toHaveLength(1);
    expect(normalize[0].kind).toBe('function');

    // A plain assignment is still a variable.
    expect(utils.symbols.find(s => s.name === 'MAX_ROWS')?.kind).toBe('variable');
  });

  test('treats a leading dot as internal', async () => {
    const models = await extractProject('r-project');
    const utils = models.get('R/utils.R')!;

    const helper = utils.symbols.find(s => s.name === '.internal_helper');
    expect(helper?.exported).toBe(false);
    expect(helper?.visibility).toBe('private');
  });

  test('re-tags library/source calls as imports', async () => {
    const models = await extractProject('r-project');
    const analysis = models.get('R/analysis.R')!;

    const imports = analysis.references.filter(r => r.kind === 'import');
    // The import target is the call's argument, not the `library`/`source` callee.
    expect(imports.map(i => i.rawName).sort()).toEqual(['stats', 'utils']);
    expect(imports.find(i => i.rawName === 'utils')?.importPath).toBe('R/utils.R');

    // ...and they must no longer be calls.
    const calls = analysis.references.filter(r => r.kind === 'call').map(r => r.rawName);
    expect(calls).not.toContain('library');
    expect(calls).not.toContain('source');
  });
});

describe('Cross-file resolution', () => {
  test('Go resolves a call through a package import', async () => {
    const result = await new Pipeline().build(path.resolve('tests/fixtures/go-project'));
    const model: any = (result as any).model ?? result;

    const byId = new Map<string, any>(model.symbols.map((s: any) => [s.id, s]));
    const edges = model.resolvedReferences.map((r: any) => ({
      from: byId.get(r.fromSymbolId)?.qualifiedName,
      to: byId.get(r.toSymbolId)?.qualifiedName,
      kind: r.kind
    }));

    // `svc := service.NewUserService(...)` in main.go, defined in service/user_service.go.
    // The import path is module-qualified (`gofixture/service`) while the directory is
    // `service/`, so this only works if the module prefix is stripped.
    expect(edges).toContainEqual({ from: 'main', to: 'NewUserService', kind: 'call' });
  });

  test('R resolves a sourced file against the project root', async () => {
    const result = await new Pipeline().build(path.resolve('tests/fixtures/r-project'));
    const model: any = (result as any).model ?? result;

    const byId = new Map<string, any>(model.symbols.map((s: any) => [s.id, s]));
    const importEdge = model.resolvedReferences.find(
      (r: any) => r.kind === 'import' && byId.get(r.toSymbolId)?.filePath === 'R/utils.R'
    );
    // `source("R/utils.R")` is root-relative; resolving it against the caller's directory
    // would look for R/R/utils.R and find nothing.
    expect(importEdge).toBeDefined();
  });

  test('C# resolves an interface across files', async () => {
    const result = await new Pipeline().build(path.resolve('tests/fixtures/csharp-project'));
    const model: any = (result as any).model ?? result;

    const byId = new Map<string, any>(model.symbols.map((s: any) => [s.id, s]));
    const implementEdge = model.resolvedReferences.find(
      (r: any) =>
        r.kind === 'implement' &&
        byId.get(r.fromSymbolId)?.qualifiedName === 'Fixture.Services.UserService'
    );
    expect(implementEdge).toBeDefined();
    expect(byId.get(implementEdge.toSymbolId)?.qualifiedName).toBe('Fixture.Data.IUserRepo');
  });
});
