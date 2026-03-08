import { MACD } from 'technicalindicators';
import type { Strategy, Candle, StrategySignal } from './types.js';
import { closePrices } from './helpers.js';

const macdMomentum: Strategy = {
  meta: {
    id: 'macd_momentum',
    name: 'MACD Momentum',
    description: 'Buy on momentum shifts. Catches trend changes early.',
    riskLevel: 'medium',
    bestFor: 'Volatile markets with clear momentum',
    winRate: 0.56,
    avgMonthlyReturn: 0.06,
  },

  paramDefs: {
    fast_period:   { min: 8, max: 15, default: 12, description: 'MACD fast EMA period' },
    slow_period:   { min: 20, max: 30, default: 26, description: 'MACD slow EMA period' },
    signal_period: { min: 7, max: 12, default: 9, description: 'MACD signal line period' },
    position_size: { min: 5, max: 20, default: 12, description: 'Position size (% of pool)' },
  },

  execute(candles: Candle[], params: Record<string, number>): StrategySignal {
    const prices = closePrices(candles);
    const fastPeriod = params.fast_period ?? 12;
    const slowPeriod = params.slow_period ?? 26;
    const signalPeriod = params.signal_period ?? 9;
    const size = params.position_size ?? 12;

    if (prices.length < slowPeriod + signalPeriod) {
      return { action: 'hold', reason: `Not enough data (need ${slowPeriod + signalPeriod} candles)` };
    }

    const macdResult = MACD.calculate({
      values: prices,
      fastPeriod,
      slowPeriod,
      signalPeriod,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });

    if (macdResult.length < 2) {
      return { action: 'hold', reason: 'MACD calculation returned insufficient values' };
    }

    const current = macdResult[macdResult.length - 1];
    const prev = macdResult[macdResult.length - 2];

    if (current.MACD === undefined || current.signal === undefined ||
        prev.MACD === undefined || prev.signal === undefined) {
      return { action: 'hold', reason: 'MACD values not yet available' };
    }

    const currentHistogram = current.MACD - current.signal;
    const prevHistogram = prev.MACD - prev.signal;

    // Bullish crossover: MACD crosses above signal line
    if (prevHistogram <= 0 && currentHistogram > 0) {
      return {
        action: 'buy',
        size,
        reason: `MACD bullish crossover — MACD=${current.MACD.toFixed(2)}, signal=${current.signal.toFixed(2)}`,
      };
    }

    // Bearish crossover: MACD crosses below signal line
    if (prevHistogram >= 0 && currentHistogram < 0) {
      return {
        action: 'sell',
        size,
        reason: `MACD bearish crossover — MACD=${current.MACD.toFixed(2)}, signal=${current.signal.toFixed(2)}`,
      };
    }

    const trend = currentHistogram > 0 ? 'bullish' : 'bearish';
    return {
      action: 'hold',
      reason: `MACD ${trend} — histogram=${currentHistogram.toFixed(4)} (no crossover)`,
    };
  },
};

export default macdMomentum;
