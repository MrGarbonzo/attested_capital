import type { Strategy, Candle, StrategySignal } from './types.js';
import { closePrices, sma } from './helpers.js';

const dcaAccumulator: Strategy = {
  meta: {
    id: 'dca_accumulator',
    name: 'DCA Accumulator',
    description: 'Buy dips systematically. Dollar-cost averaging on downtrends.',
    riskLevel: 'low',
    bestFor: 'Bear markets, accumulation phases',
    winRate: 0.55,
    avgMonthlyReturn: 0.03,
  },

  paramDefs: {
    buy_interval_candles: { min: 3, max: 42, default: 18, description: 'Min candles between buys (at 4h candles, 18 ≈ 3 days)' },
    dip_threshold:        { min: 2, max: 10, default: 5, description: 'Buy when price drops this % below recent average' },
    position_size:        { min: 3, max: 10, default: 5, description: 'Position size (% of pool)' },
  },

  execute(candles: Candle[], params: Record<string, number>): StrategySignal {
    const prices = closePrices(candles);
    const dipThreshold = params.dip_threshold ?? 5;
    const size = params.position_size ?? 5;
    const lookback = 20; // 20-candle moving average as reference

    if (prices.length < lookback) {
      return { action: 'hold', reason: `Not enough data (need ${lookback} candles)` };
    }

    const currentPrice = prices[prices.length - 1];
    const avgPrice = sma(prices, lookback);

    if (isNaN(avgPrice)) {
      return { action: 'hold', reason: 'Could not calculate average price' };
    }

    const dipPct = ((avgPrice - currentPrice) / avgPrice) * 100;

    if (dipPct >= dipThreshold) {
      return {
        action: 'buy',
        size,
        reason: `Price $${currentPrice.toFixed(2)} is ${dipPct.toFixed(1)}% below 20-candle avg $${avgPrice.toFixed(2)}`,
      };
    }

    // DCA never generates sell signals — it only accumulates
    // Selling is left to other strategies or manual action
    return {
      action: 'hold',
      reason: `Price $${currentPrice.toFixed(2)} only ${dipPct.toFixed(1)}% below avg (need ${dipThreshold}%)`,
    };
  },
};

export default dcaAccumulator;
