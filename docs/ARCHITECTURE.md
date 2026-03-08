# Attested Capital: Panthers - Architecture Overview

**Platform:** Attested Capital  
**Fund:** Panthers (500 NFTs)  
**Model:** Separate accounts with dynamic balances (NOT pooled NAV)

**Last Updated:** February 26, 2026

---

## 🏗️ System Architecture

```
┌──────────────────────────────────────────────┐
│  Fund Manager (SecretVM/TEE)                 │
│  ├─ Database (separate NFT accounts)         │
│  │  └─ Dynamic balances (change with trades) │
│  ├─ Trading Engine (10 strategies)           │
│  ├─ AI Sales Agent (dynamic pricing)         │
│  ├─ Multi-chain Wallets (4 chains)           │
│  ├─ Add Funds System (increase stake)        │
│  └─ Telegram Bot (user interface)            │
└────────────┬─────────────────────────────────┘
             │
             │ Hourly backup + trade broadcasts
             ↓
┌──────────────────────────────────────────────┐
│  Guardian/Sentry Network (Two-Tier)          │
│                                               │
│  GUARDIANS (Anyone Can Run):                 │
│  ├─ Store database backups (attested transfer)│
│  ├─ Serve RPC registry to fund manager       │
│  ├─ Monitor fund health & alert sentries     │
│  ├─ Track delegation records                 │
│  └─ NO voting power                          │
│                                               │
│  SENTRIES (NFT Holders Only):                │
│  ├─ All guardian functions +                 │
│  ├─ Accept delegations from NFT holders      │
│  ├─ Vote on code updates (75% threshold)     │
│  ├─ Vote on RPC updates                      │
│  ├─ Vote on anomaly resolution               │
│  └─ Voting power = own + delegated NFTs      │
└──────────────────────────────────────────────┘
             │
             │ Report to registry
             ↓
┌──────────────────────────────────────────────┐
│  Smart Contracts (Minimal)                   │
│  ├─ Panthers NFT (Secret Network)            │
│  └─ (Contract spec provided separately)      │
└──────────────────────────────────────────────┘
```

---

## 💾 Database Model (CRITICAL)

### **Separate Accounts with Dynamic Balances**

```sql
-- Each NFT = separate trading account with DYNAMIC balance
CREATE TABLE nft_accounts (
  token_id INTEGER PRIMARY KEY,
  owner_telegram_id TEXT,
  owner_address TEXT,
  initial_deposit REAL,      -- What they paid (can INCREASE via addFunds)
  current_balance REAL,       -- DYNAMIC: changes with every trade
  total_pnl REAL             -- Cumulative profit/loss
);

-- Track when users add more capital
CREATE TABLE fund_additions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nft_token_id INTEGER,
  amount REAL,
  tx_hash TEXT UNIQUE,
  timestamp INTEGER
);

-- How trading works:
-- 1. Pool trades together (gas efficient - 1 trade, not 500)
-- 2. Distribute P&L proportionally based on CURRENT_BALANCE
-- 3. Each NFT tracks own balance
-- 4. Balances change with every trade
```

**Why this matters:**
- ❌ Pooled NAV = Early buyers subsidized by late (Ponzi)
- ✅ Separate accounts = Fair allocation
- ✅ Dynamic balances = Accurate representation of value
- ✅ Can add funds = Increase position without buying new NFT

**Example:**
```
Alice buys NFT #123 for $50
  initial_deposit: $50
  current_balance: $50

After profitable trades:
  initial_deposit: $50 (unchanged)
  current_balance: $73 (+$23 profit)
  total_pnl: +$23

Alice adds $200 more capital:
  initial_deposit: $250 ($50 + $200)
  current_balance: $273 ($73 + $200)
  total_pnl: +$23 (unchanged)

After more trades (+10%):
  initial_deposit: $250 (unchanged)
  current_balance: $300.30 ($273 × 1.10)
  total_pnl: +$50.30

IMPORTANT: Voting power = current_balance ($300.30)
```

---

## 🛡️ Guardian vs Sentry (Two-Tier Network)

### **Guardians (Infrastructure - Permissionless)**

