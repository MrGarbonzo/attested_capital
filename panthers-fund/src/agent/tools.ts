import { readFileSync } from 'fs';
import { Connection } from '@solana/web3.js';
import type { ServiceContext, DiscoveredGuardian } from './context.js';
import { getAllStrategies, getStrategy, getDefaultParams, isAllowedStrategy } from '../strategies/index.js';
import { runTradingCycle } from './trading-engine.js';
import type { VaultClient } from './vault-client.js';
import {
  calculateNFTPrice,
  getNextAvailableTokenId,
  getSalesStats,
  evaluateOffer,
  getBuyerContext,
  createFlashAuction,
  getActiveAuctions,
  cancelAuction,
  ownerHasNFT,
} from './sales.js';
import {
  createListing,
  cancelListing,
  executePurchase,
  getMarketplaceView,
  previewWithdrawal,
  proposeSwap,
  acceptSwap,
  rejectSwap,
  cancelSwap,
  getSwapRequestsView,
} from '../marketplace/index.js';
import type { StakingClient } from './staking-client.js';
import type { TEESigner } from './tee-signing.js';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: string;
  execute: (params: Record<string, unknown>) => Promise<string>;
}

/** Well-known Solana token mint addresses, keyed by uppercase symbol. */
const TOKEN_MINTS: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
};

const MINT_SYMBOLS: Record<string, string> = Object.fromEntries(
  Object.entries(TOKEN_MINTS).map(([sym, mint]) => [mint, sym])
);

function resolveMint(input: string): string {
  const upper = input.trim().toUpperCase();
  return TOKEN_MINTS[upper] ?? input.trim();
}

function mintLabel(mint: string): string {
  return MINT_SYMBOLS[mint] ?? mint.slice(0, 8) + '…';
}

const TOKEN_DECIMALS: Record<string, number> = {
  SOL: 9, USDC: 6, USDT: 6, BONK: 5, JUP: 6, PYTH: 6, RAY: 6, ORCA: 6,
};

function formatAmount(raw: string, mint: string): string {
  const sym = MINT_SYMBOLS[mint];
  const decimals = sym ? TOKEN_DECIMALS[sym] ?? 6 : 6;
  const num = Number(raw) / 10 ** decimals;
  return `${num.toLocaleString('en-US', { maximumFractionDigits: decimals })} ${sym ?? mintLabel(mint)}`;
}

export interface ToolsConfig {
  vaultClient?: VaultClient;
  discoveredGuardians?: Map<string, DiscoveredGuardian>;
  dbPath?: string;
  botHolder?: { bot?: import('grammy').Bot };
  stakingClient?: StakingClient;
  signer?: TEESigner;
}

