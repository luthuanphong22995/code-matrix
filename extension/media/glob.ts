export class InvalidGlob extends Error {}

// In-house glob → anchored RegExp over `/`-separated paths: `**`, `*`, `?`, `[...]` (`[!...]`), `{a,b}`.
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] !== '*') {
        re += '[^/]*';
        continue;
      }
      i++;
      // `**/` also matches zero segments; a bare `**` matches anything.
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) throw new InvalidGlob(glob);
      let body = glob.slice(i + 1, end);
      const negate = body.startsWith('!');
      if (negate) body = body.slice(1);
      re += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      i = end;
    } else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (c === ',' && braces > 0) re += '|';
    else if (c === '\\') {
      if (i + 1 >= glob.length) throw new InvalidGlob(glob);
      re += escape(glob[++i]);
    } else re += escape(c);
  }
  if (braces > 0) throw new InvalidGlob(glob);
  return new RegExp(`^${re}$`);
}

const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
