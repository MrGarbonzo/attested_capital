# Quick Answers to Your 10 Items

---

## 1. **Dynamic NFT Sales** 

**Status:** Tools exist, need testing

**You have:** Basic dynamic pricing tool

**Need:** Test 4 mechanisms:
- Demand-based pricing (price increases with sales velocity)
- Flash auctions (30-min timer, highest bidder wins)
- DM haggling (counter-offers via LLM)
- Gumball (mystery NFT, random assignment)

**Document:** POST_DEMO_ROADMAP.md → Phase 2 → Item #1

**Time:** 2-3 days

---

## 2. **Agent X Account**

**Status:** Not started

**What:** Agent posts to Twitter:
- Daily stats (9am)
- Trade announcements (after each trade)
- Responds to mentions (LLM-powered)

**Implementation:** TwitterApi + cron jobs

**Document:** POST_DEMO_ROADMAP.md → Phase 4 → Item #2

**Time:** 2-3 days

---

## 3. **NFT Viewing System**

**Status:** Not started

**Options:**
A. Telegram mini app (web view)
B. Generate images on-demand (Canvas)
C. Mint real Solana NFTs (Metaplex)

**Recommendation:** Option B (simplest)

**Document:** POST_DEMO_ROADMAP.md → Phase 4 → Item #3

**Time:** 2-3 days

---

## 4. **P2P Escrow**

**Status:** Listing/buying tools exist, need escrow logic

**Flow:**
```
Alice lists Panther #5 for $150
├─ NFT locked in escrow
Bob buys for $150
├─ Payment to agent
├─ Agent atomic swap:
│  ├─ Transfer NFT: Alice → Bob
│  └─ Transfer $: Bob → Alice
└─ 0% fee (as designed)
```

**Document:** POST_DEMO_ROADMAP.md → Phase 2 → Item #4

**Time:** 1-2 days

---

## 5. **Another Chain + Bridge**

**Status:** Have 4 chains, need bridging

**Add:** Arbitrum (5th chain)

**Bridge:** 
- Circle CCTP (for USDC)
- Wormhole (for ETH/SOL)

**Use Case:** Cross-chain arbitrage

**Document:** POST_DEMO_ROADMAP.md → Phase 3 → Item #5

**Time:** 3-4 days

---

## 6. **Portfolio Allocation Rules**

**Status:** Not started

**Guidelines:**
```
Max trading: 80% of pool
Min cash: 20% (for withdrawals)
Max per asset:
├─ SOL: 40%
├─ ETH: 30%
├─ BTC: 20%
└─ USDC: 10%
Rebalance threshold: 5% deviation
```

**Document:** POST_DEMO_ROADMAP.md → Phase 2 → Item #6

**Time:** 1-2 days

---

## 7. **API Update Alerts (Guardian → Agent)**

**Status:** Not started

**Flow:**
```
Guardian monitors Jupiter API
API schema changes or goes down
Guardian sends alert to agent (Telegram)
Agent pauses trading
Agent notifies users
API recovers
Guardian sends recovery alert
Agent resumes trading
```

**Document:** POST_DEMO_ROADMAP.md → Phase 4 → Item #7

**Time:** 1 day

---

## 8. **Multiple Guardians** ⚠️ PRIORITY

**Status:** Ready to deploy

**What to Do:**
```bash
# Deploy guardian-2 (new VM)
# Deploy guardian-3 (new VM)

# Update agent .env:
BOOTSTRAP_GUARDIANS=http://g1:3100,http://g2:3100,http://g3:3100
APPROVED_MEASUREMENTS=<g1-mrtd>,<g2-mrtd>,<g3-mrtd>

# Test:
# - All 3 connect ✓
# - All 3 receive DB sync ✓
# - Kill one, others continue ✓
# - Agent recovers from any guardian ✓
```

**Document:** POST_DEMO_ROADMAP.md → Phase 1 → Item #8

**Time:** 1 day

---

## 9. **Prevent Duplicate Agents** ✅ ALREADY SOLVED!

**Status:** Architecture designed

**How It Works:**
```
Agent-1 registers with session pubkey_A
Agent-2 tries to register with pubkey_B
Guardian checks: "pubkey_A is active"
Guardian rejects Agent-2 ❌

Only when Agent-1 dies (5min timeout):
├─ pubkey_A deactivated
└─ Agent-2 can take over with pubkey_B ✓
```

**Documents:** 
- CORRECTED_AGENT_REGISTRATION.md
- POST_DEMO_ROADMAP.md → Phase 1 → Item #9

**What to Do:** Verify your implementation matches design

**Time:** 2 hours (verify + test)

---

## 10. **Agent Creates Telegram Automatically** ✅ ALREADY DESIGNED!

**Status:** Designed in TELEGRAM_COORDINATION.md

**Flow:**
```
Agent boots
├─ Creates bot via BotFather API
├─ Creates private group
├─ Stores bot token + group ID
└─ Invites you to group

Future deployments:
└─ Agent loads saved config (no human intervention)
```

**Documents:**
- TELEGRAM_COORDINATION.md
- POST_DEMO_ROADMAP.md → Phase 1 → Item #10

**First-Time Setup:**
```bash
TELEGRAM_API_ID=<your-api-id>
TELEGRAM_API_HASH=<your-api-hash>
TELEGRAM_PHONE=+1234567890

# Agent creates bot + group automatically
# One-time phone verification, then fully automated
```

**Time:** 1 day (implement + test)

---

## ✅ **Summary**

**Already Solved:**
- ✅ #9: Duplicate agents (CORRECTED_AGENT_REGISTRATION.md)
- ✅ #10: Telegram auto-setup (TELEGRAM_COORDINATION.md)

**Quick Wins (1-2 days each):**
- #4: P2P escrow
- #6: Portfolio allocation
- #7: API monitoring
- #8: Multiple guardians
- #10: Telegram auto-setup

**Medium Effort (2-3 days each):**
- #1: Dynamic sales
- #2: X account
- #3: NFT viewing

**Larger Effort (3-4 days):**
- #5: Multi-chain bridge

**Total Time:** ~20 days (4 weeks) spread across 2 months

---

## 🎯 **Recommended Order**

**Week 1 (Critical):**
1. ✅ Vault key persistence
2. ✅ LLM resilience  
3. ✅ APPROVED_MEASUREMENTS
4. #8: Multiple guardians
5. #9: Verify duplicate prevention

**Week 2-3 (Core):**
6. #1: Dynamic sales
7. #4: P2P escrow
8. #6: Portfolio rules
9. #10: Telegram auto

**Week 4-5 (Multi-Chain):**
10. #5: Bridge + 5th chain
11. #7: API monitoring

**Month 2 (Polish):**
12. #2: X marketing
13. #3: NFT viewing

---

**You have a clear path to production!** 🚀
