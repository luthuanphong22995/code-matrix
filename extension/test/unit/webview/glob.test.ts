import { describe, expect, it } from 'vitest';
import { globToRegExp, InvalidGlob } from '../../../media/glob';

const m = (glob: string, path: string) => globToRegExp(glob).test(path);

describe('globToRegExp', () => {
  it('** spans any depth, including zero segments', () => {
    expect(m('src/api/**', 'src/api/handler.go')).toBe(true);
    expect(m('src/api/**', 'src/api/v1/router.go')).toBe(true);
    expect(m('src/api/**', 'src/db/conn.go')).toBe(false);
    expect(m('a/**/b', 'a/b')).toBe(true);
    expect(m('a/**/b', 'a/x/y/b')).toBe(true);
    expect(m('**/*.go', 'main.go')).toBe(true);
  });

  it('docs/** matches no Go source path', () => {
    for (const p of ['main.go', 'config.go', 'internal/db/conn.go']) expect(m('docs/**', p)).toBe(false);
  });

  it('* and ? stay within one segment', () => {
    expect(m('*.go', 'main.go')).toBe(true);
    expect(m('*.go', 'internal/db/conn.go')).toBe(false);
    expect(m('ma?n.go', 'main.go')).toBe(true);
    expect(m('a?b', 'a/b')).toBe(false);
  });

  it('[...] and [!...] are character classes', () => {
    expect(m('f[0-9].go', 'f3.go')).toBe(true);
    expect(m('f[0-9].go', 'fx.go')).toBe(false);
    expect(m('f[!0-9].go', 'fx.go')).toBe(true);
    expect(m('f[!0-9].go', 'f3.go')).toBe(false);
  });

  it('{a,b} alternates; other metacharacters are literal; anchored', () => {
    expect(m('src/{api,db}/*.go', 'src/db/conn.go')).toBe(true);
    expect(m('src/{api,db}/*.go', 'src/web/x.go')).toBe(false);
    expect(m('a.go', 'axgo')).toBe(false);
    expect(m('a+(b).go', 'a+(b).go')).toBe(true);
    expect(m('main.go', 'x/main.go')).toBe(false);
  });

  it('throws InvalidGlob on an unterminated [ or { and a trailing \\', () => {
    for (const bad of ['src/[api', '{a,b', 'a\\']) expect(() => globToRegExp(bad)).toThrow(InvalidGlob);
  });
});
