export interface Config {
  path: string;
  mode: Mode;
}

export enum Mode {
  Dev,
  Prod,
}

export function parseConfig(): Config {
  function normalize(path: string): string {
    return path.trim();
  }
  const mode = parseEnv();
  return { path: normalize("./app.json"), mode };
}

function parseEnv(): Mode {
  return Mode.Dev;
}

export const loadDefaults = () => parseConfig();
