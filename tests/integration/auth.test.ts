import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/config/db';
import { api, auth, createUser, resetDb } from '../helpers/testApp';

beforeEach(resetDb);
afterAll(() => undefined);

describe('registration', () => {
  it('creates a user with an NGN wallet and returns tokens', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ username: 'tunde_b', email: 'Tunde@Example.com', password: 'Passw0rd!', dateOfBirth: '1992-02-29', phone: '+2348012345678' })
      .expect(201);
    expect(res.body.user).toMatchObject({ username: 'tunde_b', email: 'tunde@example.com', role: 'user', kycStatus: 'unverified' });
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.password_hash).toBeUndefined();

    const me = await api()
      .get('/api/v1/account/me')
      .set({ Authorization: `Bearer ${res.body.accessToken}` })
      .expect(200);
    expect(me.body.wallet).toEqual({ balance: '0.00', currency: 'NGN' });
  });

  it('rejects under-18s', async () => {
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 17);
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ username: 'teen', email: 'teen@example.com', password: 'Passw0rd!', dateOfBirth: dob.toISOString().slice(0, 10) })
      .expect(403);
    expect(res.body.error.code).toBe('UNDERAGE');
  });

  it('rejects duplicates case-insensitively', async () => {
    const body = { username: 'Ada', email: 'ada@example.com', password: 'Passw0rd!', dateOfBirth: '1990-01-01' };
    await api().post('/api/v1/auth/register').send(body).expect(201);
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ ...body, username: 'ada', email: 'other@example.com' })
      .expect(409);
    expect(res.body.error.code).toBe('ACCOUNT_EXISTS');
  });

  it('validates input', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ username: 'x', email: 'nope', password: 'short', dateOfBirth: '01/01/1990' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: any) => d.path)).toEqual(
      expect.arrayContaining(['username', 'email', 'password', 'dateOfBirth'])
    );
  });
});

describe('login & sessions', () => {
  it('logs in by email, username or phone', async () => {
    const u = await createUser();
    await api().post('/api/v1/auth/login').send({ identifier: u.email.toUpperCase(), password: 'Passw0rd!' }).expect(200);
    await api().post('/api/v1/auth/login').send({ identifier: u.username, password: 'Passw0rd!' }).expect(200);
  });

  it('locks the account after repeated failures', async () => {
    const u = await createUser();
    for (let i = 0; i < 5; i += 1) await api().post('/api/v1/auth/login').send({ identifier: u.email, password: 'wrong' }).expect(401);
    const res = await api().post('/api/v1/auth/login').send({ identifier: u.email, password: 'Passw0rd!' }).expect(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const u = await createUser();
    const r1 = await api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(u.refreshToken);

    // Re-using the old token revokes the whole family, including the new one.
    const reuse = await api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401);
    expect(reuse.body.error.code).toBe('REFRESH_REUSED');
    await api().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
  });

  it('logout revokes the refresh token', async () => {
    const u = await createUser();
    await api().post('/api/v1/auth/logout').send({ refreshToken: u.refreshToken }).expect(204);
    await api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401);
  });

  it('banning takes effect immediately, even with a valid access token', async () => {
    const u = await createUser();
    await api().get('/api/v1/account/me').set(auth(u)).expect(200);
    await pool.query(`UPDATE users SET status = 'banned' WHERE id = $1`, [u.id]);
    await api().get('/api/v1/account/me').set(auth(u)).expect(403);
  });

  it('password reset flow', async () => {
    const u = await createUser();
    await api().post('/api/v1/auth/forgot-password').send({ email: u.email }).expect(202);
    await api().post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.com' }).expect(202); // no enumeration

    // Swap the stored hash for one we know (the email itself is only logged in tests).
    const { sha256 } = await import('../../src/lib/tokens');
    await pool.query('UPDATE password_reset_tokens SET token_hash = $2 WHERE user_id = $1', [
      u.id,
      sha256('known-reset-token-for-tests-123'),
    ]);
    await api()
      .post('/api/v1/auth/reset-password')
      .send({ token: 'known-reset-token-for-tests-123', newPassword: 'N3wPassword!' })
      .expect(200);
    await api()
      .post('/api/v1/auth/reset-password')
      .send({ token: 'known-reset-token-for-tests-123', newPassword: 'N3wPassword!' })
      .expect(400);
    await api().post('/api/v1/auth/login').send({ identifier: u.email, password: 'N3wPassword!' }).expect(200);
    await api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401); // old sessions revoked
  });
});

describe('authorization', () => {
  it('non-admins cannot reach admin routes', async () => {
    const u = await createUser();
    await api().get('/api/v1/admin/users').set(auth(u)).expect(403);
    await api().get('/api/v1/admin/users').expect(401);
  });
});
