/**
 * Normalises odds-api.io payloads into our market model. Kept pure (no I/O)
 * so it can be unit tested against recorded payloads.
 *
 * Documented v3 shape:
 *   event: { id, home, away, date, status, league: { slug }, scores? }
 *   odds:  { id, home, away, bookmakers: { "Bet365": [ { name: "ML", odds: [{ home, draw, away }] }, ... ] } }
 * The older SDK-typed shape (homeParticipant/startTime/markets[]) is also accepted.
 */

export interface FeedEvent {
  externalId: string;
  home: string;
  away: string;
  startTime: Date;
  status: 'scheduled' | 'live' | 'finished' | 'cancelled' | 'postponed';
  leagueSlug: string | null;
  score: { home: number; away: number; htHome?: number; htAway?: number } | null;
}

export interface FeedMarket {
  type: string;
  line: number | null;
  prices: Record<string, number>;
}

const STATUS_MAP: Record<string, FeedEvent['status']> = {
  pending: 'scheduled',
  upcoming: 'scheduled',
  scheduled: 'scheduled',
  notstarted: 'scheduled',
  live: 'live',
  inplay: 'live',
  settled: 'finished',
  finished: 'finished',
  ended: 'finished',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  postponed: 'postponed',
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export function normalizeEvent(raw: any): FeedEvent | null {
  if (!raw) return null;
  const externalId = raw.id != null ? String(raw.id) : null;
  const home = raw.home ?? raw.homeParticipant?.name ?? raw.home_team;
  const away = raw.away ?? raw.awayParticipant?.name ?? raw.away_team;
  const date = raw.date ?? raw.startTime ?? raw.commence_time;
  if (!externalId || !home || !away || !date) return null;
  const startTime = new Date(date);
  if (Number.isNaN(startTime.getTime())) return null;

  const status =
    STATUS_MAP[
      String(raw.status ?? 'pending')
        .toLowerCase()
        .replace(/[\s_-]/g, '')
    ] ?? 'scheduled';
  const sc = raw.scores ?? raw.score;
  let score: FeedEvent['score'] = null;
  if (sc && num(sc.home) !== null && num(sc.away) !== null) {
    score = { home: num(sc.home)!, away: num(sc.away)! };
    const ht = sc.periods?.p1 ?? sc.halftime ?? sc.ht;
    if (ht && num(ht.home) !== null && num(ht.away) !== null) {
      score.htHome = num(ht.home)!;
      score.htAway = num(ht.away)!;
    }
  }

  return {
    externalId,
    home: String(home).trim(),
    away: String(away).trim(),
    startTime,
    status,
    leagueSlug: raw.league?.slug ?? raw.leagueId ?? null,
    score,
  };
}

function marketKind(name: string): 'ML' | 'TOTALS' | 'BTTS' | 'DC' | 'DNB' | 'AH' | null {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['ml', '1x2', 'moneyline', 'matchwinner', 'fulltimeresult', 'h2h'].includes(n)) return 'ML';
  if (['totals', 'overunder', 'goalsoverunder', 'totalgoals'].includes(n)) return 'TOTALS';
  if (['bothteamstoscore', 'btts', 'bothteamsscore'].includes(n)) return 'BTTS';
  if (n === 'doublechance') return 'DC';
  if (n === 'drawnobet') return 'DNB';
  if (['spread', 'asianhandicap', 'handicap'].includes(n)) return 'AH';
  return null;
}

