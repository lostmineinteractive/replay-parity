/**
 * The product catalog. Unit prices are stored in thousandths so that totals
 * can land exactly on a half cent and rounding behavior is observable.
 */

export interface CatalogEntry {
  sku: string;
  name: string;
  unit_price_milli: number;
  on_hand: number;
}

export const CATALOG: readonly CatalogEntry[] = [
  { sku: 'C-300', name: 'Bracket L', unit_price_milli: 12_500, on_hand: 500 },
  { sku: 'A-100', name: 'Hex bolt M8', unit_price_milli: 9_995, on_hand: 500 },
  { sku: 'F-600', name: 'Hinge pair', unit_price_milli: 2_675, on_hand: 500 },
  { sku: 'B-200', name: 'Washer 8mm', unit_price_milli: 4_125, on_hand: 500 },
  { sku: 'J-900', name: 'Rail 1m', unit_price_milli: 15_995, on_hand: 500 },
  { sku: 'D-400', name: 'Spring clip', unit_price_milli: 335, on_hand: 500 },
  { sku: 'H-800', name: 'Grommet', unit_price_milli: 500, on_hand: 500 },
  { sku: 'E-500', name: 'Panel 60x60', unit_price_milli: 7_000, on_hand: 500 },
  { sku: 'K-950', name: 'Cap nut', unit_price_milli: 3_330, on_hand: 500 },
  { sku: 'G-700', name: 'Cable tie 100', unit_price_milli: 1_005, on_hand: 500 },
];

export function milliToUnits(milli: number): number {
  return milli / 1000;
}

export function centsToUnits(cents: number): number {
  return cents / 100;
}

/** Rounds a thousandths amount to cents, ties away from zero. */
export function roundHalfUpToCents(milli: number): number {
  const q = Math.floor(milli / 10);
  const r = milli - q * 10;
  return r >= 5 ? q + 1 : q;
}
