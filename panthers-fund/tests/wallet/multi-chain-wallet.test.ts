import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiChainWallet } from '../../src/wallet/multi-chain-wallet.js';
import { DatabaseLedger } from '../../src/database/ledger.js';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

// Fixed test mnemonic (24 words) for deterministic tests
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

describe('MultiChainWallet', () => {
  // ── Mnemonic Generation ───────────────────────────────────

  describe('mnemonic generation', () => {
    it('create() generates a valid 24-word mnemonic', () => {
      const wallet = MultiChainWallet.create();
      const words = wallet.mnemonic.split(' ');
      expect(words).toHaveLength(24);
      expect(validateMnemonic(wallet.mnemonic, wordlist)).toBe(true);
    });

    it('fromMnemonic() accepts a valid mnemonic', () => {
      const wallet = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
      expect(wallet.mnemonic).toBe(TEST_MNEMONIC);
    });

    it('fromMnemonic() rejects an invalid mnemonic', () => {
      expect(() => MultiChainWallet.fromMnemonic('invalid mnemonic phrase')).toThrow(
        'Invalid BIP39 mnemonic',
      );
    });

    it('two create() calls produce different mnemonics', () => {
      const w1 = MultiChainWallet.create();
      const w2 = MultiChainWallet.create();
      expect(w1.mnemonic).not.toBe(w2.mnemonic);
    });
  });

  // ── Deterministic Derivation ──────────────────────────────

  describe('deterministic derivation', () => {
    let wallet: MultiChainWallet;

    beforeEach(() => {
      wallet = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
    });

    it('derives a Solana address (Base58)', () => {
      expect(wallet.addresses.solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    });

    it('same mnemonic always produces same addresses', () => {
      const wallet2 = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
      expect(wallet2.addresses).toEqual(wallet.addresses);
    });

    it('different mnemonic produces different addresses', () => {
      const other = MultiChainWallet.create();
      expect(other.addresses.solana).not.toBe(wallet.addresses.solana);
    });
  });

  // ── Signer Access ─────────────────────────────────────────

  describe('signer access', () => {
    let wallet: MultiChainWallet;

    beforeEach(() => {
      wallet = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
    });

    it('getSolanaKeypair() returns keypair matching derived address', () => {
      const keypair = wallet.getSolanaKeypair();
      expect(keypair.publicKey.toBase58()).toBe(wallet.addresses.solana);
    });
  });

  // ── DB Persistence ────────────────────────────────────────

  describe('database round-trip', () => {
    let ledger: DatabaseLedger;

    beforeEach(() => {
      ledger = new DatabaseLedger(':memory:');
    });

    afterEach(() => {
      ledger.close();
    });

    it('persistToDB saves and restoreFromDB recovers addresses', () => {
      const wallet = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
      wallet.persistToDB(ledger.db);

      const restored = MultiChainWallet.restoreFromDB(ledger.db);
      expect(restored.mnemonic).toBe(wallet.mnemonic);
      expect(restored.addresses).toEqual(wallet.addresses);
    });

    it('restoreFromDB throws when no wallet exists', () => {
      expect(() => MultiChainWallet.restoreFromDB(ledger.db)).toThrow(
        'No wallet state found in database',
      );
    });

    it('initializeFromDB creates wallet if none exists', () => {
      const wallet = MultiChainWallet.initializeFromDB(ledger.db);
      expect(wallet.mnemonic.split(' ')).toHaveLength(24);

      // Verify it was persisted
      const state = ledger.getWalletState();
      expect(state).not.toBeNull();
      expect(state!.solana_address).toBe(wallet.addresses.solana);
    });

    it('initializeFromDB returns existing wallet without overwriting', () => {
      const original = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
      original.persistToDB(ledger.db);

      const loaded = MultiChainWallet.initializeFromDB(ledger.db);
      expect(loaded.mnemonic).toBe(TEST_MNEMONIC);
      expect(loaded.addresses).toEqual(original.addresses);
    });

    it('getInfo() returns mnemonic and addresses', () => {
      const wallet = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
      const info = wallet.getInfo();
      expect(info.mnemonic).toBe(TEST_MNEMONIC);
      expect(info.addresses.solana).toBe(wallet.addresses.solana);
    });
  });
});
