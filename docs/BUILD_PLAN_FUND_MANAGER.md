# 🐆 Panthers Fund Manager - Build Plan

**Project:** Panthers Fund - Autonomous Trading Agent  
**Timeline:** 10 weeks to production launch  
**Foundation:** OpenClaw framework + custom tools

---

## 📋 What We're Building

**The Fund Manager** is the autonomous trading bot that:
- Manages 500 separate NFT accounts (each with dynamic balance)
- Executes trades every 4 hours using 10 strategies
- Sells NFTs via AI agent (dynamic pricing, auctions, negotiations)
- Handles P2P marketplace and withdrawals
- Runs in TEE with cryptographic attestation
- Operates fully autonomously (zero human control)

**Infrastructure:** SecretVM (Intel TDX) + SQLite + Telegram Bot

---

## 🏗️ Project Structure

```
C:\dev\attested_capital\panthers-fund\

├─ tools/                          ⭐ 8 CUSTOM OPENCLAW TOOLS
│  ├─ 00-database-ledger.ts        Week 1: NFT accounts + invariants
│  ├─ 01-multi-chain-wallet.ts     Week 2: BIP39 → 4 chains
│  ├─ 02-trading-engine.ts         Weeks 3-5: Execute trades
│  ├─ 03-ai-sales-agent.ts         Weeks 6-7: Dynamic NFT pricing
│  ├─ 04-balance-tracker.ts        Week 2: Multi-chain balances
│  ├─ 05-governance.ts             Week 7: Strategy voting
│  ├─ 06-p2p-marketplace.ts        Week 8: NFT trading
│  ├─ 07-withdrawal.ts             Week 8: Exit with 2% fee
│  └─ 08-guardian-coordinator.ts   Week 9: Broadcast to guardians
│
├─ strategies/                     ⭐ 10 TRADING STRATEGIES
│  ├─ conservative/
│  │  ├─ rsi-mean-reversion.ts
│  │  ├─ bollinger-bands.ts
│  │  ├─ dca-accumulator.ts
│  │  └─ hodl-patience.ts
│  ├─ moderate/
│  │  ├─ ema-crossover.ts
│  │  ├─ supertrend.ts
│  │  ├─ macd-momentum.ts
│  │  └─ multi-timeframe.ts
│  └─ aggressive/
│     ├─ quick-scalp.ts
│     └─ breakout-trader.ts
│
├─ cron/                           ⭐ SCHEDULED JOBS
│  ├─ trading-cycle.ts             Every 4 hours
│  ├─ balance-sync.ts              Hourly
│  ├─ guardian-broadcast.ts        Hourly
│  └─ health-check.ts              Every 10 min
│
├─ lib/
│  ├─ attestation.ts               TEE attestation generation
│  ├─ attestation-channel.ts       Attested message signing for guardians
│  ├─ validators.ts                Input validation
│  └─ jupiter-client.ts            Solana DEX integration
│
├─ types/
│  ├─ nft-account.ts
│  ├─ trade.ts
│  ├─ strategy.ts
│  └─ guardian.ts
│
├─ workspace/
│  └─ panthers.db                  SQLite database (single source of truth)
│
├─ config/
│  ├─ trading-config.json          Hot-reloadable config
│  └─ risk-limits.json             Hard limits (unchangeable)
│
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  └─ e2e/
│
├─ Dockerfile                      TEE deployment
├─ package.json
└─ tsconfig.json
```

---

## ⚡ CRITICAL: Separate Account Model

### **Each NFT = Separate Trading Account**

```typescript
// NOT pooled NAV (Ponzi structure):
// ❌ total_balance / total_nfts = nav_per_nft

// Instead: Each NFT tracks own balance
interface NFTAccount {
  token_id: number;                // 1-500
  owner_telegram_id: string;
  owner_address: string;           // Wallet address
  initial_deposit: number;         // What they paid (can increase via addFunds)
  current_balance: number;         // DYNAMIC: changes with every trade
  total_pnl: number;              // Cumulative profit/loss
  created_at: number;
  last_updated: number;
}

// Trade P&L distributed proportionally based on current_balance
// Alice ($100 balance) and Bob ($900 balance) in $1000 pool
// Trade makes $50 profit:
//   Alice gets: $50 × ($100/$1000) = $5
//   Bob gets: $50 × ($900/$1000) = $45
// Fair! Both earned 5% on their balance
```

