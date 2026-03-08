/**
 * Trading strategy types for Panthers Fund.
 * All monetary values are INTEGER CENTS ($50.00 = 5000).
 */

// ── Candle / Price Data ────────────────────────────────────────

export interface Candle {
  timestamp: number;  // Unix ms
  open: number;       // USD float (e.g. 145.32)
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ── Strategy Signal ────────────────────────────────────────────

export type TradeAction = 'buy' | 'sell' | 'hold';

export interface StrategySignal {
  action: TradeAction;
  /** Position size as percentage of pool (e.g. 15 = 15%). Only set when action !== 'hold'. */
  size?: number;
  /** Human-readable reason for the signal. */
  reason: string;
}

// ── Strategy Parameters ────────────────────────────────────────

export interface ParamRange {
  min: number;
  max: number;
  default: number;
  step?: number;
  description: string;
}

export interface StrategyMeta {
  id: string;
  name: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high';
  bestFor: string;
  winRate: number;       // backtested, e.g. 0.62
  avgMonthlyReturn: number; // e.g. 0.05 = 5%
}

// ── Strategy Interface ─────────────────────────────────────────

export interface Strategy {
  meta: StrategyMeta;
  /** Parameter definitions with ranges and defaults. */
  paramDefs: Record<string, ParamRange>;
  /**
   * Execute strategy logic against price data.
   * @param candles  Recent OHLCV candles (oldest → newest).
   * @param params   Current parameter values (within validated ranges).
   * @returns        A signal: buy/sell/hold with optional size and reason.
   */
  execute(candles: Candle[], params: Record<string, number>): StrategySignal;
}

// ── Hard Limits ────────────────────────────────────────────────

export interface HardLimits {
  maxPositionSize: number;  // % of pool (30)
  minPositionSize: number;  // % of pool (5)
  stopLossFloor: number;    // % (3)
  maxDailyTrades: number;   // 10
  dailyLossLimit: number;   // % of pool (10)
}

// ── Open Position ──────────────────────────────────────────────

export interface OpenPosition {
  id?: number;
  pair: string;              // 'SOL/USDC'
  direction: 'long' | 'short';
  entry_price_usd: number;   // USD float at time of entry
  amount_cents: number;       // position size in INTEGER CENTS
  token_amount_raw: string;   // actual token received (e.g. lamports)
  entry_signature: string;    // on-chain tx signature
  strategy: string;           // strategy that opened this
  opened_at?: string;
}

// ── Trading Config ─────────────────────────────────────────────

export interface TradingConfig {
  activeStrategy: string;
  parameters: Record<string, number>;
  lastUpdated: number;  // Unix ms
}

// ── Daily Trade Stats ──────────────────────────────────────────

export interface DailyTradeStats {
  date: string;         // 'YYYY-MM-DD'
  tradeCount: number;
  totalPnlCents: number;
}

// ── Conversion Constants ───────────────────────────────────────

/** 1 cent = 10,000 USDC on-chain units (USDC has 6 decimals). */
export const CENTS_TO_USDC_UNITS = 10_000;

/** USDC token mint on Solana mainnet. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** SOL native mint. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** SOL decimals. */
export const SOL_DECIMALS = 9;

/** USDC decimals. */
export const USDC_DECIMALS = 6;
