import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BalanceTracker, USDC_SOLANA } from '../../src/balance/balance-tracker.js';
import { DatabaseLedger } from '../../src/database/ledger.js';
import type { WalletAddresses } from '../../src/wallet/types.js';
import type { RpcConfig } from '../../src/balance/types.js';

// ── Test Constants ──────────────────────────────────────────

const MOCK_ADDRESSES: WalletAddresses = {
  solana: '9ZNTfG4NyQgxy2SWjSiQoUyBPEvXT2xo7fKc5hPYYJ7b',
};

const MOCK_RPC: RpcConfig = {
  solanaRpcUrl: 'https://mock-sol.test',
};

// ── Mocks ───────────────────────────────────────────────────

// We mock the entire modules to avoid real network calls

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getBalance: vi.fn().mockResolvedValue(5_000_000_000), // 5 SOL
      getParsedAccountInfo: vi.fn().mockResolvedValue({
        value: { data: { parsed: { info: { decimals: 6 } } } },
      }),
    })),
  };
});

vi.mock('@solana/spl-token', async () => {
  const actual = await vi.importActual<typeof import('@solana/spl-token')>('@solana/spl-token');
  return {
    ...actual,
    getAccount: vi.fn().mockResolvedValue({ amount: BigInt(100_000_000) }), // 100 USDC
    getAssociatedTokenAddressSync: actual.getAssociatedTokenAddressSync,
  };
});

describe('BalanceTracker', () => {
  let ledger: DatabaseLedger;
  let tracker: BalanceTracker;

  beforeEach(() => {
    ledger = new DatabaseLedger(':memory:');
    tracker = new BalanceTracker(MOCK_ADDRESSES, MOCK_RPC, ledger.db);
  });

  afterEach(() => {
    ledger.close();
    vi.clearAllMocks();
  });

  // ── Solana Balance Queries ──────────────────────────────

  describe('Solana balance queries', () => {
    it('getSolanaBalance returns SOL balance', async () => {
      const balance = await tracker.getSolanaBalance();
      expect(balance.chain).toBe('solana');
      expect(balance.tokenSymbol).toBe('SOL');
      expect(balance.amountRaw).toBe('5000000000');
      expect(balance.decimals).toBe(9);
    });
  });

  // ── SPL Token Balance ─────────────────────────────────────

  describe('SPL token balance', () => {
    it('getSolanaSPLBalance returns USDC balance', async () => {
      const balance = await tracker.getSolanaSPLBalance(USDC_SOLANA);
      expect(balance.chain).toBe('solana');
      expect(balance.tokenSymbol).toBe('USDC');
      expect(balance.amountRaw).toBe('100000000');
      expect(balance.decimals).toBe(6);
    });

    it('returns zero for non-existent token account', async () => {
      // Override getAccount to throw (token account not found)
      const splToken = await import('@solana/spl-token');
      vi.mocked(splToken.getAccount).mockRejectedValueOnce(new Error('Account not found'));

      const balance = await tracker.getSolanaSPLBalance('FakeMint11111111111111111111111111111111111');
      expect(balance.amountRaw).toBe('0');
    });
  });

  // ── Portfolio Aggregation ─────────────────────────────────

  describe('portfolio aggregation', () => {
    it('getPortfolio returns Solana balances', async () => {
      const portfolio = await tracker.getPortfolio();
      expect(portfolio.balances.length).toBeGreaterThanOrEqual(2);
      expect(portfolio.errors).toHaveLength(0);
      expect(portfolio.fetchedAt).toBeTruthy();

      const sol = portfolio.balances.find(b => b.tokenSymbol === 'SOL');
      expect(sol).toBeDefined();
      expect(sol!.chain).toBe('solana');

      const usdc = portfolio.balances.find(b => b.tokenSymbol === 'USDC');
      expect(usdc).toBeDefined();
    });
  });

  // ── DB Snapshot ───────────────────────────────────────────

  describe('DB snapshots', () => {
    it('recordSnapshot + getLatestBalances round-trip', async () => {
      await tracker.recordSnapshot();
      const latest = tracker.getLatestBalances();
      expect(latest.length).toBeGreaterThanOrEqual(2);

      const sol = latest.find((b) => b.tokenSymbol === 'SOL');
      expect(sol).toBeDefined();
      expect(sol!.amountRaw).toBe('5000000000');
    });

    it('getBalanceHistory returns ordered snapshots', async () => {
      // Record two snapshots
      await tracker.recordSnapshot();
      await tracker.recordSnapshot();

      const history = tracker.getBalanceHistory('solana', 'SOL', 10);
      expect(history.length).toBe(2);
      expect(history[0].chain).toBe('solana');
    });

    it('getLatestBalances returns empty array when no snapshots', () => {
      const latest = tracker.getLatestBalances();
      expect(latest).toEqual([]);
    });
  });
});