**Anyone can run, no NFT required:**

```typescript
class Guardian {
  // INFRASTRUCTURE FUNCTIONS ONLY
  
  async storeBackup(database: string) {
    // Store hourly database snapshots (received via attested channel)
    await this.storage.save('panthers-backup-' + Date.now(), database);
  }
  
  async getRPCs(chain: string): string[] {
    // Serve RPC list to fund manager
    return this.rpcRegistry.get(chain);
  }
  
  async monitorHealth() {
    // Monitor fund, alert sentries if issues
    const balances = await this.queryChains();
    if (balances.anomaly) {
      await this.alertSentries('ANOMALY_DETECTED', balances);
    }
  }
  
  async trackDelegation(delegation: Delegation) {
    // Track NFT holder delegations to sentries
    await this.delegationDB.save(delegation);
  }
  
  // NO VOTING - just infrastructure
}
```

**Why run a guardian?**
- Contribute to network security (altruism)
- If you own Panthers, you want backups to exist
- Learn TEE/autonomous trading
- Cost: ~$5/month

**Quantity:** Unlimited (can be 50-500 nodes)

---

### **Sentries (Governance - NFT Holders Only)**

**Must stake 1+ NFT to run:**

```typescript
class Sentry extends Guardian {
  private ownedNFTs: number[] = [];
  
  // ALL GUARDIAN FUNCTIONS +
  
  async calculateVotingPower(): Promise<number> {
    // Get own NFT balances (use CURRENT balance)
    let ownedValue = 0;
    for (const tokenId of this.ownedNFTs) {
      const account = await fundManager.getNFTAccount(tokenId);
      ownedValue += account.current_balance; // CURRENT, not initial!
    }
    
    // Get delegated NFT balances
    const delegatedValue = await this.getDelegatedValue();
    
    // Total voting power
    const totalValue = ownedValue + delegatedValue;
    const totalPool = await fundManager.getTotalPool();
    
    return totalValue / totalPool; // Percentage of total pool
  }
  
  async voteOnUpdate(proposalId: string, approve: boolean) {
    const votingPower = await this.calculateVotingPower();
    
    const vote = {
      proposalId,
      sentry: this.address,
      approve,
      votingPower, // e.g., 0.128 = 12.8% of pool
      timestamp: Date.now()
    };
    
    // Sign with TEE attestation
    vote.signature = await this.signWithAttestation(vote);
    
    // Broadcast to guardians
    await this.broadcastVote(vote);
  }
}
```

**Why run a sentry?**
- Economic: You own NFTs, good governance = your NFTs appreciate
- Career: "Sentry for $250k autonomous fund" on resume
- Reputation: Public leaderboard, community recognition
- Voting power: Influence fund direction, protect investment

**Cost:** ~$20/month + opportunity cost of NFTs  
**ROI:** Positive if you own $10k+ in NFTs OR value non-monetary benefits

**Quantity:** Natural limit (~10-20 quality sentries)

---

## 🗳️ Delegated Staking (No Smart Contracts)

### **How It Works**

NFT holders delegate voting power to sentries via signed messages:

```typescript
// Alice owns NFT #123 with current_balance = $100
// Bob runs a trusted sentry
// Alice delegates to Bob (NFT stays in her wallet)

const delegation = {
  delegator: "0xAlice",
  sentry: "0xBob",
  nftTokenIds: [123],
  expiresAt: Date.now() + (365 * 24 * 60 * 60 * 1000) // 1 year
};

// Alice signs with wallet
const signature = await wallet.signMessage(JSON.stringify(delegation));

// Guardians verify signature + NFT ownership
// Track in shared database
// Bob can now vote with Alice's $100 + his own stake
```

### **Voting Power Calculation**

```typescript
// Example scenario:

Fund state: $250,000 total across 500 NFTs

Bob's Sentry:
  Own NFTs: #10 ($2,000), #50 ($5,000) = $7,000
  Delegated: 50 holders delegate $25,000 total
  
Bob's voting power:
  $7,000 (self) + $25,000 (delegated) = $32,000
  Percentage: $32,000 / $250,000 = 12.8%

For code update to pass:
  Need: 75% of TOTAL POOL (not just delegated)
  Need: $187,500 in YES votes
  
If only Bob votes YES:
  $32,000 < $187,500
  Result: FAILS (need more support)
```

