import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/config/db';
import { closeStartedEvents } from '../../src/jobs/scheduler';
import { api, assertLedgerConsistent, auth, balanceOf, createFixture, createUser, kickOff, resetDb, TestUser } from '../helpers/testApp';

let admin: TestUser;
beforeEach(async () => {
  await resetDb();
  admin = await createUser({ admin: true });
});

const bet = (u: TestUser, stake: number, oddsIds: number[], extra: object = {}) =>
  api()
    .post('/api/v1/sports/bets')
    .set(auth(u))
    .send({ stake, selections: oddsIds.map((oddsId) => ({ oddsId })), ...extra });

const result = (eventId: number, homeScore: number, awayScore: number, ht?: [number, number]) =>
  api()
    .post(`/api/v1/admin/events/${eventId}/result`)
    .set(auth(admin))
    .send({ homeScore, awayScore, ...(ht ? { htHomeScore: ht[0], htAwayScore: ht[1] } : {}) });

describe('catalogue', () => {
  it('serves EPL, La Liga and NPFL as featured leagues', async () => {
    const res = await api().get('/api/v1/sports/leagues?featured=true').expect(200);
    expect(res.body.map((l: any) => l.slug)).toEqual(['premier-league', 'la-liga', 'npfl']);
  });

  it('lists events with inline 1X2 prices and full market detail', async () => {
    const fx = await createFixture(admin, 'Enyimba', 'Kano Pillars', 'npfl');
    const list = await api().get('/api/v1/sports/leagues/npfl/events').expect(200);
    expect(list.body[0]).toMatchObject({ home_team: 'Enyimba', league_slug: 'npfl', open_markets: 6 });
    expect(list.body[0].main_odds.map((o: any) => o.selection)).toEqual(['HOME', 'DRAW', 'AWAY']);

    const detail = await api().get(`/api/v1/sports/events/${fx.eventId}`).expect(200);
    expect(detail.body.markets.map((m: any) => m.type)).toEqual(['1X2', 'DRAW_NO_BET', 'OVER_UNDER', 'BTTS', 'HT_1X2', 'CORRECT_SCORE']);
  });

  it('rejects malformed markets from admins', async () => {
    const fx = await createFixture(admin);
    const res = await api()
      .post(`/api/v1/admin/events/${fx.eventId}/markets`)
      .set(auth(admin))
      .send({
        type: 'OVER_UNDER',
        line: 2.25,
        odds: [
          { selection: 'OVER', price: 1.9 },
          { selection: 'UNDER', price: 1.9 },
        ],
      })
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_MARKET');
  });
});

