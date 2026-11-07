// Data-flow fixture: line numbers match the feature scenarios.



const defaultPath = "config.yaml";

function open(path) { return []; }

function read() { return 0; }

function parseConfig(path) {
  let total = 0;
  for (const n of open(path)) {
    total = total + n;
  }
  const unused = defaultPath;
  if (read() > 0) {
    return total;
  }
  log(path);
  return 0;
}