/** Build the full tool registry from a ServiceContext. */
export function buildTools(ctx: ServiceContext, config?: ToolsConfig): Tool[] {
  return [
    // ── Fund State ──────────────────────────────────────────────
    {
      name: 'get_fund_state',
      description: 'Get current fund state including total pool balance (integer cents), active NFT count, active strategy, and paused status.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'fund',
      async execute() {
        const state = ctx.db.getFundState();
        return JSON.stringify(state, null, 2);
      },
    },
    {
      name: 'set_strategy',
      description: 'Set the active trading strategy. Example: "momentum", "mean-reversion", "hold".',
      parameters: {
        type: 'object',
        properties: {
          strategy: { type: 'string', description: 'Strategy name to set' },
        },
        required: ['strategy'],
      },
      category: 'fund',
      async execute(params) {
        ctx.db.setStrategy(params.strategy as string);
        const state = ctx.db.getFundState();
        return JSON.stringify({ success: true, active_strategy: state.active_strategy });
      },
    },
    {
      name: 'verify_invariants',
      description: 'Run all fund invariant checks: pool balance, account balance, trade allocation consistency. Auto-pauses fund on failure.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'fund',
      async execute() {
        try {
          ctx.db.verifyInvariants();
          return JSON.stringify({ passed: true, message: 'All invariants passed' });
        } catch (err: unknown) {
          const e = err as { invariant?: string; details?: string; message?: string };
          return JSON.stringify({
            passed: false,
            invariant: e.invariant ?? 'unknown',
            details: e.details ?? e.message,
          });
        }
      },
    },
    {
      name: 'unpause_fund',
      description: 'Unpause the fund after invariant violation is resolved. Only do this after verifying invariants pass.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'fund',
      async execute() {
        ctx.db.unpauseFund();
        const state = ctx.db.getFundState();
        return JSON.stringify({ success: true, is_paused: state.is_paused });
      },
    },

    // ── NFT Accounts ────────────────────────────────────────────
    {
      name: 'get_nft_account',
      description: 'Get details of a specific NFT account by token ID. Returns owner info, balances (integer cents), P&L, and active status.',
      parameters: {
        type: 'object',
        properties: {
          token_id: { type: 'number', description: 'NFT token ID (1-500)' },
        },
        required: ['token_id'],
      },
      category: 'accounts',
      async execute(params) {
        const account = ctx.db.getNFTAccount(params.token_id as number);
        if (!account) return JSON.stringify({ error: `No account found for token_id ${params.token_id}` });
        return JSON.stringify(account, null, 2);
      },
    },
    {
      name: 'list_nft_accounts',
      description: 'List all NFT accounts. Set active_only=true to filter to active accounts only.',
      parameters: {
        type: 'object',
        properties: {
          active_only: { type: 'boolean', description: 'If true, only return active accounts', default: false },
        },
        required: [],
      },
      category: 'accounts',
      async execute(params) {
        const accounts = ctx.db.getAllNFTAccounts((params.active_only as boolean) ?? false);
        return JSON.stringify({ count: accounts.length, accounts }, null, 2);
      },
    },
    {
      name: 'create_nft_account',
      description: 'Create a new NFT account. deposit_cents is the initial deposit in INTEGER CENTS (e.g. 10000 = $100.00).',
      parameters: {
        type: 'object',
        properties: {
          token_id: { type: 'number', description: 'NFT token ID (1-500), must be unique' },
          owner_telegram_id: { type: 'string', description: 'Telegram user ID of the owner' },
          owner_address: { type: 'string', description: 'Wallet address of the owner' },
          deposit_cents: { type: 'number', description: 'Initial deposit in integer cents' },
        },
        required: ['token_id', 'owner_telegram_id', 'owner_address', 'deposit_cents'],
      },
      category: 'accounts',
      async execute(params) {
        const ownerTgId = params.owner_telegram_id as string;

        // Enforce 1 NFT per Telegram account
        const existing = ownerHasNFT(ctx.db, ownerTgId);
        if (existing) {
          return JSON.stringify({
            error: `This user already owns NFT #${existing.token_id}. Limit 1 per account.`,
            existingTokenId: existing.token_id,
          });
        }

        const account = ctx.db.createNFTAccount(
          params.token_id as number,
          ownerTgId,
          params.owner_address as string,
          params.deposit_cents as number,
        );
        return JSON.stringify(account, null, 2);
      },
    },
    {
      name: 'add_funds_to_nft',
      description: 'Add additional funds to an existing NFT account. amount_cents in INTEGER CENTS. Requires on-chain tx_hash.',
      parameters: {
        type: 'object',
        properties: {
          token_id: { type: 'number', description: 'NFT token ID' },
          amount_cents: { type: 'number', description: 'Amount to add in integer cents' },
          tx_hash: { type: 'string', description: 'On-chain transaction hash proving the deposit' },
        },
        required: ['token_id', 'amount_cents', 'tx_hash'],
      },
      category: 'accounts',
      async execute(params) {
        const addition = ctx.db.addFundsToNFT(
          params.token_id as number,
          params.amount_cents as number,
          params.tx_hash as string,
        );
        return JSON.stringify(addition, null, 2);
      },
    },

    // ── Trades ──────────────────────────────────────────────────
    {
      name: 'record_trade',
      description: 'Record a completed trade and distribute P&L to all active NFT accounts. All values in INTEGER CENTS. Call verify_invariants after.',
      parameters: {
        type: 'object',
        properties: {
          strategy: { type: 'string', description: 'Strategy that generated this trade' },
          pair: { type: 'string', description: 'Trading pair, e.g. "SOL/USDC"' },
          direction: { type: 'string', enum: ['long', 'short'], description: 'Trade direction' },
          entry_price: { type: 'number', description: 'Entry price in integer cents' },
          exit_price: { type: 'number', description: 'Exit price in integer cents' },
          amount: { type: 'number', description: 'Position size in integer cents' },
          profit_loss: { type: 'number', description: 'Realized P&L in integer cents (negative for loss)' },
          signature: { type: 'string', description: 'On-chain transaction signature' },
          attestation: { type: 'string', description: 'TEE attestation or proof string' },
        },
        required: ['strategy', 'pair', 'direction', 'entry_price', 'exit_price', 'amount', 'profit_loss', 'signature', 'attestation'],
      },
      category: 'trades',
      async execute(params) {
        const trade = ctx.db.recordTrade(params as any);
        return JSON.stringify(trade, null, 2);
      },
    },
    {
      name: 'get_trade_history',
      description: 'Get recent trade history. Returns trades with P&L in integer cents, newest first.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max trades to return (default 50)', default: 50 },
        },
        required: [],
      },
      category: 'trades',
      async execute(params) {
        const trades = ctx.db.getTradeHistory((params.limit as number) ?? 50);
        return JSON.stringify({ count: trades.length, trades }, null, 2);
      },
    },
    {
      name: 'get_trade_allocations',
      description: 'Get P&L allocations for a specific trade, showing distribution across NFT accounts.',
      parameters: {
        type: 'object',
        properties: {
          trade_id: { type: 'number', description: 'ID of the trade' },
        },
        required: ['trade_id'],
      },
      category: 'trades',
      async execute(params) {
        const allocations = ctx.db.getTradeAllocations(params.trade_id as number);
        return JSON.stringify({ trade_id: params.trade_id, count: allocations.length, allocations }, null, 2);
      },
    },

    // ── Wallet ──────────────────────────────────────────────────
    {
      name: 'get_wallet_addresses',
      description: 'Get the fund Solana wallet public address. Does NOT expose private keys.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'wallet',
      async execute() {
        return JSON.stringify({ solana: ctx.wallet.addresses.solana }, null, 2);
      },
    },

    // ── Balances ─────────────────────────────────────────────────
    {
      name: 'get_portfolio',
      description: 'Fetch live Solana balances (SOL + USDC). Returns token balances with raw amounts and decimals.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'balances',
      async execute() {
        const portfolio = await ctx.tracker.getPortfolio();
        return JSON.stringify(portfolio, null, 2);
      },
    },
    {
      name: 'record_balance_snapshot',
      description: 'Record current balances to the database for historical tracking.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'balances',
      async execute() {
        await ctx.tracker.recordSnapshot();
        return JSON.stringify({ success: true, message: 'Balance snapshot recorded' });
      },
    },
    {
      name: 'get_latest_snapshots',
      description: 'Get the most recent balance snapshot for each chain/token from the database.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'balances',
      async execute() {
        const snapshots = ctx.tracker.getLatestBalances();
        return JSON.stringify({ count: snapshots.length, snapshots }, null, 2);
      },
    },
    {
      name: 'get_balance_history',
      description: 'Get historical balance snapshots for a Solana token.',
      parameters: {
        type: 'object',
        properties: {
          token_symbol: { type: 'string', description: 'Token symbol, e.g. "SOL", "USDC"' },
          limit: { type: 'number', description: 'Max records (default 50)', default: 50 },
        },
        required: ['token_symbol'],
      },
      category: 'balances',
      async execute(params) {
        const history = ctx.tracker.getBalanceHistory(
          'solana',
          params.token_symbol as string,
          (params.limit as number) ?? 50,
        );
        return JSON.stringify({ count: history.length, history }, null, 2);
      },
    },

    // ── Strategies ─────────────────────────────────────────────
    {
      name: 'list_strategies',
      description: 'List all 10 available trading strategies with risk level, win rate, and average monthly return.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'strategies',
      async execute() {
        const strategies = getAllStrategies();
        const list = strategies.map((s) => ({
          id: s.meta.id,
          name: s.meta.name,
          riskLevel: s.meta.riskLevel,
          bestFor: s.meta.bestFor,
          winRate: `${(s.meta.winRate * 100).toFixed(0)}%`,
          avgMonthlyReturn: `${(s.meta.avgMonthlyReturn * 100).toFixed(0)}%`,
        }));
        return JSON.stringify({ count: list.length, strategies: list }, null, 2);
      },
    },
    {
      name: 'get_strategy_details',
      description: 'Get detailed info about a specific strategy including parameters and ranges.',
      parameters: {
        type: 'object',
        properties: {
          strategy_id: { type: 'string', description: 'Strategy ID (e.g. "ema_crossover")' },
        },
        required: ['strategy_id'],
      },
      category: 'strategies',
      async execute(params) {
        const id = params.strategy_id as string;
        if (!isAllowedStrategy(id)) {
          return JSON.stringify({ error: `Unknown strategy: ${id}` });
        }
        const s = getStrategy(id);
        return JSON.stringify({
          ...s.meta,
          parameters: s.paramDefs,
          defaultParams: getDefaultParams(id),
        }, null, 2);
      },
    },
    {
      name: 'set_strategy_config',
      description: 'Set the active strategy and its parameters. Strategy must be one of the 10 allowed strategies.',
      parameters: {
        type: 'object',
        properties: {
          strategy_id: { type: 'string', description: 'Strategy ID to activate' },
          parameters: { type: 'object', description: 'Optional parameter overrides (JSON). Omit to use defaults.' },
        },
        required: ['strategy_id'],
      },
      category: 'strategies',
      async execute(params) {
        const id = params.strategy_id as string;
        if (!isAllowedStrategy(id)) {
          return JSON.stringify({ error: `Not an allowed strategy: ${id}` });
        }
        const defaults = getDefaultParams(id);
        const overrides = (params.parameters ?? {}) as Record<string, number>;
        const merged = { ...defaults, ...overrides };
        ctx.db.setStrategyConfig(id, merged);
        return JSON.stringify({ success: true, strategy: id, parameters: merged });
      },
    },
    {
      name: 'get_trading_config',
      description: 'Get the current trading configuration: active strategy, parameters, and last update time.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'strategies',
      async execute() {
        const config = ctx.db.getStrategyConfig();
        const fundState = ctx.db.getFundState();
        return JSON.stringify({
          ...config,
          fundActiveStrategy: fundState.active_strategy,
          isPaused: !!fundState.is_paused,
        }, null, 2);
      },
    },

    // ── Positions ─────────────────────────────────────────────
    {
      name: 'get_open_positions',
      description: 'Get all currently open trading positions.',
      parameters: {
        type: 'object',
        properties: {
          pair: { type: 'string', description: 'Filter by pair (e.g. "SOL/USDC"). Optional.' },
        },
        required: [],
      },
      category: 'trades',
      async execute(params) {
        const positions = ctx.db.getOpenPositions(params.pair as string | undefined);
        return JSON.stringify({ count: positions.length, positions }, null, 2);
      },
    },
    {
      name: 'get_daily_stats',
      description: 'Get trading stats for today (or a specific date): trade count and total P&L.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' },
        },
        required: [],
      },
      category: 'trades',
      async execute(params) {
        const stats = ctx.db.getDailyTradeStats(params.date as string | undefined);
        return JSON.stringify(stats, null, 2);
      },
    },
    {
      name: 'run_trading_cycle',
      description: 'Manually trigger a trading cycle (normally runs every 4 hours). Returns the result without waiting for the next scheduled run.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'trades',
      async execute() {
        const result = await runTradingCycle(ctx);
        return JSON.stringify(result, null, 2);
      },
    },

    // ── AI Sales ─────────────────────────────────────────────────
    {
      name: 'calculate_nft_price',
      description: 'Calculate the current dynamic price for a new NFT. Shows pricing factors: base NAV, sentiment, performance, scarcity, and activity multipliers. Price in INTEGER CENTS.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'sales',
      async execute() {
        const pricing = calculateNFTPrice(ctx.db);
        return JSON.stringify({
          currentPriceCents: pricing.finalPriceCents,
          priceUSD: `$${(pricing.finalPriceCents / 100).toFixed(2)}`,
          factors: {
            baseNavCents: pricing.baseNavCents,
            sentimentMultiplier: pricing.sentimentMultiplier.toFixed(3),
            performanceMultiplier: pricing.performanceMultiplier.toFixed(3),
            scarcityMultiplier: pricing.scarcityMultiplier.toFixed(3),
            activityMultiplier: pricing.activityMultiplier.toFixed(3),
          },
        }, null, 2);
      },
    },
    {
      name: 'get_sales_stats',
      description: 'Get NFT sales statistics: total minted, available, current price, sold-out percentage.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'sales',
      async execute() {
        const stats = getSalesStats(ctx.db);
        return JSON.stringify({
          ...stats,
          currentPriceUSD: `$${(stats.currentPriceCents / 100).toFixed(2)}`,
        }, null, 2);
      },
    },
    {
      name: 'verify_deposit',
      description: 'Verify an on-chain USDC deposit to the fund on Solana. Checks the transaction for USDC transfer to fund address.',
      parameters: {
        type: 'object',
        properties: {
          tx_hash: { type: 'string', description: 'On-chain Solana transaction signature' },
        },
        required: ['tx_hash'],
      },
      category: 'sales',
      async execute(params) {
        const txHash = (params.tx_hash as string).trim();

        // Solana verification
        const fundAddress = ctx.wallet.addresses.solana;
        const USDC_MINT = TOKEN_MINTS.USDC;

        try {
          const connection = new Connection(ctx.rpc.solanaRpcUrl, 'confirmed');
          const tx = await connection.getParsedTransaction(txHash, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });

          if (!tx) {
            return JSON.stringify({ verified: false, error: 'Transaction not found. It may not be confirmed yet — wait a moment and retry.' });
          }

          if (tx.meta?.err) {
            return JSON.stringify({ verified: false, error: 'Transaction failed on-chain.', details: tx.meta.err });
          }

          const pre = tx.meta?.preTokenBalances ?? [];
          const post = tx.meta?.postTokenBalances ?? [];

          // Find USDC token balance changes for the fund address
          const preBalance = pre.find(
            (b) => b.mint === USDC_MINT && b.owner === fundAddress,
          );
          const postBalance = post.find(
            (b) => b.mint === USDC_MINT && b.owner === fundAddress,
          );

          const preBal = preBalance?.uiTokenAmount?.uiAmount ?? 0;
          const postBal = postBalance?.uiTokenAmount?.uiAmount ?? 0;
          const depositUSDC = postBal - preBal;

          if (depositUSDC <= 0) {
            return JSON.stringify({
              verified: false,
              error: `No USDC deposit to fund address ${fundAddress} found in this transaction.`,
              hint: 'Make sure you sent USDC (not SOL) to the correct address.',
            });
          }

          // Find sender address (look for a USDC pre-balance that decreased)
          let fromAddress = 'unknown';
          for (const preEntry of pre) {
            if (preEntry.mint !== USDC_MINT || preEntry.owner === fundAddress) continue;
            const matchingPost = post.find(
              (p) => p.mint === USDC_MINT && p.owner === preEntry.owner,
            );
            const senderPre = preEntry.uiTokenAmount?.uiAmount ?? 0;
            const senderPost = matchingPost?.uiTokenAmount?.uiAmount ?? 0;
            if (senderPre > senderPost) {
              fromAddress = preEntry.owner ?? 'unknown';
              break;
            }
          }

          const amountCents = Math.round(depositUSDC * 100);

          return JSON.stringify({
            verified: true,
            chain: 'solana',
            amount_cents: amountCents,
            amount_usd: `$${depositUSDC.toFixed(2)}`,
            from_address: fromAddress,
            to_address: fundAddress,
            tx_hash: txHash,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ verified: false, error: `RPC error: ${msg}` });
        }
      },
    },
    {
      name: 'purchase_nft',
      description: 'Purchase a new NFT. Auto-assigns next available token ID. Requires buyer Telegram ID, Solana wallet address, deposit in cents, and on-chain tx_hash proving deposit. Use agreed_price_cents if a negotiated price was agreed upon. Mints a compressed NFT (cNFT) to the buyer\'s wallet.',
      parameters: {
        type: 'object',
        properties: {
          buyer_telegram_id: { type: 'string', description: 'Buyer Telegram user ID' },
          buyer_address: { type: 'string', description: 'Buyer Solana wallet address (Phantom, Solflare, etc.)' },
          deposit_cents: { type: 'number', description: 'Deposit amount in integer cents' },
          tx_hash: { type: 'string', description: 'On-chain Solana transaction signature proving deposit' },
          agreed_price_cents: { type: 'number', description: 'Negotiated price in cents if different from market price.' },
        },
        required: ['buyer_telegram_id', 'buyer_address', 'deposit_cents', 'tx_hash'],
      },
      category: 'sales',
      async execute(params) {
        const buyerTgId = params.buyer_telegram_id as string;
        const buyerAddress = params.buyer_address as string;

        // Validate Solana pubkey format (base58, 32-44 chars)
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(buyerAddress)) {
          return JSON.stringify({ error: `Invalid Solana wallet address: ${buyerAddress}` });
        }

        // Enforce 1 NFT per Telegram account
        const existing = ownerHasNFT(ctx.db, buyerTgId);
        if (existing) {
          return JSON.stringify({
            error: `You already own NFT #${existing.token_id}. Limit 1 per account.`,
            existingTokenId: existing.token_id,
          });
        }

        const tokenId = getNextAvailableTokenId(ctx.db);
        if (tokenId === null) {
          return JSON.stringify({ error: 'All NFTs have been minted — sold out!' });
        }

        const MIN_PRICE_CENTS = 100; // $1 absolute floor
        const deposit = params.deposit_cents as number;
        const agreedPrice = params.agreed_price_cents as number | undefined;

        if (agreedPrice !== undefined) {
          // Negotiated price path
          if (agreedPrice < MIN_PRICE_CENTS) {
            return JSON.stringify({
              error: `Agreed price $${(agreedPrice / 100).toFixed(2)} is below the $1 minimum.`,
              minimumCents: MIN_PRICE_CENTS,
            });
          }
          if (deposit < agreedPrice) {
            return JSON.stringify({
              error: `Deposit $${(deposit / 100).toFixed(2)} is below agreed price $${(agreedPrice / 100).toFixed(2)}`,
              agreedPriceCents: agreedPrice,
            });
          }
        } else {
          // Standard market price path
          const pricing = calculateNFTPrice(ctx.db);
          if (deposit < pricing.finalPriceCents) {
            return JSON.stringify({
              error: `Deposit $${(deposit / 100).toFixed(2)} is below current price $${(pricing.finalPriceCents / 100).toFixed(2)}`,
              currentPriceCents: pricing.finalPriceCents,
            });
          }
        }

        // Create the DB account first (ledger is source of truth)
        const account = ctx.db.createNFTAccount(
          tokenId,
          buyerTgId,
          buyerAddress,
          deposit,
        );

        // Mint cNFT to buyer's wallet
        let mintAddress: string | null = null;
        let mintNote: string | undefined;
        if (ctx.nftMinter) {
          try {
            mintAddress = await ctx.nftMinter.mintToUser(buyerAddress, tokenId, deposit);
            ctx.db.setMintAddress(tokenId, mintAddress);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[purchase_nft] cNFT mint failed for token #${tokenId}: ${msg}`);
            mintNote = `On-chain cNFT mint failed: ${msg}. Use retry_mint to retry.`;
          }
        } else {
          mintNote = 'NFT collection not set up yet. Use setup_nft_collection first, then retry_mint.';
        }

        return JSON.stringify({
          success: true,
          message: `NFT #${tokenId} purchased successfully!`,
          account,
          pricePaid: deposit,
          priceUSD: `$${(deposit / 100).toFixed(2)}`,
          ...(mintAddress ? { mint_address: mintAddress } : {}),
          ...(mintNote ? { mint_note: mintNote } : {}),
          ...(agreedPrice !== undefined ? { negotiatedPrice: true, agreedPriceCents: agreedPrice } : {}),
        }, null, 2);
      },
    },
    {
      name: 'evaluate_offer',
      description: 'Get pricing context for a buyer\'s offer. Returns scarcity-aware recommendation with advisory floor, counter-offer, and response hints — YOU decide the final price. This is advisory only.',
      parameters: {
        type: 'object',
        properties: {
          offer_cents: { type: 'number', description: 'Buyer offer in integer cents' },
          buyer_telegram_id: { type: 'string', description: 'Telegram ID of the buyer (optional — enables returning customer detection and personalized thresholds)' },
        },
        required: ['offer_cents'],
      },
      category: 'sales',
      async execute(params) {
        const result = evaluateOffer(
          ctx.db,
          params.offer_cents as number,
          params.buyer_telegram_id as string | undefined,
        );
        return JSON.stringify({
          ...result,
          listedPriceUSD: `$${(result.listedPriceCents / 100).toFixed(2)}`,
          advisoryFloorUSD: `$${(result.advisoryFloorCents / 100).toFixed(2)}`,
          ...(result.counterOfferCents ? { counterOfferUSD: `$${(result.counterOfferCents / 100).toFixed(2)}` } : {}),
        }, null, 2);
      },
    },
    {
      name: 'get_buyer_context',
      description: 'Get full buyer and market context before negotiating. Returns scarcity tier, buyer history, suggested mood, advisory floor price, and negotiation hints. Call this at the START of every sales conversation.',
      parameters: {
        type: 'object',
        properties: {
          buyer_telegram_id: { type: 'string', description: 'Telegram ID of the buyer (optional — enables returning customer detection)' },
        },
        required: [],
      },
      category: 'sales',
      async execute(params) {
        const ctx_result = getBuyerContext(
          ctx.db,
          params.buyer_telegram_id as string | undefined,
        );
        return JSON.stringify({
          ...ctx_result,
          currentPriceUSD: `$${(ctx_result.currentPriceCents / 100).toFixed(2)}`,
          suggestedFloorUSD: `$${(ctx_result.suggestedFloorCents / 100).toFixed(2)}`,
        }, null, 2);
      },
    },
    {
      name: 'send_dm',
      description: 'Send a direct message to a Telegram user. Use this to initiate private NFT sale negotiations.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'Telegram user ID to DM' },
          message: { type: 'string', description: 'Message text to send' },
        },
        required: ['user_id', 'message'],
      },
      category: 'sales',
      async execute(params) {
        const bot = config?.botHolder?.bot;
        if (!bot) {
          return JSON.stringify({ error: 'Bot not available — cannot send DMs' });
        }
        try {
          await bot.api.sendMessage(Number(params.user_id as string), params.message as string);
          return JSON.stringify({ success: true, user_id: params.user_id });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ success: false, error: msg });
        }
      },
    },
    {
      name: 'create_flash_auction',
      description: 'Create a 30-minute flash auction for a new NFT with declining price. Creates FOMO.',
      parameters: {
        type: 'object',
        properties: {
          duration_minutes: { type: 'number', description: 'Auction duration in minutes (default 30)' },
          max_discount_pct: { type: 'number', description: 'Maximum discount percentage (default 15)' },
        },
        required: [],
      },
      category: 'sales',
      async execute(params) {
        const durationMs = ((params.duration_minutes as number) ?? 30) * 60 * 1000;
        const discount = (params.max_discount_pct as number) ?? 15;
        const auction = createFlashAuction(ctx.db, durationMs, discount);
        if (!auction) {
          return JSON.stringify({ error: 'All 500 NFTs are minted — cannot create auction' });
        }
        return JSON.stringify({
          ...auction,
          startPriceUSD: `$${(auction.startPriceCents / 100).toFixed(2)}`,
          expiresIn: `${Math.round((auction.expiresAt - Date.now()) / 60000)} minutes`,
        }, null, 2);
      },
    },
    {
      name: 'get_active_auctions',
      description: 'Get all currently active flash auctions with current prices.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'sales',
      async execute() {
        const auctions = getActiveAuctions();
        return JSON.stringify({ count: auctions.length, auctions }, null, 2);
      },
    },

    // ── P2P Marketplace ─────────────────────────────────────────
    {
      name: 'create_p2p_listing',
      description: 'List an NFT for sale on the P2P marketplace. Only the NFT owner can list. 0% fee.',
      parameters: {
        type: 'object',
        properties: {
          token_id: { type: 'number', description: 'NFT token ID to list' },
          seller_telegram_id: { type: 'string', description: 'Seller Telegram user ID' },
          asking_price_cents: { type: 'number', description: 'Asking price in integer cents' },
        },
        required: ['token_id', 'seller_telegram_id', 'asking_price_cents'],
      },
      category: 'marketplace',
      async execute(params) {
        const result = createListing(
          ctx.db,
          params.token_id as number,
          params.seller_telegram_id as string,
          params.asking_price_cents as number,
        );
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: 'get_marketplace_listings',
      description: 'Get all active P2P marketplace listings with NFT details and value ratios.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'marketplace',
      async execute() {
        const view = getMarketplaceView(ctx.db);
        return JSON.stringify(view, null, 2);
      },
    },
    {
      name: 'cancel_p2p_listing',
      description: 'Cancel an active P2P listing. Only the seller can cancel.',
      parameters: {
        type: 'object',
        properties: {
          listing_id: { type: 'number', description: 'Listing ID to cancel' },
          seller_telegram_id: { type: 'string', description: 'Seller Telegram user ID (for ownership verification)' },
        },
        required: ['listing_id', 'seller_telegram_id'],
      },
      category: 'marketplace',
      async execute(params) {
        const result = cancelListing(
          ctx.db,
          params.listing_id as number,
          params.seller_telegram_id as string,
        );
        return JSON.stringify(result);
      },
    },
    {
      name: 'execute_p2p_purchase',
      description: 'Execute a P2P NFT purchase. Transfers ownership + balance atomically. Requires on-chain tx_signature proving payment. 0% fee.',
      parameters: {
        type: 'object',
        properties: {
          listing_id: { type: 'number', description: 'Listing ID to purchase' },
          buyer_telegram_id: { type: 'string', description: 'Buyer Telegram user ID' },
          buyer_address: { type: 'string', description: 'Buyer wallet address' },
          tx_signature: { type: 'string', description: 'On-chain tx signature proving payment' },
        },
        required: ['listing_id', 'buyer_telegram_id', 'buyer_address', 'tx_signature'],
      },
      category: 'marketplace',
      async execute(params) {
        const result = executePurchase(
          ctx.db,
          params.listing_id as number,
          params.buyer_telegram_id as string,
          params.buyer_address as string,
          params.tx_signature as string,
        );
        return JSON.stringify(result, null, 2);
      },
    },

    // ── Barter / Swaps ────────────────────────────────────────────
    {
      name: 'propose_swap',
      description: 'Propose an NFT-for-NFT swap (barter). No money changes hands — only ownership swaps. Both NFTs keep their balances.',
      parameters: {
        type: 'object',
        properties: {
          proposer_token_id: { type: 'number', description: 'Token ID the proposer is offering' },
          proposer_telegram_id: { type: 'string', description: 'Proposer Telegram user ID' },
          target_token_id: { type: 'number', description: 'Token ID the proposer wants in return' },
        },
        required: ['proposer_token_id', 'proposer_telegram_id', 'target_token_id'],
      },
      category: 'marketplace',
      async execute(params) {
        const result = proposeSwap(
          ctx.db,
          params.proposer_token_id as number,
          params.proposer_telegram_id as string,
          params.target_token_id as number,
        );
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: 'accept_swap',
      description: 'Accept a pending swap request. Atomically exchanges ownership of both NFTs. Only the target holder can accept.',
      parameters: {
        type: 'object',
        properties: {
          swap_id: { type: 'number', description: 'Swap request ID to accept' },
          accepter_telegram_id: { type: 'string', description: 'Accepter Telegram user ID (must be the target)' },
          accepter_address: { type: 'string', description: 'Accepter wallet address' },
        },
        required: ['swap_id', 'accepter_telegram_id', 'accepter_address'],
      },
      category: 'marketplace',
      async execute(params) {
        const result = acceptSwap(
          ctx.db,
          params.swap_id as number,
          params.accepter_telegram_id as string,
          params.accepter_address as string,
        );
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: 'reject_swap',
      description: 'Reject a swap request. Only the target holder can reject.',
      parameters: {
        type: 'object',
        properties: {
          swap_id: { type: 'number', description: 'Swap request ID to reject' },
          rejecter_telegram_id: { type: 'string', description: 'Rejecter Telegram user ID (must be the target)' },
        },
        required: ['swap_id', 'rejecter_telegram_id'],
      },
      category: 'marketplace',
      async execute(params) {
        const result = rejectSwap(
          ctx.db,
          params.swap_id as number,
          params.rejecter_telegram_id as string,
        );
        return JSON.stringify(result);
      },
    },
    {
      name: 'cancel_swap',
      description: 'Cancel your own swap proposal. Only the proposer can cancel.',
      parameters: {
        type: 'object',
        properties: {
          swap_id: { type: 'number', description: 'Swap request ID to cancel' },
          canceller_telegram_id: { type: 'string', description: 'Canceller Telegram user ID (must be the proposer)' },
        },
        required: ['swap_id', 'canceller_telegram_id'],
      },
      category: 'marketplace',
      async execute(params) {
        const result = cancelSwap(
          ctx.db,
          params.swap_id as number,
          params.canceller_telegram_id as string,
        );
        return JSON.stringify(result);
      },
    },
    {
      name: 'get_swap_requests',
      description: 'View pending swap requests. Optionally filter by Telegram user ID to see swaps where the user is proposer or target.',
      parameters: {
        type: 'object',
        properties: {
          telegram_id: { type: 'string', description: 'Optional: filter to swaps involving this user' },
        },
        required: [],
      },
      category: 'marketplace',
      async execute(params) {
        const view = getSwapRequestsView(
          ctx.db,
          params.telegram_id as string | undefined,
        );
        return JSON.stringify(view, null, 2);
      },
    },

    // ── Withdrawals ─────────────────────────────────────────────
    {
      name: 'preview_withdrawal',
      description: 'Preview what a withdrawal would look like: gross amount, 2% fee, net payout, and how many holders receive the fee. All-or-nothing (no partial withdrawals).',
      parameters: {
        type: 'object',
        properties: {
          token_id: { type: 'number', description: 'NFT token ID to withdraw' },
        },
        required: ['token_id'],
      },
      category: 'withdrawal',
      async execute(params) {
        const preview = previewWithdrawal(ctx.db, params.token_id as number);
        if ('error' in preview) {
          return JSON.stringify(preview);
        }
        return JSON.stringify({
          ...preview,
          grossUSD: `$${(preview.grossAmountCents / 100).toFixed(2)}`,
          feeUSD: `$${(preview.feeCents / 100).toFixed(2)}`,
          netUSD: `$${(preview.netAmountCents / 100).toFixed(2)}`,
          note: 'Withdrawal is ALL-OR-NOTHING. Burns the NFT permanently. 2% fee distributed to remaining holders.',
        }, null, 2);
      },
    },
    {
      name: 'execute_withdrawal',
      description: 'Execute an all-or-nothing withdrawal. Burns the NFT (on-chain + DB), takes 2% fee (distributed to remaining holders), pays out 98% on Solana. IRREVERSIBLE.',
      parameters: {
        type: 'object',
        properties: {
          token_id: { type: 'number', description: 'NFT token ID to withdraw' },
          dest_address: { type: 'string', description: 'Destination Solana wallet address' },
          tx_signature: { type: 'string', description: 'On-chain transaction signature of the USDC payout' },
        },
        required: ['token_id', 'dest_address', 'tx_signature'],
      },
      category: 'withdrawal',
      async execute(params) {
        const tokenId = params.token_id as number;

        // Try to burn the on-chain cNFT first (if it exists)
        const account = ctx.db.getNFTAccount(tokenId);
        let burnNote: string | undefined;
        if (account?.mint_address && ctx.nftMinter) {
          try {
            await ctx.nftMinter.burnNFT(account.mint_address);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[execute_withdrawal] cNFT burn failed for token #${tokenId}: ${msg}`);
            burnNote = `On-chain cNFT burn failed: ${msg}. DB withdrawal still recorded (ledger is source of truth).`;
          }
        }

        const withdrawal = ctx.db.recordWithdrawal(
          tokenId,
          params.dest_address as string,
          params.tx_signature as string,
        );
        return JSON.stringify({
          success: true,
          message: `NFT #${tokenId} burned. Withdrawal complete.`,
          withdrawal,
          grossUSD: `$${(withdrawal.amount / 100).toFixed(2)}`,
          feeUSD: `$${(withdrawal.fee / 100).toFixed(2)}`,
          netUSD: `$${(withdrawal.net_amount / 100).toFixed(2)}`,
          ...(burnNote ? { burn_note: burnNote } : {}),
        }, null, 2);
      },
    },

    // ── Jupiter ─────────────────────────────────────────────────
    {
      name: 'get_jupiter_quote',
      description: 'Get a swap quote from Jupiter on Solana. Accepts token symbols (SOL, USDC, USDT, BONK, JUP) or mint addresses. Amount is in smallest unit (1 SOL = 1000000000 lamports).',
      parameters: {
        type: 'object',
        properties: {
          input_token: { type: 'string', description: 'Input token symbol or mint address' },
          output_token: { type: 'string', description: 'Output token symbol or mint address' },
          amount: { type: 'string', description: 'Input amount in smallest unit, as a string' },
          slippage_bps: { type: 'number', description: 'Max slippage in basis points (default 50)', default: 50 },
        },
        required: ['input_token', 'output_token', 'amount'],
      },
      category: 'jupiter',
      async execute(params) {
        const inputMint = resolveMint(params.input_token as string);
        const outputMint = resolveMint(params.output_token as string);
        const quote = await ctx.jupiter.getQuote({
          inputMint,
          outputMint,
          amount: params.amount as string,
          slippageBps: params.slippage_bps as number | undefined,
        });
        const route = (quote.routePlan ?? []).map((r: any) => r.swapInfo?.label).filter(Boolean).join(' → ');
        const summary = {
          input: formatAmount(quote.inAmount, quote.inputMint),
          output: formatAmount(quote.outAmount, quote.outputMint),
          priceImpact: quote.priceImpactPct + '%',
          slippageBps: quote.slippageBps,
          route: route || 'direct',
          usdValue: (quote as any).swapUsdValue ? '$' + Number((quote as any).swapUsdValue).toFixed(2) : undefined,
        };
        return JSON.stringify(summary, null, 2);
      },
    },
    {
      name: 'execute_jupiter_swap',
      description: 'Execute a token swap on Jupiter (Solana). Signs and sends a real on-chain transaction. Irreversible once confirmed. Amount in smallest unit.',
      parameters: {
        type: 'object',
        properties: {
          input_token: { type: 'string', description: 'Input token symbol or mint address' },
          output_token: { type: 'string', description: 'Output token symbol or mint address' },
          amount: { type: 'string', description: 'Input amount in smallest unit, as a string' },
          slippage_bps: { type: 'number', description: 'Max slippage in basis points (default 50)', default: 50 },
        },
        required: ['input_token', 'output_token', 'amount'],
      },
      category: 'jupiter',
      async execute(params) {
        const inputMint = resolveMint(params.input_token as string);
        const outputMint = resolveMint(params.output_token as string);
        const result = await ctx.jupiter.swap({
          inputMint,
          outputMint,
          amount: params.amount as string,
          slippageBps: params.slippage_bps as number | undefined,
        });
        return JSON.stringify(result, null, 2);
      },
    },

    // ── Guardian Network ──────────────────────────────────────────
    {
      name: 'discover_guardians',
      description: 'Send a DISCOVER:REQUEST to the Telegram group and return all currently discovered guardians. Results accumulate from group responses.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'guardian',
      async execute() {
        const guardians = Array.from(ctx.discoveredGuardians.values());
        return JSON.stringify({ count: guardians.length, guardians }, null, 2);
      },
    },
    {
      name: 'announce_agent',
      description: 'Announce this agent to the Telegram group with TEE identity and endpoint. Used for first contact with guardians.',
      parameters: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'This agent\'s HTTP endpoint URL' },
          teeId: { type: 'string', description: 'TEE instance ID' },
          codeHash: { type: 'string', description: 'Running code hash' },
        },
        required: ['endpoint', 'teeId', 'codeHash'],
      },
      category: 'guardian',
      async execute(params) {
        // The actual sending happens via the bot — this tool prepares the data
        return JSON.stringify({
          action: 'announce_agent',
          endpoint: params.endpoint,
          teeId: params.teeId,
          codeHash: params.codeHash,
          note: 'Announcement prepared. Use broadcast_to_guardians to send.',
        });
      },
    },
    {
      name: 'register_with_guardian',
      description: 'Register this agent with a specific guardian via HTTP POST to their /api/peers endpoint.',
      parameters: {
        type: 'object',
        properties: {
          guardian_endpoint: { type: 'string', description: 'Guardian HTTP endpoint' },
          agent_address: { type: 'string', description: 'This agent\'s address/identifier' },
          agent_endpoint: { type: 'string', description: 'This agent\'s HTTP endpoint' },
        },
        required: ['guardian_endpoint', 'agent_address', 'agent_endpoint'],
      },
      category: 'guardian',
      async execute(params) {
        try {
          const res = await fetch(`${params.guardian_endpoint}/api/peers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              address: params.agent_address,
              endpoint: params.agent_endpoint,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          const body = await res.json() as Record<string, unknown>;
          return JSON.stringify({ success: res.ok, status: res.status, body }, null, 2);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ success: false, error: msg });
        }
      },
    },
    {
      name: 'list_guardians',
      description: 'List all discovered/connected guardians and their status.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'guardian',
      async execute() {
        const guardians = Array.from(ctx.discoveredGuardians.values()).map((g) => ({
          ...g,
          age: `${Math.floor((Date.now() - g.discoveredAt) / 60000)}m`,
          lastSeenAgo: `${Math.floor((Date.now() - g.lastSeen) / 1000)}s`,
        }));
        return JSON.stringify({ count: guardians.length, guardians }, null, 2);
      },
    },
    {
      name: 'check_guardian_health',
      description: 'Check a specific guardian\'s /ping endpoint to verify it\'s reachable.',
      parameters: {
        type: 'object',
        properties: {
          guardian_endpoint: { type: 'string', description: 'Guardian HTTP endpoint' },
        },
        required: ['guardian_endpoint'],
      },
      category: 'guardian',
      async execute(params) {
        const endpoint = params.guardian_endpoint as string;
        try {
          const t0 = Date.now();
          const res = await fetch(`${endpoint}/ping`, {
            signal: AbortSignal.timeout(5_000),
          });
          const latency = Date.now() - t0;
          return JSON.stringify({
            reachable: res.ok,
            status: res.status,
            latencyMs: latency,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ reachable: false, error: msg });
        }
      },
    },
    {
      name: 'broadcast_to_guardians',
      description: 'Send a protocol message to the guardian Telegram group.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Protocol message to send (e.g. [DISCOVER:REQUEST])' },
        },
        required: ['message'],
      },
      category: 'guardian',
      async execute(params) {
        if (!ctx.groupChatId) {
          return JSON.stringify({ error: 'No group chat ID configured' });
        }
        return JSON.stringify({
          action: 'broadcast',
          groupChatId: ctx.groupChatId,
          message: params.message,
          note: 'Message queued for broadcast via bot.',
        });
      },
    },

    // ── DB Sync ──────────────────────────────────────────────────
    {
      name: 'trigger_db_sync',
      description: 'Manually trigger an encrypted DB snapshot sync to all discovered guardians. Normally runs hourly via cron.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'guardian',
      async execute() {
        const vc = config?.vaultClient;
        const guardians = config?.discoveredGuardians ?? ctx.discoveredGuardians;
        const dbPath = config?.dbPath;

        if (!vc?.hasVaultKey) {
          return JSON.stringify({ error: 'No vault key available — VaultClient not initialized' });
        }
        if (!dbPath) {
          return JSON.stringify({ error: 'No dbPath configured' });
        }
        if (guardians.size === 0) {
          return JSON.stringify({ error: 'No discovered guardians to sync to' });
        }

        const dbBuffer = readFileSync(dbPath);
        const envelope = await vc.createSnapshot(dbBuffer);
        let ok = 0;
        const results: Array<{ guardian: string; accepted: boolean; error?: string }> = [];

        for (const [addr, g] of guardians) {
          try {
            const res = await fetch(`${g.endpoint.replace(/\/$/, '')}/api/db/snapshot`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(envelope),
              signal: AbortSignal.timeout(30_000),
            });
            const result = await res.json() as { accepted: boolean; error?: string };
            if (result.accepted) ok++;
            results.push({ guardian: addr, accepted: result.accepted, error: result.error });
          } catch (err) {
            results.push({ guardian: addr, accepted: false, error: err instanceof Error ? err.message : String(err) });
          }
        }

        return JSON.stringify({
          success: ok > 0,
          accepted: ok,
          total: guardians.size,
          sequence: vc.currentSequence,
          sizeKB: Math.round(dbBuffer.length / 1024),
          results,
        }, null, 2);
      },
    },

    // ── NFT Collection Admin ────────────────────────────────────
    {
      name: 'setup_nft_collection',
      description: 'One-time setup: create a Metaplex Bubblegum Merkle tree and collection for compressed NFTs. Stores addresses in DB. Requires funded Solana wallet.',
      parameters: {
        type: 'object',
        properties: {
          collection_name: { type: 'string', description: 'Collection name (default: "Panthers Fund")', default: 'Panthers Fund' },
          collection_uri: { type: 'string', description: 'Collection metadata URI (JSON)' },
        },
        required: [],
      },
      category: 'admin',
      async execute(params) {
        if (!ctx.nftMinter) {
          return JSON.stringify({ error: 'NFTMinter not initialized. Check Solana RPC and agent keypair.' });
        }

        const existing = ctx.db.getNFTCollectionConfig();
        if (existing) {
          return JSON.stringify({
            error: 'Collection already set up.',
            collection_address: existing.collection_address,
            merkle_tree_address: existing.merkle_tree_address,
          });
        }

        try {
          const treeAddress = await ctx.nftMinter.setupMerkleTree(14, 64);
          const collectionName = (params.collection_name as string) || 'Panthers Fund';
          const collectionUri = (params.collection_uri as string) || '';
          const collectionAddress = await ctx.nftMinter.setupCollection(collectionName, collectionUri);

          ctx.db.saveNFTCollectionConfig(collectionAddress, treeAddress);

          return JSON.stringify({
            success: true,
            collection_address: collectionAddress,
            merkle_tree_address: treeAddress,
            max_capacity: 16384, // 2^14
          }, null, 2);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ error: `Setup failed: ${msg}` });
        }
      },
    },
    {
      name: 'retry_mint',
      description: 'Retry minting a compressed NFT for an account where the on-chain mint failed. Only works if mint_address is null.',
      parameters: {
        type: 'object',
        properties: {
          token_id: { type: 'number', description: 'NFT token ID to retry minting for' },
        },
        required: ['token_id'],
      },
      category: 'admin',
      async execute(params) {
        const tokenId = params.token_id as number;
        const account = ctx.db.getNFTAccount(tokenId);

        if (!account) {
          return JSON.stringify({ error: `No account found for token_id ${tokenId}` });
        }
        if (account.mint_address) {
          return JSON.stringify({ error: `Token #${tokenId} already has mint_address: ${account.mint_address}` });
        }
        if (!ctx.nftMinter) {
          return JSON.stringify({ error: 'NFTMinter not initialized. Run setup_nft_collection first.' });
        }

        try {
          const mintAddress = await ctx.nftMinter.mintToUser(
            account.owner_address,
            tokenId,
            account.initial_deposit,
          );
          ctx.db.setMintAddress(tokenId, mintAddress);
          return JSON.stringify({
            success: true,
            token_id: tokenId,
            mint_address: mintAddress,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ error: `Mint retry failed: ${msg}` });
        }
      },
    },

    // ── Simulate Trade (testing) ─────────────────────────────────
    {
      name: 'simulate_trade',
      description: 'Simulate a completed trade for testing. Records the trade and distributes P&L to all active NFT accounts without executing a real on-chain swap. All values in INTEGER CENTS.',
      parameters: {
        type: 'object',
        properties: {
          pair: { type: 'string', description: 'Trading pair, e.g. "SOL/USDC"', default: 'SOL/USDC' },
          direction: { type: 'string', enum: ['long', 'short'], description: 'Trade direction', default: 'long' },
          amount: { type: 'number', description: 'Position size in integer cents (e.g. 5000 = $50)' },
          profit_loss: { type: 'number', description: 'Realized P&L in integer cents (positive = profit, negative = loss)' },
          strategy: { type: 'string', description: 'Strategy name (default: active strategy)' },
        },
        required: ['amount', 'profit_loss'],
      },
      category: 'trades',
      async execute(params) {
        const fundState = ctx.db.getFundState();
        const strategyId = (params.strategy as string) || fundState.active_strategy || 'simulated';
        const pair = (params.pair as string) || 'SOL/USDC';
        const direction = ((params.direction as string) || 'long') as 'long' | 'short';
        const amount = params.amount as number;
        const pnl = params.profit_loss as number;

        // Use approximate SOL price for entry/exit
        const entryPrice = 8300; // ~$83 in cents
        const exitPriceCents = direction === 'long'
          ? entryPrice + Math.round((pnl / amount) * entryPrice)
          : entryPrice - Math.round((pnl / amount) * entryPrice);

        const trade = ctx.db.recordTrade({
          strategy: strategyId,
          pair,
          direction,
          entry_price: entryPrice,
          exit_price: exitPriceCents,
          amount,
          profit_loss: pnl,
          signature: `sim_${Date.now().toString(36)}`,
          attestation: 'simulated_trade',
        });

        const accounts = ctx.db.getAllNFTAccounts(true);
        const summary = accounts.map(a => ({
          token_id: a.token_id,
          owner: a.owner_telegram_id,
          balance: `$${(a.current_balance / 100).toFixed(2)}`,
          total_pnl: `$${(a.total_pnl / 100).toFixed(2)}`,
        }));

        return JSON.stringify({
          success: true,
          trade_id: trade.id,
          pair,
          direction,
          amount_usd: `$${(amount / 100).toFixed(2)}`,
          pnl_usd: `$${(pnl / 100).toFixed(2)}`,
          accounts: summary,
          pool_balance: `$${(ctx.db.getFundState().total_pool_balance / 100).toFixed(2)}`,
        }, null, 2);
      },
    },

    // ── Sentiment ──────────────────────────────────────────────

    {
      name: 'get_sentiment',
      description: 'Get the latest sentiment analysis result and 24-hour average score/confidence.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'sentiment',
      async execute() {
        const latest = ctx.db.getSentimentLog(1);
        const avg24h = ctx.db.getSentimentAverage(24);

        return JSON.stringify({
          latest: latest[0] ?? null,
          average_24h: {
            avg_score: avg24h.avgScore,
            avg_confidence: avg24h.avgConfidence,
            sample_count: avg24h.count,
          },
        }, null, 2);
      },
    },
    {
      name: 'get_sentiment_history',
      description: 'Get recent sentiment log entries for review.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of entries to return (default 10, max 50)' },
        },
        required: [],
      },
      category: 'sentiment',
      async execute(params) {
        const limit = Math.min(Number(params.limit) || 10, 50);
        const entries = ctx.db.getSentimentLog(limit);
        return JSON.stringify(entries, null, 2);
      },
    },
    {
      name: 'set_blend_weights',
      description: 'Adjust the strategy/sentiment blend weights. strategyWeight + sentimentWeight must equal 1.0.',
      parameters: {
        type: 'object',
        properties: {
          strategyWeight: { type: 'number', description: 'Weight for strategy signal (0-1, default 0.4)' },
          sentimentWeight: { type: 'number', description: 'Weight for sentiment signal (0-1, default 0.6)' },
          buyThreshold: { type: 'number', description: 'Blended score threshold to trigger buy (default 0.2)' },
          sellThreshold: { type: 'number', description: 'Blended score threshold to trigger sell (default -0.2)' },
          vetoConfidence: { type: 'number', description: 'Min confidence for AI veto (default 0.7)' },
          extremeThreshold: { type: 'number', description: 'Min confidence for extreme override (default 0.85)' },
          extremeScoreMin: { type: 'number', description: 'Min |score| for extreme override (default 0.8)' },
        },
        required: [],
      },
      category: 'sentiment',
      async execute(params) {
        const current = ctx.db.getConfigValue('blend_weights');
        const existing = current ? JSON.parse(current) as Record<string, number> : {};

        const updated: Record<string, number> = { ...existing };
        if (params.strategyWeight !== undefined) updated.strategyWeight = params.strategyWeight as number;
        if (params.sentimentWeight !== undefined) updated.sentimentWeight = params.sentimentWeight as number;
        if (params.buyThreshold !== undefined) updated.buyThreshold = params.buyThreshold as number;
        if (params.sellThreshold !== undefined) updated.sellThreshold = params.sellThreshold as number;
        if (params.vetoConfidence !== undefined) updated.vetoConfidence = params.vetoConfidence as number;
        if (params.extremeThreshold !== undefined) updated.extremeThreshold = params.extremeThreshold as number;
        if (params.extremeScoreMin !== undefined) updated.extremeScoreMin = params.extremeScoreMin as number;

        // Validate weights sum to 1
        if (updated.strategyWeight !== undefined && updated.sentimentWeight !== undefined) {
          const sum = updated.strategyWeight + updated.sentimentWeight;
          if (Math.abs(sum - 1.0) > 0.001) {
            return JSON.stringify({
              error: `strategyWeight (${updated.strategyWeight}) + sentimentWeight (${updated.sentimentWeight}) = ${sum}, must equal 1.0`,
            });
          }
        }

        ctx.db.setConfigValue('blend_weights', JSON.stringify(updated));

        return JSON.stringify({
          success: true,
          blend_weights: updated,
        }, null, 2);
      },
    },

    // ── Staking ──────────────────────────────────────────────────

    {
      name: 'list_sentries',
      description: 'List discovered guardian/sentry nodes with address, endpoint, and verified status.',
      parameters: { type: 'object', properties: {}, required: [] },
      category: 'staking',
      async execute() {
        const guardians = config?.discoveredGuardians;
        if (!guardians || guardians.size === 0) {
          return JSON.stringify({ sentries: [], message: 'No guardians discovered' });
        }
        const list = Array.from(guardians.values()).map(g => ({
          address: g.address,
          endpoint: g.endpoint,
          verified: g.verified,
          isSentry: g.isSentry,
          lastSeen: new Date(g.lastSeen).toISOString(),
        }));
        return JSON.stringify({ sentries: list }, null, 2);
      },
    },
    {
      name: 'get_staking_status',
      description: 'Show staked NFTs for a Telegram user from local cache. Returns token IDs, guardian, staked value, and delegation info.',
      parameters: {
        type: 'object',
        properties: {
          telegram_id: { type: 'string', description: 'Telegram user ID' },
        },
        required: ['telegram_id'],
      },
      category: 'staking',
      async execute(params) {
        const tgId = params.telegram_id as string;
        const states = ctx.db.getStakingStateByOwner(tgId);
        if (states.length === 0) {
          return JSON.stringify({ staked: false, message: 'No staked NFTs found for this user' });
        }
        const totalValue = states.reduce((sum, s) => sum + s.stake_value_cents, 0);
        return JSON.stringify({
          staked: true,
          nfts: states.map(s => ({
            token_id: s.token_id,
            guardian: s.guardian_address,
            value_cents: s.stake_value_cents,
            staked_at: s.staked_at,
            delegated_to: s.delegated_to,
            delegation_expires: s.delegation_expires,
          })),
          total_value_cents: totalValue,
          synced_at: states[0].synced_at,
        }, null, 2);
      },
    },
    {
      name: 'stake_nft',
      description: 'Stake NFTs with a guardian/sentry node. Validates ownership locally then forwards to guardian. Specify token_ids or leave empty to stake all owned NFTs.',
      parameters: {
        type: 'object',
        properties: {
          telegram_id: { type: 'string', description: 'Telegram user ID (owner)' },
          token_ids: { type: 'array', items: { type: 'number' }, description: 'Specific token IDs to stake (optional, omit to stake all)' },
          guardian_address: { type: 'string', description: 'Guardian address to stake with (optional, uses first verified)' },
        },
        required: ['telegram_id'],
      },
      category: 'staking',
      async execute(params) {
        const sc = config?.stakingClient;
        const guardians = config?.discoveredGuardians;
        if (!sc || !guardians || guardians.size === 0) {
          return JSON.stringify({ error: 'Staking not available: no guardians discovered' });
        }

        const tgId = params.telegram_id as string;
        const preferAddr = params.guardian_address as string | undefined;

        // Pick guardian
        let guardian: DiscoveredGuardian | undefined;
        if (preferAddr) {
          guardian = guardians.get(preferAddr);
        } else {
          guardian = Array.from(guardians.values()).find(g => g.verified);
        }
        if (!guardian) {
          return JSON.stringify({ error: 'No verified guardian found' });
        }

        // Resolve token IDs
        let tokenIds = params.token_ids as number[] | undefined;
        if (!tokenIds || tokenIds.length === 0) {
          const owned = ctx.db.getNFTsByOwner(tgId);
          if (owned.length === 0) {
            return JSON.stringify({ error: 'No active NFTs found for this user' });
          }
          tokenIds = owned.map(a => a.token_id);
        } else {
          // Validate ownership locally
          for (const tid of tokenIds) {
            const acct = ctx.db.getNFTAccount(tid);
            if (!acct || !acct.is_active || acct.owner_telegram_id !== tgId) {
              return JSON.stringify({ error: `You don't own active NFT #${tid}` });
            }
          }
        }

        try {
          const result = await sc.stakeNFTs(guardian.endpoint, guardian.address, tgId, tokenIds);

          // Cache successful stakes locally
          for (const tid of result.staked) {
            const acct = ctx.db.getNFTAccount(tid);
            ctx.db.upsertStakingState({
              token_id: tid,
              owner_tg_id: tgId,
              guardian_address: guardian.address,
              guardian_endpoint: guardian.endpoint,
              staked_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
              stake_value_cents: acct?.current_balance ?? 0,
              delegated_to: null,
              delegation_expires: null,
            });
          }

          return JSON.stringify({
            success: true,
            guardian: guardian.address,
            staked: result.staked,
            failed: result.failed,
          }, null, 2);
        } catch (err) {
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      name: 'unstake_nft',
      description: 'Remove all stakes for a user from a guardian. Note: 7-day restake cooldown applies after unstaking.',
      parameters: {
        type: 'object',
        properties: {
          telegram_id: { type: 'string', description: 'Telegram user ID (owner)' },
          guardian_address: { type: 'string', description: 'Guardian to unstake from (optional, uses first verified)' },
        },
        required: ['telegram_id'],
      },
      category: 'staking',
      async execute(params) {
        const sc = config?.stakingClient;
        const guardians = config?.discoveredGuardians;
        if (!sc || !guardians || guardians.size === 0) {
          return JSON.stringify({ error: 'Staking not available: no guardians discovered' });
        }

        const tgId = params.telegram_id as string;
        const preferAddr = params.guardian_address as string | undefined;

        let guardian: DiscoveredGuardian | undefined;
        if (preferAddr) {
          guardian = guardians.get(preferAddr);
        } else {
          guardian = Array.from(guardians.values()).find(g => g.verified);
        }
        if (!guardian) {
          return JSON.stringify({ error: 'No verified guardian found' });
        }

        try {
          const result = await sc.unstake(guardian.endpoint, guardian.address, tgId);

          // Clear local cache
          const cached = ctx.db.getStakingStateByOwner(tgId);
          for (const s of cached) {
            if (s.guardian_address === guardian.address) {
              ctx.db.clearStakingState(s.token_id);
            }
          }

          return JSON.stringify({
            success: true,
            guardian: guardian.address,
            unstaked: result.unstaked,
            note: 'A 7-day cooldown now applies before re-staking these tokens with this guardian.',
          }, null, 2);
        } catch (err) {
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      name: 'delegate_voting_power',
      description: 'Delegate voting power from your staked NFTs to a sentry address. Creates a signed delegation on the guardian.',
      parameters: {
        type: 'object',
        properties: {
          telegram_id: { type: 'string', description: 'Telegram user ID (delegator)' },
          sentry_address: { type: 'string', description: 'Sentry address to delegate to' },
          expires_in_days: { type: 'number', description: 'Delegation duration in days (default 30)' },
        },
        required: ['telegram_id', 'sentry_address'],
      },
      category: 'staking',
      async execute(params) {
        const guardians = config?.discoveredGuardians;
        const signerInst = config?.signer;
        if (!guardians || guardians.size === 0) {
          return JSON.stringify({ error: 'No guardians discovered' });
        }

        const tgId = params.telegram_id as string;
        const sentryAddr = params.sentry_address as string;
        const days = (params.expires_in_days as number) || 30;

        // Get staked NFTs for this user from local cache
        const stakes = ctx.db.getStakingStateByOwner(tgId);
        if (stakes.length === 0) {
          return JSON.stringify({ error: 'No staked NFTs found — stake your NFTs first' });
        }

        const tokenIds = stakes.map(s => s.token_id);
        const totalValue = stakes.reduce((sum, s) => sum + s.stake_value_cents, 0);
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
          .toISOString().replace('T', ' ').slice(0, 19);

        // Sign the delegation
        const delegationPayload = JSON.stringify({ delegatorTgId: tgId, sentryAddress: sentryAddr, nftTokenIds: tokenIds, expiresAt });
        let signature = 'unsigned';
        if (signerInst) {
          signature = await signerInst.sign(delegationPayload);
        }

        // Find a guardian with the delegation endpoint
        const guardian = stakes[0];

        try {
          const res = await fetch(`${guardian.guardian_endpoint.replace(/\/$/, '')}/api/delegations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              delegatorTgId: tgId,
              sentryAddress: sentryAddr,
              nftTokenIds: tokenIds,
              totalValue,
              signature,
              expiresAt,
            }),
            signal: AbortSignal.timeout(10_000),
          });

          if (!res.ok) {
            const body = await res.json() as { error?: string };
            return JSON.stringify({ error: body.error ?? `Guardian returned ${res.status}` });
          }
          const result = await res.json() as { id: number };

          // Update local cache with delegation info
          for (const s of stakes) {
            ctx.db.upsertStakingState({
              ...s,
              delegated_to: sentryAddr,
              delegation_expires: expiresAt,
            });
          }

          return JSON.stringify({
            success: true,
            delegation_id: result.id,
            delegated_to: sentryAddr,
            token_ids: tokenIds,
            total_value_cents: totalValue,
            expires_at: expiresAt,
          }, null, 2);
        } catch (err) {
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
  ];
}