### **Users Can Add Funds Anytime**

```typescript
// Alice owns NFT #123 with current_balance = $73
// Alice deposits $200 more USDC on-chain
// Fund Manager verifies deposit and updates:

UPDATE nft_accounts
SET initial_deposit = initial_deposit + 200,  // $50 → $250
    current_balance = current_balance + 200   // $73 → $273
WHERE token_id = 123;

// Alice now has $273 exposed to fund performance
// Next trade distributes P&L based on new $273 balance
```

---

## 📅 10-Week Build Timeline

### **Week 1: Database Ledger** ⚠️ MOST CRITICAL

**File:** `tools/00-database-ledger.ts`

**Core Functions:**
```typescript
class DatabaseLedger {
  // NFT ACCOUNTS
  async createNFTAccount(tokenId: number, deposit: number)
  async getNFTAccount(tokenId: number): Promise<NFTAccount>
  async getAllNFTAccounts(): Promise<NFTAccount[]>
  async updateNFTBalance(tokenId: number, pnl: number)
  async addFundsToNFT(tokenId: number, amount: number, txHash: string)
  
  // TRADES
  async recordTrade(trade: Trade)
  async distributeTradePnL(profitLoss: number)
  async getTradeHistory(limit?: number): Promise<Trade[]>
  
  // WITHDRAWALS (all-or-nothing)
  async recordWithdrawal(tokenId: number)
  async distributeWithdrawalFee(fee: number, burnedTokenId: number)
  
  // P2P SALES (NFT + balance transfer together)
  async recordP2PSale(tokenId: number, seller: string, buyer: string, price: number)
  async transferNFTOwnership(tokenId: number, newOwner: string)
  
  // INVARIANTS (verify after EVERY operation)
  async verifyInvariants(): Promise<boolean>
}
```

**Database Schema:**
```sql
CREATE TABLE nft_accounts (
  token_id INTEGER PRIMARY KEY CHECK (token_id >= 1 AND token_id <= 500),
  owner_telegram_id TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  initial_deposit REAL NOT NULL CHECK (initial_deposit > 0),
  current_balance REAL NOT NULL CHECK (current_balance >= 0),
  total_pnl REAL NOT NULL,
  created_at INTEGER NOT NULL,
  last_updated INTEGER NOT NULL
);

CREATE TABLE fund_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_pool_balance REAL NOT NULL,
  total_nfts_minted INTEGER NOT NULL CHECK (total_nfts_minted <= 500),
  active_strategy TEXT NOT NULL,
  last_updated INTEGER NOT NULL
);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  strategy TEXT NOT NULL,
  action TEXT CHECK (action IN ('buy', 'sell')),
  pair TEXT NOT NULL,
  pool_amount_traded REAL NOT NULL,
  amount_in REAL NOT NULL,
  amount_out REAL NOT NULL,
  price REAL NOT NULL,
  profit_loss REAL NOT NULL,
  signature TEXT NOT NULL UNIQUE,
  attestation TEXT NOT NULL
);

CREATE TABLE trade_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL,
  nft_token_id INTEGER NOT NULL,
  nft_allocation REAL NOT NULL,
  pnl_share REAL NOT NULL,
  FOREIGN KEY (trade_id) REFERENCES trades(id),
  FOREIGN KEY (nft_token_id) REFERENCES nft_accounts(token_id)
);

CREATE TABLE withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nft_token_id INTEGER NOT NULL UNIQUE,
  telegram_id TEXT NOT NULL,
  initial_deposit REAL NOT NULL,
  final_balance REAL NOT NULL,
  withdrawal_amount REAL NOT NULL,
  fee_amount REAL NOT NULL,
  destination_chain TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  tx_signature TEXT NOT NULL,
  FOREIGN KEY (nft_token_id) REFERENCES nft_accounts(token_id)
);

CREATE TABLE p2p_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nft_token_id INTEGER NOT NULL,
  seller_telegram_id TEXT NOT NULL,
  buyer_telegram_id TEXT NOT NULL,
  sale_price REAL NOT NULL,
  nft_balance REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  tx_signature TEXT NOT NULL,
  FOREIGN KEY (nft_token_id) REFERENCES nft_accounts(token_id)
);

CREATE TABLE fund_additions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nft_token_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (nft_token_id) REFERENCES nft_accounts(token_id)
);

CREATE TABLE p2p_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nft_token_id INTEGER NOT NULL UNIQUE,
  seller TEXT NOT NULL,
  seller_address TEXT NOT NULL,
  asking_price REAL NOT NULL CHECK (asking_price > 0),
  current_balance REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'sold', 'cancelled')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (nft_token_id) REFERENCES nft_accounts(token_id)
);
```

