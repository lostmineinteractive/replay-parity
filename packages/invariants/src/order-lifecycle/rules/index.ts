import { rule as rule01 } from './01-shipment-applied-once.js';
import { rule as rule02 } from './02-shipped-within-quantity.js';
import { rule as rule03 } from './03-shipped-monotonic.js';
import { rule as rule04 } from './04-remaining-arithmetic.js';
import { rule as rule05 } from './05-stock-on-hand.js';
import { rule as rule06 } from './06-receivables.js';
import { rule as rule07 } from './07-rejected-no-shipments.js';
import { rule as rule08 } from './08-idempotency-key.js';
import { rule as rule09 } from './09-retry-no-reset.js';
import { rule as rule10 } from './10-allocation-deterministic.js';
import type { Rule } from './rule.js';

export const RULES: readonly Rule[] = [
  rule01,
  rule02,
  rule03,
  rule04,
  rule05,
  rule06,
  rule07,
  rule08,
  rule09,
  rule10,
];

export type { Rule } from './rule.js';
