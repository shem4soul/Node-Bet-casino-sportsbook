import { describe, expect, it } from 'vitest';
import { settleMarketFromScore, validateMarketShape, FOOTBALL_MARKETS } from '../../src/services/markets/footballMarkets';

const settle = (type: string, line: number | null, sels: string[], home: number, away: number, ht?: [number, number]) => {
  const r = settleMarketFromScore(type, line, sels, { home, away, htHome: ht?.[0], htAway: ht?.[1] });
  if (!r.ok) throw new Error(r.reason);
  return r.results;
};

describe('1X2', () => {
  it.each([
    [2, 1, 'HOME'],
    [0, 0, 'DRAW'],
    [1, 3, 'AWAY'],
  ])('%i-%i -> %s wins, others lose', (h, a, winner) => {
    const r = settle('1X2', null, ['HOME', 'DRAW', 'AWAY'], h, a);
    for (const s of ['HOME', 'DRAW', 'AWAY']) expect(r[s]).toBe(s === winner ? 'won' : 'lost');
  });
});

describe('DOUBLE_CHANCE', () => {
  it('home win', () => {
    expect(settle('DOUBLE_CHANCE', null, ['HOME_OR_DRAW', 'HOME_OR_AWAY', 'DRAW_OR_AWAY'], 1, 0)).toEqual({
      HOME_OR_DRAW: 'won',
      HOME_OR_AWAY: 'won',
      DRAW_OR_AWAY: 'lost',
    });
  });
  it('draw', () => {
    expect(settle('DOUBLE_CHANCE', null, ['HOME_OR_DRAW', 'HOME_OR_AWAY', 'DRAW_OR_AWAY'], 2, 2)).toEqual({
      HOME_OR_DRAW: 'won',
      HOME_OR_AWAY: 'lost',
      DRAW_OR_AWAY: 'won',
    });
  });
});

describe('DRAW_NO_BET', () => {
  it('voids on a draw', () => expect(settle('DRAW_NO_BET', null, ['HOME', 'AWAY'], 1, 1)).toEqual({ HOME: 'void', AWAY: 'void' }));
  it('settles normally otherwise', () =>
    expect(settle('DRAW_NO_BET', null, ['HOME', 'AWAY'], 0, 2)).toEqual({ HOME: 'lost', AWAY: 'won' }));
});

describe('OVER_UNDER', () => {
  it.each([
    [2.5, 2, 1, 'won', 'lost'],
    [2.5, 1, 1, 'lost', 'won'],
    [0.5, 0, 0, 'lost', 'won'],
    [3.5, 4, 0, 'won', 'lost'],
  ])('line %d with %i-%i -> OVER %s', (line, h, a, over, under) => {
    expect(settle('OVER_UNDER', line, ['OVER', 'UNDER'], h, a)).toEqual({ OVER: over, UNDER: under });
  });
  it('whole-number line is a push (void) on exact total', () => {
    expect(settle('OVER_UNDER', 3, ['OVER', 'UNDER'], 2, 1)).toEqual({ OVER: 'void', UNDER: 'void' });
  });
  it('rejects quarter lines', () => {
    expect(validateMarketShape('OVER_UNDER', 2.25, ['OVER', 'UNDER'])).toMatch(/whole or half/);
  });
  it('requires a line', () => {
    expect(validateMarketShape('OVER_UNDER', null, ['OVER', 'UNDER'])).toMatch(/requires a line/);
  });
});

describe('BTTS / ODD_EVEN', () => {
  it('BTTS yes when both score', () => expect(settle('BTTS', null, ['YES', 'NO'], 1, 1)).toEqual({ YES: 'won', NO: 'lost' }));
  it('BTTS no on a clean sheet', () => expect(settle('BTTS', null, ['YES', 'NO'], 3, 0)).toEqual({ YES: 'lost', NO: 'won' }));
  it('0-0 is EVEN', () => expect(settle('ODD_EVEN', null, ['ODD', 'EVEN'], 0, 0)).toEqual({ ODD: 'lost', EVEN: 'won' }));
  it('2-1 is ODD', () => expect(settle('ODD_EVEN', null, ['ODD', 'EVEN'], 2, 1)).toEqual({ ODD: 'won', EVEN: 'lost' }));
});

describe('half-time markets', () => {
  it('HT_1X2 needs the HT score', () => {
    const r = settleMarketFromScore('HT_1X2', null, ['HOME', 'DRAW', 'AWAY'], { home: 1, away: 0 });
    expect(r.ok).toBe(false);
  });
  it('HT_1X2 settles from HT score', () => {
    expect(settle('HT_1X2', null, ['HOME', 'DRAW', 'AWAY'], 2, 1, [0, 1])).toEqual({ HOME: 'lost', DRAW: 'lost', AWAY: 'won' });
  });
  it('HT_FT', () => {
    const sels = FOOTBALL_MARKETS.HT_FT.selections as string[];
    const r = settle('HT_FT', null, sels, 2, 1, [0, 1]);
    expect(Object.entries(r).filter(([, v]) => v === 'won')).toEqual([['AWAY/HOME', 'won']]);
  });
});

describe('CORRECT_SCORE', () => {
  const sels = ['1-0', '2-1', '0-0', 'OTHER'];
  it('exact score wins', () =>
    expect(settle('CORRECT_SCORE', null, sels, 2, 1)).toEqual({ '1-0': 'lost', '2-1': 'won', '0-0': 'lost', OTHER: 'lost' }));
  it('OTHER wins when score not offered', () => expect(settle('CORRECT_SCORE', null, sels, 4, 3).OTHER).toBe('won'));
  it('rejects malformed selections', () => expect(validateMarketShape('CORRECT_SCORE', null, ['two-one'])).toMatch(/Invalid selection/));
});

describe('ASIAN_HANDICAP (home line)', () => {
  it('-1.5: home must win by 2', () => {
    expect(settle('ASIAN_HANDICAP', -1.5, ['HOME', 'AWAY'], 2, 0)).toEqual({ HOME: 'won', AWAY: 'lost' });
    expect(settle('ASIAN_HANDICAP', -1.5, ['HOME', 'AWAY'], 2, 1)).toEqual({ HOME: 'lost', AWAY: 'won' });
  });
  it('-1 push when home wins by exactly 1', () => {
    expect(settle('ASIAN_HANDICAP', -1, ['HOME', 'AWAY'], 1, 0)).toEqual({ HOME: 'void', AWAY: 'void' });
  });
  it('+0.5 home covers on a draw', () => {
    expect(settle('ASIAN_HANDICAP', 0.5, ['HOME', 'AWAY'], 1, 1)).toEqual({ HOME: 'won', AWAY: 'lost' });
  });
});

describe('team totals', () => {
  it('HOME_OVER_UNDER', () => expect(settle('HOME_OVER_UNDER', 1.5, ['OVER', 'UNDER'], 2, 0)).toEqual({ OVER: 'won', UNDER: 'lost' }));
  it('AWAY_OVER_UNDER push', () => expect(settle('AWAY_OVER_UNDER', 1, ['OVER', 'UNDER'], 0, 1)).toEqual({ OVER: 'void', UNDER: 'void' }));
});

describe('unknown market types', () => {
  it('cannot be auto-settled', () => {
    const r = settleMarketFromScore('FIRST_GOALSCORER', null, ['SAKA'], { home: 1, away: 0 });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/settle manually/) });
  });
  it('are allowed at creation', () => expect(validateMarketShape('FIRST_GOALSCORER', null, ['SAKA'])).toBeNull());
});