**Critical: Invariant Checks (Integer Arithmetic)**
```typescript
async verifyInvariants(): Promise<boolean> {
  // Use CENTS (integers) to avoid floating point drift
  
  // 1. Sum of NFT balances = Total pool
  const nftSumCents = await db.query(
    'SELECT SUM(current_balance * 100) FROM nft_accounts'
  );
  const poolCents = await db.query(
    'SELECT total_pool_balance * 100 FROM fund_state'
  );
  
  if (Math.abs(nftSumCents - poolCents) > 1) { // Allow 1 cent difference
    console.error('INVARIANT 1 FAILED: Sum != Pool');
    return false;
  }
  
  // 2. Each NFT: current_balance = initial_deposit + total_pnl
  const nfts = await db.query('SELECT * FROM nft_accounts');
  for (const nft of nfts) {
    const expectedCents = Math.round((nft.initial_deposit + nft.total_pnl) * 100);
    const actualCents = Math.round(nft.current_balance * 100);
    
    if (Math.abs(expectedCents - actualCents) > 1) {
      console.error(`INVARIANT 2 FAILED: NFT ${nft.token_id}`);
      return false;
    }
  }
  
  // 3. Trade allocations sum to trade P&L
  const trades = await db.query('SELECT id, profit_loss FROM trades');
  for (const trade of trades) {
    const allocSumCents = await db.query(`
      SELECT SUM(pnl_share * 100) FROM trade_allocations 
      WHERE trade_id = ?
    `, [trade.id]);
    const tradeCents = Math.round(trade.profit_loss * 100);
    
    if (Math.abs(allocSumCents - tradeCents) > 1) {
      console.error(`INVARIANT 3 FAILED: Trade ${trade.id}`);
      return false;
    }
  }
  
  return true;
}
```

**Success Criteria:**
- ✅ Can run 1000 operations with zero drift
- ✅ All 3 invariants pass after every operation
- ✅ Transaction rollback works
- ✅ Add funds works correctly

---

### **Week 2: Multi-Chain Wallets + Balance Tracker**

**Files:** `tools/01-multi-chain-wallet.ts`, `tools/04-balance-tracker.ts`

**BIP39 Multi-Chain Derivation:**
```typescript
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

class MultiChainWallet {
  private mnemonic: string;
  private seed: Buffer;
  
  async initialize() {
    // ONE seed → 4 wallets
    this.mnemonic = bip39.generateMnemonic();
    this.seed = bip39.mnemonicToSeedSync(this.mnemonic);
    
    // Derive wallets
    this.wallets = {
      solana: this.deriveSolana(),
      secret: this.deriveSecret(),
      base: this.deriveBase(),
      ethereum: this.deriveEthereum()
    };
    
    // Backup mnemonic to guardians (via attested signed channel)
    await this.broadcastToGuardians({ type: 'SEED_BACKUP', mnemonic: this.mnemonic });
  }
  
  private deriveSolana() {
    const path = "m/44'/501'/0'/0/0";
    const derivedSeed = derivePath(path, this.seed.toString('hex')).key;
    return Keypair.fromSeed(derivedSeed);
  }
  
  // Similar for other chains...
}
```

