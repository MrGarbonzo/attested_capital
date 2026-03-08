import { BollingerBands } from 'technicalindicators';
import type { Strategy, Candle, StrategySignal } from './types.js';
import { closePrices, latestCandle } from './helpers.js';

const bollingerBands: Strategy = {
  meta: {
    id: 'bollinger_bands',
    name: 'Bollinger Bands',
    description: 'Buy at lower band, sell at upper. Mean reversion strategy.',
    riskLevel: 'low',
    bestFor: 'Range-bound markets with clear support/resistance',
    winRate: 0.58,
    avgMonthlyReturn: 0.04,
  },

  paramDefs: {
    period:        { min: 14, max: 28, default: 20, description: 'Bollinger period' },
    std_dev:       { min: 1.5, max: 3.0, default: 2.0, step: 0.1, description: 'Standard deviation multiplier' },
    position_size: { min: 5, max: 15, default: 10, description: 'Position size (% of pool)' },
  },

  execute(candles: Candle[], params: Record<string, number>): StrategySignal {
    const prices = closePrices(candles);
    const period = params.period ?? 20;
    const stdDev = params.std_dev ?? 2.0;
    const size = params.position_size ?? 10;

    if (prices.length < period) {
      return { action: 'hold', reason: `Not enough data (need ${period} candles)` };
    }

    const bb = BollingerBands.calculate({
      values: prices,
      period,
      stdDev,
    });

    if (bb.length === 0) {
      return { action: 'hold', reason: 'Bollinger Bands calculation returned no values' };
    }

    const latest = bb[bb.length - 1];
    const currentPrice = latestCandle(candles).close;

    if (currentPrice < latest.lower) {
      return {
        action: 'buy',
        size,
        reason: `Price $${currentPrice.toFixed(2)} below lower band $${latest.lower.toFixed(2)}`,
      };
    }

    if (currentPrice > latest.upper) {
      return {
        action: 'sell',
        size,
        reason: `Price $${currentPrice.toFixed(2)} above upper band $${latest.upper.toFixed(2)}`,
      };
    }

    return {
      action: 'hold',
      reason: `Price $${currentPrice.toFixed(2)} within bands [$${latest.lower.toFixed(2)}, $${latest.upper.toFixed(2)}]`,
    };
  },
};

export default bollingerBands;
