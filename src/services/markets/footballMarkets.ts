/**
 * Football market catalogue + deterministic settlement engine.
 *
 * Every supported market declares its valid selections and a pure function
 * that decides a selection's result from the final (and, where needed,
 * half-time) score. Being pure and table-driven makes it trivial to unit
 * test exhaustively — which matters, because a wrong settlement pays out
 * real money.
 */

export type LegResult = 'won' | 'lost' | 'void';

export interface Score {
  home: number;
  away: number;
  htHome?: number | null;
  htAway?: number | null;
}

export interface MarketDefinition {
  type: string;
  name: string;
  /** Whether the market requires a numeric line (e.g. 2.5 goals). */
  requiresLine: boolean;
  /** Validates a line value, returning an error message if invalid. */
  validateLine?: (line: number) => string | null;
  /** Fixed selection set, or a validator for open-ended ones (correct score). */
  selections: readonly string[] | ((selection: string) => boolean);
  needsHalfTime?: boolean;
  /**
   * Returns the result for one selection. `allSelections` is the full set
   * offered in the market (needed for CORRECT_SCORE's "OTHER").
   */
  settle: (selection: string, score: Score, line: number | null, allSelections: string[]) => LegResult;
}

const outcome = (home: number, away: number) => (home > away ? 'HOME' : home < away ? 'AWAY' : 'DRAW');
const wl = (cond: boolean): LegResult => (cond ? 'won' : 'lost');
const isHalfOrWholeLine = (line: number) => Number.isInteger(line * 2);
const CORRECT_SCORE_RE = /^(\d{1,2})-(\d{1,2})$/;

export const FOOTBALL_MARKETS: Record<string, MarketDefinition> = {
  '1X2': {
    type: '1X2',
    name: 'Match Result (1X2)',
    requiresLine: false,
    selections: ['HOME', 'DRAW', 'AWAY'],
    settle: (sel, s) => wl(outcome(s.home, s.away) === sel),
  },

  DOUBLE_CHANCE: {
    type: 'DOUBLE_CHANCE',
    name: 'Double Chance',
    requiresLine: false,
    selections: ['HOME_OR_DRAW', 'HOME_OR_AWAY', 'DRAW_OR_AWAY'],
    settle: (sel, s) => wl(sel.split('_OR_').includes(outcome(s.home, s.away))),
  },

  DRAW_NO_BET: {
    type: 'DRAW_NO_BET',
    name: 'Draw No Bet',
    requiresLine: false,
    selections: ['HOME', 'AWAY'],
    settle: (sel, s) => {
      const o = outcome(s.home, s.away);
      return o === 'DRAW' ? 'void' : wl(o === sel);
    },
  },

  OVER_UNDER: {
    type: 'OVER_UNDER',
    name: 'Total Goals Over/Under',
    requiresLine: true,
    validateLine: (l) =>
      l > 0 && l < 20 && isHalfOrWholeLine(l) ? null : 'Over/Under line must be a positive whole or half number (e.g. 2.5)',
    selections: ['OVER', 'UNDER'],
    settle: (sel, s, line) => {
      const total = s.home + s.away;
      if (total === line) return 'void'; // whole-number line push
      return wl(sel === 'OVER' ? total > line! : total < line!);
    },
  },

  BTTS: {
    type: 'BTTS',
    name: 'Both Teams To Score',
    requiresLine: false,
    selections: ['YES', 'NO'],
    settle: (sel, s) => wl((s.home > 0 && s.away > 0) === (sel === 'YES')),
  },

  ODD_EVEN: {
    type: 'ODD_EVEN',
    name: 'Total Goals Odd/Even',
    requiresLine: false,
    selections: ['ODD', 'EVEN'],
    settle: (sel, s) => wl(((s.home + s.away) % 2 === 1) === (sel === 'ODD')),
  },

  HT_1X2: {
    type: 'HT_1X2',
    name: 'Half-Time Result',
    requiresLine: false,
    needsHalfTime: true,
    selections: ['HOME', 'DRAW', 'AWAY'],
    settle: (sel, s) => wl(outcome(s.htHome!, s.htAway!) === sel),
  },

  HT_FT: {
    type: 'HT_FT',
    name: 'Half-Time / Full-Time',
    requiresLine: false,
    needsHalfTime: true,
    selections: ['HOME/HOME', 'HOME/DRAW', 'HOME/AWAY', 'DRAW/HOME', 'DRAW/DRAW', 'DRAW/AWAY', 'AWAY/HOME', 'AWAY/DRAW', 'AWAY/AWAY'],
    settle: (sel, s) => wl(sel === `${outcome(s.htHome!, s.htAway!)}/${outcome(s.home, s.away)}`),
  },

  CORRECT_SCORE: {
    type: 'CORRECT_SCORE',
    name: 'Correct Score',
    requiresLine: false,
    selections: (sel) => sel === 'OTHER' || CORRECT_SCORE_RE.test(sel),
    settle: (sel, s, _line, all) => {
      const actual = `${s.home}-${s.away}`;
      if (sel === 'OTHER') return wl(!all.includes(actual));
      return wl(sel === actual);
    },
  },

  /**
   * Asian handicap on half and whole lines only (quarter lines, which split
   * the stake, are deliberately not supported). `line` is the HOME handicap:
   * -1.5 means home must win by 2+. A whole-line tie on the adjusted score
   * is a push (void).
   */
  ASIAN_HANDICAP: {
    type: 'ASIAN_HANDICAP',
    name: 'Asian Handicap',
    requiresLine: true,
    validateLine: (l) =>
      Math.abs(l) <= 10 && isHalfOrWholeLine(l) ? null : 'Handicap line must be a whole or half number between -10 and 10',
    selections: ['HOME', 'AWAY'],
    settle: (sel, s, line) => {
      const diff = s.home + line! - s.away;
      if (diff === 0) return 'void';
      return wl(sel === 'HOME' ? diff > 0 : diff < 0);
    },
  },

  HOME_OVER_UNDER: {
    type: 'HOME_OVER_UNDER',
    name: 'Home Team Goals Over/Under',
    requiresLine: true,
    validateLine: (l) => (l > 0 && l < 15 && isHalfOrWholeLine(l) ? null : 'Line must be a positive whole or half number'),
    selections: ['OVER', 'UNDER'],
    settle: (sel, s, line) => (s.home === line ? 'void' : wl(sel === 'OVER' ? s.home > line! : s.home < line!)),
  },

  AWAY_OVER_UNDER: {
    type: 'AWAY_OVER_UNDER',
    name: 'Away Team Goals Over/Under',
    requiresLine: true,
    validateLine: (l) => (l > 0 && l < 15 && isHalfOrWholeLine(l) ? null : 'Line must be a positive whole or half number'),
    selections: ['OVER', 'UNDER'],
    settle: (sel, s, line) => (s.away === line ? 'void' : wl(sel === 'OVER' ? s.away > line! : s.away < line!)),
  },
};

