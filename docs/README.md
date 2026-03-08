# Attested Capital: Panthers Fund

**Platform:** Attested Capital (infrastructure for verified autonomous funds)  
**First Fund:** Panthers (500 panther NFTs, multi-chain autonomous trading)  
**Status:** Ready to build  
**Timeline:** 10-16 weeks to production

**Last Updated:** February 26, 2026

---

## 🚀 Quick Start

**New to the project?**
1. Read **START_HERE.md** - Orientation & critical concepts (10 min)
2. Read **ARCHITECTURE.md** - System design overview (15 min)
3. Choose your path:
   - Building the trading bot? → **BUILD_PLAN_FUND_MANAGER.md** (10 weeks)
   - Building infrastructure? → **BUILD_PLAN_GUARDIAN.md** (6 weeks)

**Ready to build!** 🐆

---

## 📋 What We're Building

### **Platform: Attested Capital**

Infrastructure for cryptographically verified autonomous funds:
- TEE attestation for every operation (Intel TDX)
- Guardian/Sentry network for verification & governance
- Zero fees (pure experiment)
- Fully autonomous (no human control after launch)

### **First Fund: Panthers**

**500 Panther NFTs** - Each NFT = separate trading account with dynamic balance

**Features:**
- Multi-chain trading (Solana via Jupiter, EVM chains via Uniswap, Secret for NFTs)
- AI dynamic pricing (sentiment + performance + scarcity)
- 10 pre-built trading strategies (user-voted)
- P2P marketplace (0% fees)
- Full withdrawal option (2% fee → distributed to holders)
- Telegram-only interface
- Can add funds to increase position anytime

---

## 🏗️ Architecture Highlights

### **1. Separate Accounts with Dynamic Balances**

**Each NFT = Individual Trading Account**

```
Alice buys NFT #123 for $50
  → initial_deposit: $50
  → current_balance: $50

After profitable trades:
  → current_balance: $73 (+$23 profit)

Alice adds $200 more:
  → initial_deposit: $250
  → current_balance: $273

After more trades:
  → current_balance: $300 (+10%)

Voting power = current_balance ($300)
```

**Why this matters:**
- ❌ Pooled NAV = Early buyers profit from late deposits (Ponzi)
- ✅ Separate accounts = Fair allocation (everyone earns same %)
- ✅ Dynamic balances = Accurate value representation
- ✅ Can add funds = Increase position without buying new NFT

---

### **2. Two-Tier Network: Guardians + Sentries**

**Guardians (Infrastructure - Anyone Can Run)**
```
Permissionless, no NFT required
Cost: ~$5/month

Functions:
✓ Store database backups (attested channel, hourly)
✓ Serve RPC registry to fund manager
✓ Monitor fund health, alert sentries
✓ Track delegation records
✗ NO voting power (prevents Sybil attacks)
```

**Sentries (Governance - NFT Holders Only)**
```
Must own 1+ NFT
Cost: ~$20/month + NFT opportunity cost

Functions:
✓ All guardian functions +
✓ Accept delegations from other NFT holders
✓ Vote on code updates (75% threshold)
✓ Vote on RPC updates
✓ Vote on anomaly resolution
✓ Voting power = own NFTs + delegated NFTs
```

