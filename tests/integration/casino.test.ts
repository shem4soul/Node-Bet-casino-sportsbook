import crypto from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, assertLedgerConsistent, auth, createUser, resetDb } from '../helpers/testApp';

beforeEach(resetDb);

describe('casino', () => {
  it('plays provably-fair dice and lets the player verify after rotation', async () => {
    const u = await createUser({ balance: 10_000 });
    const fair = await api().get('/api/v1/casino/fairness').set(auth(u)).expect(200);

    const rounds = [];
    for (let i = 0; i < 5; i += 1) {
      rounds.push(
        (await api().post('/api/v1/casino/dice/play').set(auth(u)).send({ stake: 100, target: 50, direction: 'under' }).expect(200)).body
      );
    }
    expect(rounds.map((r) => r.nonce)).toEqual([0, 1, 2, 3, 4]);

    const rot = await api().post('/api/v1/casino/fairness/rotate').set(auth(u)).send({}).expect(200);
    const serverSeed = rot.body.previous.serverSeed;
    expect(crypto.createHash('sha256').update(serverSeed).digest('hex')).toBe(fair.body.serverSeedHash);

    // Independently recompute each roll from the revealed seed.
    for (const r of rounds) {
      const h = crypto.createHmac('sha256', serverSeed).update(`${fair.body.clientSeed}:${r.nonce}`).digest('hex');
      expect(Math.floor((parseInt(h.slice(0, 13), 16) / 2 ** 52) * 10000) / 100).toBe(r.roll);
    }
    await assertLedgerConsistent();
  });

  it('coinflip and slots debit and credit consistently', async () => {
    const u = await createUser({ balance: 10_000 });
    for (let i = 0; i < 10; i += 1) {
      await api().post('/api/v1/casino/coinflip/play').set(auth(u)).send({ stake: 100, call: 'heads' }).expect(200);
      await api().post('/api/v1/casino/slots/play').set(auth(u)).send({ stake: 50 }).expect(200);
    }
    const hist = await api().get('/api/v1/casino/history?limit=50').set(auth(u)).expect(200);
    expect(hist.body).toHaveLength(20);
    await assertLedgerConsistent();
  });
});
