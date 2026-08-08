export const TYPESCRIPT_QUERIES = `
(class_declaration
  name: (type_identifier) @name) @definition.class

(method_definition
  name: [
    (property_identifier)
    (identifier)
  ] @name) @definition.method

(function_declaration
  name: (identifier) @name) @definition.function

(interface_declaration
  name: (type_identifier) @name) @definition.interface

; Interface bodies. Without these an interface is an empty shell, so a field typed as an
; interface resolves to a symbol with zero members and every this.field.method() through it
; dies — the single largest structural cause of unresolved member chains.
; The enclosing interface_declaration is already on the symbol stack when these match, so
; containment edges to it are established automatically.
(method_signature
  name: [
    (property_identifier)
    (identifier)
  ] @name) @definition.method

(property_signature
  name: [
    (property_identifier)
    (identifier)
  ] @name) @definition.variable

; Abstract class members are declarations without bodies, and fail the same way.
(abstract_method_signature
  name: [
    (property_identifier)
    (identifier)
  ] @name) @definition.method

(type_alias_declaration
  name: (type_identifier) @name) @definition.type_alias

(variable_declarator
  name: (identifier) @name) @definition.variable

(public_field_definition
  name: (property_identifier) @name) @definition.variable

(call_expression
  function: [
    (identifier)
    (member_expression)
  ] @name) @call

(new_expression
  constructor: [
    (identifier)
    (member_expression)
  ] @name) @new

(import_specifier
  name: (identifier) @name
  !alias) @import

(import_specifier
  alias: (identifier) @name) @import

(namespace_import
  (identifier) @name) @import

(import_clause
  (identifier) @name) @import

(extends_clause
  [
    (identifier)
    (member_expression)
  ] @name) @inherit

(implements_clause
  [
    (type_identifier)
    (nested_type_identifier)
  ] @name) @implement

(type_annotation
  [
    (type_identifier)
    (nested_type_identifier)
    (generic_type)
  ] @name) @type_use

(ERROR) @error
`;

// JSX element rendering, e.g. `<LegendSection />` or `<Foo.Bar>`. Captures the component
// name so a "renders" reference edge links the enclosing component to the one it renders.
// Only valid against JSX-aware grammars (tsx / javascript) — NOT the plain typescript
// grammar, which has no JSX node types, so this lives in its own fragment.
export const JSX_QUERIES = `
(jsx_opening_element
  name: (_) @name) @renders

(jsx_self_closing_element
  name: (_) @name) @renders
`;

// tsx files use the TSX grammar (supports JSX); plain .ts files must NOT get JSX patterns.
export const TSX_QUERIES = TYPESCRIPT_QUERIES + '\n' + JSX_QUERIES;
