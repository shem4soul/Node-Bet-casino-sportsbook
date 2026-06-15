/**
 * Idempotent seed: reference data that every environment needs, plus
 * optional demo fixtures.
 *
 *   npm run db:seed                         reference data (+ admin if ADMIN_* set)
 *   SEED_DEMO_DATA=true npm run db:seed     also creates sample fixtures with odds
 *
 * Safe to run repeatedly: everything is upserted.
 */
import { pool, withTransaction } from '../config/db';
import { hashPassword } from '../lib/password';
import { PoolClient } from 'pg';

interface LeagueSeed {
  slug: string;
  name: string;
  shortName: string;
  country: string;
  countryCode: string | null;
  providerSlug: string;
  featured: boolean;
  sortOrder: number;
}

/**
 * The three headline competitions are featured. `providerSlug` is the
 * league id at odds-api.io; verify them for your plan with
 * GET /api/v1/admin/odds-provider/leagues?sport=football and update via
 * PATCH /api/v1/admin/leagues/:id if the provider uses a different id.
 */
export const LEAGUES: LeagueSeed[] = [
  {
    slug: 'premier-league',
    name: 'English Premier League',
    shortName: 'EPL',
    country: 'England',
    countryCode: 'GB',
    providerSlug: 'england-premier-league',
    featured: true,
    sortOrder: 1,
  },
  {
    slug: 'la-liga',
    name: 'LaLiga',
    shortName: 'La Liga',
    country: 'Spain',
    countryCode: 'ES',
    providerSlug: 'spain-laliga',
    featured: true,
    sortOrder: 2,
  },
  {
    slug: 'npfl',
    name: 'Nigeria Premier Football League',
    shortName: 'NPFL',
    country: 'Nigeria',
    countryCode: 'NG',
    providerSlug: 'nigeria-npfl',
    featured: true,
    sortOrder: 3,
  },
  {
    slug: 'serie-a',
    name: 'Serie A',
    shortName: 'Serie A',
    country: 'Italy',
    countryCode: 'IT',
    providerSlug: 'italy-serie-a',
    featured: false,
    sortOrder: 4,
  },
  {
    slug: 'bundesliga',
    name: 'Bundesliga',
    shortName: 'Bundesliga',
    country: 'Germany',
    countryCode: 'DE',
    providerSlug: 'germany-bundesliga',
    featured: false,
    sortOrder: 5,
  },
  {
    slug: 'ligue-1',
    name: 'Ligue 1',
    shortName: 'Ligue 1',
    country: 'France',
    countryCode: 'FR',
    providerSlug: 'france-ligue-1',
    featured: false,
    sortOrder: 6,
  },
  {
    slug: 'champions-league',
    name: 'UEFA Champions League',
    shortName: 'UCL',
    country: 'Europe',
    countryCode: null,
    providerSlug: 'international-clubs-uefa-champions-league',
    featured: false,
    sortOrder: 7,
  },
  {
    slug: 'championship',
    name: 'EFL Championship',
    shortName: 'Championship',
    country: 'England',
    countryCode: 'GB',
    providerSlug: 'england-championship',
    featured: false,
    sortOrder: 8,
  },
];

async function seedGames(c: PoolClient) {
  const games = [
    { slug: 'dice', name: 'Dice', type: 'dice', rtp: 98, min: 50, max: 500_000, config: { houseEdgePercent: 2 } },
    { slug: 'coinflip', name: 'Coin Flip', type: 'coinflip', rtp: 98, min: 50, max: 500_000, config: { houseEdgePercent: 2 } },
    {
      slug: 'slots-classic',
      name: 'Classic Slots',
      type: 'slots',
      rtp: 96,
      min: 20,
      max: 100_000,
      config: {
        symbols: ['CHERRY', 'LEMON', 'BELL', 'STAR', 'SEVEN'],
        weights: [40, 30, 15, 10, 5],
        payouts: { CHERRY: 2, LEMON: 3, BELL: 5, STAR: 10, SEVEN: 50 },
      },
    },
  ];
  for (const g of games) {
    await c.query(
      `INSERT INTO games (slug, name, type, rtp_percent, min_bet, max_bet, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slug) DO NOTHING`,
      [g.slug, g.name, g.type, g.rtp, g.min, g.max, JSON.stringify(g.config)]
    );
  }
}

async function seedCatalogue(c: PoolClient): Promise<number> {
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO sports (slug, name, sort_order) VALUES ('football', 'Football', 1)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`
  );
  const sportId = rows[0].id;
  for (const l of LEAGUES) {
    await c.query(
      `INSERT INTO leagues (sport_id, slug, name, short_name, country, country_code, provider_slug, is_featured, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (sport_id, slug) DO UPDATE
         SET name = EXCLUDED.name, short_name = EXCLUDED.short_name, country = EXCLUDED.country,
             country_code = EXCLUDED.country_code, sort_order = EXCLUDED.sort_order`,
      [sportId, l.slug, l.name, l.shortName, l.country, l.countryCode, l.providerSlug, l.featured, l.sortOrder]
    );
  }
  return sportId;
}

async function seedAdmin(c: PoolClient) {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('  (skipping admin user — set ADMIN_EMAIL and ADMIN_PASSWORD to create one)');
    return;
  }
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  const username = process.env.ADMIN_USERNAME || 'admin';
  const hash = await hashPassword(password);
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO users (username, email, password_hash, role, kyc_status, date_of_birth)
     VALUES ($1, $2, $3, 'admin', 'verified', '1990-01-01')
     ON CONFLICT ((lower(email))) DO UPDATE SET role = 'admin'
     RETURNING id`,
    [username, email.toLowerCase(), hash]
  );
  await c.query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [rows[0].id]);
  console.log(`  admin user ready: ${email}`);
}

