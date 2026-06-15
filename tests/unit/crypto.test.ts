import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import * as pf from '../../src/lib/provablyFair';
import { computeSignature, isValidSignature } from '../../src/integrations/paystack/paystackClient';
import { bookingCode, paymentReference } from '../../src/lib/tokens';

describe('provably fair', () => {
  it('is deterministic and verifiable from revealed seeds', () => {
    const seed = pf.generateServerSeed();
    expect(pf.hashServerSeed(seed)).toBe(crypto.createHash('sha256').update(seed).digest('hex'));
    expect(pf.rollDice(seed, 'client', 7)).toBe(pf.rollDice(seed, 'client', 7));
    expect(pf.rollDice(seed, 'client', 7)).not.toBe(pf.rollDice(seed, 'client', 8));
  });

  it('dice rolls stay within [0, 99.99]', () => {
    const seed = pf.generateServerSeed();
    for (let i = 0; i < 2000; i += 1) {
      const r = pf.rollDice(seed, 'c', i);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(100);
    }
  });

  it('coin flip is roughly fair', () => {
    const seed = pf.generateServerSeed();
    let heads = 0;
    for (let i = 0; i < 10_000; i += 1) if (pf.flipCoin(seed, 'c', i)) heads += 1;
    expect(heads).toBeGreaterThan(4700);
    expect(heads).toBeLessThan(5300);
  });
});

describe('Paystack webhook signature', () => {
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'x' } }));
  it('accepts a correct HMAC-SHA512', () => {
    expect(isValidSignature(body, computeSignature(body, 'sk'), 'sk')).toBe(true);
  });
  it('rejects tampered bodies, wrong keys and missing headers', () => {
    const sig = computeSignature(body, 'sk');
    expect(isValidSignature(Buffer.from(body.toString() + ' '), sig, 'sk')).toBe(false);
    expect(isValidSignature(body, sig, 'other')).toBe(false);
    expect(isValidSignature(body, undefined, 'sk')).toBe(false);
    expect(isValidSignature(body, 'abc', 'sk')).toBe(false);
  });
});

describe('references', () => {
  it('payment references satisfy Paystack constraints', () => {
    const r = paymentReference('wd');
    expect(r).toMatch(/^[a-z0-9_-]{16,50}$/);
  });
  it('booking codes avoid ambiguous characters', () => {
    for (let i = 0; i < 200; i += 1) expect(bookingCode()).toMatch(/^[A-HJ-NP-Z2-9]{7}$/);
  });
});
