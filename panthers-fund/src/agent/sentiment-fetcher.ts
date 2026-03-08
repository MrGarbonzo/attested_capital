/**
 * Sentiment Fetcher — gathers raw text from Twitter/X (Nitter RSS),
 * Telegram public channels, and CryptoPanic news API.
 *
 * Each source is isolated with try/catch for graceful degradation.
 * Results are cached in-memory with a configurable TTL (default 15 min).
 */
import type { SentimentSourceData, SentimentItem, FetcherConfig } from './sentiment-types.js';
import { DEFAULT_FETCHER_CONFIG } from './sentiment-types.js';

// ── In-memory cache ──────────────────────────────────────────
interface CacheEntry {
  data: SentimentSourceData[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

export function clearSentimentCache(): void {
  cache = null;
}

// ── Main fetch function ──────────────────────────────────────

export async function fetchSentimentData(
  config?: Partial<FetcherConfig>,
): Promise<SentimentSourceData[]> {
  const cfg: FetcherConfig = { ...DEFAULT_FETCHER_CONFIG, ...config };

  // Check cache
  if (cache && Date.now() - cache.fetchedAt < cfg.cacheTtlMs) {
    return cache.data;
  }

  // Fetch all sources in parallel
  const [twitter, telegram, news] = await Promise.all([
    fetchTwitter(cfg.twitterAccounts, cfg.itemsPerSource),
    fetchTelegram(cfg.telegramChannels, cfg.itemsPerSource),
    fetchNews(cfg.cryptoPanicToken, cfg.itemsPerSource),
  ]);

  const results = [twitter, telegram, news];
  cache = { data: results, fetchedAt: Date.now() };
  return results;
}

// ── Twitter/X via Nitter RSS ─────────────────────────────────

async function fetchTwitter(accounts: string[], limit: number): Promise<SentimentSourceData> {
  const items: SentimentItem[] = [];
  const now = Date.now();

  for (const handle of accounts) {
    try {
      // Try multiple Nitter instances for resilience
      const nitterInstances = [
        `https://nitter.net/${handle}/rss`,
        `https://nitter.privacydev.net/${handle}/rss`,
      ];

      let rssText: string | null = null;
      for (const url of nitterInstances) {
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(10_000),
            headers: { 'User-Agent': 'PanthersFund/1.0' },
          });
          if (res.ok) {
            rssText = await res.text();
            break;
          }
        } catch {
          continue;
        }
      }

      if (!rssText) continue;

      // Parse RSS items (simple regex — RSS is well-structured enough)
      const itemRegex = /<item>[\s\S]*?<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>[\s\S]*?<\/item>/g;
      let match;
      while ((match = itemRegex.exec(rssText)) !== null && items.length < limit) {
        const text = match[1]
          .replace(/<[^>]+>/g, '')  // strip HTML tags
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .trim();

        if (text.length > 10) {
          items.push({
            text,
            author: handle,
            timestamp: now,
            url: `https://x.com/${handle}`,
          });
        }
      }
    } catch {
      // Individual account failure — continue with others
    }
  }

  return {
    source: 'twitter',
    items: items.slice(0, limit),
    fetchedAt: now,
    error: items.length === 0 ? 'No Twitter data available (Nitter may be down)' : undefined,
  };
}

// ── Telegram public channel scraping ─────────────────────────

async function fetchTelegram(channels: string[], limit: number): Promise<SentimentSourceData> {
  const items: SentimentItem[] = [];
  const now = Date.now();

  for (const channel of channels) {
    try {
      const url = `https://t.me/s/${channel}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'PanthersFund/1.0' },
      });

      if (!res.ok) continue;

      const html = await res.text();

      // Extract message text from Telegram's public preview HTML
      const msgRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
      let match;
      while ((match = msgRegex.exec(html)) !== null && items.length < limit) {
        const text = match[1]
          .replace(/<br\s*\/?>/g, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .trim();

        if (text.length > 20) {
          items.push({
            text: text.slice(0, 500), // cap individual message length
            author: channel,
            timestamp: now,
            url: `https://t.me/${channel}`,
          });
        }
      }
    } catch {
      // Individual channel failure — continue with others
    }
  }

  return {
    source: 'telegram',
    items: items.slice(0, limit),
    fetchedAt: now,
    error: items.length === 0 ? 'No Telegram data available' : undefined,
  };
}

// ── CryptoPanic news API ─────────────────────────────────────

interface CryptoPanicPost {
  title: string;
  published_at: string;
  url: string;
  source?: { title: string };
  votes?: { positive: number; negative: number; important: number };
}

async function fetchNews(token: string | undefined, limit: number): Promise<SentimentSourceData> {
  const now = Date.now();

  if (!token) {
    return {
      source: 'news',
      items: [],
      fetchedAt: now,
      error: 'CRYPTOPANIC_API_TOKEN not set',
    };
  }

  try {
    const url = `https://cryptopanic.com/api/free/v1/posts/?auth_token=${token}&currencies=SOL&filter=hot`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'PanthersFund/1.0' },
    });

    if (!res.ok) {
      return {
        source: 'news',
        items: [],
        fetchedAt: now,
        error: `CryptoPanic API returned ${res.status}`,
      };
    }

    const data = (await res.json()) as { results?: CryptoPanicPost[] };
    const posts = data.results ?? [];

    const items: SentimentItem[] = posts.slice(0, limit).map((post) => {
      const engagement = post.votes
        ? post.votes.positive + post.votes.negative + post.votes.important
        : 0;

      return {
        text: post.title,
        author: post.source?.title,
        timestamp: new Date(post.published_at).getTime(),
        url: post.url,
        engagement,
      };
    });

    return {
      source: 'news',
      items,
      fetchedAt: now,
    };
  } catch (err) {
    return {
      source: 'news',
      items: [],
      fetchedAt: now,
      error: `CryptoPanic fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