### **Why Delegated Staking?**

**Problem without delegation:**
```
Whale owns 200 NFTs ($100k = 40% of fund)
Small holders (300 NFTs × $167 avg) = $50k = 20%
Whale almost controls fund alone
```

**Solution with delegation:**
```
280 small holders delegate to Alice's sentry = $47k
Alice has 47% voting power
Whale has 40% voting power
Community prevails ✅
```

---

## 🤖 AI Sales Agent

### **Dynamic Pricing (NOT fixed NAV)**

```typescript
async calculatePrice(tokenId: number): Promise<number> {
  // Base: Average balance of similar NFTs
  let price = await this.getAverageBalance();
  
  // Sentiment multiplier (Twitter, Telegram)
  const sentiment = await this.analyzeSentiment();
  price *= (1 + sentiment * 0.5); // ±50% based on sentiment
  
  // Performance multiplier
  const performance = await this.getFundPerformance();
  price *= (1 + performance); // Recent returns
  
  // Scarcity multiplier
  const remaining = 500 - await this.getTotalMinted();
  const scarcityBonus = 1 + (1 - remaining / 500) * 0.3; // Up to 30%
  price *= scarcityBonus;
  
  // Activity multiplier
  const activity = await this.getTelegramActivity();
  price *= (1 + activity * 0.2); // Up to 20%
  
  return Math.round(price * 100) / 100;
}
```

**Strategies:**
1. **Dynamic pricing**: Market-based (sentiment, performance, scarcity)
2. **Flash auctions**: 30-minute auctions via DM (create FOMO)
3. **Negotiations**: Counter-offers, holds (feel personal)
4. **Scarcity marketing**: "Only 10 left!" (drive urgency)

---

## 💰 Economic Model

### **Zero Fees Platform**

| Fee Type | Amount |
|----------|--------|
| Management | 0% |
| Performance | 0% |
| P2P Trading | 0% |
| Add Funds | 0% |
| Withdrawal | 2% (distributed to holders) |

### **Two-Tier Exit System (All-or-Nothing)**

**Option A: P2P Sale (0% fee)**
```
User lists NFT for sale
Buyer pays seller directly
NFT + current_balance transfer together
Fund pool unchanged (no withdrawal)
Incentive: No fees, keeps fund liquid
```

**Option B: Full Withdrawal (2% fee)**
```
User burns NFT
Gets 98% of current_balance
2% fee distributed to remaining holders
MUST withdraw FULL balance (no partials)
Can never return
Incentive: Instant exit, but expensive
```

**❌ NO partial withdrawals allowed**

**Result:** Most use P2P → Liquidity stays high, fund keeps capital

---

## 🔄 Trading Flow

```typescript
Every 4 hours:

1. AI analyzes market
   ↓
2. Strategy decides: BUY 10 SOL
   ↓
3. Execute trade with pooled funds
   Total pool: $250,000
   Trade amount: $25,000 (10%)
   ↓
4. Trade result: +$1,500 profit (6% gain on trade)
   ↓
5. Distribute proportionally based on CURRENT_BALANCE:
   
   NFT #1: current_balance = $100 (0.04% of pool)
     Share: $1,500 × 0.0004 = $0.60
     New balance: $100.60
   
   NFT #2: current_balance = $50,000 (20% of pool)
     Share: $1,500 × 0.20 = $300
     New balance: $50,300
   
   [... all 500 NFTs updated ...]
   ↓
6. Update database (ATOMIC transaction)
   ↓
7. Verify invariants (CRITICAL):
   ✓ Sum of NFT balances = Total pool
   ✓ Each NFT: current_balance = initial_deposit + total_pnl
   ✓ All allocations sum to $1,500
   ↓
8. Broadcast to Guardians:
   {
     type: 'TRADE_COMPLETE',
     profit: $1,500,
     attestation: TEE_signature
   }
   ↓
9. Guardians verify independently:
   - Query chains for actual balance
   - Recalculate NAV
   - Compare with fund manager report
   - Alert if >1% discrepancy
```

