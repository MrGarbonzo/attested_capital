import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseLedger } from '../../src/database/ledger.js';
import {
  calculateNFTPrice,
  getNextAvailableTokenId,
  getSalesStats,
  evaluateOffer,
  createFlashAuction,
  getActiveAuctions,
  cancelAuction,
} from '../../src/agent/sales.js';

const MAX_NFTS = Number(process.env.MAX_NFTS) || 20;
const BASE_PRICE_CENTS = 2000; // $20 base price

describe('AI Sales Agent', () => {
  let db: DatabaseLedger;

  beforeEach(() => {
    db = new DatabaseLedger(':memory:');
  });

  afterEach(() => {
    // Clean up any flash auctions leaked from prior tests
    for (const a of getActiveAuctions()) {
      cancelAuction(a.tokenId);
    }
  });

  describe('calculateNFTPrice', () => {
    it('returns default price when no accounts exist', () => {
      const pricing = calculateNFTPrice(db);
      expect(pricing.finalPriceCents).toBeGreaterThanOrEqual(100); // MIN_PRICE_CENTS
      expect(pricing.baseNavCents).toBe(BASE_PRICE_CENTS);
      expect(pricing.scarcityMultiplier).toBe(1); // 0% minted
      expect(pricing.sentimentMultiplier).toBe(1); // no trades = neutral
    });

    it('uses fixed base price regardless of account balances', () => {
      db.createNFTAccount(1, 'tg_1', 'addr_1', 20000); // $200
      db.createNFTAccount(2, 'tg_2', 'addr_2', 10000); // $100

      const pricing = calculateNFTPrice(db);
      expect(pricing.baseNavCents).toBe(BASE_PRICE_CENTS); // fixed $20
    });

    it('increases price with scarcity (more minted = higher)', () => {
      // Mint 10 out of 20 NFTs (50%)
      for (let i = 1; i <= 10; i++) {
        db.createNFTAccount(i, `tg_${i}`, `addr_${i}`, 10000);
      }
      const pricing = calculateNFTPrice(db);

      // scarcity = 1 + (10/20 * 0.3) = 1.15
      expect(pricing.scarcityMultiplier).toBeCloseTo(1.15, 2);
    });

    it('never goes below minimum price', () => {
      const pricing = calculateNFTPrice(db);
      expect(pricing.finalPriceCents).toBeGreaterThanOrEqual(100);
    });

    it('adjusts for positive performance', () => {
      db.createNFTAccount(1, 'tg_1', 'addr_1', 100000);

      // Record a winning trade
      db.recordTrade({
        strategy: 'ema_crossover',
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price: 14500,
        exit_price: 15000,
        amount: 10000,
        profit_loss: 5000,
        signature: 'sig_1',
        attestation: 'attest_1',
      });

      const pricing = calculateNFTPrice(db);
      expect(pricing.performanceMultiplier).toBeGreaterThan(1);
    });
  });

  describe('getNextAvailableTokenId', () => {
    it('returns an available ID when no accounts exist', () => {
      const id = getNextAvailableTokenId(db);
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(MAX_NFTS);
    });

    it('returns an ID not already taken', () => {
      db.createNFTAccount(1, 'tg_1', 'addr_1', 10000);
      db.createNFTAccount(2, 'tg_2', 'addr_2', 10000);
      const id = getNextAvailableTokenId(db);
      expect(id).not.toBe(1);
      expect(id).not.toBe(2);
      expect(id).toBeGreaterThanOrEqual(3);
      expect(id).toBeLessThanOrEqual(MAX_NFTS);
    });

    it('returns null when all token IDs are taken', () => {
      for (let i = 1; i <= MAX_NFTS; i++) {
        db.createNFTAccount(i, `tg_${i}`, `addr_${i}`, 10000);
      }
      expect(getNextAvailableTokenId(db)).toBeNull();
    });
  });

  describe('getSalesStats', () => {
    it('returns correct stats with no NFTs', () => {
      const stats = getSalesStats(db);
      expect(stats.totalMinted).toBe(0);
      expect(stats.totalAvailable).toBe(MAX_NFTS);
      expect(stats.totalActive).toBe(0);
      expect(stats.soldOutPct).toBe(0);
    });

    it('returns correct stats with some NFTs', () => {
      db.createNFTAccount(1, 'tg_1', 'addr_1', 10000);
      db.createNFTAccount(2, 'tg_2', 'addr_2', 20000);

      const stats = getSalesStats(db);
      expect(stats.totalMinted).toBe(2);
      expect(stats.totalAvailable).toBe(MAX_NFTS - 2);
      expect(stats.totalActive).toBe(2);
      expect(stats.currentPriceCents).toBeGreaterThan(0);
    });
  });

  describe('evaluateOffer', () => {
    beforeEach(() => {
      db.createNFTAccount(1, 'tg_1', 'addr_1', 10000);
    });

    it('accepts offers at or above accept threshold', () => {
      const pricing = calculateNFTPrice(db);
      // abundant accept = 85%, offer at 90% should be accepted
      const offer = Math.trunc(pricing.finalPriceCents * 0.90);
      const result = evaluateOffer(db, offer);
      expect(result.accepted).toBe(true);
    });

    it('counter-offers for offers in the negotiation zone', () => {
      const pricing = calculateNFTPrice(db);
      // abundant: counter zone is 70-85%, offer at 75%
      const offer = Math.trunc(pricing.finalPriceCents * 0.75);
      const result = evaluateOffer(db, offer);
      expect(result.accepted).toBe(false);
      expect(result.counterOfferCents).toBeDefined();
      expect(result.counterOfferCents!).toBeLessThan(pricing.finalPriceCents);
    });

    it('rejects offers below counter threshold', () => {
      const pricing = calculateNFTPrice(db);
      // abundant: below 70% is reject
      const offer = Math.trunc(pricing.finalPriceCents * 0.5);
      const result = evaluateOffer(db, offer);
      expect(result.accepted).toBe(false);
      expect(result.counterOfferCents).toBeUndefined();
    });
  });

  describe('Flash Auctions', () => {
    it('creates an auction', () => {
      const auction = createFlashAuction(db, 30 * 60 * 1000, 15);
      expect(auction).not.toBeNull();
      expect(auction!.tokenId).toBeGreaterThanOrEqual(1);
      expect(auction!.tokenId).toBeLessThanOrEqual(MAX_NFTS);
      expect(auction!.startPriceCents).toBeGreaterThan(0);
      expect(auction!.isExpired).toBe(false);
    });

    it('lists active auctions', () => {
      createFlashAuction(db);
      const auctions = getActiveAuctions();
      expect(auctions.length).toBe(1);
    });

    it('cancels an auction', () => {
      const auction = createFlashAuction(db)!;
      expect(cancelAuction(auction.tokenId)).toBe(true);
      expect(getActiveAuctions().length).toBe(0);
    });
  });
});
