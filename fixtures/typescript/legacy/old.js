const fs = require("fs");
const view = require("./view");

function legacy() {
  return fs.readFileSync(view.path);
}

module.exports = { legacy };
