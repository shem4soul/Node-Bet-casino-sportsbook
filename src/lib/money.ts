/**
 * Money helpers. All arithmetic on balances happens in integer minor units
 * (kobo for NGN) so that floating-point rounding can never leak into a
 * balance. NUMERIC values arrive from Postgres as strings ("1234.50").
 */

export type MoneyInput = string | number;

/** "1234.56" | 1234.56 -> 123456 (kobo). Rounds half away from zero. */
export function toMinor(amount: MoneyInput): number {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) throw new Error(`Invalid money amount: ${amount}`);
  const minor = Math.round(Math.abs(n) * 100 + 1e-9) * Math.sign(n);
  if (!Number.isSafeInteger(minor)) throw new Error(`Money amount out of range: ${amount}`);
  return minor === 0 ? 0 : minor; // normalise -0
}

/** 123456 -> "1234.56" (string, safe to pass straight into a NUMERIC param). */
export function fromMinor(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error(`Invalid minor amount: ${minor}`);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Normalises any amount to a 2dp string. */
export function money(amount: MoneyInput): string {
  return fromMinor(toMinor(amount));
}

/** True if the amount has at most two decimal places. */
export function hasAtMostTwoDecimals(n: number): boolean {
  return Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
}

/**
 * stake (minor) x decimal odds -> payout (minor), rounded DOWN to the kobo
 * (the operator never pays a fraction of a kobo more than earned).
 */
export function payoutMinor(stakeMinor: number, odds: number): number {
  return Math.floor(stakeMinor * odds + 1e-6);
}

/** Product of decimal odds, kept at full precision. */
export function combineOdds(prices: Array<string | number>): number {
  return prices.reduce<number>((acc, p) => acc * Number(p), 1);
}