/** Converts one bookmaker market entry into zero or more FeedMarkets. */
function convertEntry(kind: NonNullable<ReturnType<typeof marketKind>>, o: any): FeedMarket | null {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = num(o?.[k]);
      if (v !== null) return v;
    }
    return null;
  };
  const line = num(o?.hdp ?? o?.line ?? o?.points ?? o?.handicap);
  const build = (type: string, l: number | null, entries: [string, number | null][]): FeedMarket | null => {
    const prices: Record<string, number> = {};
    for (const [sel, p] of entries) if (p !== null && p >= 1.01) prices[sel] = p;
    return Object.keys(prices).length === entries.length ? { type, line: l, prices } : null;
  };

  switch (kind) {
    case 'ML':
      return build('1X2', null, [
        ['HOME', pick('home', '1')],
        ['DRAW', pick('draw', 'x', 'X')],
        ['AWAY', pick('away', '2')],
      ]);
    case 'TOTALS':
      if (line === null || !Number.isInteger(line * 2)) return null;
      return build('OVER_UNDER', line, [
        ['OVER', pick('over')],
        ['UNDER', pick('under')],
      ]);
    case 'BTTS':
      return build('BTTS', null, [
        ['YES', pick('yes')],
        ['NO', pick('no')],
      ]);
    case 'DC':
      return build('DOUBLE_CHANCE', null, [
        ['HOME_OR_DRAW', pick('1x', '1X', 'homeDraw', 'home_draw')],
        ['HOME_OR_AWAY', pick('12', 'homeAway', 'home_away')],
        ['DRAW_OR_AWAY', pick('x2', 'X2', 'drawAway', 'draw_away')],
      ]);
    case 'DNB':
      return build('DRAW_NO_BET', null, [
        ['HOME', pick('home', '1')],
        ['AWAY', pick('away', '2')],
      ]);
    case 'AH':
      // Quarter lines (e.g. -0.25) split stakes and are not supported.
      if (line === null || !Number.isInteger(line * 2)) return null;
      return build('ASIAN_HANDICAP', line, [
        ['HOME', pick('home')],
        ['AWAY', pick('away')],
      ]);
  }
}

/** Returns, per market key, the list of prices quoted by each bookmaker. */
export function collectQuotes(
  rawOdds: any,
  bookmakerFilter: string[] = []
): Map<string, { type: string; line: number | null; quotes: Record<string, number>[] }> {
  const out = new Map<string, { type: string; line: number | null; quotes: Record<string, number>[] }>();
  const allow = new Set(bookmakerFilter.map((b) => b.toLowerCase()));
  const add = (m: FeedMarket | null) => {
    if (!m) return;
    const key = `${m.type}|${m.line ?? ''}`;
    const entry = out.get(key) ?? { type: m.type, line: m.line, quotes: [] };
    entry.quotes.push(m.prices);
    out.set(key, entry);
  };

  if (rawOdds?.bookmakers && typeof rawOdds.bookmakers === 'object' && !Array.isArray(rawOdds.bookmakers)) {
    for (const [bookmaker, markets] of Object.entries<any>(rawOdds.bookmakers)) {
      if (allow.size && !allow.has(bookmaker.toLowerCase())) continue;
      for (const market of Array.isArray(markets) ? markets : []) {
        const kind = marketKind(String(market?.name ?? ''));
        if (!kind) continue;
        for (const o of Array.isArray(market.odds) ? market.odds : []) add(convertEntry(kind, o));
      }
    }
  } else if (Array.isArray(rawOdds?.markets)) {
    // Legacy SDK-typed shape: { markets: [{ market, marketLine, outcomes: [{ name, odds }] }] }
    const home = String(rawOdds.home ?? '').toLowerCase();
    const away = String(rawOdds.away ?? '').toLowerCase();
    for (const m of rawOdds.markets) {
      const kind = marketKind(String(m.market ?? ''));
      if (!kind) continue;
      const o: Record<string, unknown> = { hdp: m.marketLine };
      for (const oc of m.outcomes ?? []) {
        const n = String(oc.name ?? '').toLowerCase();
        const key = n === home ? 'home' : n === away ? 'away' : n === 'tie' ? 'draw' : n;
        o[key] = oc.odds;
      }
      add(convertEntry(kind, o));
    }
  }
  return out;
}

/** Aggregates bookmaker quotes into one price per selection and applies the operator margin. */
export function aggregate(
  quotes: Record<string, number>[],
  mode: 'best' | 'average' | 'first',
  marginPercent: number
): Record<string, number> {
  const result: Record<string, number> = {};
  const selections = Object.keys(quotes[0] ?? {});
  for (const sel of selections) {
    const values = quotes.map((q) => q[sel]).filter((v): v is number => typeof v === 'number');
    if (!values.length) continue;
    const raw = mode === 'best' ? Math.max(...values) : mode === 'first' ? values[0] : values.reduce((a, b) => a + b, 0) / values.length;
    // Margin shrinks the "profit" part of the price: 1 + (p − 1)(1 − m).
    const adjusted = 1 + (raw - 1) * (1 - marginPercent / 100);
    // +1e-9 guards against binary-float artefacts like (3.4 + 3.3) / 2 = 3.3499999…
    result[sel] = Math.max(1.01, Math.floor(adjusted * 100 + 1e-9) / 100);
  }
  return result;
}
