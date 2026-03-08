# Prioritized Action Plan - Based on Status Report

**Current State:** Working system with 3 critical blockers preventing production readiness.

---

## 🚨 **PRIORITY 1: CRITICAL BLOCKERS** (Deploy This Week)

### **1.1 Vault Key Persistence** ⚠️⚠️⚠️

**Issue:** Vault key regenerates → can't decrypt DB snapshots → recovery broken

**Impact:** Complete loss of DB sync functionality

**Fix:** `FIX_VAULT_KEY_PERSISTENCE.md`
- Use `/dev/attestation/keys/vault-key` for TEE-sealed storage
- 2-3 hours to implement + test
- **Blocks:** DB sync recovery, multi-guardian failover

**Test Plan:**
```bash
# 1. Deploy fix
# 2. Trigger DB sync: trigger_db_sync via Telegram
# 3. Restart agent: docker compose restart
# 4. Verify vault key persists (check logs)
# 5. Verify can decrypt old snapshots
```

---

### **1.2 LLM Fallback** ⚠️⚠️

**Issue:** SecretAI down → bot completely dead

**Impact:** Users can't interact with fund

**Fix:** `FIX_LLM_FALLBACK.md`
- Add OpenAI fallback (gpt-4o-mini)
- 1-2 hours to implement
- Cost: ~$2-5/month when SecretAI is down

**Test Plan:**
```bash
# 1. Add OPENAI_API_KEY to .env
# 2. Redeploy agent
# 3. Kill SecretAI endpoint (test failover)
# 4. Send Telegram message
# 5. Verify OpenAI fallback works
```

---

### **1.3 APPROVED_MEASUREMENTS Security** ⚠️⚠️

**Issue:** Empty `APPROVED_MEASUREMENTS` → accepts ANY TEE attestation

**Impact:** Malicious guardian could register

**Fix:** Lock down to your guardian's MRTD

**Steps:**
```bash
# 1. Get guardian's MRTD
ssh -i ~/.ssh/guardian_vm_key root@67.43.239.6
curl -k https://localhost:29343/cpu.html | grep -A1 "MRTD"
# Copy the hash: e.g., 9a7b3c...

# 2. Add to agent .env
ssh -i ~/.ssh/secretvm_key root@67.215.13.107
echo 'APPROVED_MEASUREMENTS=9a7b3c...' >> /mnt/secure/docker_wd/usr/.env

# 3. Restart agent
docker compose restart panthers-agent

# 4. Test: Try to register guardian with different MRTD → Should fail
```

**Time:** 30 minutes

---

## 🔥 **PRIORITY 2: PRODUCTION READINESS** (Next 2 Weeks)

### **2.1 Real Trading Setup**

**Current:** Devnet, fake trades, Jupiter returns 401

**Needed:**
1. Valid Jupiter API key
2. Mainnet Solana RPC (QuickNode or Helius)
3. Fund agent wallet with SOL + USDC

**Steps:**
```bash
# 1. Get Jupiter API key
# Sign up at https://station.jup.ag/

# 2. Get mainnet RPC
# QuickNode: https://www.quicknode.com/
# Or Helius: https://www.helius.dev/

# 3. Update .env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
JUPITER_API_KEY=...

# 4. Fund wallet (get address from agent)
# Transfer 0.5 SOL + $100 USDC to agent's Solana address

# 5. Test trade with small position (5% of pool)
```

**Time:** 1 day (mostly waiting for approvals/transfers)

---

### **2.2 Multi-Guardian Deployment**

**Current:** Single guardian = single point of failure

**Needed:** Deploy 2-3 more guardians for resilience

**Steps:**
```bash
# Deploy guardian-2
1. Provision new SecretVM
2. Clone guardian-network repo
3. Set GUARDIAN_EXTERNAL_ENDPOINT=http://<new-ip>:3100
4. Add to BOOTSTRAP_GUARDIANS in agent .env
5. Test registration + attestation

# Deploy guardian-3 (same process)

# Update agent .env
BOOTSTRAP_GUARDIANS=http://67.43.239.6:3100,http://<g2-ip>:3100,http://<g3-ip>:3100
```

**Time:** 4-6 hours (3 guardians × 2 hours each)

---

### **2.3 DB Sync Recovery Testing**

**Current:** Not tested end-to-end

**Needed:** Verify agent can recover from guardian snapshot

**Test Plan:**
```bash
# 1. Agent running, DB synced to guardians
trigger_db_sync  # Via Telegram

# 2. Completely destroy agent
docker compose down -v  # Delete volumes
rm -rf /data/panthers.db

# 3. Redeploy agent
docker compose up

# 4. Verify agent requests DB from guardians
# Check logs: "Requesting DB snapshot from guardians..."

# 5. Verify DB restored
# Check: NFT balances, trade history, fund state
```

**Prerequisite:** Fix #1.1 (vault key persistence)

**Time:** 2 hours

---

## ⚙️ **PRIORITY 3: OPERATIONAL IMPROVEMENTS** (Month 1)

### **3.1 Monitoring Dashboard**

**Needed:** Real-time visibility into fund health

**Metrics to expose:**
- Current pool balance
- Trade count (24h / total)
- P&L (24h / 7d / 30d / all-time)
- Active NFT count
- Guardian health (online/offline)
- Heartbeat status
- Last DB sync timestamp

