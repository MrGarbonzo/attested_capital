/**
 * Test helpers for strategy tests.
 */
import type { Candle } from '../../src/strategies/types.js';

/**
 * Generate synthetic candle data.
 * Prices follow a simple pattern starting at `startPrice` with `step` increment.
 */
export function generateCandles(
  count: number,
  startPrice: number = 100,
  step: number = 0,
  volatility: number = 0.5,
): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    price += step;
    const noise = (Math.random() - 0.5) * 2 * volatility;
    const open = price + noise;
    const close = price - noise;
    const high = Math.max(open, close) + Math.abs(noise) * 0.5;
    const low = Math.min(open, close) - Math.abs(noise) * 0.5;

    candles.push({
      timestamp: Date.now() - (count - i) * 4 * 3600_000,
      open,
      high,
      low,
      close,
      volume: 1000 + Math.random() * 500,
    });
  }

  return candles;
}

/**
 * Generate candles that simulate an uptrend.
 */
export function uptrendCandles(count: number = 50, start: number = 100): Candle[] {
  return generateCandles(count, start, 1, 0.3);
}

/**
 * Generate candles that simulate a downtrend.
 */
export function downtrendCandles(count: number = 50, start: number = 200): Candle[] {
  return generateCandles(count, start, -1, 0.3);
}

/**
 * Generate candles that simulate a sideways (range-bound) market.
 */
export function sidewaysCandles(count: number = 50, center: number = 150): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const wave = Math.sin(i * 0.3) * 5; // oscillating ±5
    const price = center + wave;
    const noise = (Math.random() - 0.5) * 2;
    candles.push({
      timestamp: Date.now() - (count - i) * 4 * 3600_000,
      open: price + noise,
      high: price + Math.abs(noise) + 1,
      low: price - Math.abs(noise) - 1,
      close: price - noise,
      volume: 1000,
    });
  }
  return candles;
}

/**
 * Generate candles where RSI will be oversold (many consecutive drops).
 */
export function oversoldCandles(count: number = 30, start: number = 200): Candle[] {
  return generateCandles(count, start, -2, 0.1);
}

/**
 * Generate candles where RSI will be overbought (many consecutive rises).
 */
export function overboughtCandles(count: number = 30, start: number = 100): Candle[] {
  return generateCandles(count, start, 2, 0.1);
}
