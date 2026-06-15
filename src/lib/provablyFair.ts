import crypto from 'crypto';

/**
 * Provably-fair helpers.
 *
 *  1. Server generates a random `serverSeed` and shows only its SHA-256 hash.
 *  2. The user supplies (or is assigned) a `clientSeed`.
 *  3. Each round increments a `nonce`.
 *  4. Outcome = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`).
 *  5. Rotating seeds reveals the old serverSeed so past rounds can be verified.
 */

export function generateServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashServerSeed(serverSeed: string): string {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

/** Uniform float in [0, 1) derived deterministically from the seeds/nonce. */
export function deriveFloat(serverSeed: string, clientSeed: string, nonce: number): number {
  const hmac = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  // 52 bits of entropy -> exact double in [0, 1)
  const intVal = parseInt(hmac.slice(0, 13), 16);
  return intVal / 2 ** 52;
}

/** Dice roll in [0.00, 99.99]. */
export function rollDice(serverSeed: string, clientSeed: string, nonce: number): number {
  return Math.floor(deriveFloat(serverSeed, clientSeed, nonce) * 10000) / 100;
}

/** true = heads */
export function flipCoin(serverSeed: string, clientSeed: string, nonce: number): boolean {
  return deriveFloat(serverSeed, clientSeed, nonce) < 0.5;
}

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
    if (threshold < 0) return symbols[i];
  }
  return symbols[symbols.length - 1];
}
