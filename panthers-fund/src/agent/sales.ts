/**
 * AI Sales Agent — Dynamic NFT pricing, purchases, and auctions.
 *
 * Pricing formula:
 *   price = baseNAV × (1 + sentiment×0.5) × (1 + performance) × scarcity × activity
 *
 * Where:
 *   baseNAV      = fixed $20 base price (independent of fund NAV)
 *   sentiment    = [-1, 1] based on recent Telegram activity (simplified)
 *   performance  = recent fund return % (e.g. +0.05 for +5%)
 *   scarcity     = 1 + (mintedRatio × 0.3)  — up to +30% as supply dwindles
 *   activity     = 1 + (activityScore × 0.2) — up to +20% for active communities
 *
 * All prices in INTEGER CENTS.
 */
import type { DatabaseLedger } from '../database/ledger.js';
import type { NFTAccount } from '../types/nft-account.js';

// ── Constants ──────────────────────────────────────────────────

const MAX_NFTS = Number(process.env.MAX_NFTS) || 20;
const MIN_PRICE_CENTS = 100;     // $1 absolute minimum price
const BASE_PRICE_CENTS = 2000;   // $20 base price for new NFTs

// ── Dynamic Pricing ────────────────────────────────────────────

export interface PricingFactors {
  baseNavCents: number;
  sentimentMultiplier: number;
  performanceMultiplier: number;
  scarcityMultiplier: number;
  activityMultiplier: number;
  finalPriceCents: number;
}

/**
 * Calculate the dynamic price for a new NFT.
 */
export function calculateNFTPrice(db: DatabaseLedger): PricingFactors {
  const accounts = db.getAllNFTAccounts(true);

  // Fixed base price — independent of NAV so new NFTs stay affordable
  const baseNavCents = BASE_PRICE_CENTS;

  // Sentiment: simplified — based on number of recent trades as proxy
  const sentiment = calculateSentiment(db);
  const sentimentMultiplier = 1 + sentiment * 0.5;

  // Performance: recent fund return
  const performance = calculatePerformance(db);
  const performanceMultiplier = 1 + performance;

  // Scarcity: more minted = more expensive
  const mintedCount = accounts.length;
  const mintedRatio = mintedCount / MAX_NFTS;
  const scarcityMultiplier = 1 + mintedRatio * 0.3;

  // Activity: simplified — based on NFT count as proxy for community size
  const activityScore = Math.min(1, mintedCount / 100); // 0-1 scale
  const activityMultiplier = 1 + activityScore * 0.2;

  // Final price
  let finalPriceCents = Math.trunc(
    baseNavCents * sentimentMultiplier * performanceMultiplier * scarcityMultiplier * activityMultiplier
  );

  // Floor
  finalPriceCents = Math.max(MIN_PRICE_CENTS, finalPriceCents);

  return {
    baseNavCents,
    sentimentMultiplier,
    performanceMultiplier,
    scarcityMultiplier,
    activityMultiplier,
    finalPriceCents,
  };
}

/**
 * Sentiment proxy: ratio of winning trades in recent history.
 * Returns [-1, 1] where 1 = very positive, -1 = very negative.
 */
function calculateSentiment(db: DatabaseLedger): number {
  const trades = db.getTradeHistory(20);
  if (trades.length === 0) return 0;

  const wins = trades.filter((t) => t.profit_loss > 0).length;
  const losses = trades.filter((t) => t.profit_loss < 0).length;
  const total = wins + losses;
  if (total === 0) return 0;

  // Scale from [-1, 1]: win ratio 0.5 → 0, win ratio 1.0 → 1, win ratio 0 → -1
  return (wins / total - 0.5) * 2;
}

/**
 * Performance: total P&L of recent trades as percentage of pool.
 * Returns a decimal (e.g. 0.05 for +5%).
 */
export function calculatePerformance(db: DatabaseLedger): number {
  const state = db.getFundState();
  if (state.total_pool_balance === 0) return 0;

  const trades = db.getTradeHistory(20);
  if (trades.length === 0) return 0;

  const totalPnl = trades.reduce((sum, t) => sum + t.profit_loss, 0);
  const pctReturn = totalPnl / state.total_pool_balance;

  // Clamp to [-0.5, 0.5] to prevent extreme multipliers
  return Math.max(-0.5, Math.min(0.5, pctReturn));
}

// ── Token ID Management ────────────────────────────────────────

/**
 * Check if a Telegram user already owns an active NFT.
 */
export function ownerHasNFT(db: DatabaseLedger, telegramId: string): NFTAccount | null {
  const accounts = db.getAllNFTAccounts(true);
  return accounts.find((a) => a.owner_telegram_id === telegramId) ?? null;
}