type Price = [selection: string, price: number];
interface MarketSeed {
  type: string;
  line?: number;
  odds: Price[];
}

function footballMarkets(h: number, d: number, a: number): MarketSeed[] {
  const r = (n: number) => Math.max(1.01, Number(n.toFixed(2)));
  return [
    {
      type: '1X2',
      odds: [
        ['HOME', h],
        ['DRAW', d],
        ['AWAY', a],
      ],
    },
    {
      type: 'DOUBLE_CHANCE',
      odds: [
        ['HOME_OR_DRAW', r(((h * d) / (h + d)) * 0.95)],
        ['HOME_OR_AWAY', r(((h * a) / (h + a)) * 0.95)],
        ['DRAW_OR_AWAY', r(((d * a) / (d + a)) * 0.95)],
      ],
    },
    {
      type: 'DRAW_NO_BET',
      odds: [
        ['HOME', r(h * 0.72)],
        ['AWAY', r(a * 0.72)],
      ],
    },
    {
      type: 'OVER_UNDER',
      line: 1.5,
      odds: [
        ['OVER', 1.3],
        ['UNDER', 3.4],
      ],
    },
    {
      type: 'OVER_UNDER',
      line: 2.5,
      odds: [
        ['OVER', 1.9],
        ['UNDER', 1.9],
      ],
    },
    {
      type: 'OVER_UNDER',
      line: 3.5,
      odds: [
        ['OVER', 3.1],
        ['UNDER', 1.36],
      ],
    },
    {
      type: 'BTTS',
      odds: [
        ['YES', 1.8],
        ['NO', 1.95],
      ],
    },
    {
      type: 'HT_1X2',
      odds: [
        ['HOME', r(h + 0.8)],
        ['DRAW', 2.1],
        ['AWAY', r(a + 0.9)],
      ],
    },
    {
      type: 'ODD_EVEN',
      odds: [
        ['ODD', 1.9],
        ['EVEN', 1.9],
      ],
    },
    {
      type: 'CORRECT_SCORE',
      odds: [
        ['1-0', 7.5],
        ['2-0', 9.5],
        ['2-1', 8.5],
        ['0-0', 10],
        ['1-1', 6.5],
        ['0-1', 11],
        ['1-2', 13],
        ['OTHER', 4.5],
      ],
    },
  ];
}

async function seedDemoFixtures(c: PoolClient) {
  const fixtures: { league: string; home: string; away: string; inHours: number; prices: [number, number, number] }[] = [
    { league: 'premier-league', home: 'Arsenal', away: 'Chelsea', inHours: 26, prices: [1.95, 3.6, 3.9] },
    { league: 'premier-league', home: 'Manchester City', away: 'Liverpool', inHours: 50, prices: [2.05, 3.7, 3.4] },
    { league: 'premier-league', home: 'Manchester United', away: 'Tottenham Hotspur', inHours: 74, prices: [2.3, 3.5, 3.0] },
    { league: 'la-liga', home: 'Real Madrid', away: 'Barcelona', inHours: 30, prices: [2.2, 3.8, 3.1] },
    { league: 'la-liga', home: 'Atletico Madrid', away: 'Sevilla', inHours: 54, prices: [1.7, 3.6, 5.2] },
    { league: 'npfl', home: 'Enyimba', away: 'Kano Pillars', inHours: 28, prices: [1.75, 3.2, 4.8] },
    { league: 'npfl', home: 'Rangers International', away: 'Remo Stars', inHours: 52, prices: [2.1, 3.0, 3.6] },
    { league: 'npfl', home: 'Rivers United', away: 'Shooting Stars', inHours: 76, prices: [1.85, 3.1, 4.3] },
  ];

  for (const f of fixtures) {
    const league = await c.query<{ id: number }>('SELECT id FROM leagues WHERE slug = $1', [f.league]);
    if (!league.rows[0]) continue;
    const exists = await c.query(
      `SELECT 1 FROM events WHERE league_id = $1 AND home_team = $2 AND away_team = $3 AND status = 'scheduled'`,
      [league.rows[0].id, f.home, f.away]
    );
    if (exists.rowCount) continue;

    const ev = await c.query<{ id: number }>(
      `INSERT INTO events (league_id, home_team, away_team, start_time, is_featured, odds_provider, external_ref)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4), true, 'demo', gen_random_uuid()::text)
       RETURNING id`,
      [league.rows[0].id, f.home, f.away, f.inHours]
    );
    for (const m of footballMarkets(...f.prices)) {
      const mk = await c.query<{ id: number }>('INSERT INTO markets (event_id, market_type, line) VALUES ($1, $2, $3) RETURNING id', [
        ev.rows[0].id,
        m.type,
        m.line ?? null,
      ]);
      for (const [sel, price] of m.odds) {
        await c.query('INSERT INTO odds (market_id, selection, price_decimal) VALUES ($1, $2, $3)', [mk.rows[0].id, sel, price]);
      }
    }
  }
  console.log(`  demo fixtures ready (${fixtures.length})`);
}

export async function runSeed({ demo = process.env.SEED_DEMO_DATA === 'true' } = {}) {
  await withTransaction(async (c) => {
    console.log('→ seeding reference data');
    await seedGames(c);
    await seedCatalogue(c);
    await seedAdmin(c);
    if (demo) await seedDemoFixtures(c);
  });
  console.log('✔ seed complete');
}

if (require.main === module) {
  runSeed()
    .catch((err) => {
      console.error('✖ seed failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
