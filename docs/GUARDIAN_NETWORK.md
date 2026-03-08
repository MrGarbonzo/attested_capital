# 🛡️ Guardian & Sentry Network - Complete Guide

**For:** Panthers Fund - Attested Capital  
**Purpose:** Decentralized infrastructure, backup, verification, and governance

**Last Updated:** February 26, 2026

---

## 🎯 TL;DR

```
Guardian = Anyone can run, provides infrastructure, NO voting
Sentry = Must own NFTs, accepts delegations, HAS voting power

Think: Bitcoin nodes vs Ethereum validators
```

**Why Two Tiers?**
- Separates infrastructure (permissionless) from governance (economic stake)
- Prevents Sybil attacks on voting
- Allows anyone to contribute to security
- Ensures governance is aligned with fund performance

---

## 📊 Quick Comparison

| Feature | Guardian | Sentry |
|---------|----------|--------|
| **Who can run?** | Anyone | NFT holders only |
| **Requirements** | None | Own 1+ Panther NFT |
| **Cost** | ~$5/month | ~$20/month + opportunity cost |
| **Voting power** | NONE | Based on owned + delegated NFTs |
| **Accepts delegations?** | NO | YES |
| **Functions** | Infrastructure only | Infrastructure + Governance |
| **Can be Sybil attacked?** | Yes (but doesn't matter) | No (must own NFTs) |
| **Quantity** | Unlimited (50-500+) | Limited (~10-20 quality ones) |
| **Like** | Bitcoin node | Cosmos validator |

---

## 🛠️ What Guardians Do

**Infrastructure Layer (No Governance)**

### **1. Store Database Backups (Attested Channel)**

```typescript
// Fund Manager sends database every hour via verified message signing
async function storeBackup(database: string) {
  // Fund Manager already verified our attestation before sending
  await this.storage.save('panthers-backup-' + Date.now(), database);

  // Keep last 1000 snapshots (~41 days at hourly)
  await this.storage.cleanup(1000);

  console.log('Backup stored');
}
```

**Why:** If fund manager crashes, can recover from any guardian in <5 minutes

---

### **2. Serve RPC Registry**

```typescript
// Fund Manager queries guardians for RPC list
async function getRPCs(chain: string): string[] {
  const rpcs = await this.db.query(`
    SELECT url FROM rpc_registry 
    WHERE chain = ? AND status = 'active'
    ORDER BY reputation DESC
  `, [chain]);
  
  return rpcs.map(r => r.url);
}
```

**Why:** Fund manager doesn't need to SSH to update RPCs, guardians manage via consensus

---

### **3. Verify Balances Independently**

```typescript
// Guardian independently calculates balances (every hour)
async function verifyBalances() {
  // 1. Get Fund Manager's reported balance
  const reported = await fetch('https://panthers/api/balance');
  
  // 2. Query chains DIRECTLY (independent RPCs)
  const solana = await querySolana(INDEPENDENT_RPC);
  const base = await queryBase(INDEPENDENT_RPC);
  const ethereum = await queryEthereum(INDEPENDENT_RPC);
  const secret = await querySecret(INDEPENDENT_RPC);
  
  // 3. Calculate total
  const calculated = solana + base + ethereum + secret;
  
  // 4. Compare
  const diff = Math.abs(calculated - reported) / calculated;
  
  if (diff > 0.01) {
    // More than 1% difference = ALERT SENTRIES
    await this.alertSentries('BALANCE_MISMATCH', { 
      reported, 
      calculated, 
      diff 
    });
  }
  
  // 5. Post to shared registry
  await registry.updateStatus({
    balances_verified: diff < 0.01,
    last_check: Date.now()
  });
}
```

**Why:** Prevents fund manager from lying about balances

---

### **4. Detect Anomalies**

```typescript
// Monitor fund health (every 10 minutes)
async function detectAnomalies() {
  const anomalies = [];
  
  // Check 1: Too many trades?
  const recentTrades = await getTrades('1hour');
  if (recentTrades.length > 15) {
    anomalies.push('excessive_trading');
  }
  
  // Check 2: Position too large?
  const positions = await getPositions();
  if (positions.some(p => p.size > 0.35)) {
    anomalies.push('position_violation');
  }
  
  // Check 3: Steep loss?
  const pnl24h = await get24hPnL();
  if (pnl24h < -0.15) {
    anomalies.push('steep_loss');
  }
  
  // Check 4: Missing attestations?
  if (recentTrades.some(t => !t.attestation)) {
    anomalies.push('missing_attestation');
  }
  
  if (anomalies.length > 0) {
    await this.alertSentries('ANOMALIES_DETECTED', anomalies);
  }
}
```

**Why:** Early detection of issues, alert sentries to vote on resolution

---

### **5. Track Delegations**

```typescript
// Record NFT holder delegations to sentries
async function recordDelegation(delegation: Delegation) {
  // 1. Verify signature
  const valid = await this.verifySignature(delegation);
  if (!valid) throw new Error('Invalid signature');
  
  // 2. Verify NFT ownership
  for (const tokenId of delegation.nftTokenIds) {
    const owner = await nftContract.ownerOf(tokenId);
    if (owner !== delegation.delegator) {
      throw new Error('Not owner');
    }
  }
  
  // 3. Calculate voting power (use CURRENT balances)
  let totalValue = 0;
  for (const tokenId of delegation.nftTokenIds) {
    const account = await fundManager.getNFTAccount(tokenId);
    totalValue += account.current_balance;
  }
  
  // 4. Save to shared database
  await this.delegationDB.save({
    ...delegation,
    totalValue,
    timestamp: Date.now()
  });
  
  // 5. Broadcast to all guardians
  await this.broadcastToGuardians({
    type: 'DELEGATION_UPDATE',
    delegation
  });
}
```

**Why:** Enables delegated staking without smart contracts

---

### **6. Provide Recovery Data**

```typescript
// New Fund Manager requests backup (must prove attestation first)
async function provideBackup(attestation: string): string {
  // Verify requester is legitimate fund manager via TEE attestation
  if (!await this.verifyAttestation(attestation)) {
    throw new Error('Invalid attestation');
  }

  // Send latest backup over verified message signing channel
  const backup = await this.storage.getLatest();

  return backup.data;
}
```

**Why:** Recovery in <5 minutes if fund crashes

---

## 🗳️ What Sentries Do

**All Guardian Functions + Governance**

### **1. All Guardian Infrastructure**

Sentries run everything guardians do:
- ✅ Store backups
- ✅ Serve RPCs
- ✅ Verify balances
- ✅ Detect anomalies
- ✅ Track delegations
- ✅ Provide recovery

---

### **2. Accept Delegations**

```typescript
// Sentry accepts delegations from NFT holders
async function registerAsSentry(nftTokenIds: number[]) {
  // Verify ownership of all NFTs
  for (const tokenId of nftTokenIds) {
    const owner = await nftContract.ownerOf(tokenId);
    if (owner !== this.address) {
      throw new Error(`Don't own NFT #${tokenId}`);
    }
  }
  
  this.ownedNFTs = nftTokenIds;
  
  // Broadcast to network
  await this.broadcastToGuardians({
    type: 'NEW_SENTRY',
    address: this.address,
    ownedNFTs: nftTokenIds,
    attestation: await this.generateAttestation()
  });
  
  console.log('Sentry registered, can now accept delegations');
}
```

---

### **3. Calculate Voting Power**

```typescript
// Sentry voting power = own NFTs + delegated NFTs
async function calculateVotingPower(): Promise<number> {
  // Get own NFT balances (use CURRENT balance, not initial)
  let ownedValue = 0;
  for (const tokenId of this.ownedNFTs) {
    const account = await fundManager.getNFTAccount(tokenId);
    ownedValue += account.current_balance;
  }
  
  // Get delegated value from guardians (query multiple for consensus)
  const guardians = await this.getActiveGuardians();
  const votingPowers = await Promise.all(
    guardians.slice(0, 3).map(g => g.getSentryVotingPower(this.address))
  );
  
  // Use median (prevents one guardian from lying)
  const delegatedValue = this.median(votingPowers);
  
  // Total voting power
  const totalValue = ownedValue + delegatedValue;
  const totalPool = await fundManager.getTotalPool();
  
  return totalValue / totalPool; // Percentage
}
```

**Example:**
```
Bob's Sentry:
  Own NFTs: #10 ($2,000), #50 ($5,000) = $7,000
  Delegated: 50 holders delegate $25,000
  