---

## 🔐 Security Model

### **Four-Layer Verification**

**1. TEE Attestation (Hardware)**
```
Every operation signed by Intel TDX
Proves:
  - Code hasn't been tampered
  - No human intervention
  - Running official version
```

**2. Guardian Verification (Infrastructure)**
```
50+ guardians independently:
  - Store DB backups (received via attested signed channel)
  - Verify balances (hourly)
  - Monitor health (every 10 min)
  - Provide recovery data (after verifying attestation)
```

**3. Sentry Governance (Economic)**
```
10-20 sentries (NFT holders):
  - Vote on code updates (75% threshold)
  - Review all changes
  - Economic alignment (their NFTs at stake)
  - Delegated voting power (community can override)
```

**4. On-Chain Proof (Immutable)**
```
Every trade recorded on blockchain:
  - Transaction signatures
  - Timestamped
  - Publicly verifiable
  - Immutable audit trail
```

### **Invariants (MUST PASS After Every Operation)**

```typescript
async verifyInvariants(): Promise<boolean> {
  // Use integer arithmetic (cents) to avoid float drift
  
  // 1. Sum of NFT balances = Total pool
  const nftSumCents = await db.query(
    'SELECT SUM(current_balance * 100) FROM nft_accounts'
  );
  const poolCents = await db.query(
    'SELECT total_pool_balance * 100 FROM fund_state'
  );
  
  if (Math.abs(nftSumCents - poolCents) > 1) {
    console.error('INVARIANT 1 FAILED');
    await this.emergencyPause();
    return false;
  }
  
  // 2. Each NFT: current_balance = initial_deposit + total_pnl
  const nfts = await db.query('SELECT * FROM nft_accounts');
  for (const nft of nfts) {
    const expected = nft.initial_deposit + nft.total_pnl;
    if (Math.abs(expected - nft.current_balance) > 0.01) {
      console.error(`INVARIANT 2 FAILED: NFT ${nft.token_id}`);
      await this.emergencyPause();
      return false;
    }
  }
  
  // 3. Trade allocations sum to trade P&L
  const trades = await db.query('SELECT id, profit_loss FROM trades');
  for (const trade of trades) {
    const allocSum = await db.query(`
      SELECT SUM(pnl_share) FROM trade_allocations 
      WHERE trade_id = ?
    `, [trade.id]);
    
    if (Math.abs(allocSum - trade.profit_loss) > 0.01) {
      console.error(`INVARIANT 3 FAILED: Trade ${trade.id}`);
      await this.emergencyPause();
      return false;
    }
  }
  
  return true;
}
```

**If ANY invariant fails → IMMEDIATE PAUSE → Alert sentries → Vote on resolution**

---

## 📱 User Interface

### **Telegram Only**

```
/balance → Check your panther's value (current_balance)
/add [amount] → Add funds to increase stake
/listings → View P2P marketplace
/strategies → See all 10 strategies
/vote [strategy] → Propose change
/delegate [sentry] → Delegate voting power
/withdraw → Exit options (P2P vs full withdrawal)
/help → Full commands
```

**No dApps. No websites. Just Telegram bot.**

---

## 🌐 Multi-Chain Architecture

### **One Seed → Four Wallets**

```
BIP39 Mnemonic (ONE TIME GENERATION)
    ↓
├─ Secret:   m/44'/529'/0'/0/0  (NFT contract, TEE)
├─ Solana:   m/44'/501'/0'/0/0  (Trading - Jupiter DEX)
├─ Base:     m/44'/60'/0'/0/1   (Future: DeFi integrations)
└─ Ethereum: m/44'/60'/0'/0/0   (Future: cross-chain)
```

**Backup Flow:**
```
Fund Manager (TEE) has database
    ↓
Guardian connects, proves attestation
    ↓
Fund Manager verifies guardian meets attestation standards
    ↓
Fund Manager sends unencrypted DB over verified message signing channel
    ↓
Guardian stores backup copy
```

