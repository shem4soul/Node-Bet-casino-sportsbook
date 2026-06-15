import { describe, expect, it } from 'vitest';
import { aggregate, collectQuotes, normalizeEvent } from '../../src/integrations/oddsApi/normalize';

describe('normalizeEvent', () => {
  it('handles the documented v3 shape', () => {
    const e = normalizeEvent({
      id: 123456,
      home: 'Manchester United',
      away: 'Liverpool',
      date: '2026-11-01T15:00:00Z',
      status: 'pending',
      league: { name: 'Premier League', slug: 'england-premier-league' },
    });
    expect(e).toMatchObject({
      externalId: '123456',
      home: 'Manchester United',
      away: 'Liverpool',
      status: 'scheduled',
      leagueSlug: 'england-premier-league',
    });
    expect(e!.startTime.toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });

  it('handles the legacy SDK shape with scores', () => {
    const e = normalizeEvent({
      id: 'abc',
      homeParticipant: { name: 'Enyimba' },
      awayParticipant: { name: 'Kano Pillars' },
      startTime: '2026-11-01T16:00:00Z',
      status: 'finished',
      score: { home: 2, away: 1 },
    });
    expect(e).toMatchObject({ externalId: 'abc', status: 'finished', score: { home: 2, away: 1 } });
  });

  it('returns null for incomplete events', () => {
    expect(normalizeEvent({ id: 1, home: 'A' })).toBeNull();
  });
});

describe('collectQuotes + aggregate', () => {
  const payload = {
    id: 1,
    home: 'Real Madrid',
    away: 'Barcelona',
    bookmakers: {
      Bet365: [
        { name: 'ML', odds: [{ home: '2.10', draw: '3.40', away: '3.20' }] },
        {
          name: 'Totals',
          odds: [
            { hdp: 2.5, over: '1.85', under: '1.95' },
            { hdp: 2.25, over: '1.7', under: '2.1' },
          ],
        },
        { name: 'Both Teams To Score', odds: [{ yes: '1.70', no: '2.05' }] },
      ],
      Pinnacle: [{ name: 'ML', odds: [{ home: '2.20', draw: '3.30', away: '3.30' }] }],
    },
  };

  it('maps markets and skips quarter lines', () => {
    const q = collectQuotes(payload);
    expect([...q.keys()].sort()).toEqual(['1X2|', 'BTTS|', 'OVER_UNDER|2.5']);
    expect(q.get('1X2|')!.quotes).toHaveLength(2);
  });

  it('filters by bookmaker', () => {
    const q = collectQuotes(payload, ['pinnacle']);
    expect([...q.keys()]).toEqual(['1X2|']);
  });

  it('aggregates best / average / first and applies margin', () => {
    const quotes = collectQuotes(payload).get('1X2|')!.quotes;
    expect(aggregate(quotes, 'best', 0)).toEqual({ HOME: 2.2, DRAW: 3.4, AWAY: 3.3 });
    expect(aggregate(quotes, 'average', 0)).toEqual({ HOME: 2.15, DRAW: 3.35, AWAY: 3.25 });
    expect(aggregate(quotes, 'first', 10)).toEqual({ HOME: 1.99, DRAW: 3.16, AWAY: 2.98 });
  });
});
