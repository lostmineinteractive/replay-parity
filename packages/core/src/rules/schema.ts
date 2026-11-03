import { parse as parseYamlText } from 'yaml';
import { z } from 'zod';
import { isValidPath, isValidRulePath } from '../jsonpath/index.js';
import { ConfigError, formatZodError } from '../yaml.js';
import { patternProblem } from './pattern.js';
import { WhenSchema, type When } from './scope.js';
import { TIME_FORMATS } from './time.js';

/**
 * The diff rules file (`diff-rules.yaml`). Rules are data, not code. Every
 * rule entry takes an optional `when` scope; see scope.ts. `include` at the
 * top of a file names rule packs merged in before validation; see load.ts.
 */

/** A path in the plain subset, for unordered keys and substitution captures. */
const PathSchema = z.string().refine(isValidPath, {
  message: "unsupported JSONPath (supported: $, .name, ['name'], [n], [*], .*)",
});

/** A path a rule matches against: the plain subset plus filters and recursive descent. */
const RulePathSchema = z.string().refine(isValidRulePath, {
  message:
    "unsupported JSONPath (supported: $, .name, ['name'], [n], [*], .*, [?(@.name=='x')], ..name)",
});

const PatternSchema = z
  .string()
  .min(1)
  .superRefine((pattern, ctx) => {
    const problem = patternProblem(pattern);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `bad pattern: ${problem}` });
  });

const scoped = { when: WhenSchema.optional() };

/** A path, or `{ path, when }` for a scoped entry. */
export const IgnoreRuleSchema = z.union([
  RulePathSchema,
  z.object({ path: RulePathSchema, ...scoped }).strict(),
]);

export const ToleranceRuleSchema = z
  .object({
    path: RulePathSchema,
    abs: z.number().nonnegative().optional(),
    rel: z.number().nonnegative().optional(),
    ...scoped,
  })
  .strict()
  .refine((r) => r.abs !== undefined || r.rel !== undefined, {
    message: 'a tolerance needs abs, rel, or both',
  });

export const UnorderedRuleSchema = z
  .object({
    path: RulePathSchema,
    key: PathSchema.optional(),
    ...scoped,
  })
  .strict();

const StatusClassSchema = z.array(z.number().int().min(100).max(599)).min(2);

/** One class of equivalent statuses, or `{ classes, when }` for scoped classes. */
export const StatusEquivalentSchema = z.union([
  StatusClassSchema,
  z.object({ classes: z.array(StatusClassSchema).min(1), ...scoped }).strict(),
]);

const HeaderNameSchema = z.string().min(1);

/** A header name, or `{ name, when }` for a scoped entry. */
export const HeaderRuleSchema = z.union([
  HeaderNameSchema,
  z.object({ name: HeaderNameSchema, ...scoped }).strict(),
]);

export const HeaderMaskSchema = z
  .object({ name: HeaderNameSchema, pattern: PatternSchema, ...scoped })
  .strict();

export const ExtraFieldsRuleSchema = z.object({ allow: z.boolean(), ...scoped }).strict();

export const EquivalenceRuleSchema = z
  .object({
    /** `null` and an absent field compare equal. */
    null_absent: z.boolean().default(false),
    /** `""`, `[]`, `{}`, and an absent field compare equal. */
    empty_absent: z.boolean().default(false),
    /** A string that spells a number compares equal to that number. */
    numeric_strings: z.boolean().default(false),
    ...scoped,
  })
  .strict();

/** One entry, or a list of scoped entries. */
export const EquivalencesSchema = z.union([EquivalenceRuleSchema, z.array(EquivalenceRuleSchema)]);

export const DecimalRuleSchema = z
  .object({
    path: RulePathSchema,
    /** Fraction digits kept after rounding half away from zero. */
    scale: z.number().int().min(0).max(20),
    ...scoped,
  })
  .strict();

export const TimeRuleSchema = z
  .object({
    path: RulePathSchema,
    /** The window within which two timestamps compare equal, in milliseconds. */
    abs_ms: z.number().nonnegative(),
    format: z.enum(TIME_FORMATS).default('iso8601'),
    ...scoped,
  })
  .strict();

export const MaskRuleSchema = z
  .object({ path: RulePathSchema, pattern: PatternSchema, ...scoped })
  .strict();

/**
 * Where a substitution reads its value. `path` reads the response body, or
 * the request body with `from: request`. `header` reads a response header,
 * through the first group of `pattern` when one is given.
 */
export const SubstitutionCaptureSchema = z
  .object({
    tag: z.string().min(1),
    from: z.enum(['response', 'request']).optional(),
    path: PathSchema.optional(),
    header: HeaderNameSchema.optional(),
    pattern: PatternSchema.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if ((c.path === undefined) === (c.header === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'capture needs path or header, and not both' });
    }
    if (c.pattern !== undefined && c.header === undefined) {
      ctx.addIssue({ code: 'custom', message: 'pattern applies to a header capture only' });
    }
    if (c.from === 'request' && c.header !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'a request capture reads a path, not a header' });
    }
  });

export const SubstitutionRuleSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'name must be an identifier'),
    capture: SubstitutionCaptureSchema,
    apply: z
      .array(z.enum(['path', 'query', 'body']))
      .min(1)
      .default(['path', 'query', 'body']),
  })
  .strict();

