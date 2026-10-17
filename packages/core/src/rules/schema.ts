import { z } from 'zod';
import { isValidPath } from '../jsonpath/index.js';
import { loadYamlFile, parseYaml } from '../yaml.js';

/**
 * The diff rules file (`diff-rules.yaml`). Rules are data, not code.
 */

const PathSchema = z.string().refine(isValidPath, {
  message: "unsupported JSONPath (supported: $, .name, ['name'], [n], [*], .*)",
});

export const ToleranceRuleSchema = z
  .object({
    path: PathSchema,
    abs: z.number().nonnegative().optional(),
    rel: z.number().nonnegative().optional(),
  })
  .strict()
  .refine((r) => r.abs !== undefined || r.rel !== undefined, {
    message: 'a tolerance needs abs, rel, or both',
  });

export const UnorderedRuleSchema = z
  .object({
    path: PathSchema,
    key: PathSchema.optional(),
  })
  .strict();

export const SubstitutionRuleSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'name must be an identifier'),
    capture: z
      .object({
        tag: z.string().min(1),
        path: PathSchema,
      })
      .strict(),
    apply: z
      .array(z.enum(['path', 'query', 'body']))
      .min(1)
      .default(['path', 'query', 'body']),
  })
  .strict();

export const DiffRulesSchema = z
  .object({
    ignore: z.array(PathSchema).default([]),
    tolerances: z.array(ToleranceRuleSchema).default([]),
    unordered: z.array(UnorderedRuleSchema).default([]),
    status: z
      .object({
        equivalent: z.array(z.array(z.number().int().min(100).max(599)).min(2)).default([]),
      })
      .strict()
      .default({ equivalent: [] }),
    headers: z
      .object({
        compare: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ compare: [] }),
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
  })
  .strict();

export type ToleranceRule = z.output<typeof ToleranceRuleSchema>;
export type UnorderedRule = z.output<typeof UnorderedRuleSchema>;
export type SubstitutionRule = z.output<typeof SubstitutionRuleSchema>;
export type DiffRules = z.output<typeof DiffRulesSchema>;
export type DiffRulesInput = z.input<typeof DiffRulesSchema>;

export function emptyRules(): DiffRules {
  return DiffRulesSchema.parse({});
}

export function parseDiffRules(text: string, source = 'diff-rules'): DiffRules {
  return parseYaml(text, DiffRulesSchema, source);
}

export function loadDiffRules(path: string): Promise<DiffRules> {
  return loadYamlFile(path, DiffRulesSchema);
}
