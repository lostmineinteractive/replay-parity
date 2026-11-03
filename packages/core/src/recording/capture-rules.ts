import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, isJsonObject, type JsonValue } from '../json.js';
import { parsePath, select, type Segment } from '../jsonpath/index.js';
import type { HeaderMap } from '../headers.js';
import { ConfigError, loadYamlFile } from '../yaml.js';
import { bodyKind, type BodyFields } from './body.js';
import {
  RedactionModeSchema,
  type ManifestRedactionRules,
  type RedactionMode,
} from './manifest.js';
import { DEFAULT_REDACTED_HEADERS, DEFAULT_REDACTED_QUERY, REDACTED } from './redact.js';
import { resolve } from 'node:path';
import { iterateRecording, readRecordingManifest } from './reader.js';
import type { Exchange, Query, RecordedRequest, RecordedResponse } from './types.js';
import { RecordingWriter } from './writer.js';

/**
 * Capture rules: what a capture, or `rp recording anonymize`, redacts.
 *
 * ```yaml
 * redact:
 *   body:
 *     - { path: '$.card.number', mode: drop }
 *     - { path: '$..order_id', mode: hash }
 *   query: [api_key, { name: session, mode: hash }]
 *   headers: [{ name: x-user, mode: hash }]
 * ```
 *
 * `drop` writes the redaction marker. `hash` writes `hmac-sha256:<hex>`, the
 * HMAC-SHA256 of the value keyed by `RP_REDACTION_KEY`, so equal values stay
 * equal across exchanges and a substitution that captures a hashed id finds
 * the same hash where the id is used later. A string is hashed as its text
 * and any other value as its canonical JSON. Body paths are JSONPath and may
 * use wildcards and recursive descent; they apply to the request and the
 * response body when the body is stored as JSON. Header and query entries
 * are added to the name lists of the flags, and an entry here decides the
 * mode for its name.
 */

export const REDACTION_KEY_ENV = 'RP_REDACTION_KEY';
export const HASH_PREFIX = 'hmac-sha256:';

const NamedRuleSchema = z.union([
  z
    .string()
    .min(1)
    .transform((name) => ({ name, mode: 'drop' as const })),
  z.object({ name: z.string().min(1), mode: RedactionModeSchema.default('drop') }).strict(),
]);

export const CaptureRulesSchema = z
  .object({
    redact: z
      .object({
        body: z
          .array(
            z
              .object({ path: z.string().min(1), mode: RedactionModeSchema.default('drop') })
              .strict(),
          )
          .default([]),
        query: z.array(NamedRuleSchema).default([]),
        headers: z.array(NamedRuleSchema).default([]),
      })
      .strict()
      .default({ body: [], query: [], headers: [] }),
  })
  .strict();

export type CaptureRules = z.output<typeof CaptureRulesSchema>;

/** Reads and validates a capture rules file. Every body path must parse. */
export async function loadCaptureRules(path: string): Promise<CaptureRules> {
  const rules = await loadYamlFile(path, CaptureRulesSchema);
  rules.redact.body.forEach((rule, i) => {
    try {
      parsePath(rule.path);
    } catch (err) {
      throw new ConfigError(`${path}: redact.body[${i}]: ${(err as Error).message}`);
    }
  });
  return rules;
}

/** `hmac-sha256:<hex>` of the text with the key. */
export function hashRedaction(key: string, text: string): string {
  return `${HASH_PREFIX}${createHmac('sha256', key).update(text, 'utf8').digest('hex')}`;
}

/** The text a value is hashed as: a string as it is, a lossless number as its text, anything else as canonical JSON. */
export function redactionText(value: JsonValue): string {
  if (typeof value === 'string') return value;
  if (isJsonObject(value) && Object.keys(value).length === 1 && typeof value.$num === 'string') {
    return value.$num;
  }
  return canonicalJson(value);
}

export interface RedactorOptions {
  /** Header names to drop, as the flags give them. Default `DEFAULT_REDACTED_HEADERS`. */
  headers?: readonly string[] | undefined;
  /** Query names to drop, as the flags give them. Default `DEFAULT_REDACTED_QUERY`. */
  query?: readonly string[] | undefined;
  rules?: CaptureRules | undefined;
  /** The HMAC key. Required when a rule hashes. */
  key?: string | undefined;
}

interface BodyRule {
  path: string;
  segments: Segment[];
  mode: RedactionMode;
}

/** Applies header, query, and body redaction to exchanges. */
export class Redactor {
  private readonly headerModes = new Map<string, RedactionMode>();
  private readonly queryModes = new Map<string, RedactionMode>();
  private readonly bodyRules: BodyRule[];
  private readonly key: string | undefined;
  private readonly rules: CaptureRules | undefined;

  constructor(options: RedactorOptions = {}) {
    for (const name of options.headers ?? DEFAULT_REDACTED_HEADERS) {
      this.headerModes.set(name.toLowerCase(), 'drop');
    }
    for (const name of options.query ?? DEFAULT_REDACTED_QUERY) {
      this.queryModes.set(name.toLowerCase(), 'drop');
    }
    const redact = options.rules?.redact;
    for (const rule of redact?.headers ?? [])
      this.headerModes.set(rule.name.toLowerCase(), rule.mode);
    for (const rule of redact?.query ?? []) this.queryModes.set(rule.name.toLowerCase(), rule.mode);
    this.bodyRules = (redact?.body ?? []).map((rule) => ({
      path: rule.path,
      segments: parsePath(rule.path),
      mode: rule.mode,
    }));
    this.rules = options.rules;
    this.key = options.key === undefined || options.key.length === 0 ? undefined : options.key;
    if (this.hashes && this.key === undefined) {
      throw new ConfigError(
        `a capture rule hashes values, so ${REDACTION_KEY_ENV} must be set to the HMAC key`,
      );
    }
  }

