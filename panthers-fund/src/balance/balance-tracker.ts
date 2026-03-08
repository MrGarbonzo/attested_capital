import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type Database from 'better-sqlite3';
import type { WalletAddresses } from '../wallet/types.js';
import type { TokenBalance, PortfolioView, RpcConfig, PortfolioError } from './types.js';

export const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export class BalanceTracker {
  private readonly addresses: WalletAddresses;
  private readonly rpc: RpcConfig;
  private readonly db: Database.Database;

  constructor(addresses: WalletAddresses, rpc: RpcConfig, db: Database.Database) {
    this.addresses = addresses;
    this.rpc = rpc;
    this.db = db;
  }

  // ── Per-Chain Native Balances ─────────────────────────────

  async getSolanaBalance(): Promise<TokenBalance> {
    const connection = new Connection(this.rpc.solanaRpcUrl, 'confirmed');
    const pubkey = new PublicKey(this.addresses.solana);
    const lamports = await connection.getBalance(pubkey);
    return {
      chain: 'solana',
      tokenSymbol: 'SOL',
      tokenMint: 'So11111111111111111111111111111111111111112',
      amountRaw: String(lamports),
      decimals: 9,
    };
  }

  async getSolanaSPLBalance(mint: string): Promise<TokenBalance> {
    const connection = new Connection(this.rpc.solanaRpcUrl, 'confirmed');
    const owner = new PublicKey(this.addresses.solana);
    const mintPubkey = new PublicKey(mint);

    const ata = getAssociatedTokenAddressSync(mintPubkey, owner);

    try {
      const account = await getAccount(connection, ata);
      // Token mint info for decimals
      const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
      const decimals = (mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } })
        ?.parsed?.info?.decimals ?? 6;

      return {
        chain: 'solana',
        tokenSymbol: mint === USDC_SOLANA ? 'USDC' : mint.slice(0, 6),
        tokenMint: mint,
        amountRaw: String(account.amount),
        decimals,
      };
    } catch {
      // Token account doesn't exist — zero balance
      return {
        chain: 'solana',
        tokenSymbol: mint === USDC_SOLANA ? 'USDC' : mint.slice(0, 6),
        tokenMint: mint,
        amountRaw: '0',
        decimals: 6,
      };
    }
  }

  // ── Aggregation ───────────────────────────────────────────

  async getAllNativeBalances(): Promise<TokenBalance[]> {
    const results = await Promise.allSettled([
      this.getSolanaBalance(),
    ]);

    return results
      .filter((r): r is PromiseFulfilledResult<TokenBalance> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  async getPortfolio(): Promise<PortfolioView> {
    const queries: Promise<TokenBalance>[] = [
      this.getSolanaBalance(),
      this.getSolanaSPLBalance(USDC_SOLANA),
    ];

    const chainLabels: string[] = ['solana', 'solana'];
    const results = await Promise.allSettled(queries);

    const balances: TokenBalance[] = [];
    const errors: PortfolioError[] = [];

    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        balances.push(r.value);
      } else {
        errors.push({
          chain: chainLabels[i] as TokenBalance['chain'],
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    });

    return {
      balances,
      fetchedAt: new Date().toISOString(),
      errors,
    };
  }

  // ── DB Snapshots ──────────────────────────────────────────

  async recordSnapshot(): Promise<void> {
    const portfolio = await this.getPortfolio();

    const insert = this.db.prepare(
      `INSERT INTO balance_snapshots (chain, token_symbol, token_mint, amount_raw, decimals, amount_usd_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const insertMany = this.db.transaction((balances: TokenBalance[]) => {
      for (const b of balances) {
        insert.run(b.chain, b.tokenSymbol, b.tokenMint, b.amountRaw, b.decimals, b.amountUsdCents ?? null);
      }
    });

    insertMany(portfolio.balances);
  }

  getLatestBalances(): TokenBalance[] {
    const rows = this.db.prepare(
      `SELECT bs.*
       FROM balance_snapshots bs
       INNER JOIN (
         SELECT chain, token_symbol, MAX(snapshot_at) AS max_at
         FROM balance_snapshots
         GROUP BY chain, token_symbol
       ) latest ON bs.chain = latest.chain
         AND bs.token_symbol = latest.token_symbol
         AND bs.snapshot_at = latest.max_at
       ORDER BY bs.chain, bs.token_symbol`,
    ).all() as Array<{
      chain: TokenBalance['chain'];
      token_symbol: string;
      token_mint: string;
      amount_raw: string;
      decimals: number;
      amount_usd_cents: number | null;
    }>;

    return rows.map((r) => ({
      chain: r.chain,
      tokenSymbol: r.token_symbol,
      tokenMint: r.token_mint,
      amountRaw: r.amount_raw,
      decimals: r.decimals,
      amountUsdCents: r.amount_usd_cents ?? undefined,
    }));
  }

  getBalanceHistory(chain: string, tokenSymbol: string, limit: number = 50): TokenBalance[] {
    const rows = this.db.prepare(
      `SELECT * FROM balance_snapshots
       WHERE chain = ? AND token_symbol = ?
       ORDER BY snapshot_at DESC
       LIMIT ?`,
    ).all(chain, tokenSymbol, limit) as Array<{
      chain: TokenBalance['chain'];
      token_symbol: string;
      token_mint: string;
      amount_raw: string;
      decimals: number;
      amount_usd_cents: number | null;
    }>;

    return rows.map((r) => ({
      chain: r.chain,
      tokenSymbol: r.token_symbol,
      tokenMint: r.token_mint,
      amountRaw: r.amount_raw,
      decimals: r.decimals,
      amountUsdCents: r.amount_usd_cents ?? undefined,
    }));
  }
}
