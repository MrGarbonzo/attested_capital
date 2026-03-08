// Re-export strategy public API
export type {
  Strategy,
  StrategySignal,
  StrategyMeta,
  TradeAction,
  Candle,
  ParamRange,
  HardLimits,
  OpenPosition,
  TradingConfig,
  DailyTradeStats,
} from './types.js';

export {
  CENTS_TO_USDC_UNITS,
  USDC_MINT,
  SOL_MINT,
  SOL_DECIMALS,
  USDC_DECIMALS,
} from './types.js';

export {
  HARD_LIMITS,
  ALLOWED_STRATEGIES,
  isAllowedStrategy,
  clampPositionSize,
  checkDailyLimits,
  validateParams,
} from './hard-limits.js';

export {
  getStrategy,
  getAllStrategies,
  getDefaultParams,
  STRATEGIES,
} from './registry.js';
