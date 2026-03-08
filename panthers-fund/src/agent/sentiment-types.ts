/**
 * Sentiment pipeline types — shared across fetcher, analyzer, blender, and trading engine.
 */

export interface SentimentItem {
  text: string;
  author?: string;
  timestamp: number;
  url?: string;
  engagement?: number;
}

export interface SentimentSourceData {
  source: 'twitter' | 'telegram' | 'news';
  items: SentimentItem[];
  fetchedAt: number;
  error?: string;
}

export interface SentimentSourceScore {
  score: number;
  confidence: number;
  itemCount: number;
}

export interface SentimentSignal {
  score: number;        // -1 (bearish) to +1 (bullish)
  confidence: number;   // 0 to 1
  reasoning: string;
  sources: {
    twitter: SentimentSourceScore;
    telegram: SentimentSourceScore;
    news: SentimentSourceScore;
  };
  extremeEvent: string | null;   // "exchange hack", "major partnership", etc.
  generatedAt: number;
}

export interface BlendedSignal {
  action: 'buy' | 'sell' | 'hold';
  size?: number;        // 5-30% (same range as StrategySignal)
  reason: string;
  blendLayer: 'weighted' | 'veto' | 'extreme_override' | 'fallback';
  strategyScore: number;
  sentimentScore: number;
  sentimentConfidence: number;
}

export interface BlendWeights {
  strategyWeight: number;       // 0.4
  sentimentWeight: number;      // 0.6
  buyThreshold: number;         // 0.2
  sellThreshold: number;        // -0.2
  vetoConfidence: number;       // 0.7 — min confidence for AI veto
  extremeThreshold: number;     // 0.85 — min confidence for extreme override
  extremeScoreMin: number;      // 0.8 — min |score| for extreme override
}

export const DEFAULT_BLEND_WEIGHTS: BlendWeights = {
  strategyWeight: 0.4,
  sentimentWeight: 0.6,
  buyThreshold: 0.2,
  sellThreshold: -0.2,
  vetoConfidence: 0.7,
  extremeThreshold: 0.85,
  extremeScoreMin: 0.8,
};

export interface FetcherConfig {
  twitterAccounts: string[];
  telegramChannels: string[];
  cryptoPanicToken?: string;
  itemsPerSource: number;
  cacheTtlMs: number;
}

export const DEFAULT_FETCHER_CONFIG: FetcherConfig = {
  twitterAccounts: ['SolanaFloor', 'DefiIgnas', 'CryptoCapo_', 'inversebrah', 'AltcoinGordon'],
  telegramChannels: ['crypto', 'WatcherGuru'],
  cryptoPanicToken: undefined,
  itemsPerSource: 20,
  cacheTtlMs: 15 * 60 * 1000, // 15 minutes
};

export interface SentimentLogEntry {
  score: number;
  confidence: number;
  reasoning: string;
  extremeEvent: string | null;
  twitterScore: number | null;
  telegramScore: number | null;
  newsScore: number | null;
  blendLayer: string | null;
  strategyAction: string | null;
  blendedAction: string | null;
  rawJson: string;
}
