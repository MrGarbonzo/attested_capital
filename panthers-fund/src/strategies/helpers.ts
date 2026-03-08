/**
 * Shared helpers for strategy implementations.
 */
import type { Candle } from './types.js';

/** Extract close prices from candles (oldest → newest). */
export function closePrices(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

/** Extract high prices from candles. */
export function highPrices(candles: Candle[]): number[] {
  return candles.map((c) => c.high);
}

/** Extract low prices from candles. */
export function lowPrices(candles: Candle[]): number[] {
  return candles.map((c) => c.low);
}

/** Get the latest candle. */
export function latestCandle(candles: Candle[]): Candle {
  if (candles.length === 0) throw new Error('No candle data');
  return candles[candles.length - 1];
}

/**
 * Simple Moving Average of the last `period` values.
 */
export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Calculate Average True Range manually from candles.
 */
export function atr(candles: Candle[], period: number): number[] {
  if (candles.length < 2) return [];
  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  // EMA-based ATR
  const result: number[] = [];
  if (trueRanges.length < period) return [];

  let atrVal = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(atrVal);

  for (let i = period; i < trueRanges.length; i++) {
    atrVal = (atrVal * (period - 1) + trueRanges[i]) / period;
    result.push(atrVal);
  }

  return result;
}
