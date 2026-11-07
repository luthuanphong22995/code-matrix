// Data-flow fixture: line numbers match the feature scenarios.























































































const serve = () => {
  const limit = 5;

  const f = () => {
    const n = limit;
    return n + limit;
  };
  f();
  print(limit);

  function inner() { return limit; }
};
