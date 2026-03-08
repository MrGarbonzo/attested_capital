# 🚀 Attested Capital: Panthers - START HERE

**Created:** February 26, 2026  
**Status:** READY TO BUILD  
**Timeline:** 10-16 weeks to production

---

## ✅ What's in This Directory

This is a **FRESH, CLEAN** directory with everything needed to build Attested Capital: Panthers.

All legacy "AgentMarket" references removed. All architecture finalized. Ready for Claude Code.

---

## 📚 Documentation Structure

```
C:\dev\attested_capital\docs\
│
├─ 📄 START_HERE.md                    ← You are here!
├─ 📄 README.md                         ← Project overview
├─ 📄 ARCHITECTURE.md                   ← System design
│
├─ 🐆 BUILD_PLAN_FUND_MANAGER.md      ← Build trading bot (10 weeks)
├─ 🛡️ BUILD_PLAN_GUARDIAN.md          ← Build infrastructure (6 weeks)
│
├─ 📊 STRATEGIES.md                     ← 10 trading strategies
└─ 🛡️ GUARDIAN_NETWORK.md              ← Guardian/Sentry complete guide
```

---

## 🎯 Two Separate Projects

We're building **two different systems** that work together:

### **1. Fund Manager** (Trading Bot)
**File:** BUILD_PLAN_FUND_MANAGER.md  
**Timeline:** 10 weeks  
**What it does:**
- Manages 500 NFT accounts (dynamic balances)
- Executes trades every 4 hours
- AI agent sells NFTs (dynamic pricing)
- Handles withdrawals and P2P marketplace
- Runs in TEE with cryptographic attestation

**Start here if:** You're building the core trading system

---

### **2. Guardian/Sentry Network** (Infrastructure)
**File:** BUILD_PLAN_GUARDIAN.md  
**Timeline:** 6 weeks  
**What it does:**
- **Guardians:** Store backups, serve RPCs, monitor health (anyone can run)
- **Sentries:** Accept delegations, vote on updates (NFT holders only)
- Provides recovery, governance, and decentralized verification

**Start here if:** You're building the infrastructure/governance layer

---

## 🚀 For Claude Code: Start Building

**Step 1:** Read `README.md` (2 min overview)

**Step 2:** Read `ARCHITECTURE.md` (understand the system)

**Step 3:** Choose your path:

**Path A: Build Fund Manager First (Recommended)**
1. Open `BUILD_PLAN_FUND_MANAGER.md`
2. Start Week 1: Database Ledger
3. Build trading system (10 weeks)
4. Add guardians later

**Path B: Build Guardian Network First**
1. Open `BUILD_PLAN_GUARDIAN.md`
2. Start Week 1: Basic Guardian
3. Build infrastructure (6 weeks)
4. Wait for fund manager to integrate

**Path C: Parallel Development (If you have 2 teams)**
1. Team A: Fund Manager (10 weeks)
2. Team B: Guardians (6 weeks)
3. Integrate in Week 10

---

## 🔑 Critical Concepts (Must Understand)

### **1. Separate Accounts (NOT Pooled NAV)**

This is the MOST IMPORTANT architectural decision:

❌ **WRONG (Pooled NAV - Ponzi):**
```
Total fund = $1000
NFTs = 10
NAV = $100 per NFT

Alice paid $50 → Gets $100 NFT (2x!)
Bob paid $500 → Gets $100 NFT (0.2x)

Early buyers profit from late deposits = Ponzi
```

✅ **RIGHT (Separate Accounts - Fair):**
```
Alice paid $50 → Alice's account = $50
Bob paid $500 → Bob's account = $500

Trade makes 20% profit:
- Alice: $50 → $60 (+20%)
- Bob: $500 → $600 (+20%)

Equal % returns = Fair
```

### **2. Dynamic NFT Balances (NEW)**

**NFT balances change with every trade:**
```
Alice buys NFT #123 for $50
  → initial_deposit: $50
  → current_balance: $50

After profitable trades:
  → initial_deposit: $50 (unchanged)
  → current_balance: $73 (+$23 profit)

Alice can add $200 more:
  → initial_deposit: $250 ($50 + $200)
  → current_balance: $273 ($73 + $200)

Voting power = current_balance ($273)
```

### **3. Two-Tier Network (Guardian vs Sentry)**

**Guardians (Infrastructure - Anyone Can Run):**
- Discover peers via Telegram, connect directly
- Store database backups (via attested signed channel)
- Serve RPC registry
- Monitor fund health
- **NO voting power**
- Cost: ~$5/month
- Permissionless

**Sentries (Governance - NFT Holders Only):**
- All guardian functions PLUS:
- Accept delegations from NFT holders
- Vote on code updates (75% threshold)
- **Voting power = own NFTs + delegated NFTs**
- Cost: ~$20/month + NFTs
- Must own 1+ NFT

### **4. Delegated Staking (No Smart Contracts)**

**NFT holders delegate voting power to sentries:**
```
Alice owns 1 NFT ($100 balance)
Bob runs a sentry she trusts
Alice signs delegation message (keeps NFT in wallet)

Bob's voting power:
  Own NFTs: $7,000
  Delegated: $25,000 (from 50 holders like Alice)
  Total: $32,000 / $250,000 = 12.8% voting power

Alice can undelegate anytime
```

