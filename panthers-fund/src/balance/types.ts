import type { ChainId } from '../wallet/types.js';

export interface TokenBalance {
  chain: ChainId;
  tokenSymbol: string;
  tokenMint: string;
  amountRaw: string;
  decimals: number;
  amountUsdCents?: number;
}

export interface PortfolioView {
  balances: TokenBalance[];
  fetchedAt: string;
  errors: PortfolioError[];
}

export interface PortfolioError {
  chain: ChainId;
  error: string;
}

export interface RpcConfig {
  solanaRpcUrl: string;
}
