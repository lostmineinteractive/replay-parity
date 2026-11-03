import type { JsonValue } from '../json.js';
import { parseNumericText } from './numeric.js';

/**
 * Timestamp parsing for `time` rules. `iso8601` reads a date, or a date and
 * time with an optional fraction and zone; a time without a zone is read as
 * UTC so the result does not depend on the machine. `epoch_ms` and `epoch_s`
 * read a number, or a string that spells one.
 */

export type TimeFormat = 'iso8601' | 'epoch_ms' | 'epoch_s';

export const TIME_FORMATS: readonly TimeFormat[] = ['iso8601', 'epoch_ms', 'epoch_s'];

const ISO_8601 =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

/** Milliseconds since the epoch, or `undefined` when the value does not read under the format. */
export function parseTimestamp(
  value: JsonValue | undefined,
  format: TimeFormat,
): number | undefined {
  if (format === 'iso8601') {
    if (typeof value !== 'string') return undefined;
    const m = ISO_8601.exec(value);
    if (!m) return undefined;
    const date = m[1] as string;
    const time = m[2];
    if (time === undefined) {
      const day = Date.parse(date);
      return Number.isNaN(day) ? undefined : day;
    }
    // Date.parse takes at most three fraction digits and wants a colon in the zone offset.
    const fraction = m[3] === undefined ? '' : m[3].slice(0, 4).padEnd(4, '0');
    const zone = (m[4] ?? 'Z').toUpperCase().replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const seconds = time.length === 5 ? `${time}:00` : time;
    const ms = Date.parse(`${date}T${seconds}${fraction}${zone}`);
    return Number.isNaN(ms) ? undefined : ms;
  }
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? parseNumericText(value)
        : undefined;
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return format === 'epoch_ms' ? n : n * 1000;
}