**Jupiter Swap (Solana DEX):**
```typescript
async executeSwap(params: SwapParams): Promise<SwapResult> {
  // 1. Get quote
  const quote = await fetch(`https://quote-api.jup.ag/v6/quote`, {
    method: 'GET',
    params: {
      inputMint: USDC_MINT,
      outputMint: params.outputToken,
      amount: params.amountCents, // In lamports/smallest unit
      slippageBps: 50 // 0.5%
    }
  });
  
  // 2. Get swap transaction
  const { swapTransaction } = await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: this.wallets.solana.publicKey })
  });
  
  // 3. Sign and send
  const tx = Transaction.from(Buffer.from(swapTransaction, 'base64'));
  const signature = await this.wallets.solana.sendTransaction(tx);
  
  // 4. Wait for finality (13 seconds, not just 'confirmed')
  await connection.confirmTransaction(signature, 'finalized');
  
  // 5. Calculate actual P&L
  const profit_loss = actualOut - expectedOut;
  
  return { signature, profit_loss };
}
```

**Success Criteria:**
- ✅ One seed generates 4 working wallets
- ✅ Can execute swap on Jupiter
- ✅ Seed backed up to guardians via attested channel

---

### **Weeks 3-5: Trading Engine + 10 Strategies**

**File:** `tools/02-trading-engine.ts`

**Trading Cycle (Every 4 Hours):**
```typescript
import cron from 'node-cron';

cron.schedule('0 */4 * * *', async () => {
  console.log('Starting trading cycle...');
  
  // 1. Load current strategy
  const config = await loadConfig();
  const strategy = STRATEGIES[config.active_strategy];
  
  // 2. Get market data
  const prices = await getPrices(['SOL/USDC', 'BTC/USDC', 'ETH/USDC']);
  
  // 3. Execute strategy
  const signal = await strategy.execute(prices, config.params);
  
  if (signal.action === 'hold') {
    console.log('Strategy says HOLD - no trade');
    return;
  }
  
  // 4. Execute trade
  const trade = await wallet.executeSwap({
    outputToken: signal.token,
    amountCents: totalPool * signal.position_size,
    slippageBps: 50
  });
  
  // 5. Record trade (distributes P&L to all NFTs)
  await database.recordTrade(trade);
  
  // 6. CRITICAL: Verify invariants
  if (!await database.verifyInvariants()) {
    await emergencyPause();
    await alertGuardians('INVARIANT_VIOLATION');
    throw new Error('INVARIANTS FAILED');
  }
  
  // 7. Broadcast to guardians
  await guardianCoordinator.broadcast({
    type: 'TRADE_COMPLETE',
    trade,
    attestation: await generateAttestation(trade)
  });
  
  console.log(`Trade complete: ${signal.action} ${signal.token}, P&L: $${trade.profit_loss}`);
});
```

**10 Strategies (See STRATEGIES.md for implementations):**
- Conservative: RSI, Bollinger, DCA, HODL
- Moderate: EMA, Supertrend, MACD, Multi-TF
- Aggressive: Scalp, Breakout

**Success Criteria:**
- ✅ All 10 strategies backtest (50%+ win rate)
- ✅ Cron executes reliably
- ✅ 100 cycles with zero drift

---

### **Weeks 6-7: AI Sales Agent**

**File:** `tools/03-ai-sales-agent.ts`

**Dynamic Pricing:**
```typescript
class AISalesAgent {
  async calculatePrice(tokenId: number): Promise<number> {
    // Base: Current NAV of similar NFTs
    const avgBalance = await this.getAverageBalance();
    let price = avgBalance;
    
    // Sentiment multiplier (Twitter, Telegram)
    const sentiment = await this.analyzeSentiment();
    price *= (1 + sentiment * 0.5); // ±50% based on sentiment
    
    // Performance multiplier
    const performance = await this.getFundPerformance();
    price *= (1 + performance); // Recent returns
    
    // Scarcity multiplier
    const remaining = 500 - await this.getTotalMinted();
    const scarcityBonus = 1 + (1 - remaining / 500) * 0.3; // Up to 30% more as sold out
    price *= scarcityBonus;
    
    // Activity multiplier
    const activity = await this.getTelegramActivity();
    price *= (1 + activity * 0.2); // Up to 20% more if active
    
    return Math.round(price * 100) / 100;
  }
  