Total: $32,000
Pool: $250,000
Voting power: 12.8%
```

---

### **4. Vote on Code Updates**

```typescript
// Sentry votes on proposed code update
async function voteOnUpdate(proposalId: string, approve: boolean) {
  // 1. Calculate voting power
  const votingPower = await this.calculateVotingPower();
  
  // 2. Create vote
  const vote = {
    proposalId,
    sentry: this.address,
    approve,
    votingPower, // e.g., 0.128 = 12.8%
    timestamp: Date.now()
  };
  
  // 3. Sign with TEE attestation
  vote.signature = await this.signWithAttestation(vote);
  
  // 4. Broadcast to guardians
  await this.broadcastVote(vote);
  
  console.log(`Voted ${approve ? 'YES' : 'NO'} with ${(votingPower * 100).toFixed(1)}% power`);
}
```

**Threshold:** Need 75% of TOTAL POOL to pass (not just delegated)

---

### **5. Vote on RPC Updates**

```typescript
// Sentry votes on proposed RPC addition
async function voteOnRPC(rpcProposal: RPCProposal, approve: boolean) {
  // 1. Test RPC ourselves first
  const testResults = await this.testRPC(rpcProposal.chain, rpcProposal.url);
  
  if (!testResults.connectivity || !testResults.correctData || !testResults.ssl) {
    console.warn('RPC failed tests, voting NO');
    approve = false;
  }
  
  // 2. Vote (same as code update)
  const votingPower = await this.calculateVotingPower();
  
  const vote = {
    proposalId: rpcProposal.id,
    sentry: this.address,
    approve,
    votingPower,
    testResults,
    timestamp: Date.now()
  };
  
  vote.signature = await this.signWithAttestation(vote);
  await this.broadcastVote(vote);
}
```

---

### **6. Vote on Anomaly Resolution**

```typescript
// Sentry votes on how to handle detected anomaly
async function voteOnAnomaly(anomalyId: string, decision: 'RESUME' | 'INVESTIGATE' | 'EMERGENCY') {
  // Independently verify the anomaly
  const verified = await this.verifyAnomaly(anomalyId);
  
  const votingPower = await this.calculateVotingPower();
  
  const vote = {
    anomalyId,
    sentry: this.address,
    decision,
    votingPower,
    verificationResults: verified,
    timestamp: Date.now()
  };
  
  vote.signature = await this.signWithAttestation(vote);
  await this.broadcastVote(vote);
}
```

---

## 🗳️ Delegated Staking (No Smart Contracts)

### **How NFT Holders Delegate**

```typescript
// Alice owns NFT #123 (current_balance = $100)
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