/**
 * Pick a random available token ID (1-MAX_NFTS).
 * Returns null if all NFTs are taken.
 */
export function getNextAvailableTokenId(db: DatabaseLedger): number | null {
  const allAccounts = db.getAllNFTAccounts(false);
  const taken = new Set(allAccounts.map((a) => a.token_id));

  const available: number[] = [];
  for (let id = 1; id <= MAX_NFTS; id++) {
    if (!taken.has(id)) available.push(id);
  }
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Get sales statistics.
 */
export interface SalesStats {
  totalMinted: number;
  totalAvailable: number;
  totalActive: number;
  totalWithdrawn: number;
  currentPriceCents: number;
  pricingFactors: PricingFactors;
  soldOutPct: number;
}

export function getSalesStats(db: DatabaseLedger): SalesStats {
  const allAccounts = db.getAllNFTAccounts(false);
  const activeAccounts = allAccounts.filter((a) => a.is_active);
  const withdrawnAccounts = allAccounts.filter((a) => !a.is_active);
  const pricing = calculateNFTPrice(db);

  return {
    totalMinted: allAccounts.length,
    totalAvailable: MAX_NFTS - allAccounts.length,
    totalActive: activeAccounts.length,
    totalWithdrawn: withdrawnAccounts.length,
    currentPriceCents: pricing.finalPriceCents,
    pricingFactors: pricing,
    soldOutPct: Math.round((allAccounts.length / MAX_NFTS) * 100),
  };
}

// ── Buyer Context ──────────────────────────────────────────────

export type ScarcityTier = 'abundant' | 'moderate' | 'scarce' | 'final_few';
export type SuggestedMood = 'firm' | 'confident' | 'generous' | 'neutral';

export interface BuyerContext {
  isReturningCustomer: boolean;
  currentlyOwnsNFT: boolean;
  currentTokenId: number | null;
  nftsRemaining: number;
  totalMinted: number;
  maxSupply: number;
  soldOutPct: number;
  scarcityTier: ScarcityTier;
  fundPerformanceSummary: string;
  suggestedMood: SuggestedMood;
  currentPriceCents: number;
  suggestedFloorCents: number;
  negotiationHints: string[];
}

function getScarcityTier(remaining: number, maxSupply: number): ScarcityTier {
  if (remaining <= 2) return 'final_few';
  const soldPct = ((maxSupply - remaining) / maxSupply) * 100;
  if (soldPct >= 70) return 'scarce';
  if (soldPct >= 40) return 'moderate';
  return 'abundant';
}

export function getBuyerContext(
  db: DatabaseLedger,
  buyerTelegramId?: string,
): BuyerContext {
  const allAccounts = db.getAllNFTAccounts(false);
  const activeAccounts = allAccounts.filter((a) => a.is_active);
  const totalMinted = allAccounts.length;
  const nftsRemaining = MAX_NFTS - totalMinted;
  const soldOutPct = Math.round((totalMinted / MAX_NFTS) * 100);
  const scarcityTier = getScarcityTier(nftsRemaining, MAX_NFTS);

  // Buyer-specific context
  let isReturningCustomer = false;
  let currentlyOwnsNFT = false;
  let currentTokenId: number | null = null;

  if (buyerTelegramId) {
    const activeOwned = activeAccounts.find((a) => a.owner_telegram_id === buyerTelegramId);
    if (activeOwned) {
      currentlyOwnsNFT = true;
      currentTokenId = activeOwned.token_id;
    }
    // Returning = previously owned (has a withdrawn/inactive account) but doesn't currently hold one
    const pastOwned = allAccounts.find(
      (a) => a.owner_telegram_id === buyerTelegramId && !a.is_active,
    );
    if (pastOwned && !currentlyOwnsNFT) {
      isReturningCustomer = true;
    }
  }

  // Performance summary
  const performance = calculatePerformance(db);
  const pctStr = (performance * 100).toFixed(1);
  let fundPerformanceSummary: string;
  if (performance > 0.02) fundPerformanceSummary = `Fund is up ${pctStr}% recently — performing well`;
  else if (performance < -0.02) fundPerformanceSummary = `Fund is down ${pctStr}% recently — in a dip`;
  else fundPerformanceSummary = `Fund is roughly flat (${pctStr}%) recently`;

  // Pricing
  const pricing = calculateNFTPrice(db);
  const currentPriceCents = pricing.finalPriceCents;

  // Suggested mood
  let suggestedMood: SuggestedMood = 'neutral';
  if (scarcityTier === 'final_few') suggestedMood = 'firm';
  else if (scarcityTier === 'scarce' || performance > 0.02) suggestedMood = 'confident';
  else if (scarcityTier === 'abundant' && performance < -0.02) suggestedMood = 'generous';

  // Advisory floor — tightens with scarcity, loosens for returning customers
  let floorPct: number;
  switch (scarcityTier) {
    case 'final_few': floorPct = 0.92; break;
    case 'scarce':    floorPct = 0.85; break;
    case 'moderate':  floorPct = 0.80; break;
    case 'abundant':  floorPct = 0.75; break;
  }
  if (isReturningCustomer) floorPct -= 0.03;
  const suggestedFloorCents = Math.trunc(currentPriceCents * floorPct);

  // Negotiation hints
  const negotiationHints: string[] = [];
  if (currentlyOwnsNFT) {
    negotiationHints.push(`Buyer already owns NFT #${currentTokenId} — they can't buy another while holding one`);
  }
  if (isReturningCustomer) {
    negotiationHints.push('Returning customer — consider loyalty pricing');
  }
  if (scarcityTier === 'final_few') {
    negotiationHints.push(`Only ${nftsRemaining} left — create urgency, hold the line on price`);
  } else if (scarcityTier === 'scarce') {
    negotiationHints.push(`Only ${nftsRemaining} remaining out of ${MAX_NFTS} — scarcity is real`);
  }
  if (performance > 0.05) {
    negotiationHints.push('Fund is hot — use performance to justify price');
  }
  if (performance < -0.02 && scarcityTier === 'abundant') {
    negotiationHints.push('Market dip + abundant supply — good time for a deal to attract buyers');
  }
  if (nftsRemaining === 0) {
    negotiationHints.push('SOLD OUT — no new NFTs available, buyers must use the secondary marketplace');
  }

  return {
    isReturningCustomer,
    currentlyOwnsNFT,
    currentTokenId,
    nftsRemaining,
    totalMinted,
    maxSupply: MAX_NFTS,
    soldOutPct,
    scarcityTier,
    fundPerformanceSummary,
    suggestedMood,
    currentPriceCents,
    suggestedFloorCents,
    negotiationHints,
  };
}

// ── Flash Auction ──────────────────────────────────────────────

export interface FlashAuction {
  tokenId: number;
  startPriceCents: number;
  currentPriceCents: number;
  discountPct: number;
  expiresAt: number;     // Unix ms
  isExpired: boolean;
}

/** Active flash auctions (in-memory, reset on restart). */
const activeAuctions: Map<number, FlashAuction> = new Map();

/**
 * Create a flash auction for a new NFT.
 * Starts at dynamic price, drops by discountPct over duration.
 */
export function createFlashAuction(
  db: DatabaseLedger,
  durationMs: number = 30 * 60 * 1000, // 30 minutes
  discountPct: number = 15,             // up to 15% off
): FlashAuction | null {
  const tokenId = getNextAvailableTokenId(db);
  if (tokenId === null) return null;

  const pricing = calculateNFTPrice(db);
  const auction: FlashAuction = {
    tokenId,
    startPriceCents: pricing.finalPriceCents,
    currentPriceCents: pricing.finalPriceCents,
    discountPct,
    expiresAt: Date.now() + durationMs,
    isExpired: false,
  };

  activeAuctions.set(tokenId, auction);
  return auction;
}

/**
 * Get current auction price (decreases over time).
 */
export function getAuctionPrice(tokenId: number): FlashAuction | null {
  const auction = activeAuctions.get(tokenId);
  if (!auction) return null;

  const now = Date.now();
  if (now >= auction.expiresAt) {
    auction.isExpired = true;
    auction.currentPriceCents = auction.startPriceCents; // Reset to full price
    activeAuctions.delete(tokenId);
    return auction;
  }

  // Linear discount over time
  const totalDuration = auction.expiresAt - (auction.expiresAt - 30 * 60 * 1000);
  const elapsed = now - (auction.expiresAt - 30 * 60 * 1000);
  const progress = Math.min(1, Math.max(0, elapsed / totalDuration));
  const currentDiscount = auction.discountPct * progress;
  auction.currentPriceCents = Math.trunc(
    auction.startPriceCents * (1 - currentDiscount / 100)
  );
  auction.currentPriceCents = Math.max(MIN_PRICE_CENTS, auction.currentPriceCents);

  return auction;
}

/**
 * Get all active auctions.
 */
export function getActiveAuctions(): FlashAuction[] {
  const now = Date.now();
  const result: FlashAuction[] = [];
  for (const [tokenId, auction] of activeAuctions) {
    if (now >= auction.expiresAt) {
      activeAuctions.delete(tokenId);
      continue;
    }
    result.push(getAuctionPrice(tokenId)!);
  }
  return result;
}

/**
 * Cancel a flash auction.
 */
export function cancelAuction(tokenId: number): boolean {
  return activeAuctions.delete(tokenId);
}

// ── Negotiation ────────────────────────────────────────────────

export interface NegotiationResult {
  accepted: boolean;
  counterOfferCents?: number;
  reason: string;
  listedPriceCents: number;
  scarcityTier: ScarcityTier;
  isReturningCustomer: boolean;
  maxDiscountPct: number;
  advisoryFloorCents: number;
  responseHints: string[];
}

/** Scarcity-based negotiation thresholds. */
const SCARCITY_THRESHOLDS: Record<ScarcityTier, { accept: number; counter: number; maxDiscount: number }> = {
  abundant:  { accept: 0.85, counter: 0.70, maxDiscount: 25 },
  moderate:  { accept: 0.88, counter: 0.75, maxDiscount: 20 },
  scarce:    { accept: 0.92, counter: 0.82, maxDiscount: 15 },
  final_few: { accept: 0.95, counter: 0.88, maxDiscount: 8 },
};

/** Returning customer leeway applied to thresholds. */
const RETURNING_LEEWAY = 0.03;
const RETURNING_DISCOUNT_BONUS = 3;

/**
 * Evaluate a buyer's offer against the dynamic price.
 * Uses scarcity-aware thresholds and optional buyer context.
 * Backward compatible — buyerTelegramId is optional.
 */
export function evaluateOffer(
  db: DatabaseLedger,
  offerCents: number,
  buyerTelegramId?: string,
): NegotiationResult {
  const buyerCtx = getBuyerContext(db, buyerTelegramId);
  const listedPrice = buyerCtx.currentPriceCents;
  const { scarcityTier, isReturningCustomer } = buyerCtx;

  const thresholds = SCARCITY_THRESHOLDS[scarcityTier];
  let acceptPct = thresholds.accept;
  let counterPct = thresholds.counter;
  let maxDiscount = thresholds.maxDiscount;

  // Returning customers get leeway
  if (isReturningCustomer) {
    acceptPct -= RETURNING_LEEWAY;
    counterPct -= RETURNING_LEEWAY;
    maxDiscount += RETURNING_DISCOUNT_BONUS;
  }

  const advisoryFloorCents = Math.trunc(listedPrice * (1 - maxDiscount / 100));
  const offerRatio = offerCents / listedPrice;
  const responseHints: string[] = [];

  // Accept
  if (offerRatio >= acceptPct) {
    if (isReturningCustomer) responseHints.push('Welcome back — good to see a returning holder');
    return {
      accepted: true,
      reason: `Offer $${(offerCents / 100).toFixed(2)} accepted (listed at $${(listedPrice / 100).toFixed(2)})`,
      listedPriceCents: listedPrice,
      scarcityTier,
      isReturningCustomer,
      maxDiscountPct: maxDiscount,
      advisoryFloorCents,
      responseHints,
    };
  }

  // Counter-offer zone
  if (offerRatio >= counterPct) {
    // Weighted toward listed price: (offer + listed×2) / 3
    const counterOffer = Math.trunc((offerCents + listedPrice * 2) / 3);
    const discountPct = Math.round((1 - counterOffer / listedPrice) * 100);

    responseHints.push(`Counter is ${discountPct}% off listed — room for one more round`);
    if (scarcityTier === 'scarce' || scarcityTier === 'final_few') {
      responseHints.push('Supply is tight — don\'t give much more ground');
    }
    if (isReturningCustomer) responseHints.push('Returning customer — you can lean toward their side');

    return {
      accepted: false,
      counterOfferCents: counterOffer,
      reason: `Offer too low. Counter-offer: $${(counterOffer / 100).toFixed(2)} (listed at $${(listedPrice / 100).toFixed(2)})`,
      listedPriceCents: listedPrice,
      scarcityTier,
      isReturningCustomer,
      maxDiscountPct: maxDiscount,
      advisoryFloorCents,
      responseHints,
    };
  }

  // Reject — lowball
  responseHints.push(`Offer is ${Math.round((1 - offerRatio) * 100)}% below listed price — that's a lowball`);
  if (scarcityTier !== 'abundant') {
    responseHints.push(`With ${buyerCtx.nftsRemaining} left, you can be firm`);
  }
  responseHints.push('Challenge them to come back with a real offer');

  return {
    accepted: false,
    reason: `Offer $${(offerCents / 100).toFixed(2)} too low. Current price: $${(listedPrice / 100).toFixed(2)}`,
    listedPriceCents: listedPrice,
    scarcityTier,
    isReturningCustomer,
    maxDiscountPct: maxDiscount,
    advisoryFloorCents,
    responseHints,
  };
}
