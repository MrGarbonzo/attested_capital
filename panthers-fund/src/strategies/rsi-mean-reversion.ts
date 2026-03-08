import { RSI } from 'technicalindicators';
import type { Strategy, Candle, StrategySignal } from './types.js';
import { closePrices } from './helpers.js';

const rsiMeanReversion: Strategy = {
  meta: {
    id: 'rsi_mean_reversion',
    name: 'RSI Mean Reversion',
    description: 'Buy oversold, sell overbought. Works in sideways markets.',
    riskLevel: 'low',
    bestFor: 'Range-bound, sideways markets',
    winRate: 0.62,
    avgMonthlyReturn: 0.05,
  },

  paramDefs: {
    rsi_period:    { min: 7, max: 21, default: 14, description: 'RSI calculation period' },
    oversold:      { min: 20, max: 35, default: 30, description: 'Oversold threshold (buy signal)' },
    overbought:    { min: 65, max: 80, default: 70, description: 'Overbought threshold (sell signal)' },
    position_size: { min: 5, max: 20, default: 10, description: 'Position size (% of pool)' },
  },

  execute(candles: Candle[], params: Record<string, number>): StrategySignal {
    const prices = closePrices(candles);
    const period = params.rsi_period ?? 14;

    if (prices.length < period + 1) {
      return { action: 'hold', reason: `Not enough data (need ${period + 1} candles, have ${prices.length})` };
    }

    const rsiValues = RSI.calculate({ values: prices, period });
    if (rsiValues.length === 0) {
      return { action: 'hold', reason: 'RSI calculation returned no values' };
    }

    const current = rsiValues[rsiValues.length - 1];
    const oversold = params.oversold ?? 30;
    const overbought = params.overbought ?? 70;
    const size = params.position_size ?? 10;

    if (current < oversold) {
      return {
        action: 'buy',
        size,
        reason: `RSI ${current.toFixed(1)} < ${oversold} (oversold)`,
      };
    }

    if (current > overbought) {
      return {
        action: 'sell',
        size,
        reason: `RSI ${current.toFixed(1)} > ${overbought} (overbought)`,
      };
    }

    return { action: 'hold', reason: `RSI ${current.toFixed(1)} — neutral zone` };
  },
};

export default rsiMeanReversion;
