import { RSI, BollingerBands } from 'technicalindicators';
import type { Strategy, Candle, StrategySignal } from './types.js';
import { closePrices, latestCandle } from './helpers.js';

const scalping: Strategy = {
  meta: {
    id: 'scalping',
    name: 'Quick Scalp',
    description: 'Fast trades on small moves. High frequency trading.',
    riskLevel: 'high',
    bestFor: 'High volatility, active monitoring',
    winRate: 0.53,
    avgMonthlyReturn: 0.10,
  },

  paramDefs: {
    profit_target: { min: 0.5, max: 2, default: 1, step: 0.1, description: 'Profit target (%)' },
    stop_loss:     { min: 0.3, max: 1, default: 0.5, step: 0.1, description: 'Stop loss (%)' },
    position_size: { min: 15, max: 30, default: 25, description: 'Position size (% of pool)' },
  },

  execute(candles: Candle[], params: Record<string, number>): StrategySignal {
    const prices = closePrices(candles);
    const size = params.position_size ?? 25;

    if (prices.length < 20) {
      return { action: 'hold', reason: 'Not enough data (need 20+ candles)' };
    }

    // Scalping uses RSI + Bollinger Bands for quick entries
    const rsi = RSI.calculate({ values: prices, period: 7 }); // shorter period for quick signals
    const bb = BollingerBands.calculate({ values: prices, period: 10, stdDev: 1.5 });

    if (rsi.length === 0 || bb.length === 0) {
      return { action: 'hold', reason: 'Indicator calculation failed' };
    }

    const currentRSI = rsi[rsi.length - 1];
    const latestBB = bb[bb.length - 1];
    const currentPrice = latestCandle(candles).close;

    // Quick scalp buy: RSI oversold AND price at/below lower Bollinger band
    if (currentRSI < 25 && currentPrice <= latestBB.lower * 1.005) {
      return {
        action: 'buy',
        size,
        reason: `Scalp buy — RSI=${currentRSI.toFixed(1)}, price near lower BB $${latestBB.lower.toFixed(2)}`,
      };
    }

    // Quick scalp sell: RSI overbought AND price at/above upper Bollinger band
    if (currentRSI > 75 && currentPrice >= latestBB.upper * 0.995) {
      return {
        action: 'sell',
        size,
        reason: `Scalp sell — RSI=${currentRSI.toFixed(1)}, price near upper BB $${latestBB.upper.toFixed(2)}`,
      };
    }

    // Also check for strong momentum using recent price change
    const recentPrices = prices.slice(-5);
    const pctChange = ((recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices[0]) * 100;

    if (pctChange < -2 && currentRSI < 35) {
      return {
        action: 'buy',
        size,
        reason: `Scalp momentum buy — ${pctChange.toFixed(1)}% drop, RSI=${currentRSI.toFixed(1)}`,
      };
    }

    if (pctChange > 2 && currentRSI > 65) {
      return {
        action: 'sell',
        size,
        reason: `Scalp momentum sell — +${pctChange.toFixed(1)}% rise, RSI=${currentRSI.toFixed(1)}`,
      };
    }

    return {
      action: 'hold',
      reason: `Scalp — no clear entry (RSI=${currentRSI.toFixed(1)}, change=${pctChange.toFixed(1)}%)`,
    };
  },
};

export default scalping;
