import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { HeaderMap } from '../headers.js';
import { createUlidFactory } from '../ulid.js';
import { ConfigError, formatZodError } from '../yaml.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  encodeBody,
  parseContentEncoding,
  type BodyFields,
} from './body.js';
import type { Redactor } from './capture-rules.js';
import { buildManifest } from './manifest.js';
import type { Exchange, Query } from './types.js';
import { RecordingWriter } from './writer.js';

/**
 * Imports a HAR 1.2 file as a recording. Each entry becomes an exchange:
 * the method, the path and query of the URL, the headers, and the bodies by
 * the same storage rules as a capture. `ts` is `startedDateTime`, `offset_ms`
 * is the time since the earliest entry, and `latency_ms` is the entry's
 * `time`. Entries are written in order of `startedDateTime`, with ties in
 * file order. An entry without a response, which browsers write with status
 * 0, is skipped and counted.
 *
 * A HAR body is the decoded content, so a body that arrived with a
 * `content-encoding` is stored decoded with the coding noted in
 * `content_encoding`, as the capture does. HTTP/2 pseudo headers and hop by
 * hop headers are left out, names are lower cased, and repeated headers are
 * joined with a comma. Ids are ULIDs on the entry's time with the random
 * part derived from the file name and the entry's position, so importing
 * the same file twice gives the same ids.
 */

const NameValue = z.object({ name: z.string(), value: z.string() }).loose();