// Guardians verify and track
// Bob can now vote with Alice's $100 + his own stake
```

**Key Points:**
- No NFT transfer (stays in wallet)
- Can undelegate anytime
- Guardians track in shared DB
- Sentry gets voting power

---

### **Why Delegate?**

**Problem without delegation:**
```
Whale owns 200 NFTs ($100k = 40% of fund)
Small holders don't participate
Whale almost controls governance alone
```

**Solution with delegation:**
```
280 small holders delegate to Alice's sentry = $47k
Alice has 47% voting power
Whale has 40% voting power
Community coalition prevails ✅
```

**Benefits:**
- Small holders can participate via delegation
- Sentries compete for delegations (reputation matters)
- Prevents single whale control
- No custody risk (NFT never leaves wallet)

---

## 🏗️ Network Architecture

**Peer Discovery: Telegram-Based**
```
1. Fund Manager + Guardians join shared Telegram group
2. Exchange connection info (IP, port) via Telegram DMs
3. Connect directly for data transfer
4. Verify attestation over direct connection
5. Telegram NEVER sees database data — only connection metadata
```

```
Fund Manager (TEE)
     ↓
     | Hourly database backups (attested channel)
     | Trade broadcasts
     | Anomaly requests
     ↓
┌────────────────────────────────────┐
│  Guardian Layer (50-500 nodes)     │
│  - Store backups (attested)        │
│  - Serve RPCs                      │
│  - Verify balances                 │
│  - Detect anomalies                │
│  - Track delegations               │
│  - NO voting                       │
└────────────────────────────────────┘
     ↓
     | Alerts, proposals, votes
     ↓
┌────────────────────────────────────┐
│  Sentry Layer (10-20 nodes)        │
│  - All guardian functions +        │
│  - Accept delegations              │
│  - Vote on updates (75%)           │
│  - Economic alignment              │
└────────────────────────────────────┘
```

---

## 🔄 Recovery Process

**If Fund Manager crashes:**

```typescript
1. Deploy new Fund Manager in TEE
   const newManager = deployNewTEE();

2. Generate attestation
   const attestation = await generateAttestation();

3. Discover guardians via Telegram group
   const guardians = await discoverGuardiansViaTelegram();