describe('placing bets', () => {
  it('single bet debits the stake and records the slip', async () => {
    const u = await createUser({ balance: 10_000 });
    const fx = await createFixture(admin);
    const res = await bet(u, 1000, [fx.odds['1X2:HOME']]).expect(201);
    expect(res.body).toMatchObject({
      betType: 'single',
      stake: '1000.00',
      totalOdds: '2.000',
      potentialPayout: '2000.00',
      status: 'pending',
    });
    expect(await balanceOf(u.id)).toBe('9000.00');
  });

  it('accumulator across leagues multiplies odds', async () => {
    const u = await createUser({ balance: 10_000 });
    const a = await createFixture(admin, 'Arsenal', 'Chelsea');
    const b = await createFixture(admin, 'Real Madrid', 'Barcelona', 'la-liga');
    const c = await createFixture(admin, 'Rivers United', 'Shooting Stars', 'npfl');
    const res = await bet(u, 500, [a.odds['1X2:HOME'], b.odds['OVER_UNDER:2.5:OVER'], c.odds['BTTS:YES']]).expect(201);
    expect(res.body).toMatchObject({ betType: 'multi', totalOdds: '6.840', potentialPayout: '3420.00' });
  });

  it('rejects insufficient funds, below-minimum stakes and same-match legs', async () => {
    const u = await createUser({ balance: 500 });
    const fx = await createFixture(admin);
    expect((await bet(u, 1000, [fx.odds['1X2:HOME']]).expect(400)).body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect((await bet(u, 50, [fx.odds['1X2:HOME']]).expect(400)).body.error.code).toBe('STAKE_TOO_LOW');
    expect((await bet(u, 100, [fx.odds['1X2:HOME'], fx.odds['BTTS:YES']]).expect(400)).body.error.code).toBe('SAME_EVENT_SELECTIONS');
    expect(await balanceOf(u.id)).toBe('500.00');
  });

  it('rejects bets once the match has kicked off, even before the close job runs', async () => {
    const u = await createUser({ balance: 5000 });
    const fx = await createFixture(admin);
    await pool.query(`UPDATE events SET start_time = now() - interval '1 minute' WHERE id = $1`, [fx.eventId]);
    expect((await bet(u, 100, [fx.odds['1X2:HOME']]).expect(409)).body.error.code).toBe('SELECTIONS_UNAVAILABLE');

    const closed = await closeStartedEvents();
    expect(closed.events).toBe(1);
    const m = await pool.query(`SELECT DISTINCT status FROM markets WHERE event_id = $1`, [fx.eventId]);
    expect(m.rows).toEqual([{ status: 'suspended' }]);
  });

  it('handles odds movement according to acceptOddsChanges', async () => {
    const u = await createUser({ balance: 5000 });
    const fx = await createFixture(admin);
    const id = fx.odds['1X2:HOME'];
    await api().patch(`/api/v1/admin/odds/${id}`).set(auth(admin)).send({ price: 2.2 }).expect(200);

    const send = (policy: string) =>
      api()
        .post('/api/v1/sports/bets')
        .set(auth(u))
        .send({ stake: 100, selections: [{ oddsId: id, price: 2.0 }], acceptOddsChanges: policy });
    expect((await send('none').expect(409)).body.error.code).toBe('ODDS_CHANGED');
    expect((await send('higher').expect(201)).body.totalOdds).toBe('2.200'); // price improved

    await api().patch(`/api/v1/admin/odds/${id}`).set(auth(admin)).send({ price: 1.8 }).expect(200);
    await send('higher').expect(409); // price drifted down
    expect((await send('any').expect(201)).body.totalOdds).toBe('1.800');
  });

  it('Idempotency-Key prevents duplicate slips on retry', async () => {
    const u = await createUser({ balance: 5000 });
    const fx = await createFixture(admin);
    const body = { stake: 1000, selections: [{ oddsId: fx.odds['1X2:HOME'] }] };
    const send = () => api().post('/api/v1/sports/bets').set(auth(u)).set('Idempotency-Key', 'k-123').send(body);
    const results = await Promise.all([send(), send(), send()]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await balanceOf(u.id)).toBe('4000.00');
  });

  it('concurrent bets can never overdraw the wallet', async () => {
    const u = await createUser({ balance: 10_000 });
    const fx = await createFixture(admin);
    const res = await Promise.all(Array.from({ length: 6 }, () => bet(u, 3000, [fx.odds['1X2:HOME']])));
    expect(res.filter((r) => r.status === 201)).toHaveLength(3);
    expect(await balanceOf(u.id)).toBe('1000.00');
    await assertLedgerConsistent();
  });
});

describe('settlement from final score', () => {
  it('pays winners, settles losers, voids DNB on a draw, and recomputes multis with void legs', async () => {
    const u = await createUser({ balance: 100_000 });
    const a = await createFixture(admin, 'Arsenal', 'Chelsea'); // will finish 1-1 (HT 0-0)
    const b = await createFixture(admin, 'Real Madrid', 'Barcelona', 'la-liga'); // will finish 2-1 (HT 0-1)

    const s1 = (await bet(u, 1000, [b.odds['1X2:HOME']]).expect(201)).body.id; // 2.0 -> 2000
    const s2 = (await bet(u, 1000, [a.odds['1X2:HOME']]).expect(201)).body.id; // lost
    const s3 = (await bet(u, 1000, [a.odds['DRAW_NO_BET:HOME']]).expect(201)).body.id; // void -> refund 1000
    const s4 = (await bet(u, 1000, [a.odds['DRAW_NO_BET:HOME'], b.odds['OVER_UNDER:2.5:OVER']]).expect(201)).body.id; // void x 1.9 -> 1900
    const s5 = (await bet(u, 1000, [a.odds['BTTS:YES'], b.odds['CORRECT_SCORE:2-1']]).expect(201)).body.id; // 1.8 x 9 -> 16200
    const s6 = (await bet(u, 1000, [b.odds['HT_1X2:AWAY']]).expect(201)).body.id; // 4.5 -> 4500
    expect(await balanceOf(u.id)).toBe('94000.00');

    for (const fx of [a, b]) await kickOff(fx.eventId);
    const ra = await result(a.eventId, 1, 1, [0, 0]).expect(200);
    expect(ra.body.needsManualSettlement).toEqual([]);
    await result(b.eventId, 2, 1, [0, 1]).expect(200);

    const status = async (id: number) => (await api().get(`/api/v1/sports/bets/${id}`).set(auth(u))).body;
    expect(await status(s1)).toMatchObject({ status: 'won', payout: '2000.00' });
    expect(await status(s2)).toMatchObject({ status: 'lost', payout: '0.00' });
    expect(await status(s3)).toMatchObject({ status: 'void', payout: '1000.00' });
    expect(await status(s4)).toMatchObject({ status: 'won', payout: '1900.00' });
    expect(await status(s5)).toMatchObject({ status: 'won', payout: '16200.00' });
    expect(await status(s6)).toMatchObject({ status: 'won', payout: '4500.00' });

    expect(await balanceOf(u.id)).toBe(String((94_000 + 2000 + 1000 + 1900 + 16_200 + 4500).toFixed(2)));
    await assertLedgerConsistent();

    // Results can't be entered twice.
    await result(a.eventId, 2, 0).expect(409);
  });

  it('a lost leg settles a multi as lost immediately', async () => {
    const u = await createUser({ balance: 5000 });
    const a = await createFixture(admin, 'Arsenal', 'Chelsea');
    const b = await createFixture(admin, 'Real Madrid', 'Barcelona', 'la-liga');
    const id = (await bet(u, 1000, [a.odds['1X2:HOME'], b.odds['1X2:HOME']]).expect(201)).body.id;
    await kickOff(a.eventId);
    await result(a.eventId, 0, 2).expect(200);
    expect((await api().get(`/api/v1/sports/bets/${id}`).set(auth(u))).body.status).toBe('lost');
  });

  it('HT markets wait for manual settlement when no HT score is supplied', async () => {
    const fx = await createFixture(admin);
    await kickOff(fx.eventId);
    const r = await result(fx.eventId, 1, 0).expect(200);
    expect(r.body.needsManualSettlement).toEqual([expect.objectContaining({ type: 'HT_1X2' })]);
    const htMarket = r.body.needsManualSettlement[0].marketId;
    await api().post(`/api/v1/admin/markets/${htMarket}/settle`).set(auth(admin)).send({ winningSelection: 'DRAW' }).expect(200);
  });

  it('refuses results for events that have not started', async () => {
    const fx = await createFixture(admin);
    await result(fx.eventId, 1, 0).expect(409);
  });

  it('cancelling an event refunds singles and recomputes multis', async () => {
    const u = await createUser({ balance: 5000 });
    const a = await createFixture(admin, 'Arsenal', 'Chelsea');
    const b = await createFixture(admin, 'Real Madrid', 'Barcelona', 'la-liga');
    const single = (await bet(u, 1000, [a.odds['1X2:HOME']]).expect(201)).body.id;
    const multi = (await bet(u, 1000, [a.odds['1X2:HOME'], b.odds['1X2:HOME']]).expect(201)).body.id;
    await api()
      .post(`/api/v1/admin/events/${a.eventId}/cancel`)
      .set(auth(admin))
      .send({ reason: 'Match abandoned (floodlight failure)' })
      .expect(200);
    expect((await api().get(`/api/v1/sports/bets/${single}`).set(auth(u))).body).toMatchObject({ status: 'void', payout: '1000.00' });

    await kickOff(b.eventId);
    await result(b.eventId, 3, 0).expect(200);
    expect((await api().get(`/api/v1/sports/bets/${multi}`).set(auth(u))).body).toMatchObject({ status: 'won', payout: '2000.00' });
    await assertLedgerConsistent();
  });
});

describe('cash-out', () => {
  it('quotes and pays fair value minus margin, then ignores later settlement', async () => {
    const u = await createUser({ balance: 5000 });
    const fx = await createFixture(admin);
    const id = (await bet(u, 1000, [fx.odds['1X2:HOME']]).expect(201)).body.id;

    await api().patch(`/api/v1/admin/odds/${fx.odds['1X2:HOME']}`).set(auth(admin)).send({ price: 1.6 }).expect(200);
    const quote = await api().get(`/api/v1/sports/bets/${id}/cashout`).set(auth(u)).expect(200);
    expect(quote.body).toEqual({ betId: id, available: true, amount: '1187.50' }); // 1000*2.0/1.6*0.95

    await api().post(`/api/v1/sports/bets/${id}/cashout`).set(auth(u)).send({ expectedAmount: 1200 }).expect(409); // value dropped below what user accepted
    const done = await api().post(`/api/v1/sports/bets/${id}/cashout`).set(auth(u)).send({ expectedAmount: 1187.5 }).expect(200);
    expect(done.body.balance).toBe('5187.50');
    await api().post(`/api/v1/sports/bets/${id}/cashout`).set(auth(u)).send({}).expect(409);

    await kickOff(fx.eventId);
    await result(fx.eventId, 2, 0).expect(200);
    expect(await balanceOf(u.id)).toBe('5187.50'); // no second payout
    await assertLedgerConsistent();
  });

  it('is unavailable once a leg is suspended', async () => {
    const u = await createUser({ balance: 5000 });
    const fx = await createFixture(admin);
    const id = (await bet(u, 1000, [fx.odds['1X2:HOME']]).expect(201)).body.id;
    const market = (await pool.query('SELECT market_id FROM odds WHERE id = $1', [fx.odds['1X2:HOME']])).rows[0].market_id;
    await api().post(`/api/v1/admin/markets/${market}/suspend`).set(auth(admin)).expect(200);
    const q = await api().get(`/api/v1/sports/bets/${id}/cashout`).set(auth(u)).expect(200);
    expect(q.body.available).toBe(false);
  });
});

describe('booking codes', () => {
  it('round-trips a shareable slip', async () => {
    const a = await createFixture(admin, 'Arsenal', 'Chelsea');
    const b = await createFixture(admin, 'Enyimba', 'Kano Pillars', 'npfl');
    const created = await api()
      .post('/api/v1/sports/booking-codes')
      .send({ oddsIds: [a.odds['1X2:HOME'], b.odds['BTTS:NO']] })
      .expect(201);
    expect(created.body.code).toMatch(/^[A-Z0-9]{7}$/);
    const loaded = await api().get(`/api/v1/sports/booking-codes/${created.body.code.toLowerCase()}`).expect(200);
    expect(loaded.body).toMatchObject({ totalOdds: '4.000' });
    expect(loaded.body.selections).toHaveLength(2);
  });
});

describe('admin reporting', () => {
  it('computes GGR and liability', async () => {
    const u = await createUser({ balance: 10_000 });
    const fx = await createFixture(admin);
    await bet(u, 1000, [fx.odds['1X2:HOME']]).expect(201);
    await bet(u, 2000, [fx.odds['1X2:AWAY']]).expect(201);

    const liab = await api().get(`/api/v1/admin/reports/liability?eventId=${fx.eventId}`).set(auth(admin)).expect(200);
    expect(liab.body.map((r: any) => [r.selection, r.single_liability])).toEqual([
      ['AWAY', '7600.00'],
      ['HOME', '2000.00'],
    ]);

    await kickOff(fx.eventId);
    await result(fx.eventId, 1, 0).expect(200); // HOME wins: pays 2000, keeps 2000
    const rep = await api().get('/api/v1/admin/reports/summary').set(auth(admin)).expect(200);
    expect(rep.body.sportsbook).toEqual({ stakes: '3000.00', payouts: '2000.00', ggr: '1000.00' });

    const logs = await api().get('/api/v1/admin/audit-logs?action=event.result').set(auth(admin)).expect(200);
    expect(logs.body).toHaveLength(1);
  });
});
