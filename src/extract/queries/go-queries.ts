/**
 * Go captures.
 *
 * Two Go-specific shapes are handled in the normalizer rather than here, because a
 * tree-sitter query can't express either:
 *  - a `method_declaration`'s receiver becomes the method's owner, so `func (s *UserService)
 *    Save()` is indexed as `UserService.Save` rather than a free function (see
 *    getGoReceiverTypeName).
 *  - exportedness is the capitalization of the identifier, not a keyword.
 *
 * The `type_spec` patterns are deliberately split by RHS shape instead of using one generic
 * `(type_spec name: _)`: tree-sitter reports every matching pattern, so a generic pattern
 * would fire alongside the struct/interface ones and emit the same symbol twice.
 */
export const GO_QUERIES = `
(function_declaration
  name: (identifier) @name) @definition.function

(method_declaration
  name: (field_identifier) @name) @definition.method

(method_elem
  name: (field_identifier) @name) @definition.method

(type_spec
  name: (type_identifier) @name
  type: (struct_type)) @definition.struct

(type_spec
  name: (type_identifier) @name
  type: (interface_type)) @definition.interface

(type_spec
  name: (type_identifier) @name
  type: [
    (type_identifier)
    (qualified_type)
    (function_type)
    (map_type)
    (slice_type)
    (pointer_type)
  ]) @definition.type_alias

(type_alias
  name: (type_identifier) @name) @definition.type_alias

(const_spec
  name: (identifier) @name) @definition.variable

(var_spec
  name: (identifier) @name) @definition.variable

(call_expression
  function: [
    (identifier)
    (selector_expression)
  ] @name) @call

(composite_literal
  type: [
    (type_identifier)
    (qualified_type)
  ] @name) @new

(import_spec
  path: (interpreted_string_literal) @name) @import

(parameter_declaration
  type: [
    (type_identifier)
    (qualified_type)
  ] @name) @type_use

(field_declaration
  name: (field_identifier)
  type: [
    (type_identifier)
    (qualified_type)
  ] @name) @type_use

(ERROR) @error
`;