  /** True when any rule hashes. */
  get hashes(): boolean {
    return (
      [...this.headerModes.values(), ...this.queryModes.values()].includes('hash') ||
      this.bodyRules.some((r) => r.mode === 'hash')
    );
  }

  /** The header and query names dropped, for the manifest's lists. */
  get droppedHeaders(): string[] {
    return [...this.headerModes].filter(([, m]) => m === 'drop').map(([n]) => n);
  }

  get droppedQuery(): string[] {
    return [...this.queryModes].filter(([, m]) => m === 'drop').map(([n]) => n);
  }

  /** The rules file in the manifest's shape, or undefined without one. The key is never included. */
  get manifestRules(): ManifestRedactionRules | undefined {
    if (this.rules === undefined) return undefined;
    const { redact } = this.rules;
    return {
      headers: redact.headers.map((r) => ({ name: r.name.toLowerCase(), mode: r.mode })),
      query: redact.query.map((r) => ({ name: r.name, mode: r.mode })),
      body: redact.body.map((r) => ({ path: r.path, mode: r.mode })),
    };
  }

  private replace(value: JsonValue, mode: RedactionMode): JsonValue {
    if (mode === 'drop') return REDACTED;
    // A value already redacted stays the marker rather than becoming the hash of the marker.
    if (value === REDACTED) return REDACTED;
    return hashRedaction(this.key as string, redactionText(value));
  }

  headers(headers: HeaderMap): HeaderMap {
    const out: HeaderMap = {};
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      const mode = this.headerModes.get(key);
      out[key] = mode === undefined ? value : (this.replace(value, mode) as string);
    }
    return out;
  }

  query(query: Query): Query {
    const out: Query = {};
    for (const [name, value] of Object.entries(query)) {
      const mode = this.queryModes.get(name.toLowerCase());
      if (mode === undefined) {
        out[name] = value;
      } else if (Array.isArray(value)) {
        out[name] = value.map((v) => this.replace(v, mode) as string);
      } else {
        out[name] = this.replace(value, mode) as string;
      }
    }
    return out;
  }

  /** A copy of the body with every value at a rule's path replaced. Bodies not stored as JSON are kept. */
  body<T extends BodyFields>(fields: T): T {
    if (this.bodyRules.length === 0 || bodyKind(fields) !== 'json') return fields;
    let body = fields.body as JsonValue;
    for (const rule of this.bodyRules) {
      for (const match of select(body, rule.segments)) {
        body = setAt(body, match.segments, this.replace(match.value, rule.mode));
      }
    }
    return { ...fields, body };
  }

  request(request: RecordedRequest): RecordedRequest {
    return this.body({
      ...request,
      query: this.query(request.query),
      headers: this.headers(request.headers),
    });
  }

  response(response: RecordedResponse): RecordedResponse {
    return this.body({ ...response, headers: this.headers(response.headers) });
  }

  exchange(exchange: Exchange): Exchange {
    return {
      ...exchange,
      request: this.request(exchange.request),
      response: this.response(exchange.response),
    };
  }
}

/** A copy of `doc` with the value at the concrete key and index path replaced. */
function setAt(doc: JsonValue, path: readonly Segment[], value: JsonValue): JsonValue {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [Segment, ...Segment[]];
  if (head.type === 'key' && isJsonObject(doc) && Object.hasOwn(doc, head.name)) {
    const copy = { ...doc };
    Object.defineProperty(copy, head.name, {
      value: setAt(doc[head.name] as JsonValue, rest, value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return copy;
  }
  if (head.type === 'index' && Array.isArray(doc) && head.index < doc.length) {
    const copy = [...doc];
    copy[head.index] = setAt(doc[head.index] as JsonValue, rest, value);
    return copy;
  }
  return doc;
}

export interface AnonymizeResult {
  exchanges: number;
  /** True when the input had a manifest, which the output keeps with the rules added. */
  manifest: boolean;
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Applies a redactor to every exchange of a recording and writes the result.
 * Offsets, ids, and order are kept. A manifest on the input is kept with the
 * redaction lists and rules extended; an input without one gives an output
 * without one. The output is new: it may not be the input.
 */
export async function anonymizeRecording(
  inPath: string,
  outPath: string,
  redactor: Redactor,
): Promise<AnonymizeResult> {
  if (resolve(inPath) === resolve(outPath)) {
    throw new ConfigError('anonymize writes a new file; --out must differ from the input');
  }
  let manifest;
  try {
    manifest = await readRecordingManifest(inPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string') throw new ConfigError(`${inPath}: ${(err as Error).message}`);
    throw err;
  }
  const rules = redactor.manifestRules;
  const extended =
    manifest === null
      ? undefined
      : {
          ...manifest,
          redaction: {
            headers: union(manifest.redaction.headers, redactor.droppedHeaders),
            query: union(manifest.redaction.query, redactor.droppedQuery),
            ...(rules === undefined && manifest.redaction.rules === undefined
              ? {}
              : {
                  rules: {
                    headers: [
                      ...(manifest.redaction.rules?.headers ?? []),
                      ...(rules?.headers ?? []),
                    ],
                    query: [...(manifest.redaction.rules?.query ?? []), ...(rules?.query ?? [])],
                    body: [...(manifest.redaction.rules?.body ?? []), ...(rules?.body ?? [])],
                  },
                }),
          },
        };
  const writer = await RecordingWriter.open(outPath, { append: false, manifest: extended });
  try {
    for await (const exchange of iterateRecording(inPath)) {
      await writer.write(redactor.exchange(exchange));
    }
  } finally {
    await writer.close();
  }
  return { exchanges: writer.count, manifest: manifest !== null };
}
