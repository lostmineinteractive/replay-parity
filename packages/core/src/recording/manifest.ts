import { z } from 'zod';
import { formatZodError } from '../yaml.js';

/**
 * The manifest line. A recording may start with one JSON object that has a
 * `manifest` member instead of an exchange. It says which tool, target, tag
 * rules, redaction, and sampling produced the file. The reader skips it, so
 * the exchanges of a file with a manifest and without one read the same.
 * The manifest never holds a secret: a keyed redaction names its paths and
 * modes, never the key.
 */

export const MANIFEST_VERSION = 1;

export const RedactionModeSchema = z.enum(['drop', 'hash']);
export type RedactionMode = z.output<typeof RedactionModeSchema>;

export const ManifestBodyRuleSchema = z
  .object({ path: z.string().min(1), mode: RedactionModeSchema })
  .strict();

export const ManifestNamedRuleSchema = z
  .object({ name: z.string().min(1), mode: RedactionModeSchema })
  .strict();

export const ManifestRedactionRulesSchema = z
  .object({
    headers: z.array(ManifestNamedRuleSchema),
    query: z.array(ManifestNamedRuleSchema),
    body: z.array(ManifestBodyRuleSchema),
  })
  .strict();

export type ManifestRedactionRules = z.output<typeof ManifestRedactionRulesSchema>;

export const RecordingManifestSchema = z
  .object({
    manifest: z.literal(MANIFEST_VERSION),
    tool_version: z.string().min(1),
    created_at: z.iso.datetime(),
    /** The reference system the traffic went to, or null when unknown. */
    target: z.string().nullable(),
    /** Tag rules in their text form, `[METHOD ]<glob>=<tag>`, in order. */
    tag_rules: z.array(z.string()),
    redaction: z
      .object({
        /** Header names whose values were replaced by the marker. */
        headers: z.array(z.string()),
        /** Query parameter names whose values were replaced by the marker. */
        query: z.array(z.string()),
        /** The rules of a capture rules file, with their modes. */
        rules: ManifestRedactionRulesSchema.optional(),
      })
      .strict(),
    /** The fraction recorded and the seed of the session hash, when one was used. */
    sample: z
      .object({
        fraction: z.number().gt(0).max(1),
        seed: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    /** The `--sample-by` selector, or null when exchanges were sampled one by one. */
    session_key: z.string().nullable(),
    /** The part number of a rotated capture, from 1. Absent on a single file. */
    part: z.number().int().positive().optional(),
    /** Where the exchanges came from when they were not captured, such as `har:session.har`. */
    source: z.string().min(1).optional(),
  })
  .strict();

export type RecordingManifest = z.output<typeof RecordingManifestSchema>;

/** True when a parsed line is a manifest rather than an exchange. */
export function isManifestRecord(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'manifest' in raw;
}

/** Validates a parsed manifest record. Throws an Error with the problem in words. */
export function parseManifestRecord(raw: unknown): RecordingManifest {
  const result = RecordingManifestSchema.safeParse(raw);
  if (!result.success) throw new Error(`invalid manifest: ${formatZodError(result.error)}`);
  return result.data;
}

/** The manifest as one line of JSON with its trailing newline. */
export function manifestLine(manifest: RecordingManifest): string {
  return `${JSON.stringify(RecordingManifestSchema.parse(manifest))}\n`;
}

export interface ManifestFields {
  tool_version: string;
  target?: string | null | undefined;
  tag_rules?: readonly string[] | undefined;
  headers?: readonly string[] | undefined;
  query?: readonly string[] | undefined;
  rules?: ManifestRedactionRules | undefined;
  fraction?: number | undefined;
  seed?: number | null | undefined;
  session_key?: string | null | undefined;
  created_at?: string | undefined;
  source?: string | undefined;
}

/** Builds a manifest with empty lists, a fraction of 1, and the current time where a field is not given. */
export function buildManifest(fields: ManifestFields): RecordingManifest {
  return RecordingManifestSchema.parse({
    manifest: MANIFEST_VERSION,
    tool_version: fields.tool_version,
    created_at: fields.created_at ?? new Date().toISOString(),
    target: fields.target ?? null,
    tag_rules: [...(fields.tag_rules ?? [])],
    redaction: {
      headers: [...(fields.headers ?? [])],
      query: [...(fields.query ?? [])],
      ...(fields.rules === undefined ? {} : { rules: fields.rules }),
    },
    sample: { fraction: fields.fraction ?? 1, seed: fields.seed ?? null },
    session_key: fields.session_key ?? null,
    ...(fields.source === undefined ? {} : { source: fields.source }),
  });
}
