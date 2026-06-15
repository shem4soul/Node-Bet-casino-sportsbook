import { describe, expect, it } from 'vitest';
import { combineOdds, fromMinor, money, payoutMinor, toMinor } from '../../src/lib/money';

describe('money', () => {
  it('converts to and from kobo without float drift', () => {
    expect(toMinor('0.1')).toBe(10);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor('1234.56')).toBe(123456);
    expect(toMinor(-5.005)).toBe(-501);
    expect(fromMinor(123456)).toBe('1234.56');
    expect(fromMinor(-5)).toBe('-0.05');
    expect(fromMinor(0)).toBe('0.00');
    expect(money(19.999)).toBe('20.00');
  });

  it('normalises negative zero', () => {
    expect(Object.is(toMinor(-0.001), 0)).toBe(true);
  });

  it('rejects non-numeric input', () => {
    expect(() => toMinor('abc')).toThrow();
  });

  it('rounds payouts down to the kobo', () => {
    expect(payoutMinor(100_000, 1.75)).toBe(175_000);
    expect(payoutMinor(333, 1.333)).toBe(443); // 443.889 -> 443
    expect(payoutMinor(1000, combineOdds(['1.10', '1.10', '1.10']))).toBe(1331);
  });
});
