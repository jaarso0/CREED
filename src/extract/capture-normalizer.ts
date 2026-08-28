import Parser from 'tree-sitter';
import * as path from 'path';
import { Capture } from './facts.js';
import {
  Symbol,
  Scope,
  Containment,
  ReferenceCandidate,
  Diagnostic,
  Range,
  SymbolKind,
  ReferenceKind,
  ScopeKind,
  LocalTypeBinding
} from '../semantic-model/types.js';
import { ContextTracker } from './context-tracker.js';
import { languageCategory } from '../parse/lang-detect.js';
import {
  createSymbol,
  createScope,
  createContainment,
  createReferenceCandidate,
  createDiagnostic
} from '../semantic-model/builder.js';
import { runAdapters } from '../frameworks/adapter-registry.js';

// ════════════════════════════════════════════
// RANGE CONTAINMENT HELPERS
// ════════════════════════════════════════════

function getRange(node: Parser.SyntaxNode): Range {
  return {
    start: { line: node.startPosition.row, column: node.startPosition.column },
    end: { line: node.endPosition.row, column: node.endPosition.column }
  };
}

/** Identity of a node's span, for spotting two query patterns that matched the same node. */
function rangeKey(node: Parser.SyntaxNode): string {
  return `${node.startPosition.row}:${node.startPosition.column}-${node.endPosition.row}:${node.endPosition.column}`;
}

function isRangeContained(inner: Range, outer: Range): boolean {
  if (inner.start.line < outer.start.line) return false;
  if (inner.start.line === outer.start.line && inner.start.column < outer.start.column) return false;
  if (inner.end.line > outer.end.line) return false;
  if (inner.end.line === outer.end.line && inner.end.column > outer.end.column) return false;
  return true;
}

// ════════════════════════════════════════════
// QUALIFIER CHAIN HELPERS
// ════════════════════════════════════════════

function getQualifierChain(node: any): string[] {
  if (!node) return [];
  const type = node.type;
  if (
    type === 'identifier' ||
    type === 'property_identifier' ||
    type === 'shorthand_property_identifier' ||
    type === 'type_identifier'
  ) {
    return [node.text];
  }
  if (type === 'member_expression') {
    const obj = node.childForFieldName('object');
    const prop = node.childForFieldName('property');
    if (obj && prop) {
      return [...getQualifierChain(obj), ...getQualifierChain(prop)];
    }
  }
  if (type === 'attribute') {
    const val = node.childForFieldName('object') || node.childForFieldName('value');
    const attr = node.childForFieldName('attribute');
    if (val && attr) {
      return [...getQualifierChain(val), ...getQualifierChain(attr)];
    }
  }
  if (type === 'scoped_identifier') {
    const scope = node.childForFieldName('scope');
    const name = node.childForFieldName('name');
    if (scope && name) {
      return [...getQualifierChain(scope), ...getQualifierChain(name)];
    }
  }
  if (type === 'scoped_type_identifier') {
    const path = node.childForFieldName('path');
    const name = node.childForFieldName('name');
    if (path && name) {
      return [...getQualifierChain(path), ...getQualifierChain(name)];
    }
  }
  // Go: `s.repo.Insert` → (selector_expression operand: ... field: (field_identifier))
  if (type === 'selector_expression') {
    const operand = node.childForFieldName('operand');
    const field = node.childForFieldName('field');
    if (operand && field) {
      return [...getQualifierChain(operand), ...getQualifierChain(field)];
    }
  }
  // C#: `Console.WriteLine` → (member_access_expression expression: ... name: (identifier))
  if (type === 'member_access_expression') {
    const expression = node.childForFieldName('expression');
    const name = node.childForFieldName('name');
    if (expression && name) {
      return [...getQualifierChain(expression), ...getQualifierChain(name)];
    }
  }
  // C#: `MyApp.Data.Models` → (qualified_name qualifier: ... name: (identifier))
  if (type === 'qualified_name') {
    const qualifier = node.childForFieldName('qualifier');
    const name = node.childForFieldName('name');
    if (qualifier && name) {
      return [...getQualifierChain(qualifier), ...getQualifierChain(name)];
    }
  }
  // C++: `repo_->Insert` / `obj.field` → (field_expression argument: ... field: (field_identifier))
  if (type === 'field_expression') {
    const argument = node.childForFieldName('argument');
    const field = node.childForFieldName('field');
    if (argument && field) {
      return [...getQualifierChain(argument), ...getQualifierChain(field)];
    }
  }
  // C++: `UserService::Save` / `std::string` → (qualified_identifier scope: ... name: ...)
  if (type === 'qualified_identifier') {
    const scope = node.childForFieldName('scope');
    const name = node.childForFieldName('name');
    if (scope && name) {
      return [...getQualifierChain(scope), ...getQualifierChain(name)];
    }
    if (name) return getQualifierChain(name);
  }
  // R: `utils::head` → (namespace_operator lhs: (identifier) rhs: (identifier))
  if (type === 'namespace_operator') {
    const lhs = node.childForFieldName('lhs');
    const rhs = node.childForFieldName('rhs');
    if (lhs && rhs) {
      return [...getQualifierChain(lhs), ...getQualifierChain(rhs)];
    }
  }
  if (
    type === 'field_identifier' ||
    type === 'namespace_identifier' ||
    type === 'package_identifier'
  ) {
    return [node.text];
  }
  return [node.text];
}

