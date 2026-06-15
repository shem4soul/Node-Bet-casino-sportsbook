import { describe, expect, it } from 'vitest';
import { maskAccount, maskEmail } from '../../src/config/logger';
import { getContext, runWithContext, setContext } from '../../src/lib/requestContext';

describe('log helpers', () => {
  it('masks PII', () => {
    expect(maskEmail('chidi.okafor@example.com')).toBe('ch***@example.com');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
    expect(maskEmail(undefined)).toBeUndefined();
    expect(maskAccount('0123456789')).toBe('******6789');
  });
});

describe('request context', () => {
  it('propagates through async calls and is isolated between requests', async () => {
    const seen: (number | undefined)[] = [];
    const handler = async (id: string, userId: number) =>
      runWithContext({ requestId: id }, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        setContext({ userId });
        await Promise.resolve();
        seen.push(getContext()?.userId);
        return getContext()?.requestId;
      });
    const ids = await Promise.all([handler('a', 1), handler('b', 2), handler('c', 3)]);
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(seen.sort()).toEqual([1, 2, 3]);
    expect(getContext()).toBeUndefined();
  });
});
