/**
 * Strategy registry — maps strategy IDs to implementations.
 * Only the 10 allowed strategies are registered.
 */
import type { Strategy } from './types.js';
import { ALLOWED_STRATEGIES, isAllowedStrategy } from './hard-limits.js';

import rsiMeanReversion from './rsi-mean-reversion.js';
import bollingerBands from './bollinger-bands.js';
import dcaAccumulator from './dca-accumulator.js';
import hodlPatience from './hodl-patience.js';
import emaCrossover from './ema-crossover.js';
import supertrendStrategy from './supertrend.js';
import macdMomentum from './macd-momentum.js';
import multiTimeframe from './multi-timeframe.js';
import scalping from './scalping.js';
import breakoutTrader from './breakout-trader.js';

const STRATEGIES: Record<string, Strategy> = {
  rsi_mean_reversion: rsiMeanReversion,
  bollinger_bands: bollingerBands,
  dca_accumulator: dcaAccumulator,
  hodl_patience: hodlPatience,
  ema_crossover: emaCrossover,
  supertrend: supertrendStrategy,
  macd_momentum: macdMomentum,
  multi_timeframe: multiTimeframe,
  scalping: scalping,
  breakout_trader: breakoutTrader,
};

/**
 * Get a strategy by ID. Throws if not found or not allowed.
 */
export function getStrategy(id: string): Strategy {
  if (!isAllowedStrategy(id)) {
    throw new Error(`Strategy '${id}' is not an allowed strategy. Allowed: ${ALLOWED_STRATEGIES.join(', ')}`);
  }
  const strategy = STRATEGIES[id];
  if (!strategy) {
    throw new Error(`Strategy '${id}' not implemented`);
  }
  return strategy;
}

/**
 * Get all registered strategies.
 */
export function getAllStrategies(): Strategy[] {
  return Object.values(STRATEGIES);
}

/**
 * Get default parameters for a strategy.
 */
export function getDefaultParams(id: string): Record<string, number> {
  const strategy = getStrategy(id);
  const params: Record<string, number> = {};
  for (const [key, def] of Object.entries(strategy.paramDefs)) {
    params[key] = def.default;
  }
  return params;
}

export { STRATEGIES };
