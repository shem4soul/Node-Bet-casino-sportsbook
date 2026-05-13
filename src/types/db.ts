import { RowDataPacket, ResultSetHeader } from 'mysql2';

// DECIMAL/NUMERIC columns come back as strings (decimalNumbers: false in
// config/db.ts) to avoid float rounding on money — reflected in these types.

export interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  kyc_status: 'unverified' | 'pending' | 'verified' | 'rejected';
  date_of_birth: string | null;
  status: 'active' | 'suspended' | 'self_excluded' | 'banned';
  self_exclusion_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface WalletRow extends RowDataPacket {
  id: number;
  user_id: number;
  balance: string;
  currency: string;
  created_at: string;
  updated_at: string;
}

export type TransactionType =
  | 'deposit'
  | 'withdrawal'
  | 'bet_stake'
  | 'bet_payout'
  | 'bet_void_refund'
  | 'game_stake'
  | 'game_payout'
  | 'adjustment';

export interface TransactionRow extends RowDataPacket {
  id: number;
  user_id: number;
  type: TransactionType;
  amount: string;
  balance_after: string;
  reference_type: string | null;
  reference_id: number | null;
  note: string | null;
  created_at: string;
}

export interface GameConfig {
  houseEdgePercent?: number;
  symbols?: string[];
  weights?: number[];
  payouts?: Record<string, number>;
}

export interface GameRow extends RowDataPacket {
  id: number;
  slug: string;
  name: string;
  type: 'dice' | 'coinflip' | 'slots' | 'blackjack' | 'roulette';
  rtp_percent: string;
  min_bet: string;
  max_bet: string;
  is_active: number;
  config_json: GameConfig;
  created_at: string;
}

export interface FairnessSeedRow extends RowDataPacket {
  id: number;
  user_id: number;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  nonce: number;
  is_active: number;
  revealed_at: string | null;
  created_at: string;
}

export interface GameRoundRow extends RowDataPacket {
  id: number;
  user_id: number;
  game_id: number;
  fairness_seed_id: number;
  nonce: number;
  stake: string;
  multiplier: string;
  payout: string;
  result_json: Record<string, unknown>;
  outcome: 'win' | 'loss';
  created_at: string;
}

export interface SportRow extends RowDataPacket {
  id: number;
  slug: string;
  name: string;
}

export interface LeagueRow extends RowDataPacket {
  id: number;
  sport_id: number;
  slug: string;
  name: string;
  country: string | null;
}

export type EventStatus = 'scheduled' | 'live' | 'finished' | 'cancelled' | 'postponed';

export interface EventRow extends RowDataPacket {
  id: number;
  league_id: number;
  home_team: string;
  away_team: string;
  start_time: string;
  status: EventStatus;
  home_score: number | null;
  away_score: number | null;
  result_json: Record<string, unknown> | null;
  odds_provider: string | null;
  external_ref: string | null;
  created_at: string;
  league_name?: string;
  sport_name?: string;
}

export type MarketStatus = 'open' | 'suspended' | 'settled' | 'void';

export interface MarketRow extends RowDataPacket {
  id: number;
  event_id: number;
  market_type: string;
  line: string | null;
  status: MarketStatus;
  settled_at: string | null;
  created_at: string;
  odds?: OddsRow[];
}

export type OddsResult = 'pending' | 'won' | 'lost' | 'void';

export interface OddsRow extends RowDataPacket {
  id: number;
  market_id: number;
  selection: string;
  price_decimal: string;
  is_active: number;
  result: OddsResult;
  updated_at: string;
  market_status?: MarketStatus;
  event_id?: number;
}

export type BetSlipStatus = 'pending' | 'won' | 'lost' | 'void' | 'cashed_out';

export interface BetSlipRow extends RowDataPacket {
  id: number;
  user_id: number;
  stake: string;
  bet_type: 'single' | 'multi';
  total_odds: string;
  potential_payout: string;
  status: BetSlipStatus;
  settled_at: string | null;
  created_at: string;
  selections?: BetSelectionRow[];
}

export interface BetSelectionRow extends RowDataPacket {
  id: number;
  bet_slip_id: number;
  odds_id: number;
  event_id: number;
  selection: string;
  price_decimal_at_placement: string;
  result: OddsResult;
  user_id?: number;
  home_team?: string;
  away_team?: string;
}

export type PaymentIntentStatus = 'pending' | 'success' | 'failed' | 'abandoned';

export interface PaymentIntentRow extends RowDataPacket {
  id: number;
  user_id: number;
  provider: string;
  reference: string;
  amount: string;
  currency: string;
  status: PaymentIntentStatus;
  gateway_response: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookEventRow extends RowDataPacket {
  id: number;
  provider: string;
  reference: string;
  event_type: string;
  payload_json: Record<string, unknown>;
  received_at: string;
}

export type InsertResult = ResultSetHeader;
