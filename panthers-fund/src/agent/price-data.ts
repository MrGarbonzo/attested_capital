/**
 * Price data fetcher for Panthers Fund.
 * Fetches SOL/USDC OHLCV candles from CoinGecko (free, no API key).
 *
 * CoinGecko /ohlc endpoint granularity:
 *   days=1-2   → 30-min candles
 *   days=3-30  → 4-hour candles  (matches our 4h trading cycle)
 *   days=31+   → 4-day candles
 */
import type { Candle } from '../strategies/types.js';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

/** In-memory cache with TTL. */
interface CacheEntry {
  candles: Candle[];
  fetchedAt: number;
}

const cache: Map<string, CacheEntry> = new Map();

/** Default cache TTL: 10 minutes. */
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Fetch OHLCV candles for a coin from CoinGecko.
 *
 * @param coinId   CoinGecko coin ID (default: 'solana').
 * @param days     Number of days of history (default: 30 → 4h candles).
 * @param cacheTtl Cache TTL in ms (default: 10 min).
 */
export async function fetchCandles(
  coinId: string = 'solana',
  days: number = 30,
  cacheTtl: number = DEFAULT_CACHE_TTL_MS,
): Promise<Candle[]> {
  const cacheKey = `${coinId}:${days}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < cacheTtl) {
    return cached.candles;
  }

  const url = `${COINGECKO_BASE}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CoinGecko OHLC fetch failed (${res.status}): ${body}`);
  }

  // CoinGecko returns: [[timestamp, open, high, low, close], ...]
  const raw = (await res.json()) as number[][];

  const candles: Candle[] = raw.map(([timestamp, open, high, low, close]) => ({
    timestamp,
    open,
    high,
    low,
    close,
  }));

  cache.set(cacheKey, { candles, fetchedAt: Date.now() });
  return candles;
}

/**
 * Get an array of close prices (oldest → newest) for indicator calculations.
 */
export function closePrices(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

/**
 * Get the latest price from a candle array.
 */
export function latestPrice(candles: Candle[]): number {
  if (candles.length === 0) throw new Error('No candle data available');
  return candles[candles.length - 1].close;
}

/**
 * Fetch current SOL price in USD from Jupiter Price API v2 (faster, more accurate for Solana).
 * Falls back to latest candle close price if Jupiter fails.
 */
export async function fetchCurrentSolPrice(): Promise<number> {
  try {
    const url = 'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Jupiter price API: ${res.status}`);
    const data = (await res.json()) as {
      data: Record<string, { price: string }>;
    };
    const solData = data.data['So11111111111111111111111111111111111111112'];
    if (solData?.price) return parseFloat(solData.price);
    throw new Error('No SOL price in response');
  } catch {
    // Fallback: use latest candle
    const candles = await fetchCandles('solana', 1);
    return latestPrice(candles);
  }
}

/**
 * Clear the price cache (useful for testing).
 */
export function clearPriceCache(): void {
  cache.clear();
}
