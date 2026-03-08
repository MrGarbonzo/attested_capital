export interface WalletState {
  id: number;
  mnemonic: string;
  solana_address: string;
  created_at: string;
  updated_at: string;
}

export interface BalanceSnapshot {
  id: number;
  chain: 'solana';
  token_symbol: string;
  token_mint: string;
  amount_raw: string;
  decimals: number;
  amount_usd_cents: number | null;
  snapshot_at: string;
}
