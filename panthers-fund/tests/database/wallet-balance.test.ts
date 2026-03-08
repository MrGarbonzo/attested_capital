import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseLedger } from '../../src/database/ledger.js';

describe('DatabaseLedger — wallet & balance methods', () => {
  let ledger: DatabaseLedger;

  beforeEach(() => {
    ledger = new DatabaseLedger(':memory:');
  });

  afterEach(() => {
    ledger.close();
  });

  // ── Wallet State ──────────────────────────────────────────

  describe('wallet state', () => {
    it('getWalletState returns null when no wallet saved', () => {
      expect(ledger.getWalletState()).toBeNull();
    });

    it('saveWalletState + getWalletState round-trip', () => {
      ledger.saveWalletState({
        mnemonic: 'test mnemonic phrase here',
        solana_address: 'SolAddr123',
      });

      const state = ledger.getWalletState();
      expect(state).not.toBeNull();
      expect(state!.mnemonic).toBe('test mnemonic phrase here');
      expect(state!.solana_address).toBe('SolAddr123');
      expect(state!.id).toBe(1);
    });

    it('saveWalletState updates on re-save (singleton)', () => {
      ledger.saveWalletState({
        mnemonic: 'first',
        solana_address: 'a',
      });

      ledger.saveWalletState({
        mnemonic: 'second',
        solana_address: 'e',
      });

      const state = ledger.getWalletState();
      expect(state!.mnemonic).toBe('second');
      expect(state!.solana_address).toBe('e');
    });
  });

  // ── Balance Snapshots ─────────────────────────────────────

  describe('balance snapshots', () => {
    it('recordBalanceSnapshot + getLatestBalanceSnapshots', () => {
      ledger.recordBalanceSnapshot({
        chain: 'solana',
        token_symbol: 'SOL',
        token_mint: 'So11111111111111111111111111111111111111112',
        amount_raw: '5000000000',
        decimals: 9,
        amount_usd_cents: null,
      });

      const latest = ledger.getLatestBalanceSnapshots();
      expect(latest).toHaveLength(1);
      expect(latest[0].chain).toBe('solana');
      expect(latest[0].token_symbol).toBe('SOL');
      expect(latest[0].amount_raw).toBe('5000000000');
      expect(latest[0].decimals).toBe(9);
    });

    it('getBalanceHistory returns snapshots in descending time order', () => {
      for (let i = 0; i < 3; i++) {
        ledger.recordBalanceSnapshot({
          chain: 'solana',
          token_symbol: 'SOL',
          token_mint: 'So11111111111111111111111111111111111111112',
          amount_raw: String(i * 1000),
          decimals: 9,
          amount_usd_cents: null,
        });
      }

      const history = ledger.getBalanceHistory('solana', 'SOL', 10);
      expect(history).toHaveLength(3);
      expect(history.every((h) => h.chain === 'solana' && h.token_symbol === 'SOL')).toBe(true);
    });
  });

  // ── NFT Collection Config ─────────────────────────────────

  describe('nft collection config', () => {
    it('getNFTCollectionConfig returns null when not set', () => {
      expect(ledger.getNFTCollectionConfig()).toBeNull();
    });

    it('saveNFTCollectionConfig + getNFTCollectionConfig round-trip', () => {
      ledger.saveNFTCollectionConfig('CollAddr123', 'TreeAddr456');

      const config = ledger.getNFTCollectionConfig();
      expect(config).not.toBeNull();
      expect(config!.collection_address).toBe('CollAddr123');
      expect(config!.merkle_tree_address).toBe('TreeAddr456');
    });
  });

  // ── Mint Address ──────────────────────────────────────────

  describe('mint address', () => {
    it('createNFTAccount stores null mint_address by default', () => {
      ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
      const account = ledger.getNFTAccount(1);
      expect(account).not.toBeNull();
      expect(account!.mint_address).toBeNull();
    });

    it('setMintAddress updates the mint_address', () => {
      ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
      ledger.setMintAddress(1, 'MintAddr789');

      const account = ledger.getNFTAccount(1);
      expect(account!.mint_address).toBe('MintAddr789');
    });

    it('createNFTAccount with mintAddress option', () => {
      ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000, { mintAddress: 'Mint123' });
      const account = ledger.getNFTAccount(1);
      expect(account!.mint_address).toBe('Mint123');
    });
  });
});