**Recovery Flow:**
```
Fund Manager crashes
    ↓
Deploy new Fund Manager in TEE
    ↓
Generate TEE attestation (proves running official code)
    ↓
Connect to ANY guardian, prove attestation
    ↓
Guardian verifies new Fund Manager's attestation
    ↓
Guardian sends DB copy over verified message signing channel
    ↓
Restore state and resume operations (<5 minutes)
```

**Key Points:**
- Security is attestation verification on both ends + verified message signing (not encryption at rest)
- Guardians hold real copies of the database
- Only need 1 guardian online for recovery
- No threshold/consensus/key keeper scheme needed
- Both sides verify attestation before any data transfer

---

## 🎯 Critical Design Decisions

### **1. Why Separate Accounts?**

**Problem:** Pooled NAV creates Ponzi dynamics
```
Pooled NAV (WRONG):
  Early buyer: $50 → 1/100 of fund → Worth $1,000 (20x!)
  Late buyer: $500 → 1/100 of fund → Worth $1,000 (2x)
  = Early profits from late deposits ❌
```

**Solution:** Separate accounts
```
Separate Accounts (CORRECT):
  Early buyer: $50 account → $65 after trades (30% gain)
  Late buyer: $500 account → $650 after trades (30% gain)
  = Equal % returns ✅
```

### **2. Why Dynamic Balances?**

Allows users to:
- Increase position without buying new NFT
- Accurately track actual value
- Fair voting power (based on economic stake)
- Transparent accounting

### **3. Why AI Sales Agent?**

Makes pricing exciting (not boring formula):
- Auctions create FOMO
- Negotiations feel personal
- Scarcity marketing drives urgency
- Performance-based pricing is fair
- Sentiment-based pricing feels market-driven

### **4. Why 2% Withdrawal Fee?**

Creates incentive alignment:
- P2P = 0% → Users prefer this (fund stays liquid)
- Withdrawal = 2% → Users avoid unless urgent
- Fee to holders → Rewards loyalty
- Result: Sticky liquidity, healthy fund

### **5. Why Guardian/Sentry Split?**

**Problem with single role:**
```
If guardians could vote:
  Attacker spins up 1000 guardian nodes
  Attacker controls 90% voting power
  Attacker votes malicious update
  Fund stolen ❌
```

**Solution: Separate infrastructure from governance**
```
Guardians = Infrastructure (permissionless, no voting)
Sentries = Governance (NFT holders, economic stake)

Attacker spins up 1000 guardians:
  Gets 0% voting power
  Actually helps network (more backups!)
  Attack fails ✅
```

### **6. Why Delegated Staking?**

**Without delegation:**
- Whales dominate governance
- Small holders don't participate
- Centralized decision-making

**With delegation:**
- Community can pool voting power
- Sentries compete for delegations
- Reputation matters
- Decentralized governance

---

## 📊 Build Plans

**Two separate projects:**

### **Fund Manager (10 Weeks)**
**File:** BUILD_PLAN_FUND_MANAGER.md

| Week | Focus |
|------|-------|
| 1 | Database ledger (dynamic balances) |
| 2 | Multi-chain wallets + balance tracker |
| 3-5 | Trading engine + 10 strategies |
| 6-7 | AI sales agent (dynamic pricing) |
| 8 | P2P marketplace + withdrawals |
| 9 | Guardian coordinator |
| 10 | Testing + deployment |

### **Guardian/Sentry Network (6 Weeks)**
**File:** BUILD_PLAN_GUARDIAN.md

| Week | Focus |
|------|-------|
| 1 | Guardian infrastructure |
| 2 | RPC management |
| 3 | Delegation tracking |
| 4 | Sentry voting system |
| 5 | Code update review |
| 6 | Testing + deployment |

---

## 🚀 Ready to Build

**Start with:**
1. **START_HERE.md** → Entry point
2. **BUILD_PLAN_FUND_MANAGER.md** → Trading bot (if building fund)
3. **BUILD_PLAN_GUARDIAN.md** → Infrastructure (if building network)

**Or build both in parallel (16 weeks total)**

---

**This is Attested Capital. Don't trust. Attest.** 🐆