**Implementation:**
```typescript
// Add /metrics endpoint to agent
app.get('/metrics', async (req, res) => {
  const state = await getFundState();
  const trades = await getTradeHistory(1000);
  const guardians = await getGuardianHealth();
  
  res.json({
    pool_balance: state.poolBalance,
    nft_count: state.activeNFTs,
    trades_24h: trades.filter(t => t.timestamp > Date.now() - 86400000).length,
    pnl_24h: calculatePNL(trades, '24h'),
    pnl_7d: calculatePNL(trades, '7d'),
    pnl_all: calculatePNL(trades, 'all'),
    guardians: guardians.map(g => ({
      id: g.id,
      online: g.lastSeen > Date.now() - 300000, // 5 min
      last_sync: g.lastDBSync
    })),
    heartbeat: {
      last: state.lastHeartbeat,
      status: Date.now() - state.lastHeartbeat < 120000 ? 'OK' : 'STALE'
    }
  });
});
```

**Time:** 1 day

---

### **3.2 Profit Distribution Flow**

**Needed:** Test withdrawal mechanics (2% fee)

**Test Cases:**
```
Scenario 1: User exits with profit
- Alice: $100 → $115 (15% gain)
- Withdrawal: $115 * 0.98 = $112.70 (2% fee = $2.30)
- Fee distributed to other 4 holders proportionally

Scenario 2: User exits with loss
- Bob: $100 → $85 (15% loss)  
- Withdrawal: $85 * 0.98 = $83.30 (2% fee = $1.70)
- Fee distributed to others

Scenario 3: Last holder exits
- Only 1 NFT remaining
- No one to distribute fee to
- Full withdrawal (no 2% fee? Or burn?)
```

**Time:** 1 day

---

### **3.3 P2P Marketplace Flow**

**Needed:** Test NFT trading between users

**Test Sequence:**
```
1. Alice lists Panther #1 for $120
   - verify_listing checks:
     ✓ Alice owns #1
     ✓ Price > current_value
     ✓ Not already listed
   
2. Bob buys #1
   - Bob pays $120 to agent
   - Agent transfers NFT ownership: Alice → Bob
   - Agent pays Alice $120
   - Agent charges 0% fee (as designed)
   
3. Carol cancels her listing
   - Listing removed
   - NFT still owned by Carol
```

**Time:** 1 day

---

## 🔮 **PRIORITY 4: FUTURE ENHANCEMENTS** (Month 2+)

### **4.1 On-Chain NFT Minting**

**Current:** Off-chain ledger (SQLite)

**Needed:** Real Solana NFTs

**Why:** Tradable on OpenSea, provably scarce, composable

**Approach:**
- Metaplex Bubblegum (compressed NFTs, cheap)
- Mint on Secret Network (private balances)
- Bridge between Solana ↔ Secret

**Time:** 1-2 weeks

---

### **4.2 Advanced Strategies**

**Current:** 10 hardcoded strategies (good start)

**Needed:** More sophisticated algorithms

**Ideas:**
- Machine learning models (LSTM, Transformer)
- Multi-asset portfolios (SOL + ETH + BTC)
- Options strategies (covered calls, protective puts)
- Arbitrage (cross-exchange, cross-chain)

**Time:** Ongoing research

---

### **4.3 Governance Evolution**

**Current:** Sentry voting (75% approval)

**Needed:** More nuanced governance

**Ideas:**
- Strategy proposals from NFT holders
- Parameter adjustments (stop loss %, position size %)
- Fee structure votes
- Emergency pause mechanism

**Time:** 2-3 weeks

---

## 📊 **Timeline Summary**

```
WEEK 1 (Critical Blockers):
├─ Day 1-2: Vault key persistence
├─ Day 2-3: LLM fallback
├─ Day 3: APPROVED_MEASUREMENTS
└─ Day 4-5: Testing + verification

WEEK 2-3 (Production Ready):
├─ Real trading setup (Jupiter API, mainnet)
├─ Multi-guardian deployment
├─ DB sync recovery testing
└─ End-to-end production test

MONTH 1 (Operational):
├─ Monitoring dashboard
├─ Withdrawal flow testing
├─ P2P marketplace testing
└─ Performance optimization

MONTH 2+ (Enhancements):
├─ On-chain NFT minting
├─ Advanced strategies
└─ Governance evolution
```

---

## ✅ **Immediate Next Steps** (Today)

1. **Deploy vault key persistence fix** (3 hours)
   - Implement VaultKeyManager
   - Test persistence across restarts
   - Verify DB sync works

2. **Add OpenAI fallback** (2 hours)
   - Get OpenAI API key
   - Implement ResilientLLMClient
   - Test failover

3. **Lock down APPROVED_MEASUREMENTS** (30 min)
   - Get guardian MRTD
   - Update agent .env
   - Test rejection of rogue guardians

**After these 3 fixes, you have a production-ready system!** 🚀

---

## 🎯 **Success Criteria**

**Week 1 Complete:**
- ✅ Vault key persists across restarts
- ✅ Bot responds even when SecretAI is down
- ✅ Only approved guardians can register
- ✅ DB sync recovery tested

**Week 3 Complete:**
- ✅ Real trades executing on mainnet
- ✅ 3+ guardians online
- ✅ Full failover tested
- ✅ Monitoring dashboard live

**Month 1 Complete:**
- ✅ 10+ users with NFTs
- ✅ $1000+ in pooled funds
- ✅ 100+ successful trades
- ✅ 99.9% uptime
- ✅ All withdrawal/P2P flows tested

---

**Focus on Priority 1 this week - everything else depends on it!**
