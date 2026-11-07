(function_declaration
  name: (identifier) @name) @function

(method_declaration
  receiver: (parameter_list
    (parameter_declaration
      type: (_) @receiver))
  name: (field_identifier) @name) @method

(source_file
  (type_declaration
    (type_spec
      name: (type_identifier) @name
      type: [(struct_type) (interface_type)]) @class))
