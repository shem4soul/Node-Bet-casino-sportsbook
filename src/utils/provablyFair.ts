import crypto from 'crypto';

/**
 * Provably-fair helpers.
 *
 * Flow:
 *  1. Server generates a random `serverSeed` and shows the user only its
 *     SHA-256 hash (`serverSeedHash`) before any bets are placed.
 *  2. User supplies (or is assigned) a `clientSeed`.
 *  3. Each bet increments a `nonce`.
 *  4. The outcome is derived from HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`).
 *  5. When the user rotates seeds, the old `serverSeed` is revealed so they
 *     can independently verify every past round against its stored hash.
 */

export function generateServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashServerSeed(serverSeed: string): string {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

/** Returns a float in [0, 1) derived deterministically from the seeds/nonce. */
export function deriveFloat(serverSeed: string, clientSeed: string, nonce: number): number {
  const hmac = crypto
    .createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');

  // Use the first 8 hex chars (32 bits) for a uniform float in [0, 1)
  const intVal = parseInt(hmac.slice(0, 8), 16);
  return intVal / 0xffffffff;
}

/** Dice roll result in [0, 100) with 2 decimal places. */
export function rollDice(serverSeed: string, clientSeed: string, nonce: number): number {
  const f = deriveFloat(serverSeed, clientSeed, nonce);
  return Math.round(f * 10000) / 100; // 0.00 - 99.99
}

/** Coin flip: true = heads. */
export function flipCoin(serverSeed: string, clientSeed: string, nonce: number): boolean {
  return deriveFloat(serverSeed, clientSeed, nonce) < 0.5;
}

/**
 * Weighted symbol pick for slot reels, using successive slices of the hash
 * (one nonce derivation per reel position) so reels stay independent.
 */
export function pickWeightedSymbol(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  reelIndex: number,
  symbols: string[],
  weights: number[]
): string {
  const f = deriveFloat(serverSeed, `${clientSeed}:${reelIndex}`, nonce);
  const total = weights.reduce((a, b) => a + b, 0);
  let threshold = f * total;
  for (let i = 0; i < symbols.length; i += 1) {
    threshold -= weights[i];
    if (threshold <= 0) return symbols[i];
  }
  return symbols[symbols.length - 1];
}