/**
 * What `rp shrink` may change in a request body. `lower` lists the paths of
 * integers lowered toward one. `simplify` lists the paths of values replaced
 * by "", [], or {}. Without `lower` the fields `qty` and `quantity` are lowered.
 */
export const ShrinkRulesSchema = z
  .object({
    lower: z.array(PathSchema).optional(),
    simplify: z.array(PathSchema).optional(),
  })
  .strict();

export const DiffRulesSchema = z
  .object({
    ignore: z.array(IgnoreRuleSchema).default([]),
    tolerances: z.array(ToleranceRuleSchema).default([]),
    unordered: z.array(UnorderedRuleSchema).default([]),
    status: z
      .object({
        equivalent: z.array(StatusEquivalentSchema).default([]),
      })
      .strict()
      .default({ equivalent: [] }),
    headers: z
      .object({
        /** Response headers compared by name. Default: none. */
        compare: z.array(HeaderRuleSchema).default([]),
        /** Names taken out of the comparison, so a pack's entry can be undone. */
        ignore: z.array(HeaderRuleSchema).default([]),
        /** A compared header whose two values both match the pattern is tolerated. */
        masks: z.array(HeaderMaskSchema).default([]),
      })
      .strict()
      .default({ compare: [], ignore: [], masks: [] }),
    /** Whether a field the candidate adds is tolerated. Default deny. */
    extra_fields: z.enum(['allow', 'deny']).default('deny'),
    /** Scoped overrides of `extra_fields`. The first entry whose scope matches decides. */
    extra_fields_rules: z.array(ExtraFieldsRuleSchema).default([]),
    equivalences: EquivalencesSchema.default({
      null_absent: false,
      empty_absent: false,
      numeric_strings: false,
    }),
    decimal: z.array(DecimalRuleSchema).default([]),
    time: z.array(TimeRuleSchema).default([]),
    mask: z.array(MaskRuleSchema).default([]),
    substitutions: z.array(SubstitutionRuleSchema).default([]),
    /**
     * Harness controls. An exchange with one of these tags is replayed in
     * order behind a full barrier, diffed on status only, excluded from
     * statistics and thresholds, and marked `control: true` in the run.
     */
    controls: z
      .object({
        tags: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ tags: [] }),
    /** Paths `rp shrink` lowers and simplifies. Absent means the default quantity fields. */
    shrink: ShrinkRulesSchema.optional(),
  })
  .strict();

export type IgnoreRule = z.output<typeof IgnoreRuleSchema>;
export type ToleranceRule = z.output<typeof ToleranceRuleSchema>;
export type UnorderedRule = z.output<typeof UnorderedRuleSchema>;
export type StatusEquivalent = z.output<typeof StatusEquivalentSchema>;
export type HeaderRule = z.output<typeof HeaderRuleSchema>;
export type HeaderMask = z.output<typeof HeaderMaskSchema>;
export type ExtraFieldsRule = z.output<typeof ExtraFieldsRuleSchema>;
export type EquivalenceRule = z.output<typeof EquivalenceRuleSchema>;
export type DecimalRule = z.output<typeof DecimalRuleSchema>;
export type TimeRule = z.output<typeof TimeRuleSchema>;
export type MaskRule = z.output<typeof MaskRuleSchema>;
export type SubstitutionCapture = z.output<typeof SubstitutionCaptureSchema>;
export type SubstitutionRule = z.output<typeof SubstitutionRuleSchema>;
export type ShrinkRules = z.output<typeof ShrinkRulesSchema>;
export type DiffRules = z.output<typeof DiffRulesSchema>;
export type DiffRulesInput = z.input<typeof DiffRulesSchema>;

export function emptyRules(): DiffRules {
  return DiffRulesSchema.parse({});
}

/** Validates a parsed rules object. Errors name the source and the path. */
export function validateRules(raw: unknown, source: string): DiffRules {
  const result = DiffRulesSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(`${source}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/** Parses rules from YAML text. A file with `include` needs `loadDiffRules`, which resolves the packs. */
export function parseDiffRules(text: string, source = 'diff-rules'): DiffRules {
  let raw: unknown;
  try {
    raw = parseYamlText(text);
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML (${(err as Error).message})`);
  }
  if (typeof raw === 'object' && raw !== null && 'include' in raw) {
    throw new ConfigError(
      `${source}: include needs a file to resolve the packs against; load the rules with loadDiffRules`,
    );
  }
  return validateRules(raw, source);
}

/** The ignore entries as `{ path, when }`, whichever form each was written in. */
export function ignoreEntries(rules: DiffRules): { path: string; when?: When | undefined }[] {
  return rules.ignore.map((r) => (typeof r === 'string' ? { path: r } : r));
}

/** A header list as `{ name, when }` with names lower cased. */
export function headerEntries(
  entries: readonly HeaderRule[],
): { name: string; when?: When | undefined }[] {
  return entries.map((r) =>
    typeof r === 'string' ? { name: r.toLowerCase() } : { ...r, name: r.name.toLowerCase() },
  );
}

/** The equivalence entries as a list, whichever form they were written in. */
export function equivalenceEntries(rules: DiffRules): EquivalenceRule[] {
  return Array.isArray(rules.equivalences) ? rules.equivalences : [rules.equivalences];
}
