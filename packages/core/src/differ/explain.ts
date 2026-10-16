import type { JsonValue } from '../json.js';
import type { Diff, Finding } from './schema.js';

const MAX_VALUE_TEXT = 80;

function fmt(value: JsonValue | undefined): string {
  if (value === undefined) return 'absent';
  const text = JSON.stringify(value);
  return text.length > MAX_VALUE_TEXT ? `${text.slice(0, MAX_VALUE_TEXT - 3)}...` : text;
}

function where(path: string): string {
  if (path === '$') return 'the body';
  return path;
}

/** Renders one finding as a plain language sentence. */
export function explainFinding(f: Finding): string {
  let text: string;
  switch (f.kind) {
    case 'status':
      text = `The status differs. The reference returned ${fmt(f.reference)} and the candidate returned ${fmt(f.candidate)}.`;
      break;
    case 'header':
      text = `Header ${f.path.slice('header:'.length)} differs. The reference sent ${fmt(f.reference)} and the candidate sent ${fmt(f.candidate)}.`;
      break;
    case 'value':
      if (f.reference === undefined && f.candidate === undefined) {
        text = `${capitalize(where(f.path))} differs. ${f.detail ?? ''}`.trim();
      } else {
        text = `The value at ${where(f.path)} differs. The reference has ${fmt(f.reference)} and the candidate has ${fmt(f.candidate)}.`;
        if (!f.tolerated && f.detail) text += ` ${capitalize(f.detail)}.`;
      }
      break;
    case 'type':
      text = `The type at ${where(f.path)} differs. ${capitalize(f.detail ?? '')}.`;
      break;
    case 'missing':
      text = `The candidate is missing ${where(f.path)}. The reference has ${fmt(f.reference)}.`;
      break;
    case 'unexpected':
      text = `The candidate has an extra value at ${where(f.path)}: ${fmt(f.candidate)}.`;
      break;
    case 'body_too_large':
      text = `The body was not compared. ${capitalize(f.detail ?? '')}.`;
      break;
    case 'body_format':
      text = `The body formats differ. ${capitalize(f.detail ?? '')}.`;
      break;
  }
  if (f.tolerated) {
    text += ` Tolerated by rule ${f.rule ?? 'unknown'}.`;
  }
  return text.replace(/\.\.$/, '.');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]?.toUpperCase() + s.slice(1);
}

/** Renders a whole diff as lines. The first line states the verdict. */
export function explainDiff(diff: Diff): string[] {
  const untolerated = diff.findings.filter((f) => !f.tolerated).length;
  const tolerated = diff.findings.length - untolerated;
  const lines: string[] = [];
  switch (diff.verdict) {
    case 'match':
      lines.push('The responses match. No differences were found.');
      break;
    case 'tolerated':
      lines.push(
        `The responses differ in ${tolerated} place${tolerated === 1 ? '' : 's'} and every difference is tolerated by a rule.`,
      );
      break;
    case 'mismatch':
      lines.push(
        `The responses mismatch. ${untolerated} difference${untolerated === 1 ? ' is' : 's are'} not covered by any rule${tolerated > 0 ? ` and ${tolerated} ${tolerated === 1 ? 'is' : 'are'} tolerated` : ''}.`,
      );
      break;
  }
  for (const f of diff.findings) {
    lines.push(`${f.tolerated ? '  ~ ' : '  x '}${explainFinding(f)}`);
  }
  return lines;
}