4. Request database from ANY guardian (attested channel)
   for (const guardian of guardians) {
     // Connect directly, verify attestation on both sides
     const connection = await guardian.connect(attestation);

     if (connection.verified) {
       // Receive DB over verified message signing channel
       const database = await connection.requestDatabase();

       // Restore full state
       await restoreFromDatabase(database);

       console.log("✓ Recovery complete!");
       return;
     }
   }
```

**Recovery time: 2-5 minutes (fully automated)**

**Requirements:**
- ANY 1 guardian online
- Valid TEE attestation on both sides
- Telegram for peer discovery
- No human intervention

---

## 💰 Economics

### **Guardian Economics**

**Why run a guardian?**
- Contribute to crypto ecosystem (altruism)
- If you own Panthers, you want backups/recovery to work
- Learn TEE and autonomous trading tech
- Help secure the fund

**Cost:** ~$5/month (small VPS)

**Income:** $0 (no payment, community service)

**ROI:** Non-monetary
- Reputation in community
- Learning experience
- Warm fuzzy feeling

---

### **Sentry Economics**

**Why run a sentry?**

1. **Economic Incentive:**
   - You own NFTs
   - Good governance → Better fund performance
   - Better performance → Your NFTs appreciate
   - Extra 5% annual return on $10k = $500/year

2. **Career Building:**
   - "Sentry for $250k autonomous fund" on resume
   - Network with other crypto builders
   - Hands-on experience with cutting-edge tech

3. **Reputation:**
   - Public leaderboard (uptime, votes, reviews)
   - Community recognition
   - Gain delegations from trust

4. **Voting Power:**
   - Influence fund direction
   - Protect your investment
   - Propose changes you want

5. **Future Rewards:**
   - If Panthers succeeds → Launch Panthers V2
   - Early sentries get priority/airdrops
   - Similar to early Bitcoin miners

**Cost:** ~$20/month + 10 hours/month

**Income:** $0 direct (but NFTs may appreciate from good governance)

**ROI Calculation:**
```
Own $10,000 in NFTs
Good governance adds 5% annual return
Extra gain: $500/year

Costs:
  Server: $240/year
  Time: 120 hours/year

Net: $260/year + non-monetary benefits

Worth it if:
  - You own $10k+ in NFTs, OR
  - You value career/reputation benefits
```

---

## 🔒 Security Properties

### **Why Separate Guardian and Sentry?**

**Attack Scenario: If guardians could vote**
```
Attacker spins up 1000 guardian nodes
  Cost: $5,000/month
  
Attacker gets: 90% of voting power
  
Attacker votes: Malicious update to steal fund
  
