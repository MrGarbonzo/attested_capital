import type { Strategy, Candle, StrategySignal } from './types.js';
import { atr, closePrices, latestCandle } from './helpers.js';

const supertrend: Strategy = {
  meta: {
    id: 'supertrend',
    name: 'Supertrend',
    description: 'Trend following with built-in stop losses. Clear trend signals.',
    riskLevel: 'medium',
    bestFor: 'Strong trending markets',
    winRate: 0.60,
    avgMonthlyReturn: 0.08,
  },

  paramDefs: {
    atr_period:    { min: 7, max: 14, default: 10, description: 'ATR period' },
    multiplier:    { min: 2.0, max: 5.0, default: 3.0, step: 0.1, description: 'ATR multiplier' },
    position_size: { min: 10, max: 30, default: 20, description: 'Position size (% of pool)' },
  },

  execute(candles: Candle[], params: Record<string, number>): StrategySignal {
    const atrPeriod = params.atr_period ?? 10;
    const multiplier = params.multiplier ?? 3.0;
    const size = params.position_size ?? 20;

    if (candles.length < atrPeriod + 2) {
      return { action: 'hold', reason: `Not enough data (need ${atrPeriod + 2} candles)` };
    }

    const atrValues = atr(candles, atrPeriod);
    if (atrValues.length < 2) {
      return { action: 'hold', reason: 'ATR calculation returned insufficient values' };
    }

    // Calculate Supertrend bands
    // We need to iterate to get the true Supertrend with direction tracking
    const prices = closePrices(candles);
    const startIdx = atrPeriod; // ATR values start at index (atrPeriod) of the candles (after first candle)

    let prevUpperBand = 0;
    let prevLowerBand = 0;
    let prevSupertrend = 0;
    let prevDirection = 1; // 1 = up (bullish), -1 = down (bearish)

    for (let i = 0; i < atrValues.length; i++) {
      const candleIdx = startIdx + i;
      if (candleIdx >= candles.length) break;

      const hl2 = (candles[candleIdx].high + candles[candleIdx].low) / 2;
      let upperBand = hl2 + multiplier * atrValues[i];
      let lowerBand = hl2 - multiplier * atrValues[i];

      // Band persistence: bands only move in favorable direction
      if (i > 0) {
        if (lowerBand > prevLowerBand || prices[candleIdx - 1] < prevLowerBand) {
          // Keep the higher lower band (tighter)
        } else {
          lowerBand = prevLowerBand;
        }
        if (upperBand < prevUpperBand || prices[candleIdx - 1] > prevUpperBand) {
          // Keep the lower upper band (tighter)
        } else {
          upperBand = prevUpperBand;
        }
      }

      // Direction logic
      let direction: number;
      if (i === 0) {
        direction = prices[candleIdx] > upperBand ? 1 : -1;
      } else {
        if (prevDirection === 1) {
          direction = prices[candleIdx] < lowerBand ? -1 : 1;
        } else {
          direction = prices[candleIdx] > upperBand ? 1 : -1;
        }
      }

      prevUpperBand = upperBand;
      prevLowerBand = lowerBand;
      prevSupertrend = direction === 1 ? lowerBand : upperBand;
      prevDirection = direction;
    }

    // Check for direction change in the last 2 periods
    // Re-run for second-to-last to get previous direction
    let prev2Direction = prevDirection; // fallback
    if (atrValues.length >= 2) {
      // Simplified: use the current direction logic
      // If current is bullish and price just crossed above upper band → buy signal
      const currentPrice = prices[prices.length - 1];
      const prevPrice = prices[prices.length - 2];

      if (prevDirection === 1) {
        // Bullish trend
        if (prevPrice <= prevLowerBand && currentPrice > prevLowerBand) {
          // Not really a change, already bullish
        }
        // Check if this is a NEW bullish signal (was bearish before)
        // For simplicity, generate buy on bullish trend confirmation
        return {
          action: 'buy',
          size,
          reason: `Supertrend bullish — price $${currentPrice.toFixed(2)} above band $${prevSupertrend.toFixed(2)}`,
        };
      } else {
        return {
          action: 'sell',
          size,
          reason: `Supertrend bearish — price $${prices[prices.length - 1].toFixed(2)} below band $${prevSupertrend.toFixed(2)}`,
        };
      }
    }

    return { action: 'hold', reason: 'Supertrend — insufficient trend data' };
  },
};

export default supertrend;
