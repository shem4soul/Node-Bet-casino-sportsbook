import http from 'http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/config/db';
import { syncLeagues } from '../../src/services/oddsSyncService';
import { resetDb } from '../helpers/testApp';

/** Fake odds-api.io v3 serving the documented response shapes. */
let server: http.Server;
let homePrice = '2.10';
const inTwoDays = new Date(Date.now() + 2 * 86400_000).toISOString();

beforeAll(async () => {
  const app = express();
  app.get('/events', (req, res) => {
    if (req.query.apiKey !== 'test-odds-key') return res.status(401).json({ error: 'bad key' });
    if (req.query.league !== 'nigeria-npfl') return res.json([]);
    res.json([
      { id: 9001, home: 'Enyimba', away: 'Kano Pillars', date: inTwoDays, status: 'pending', league: { slug: 'nigeria-npfl' } },
      { id: 9002, home: 'Remo Stars', away: 'Rangers International', date: inTwoDays, status: 'pending', league: { slug: 'nigeria-npfl' } },
    ]);
  });
  app.get('/odds/multi', (req, res) => {
    const ids = String(req.query.eventIds).split(',');
    res.json(
      ids.map((id) => ({
        id: Number(id),
        bookmakers: {
          Bet365: [
            { name: 'ML', odds: [{ home: homePrice, draw: '3.20', away: '3.50' }] },
            { name: 'Totals', odds: [{ hdp: 2.5, over: '2.00', under: '1.80' }] },
            { name: 'Both Teams To Score', odds: [{ yes: '1.90', no: '1.85' }] },
          ],
          Pinnacle: [{ name: 'ML', odds: [{ home: '2.30', draw: '3.00', away: '3.30' }] }],
        },
      }))
    );
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(45998, '127.0.0.1', r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(async () => {
  await resetDb();
  homePrice = '2.10';
});

describe('odds feed sync', () => {
  it('imports NPFL fixtures with averaged prices, and re-sync updates without duplicating', async () => {
    const [summary] = await syncLeagues(['npfl']);
    expect(summary).toMatchObject({ league: 'npfl', eventsSeen: 2, eventsCreated: 2, marketsCreated: 6, errors: [] });

    const odds = await pool.query(
      `SELECT e.home_team, m.market_type, m.line, o.selection, o.price_decimal
       FROM odds o JOIN markets m ON m.id = o.market_id JOIN events e ON e.id = m.event_id
       WHERE e.external_ref = '9001' ORDER BY m.market_type, o.selection`
    );
    const price = (t: string, s: string) => odds.rows.find((r) => r.market_type === t && r.selection === s)?.price_decimal;
    expect(price('1X2', 'HOME')).toBe('2.200'); // average of 2.10 and 2.30
    expect(price('OVER_UNDER', 'OVER')).toBe('2.000');
    expect(price('BTTS', 'NO')).toBe('1.850');

    homePrice = '2.50';
    const [again] = await syncLeagues(['npfl']);
    expect(again).toMatchObject({ eventsCreated: 0, marketsCreated: 0 });
    const updated = await pool.query(
      `SELECT o.price_decimal FROM odds o JOIN markets m ON m.id = o.market_id JOIN events e ON e.id = m.event_id
       WHERE e.external_ref = '9001' AND m.market_type = '1X2' AND o.selection = 'HOME'`
    );
    expect(updated.rows[0].price_decimal).toBe('2.400');
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM events')).rows[0].n).toBe(2);
  });

  it('never reprices or reopens events after kick-off', async () => {
    await syncLeagues(['npfl']);
    await pool.query(`UPDATE events SET start_time = now() - interval '5 minutes', status = 'live'`);
    homePrice = '9.00';
    await syncLeagues(['npfl']);
    const r = await pool.query(
      `SELECT DISTINCT o.price_decimal FROM odds o JOIN markets m ON m.id = o.market_id WHERE m.market_type = '1X2' AND o.selection = 'HOME'`
    );
    expect(r.rows).toEqual([{ price_decimal: '2.200' }]);
  });
});
