/**
 * A small path glob matcher. `*` matches any run of characters inside one
 * path segment, `**` matches across segments, and `?` matches one character.
 * Matching is anchored at both ends.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let source = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  source += '$';
  const re = new RegExp(source);
  cache.set(glob, re);
  return re;
}

export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}
