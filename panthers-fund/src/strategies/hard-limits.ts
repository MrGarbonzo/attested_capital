/**
 * Hard safety limits — cannot be voted away or bypassed.
 */
import type { HardLimits, DailyTradeStats } from './types.js';

export const HARD_LIMITS: HardLimits = {
  maxPositionSize: 30,   // No trade > 30% of pool
  minPositionSize: 5,    // No trade < 5% of pool
  stopLossFloor: 3,      // Must have >= 3% stop loss
  maxDailyTrades: 10,    // Max 10 trades per day
  dailyLossLimit: 10,    // Pause if 10% daily loss
};

/** Allowed strategy IDs (only these 10 can be activated). */
export const ALLOWED_STRATEGIES = [
  'rsi_mean_reversion',
  'bollinger_bands',
  'dca_accumulator',
  'hodl_patience',
  'ema_crossover',
  'supertrend',
  'macd_momentum',
  'multi_timeframe',
  'scalping',
  'breakout_trader',
] as const;

export type AllowedStrategyId = (typeof ALLOWED_STRATEGIES)[number];

export function isAllowedStrategy(id: string): id is AllowedStrategyId {
  return (ALLOWED_STRATEGIES as readonly string[]).includes(id);
}

/**
 * Clamp a position size percentage to the hard limits.
 * Returns the clamped value or throws if it's wildly out of range.
 */
export function clampPositionSize(sizePct: number): number {
  return Math.max(HARD_LIMITS.minPositionSize, Math.min(HARD_LIMITS.maxPositionSize, sizePct));
}

/**
 * Check whether a new trade is allowed given today's stats.
 * Governance overrides can tighten (not loosen) the hard limits.
 * Returns { allowed, reason }.
 */
export function checkDailyLimits(
  dailyStats: DailyTradeStats,
  poolBalanceCents: number,
  governanceOverrides?: Record<string, number>,
): { allowed: boolean; reason?: string } {
  // Governance can tighten limits (lower maxDailyTrades, lower dailyLossLimit)
  const maxTrades = governanceOverrides?.maxDailyTrades !== undefined
    ? Math.min(governanceOverrides.maxDailyTrades, HARD_LIMITS.maxDailyTrades)
    : HARD_LIMITS.maxDailyTrades;
  const lossLimit = governanceOverrides?.dailyLossLimit !== undefined
    ? Math.min(governanceOverrides.dailyLossLimit, HARD_LIMITS.dailyLossLimit)
    : HARD_LIMITS.dailyLossLimit;

  if (dailyStats.tradeCount >= maxTrades) {
    return { allowed: false, reason: `Daily trade limit reached (${maxTrades})` };
  }

  if (poolBalanceCents > 0) {
    const dailyLossPct = Math.abs(dailyStats.totalPnlCents) / poolBalanceCents * 100;
    if (dailyStats.totalPnlCents < 0 && dailyLossPct >= lossLimit) {
      return {
        allowed: false,
        reason: `Daily loss limit breached: ${dailyLossPct.toFixed(1)}% >= ${lossLimit}%`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Validate that a strategy's parameters are within their defined ranges.
 */
export function validateParams(
  params: Record<string, number>,
  paramDefs: Record<string, { min: number; max: number }>,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const def = paramDefs[key];
    if (!def) continue;
    if (value < def.min || value > def.max) {
      violations.push(`${key}: ${value} outside range [${def.min}, ${def.max}]`);
    }
  }
  return { valid: violations.length === 0, violations };
}