  async handlePurchase(userId: string, tokenId: number) {
    const price = await this.calculatePrice(tokenId);
    
    // Send invoice
    await telegram.sendInvoice(userId, {
      title: `Panther NFT #${tokenId}`,
      description: `Join Panthers Fund with $${price}`,
      amount: price * 100, // Cents
      currency: 'USD'
    });
    
    // On payment success:
    // 1. Mint NFT
    // 2. Create account in database
    // 3. Verify deposit on-chain
  }
}
```

**Success Criteria:**
- ✅ Prices adjust based on market conditions
- ✅ Can sell all 500 NFTs
- ✅ Each purchase creates separate account

---

### **Week 8: P2P Marketplace + Withdrawals**

**Files:** `tools/06-p2p-marketplace.ts`, `tools/07-withdrawal.ts`

**NFT Contract Note:**
```typescript
// Panthers NFT contract on Secret Network
// Contract specification will be provided separately
// Functions used: ownerOf(), burn(), transferFrom()
// For now, assume standard ERC-721-like interface:
interface NFTContract {
  ownerOf(tokenId: number): Promise<string>;
  burn(tokenId: number): Promise<void>;
  transferFrom(from: string, to: string, tokenId: number): Promise<void>;
}
```

**P2P Sale (0% Fee) - Fund Manager Escrow:**
```typescript
async listForSale(tokenId: number, askingPrice: number) {
  const account = await db.getNFTAccount(tokenId);

  await db.execute(`
    INSERT INTO p2p_listings (nft_token_id, seller, asking_price, current_balance, status)
    VALUES (?, ?, ?, ?, 'active')
  `, [tokenId, account.owner_telegram_id, askingPrice, account.current_balance]);

  await telegram.broadcast(`
🏷️ NFT #${tokenId} For Sale

Price: $${askingPrice}
Current Balance: $${account.current_balance}
Profit if bought now: $${account.current_balance - askingPrice}

Buy: /buy ${tokenId}
  `);
}

