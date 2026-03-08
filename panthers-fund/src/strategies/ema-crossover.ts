import { EMA } from 'technicalindicators';
import type { Strategy, Candle, StrategySignal } from './types.js';
import { closePrices } from './helpers.js';

const emaCrossover: Strategy = {
  meta: {
    id: 'ema_crossover',
    name: 'EMA Crossover',
    description: 'Trend following — buy on golden cross, sell on death cross.',
    riskLevel: 'medium',
    bestFor: 'Trending markets (bull or bear)',
    winRate: 0.58,
    avgMonthlyReturn: 0.07,
  },

  paramDefs: {
    fast_ema:      { min: 5, max: 20, default: 12, description: 'Fast EMA period' },
    slow_ema:      { min: 20, max: 50, default: 26, description: 'Slow EMA period' },
    position_size: { min: 5, max: 25, default: 15, description: 'Position size (% of pool)' },
  },

  execute(candles: Candle[], params: Record<string, number>): StrategySignal {
    const prices = closePrices(candles);
    const fastPeriod = params.fast_ema ?? 12;
    const slowPeriod = params.slow_ema ?? 26;
    const size = params.position_size ?? 15;

    if (prices.length < slowPeriod + 2) {
      return { action: 'hold', reason: `Not enough data (need ${slowPeriod + 2} candles)` };
    }

    const fastEMA = EMA.calculate({ values: prices, period: fastPeriod });
    const slowEMA = EMA.calculate({ values: prices, period: slowPeriod });

    if (fastEMA.length < 2 || slowEMA.length < 2) {
      return { action: 'hold', reason: 'EMA calculation returned insufficient values' };
    }

    // Align the arrays — fast EMA is longer, take the tail matching slow EMA length
    const offset = fastEMA.length - slowEMA.length;
    const currentFast = fastEMA[fastEMA.length - 1];
    const currentSlow = slowEMA[slowEMA.length - 1];
    const prevFast = fastEMA[fastEMA.length - 2];
    const prevSlow = slowEMA[slowEMA.length - 2];

    // Golden cross: fast crosses above slow (bullish)
    if (prevFast <= prevSlow && currentFast > currentSlow) {
      return {
        action: 'buy',
        size,
        reason: `Golden cross — fast EMA(${fastPeriod})=${currentFast.toFixed(2)} crossed above slow EMA(${slowPeriod})=${currentSlow.toFixed(2)}`,
      };
    }

    // Death cross: fast crosses below slow (bearish)
    if (prevFast >= prevSlow && currentFast < currentSlow) {
      return {
        action: 'sell',
        size,
        reason: `Death cross — fast EMA(${fastPeriod})=${currentFast.toFixed(2)} crossed below slow EMA(${slowPeriod})=${currentSlow.toFixed(2)}`,
      };
    }

    const trend = currentFast > currentSlow ? 'bullish' : 'bearish';
    return {
      action: 'hold',
      reason: `EMA trend ${trend} — fast=${currentFast.toFixed(2)}, slow=${currentSlow.toFixed(2)} (no crossover)`,
    };
  },
};

export default emaCrossover;
