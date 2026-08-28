/**
 * C# captures.
 *
 * `base_list` is the one genuinely lossy spot: C# writes a base class and the interfaces it
 * implements in the same comma-separated list, with no syntactic difference between them
 * (`class Foo : BaseService, IUserService`). The captures are tagged `@inherit` here and the
 * normalizer re-tags the ones following .NET's `IPascalCase` interface convention as
 * `implement`. That convention is near-universal in C# but it IS a convention, so a base
 * class named `IndexWriter` would be misfiled as an interface.
 */
export const CSHARP_QUERIES = `
(class_declaration
  name: (identifier) @name) @definition.class

(record_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface

(struct_declaration
  name: (identifier) @name) @definition.struct

(enum_declaration
  name: (identifier) @name) @definition.enum

(namespace_declaration
  name: [
    (identifier)
    (qualified_name)
  ] @name) @definition.module

(method_declaration
  name: (identifier) @name) @definition.method

(constructor_declaration
  name: (identifier) @name) @definition.method

(property_declaration
  name: (identifier) @name) @definition.variable

(field_declaration
  (variable_declaration
    (variable_declarator
      name: (identifier) @name))) @definition.variable

(invocation_expression
  function: [
    (identifier)
    (member_access_expression)
  ] @name) @call

(object_creation_expression
  type: [
    (identifier)
    (qualified_name)
    (generic_name)
  ] @name) @new

(using_directive
  [
    (identifier)
    (qualified_name)
  ] @name) @import

(base_list
  [
    (identifier)
    (qualified_name)
    (generic_name)
  ] @name) @inherit

(parameter
  type: [
    (identifier)
    (qualified_name)
    (generic_name)
  ] @name) @type_use

(ERROR) @error
`;
