import {
  ConfigError,
  bucketOf,
  canonicalJson,
  get,
  parsePath,
  type HeaderMap,
  type JsonValue,
  type Segment,
} from '@replay-parity/core';

/**
 * Session aware sampling for the capture. A selector names where a request
 * carries its session: `header:<name>`, `cookie:<name>`, or a request body
 * JSONPath starting with `$`. The value found there is hashed with the seed
 * by `bucketOf`, and the session is kept when the bucket is below the
 * fraction, so every request of a session gets the same answer and a create
 * stays with its later reads. The hash is the one `rp recording sample
 * --by-session` uses, so the same seed and fraction choose the same sessions
 * for a header or body selector whether the sample is taken at capture or
 * afterwards. A request without a session value falls back to a draw of its
 * own.
 */

export type SessionSelector =
  | { kind: 'header'; name: string; text: string }
  | { kind: 'cookie'; name: string; text: string }
  | { kind: 'body'; path: Segment[]; text: string };

/** Parses `header:<name>`, `cookie:<name>`, or a plain JSONPath such as `$.session.id`. */
export function parseSessionSelector(text: string): SessionSelector {
  const trimmed = text.trim();
  if (trimmed.startsWith('$')) {
    let path: Segment[];
    try {
      path = parsePath(trimmed);
    } catch (err) {
      throw new ConfigError(`--sample-by: ${(err as Error).message}`);
    }
    if (!path.every((seg) => seg.type === 'key' || seg.type === 'index')) {
      throw new ConfigError(
        '--sample-by: a body path names one value; wildcards, filters, and recursive descent are not allowed',
      );
    }
    return { kind: 'body', path, text: trimmed };
  }
  const m = /^(header|cookie):(.+)$/i.exec(trimmed);
  const name = m?.[2]?.trim() ?? '';
  if (m === null || name.length === 0) {
    throw new ConfigError(
      `--sample-by ${JSON.stringify(text)} must be header:<name>, cookie:<name>, or a JSONPath starting with $`,
    );
  }
  const kind = (m[1] as string).toLowerCase() as 'header' | 'cookie';
  const key = kind === 'header' ? name.toLowerCase() : name;
  return { kind, name: key, text: `${kind}:${key}` };
}

/** The value of cookie `name` in a `cookie` request header, or null. */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export interface SessionSamplerOptions {
  fraction: number;
  seed: number;
  selector: SessionSelector;
  /** The draw for a request without a session value. */
  random: () => number;
}

/** The answer for one request: keep, drop, or wait for the request body. */
export type SessionDecision = boolean | 'body';

export class SessionSampler {
  constructor(private readonly options: SessionSamplerOptions) {}

  get selector(): SessionSelector {
    return this.options.selector;
  }

  /** Whether to keep a session key, the same answer every time for the same key. */
  keepKey(key: string): boolean {
    return bucketOf(this.options.seed, key) < this.options.fraction;
  }

  private fallback(): boolean {
    return this.options.random() < this.options.fraction;
  }

  /** Decides from the request headers, or answers `'body'` when the selector reads the body. */
  fromHeaders(headers: HeaderMap): SessionDecision {
    const { selector } = this.options;
    if (selector.kind === 'body') return 'body';
    const value =
      selector.kind === 'header'
        ? (headers[selector.name] ?? null)
        : cookieValue(headers.cookie, selector.name);
    return value === null || value.length === 0 ? this.fallback() : this.keepKey(value);
  }

  /** Decides from the parsed request body, for a body selector. */
  fromBody(body: JsonValue | undefined): boolean {
    const { selector } = this.options;
    if (selector.kind !== 'body') throw new Error('fromBody needs a body selector');
    const value = get(body, selector.path);
    if (typeof value === 'string' || typeof value === 'number') {
      return this.keepKey(canonicalJson(value));
    }
    return this.fallback();
  }
}