// Fund Manager acts as escrow:
// 1. Buyer sends funds TO the fund (on-chain, verified)
// 2. Fund Manager verifies deposit
// 3. Fund Manager transfers NFT ownership + balance in database
// 4. No direct buyer-seller payment — fund handles it all
async executePurchase(tokenId: number, buyerTelegramId: string, txHash: string) {
  const listing = await db.getListing(tokenId);

  // Verify buyer's deposit on-chain
  const deposit = await verifyOnChainDeposit(txHash, listing.asking_price);
  if (!deposit.verified) throw new Error('Deposit not verified');

  await db.transaction(async () => {
    // Transfer ownership in database
    await db.transferNFTOwnership(tokenId, buyerTelegramId);

    // Send listing price to seller (from fund wallet)
    await wallet.transfer(listing.seller_address, listing.asking_price);

    // Record the sale
    await db.execute(`
      INSERT INTO p2p_sales (nft_token_id, seller_telegram_id, buyer_telegram_id, sale_price, nft_balance, timestamp, tx_signature)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [tokenId, listing.seller, buyerTelegramId, listing.asking_price, listing.current_balance, Date.now(), txHash]);

    // Mark listing as sold
    await db.execute(`UPDATE p2p_listings SET status = 'sold' WHERE nft_token_id = ?`, [tokenId]);
  });
}
```

**Withdrawal (2% Fee, All-or-Nothing):**
```typescript
async withdraw(tokenId: number, destinationChain: string, destinationAddress: string) {
  const account = await db.getNFTAccount(tokenId);
  const balance = account.current_balance;
  
  // Calculate fee
  const fee = balance * 0.02; // 2%
  const userReceives = balance - fee;
  
  // 1. Burn NFT
  await nftContract.burn(tokenId);
  
  // 2. Send USDC to user
  await wallet[destinationChain].transfer(destinationAddress, userReceives);
  
  // 3. Distribute fee to remaining holders
  await db.distributeWithdrawalFee(fee, tokenId);
  
  // 4. Update database (ATOMIC)
  await db.transaction(async () => {
    await db.execute('DELETE FROM nft_accounts WHERE token_id = ?', [tokenId]);
    await db.execute(`
      UPDATE fund_state 
      SET total_pool_balance = total_pool_balance - ?,
          total_nfts_minted = total_nfts_minted - 1
    `, [balance]);
    
    await db.execute(`
      INSERT INTO withdrawals (nft_token_id, final_balance, fee_amount, user_received)
      VALUES (?, ?, ?, ?)
    `, [tokenId, balance, fee, userReceives]);
  });
  
  // 5. Verify invariants
  if (!await db.verifyInvariants()) {
    throw new Error('INVARIANT VIOLATION AFTER WITHDRAWAL');
  }
}
```

**Success Criteria:**
- ✅ P2P sales work (NFT + balance transfer)
- ✅ Withdrawals burn NFT, distribute fee
- ✅ No partial withdrawals possible

---

### **Week 9: Guardian Coordinator**

**File:** `tools/08-guardian-coordinator.ts`

**What Fund Manager Broadcasts:**
```typescript
class GuardianCoordinator {
  // Every hour: Send database to attested guardians
  async broadcastDatabase() {
    const db = await readFile('workspace/panthers.db');

    // Only send to guardians that have passed attestation verification
    await this.broadcast({
      type: 'DATABASE_BACKUP',
      data: db,
      timestamp: Date.now()
    });
  }
  
  // After every trade: Broadcast trade details
  async broadcastTrade(trade: Trade) {
    await this.broadcast({
      type: 'TRADE_COMPLETE',
      trade,
      attestation: await generateAttestation(trade)
    });
  }
  
  // When paused: Ask guardians for help
  async requestAnomalyResolution(anomaly: Anomaly) {
    await this.broadcast({
      type: 'ANOMALY_DETECTED',
      anomaly,
      fundState: await db.getFundState()
    });
    
    // Wait for guardian consensus (handled by guardians)
  }
  
  private async broadcast(message: Message) {
    const guardians = await this.getActiveGuardians();
    
    for (const guardian of guardians) {
      try {
        await fetch(`${guardian.endpoint}/message`, {
          method: 'POST',
          body: JSON.stringify(message)
        });
      } catch (error) {
        console.warn(`Failed to reach guardian ${guardian.address}`);
      }
    }
  }
}
```

**Success Criteria:**
- ✅ Hourly database backups to attested guardians
- ✅ Trade broadcasts work
- ✅ Can request guardian votes

---

### **Week 10: Testing & Deployment**

**Test Suites:**

```typescript
// Unit tests (100+ tests)
describe('DatabaseLedger', () => {
  test('distributes trade P&L correctly');
  test('maintains invariants after 1000 trades');
  test('handles withdrawal fee distribution');
  test('prevents partial withdrawals');
  test('add funds updates correctly');
});

// Integration tests (20+ tests)
describe('Trading Cycle', () => {
  test('executes full trading cycle');
  test('handles failed trades gracefully');
  test('verifies invariants after each trade');
});

// E2E tests (10+ tests)
describe('End-to-End', () => {
  test('user buys NFT → trades execute → user withdraws');
  test('user buys → adds funds → sells on P2P');
});

// Stress tests
describe('Stress Tests', () => {
  test('1000 trades with no drift');
  test('100 concurrent operations');
});
```

**Deployment:**
```bash
# Build Docker image
docker build -t panthers-fund:v1.0 .

# Deploy to SecretVM (TEE)
secretvm deploy panthers-fund:v1.0 \
  --device /dev/tdx_guest \
  --env TELEGRAM_BOT_TOKEN=xxx \
  --env TELEGRAM_GROUP_ID=xxx

# Verify attestation
secretvm verify panthers-fund

# Fund goes live!
```

**Success Criteria:**
- ✅ 100% test coverage on critical paths
- ✅ All stress tests pass
- ✅ Zero known bugs
- ✅ Deployed to TEE
- ✅ Attestation verified

---

## 🎯 Critical Reminders

**Database:**
- Use integer arithmetic (cents) everywhere
- Verify invariants after EVERY operation
- Atomic transactions always

**Trading:**
- Wait for 'finalized' confirmation (not just 'confirmed')
- Record every trade before distributing P&L
- Pause on any error

**Exit:**
- Withdrawals are all-or-nothing (no partials)
- P2P sales transfer NFT + balance together
- Always verify invariants after exits

**Security:**
- Generate TEE attestation for every critical operation
- Only send database to guardians that pass attestation verification
- All transfers via verified message signing channels
- Never store keys in plaintext

---

## ✅ Ready to Build

Start with Week 1 - Database Ledger is the foundation for everything!

**Next:** See BUILD_PLAN_GUARDIAN.md for building the guardian/sentry infrastructure.

🐆 **Let's build autonomous finance!** 🚀
