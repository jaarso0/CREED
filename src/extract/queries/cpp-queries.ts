/**
 * C / C++ captures. One grammar serves both — tree-sitter-cpp is a superset of tree-sitter-c.
 *
 * Out-of-line member definitions (`int UserService::Save(...) { ... }`) capture the whole
 * `qualified_identifier`, and the normalizer splits it so the method is filed under its
 * class rather than at file level (see getCppQualifiedOwner). That matters more here than in
 * most languages: in a .cpp file the class body usually lives in a different file entirely,
 * so without the split every method in the codebase would be a free function.
 *
 * Bodyless declarations are tagged `definition.function`, not `definition.method`, even
 * inside a class body. A `(declaration ...)` node covers both an in-class constructor
 * declaration and a file-scope forward declaration, and the two are indistinguishable
 * without looking at the parent — `function` is the reading that is never wrong, and range
 * containment still nests the in-class ones under their class.
 */
export const CPP_QUERIES = `
(class_specifier
  name: (type_identifier) @name) @definition.class

(struct_specifier
  name: (type_identifier) @name) @definition.struct

(union_specifier
  name: (type_identifier) @name) @definition.struct

(enum_specifier
  name: (type_identifier) @name) @definition.enum

(namespace_definition
  name: (namespace_identifier) @name) @definition.module

(type_definition
  declarator: (type_identifier) @name) @definition.type_alias

(alias_declaration
  name: (type_identifier) @name) @definition.type_alias

(function_definition
  declarator: (function_declarator
    declarator: [
      (identifier)
      (field_identifier)
    ] @name)) @definition.function

(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier) @name)) @definition.method

(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: [
        (identifier)
        (field_identifier)
        (qualified_identifier)
      ] @name))) @definition.function

(field_declaration
  declarator: (function_declarator
    declarator: (field_identifier) @name)) @definition.method

(declaration
  declarator: (function_declarator
    declarator: [
      (identifier)
      (field_identifier)
    ] @name)) @definition.function

(field_declaration
  declarator: (field_identifier) @name) @definition.variable

(field_declaration
  declarator: (pointer_declarator
    declarator: (field_identifier) @name)) @definition.variable

(base_class_clause
  [
    (type_identifier)
    (qualified_identifier)
  ] @name) @inherit

(new_expression
  type: [
    (type_identifier)
    (qualified_identifier)
  ] @name) @new

(call_expression
  function: [
    (identifier)
    (field_expression)
    (qualified_identifier)
  ] @name) @call

(preproc_include
  path: [
    (string_literal)
    (system_lib_string)
  ] @name) @import

(parameter_declaration
  type: [
    (type_identifier)
    (qualified_identifier)
  ] @name) @type_use

(ERROR) @error
`;
