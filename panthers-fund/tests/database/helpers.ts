import { DatabaseLedger } from '../../src/database/ledger.js';
import type { Trade } from '../../src/types/trade.js';

export function createTestLedger(): DatabaseLedger {
  return new DatabaseLedger(':memory:');
}

export function seedAccounts(
  ledger: DatabaseLedger,
  count: number,
  depositCents: number = 5000,
): void {
  for (let i = 1; i <= count; i++) {
    ledger.createNFTAccount(i, `tg_${i}`, `addr_${i}`, depositCents);
  }
}

export function seedAccountsVaried(
  ledger: DatabaseLedger,
  deposits: number[],
): void {
  deposits.forEach((deposit, idx) => {
    ledger.createNFTAccount(idx + 1, `tg_${idx + 1}`, `addr_${idx + 1}`, deposit);
  });
}

export function mockTrade(overrides: Partial<Omit<Trade, 'id' | 'created_at'>> = {}): Omit<Trade, 'id' | 'created_at'> {
  return {
    strategy: 'momentum',
    pair: 'SOL/USDC',
    direction: 'long',
    entry_price: 10000,
    exit_price: 11000,
    amount: 100000,
    profit_loss: 1000,
    signature: `sig_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    attestation: 'attest_test',
    ...overrides,
  };
}
