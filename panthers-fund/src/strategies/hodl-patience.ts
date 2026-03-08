import type { Strategy, Candle, StrategySignal } from './types.js';
import { closePrices } from './helpers.js';

const hodlPatience: Strategy = {
  meta: {
    id: 'hodl_patience',
    name: 'HODL Patience',
    description: 'Buy and hold, minimal trades. Long-term accumulation.',
    riskLevel: 'low',
    bestFor: 'Long-term believers, bull markets',
    winRate: 0.70,
    avgMonthlyReturn: 0.06,
  },

  paramDefs: {
    rebalance_candles: { min: 42, max: 180, default: 84, description: 'Candles between rebalance checks (84 ≈ 14 days at 4h)' },
    buy_threshold:     { min: 10, max: 25, default: 15, description: 'Buy when price drops this % below recent high' },
    position_size:     { min: 10, max: 30, default: 20, description: 'Position size (% of pool)' },
  },

  execute(candles: Candle[], params: Record<string, number>): StrategySignal {
    const prices = closePrices(candles);
    const buyThreshold = params.buy_threshold ?? 15;
    const size = params.position_size ?? 20;

    if (prices.length < 30) {
      return { action: 'hold', reason: 'Not enough data (need 30+ candles)' };
    }

    const currentPrice = prices[prices.length - 1];
    const recentHigh = Math.max(...prices.slice(-Math.min(prices.length, 180)));
    const dropFromHigh = ((recentHigh - currentPrice) / recentHigh) * 100;

    // Buy when price has dropped significantly from recent high
    if (dropFromHigh >= buyThreshold) {
      return {
        action: 'buy',
        size,
        reason: `Price $${currentPrice.toFixed(2)} is ${dropFromHigh.toFixed(1)}% below recent high $${recentHigh.toFixed(2)}`,
      };
    }

    // HODL strategy rarely sells — only on extreme overbought conditions
    // If price is at all-time high territory, take some profit
    const recentLow = Math.min(...prices.slice(-180));
    const riseFromLow = ((currentPrice - recentLow) / recentLow) * 100;
    if (riseFromLow > 50) {
      return {
        action: 'sell',
        size: Math.round(size / 2), // Sell half — HODL mentality
        reason: `Price $${currentPrice.toFixed(2)} is ${riseFromLow.toFixed(1)}% above recent low — take partial profit`,
      };
    }

    return {
      action: 'hold',
      reason: `HODL — price ${dropFromHigh.toFixed(1)}% below high, waiting for ${buyThreshold}% dip to buy`,
    };
  },
};

export default hodlPatience;