// ════════════════════════════════════════════
// OWNER INFERENCE FOR OUT-OF-BODY MEMBERS
// ════════════════════════════════════════════
//
// Go and C++ both declare methods outside the type's body, so range containment — which is
// how every other language here gets its owner — finds nothing. Both need the owner read off
// the declaration itself instead.

/**
 * The receiver type of a Go method: `func (s *UserService) Save()` → `UserService`.
 * Returns undefined for a plain function, which has no receiver.
 */
function getGoReceiverTypeName(node: any): string | undefined {
  if (node?.type !== 'method_declaration') return undefined;
  const receiver = node.childForFieldName('receiver');
  if (!receiver) return undefined;

  // (parameter_list (parameter_declaration name: (identifier) type: (pointer_type (type_identifier))))
  const decl = receiver.namedChildren?.find((c: any) => c.type === 'parameter_declaration');
  let typeNode = decl?.childForFieldName('type');
  // Unwrap `*T` and `T[P]` — the receiver's identity is the bare type name.
  while (typeNode && (typeNode.type === 'pointer_type' || typeNode.type === 'generic_type')) {
    typeNode = typeNode.namedChildren?.[0] ?? typeNode.childForFieldName('type');
  }
  if (!typeNode) return undefined;
  const chain = getQualifierChain(typeNode);
  return chain[chain.length - 1];
}

/**
 * Splits a C++ out-of-line definition name: `UserService::Save` → owner `UserService`,
 * name `Save`. Namespace-only qualifiers (`app::freeFunc`) come back the same way; filing
 * the function under its namespace is the correct reading there too.
 */
function getCppQualifiedOwner(nameNode: any): { owner: string; name: string } | undefined {
  if (nameNode?.type !== 'qualified_identifier') return undefined;
  const chain = getQualifierChain(nameNode);
  if (chain.length < 2) return undefined;
  return { owner: chain[chain.length - 2], name: chain[chain.length - 1] };
}

function getJavaCallQualifierChain(node: any): string[] {
  const chain: string[] = [];
  const traverse = (n: any) => {
    if (!n) return;
    if (n.type === 'identifier' || n.type === 'property_identifier' || n.type === 'type_identifier') {
      chain.push(n.text);
    } else if (n.type === 'field_access') {
      const obj = n.childForFieldName('object');
      const field = n.childForFieldName('field');
      traverse(obj);
      traverse(field);
    } else if (n.type === 'method_invocation') {
      const obj = n.childForFieldName('object');
      const name = n.childForFieldName('name');
      traverse(obj);
      traverse(name);
    } else {
      chain.push(n.text);
    }
  };

  const obj = node.childForFieldName('object');
  const name = node.childForFieldName('name');
  traverse(obj);
  traverse(name);
  return chain;
}

// ════════════════════════════════════════════
// IMPORT PATH RESOLVERS
// ════════════════════════════════════════════

