import type { InvariantRule } from '../../module.js';
import type { Epoch } from '../model.js';

export { Collector } from '../../outcome.js';

/** A rule of the order lifecycle module, checked once per epoch. */
export type Rule = InvariantRule<Epoch>;