Result: CATASTROPHIC ❌
```

**Defense: Two-tier system**
```
Attacker spins up 1000 guardians:
  Cost: $5,000/month
  Voting power: 0% (guardians can't vote)
  Effect: Actually HELPS network (more backups!)
  Result: Attack fails ✅

Attacker wants voting power:
  Must buy NFTs to become sentry
  Need: 75% of $250k pool = $187,500 in NFTs
  But: Then you own 75% of fund
  Stealing from yourself = pointless
  Result: Economically irrational ✅
```

**Key Insight:** Separating infrastructure (permissionless) from governance (economic stake) prevents Sybil attacks while allowing anyone to contribute.

---

## 📋 How to Participate

### **Run a Guardian (Easy)**

```bash
# 1. Pull Docker image
docker pull ghcr.io/attestedcapital/guardian:latest

# 2. Run
docker run \
  --device /dev/tdx_guest \
  -e FUND_ID=panthers \
  ghcr.io/attestedcapital/guardian:latest

# That's it! You're contributing to infrastructure
```

**Requirements:** None  
**Cost:** $5/month (small VPS)  
**Time:** 1 hour setup, 1 hour/month maintenance  

---

### **Run a Sentry (Moderate)**

```bash
# 1. Must own 1+ Panther NFT

# 2. Pull Docker image
docker pull ghcr.io/attestedcapital/sentry:latest

# 3. Run with NFT proof
docker run \
  --device /dev/tdx_guest \
  -e FUND_ID=panthers \
  -e NFT_TOKEN_IDS=10,50,100 \
  -e WALLET_ADDRESS=0xYOUR_ADDRESS \
  ghcr.io/attestedcapital/sentry:latest

# 4. Verify ownership (proves you own the NFTs)
# 5. Accept delegations and start voting!
```

**Requirements:** Own 1+ Panther NFT  
**Cost:** $20/month + opportunity cost  
**Time:** 2 hours setup, 10 hours/month (code reviews, voting)

---

### **Delegate (Very Easy)**

```bash
# Via Telegram bot
/delegate @BobsSentry

# Or sign delegation message via wallet
# NFT stays in your wallet
# Can undelegate anytime
```

**Requirements:** Own 1+ Panther NFT  
**Cost:** $0  
**Time:** 5 minutes

---

## 🎯 Governance Flow Example

```
Week 5: Bug discovered in trading engine

1. Developer fixes bug, pushes to GitHub
   git push origin bug-fix-xyz
   
2. Developer proposes update:
   createProposal({
     type: 'CODE_UPDATE',
     version: 'v1.1.0',
     gitCommit: 'abc123',
     description: 'Fix rounding error in P&L distribution'
   })
   → Broadcasts to all guardians
   → Guardians relay to all sentries
   
3. Sentries review code:
   
   Alice's Sentry:
     - Pulls code from GitHub
     - Reviews diff
     - Runs tests
     - Checks for suspicious patterns
     - Builds Docker image
     - Verifies code hash
     - Decision: APPROVE ✅
   
   Bob's Sentry:
     - Same review process
     - Decision: APPROVE ✅
   
   Carol's Sentry:
     - Same review process
     - Decision: APPROVE ✅
   
4. Voting:
   
   Alice: 22% voting power → YES
   Bob: 11% voting power → YES
   Carol: 48% voting power → YES
   
   Total YES: 81%
   Threshold: 75%
   Result: APPROVED ✅
   
5. Automated deployment:
   
   a. Fund Manager sends database to guardians via attested channel
   b. Guardians store backup
   c. Graceful shutdown (finishes current operation)
   d. Deploy new Docker image
   e. New Fund Manager requests DB from guardians
   f. Verifies integrity and invariants
   g. Resumes operations
   
   Total downtime: ~5 minutes

Total timeline: 
  - Review: 48 hours
  - Deployment: 30 minutes
  - Zero human intervention
```

---

## ❓ FAQ

**Q: Can a guardian become a sentry later?**  
A: Yes! Just buy a Panther NFT and restart as a sentry node.

**Q: Can a sentry run without accepting delegations?**  
A: Yes! You can run a sentry with only your own NFTs.

**Q: What if all sentries go offline?**  
A: Fund keeps trading (doesn't need sentries for trading). But governance halts until sentries return.

**Q: What if all guardians go offline?**  
A: Fund keeps running but can't recover if it crashes. At least 1 guardian should be online.

**Q: Can I run both guardian and sentry?**  
A: Yes, but just run sentry (does everything guardian does + governance).

**Q: Is there a minimum NFT amount to run a sentry?**  
A: No minimum, but probably not worth it unless you own $5k+ (to cover time/costs).

**Q: Can I sell my NFTs while running a sentry?**  
A: Yes, but you'll lose voting power. Delegators might undelegate if you have no stake.

**Q: How do delegators know which sentry to trust?**  
A: Public leaderboard shows uptime, votes cast, code reviews, reputation. Choose based on track record.

**Q: What happens if a sentry votes maliciously?**  
A: Delegators see the vote, undelegate immediately, sentry loses all delegated power.

**Q: Can guardians see the database contents?**
A: Yes, guardians hold real copies. Security comes from attestation verification — only verified nodes can connect and receive data. Guardians are trusted infrastructure contributors.

**Q: Who pays for guardian infrastructure?**  
A: Volunteers (altruism). Costs ~$5/month, manageable for community members.

**Q: What if no one wants to run guardians?**  
A: Fund still works, just no backup/recovery. But if you own Panthers, you'd want guardians running!

---

## 🚀 Summary

**Guardians (Infrastructure):**
- Anyone can run
- Discover peers via Telegram, connect directly
- Store backups (attested channel), serve RPCs, verify balances
- No voting power
- Permissionless
- ~50-500 nodes

**Sentries (Governance):**
- Must own NFTs
- All guardian functions + voting
- Accept delegations
- Economic alignment
- ~10-20 nodes

**Result:**
- Decentralized infrastructure
- Trustless verification
- Fast recovery (<5 min)
- Sybil-resistant governance
- Community-driven decisions

---

**More info:**
- Technical: BUILD_PLAN_GUARDIAN.md
- System: ARCHITECTURE.md
- Fund Manager: BUILD_PLAN_FUND_MANAGER.md

🐆 **Attested Capital: Don't trust. Attest.**
