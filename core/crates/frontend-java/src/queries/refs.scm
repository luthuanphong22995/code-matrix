; Every type usage: extends/implements, field, local, parameter and return types, generic
; arguments, catch and throws types. Primitives and `void` have their own node kinds and
; never match. Parts of a qualified name, type-parameter declarations and the type of a
; `new` expression (a call, not a reference) are filtered out in extract.rs.
(type_identifier) @type
(scoped_type_identifier) @type