export function getMarketDefinition(type: string): MarketDefinition | undefined {
  return FOOTBALL_MARKETS[type];
}

export function isValidSelection(def: MarketDefinition, selection: string): boolean {
  return typeof def.selections === 'function' ? def.selections(selection) : def.selections.includes(selection);
}

/** Returns an error message if the market/line/selections combination is invalid. */
export function validateMarketShape(type: string, line: number | null, selections: string[]): string | null {
  const def = getMarketDefinition(type);
  if (!def) return null; // custom markets are allowed but must be settled manually
  if (def.requiresLine && line === null) return `${type} requires a line`;
  if (!def.requiresLine && line !== null) return `${type} does not take a line`;
  if (line !== null && def.validateLine) {
    const e = def.validateLine(line);
    if (e) return e;
  }
  const bad = selections.filter((s) => !isValidSelection(def, s));
  if (bad.length) return `Invalid selection(s) for ${type}: ${bad.join(', ')}`;
  return null;
}

export type MarketSettlement = { ok: true; results: Record<string, LegResult> } | { ok: false; reason: string };

/** Settles every selection of a market from a final score, or explains why it can't. */
export function settleMarketFromScore(type: string, line: number | null, selections: string[], score: Score): MarketSettlement {
  const def = getMarketDefinition(type);
  if (!def) return { ok: false, reason: `Unsupported market type ${type} — settle manually` };
  if (def.needsHalfTime && (score.htHome == null || score.htAway == null)) {
    return { ok: false, reason: `${type} needs the half-time score` };
  }
  const shapeError = validateMarketShape(type, line, selections);
  if (shapeError) return { ok: false, reason: shapeError };

  const results: Record<string, LegResult> = {};
  for (const sel of selections) results[sel] = def.settle(sel, score, line, selections);
  return { ok: true, results };
}

export function listMarketDefinitions() {
  return Object.values(FOOTBALL_MARKETS).map((d) => ({
    type: d.type,
    name: d.name,
    requiresLine: d.requiresLine,
    needsHalfTime: Boolean(d.needsHalfTime),
    selections: typeof d.selections === 'function' ? 'score like "2-1", or "OTHER"' : d.selections,
  }));
}