const HarEntrySchema = z
  .object({
    startedDateTime: z.string(),
    time: z.number(),
    request: z
      .object({
        method: z.string().min(1),
        url: z.string().min(1),
        headers: z.array(NameValue).default([]),
        postData: z
          .object({
            mimeType: z.string().optional(),
            text: z.string().optional(),
            encoding: z.string().optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
    response: z
      .object({
        status: z.number(),
        headers: z.array(NameValue).default([]),
        content: z
          .object({
            mimeType: z.string().optional(),
            text: z.string().optional(),
            encoding: z.string().optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  })
  .loose();

export const HarSchema = z
  .object({
    log: z.object({ version: z.string().optional(), entries: z.array(HarEntrySchema) }).loose(),
  })
  .loose();

export type Har = z.output<typeof HarSchema>;
type HarEntry = z.output<typeof HarEntrySchema>;

const LEFT_OUT = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function headerMap(list: readonly { name: string; value: string }[]): HeaderMap {
  const out: HeaderMap = {};
  for (const { name, value } of list) {
    const key = name.toLowerCase();
    if (key.startsWith(':') || LEFT_OUT.has(key)) continue;
    const current = out[key];
    out[key] = current === undefined ? value : `${current}, ${value}`;
  }
  return out;
}

function queryOf(params: URLSearchParams): Query {
  const out: Query = {};
  for (const [key, value] of params) {
    const current = out[key];
    if (current === undefined) {
      out[key] = value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      out[key] = [current, value];
    }
  }
  return out;
}

/** The body fields for HAR content, which is already decoded. */
function harBody(
  text: string | undefined,
  encoding: string | undefined,
  mimeType: string | undefined,
  contentEncoding: string | undefined,
  maxBodyBytes: number,
): BodyFields {
  if (text === undefined || text.length === 0) return {};
  const bytes = encoding === 'base64' ? Buffer.from(text, 'base64') : Buffer.from(text, 'utf8');
  const fields = encodeBody(bytes, mimeType, maxBodyBytes);
  const codings = parseContentEncoding(contentEncoding);
  if (fields.body === undefined || codings === null || codings.length === 0) return fields;
  return { ...fields, content_encoding: codings.join(', ') };
}

export interface HarImportOptions {
  /** The tags of a request, as the capture's tag rules give them. Default: none. */
  tags?: ((method: string, path: string) => string[]) | undefined;
  redactor: Redactor;
  maxBodyBytes?: number | undefined;
  /** Seeds the ids. Default `har`. */
  source?: string | undefined;
}

export interface HarSkipped {
  /** 0 based position of the entry in the file. */
  index: number;
  reason: string;
}

export interface HarConversion {
  exchanges: Exchange[];
  skipped: HarSkipped[];
  /** The origin of the earliest entry, or null with none. */
  origin: string | null;
}

/** Validates parsed HAR JSON. */
export function parseHar(raw: unknown, source = 'HAR'): Har {
  const result = HarSchema.safeParse(raw);
  if (!result.success)
    throw new ConfigError(`${source}: not a HAR file: ${formatZodError(result.error)}`);
  return result.data;
}

/** Turns HAR entries into exchanges. */
export function harToExchanges(har: Har, options: HarImportOptions): HarConversion {
  const skipped: HarSkipped[] = [];
  const timed: { index: number; tsMs: number; entry: HarEntry; url: URL }[] = [];
  har.log.entries.forEach((entry, index) => {
    const tsMs = Date.parse(entry.startedDateTime);
    if (Number.isNaN(tsMs)) {
      skipped.push({
        index,
        reason: `startedDateTime ${JSON.stringify(entry.startedDateTime)} is not a date`,
      });
      return;
    }
    const status = entry.response.status;
    if (!(Number.isInteger(status) && status >= 100 && status <= 599)) {
      skipped.push({ index, reason: `no response (status ${status})` });
      return;
    }
    let url: URL;
    try {
      url = new URL(entry.request.url);
    } catch {
      skipped.push({ index, reason: `url ${JSON.stringify(entry.request.url)} does not parse` });
      return;
    }
    timed.push({ index, tsMs, entry, url });
  });
  timed.sort((a, b) => a.tsMs - b.tsMs || a.index - b.index);
  const source = options.source ?? 'har';
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const first = timed[0]?.tsMs ?? 0;
  const exchanges = timed.map(({ index, tsMs, entry, url }) => {
    const nextId = createUlidFactory({
      now: () => tsMs,
      random: (n) => createHash('sha256').update(`${source}\n${index}`).digest().subarray(0, n),
    });
    const requestHeaders = headerMap(entry.request.headers);
    const responseHeaders = headerMap(entry.response.headers);
    const method = entry.request.method.toUpperCase();
    const post = entry.request.postData;
    const content = entry.response.content;
    return {
      id: nextId(),
      ts: new Date(tsMs).toISOString(),
      offset_ms: tsMs - first,
      adapter: 'http',
      request: options.redactor.request({
        method,
        path: url.pathname,
        query: queryOf(url.searchParams),
        headers: requestHeaders,
        ...harBody(
          post?.text,
          post?.encoding,
          post?.mimeType ?? requestHeaders['content-type'],
          requestHeaders['content-encoding'],
          maxBodyBytes,
        ),
      }),
      response: options.redactor.response({
        status: entry.response.status,
        headers: responseHeaders,
        latency_ms: Math.max(0, entry.time),
        ...harBody(
          content?.text,
          content?.encoding,
          content?.mimeType ?? responseHeaders['content-type'],
          responseHeaders['content-encoding'],
          maxBodyBytes,
        ),
      }),
      tags: options.tags?.(method, url.pathname) ?? [],
    } satisfies Exchange;
  });
  return { exchanges, skipped, origin: timed[0]?.url.origin ?? null };
}

export interface HarFileImportOptions extends Omit<HarImportOptions, 'source'> {
  toolVersion: string;
  /** The tag rules in their text form, for the manifest. */
  tagRuleTexts?: readonly string[] | undefined;
  /** The manifest's creation time. Default: now. */
  createdAt?: string | undefined;
  /** Header and query names dropped, as the flags gave them, for the manifest. */
  redactedHeaders: readonly string[];
  redactedQuery: readonly string[];
}

export interface HarFileImport {
  exchanges: number;
  skipped: HarSkipped[];
}

/** Reads a HAR file and writes it as a recording with a manifest. `.gz` output is compressed. */
export async function importHarFile(
  harPath: string,
  outPath: string,
  options: HarFileImportOptions,
): Promise<HarFileImport> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(harPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${harPath}: ${(err as Error).message}`);
  }
  const source = basename(harPath);
  const { exchanges, skipped, origin } = harToExchanges(parseHar(raw, harPath), {
    ...options,
    source,
  });
  const manifest = buildManifest({
    tool_version: options.toolVersion,
    created_at: options.createdAt,
    target: origin,
    tag_rules: options.tagRuleTexts ?? [],
    headers: options.redactedHeaders,
    query: options.redactedQuery,
    rules: options.redactor.manifestRules,
    source: `har:${source}`,
  });
  let writer: RecordingWriter;
  try {
    writer = await RecordingWriter.open(outPath, { append: false, manifest });
  } catch (err) {
    throw new ConfigError(`${outPath}: ${(err as Error).message}`);
  }
  try {
    for (const e of exchanges) await writer.write(e);
  } finally {
    await writer.close();
  }
  return { exchanges: writer.count, skipped };
}
