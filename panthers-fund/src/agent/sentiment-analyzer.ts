/**
 * Sentiment Analyzer — sends aggregated text to DeepSeek via ResilientLLM
 * and parses the structured sentiment response.
 *
 * Returns null on any failure — trading engine falls back to strategy-only.
 */
import type { ResilientLLM } from './resilient-llm.js';
import type { SentimentSourceData, SentimentSignal } from './sentiment-types.js';

function buildSentimentPrompt(sources: SentimentSourceData[]): string {
  const sections: string[] = [];

  for (const src of sources) {
    if (src.items.length === 0) continue;
    const label = src.source === 'twitter' ? 'Twitter/X Posts'
      : src.source === 'telegram' ? 'Telegram Messages'
      : 'Crypto News Headlines';

    const texts = src.items.map((item, i) => {
      const authorTag = item.author ? ` (@${item.author})` : '';
      return `  ${i + 1}. ${item.text}${authorTag}`;
    }).join('\n');

    sections.push(`## ${label}\n${texts}`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `You are a crypto market sentiment analyst. Analyze the following social media posts and news about Solana (SOL) and produce a sentiment assessment.

${sections.join('\n\n')}

Respond with ONLY a JSON object (no markdown, no explanation) matching this exact schema:
{
  "score": <number from -1.0 (extremely bearish) to +1.0 (extremely bullish)>,
  "confidence": <number from 0.0 (no confidence) to 1.0 (very confident)>,
  "reasoning": "<1-2 sentence summary of sentiment drivers>",
  "sources": {
    "twitter": { "score": <-1 to 1>, "confidence": <0 to 1>, "itemCount": <number> },
    "telegram": { "score": <-1 to 1>, "confidence": <0 to 1>, "itemCount": <number> },
    "news": { "score": <-1 to 1>, "confidence": <0 to 1>, "itemCount": <number> }
  },
  "extremeEvent": <string describing extreme event like "exchange hack" or "major partnership", or null if none>
}

Guidelines:
- Score reflects overall market sentiment direction for SOL
- Confidence reflects how reliable the signal is (low if sources are contradictory or sparse)
- Set extremeEvent only for genuine black swan events (hacks, regulatory bans, major protocol upgrades, massive partnerships)
- If sources are mostly noise or irrelevant, score near 0 with low confidence
- Weight engagement and author credibility where visible`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseResponse(text: string): SentimentSignal | null {
  // Extract JSON from response (handle potential markdown wrapping)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    if (typeof parsed.score !== 'number' || typeof parsed.confidence !== 'number') {
      return null;
    }

    const sources = parsed.sources as Record<string, Record<string, number>> | undefined;

    const defaultSrc = { score: 0, confidence: 0, itemCount: 0 };
    const twitterSrc = sources?.twitter ?? defaultSrc;
    const telegramSrc = sources?.telegram ?? defaultSrc;
    const newsSrc = sources?.news ?? defaultSrc;

    return {
      score: clamp(parsed.score, -1, 1),
      confidence: clamp(parsed.confidence, 0, 1),
      reasoning: String(parsed.reasoning ?? 'No reasoning provided'),
      sources: {
        twitter: {
          score: clamp(Number(twitterSrc.score) || 0, -1, 1),
          confidence: clamp(Number(twitterSrc.confidence) || 0, 0, 1),
          itemCount: Number(twitterSrc.itemCount) || 0,
        },
        telegram: {
          score: clamp(Number(telegramSrc.score) || 0, -1, 1),
          confidence: clamp(Number(telegramSrc.confidence) || 0, 0, 1),
          itemCount: Number(telegramSrc.itemCount) || 0,
        },
        news: {
          score: clamp(Number(newsSrc.score) || 0, -1, 1),
          confidence: clamp(Number(newsSrc.confidence) || 0, 0, 1),
          itemCount: Number(newsSrc.itemCount) || 0,
        },
      },
      extremeEvent: typeof parsed.extremeEvent === 'string' ? parsed.extremeEvent : null,
      generatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function analyzeSentiment(
  llm: ResilientLLM,
  sources: SentimentSourceData[],
): Promise<SentimentSignal | null> {
  const prompt = buildSentimentPrompt(sources);

  if (!prompt) {
    console.log('[sentiment] No source data to analyze — skipping');
    return null;
  }

  if (!llm.isAvailable) {
    console.warn('[sentiment] LLM circuit breaker is open — skipping analysis');
    return null;
  }

  try {
    // Use empty tools array — pure text completion, no tool calling
    const response = await llm.run(prompt, []);
    const signal = parseResponse(response);

    if (!signal) {
      console.warn('[sentiment] Failed to parse LLM response');
      return null;
    }

    console.log(
      `[sentiment] Analysis complete: score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} extreme=${signal.extremeEvent ?? 'none'}`,
    );

    return signal;
  } catch (err) {
    console.warn(`[sentiment] Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
