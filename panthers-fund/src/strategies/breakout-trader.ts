import type { Strategy, Candle, StrategySignal } from './types.js';
import { closePrices, latestCandle } from './helpers.js';

const breakoutTrader: Strategy = {
  meta: {
    id: 'breakout_trader',
    name: 'Breakout Trader',
    description: 'Buy on volume breakouts. Catches explosive moves.',
    riskLevel: 'high',
    bestFor: 'News events, catalysts, strong momentum',
    winRate: 0.49,
    avgMonthlyReturn: 0.12,
  },

  paramDefs: {
    volume_threshold: { min: 1.5, max: 3, default: 2, step: 0.1, description: 'Volume multiplier threshold (x average)' },
    price_move:       { min: 2, max: 5, default: 3, description: 'Min price move (%)' },
    position_size:    { min: 15, max: 35, default: 25, description: 'Position size (% of pool)' },
  },

  execute(candles: Candle[], params: Record<string, number>): StrategySignal {
    const priceMovePct = params.price_move ?? 3;
    const size = params.position_size ?? 25;
    const lookback = 20;

    if (candles.length < lookback + 1) {
      return { action: 'hold', reason: `Not enough data (need ${lookback + 1} candles)` };
    }

    const prices = closePrices(candles);
    const currentPrice = latestCandle(candles).close;

    // Calculate resistance and support from recent highs/lows
    const recentCandles = candles.slice(-lookback);
    const recentHigh = Math.max(...recentCandles.map((c) => c.high));
    const recentLow = Math.min(...recentCandles.map((c) => c.low));

    // Check for volume breakout (if volume data available)
    const hasVolume = candles.some((c) => c.volume !== undefined && c.volume > 0);
    let volumeBreakout = false;

    if (hasVolume) {
      const volThreshold = params.volume_threshold ?? 2;
      const recentVolumes = recentCandles
        .slice(0, -1) // exclude current
        .map((c) => c.volume ?? 0)
        .filter((v) => v > 0);

      if (recentVolumes.length > 0) {
        const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
        const currentVolume = latestCandle(candles).volume ?? 0;
        volumeBreakout = currentVolume > avgVolume * volThreshold;
      }
    }

    // Price breakout above resistance
    const breakAbove = ((currentPrice - recentHigh) / recentHigh) * 100;
    if (breakAbove > 0) {
      // Price is above recent resistance
      const priceBreakout = breakAbove >= priceMovePct * 0.5; // looser on resistance break
      if (priceBreakout || volumeBreakout) {
        return {
          action: 'buy',
          size,
          reason: `Breakout above resistance $${recentHigh.toFixed(2)} (+${breakAbove.toFixed(1)}%)${volumeBreakout ? ' with volume' : ''}`,
        };
      }
    }

    // Price breakdown below support
    const breakBelow = ((recentLow - currentPrice) / recentLow) * 100;
    if (breakBelow > 0) {
      const priceBreakdown = breakBelow >= priceMovePct * 0.5;
      if (priceBreakdown || volumeBreakout) {
        return {
          action: 'sell',
          size,
          reason: `Breakdown below support $${recentLow.toFixed(2)} (-${breakBelow.toFixed(1)}%)${volumeBreakout ? ' with volume' : ''}`,
        };
      }
    }

    // Check for strong momentum move (no need for exact breakout)
    const prevClose = prices[prices.length - 2];
    const pctMove = ((currentPrice - prevClose) / prevClose) * 100;

    if (Math.abs(pctMove) >= priceMovePct && volumeBreakout) {
      if (pctMove > 0) {
        return {
          action: 'buy',
          size,
          reason: `Strong momentum +${pctMove.toFixed(1)}% with volume breakout`,
        };
      }
      return {
        action: 'sell',
        size,
        reason: `Strong momentum ${pctMove.toFixed(1)}% with volume breakdown`,
      };
    }

    return {
      action: 'hold',
      reason: `No breakout — price within range [$${recentLow.toFixed(2)}, $${recentHigh.toFixed(2)}]`,
    };
  },
};

export default breakoutTrader;