**Why two tiers?**
- Separates infrastructure (permissionless) from governance (economic stake)
- Prevents Sybil attacks (can't vote without owning NFTs)
- Allows anyone to contribute to security
- Ensures governance is aligned with fund performance

---

### **3. Delegated Staking (No Smart Contracts)**

**NFT holders delegate voting power to sentries:**

```
Small holder: Owns 1 NFT ($100)
  → Delegates to trusted sentry
  → Sentry votes with combined power
  → NFT stays in holder's wallet
  → Can undelegate anytime

Sentry voting power:
  Own NFTs: $7,000
  Delegated: $25,000 (from 50 holders)
  Total: $32,000 / $250,000 = 12.8%
```

**Why delegation?**
- Prevents whale domination
- Small holders can participate
- Sentries compete for delegations (reputation matters)
- No custody risk (NFT never leaves wallet)

---

### **4. AI Sales Agent**

**Dynamic Pricing** (not fixed formula):

```
Price = baseNAV × 
        sentimentMultiplier ×      // Twitter/Telegram sentiment
        performanceMultiplier ×    // Recent fund returns
        scarcityMultiplier ×       // Only X left!
        activityMultiplier         // Community engagement
```

**Sales Strategies:**
- Flash auctions (30-min via DM) → Create FOMO
- Negotiations (counter-offers) → Feel personal
- Scarcity marketing → Drive urgency
- Performance-based → Fair pricing

---

### **5. Exit System: All-or-Nothing**

**Option A: P2P Sale (0% fee)**
```
List NFT for sale
Buyer pays you directly
NFT + current_balance transfer together
Fund pool unchanged (stays liquid)
Incentive: Zero fees ✅
```

**Option B: Full Withdrawal (2% fee)**
```
Burn NFT (can never return)
Get 98% of current_balance
2% distributed to remaining holders
MUST withdraw FULL balance (no partials)
Incentive: Instant exit ✅
```

**Result:** Most use P2P → Fund stays liquid, holders rewarded for loyalty

---

## 💰 Economic Model

| Fee Type | Amount | Distributed To |
|----------|--------|----------------|
| Management | 0% | N/A |
| Performance | 0% | N/A |
| P2P Trading | 0% | N/A |
| Add Funds | 0% | N/A |
| Withdrawal | 2% | Remaining NFT holders |

**Infrastructure Costs:** $0/month (free RPCs + volunteer guardians)  
**Revenue Model:** $0 (zero fees, pure experiment)

---

## 📊 Two Separate Projects

### **Project 1: Fund Manager** (Trading Bot)

**Timeline:** 10 weeks  
**File:** BUILD_PLAN_FUND_MANAGER.md

**What it does:**
- Manages 500 NFT accounts (separate balances)
- Executes trades every 4 hours (10 strategies)
- AI agent sells NFTs (dynamic pricing)
- Handles P2P marketplace
- Processes withdrawals (all-or-nothing)
- Runs in TEE with cryptographic attestation

**Tech Stack:**
- OpenClaw framework
- SQLite (separate account ledger)
- BIP39 multi-chain wallets
- Jupiter DEX (Solana trading)
- Telegram bot
- SecretVM (Intel TDX)

---

### **Project 2: Guardian/Sentry Network** (Infrastructure)

**Timeline:** 6 weeks  
**File:** BUILD_PLAN_GUARDIAN.md

**What it does:**
- Stores database backups via attested channel (guardians)
- Provides RPC registry (guardians)
- Tracks delegations (guardians)
- Votes on code updates (sentries)
- Votes on RPC updates (sentries)
- Autonomous governance (sentries)

**Tech Stack:**
- Express.js
- SQLite (delegation tracking)
- P2P messaging (guardian ↔ guardian)
- TEE attestation (sentries only)
- Docker

---

## 📚 Documentation Structure

```
C:\dev\attested_capital\docs\

Essential Files:
├─ START_HERE.md                    ⭐ Read this first
├─ README.md                         ← You are here
├─ ARCHITECTURE.md                   System design overview
│
Build Plans:
├─ BUILD_PLAN_FUND_MANAGER.md       🐆 Trading bot (10 weeks)
├─ BUILD_PLAN_GUARDIAN.md           🛡️ Infrastructure (6 weeks)
├─ STRATEGIES.md                     10 trading strategies
│
Reference:
└─ GUARDIAN_NETWORK.md              🛡️ Complete guardian/sentry guide
```

---

## 🎯 Core Principles

### **1. Separate Accounts (NOT Pooled NAV)**

Each NFT tracks its own balance:
```
Alice: $50 → $65 after trades (+30%)
Bob: $500 → $650 after trades (+30%)
Equal % returns = Fair ✅

NOT:
Alice: $50 → Gets 1/500 of pool = $500 (10x!)
Bob: $500 → Gets 1/500 of pool = $500 (1x)
Early profits from late deposits = Ponzi ❌
```

### **2. Dynamic Balances**

Balances change with every trade:
```
current_balance = initial_deposit + cumulative_pnl

Can increase via addFunds()
Voting power based on current_balance
Transparent accounting
```

### **3. AI-Driven & Autonomous**

- Dynamic pricing (not boring formula)
- Autonomous trading (zero human control)
- Self-governing (via sentries)
- Verifiable (TEE attestation)

### **4. Fair Exits with Aligned Incentives**

- P2P (0%) → Preferred, fund stays liquid
- Withdrawal (2%) → Instant exit, fees to loyalists
- All-or-nothing → No gaming the system

### **5. Zero Fees**

- No management fees
- No performance fees
- Pure experiment for maximum street cred
- Sustainable via volunteer infrastructure

---

## 🔑 Critical Invariants

**Database must maintain these after EVERY operation:**

```typescript
// Invariant 1: Sum equals pool
SUM(nft_accounts.current_balance) = fund_state.total_pool_balance

// Invariant 2: Balance equals deposit + P&L
FOR EACH NFT:
  current_balance = initial_deposit + total_pnl

// Invariant 3: Allocations sum to trade P&L
FOR EACH TRADE:
  SUM(trade_allocations.pnl_share) = trades.profit_loss
```

**If ANY invariant fails:**
1. IMMEDIATE PAUSE
2. Alert sentries
3. Vote on resolution
4. No trading until resolved

---

## 🔒 Security Model

### **Four Layers of Verification**

**1. TEE Attestation (Hardware)**
- Every operation signed by Intel TDX
- Proves code hasn't been tampered
- Proves no human intervention

**2. Guardian Verification (Infrastructure)**
- 50+ guardians independently verify balances
- Hourly balance checks
- Anomaly detection every 10 minutes
- Store DB backups (received via attested signed channel)

**3. Sentry Governance (Economic)**
- 10-20 sentries (NFT holders)
- Vote on code updates (75% threshold)
- Economic alignment (their NFTs at stake)
- Community can delegate to override whales

**4. On-Chain Proof (Immutable)**
- Every trade recorded on blockchain
- Publicly verifiable
- Immutable audit trail

---

## 🚀 Ready to Build

**Choose your path:**

### **Path A: Fund Manager First (Recommended)**
```
1. Read BUILD_PLAN_FUND_MANAGER.md
2. Start Week 1: Database Ledger
3. Build trading system (10 weeks)
4. Add guardians later
```

### **Path B: Guardian Network First**
```
1. Read BUILD_PLAN_GUARDIAN.md
2. Start Week 1: Basic Guardian
3. Build infrastructure (6 weeks)
4. Integrate with fund manager
```

### **Path C: Parallel Development**
```
Team A: Fund Manager (10 weeks)
Team B: Guardians (6 weeks)
Integrate in Week 10
Total: 10 weeks (if parallel)
```

---

## 📈 Success Criteria

**Technical:**
- 99.5%+ uptime
- <5 min recovery time
- Zero invariant violations
- Zero fund loss
- Dynamic balances work correctly

**Governance:**
- 3-5 quality sentries running
- 20-50 guardians providing infrastructure
- 30%+ of NFTs delegated
- All code updates require 75% approval

**Product:**
- 500/500 NFTs sold
- $250k+ AUM
- Positive returns vs BTC
- Active P2P marketplace
- Users understand add funds vs P2P vs withdrawal

**Community:**
- 500+ Telegram members
- 5k+ Twitter followers
- 10+ strategy votes/month
- Active guardian/sentry participation

---

## 💡 Why This Project Matters

**If successful:**
- Proves autonomous funds can work
- Shows trustless verification is possible
- Demonstrates fair NFT-based trading accounts
- Creates replicable infrastructure
- Establishes Attested Capital platform

**If it fails:**
- Learn from experiment
- Open-source everything
- Community learns
- Still valuable for career/resume
- Zero legal risk (not a financial product)

---

## 🐆 Tagline

**"Don't trust. Attest."**

Every operation cryptographically verified.  
Every balance independently checked.  
Every trade publicly auditable.  
Zero human control.  
Pure autonomy.

---

## 📞 Next Steps

1. **START_HERE.md** - Understand critical concepts
2. **ARCHITECTURE.md** - Learn system design
3. **BUILD_PLAN_FUND_MANAGER.md** or **BUILD_PLAN_GUARDIAN.md** - Start building
4. **STRATEGIES.md** - Understand trading logic
5. **GUARDIAN_NETWORK.md** - Deep dive on infrastructure

**Let's build the future of verifiable autonomous finance!** 🚀

---

**Platform:** Attested Capital  
**Fund:** Panthers  
**Status:** Ready to build  
**Launch:** 10-16 weeks from now

🐆 **Don't trust. Attest.**
