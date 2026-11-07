import { parseConfig, Config } from "./config.js";
import * as util from "./util";
import App from "./App";
import React from "react";

function main() {
  const c: Config = parseConfig();
  util.readFile(c.path);
  fetchData();
  return new App({ config: c });
}

main();
