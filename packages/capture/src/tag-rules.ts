import { matchGlob } from '@replay-parity/core';

/**
 * Tag rules map a request to a scenario tag. The text form is
 * `[METHOD ]<glob>=<tag>`, for example `POST /v1/orders=create-order` or
 * `/v1/inventory/*=stock`. The first matching rule wins.
 */

export interface TagRule {
  method: string | null;
  glob: string;
  tag: string;
}

export class TagRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagRuleError';
  }
}

const RULE = /^(?:([A-Za-z]+)\s+)?([/*][^=\s]*)=([A-Za-z0-9_.:-]+)$/;

export function parseTagRule(text: string): TagRule {
  const match = RULE.exec(text.trim());
  if (!match) {
    throw new TagRuleError(
      `tag rule ${JSON.stringify(text)} must look like "[METHOD ]<path-glob>=<tag>"`,
    );
  }
  const [, method, glob, tag] = match;
  return { method: method ? method.toUpperCase() : null, glob: glob as string, tag: tag as string };
}

/** The text form of a rule, which `parseTagRule` reads back. */
export function formatTagRule(rule: TagRule): string {
  return `${rule.method === null ? '' : `${rule.method} `}${rule.glob}=${rule.tag}`;
}

export function tagsFor(rules: readonly TagRule[], method: string, path: string): string[] {
  const upper = method.toUpperCase();
  for (const rule of rules) {
    if (rule.method !== null && rule.method !== upper) continue;
    if (matchGlob(rule.glob, path)) return [rule.tag];
  }
  return [];
}