### **5. Exit System: All-or-Nothing**

**Option A: Full Withdrawal (2% fee)**
```
Burn NFT
Get 98% of current_balance
2% distributed to remaining holders
Can never return
```

**Option B: P2P Sale (0% fee)**
```
Sell NFT to another user
NFT + balance transfer together
Fund pool unchanged
Buyer gets your balance
```

**❌ NO partial withdrawals allowed**

---

## 📊 Project Stats

| Metric | Value |
|--------|-------|
| **Infrastructure Cost** | $0/month (free RPCs + volunteers) |
| **Revenue Model** | $0 (zero fees, pure experiment) |
| **Build Timeline** | 10-16 weeks |
| **Legal Risk** | Zero (not a financial product) |
| **Career Impact** | Massive (if successful) |

---

## 🏗️ Build Timeline Overview

### **Fund Manager: 10 Weeks**

| Week | Focus | What You Build |
|------|-------|----------------|
| 1 | Database | Separate account ledger + invariants |
| 2 | Wallets | Multi-chain (BIP39) + balance tracking |
| 3-5 | Trading | 10 strategies + engine |
| 6-7 | Sales | AI agent (dynamic pricing, auctions) |
| 8 | Exit | P2P + withdrawal (2% fee) |
| 9 | Guardians | Coordinator (broadcasts) |
| 10 | Testing | E2E + stress tests |

### **Guardian Network: 6 Weeks**

| Week | Focus | What You Build |
|------|-------|----------------|
| 1 | Guardian | Basic infrastructure (backups, RPCs) |
| 2 | Guardian | RPC management + testing |
| 3 | Guardian | Delegation tracking |
| 4 | Sentry | Governance + voting |
| 5 | Sentry | Code update review system |
| 6 | Deploy | Testing + production |

**Then: Production launch!**

---

## 🎯 Success Criteria

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
- 5+ active guardians

---

## ⚠️ Critical Reminders

### **When Building Database (Week 1):**

```sql
-- CORRECT (separate accounts):
CREATE TABLE nft_accounts (
  token_id INTEGER,
  initial_deposit REAL,     -- Can increase via addFunds
  current_balance REAL,     -- DYNAMIC: changes with trades
  total_pnl REAL
);

-- WRONG (pooled NAV):
CREATE TABLE fund_state (
  nav_per_nft REAL  -- ❌ This is Ponzi!
);
```

### **When Building Trading (Weeks 3-5):**

```typescript
// CORRECT (proportional distribution):
for (const nft of allNFTs) {
  const allocation = nft.current_balance / totalPool;  // Use current_balance!
  const profitShare = tradeProfit * allocation;
  nft.current_balance += profitShare;
}

// WRONG (pooled NAV):
fundState.nav_per_nft += profitIncrease;  // ❌ This is Ponzi!
```

### **When Building Exit (Week 8):**

```typescript
// CORRECT (2% fee to holders):
const fee = balance * 0.02;
const userReceives = balance - fee;
distributeToRemainingHolders(fee);  // ✅

// WRONG (partial withdrawal):
const partialAmount = balance * 0.5;  // ❌ Not allowed!
```

### **When Building Guardians (Week 1-3):**

```typescript
// CORRECT (anyone can run):
class Guardian {
  // Infrastructure only - NO voting
  async storeBackup() { }
  async serveRPCs() { }
  async monitorHealth() { }
}

// WRONG (guardians vote):
async vote() { }  // ❌ Only sentries vote!
```

### **When Building Sentries (Week 4-6):**

```typescript
// CORRECT (voting power = current_balance):
const ownValue = sum(myNFTs.map(nft => nft.current_balance));
const delegatedValue = sum(delegations.map(d => d.totalValue));
const votingPower = (ownValue + delegatedValue) / totalPool;

// WRONG (voting power = number of NFTs):
const votingPower = myNFTs.length / 500;  // ❌ Ignores balance!
```

---

## 📖 Read Next

**Building Fund Manager:**
1. **README.md** - Project overview (5 min)
2. **ARCHITECTURE.md** - System design (15 min)
3. **BUILD_PLAN_FUND_MANAGER.md** - Start Week 1 (deep dive)

**Building Guardian Network:**
1. **README.md** - Project overview (5 min)
2. **GUARDIAN_NETWORK.md** - Complete guide (15 min)
3. **BUILD_PLAN_GUARDIAN.md** - Start Week 1 (deep dive)

**Understanding the System:**
1. **ARCHITECTURE.md** - Complete system design
2. **STRATEGIES.md** - Trading strategy details
3. **GUARDIAN_NETWORK.md** - Guardian system details

---

## 🚀 Ready to Build!

**Two paths:**
- 🐆 Fund Manager (10 weeks) → Trading bot
- 🛡️ Guardian Network (6 weeks) → Infrastructure

**Or build both in parallel (16 weeks total)**

All documentation is complete and accurate.  
All architectural decisions finalized.  
All legacy references removed.  

**Choose your path and start building!**

**Platform:** Attested Capital  
**Fund:** Panthers  
**Tagline:** Don't trust. Attest. 🐆

---

**Let's build the future of verifiable autonomous finance!** 🚀
