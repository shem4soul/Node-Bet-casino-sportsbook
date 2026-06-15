// Row shapes as returned by `pg`. NUMERIC columns arrive as strings (money
// safety); BIGINT ids are parsed to numbers (see config/db.ts).

export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended' | 'banned' | 'closed';
export type KycStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

export interface UserRow {
  id: number;
  username: string;
  email: string;
  phone: string | null;
  password_hash: string;
  first_name: string | null;
  last_name: string | null;
  role: UserRole;
  kyc_status: KycStatus;
  date_of_birth: string;
  status: UserStatus;
  self_exclusion_until: Date | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WalletRow {
  id: number;
  user_id: number;
  balance: string;
  currency: string;
  created_at: Date;
  updated_at: Date;
}

export type TransactionType =
  | 'deposit'
  | 'withdrawal'
  | 'withdrawal_reversal'
  | 'bet_stake'
  | 'bet_payout'
  | 'bet_void_refund'
  | 'bet_cashout'
  | 'game_stake'
  | 'game_payout'
  | 'adjustment';

export interface TransactionRow {
  id: number;
  user_id: number;
  type: TransactionType;
  amount: string;
  balance_after: string;
  reference_type: string | null;
  reference_id: number | null;
  note: string | null;
  created_at: Date;
}

export type PaymentIntentStatus = 'pending' | 'success' | 'failed' | 'abandoned';

export interface PaymentIntentRow {
  id: number;
  user_id: number;
  provider: string;
  reference: string;
  amount: string;
  currency: string;
  status: PaymentIntentStatus;
  access_code: string | null;
  authorization_url: string | null;
  channel: string | null;
  gateway_response: Record<string, unknown> | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface BankAccountRow {
  id: number;
  user_id: number;
  bank_code: string;
  bank_name: string;
  account_number: string;
  account_name: string;
  recipient_code: string;
  is_default: boolean;
  deleted_at: Date | null;
  created_at: Date;
}

export type WithdrawalStatus = 'pending_review' | 'approved' | 'processing' | 'success' | 'failed' | 'reversed' | 'rejected';

export interface WithdrawalRow {
  id: number;
  user_id: number;
  bank_account_id: number;
  amount: string;
  currency: string;
  status: WithdrawalStatus;
  reference: string;
  transfer_code: string | null;
  failure_reason: string | null;
  reviewed_by: number | null;
  reviewed_at: Date | null;
  gateway_response: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export type LimitPeriod = 'daily' | 'weekly' | 'monthly';

export interface DepositLimitRow {
  id: number;
  user_id: number;
  period: LimitPeriod;
  amount_limit: string | null;
  pending_amount_limit: string | null;
  pending_effective_at: Date | null;
  pending_removal: boolean;
  updated_at: Date;
}

export interface GameConfig {
  houseEdgePercent?: number;
  symbols?: string[];
  weights?: number[];
  payouts?: Record<string, number>;
}

export interface GameRow {
  id: number;
  slug: string;
  name: string;
  type: 'dice' | 'coinflip' | 'slots';
  rtp_percent: string;
  min_bet: string;
  max_bet: string;
  is_active: boolean;
  config: GameConfig;
  created_at: Date;
}

export interface FairnessSeedRow {
  id: number;
  user_id: number;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  nonce: number;
  is_active: boolean;
  revealed_at: Date | null;
  created_at: Date;
}

export interface SportRow {
  id: number;
  slug: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}

export interface LeagueRow {
  id: number;
  sport_id: number;
  slug: string;
  name: string;
  short_name: string | null;
  country: string | null;
  country_code: string | null;
  provider_slug: string | null;
  sync_enabled: boolean;
  is_featured: boolean;
  is_active: boolean;
  sort_order: number;
}

export type EventStatus = 'scheduled' | 'live' | 'finished' | 'cancelled' | 'postponed';

export interface EventRow {
  id: number;
  league_id: number;
  home_team: string;
  away_team: string;
  start_time: Date;
  status: EventStatus;
  home_score: number | null;
  away_score: number | null;
  ht_home_score: number | null;
  ht_away_score: number | null;
  is_featured: boolean;
  odds_provider: string | null;
  external_ref: string | null;
  settled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type MarketStatus = 'open' | 'suspended' | 'settled' | 'void';

export interface MarketRow {
  id: number;
  event_id: number;
  market_type: string;
  line: string | null;
  status: MarketStatus;
  settled_at: Date | null;
  created_at: Date;
}

export type SelectionResult = 'pending' | 'won' | 'lost' | 'void';

export interface OddsRow {
  id: number;
  market_id: number;
  selection: string;
  price_decimal: string;
  is_active: boolean;
  result: SelectionResult;
  updated_at: Date;
}

export type BetSlipStatus = 'pending' | 'won' | 'lost' | 'void' | 'cashed_out';

export interface BetSlipRow {
  id: number;
  user_id: number;
  stake: string;
  bet_type: 'single' | 'multi';
  total_odds: string;
  potential_payout: string;
  payout: string | null;
  status: BetSlipStatus;
  idempotency_key: string | null;
  booking_code: string | null;
  settled_at: Date | null;
  created_at: Date;
}

export interface BetSelectionRow {
  id: number;
  bet_slip_id: number;
  odds_id: number;
  market_id: number;
  event_id: number;
  market_type: string;
  line: string | null;
  selection: string;
  price_decimal_at_placement: string;
  result: SelectionResult;
}