/** Strips the string/include delimiters a grammar keeps in the token text: `"x"`, `'x'`, `<x>`. */
function stripQuotes(text: string): string {
  return text.replace(/^['"<]|['">]$/g, '');
}

/**
 * R calls that are really imports. R has no import syntax — dependencies are pulled in by
 * calling a function, so these are captured as calls and re-tagged here.
 */
const R_IMPORT_FUNCTIONS = new Set([
  'library', 'require', 'requireNamespace', 'source', 'loadNamespace'
]);

/**
 * What an R import call actually pulls in — the first argument, not the callee.
 * `library(dplyr)` → `dplyr`; `source("utils.R")` → `utils.R`. R accepts the package
 * either bare or quoted, so the result is unquoted either way.
 */
function getRImportTarget(callNode: any): string | undefined {
  const args = callNode?.childForFieldName('arguments');
  const firstArg = args?.namedChildren?.find((c: any) => c.type === 'argument');
  const value = firstArg?.childForFieldName('value') ?? firstArg?.namedChildren?.[0];
  if (!value) return undefined;
  if (value.type === 'string') {
    const content = value.childForFieldName('content');
    return content ? content.text : stripQuotes(value.text);
  }
  return value.text;
}

/** Built-in type names that are never symbols in the graph, by language. */
const GO_BUILTIN_TYPES = new Set([
  'string', 'bool', 'byte', 'rune', 'error', 'any', 'int', 'uint', 'uintptr',
  'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
  'float32', 'float64', 'complex64', 'complex128'
]);

/**
 * Whether a `type_use` target is something the graph could ever contain. Go's builtins and
 * anything rooted at C++'s `std` namespace are external by definition — emitting edges to
 * them adds nothing and makes every file look like it has unresolved references.
 */
function isUnindexableType(category: string, rawName: string, qualifierChain: string[]): boolean {
  if (category === 'go') return GO_BUILTIN_TYPES.has(rawName);
  if (category === 'cpp') return qualifierChain[0] === 'std';
  return false;
}

/**
 * True when a C# base-list entry looks like an interface rather than a base class.
 *
 * C# puts both in the same list with no syntactic marker, so this leans on the .NET
 * `IPascalCase` convention. It is a convention, not a rule: a base class named `IndexWriter`
 * is misread as an interface. The alternative — calling every base a superclass — is wrong
 * far more often, since most C# base lists are interfaces.
 */
function looksLikeCSharpInterface(name: string): boolean {
  const base = name.split('.').pop() ?? name;
  return /^I[A-Z]/.test(base);
}

/**
 * The access level of a C++ member, read from the `public:` / `private:` / `protected:`
 * label that most recently preceded it in the class body. Falls back to the language
 * default for the enclosing container — private for `class`, public for `struct`.
 * Anything not inside a class body (a free function, a namespace-level definition) is
 * public.
 */
function getCppAccess(node: any): 'public' | 'private' | 'protected' {
  // Find the member declaration that sits directly in a field_declaration_list.
  let member = node;
  while (member && member.parent && member.parent.type !== 'field_declaration_list') {
    member = member.parent;
  }
  const body = member?.parent;
  if (!body || body.type !== 'field_declaration_list') return 'public';

  let access: 'public' | 'private' | 'protected' =
    body.parent?.type === 'class_specifier' ? 'private' : 'public';

  for (const child of body.children ?? []) {
    if (child.id === member.id) break;
    if (child.type === 'access_specifier') {
      const text = child.text;
      if (text.startsWith('private')) access = 'private';
      else if (text.startsWith('protected')) access = 'protected';
      else if (text.startsWith('public')) access = 'public';
    }
  }
  return access;
}

function getTSImportPath(node: any): string | undefined {
  let cur = node;
  while (cur && cur.type !== 'import_statement') {
    cur = cur.parent;
  }
  if (cur) {
    const sourceNode = cur.childForFieldName('source');
    if (sourceNode && sourceNode.type === 'string') {
      return sourceNode.text.replace(/^['"]|['"]$/g, '');
    }
  }
  return undefined;
}

function getPythonImportPath(node: any, nameNode: any): string | undefined {
  let parent = nameNode;
  while (parent && parent.type !== 'import_from_statement' && parent.type !== 'import_statement') {
    parent = parent.parent;
  }

  if (parent) {
    if (parent.type === 'import_from_statement') {
      const moduleNode = parent.childForFieldName('module_name');
      if (moduleNode) {
        return moduleNode.text.replace(/\./g, '/');
      }
    } else if (parent.type === 'import_statement') {
      // For import_statement, if the nameNode is inside an aliased_import, we want the real name
      let cur = nameNode;
      while (cur && cur !== parent) {
        if (cur.type === 'aliased_import') {
          const realNameNode = cur.childForFieldName('name');
          if (realNameNode) {
            return getQualifierChain(realNameNode).join('/');
          }
        }
        cur = cur.parent;
      }
    }
  }

  return getQualifierChain(nameNode).join('/');
}

function getImportedName(nameNode: any): string {
  if (nameNode.parent) {
    if (nameNode.parent.type === 'aliased_import' || nameNode.parent.type === 'import_specifier') {
      const realNameNode = nameNode.parent.childForFieldName('name');
      if (realNameNode) {
        return realNameNode.text;
      }
    }
  }
  return nameNode.text;
}

// ════════════════════════════════════════════
// DECLARED-TYPE INFERENCE (for instance member resolution)
// ════════════════════════════════════════════
//
// Best-effort: figures out what class/type a variable holds, so Stage 4
// can resolve `instance.method()` calls through to the class's members.
// Only handles the common, unambiguous cases (explicit `new X()`, TS type
// annotations, and `x = ClassName()` in Python where the callee looks
// like a class name) — anything murkier is left unresolved rather than guessed.
// True if the node sits inside a function/arrow/method body (a real local), as opposed to
// module top-level or a class body (a field). Stops at class/module boundaries so class
// fields and top-level consts are NOT treated as locals.
function isInsideFunctionBody(node: any): boolean {
  const FN_TYPES = new Set([
    'arrow_function', 'function', 'function_expression', 'function_declaration',
    'generator_function', 'generator_function_declaration', 'method_definition'
  ]);
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'class_body' || cur.type === 'program') return false;
    if (FN_TYPES.has(cur.type)) return true;
    cur = cur.parent;
  }
  return false;
}

const NAMED_TYPE_NODES = new Set(['type_identifier', 'nested_type_identifier', 'generic_type']);

/** Type-annotation node shapes that can carry a resolvable named type somewhere inside. */
const WRAPPER_TYPE_NODES = new Set([
  'array_type',        // Scope[]
  'union_type',        // Scope | undefined
  'readonly_type',     // readonly Scope[]
  'parenthesized_type' // (Scope)
]);

function isTypeNode(node: any): boolean {
  return NAMED_TYPE_NODES.has(node?.type) || WRAPPER_TYPE_NODES.has(node?.type);
}

/**
 * Reduces a type annotation to the named type a member lookup can be performed against.
 *
 * Previously only bare `type_identifier`/`generic_type` were recognised, so a field declared
 * `private scopeStack: Scope[]` produced no declared type at all and every `this.scopeStack.x`
 * chain died. Wrappers are unwrapped to the first named type inside them: `Scope[]` → `Scope`,
 * `Foo | undefined` → `Foo`.
 *
 * Note the array case deliberately yields the *element* type. That is wrong for
 * `.push`/`.length` (which live on Array, not Scope) but right for the far more common
 * `this.items[0].method()` intent; the alternative today is no type information at all.
 */
function unwrapTypeNode(node: any, depth = 0): any | undefined {
  if (!node || depth > 5) return undefined;

  if (node.type === 'generic_type') {
    return node.childForFieldName('name') ?? node;
  }
  if (NAMED_TYPE_NODES.has(node.type)) {
    return node;
  }
  if (WRAPPER_TYPE_NODES.has(node.type)) {
    for (const child of node.children ?? []) {
      // Skip `null`/`undefined` union members — they carry no members worth resolving.
      if (child.type === 'predefined_type' || child.type === 'undefined') continue;
      const inner = unwrapTypeNode(child, depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

function getDeclaredTypeChain(node: any, filePath: string): string[] | undefined {
  if (filePath.endsWith('.py')) {
    if (node.type !== 'assignment') return undefined;
    const right = node.childForFieldName('right');
    if (!right || right.type !== 'call') return undefined;
    const func = right.childForFieldName('function');
    if (!func) return undefined;
    const chain = getQualifierChain(func);
    const last = chain[chain.length - 1];
    if (!last || last[0] !== last[0].toUpperCase() || last[0] === last[0].toLowerCase()) return undefined;
    return chain;
  }

  // variable_declarator (const/let), plus class fields: public_field_definition (TS) and
  // field_definition (JS), plus interface members: property_signature. All expose 'type'
  // (TS annotation) and/or 'value' (initializer).
  if (
    node.type !== 'variable_declarator' &&
    node.type !== 'public_field_definition' &&
    node.type !== 'field_definition' &&
    node.type !== 'property_signature'
  ) {
    return undefined;
  }

  const typeAnnotation = node.childForFieldName('type');
  if (typeAnnotation) {
    const typeNode = typeAnnotation.children?.find((c: any) => isTypeNode(c));
    if (typeNode) {
      const named = unwrapTypeNode(typeNode);
      if (named) return getQualifierChain(named);
    }
  }

  const value = node.childForFieldName('value');
  if (value && value.type === 'new_expression') {
    const ctor = value.childForFieldName('constructor');
    if (ctor) return getQualifierChain(ctor);
  }

  return undefined;
}

// ════════════════════════════════════════════
// VISIBILITY & EXPORT DETERMINERS
// ════════════════════════════════════════════

function getSymbolMetadata(
  node: Parser.SyntaxNode,
  name: string,
  filePath: string
): { exported: boolean; visibility: 'public' | 'private' | 'protected' | 'internal' } {
  if (filePath.endsWith('.py')) {
    const isPrivate = name.startsWith('_') && !name.startsWith('__');
    return {
      exported: !isPrivate,
      visibility: isPrivate ? 'private' : 'public'
    };
  }

  if (filePath.endsWith('.java')) {
    let cur: any = node;
    let modifiers = cur.childForFieldName('modifiers') ?? cur.children.find((c: any) => c.type === 'modifiers');
    if (!modifiers && cur.parent) {
      modifiers = cur.parent.childForFieldName('modifiers') ?? cur.parent.children.find((c: any) => c.type === 'modifiers');
    }
    if (modifiers) {
      const text = modifiers.text;
      if (text.includes('private')) {
        return { visibility: 'private', exported: false };
      }
      if (text.includes('protected')) {
        return { visibility: 'protected', exported: false };
      }
    }
    return { visibility: 'public', exported: true };
  }

  if (filePath.endsWith('.html')) {
    return {
      exported: true,
      visibility: 'public'
    };
  }

  const category = languageCategory(filePath);

  // Go: exportedness is spelled with a capital letter and nothing else.
  if (category === 'go') {
    const first = name[0] ?? '';
    const isExported = first === first.toUpperCase() && first !== first.toLowerCase();
    return { exported: isExported, visibility: isExported ? 'public' : 'private' };
  }

  if (category === 'csharp') {
    const modifiers = (node.children ?? [])
      .filter((c: any) => c.type === 'modifier')
      .map((c: any) => c.text);
    if (modifiers.includes('private')) return { visibility: 'private', exported: false };
    if (modifiers.includes('protected')) return { visibility: 'protected', exported: false };
    if (modifiers.includes('internal')) return { visibility: 'internal', exported: false };
    // An unmarked C# member is really private, but defaulting to public here is deliberate:
    // `exported` gates import resolution and name search, and a symbol wrongly hidden is a
    // worse failure for a navigation index than one wrongly shown.
    return { visibility: 'public', exported: true };
  }

  if (category === 'cpp') {
    const access = getCppAccess(node);
    if (access === 'private') return { visibility: 'private', exported: false };
    if (access === 'protected') return { visibility: 'protected', exported: false };
    return { visibility: 'public', exported: true };
  }

  // R has no export syntax outside a NAMESPACE file. The one convention that holds is that
  // a leading dot marks a name as internal.
  if (category === 'r') {
    const isInternal = name.startsWith('.');
    return { exported: !isInternal, visibility: isInternal ? 'private' : 'public' };
  }

  const isPrivate = name.startsWith('#');
  let isExported = false;
  let cur: any = node;
  while (cur) {
    if (cur.type === 'export_statement') {
      isExported = true;
      break;
    }
    cur = cur.parent;
  }
  return {
    exported: isExported,
    visibility: isPrivate ? 'private' : 'public'
  };
}

// ════════════════════════════════════════════
// CONTEXT SYNCHRONIZER
// ════════════════════════════════════════════

function syncContext(node: Parser.SyntaxNode, tracker: ContextTracker) {
  const nodeRange = getRange(node);

  while (tracker.currentParentSymbol) {
    const parentSym = tracker.currentParentSymbol;
    if (parentSym.kind === 'file' || parentSym.kind === 'project') {
      break;
    }
    if (isRangeContained(nodeRange, parentSym.range)) {
      break;
    }
    tracker.exitSymbol();
  }

  while (tracker.currentScope) {
    const curScope = tracker.currentScope;
    if (curScope.kind === 'global') {
      break;
    }
    if (isRangeContained(nodeRange, curScope.range)) {
      break;
    }
    tracker.exitScope();
  }
}

// ════════════════════════════════════════════
// CAPTURE NORMALIZER MAIN ENTRY
// ════════════════════════════════════════════

export interface NormalizerOutput {
  symbols: Symbol[];
  scopes: Scope[];
  containments: Containment[];
  references: ReferenceCandidate[];
  diagnostics: Diagnostic[];
  localTypeBindings: LocalTypeBinding[];
}

export function normalizeCaptures(
  captures: Capture[],
  filePath: string,
  rootNode: Parser.SyntaxNode
): NormalizerOutput {
  const tracker = new ContextTracker(filePath);

  const symbols: Symbol[] = [];
  const scopes: Scope[] = [];
  const containments: Containment[] = [];
  const references: ReferenceCandidate[] = [];
  const diagnostics: Diagnostic[] = [];
  const localTypeBindings: LocalTypeBinding[] = [];

  // Create file-level symbol and global scope
  const fileRange = getRange(rootNode);
  const fileSymbol = createSymbol({
    filePath,
    chain: [filePath],
    kind: 'file',
    range: fileRange,
    exported: true,
    visibility: 'public'
  });
  symbols.push(fileSymbol);

  const globalScope = tracker.enterScope('global', fileRange, fileSymbol);
  scopes.push(globalScope);

  // Sort captures by start position, then by range size (larger first) for structural nesting
  const sorted = [...captures].sort((a, b) => {
    const startA = a.node.startPosition;
    const startB = b.node.startPosition;
    if (startA.row !== startB.row) {
      return startA.row - startB.row;
    }
    if (startA.column !== startB.column) {
      return startA.column - startB.column;
    }
    const endA = a.node.endPosition;
    const endB = b.node.endPosition;
    if (endA.row !== endB.row) {
      return endB.row - endA.row;
    }
    return endB.column - endA.column;
  });

  // Some grammars force two patterns to overlap on the same node. R is the case that needs
  // this: a function is an assignment whose right side is a function literal, so
  // `greet <- function(x)` matches both the function pattern and the plain-assignment one
  // and would produce two symbols at the identical range. Queries have no negation, so the
  // variable capture is dropped here wherever a definition capture already covers it.
  const definitionRanges = new Set<string>();
  for (const capture of sorted) {
    if (capture.tag.startsWith('definition.') && capture.tag !== 'definition.variable') {
      definitionRanges.add(rangeKey(capture.node));
    }
  }

  for (const capture of sorted) {
    const { tag, name, node, nameNode } = capture;

    if (tag === 'definition.variable' && definitionRanges.has(rangeKey(node))) {
      continue;
    }

    // Synchronize active scope/symbol contexts to our current node
    syncContext(node, tracker);

    // Identify tag class/family
    if (tag.startsWith('definition.')) {
      const kindStr = tag.substring('definition.'.length);
      const kind: SymbolKind = kindStr as SymbolKind;

      // Handle variable scope containment rule: local block/method variables don't become
      // full Symbols (they'd pollute name search), but we still record their declared type
      // as a resolver-only LocalTypeBinding so `localVar.method()` calls can be resolved.
      if (kind === 'variable') {
        const parentKind = tracker.currentParentSymbol?.kind;
        const isTopOrClassLevel =
          parentKind === undefined || parentKind === 'file' || parentKind === 'class' || parentKind === 'interface';
        // A variable whose AST sits inside a function/arrow body is local even when that body
        // isn't a tracked symbol (e.g. `it(() => { const x = ... })` callbacks) — otherwise it
        // leaks in as a bogus file-level symbol and collides on id with same-named locals in
        // sibling callbacks. Class fields (parent is class_body) are NOT caught by this.
        if (!isTopOrClassLevel || isInsideFunctionBody(node)) {
          const owner = tracker.currentParentSymbol;
          const declaredTypeChain = getDeclaredTypeChain(node, filePath);
          if (owner && declaredTypeChain && declaredTypeChain.length > 0) {
            localTypeBindings.push({
              ownerSymbolId: owner.id,
              name,
              filePath,
              range: getRange(node),
              declaredType: {
                qualifierChain: declaredTypeChain,
                rawName: declaredTypeChain.join('.')
              }
            });
          }
          continue;
        }
      }

      const { exported, visibility } = getSymbolMetadata(node, name, filePath);

      // Go and C++ declare members outside the type's body, so the range-containment walk
      // that gives every other language its owner finds nothing here. Read the owner off
      // the declaration itself: a Go method's receiver, a C++ definition's `Owner::name`.
      const goReceiver = getGoReceiverTypeName(node);
      const cppQualified = getCppQualifiedOwner(nameNode);
      let chain: string[];
      if (goReceiver) {
        chain = [...tracker.buildIdChain(''), goReceiver, name];
      } else if (cppQualified) {
        chain = [...tracker.buildIdChain(''), cppQualified.owner, cppQualified.name];
      } else {
        chain = tracker.buildIdChain(name);
      }

      const adapterMeta = runAdapters(node, rootNode, filePath);
      const symbolMetadata: Record<string, unknown> = {};
      if (adapterMeta.apiRoute) symbolMetadata.apiRoute = adapterMeta.apiRoute;
      if (adapterMeta.dataModel) symbolMetadata.dataModel = adapterMeta.dataModel;
      if (adapterMeta.isService) symbolMetadata.isService = adapterMeta.isService;

      if (kind === 'variable') {
        const declaredTypeChain = getDeclaredTypeChain(node, filePath);
        if (declaredTypeChain && declaredTypeChain.length > 0) {
          symbolMetadata.declaredType = {
            qualifierChain: declaredTypeChain,
            rawName: declaredTypeChain.join('.')
          };
        }
      }

      const sym = createSymbol({
        filePath,
        chain,
        kind,
        range: getRange(node),
        exported,
        visibility,
        metadata: symbolMetadata
      });
      symbols.push(sym);

      // Establish structural containment edge
      const parent = tracker.currentParentSymbol;
      if (parent) {
        containments.push(
          createContainment(
            parent.id,
            sym.id,
            kind === 'method' ? 'has_member' : 'owns'
          )
        );
      }

      // If symbol defines a scope boundary, enter it
      // `struct` and `module` join the type kinds here for Go/C#/C++: a struct body holds
      // fields and (in C#/C++) methods, and a C#/C++ namespace holds everything in the file,
      // so both need to become the active parent for what follows.
      const createsScope =
        kind === 'class' || kind === 'interface' || kind === 'struct' || kind === 'module' ||
        kind === 'function' || kind === 'method';
      if (createsScope) {
        const scopeKind: ScopeKind =
          (kind === 'class' || kind === 'interface' || kind === 'struct' || kind === 'module')
            ? 'class'
            : 'function';
        const newScope = tracker.enterScope(scopeKind, getRange(node), sym);
        scopes.push(newScope);
        tracker.enterSymbol(sym);
      }
    } else if (tag === 'call' || tag === 'new' || tag === 'import' || tag === 'inherit' || tag === 'implement' || tag === 'type_use' || tag === 'renders') {
      // JSX renders: skip host/HTML elements (`<div>`, `<span>`) — only Capitalized names
      // (or member expressions like `<Foo.Bar>`) are component references worth linking.
      if (tag === 'renders') {
        const isMemberExpr = getQualifierChain(nameNode).length > 1;
        const firstChar = nameNode.text[0] || '';
        if (!isMemberExpr && firstChar === firstChar.toLowerCase()) {
          continue;
        }
      }

      const fromSym = tracker.currentParentSymbol ?? fileSymbol;

      // Two languages need the reference kind corrected after the fact, because the grammar
      // cannot express the distinction the graph cares about.
      let effectiveTag = tag;
      const refCategory = languageCategory(filePath);
      if (refCategory === 'r' && tag === 'call' && R_IMPORT_FUNCTIONS.has(name)) {
        effectiveTag = 'import';
      } else if (refCategory === 'csharp' && tag === 'inherit' && looksLikeCSharpInterface(name)) {
        effectiveTag = 'implement';
      }

      const refKindMap: Record<string, ReferenceKind> = {
        call: 'call',
        new: 'instantiate',
        import: 'import',
        inherit: 'inherit',
        implement: 'implement',
        type_use: 'type_use',
        renders: 'renders'
      };

      const refKind = refKindMap[effectiveTag];
      let importPath: string | undefined;

      let metadata: Record<string, unknown> = {};
      if (refKind === 'import') {
        const category = languageCategory(filePath);
        if (category === 'python') {
          importPath = getPythonImportPath(node, nameNode);
          metadata.importedName = getImportedName(nameNode);
        } else if (category === 'java') {
          importPath = nameNode.text.replace(/\./g, '/');
          metadata.importedName = getImportedName(nameNode);
        } else if (category === 'html') {
          importPath = nameNode.text.replace(/^['"]|['"]$/g, '');
          metadata.importedName = getImportedName(nameNode);
        } else if (category === 'csharp') {
          // `using MyApp.Data.Models;` — a namespace, addressed like a Java package.
          importPath = stripQuotes(nameNode.text).replace(/\./g, '/');
          metadata.importedName = importPath.split('/').pop() ?? nameNode.text;
        } else if (category === 'go' || category === 'cpp' || category === 'r') {
          // All three import a *path* rather than a name: `"myapp/repo"`, `"repo.h"`,
          // `source("utils.R")`. The name worth matching on is the final segment with any
          // extension dropped, which is also the Go package name. For R the target is the
          // call's argument — the callee is just `library`/`source`.
          importPath = category === 'r'
            ? (getRImportTarget(node) ?? stripQuotes(nameNode.text))
            : stripQuotes(nameNode.text);
          const base = importPath.split('/').pop() ?? importPath;
          metadata.importedName = base.replace(/\.[A-Za-z0-9]+$/, '');
        } else {
          importPath = getTSImportPath(node);
          metadata.importedName = getImportedName(nameNode);
        }
      }

      let qualifierChain = getQualifierChain(nameNode);
      let rawName = nameNode.text;

      if (filePath.endsWith('.java') && node.type === 'method_invocation') {
        qualifierChain = getJavaCallQualifierChain(node);
        rawName = qualifierChain.join('.');
      }

      // An R import's name is its argument, not the `library`/`source` callee that the
      // capture pointed at.
      if (refKind === 'import' && refCategory === 'r') {
        const imported = metadata.importedName as string | undefined;
        if (imported) {
          rawName = imported;
          qualifierChain = [imported];
        }
      }

      // Go and C++ import tokens carry their delimiters — `"myapp/repo"`, `<string>`. The
      // name every downstream consumer wants is the bare path, which importPath already is.
      if (refKind === 'import' && (refCategory === 'go' || refCategory === 'cpp') && importPath) {
        rawName = importPath;
        qualifierChain = [importPath];
      }

      // Primitive and standard-library types are not symbols in this graph and never will
      // be, so a type_use edge to one is guaranteed to end up in the unresolved-reference
      // list. Drop them at the source rather than reporting them as gaps in the picture.
      if (refKind === 'type_use' && isUnindexableType(refCategory, rawName, qualifierChain)) {
        continue;
      }

      references.push(
        createReferenceCandidate({
          fromSymbolId: fromSym.id,
          kind: refKind,
          rawName,
          qualifierChain,
          importPath,
          astNodeType: node.type,
          filePath,
          range: getRange(nameNode),
          metadata
        })
      );
    } else if (tag === 'error') {
      diagnostics.push(
        createDiagnostic({
          kind: 'parse_error',
          severity: 'error',
          message: `Syntax error at line ${node.startPosition.row + 1}`,
          filePath,
          range: getRange(node)
        })
      );
    }
  }

  // Finalize global scope pop and cleanup remaining stacks
  while (tracker.currentParentSymbol) {
    tracker.exitSymbol();
  }
  while (tracker.currentScope) {
    tracker.exitScope();
  }

  return {
    symbols: dedupeSymbolsById(symbols),
    scopes,
    containments: dedupeContainments(containments),
    references,
    diagnostics,
    localTypeBindings
  };
}

/**
 * Collapses symbols that share an id, keeping the one with the widest range.
 *
 * C++ is why this exists: a member is declared in the class body and defined again outside
 * it (`int UserService::Save(...)`), and both are the same symbol under the same
 * path-anchored id. The definition is the wider of the two because it carries a body, and
 * it is the one worth keeping — a caller asking for `Save` wants the implementation, not the
 * one-line signature.
 *
 * This also absorbs C++ overloads, which the id scheme cannot tell apart in any case.
 */
function dedupeSymbolsById(symbols: Symbol[]): Symbol[] {
  const byId = new Map<string, Symbol>();
  for (const sym of symbols) {
    const existing = byId.get(sym.id);
    if (!existing) {
      byId.set(sym.id, sym);
      continue;
    }
    const existingSpan = existing.range.end.line - existing.range.start.line;
    const candidateSpan = sym.range.end.line - sym.range.start.line;
    if (candidateSpan > existingSpan) byId.set(sym.id, sym);
  }
  return [...byId.values()];
}

/** Drops containment edges duplicated by a symbol that was captured twice. */
function dedupeContainments(containments: Containment[]): Containment[] {
  const seen = new Set<string>();
  const out: Containment[] = [];
  for (const c of containments) {
    const key = `${c.parentId}>${c.childId}:${c.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
