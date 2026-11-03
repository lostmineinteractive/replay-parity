import { z } from 'zod';
import { matchGlob } from '../glob.js';

/**
 * Rule scope. A rule carries an optional `when`; a rule without one is
 * global. A rule with one applies to an exchange only when every criterion
 * given holds: the exchange carries one of the tags, its method is one of
 * the methods, and its path matches one of the globs. The differ learns the
 * exchange through a `DiffContext`. Without a context the exchange is
 * unknown and every rule applies, scoped or not, which is how a caller that
 * predates scopes keeps the behavior it had. A context with a field left out
 * fails the criteria on that field.
 */

export const WhenSchema = z
  .object({
    tags: z.array(z.string().min(1)).min(1).optional(),
    methods: z.array(z.string().min(1)).min(1).optional(),
    /** Path globs: `*` within a segment, `**` across segments, `?` one character. */
    paths: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine((w) => w.tags !== undefined || w.methods !== undefined || w.paths !== undefined, {
    message: 'when needs tags, methods, or paths',
  });

export type When = z.output<typeof WhenSchema>;

/** What the differ knows about the exchange whose responses it compares. */
export interface DiffContext {
  tags?: readonly string[] | undefined;
  method?: string | undefined;
  path?: string | undefined;
}

export function whenMatches(when: When | undefined, context: DiffContext | undefined): boolean {
  if (when === undefined) return true;
  if (context === undefined) return true;
  if (when.tags !== undefined) {
    const tags = context.tags ?? [];
    if (!when.tags.some((t) => tags.includes(t))) return false;
  }
  if (when.methods !== undefined) {
    const method = context.method?.toUpperCase();
    if (method === undefined || !when.methods.some((m) => m.toUpperCase() === method)) return false;
  }
  if (when.paths !== undefined) {
    const path = context.path;
    if (path === undefined || !when.paths.some((g) => matchGlob(g, path))) return false;
  }
  return true;
}

/** The context of a recorded exchange: its tags, method, and path. */
export function exchangeContext(exchange: {
  tags: readonly string[];
  request: { method: string; path: string };
}): DiffContext {
  return { tags: exchange.tags, method: exchange.request.method, path: exchange.request.path };
}

/** `global`, or the criteria as `tags a, b; methods GET; paths /v1/*`. */
export function describeWhen(when: When | undefined): string {
  if (when === undefined) return 'global';
  const parts: string[] = [];
  if (when.tags !== undefined) parts.push(`tags ${when.tags.join(', ')}`);
  if (when.methods !== undefined) parts.push(`methods ${when.methods.join(', ')}`);
  if (when.paths !== undefined) parts.push(`paths ${when.paths.join(', ')}`);
  return parts.join('; ');
}
