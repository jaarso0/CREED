/**
 * R captures.
 *
 * R has no function-declaration syntax: a function is an ordinary value assigned to a name,
 * so `greet <- function(x) {...}` parses as a `binary_operator` whose right side happens to
 * be a `function_definition`. All three assignment operators are matched (`<-`, `<<-`, `=`)
 * since all three are used in practice.
 *
 * That makes the function and variable patterns overlap — `greet <- function(x)` matches
 * both, on the identical node range. Tree-sitter reports every matching pattern, so the
 * normalizer drops the variable capture when a function capture covers the same range
 * (see dropShadowedVariableRanges). Encoding the exclusion here isn't possible; queries have
 * no negation.
 *
 * Imports are calls, not syntax — `library(dplyr)`, `require(x)`, `source("utils.R")`. They
 * are captured as calls here and re-tagged as imports by the normalizer.
 *
 * Note the field order: `lhs` before `operator` before `rhs`. A tree-sitter query has to
 * list a node's children in the order they appear in the tree, and putting `operator` first
 * is a TSQueryErrorStructure rather than a no-match, so the whole file silently extracts
 * nothing.
 */
export const R_QUERIES = `
(binary_operator
  lhs: (identifier) @name
  operator: "<-"
  rhs: (function_definition)) @definition.function

(binary_operator
  lhs: (identifier) @name
  operator: "<<-"
  rhs: (function_definition)) @definition.function

(binary_operator
  lhs: (identifier) @name
  operator: "="
  rhs: (function_definition)) @definition.function

(binary_operator
  lhs: (identifier) @name
  operator: "<-") @definition.variable

(binary_operator
  lhs: (identifier) @name
  operator: "<<-") @definition.variable

(call
  function: [
    (identifier)
    (namespace_operator)
  ] @name) @call

(ERROR) @error
`;
