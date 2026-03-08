# 🛡️ Guardian/Sentry Network - Build Plan

**Project:** Infrastructure & Governance for Panthers Fund  
**Timeline:** 6 weeks to production launch  
**Foundation:** Express.js + SQLite + P2P messaging

---

## 📋 What We're Building

**Two-Tier Network:**

**1. Guardians (Infrastructure - Anyone Can Run)**
- Store database backups from fund manager (via attested channel)
- Serve RPC registry to fund manager
- Monitor fund health and alert sentries
- Provide recovery data if fund crashes
- Track delegation records
- **NO voting power**

**2. Sentries (Governance - NFT Holders Only)**
- All guardian functions PLUS:
- Accept delegations from other NFT holders
- Vote on code updates (75% threshold)
- Vote on RPC updates (75% threshold)
- Vote on anomaly resolution
- **Voting power = owned NFTs + delegated NFTs (by current balance)**

**Infrastructure:** Any VPS + Docker (Intel TDX optional for sentries)

---

## 🏗️ Project Structure

```
C:\dev\attested_capital\guardian-network\

├─ src/
│  ├─ guardian/                    ⭐ GUARDIAN (INFRASTRUCTURE)
│  │  ├─ index.ts                  Express server
│  │  ├─ storage.ts                Store DB backups (attested channel)
│  │  ├─ rpc-registry.ts           Serve RPC list to fund manager
│  │  ├─ health-monitor.ts         Monitor fund health
│  │  ├─ recovery.ts               Provide DB for recovery
│  │  └─ delegation-tracker.ts     Track delegations
│  │
│  ├─ sentry/                      ⭐ SENTRY (GOVERNANCE)
│  │  ├─ index.ts                  Extends Guardian
│  │  ├─ voting.ts                 Vote on proposals
│  │  ├─ proposal-review.ts        Review code updates
│  │  ├─ rpc-testing.ts            Test proposed RPCs
│  │  └─ delegation-manager.ts     Accept delegations
│  │
│  ├─ shared/
│  │  ├─ p2p.ts                    P2P messaging (guardian ↔ guardian)
│  │  ├─ db.ts                     SQLite wrapper
│  │  ├─ attestation.ts            TEE attestation (sentry only)
│  │  └─ types.ts                  Shared types
│  │
│  └─ api/
│     ├─ guardian-api.ts           REST API for guardians
│     └─ sentry-api.ts             REST API for sentries
│
├─ database/
│  ├─ guardian.db                  Local guardian database
│  └─ schema.sql                   Database schema
│
├─ config/
│  ├─ guardian.json                Guardian config
│  ├─ sentry.json                  Sentry config (includes NFTs)
│  └─ fund-manager.json            Fund Manager endpoints
│
├─ tests/
│  ├─ guardian.test.ts
│  ├─ sentry.test.ts
│  └─ voting.test.ts
│
├─ Dockerfile.guardian             Guardian Docker image
├─ Dockerfile.sentry               Sentry Docker image (with TEE)
├─ package.json
└─ README.md                       "How to run a guardian/sentry"
```

---

## 📅 6-Week Build Timeline

### **Week 1: Guardian - Basic Infrastructure**

**What to Build:**

```typescript
// src/guardian/index.ts
class Guardian {
  private db: Database;
  private storage: BackupStorage;
  private peers: Map<string, Guardian> = new Map();
  
  async initialize() {
    // 1. Set up database
    await this.db.initialize();

    // 2. Discover peers via Telegram group
    //    - Guardian joins Telegram group (env: TELEGRAM_BOT_TOKEN + GROUP_ID)
    //    - Exchanges connection info (IP, port) with other guardians via DM
    //    - Connects directly for data transfer
    //    - Telegram NEVER sees database data — only connection metadata
    await this.discoverPeersViaTelegram();

    // 3. Start API server
    await this.startServer();

    // 4. Start monitoring
    await this.startHealthMonitor();

    console.log('Guardian initialized');
  }
  
  // FUNCTION 1: Store database backups (received via attested channel)
  async storeBackup(backup: AttestedBackup) {
    // Verify fund manager's attestation
    if (!await this.verifyFundManagerAttestation(backup.attestation)) {
      throw new Error('Invalid fund manager attestation');
    }

    // Store locally (received unencrypted via verified message signing)
    await this.storage.save({
      id: backup.id,
      timestamp: backup.timestamp,
      data: backup.data,
      fund_manager_address: backup.from
    });

    // Keep last 1000 backups (~41 days at hourly)
    await this.storage.cleanup(1000);

    console.log(`Stored backup ${backup.id}`);
  }
  
  // FUNCTION 2: Serve RPC registry
  async getRPCs(chain: string): string[] {
    // Query local RPC registry
    const rpcs = await this.db.query(`
      SELECT url FROM rpc_registry 
      WHERE chain = ? AND status = 'active'
      ORDER BY reputation DESC
    `, [chain]);
    
    return rpcs.map(r => r.url);
  }
  
  // FUNCTION 3: Monitor fund health
  async monitorHealth() {
    // Query fund manager for status
    const status = await fetch('https://fund-manager/api/health');
    
    // Check if anomaly
    if (status.anomaly) {
      await this.alertSentries({
        type: 'ANOMALY_DETECTED',
        details: status
      });
    }
  }
  
  // FUNCTION 4: Provide recovery data (after verifying attestation)
  async provideBackup(attestation: string): Backup {
    // Verify requester is legitimate fund manager via TEE attestation
    if (!await this.verifyAttestation(attestation)) {
      throw new Error('Invalid attestation');
    }

    // Send latest backup over verified message signing channel
    const backup = await this.storage.getLatest();

    return backup;
  }
}
```

**Database Schema:**
```sql
-- Backup storage (received via attested signed channel, stored locally)
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  data BLOB NOT NULL,
  fund_manager_address TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
);

-- RPC registry
CREATE TABLE rpc_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  status TEXT CHECK (status IN ('active', 'trial', 'deprecated')),
  reputation INTEGER DEFAULT 0
);

-- Peer guardians
CREATE TABLE peers (
  address TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  is_sentry BOOLEAN DEFAULT FALSE
);
```

**Success Criteria:**
- ✅ Can store and retrieve backups via attested channels
- ✅ Serves RPC registry to fund manager
- ✅ Monitors fund health
- ✅ Provides recovery data

---

### **Week 2: Guardian - RPC Management**

**What to Build:**

```typescript
// src/guardian/rpc-registry.ts
class RPCRegistry {
  // Guardian receives RPC proposal from sentry
  async handleRPCProposal(proposal: RPCProposal) {
    // 1. Verify proposer is a sentry
    if (!await this.verifySentry(proposal.proposer)) {
      throw new Error('Only sentries can propose RPCs');
    }
    
    // 2. Test RPC ourselves
    const testResults = await this.testRPC(proposal.chain, proposal.url);
    
    // 3. Save proposal
    await this.db.execute(`
      INSERT INTO rpc_proposals (chain, url, proposer, test_results, status)
      VALUES (?, ?, ?, ?, 'pending')
    `, [proposal.chain, proposal.url, proposal.proposer, JSON.stringify(testResults)]);
    
    // 4. Broadcast to all guardians
    await this.broadcastToGuardians({
      type: 'RPC_PROPOSAL',
      proposal
    });
  }
  
  // Test RPC functionality
  async testRPC(chain: string, url: string): Promise<TestResults> {
    const tests = {
      connectivity: false,
      correctData: false,
      latency: 0,
      ssl: false
    };
    
    try {
      // Test 1: Can connect?
      const start = Date.now();
      const response = await fetch(url, { timeout: 5000 });
      tests.latency = Date.now() - start;
      tests.connectivity = response.ok;
      
      // Test 2: Returns correct data?
      const balance = await this.queryBalance(url, TEST_ADDRESS);
      const knownGoodBalance = await this.queryBalance(KNOWN_GOOD_RPC, TEST_ADDRESS);
      tests.correctData = Math.abs(balance - knownGoodBalance) < 0.01;
      
      // Test 3: SSL valid?
      tests.ssl = url.startsWith('https://') && await this.verifySSL(url);
      
    } catch (error) {
      console.error('RPC test failed:', error);
    }
    
    return tests;
  }
  
  // After sentry vote passes, add RPC
  async addRPC(chain: string, url: string) {
    await this.db.execute(`
      INSERT INTO rpc_registry (chain, url, added_by, added_at, status)
      VALUES (?, ?, 'sentry_vote', ?, 'trial')
    `, [chain, url, Date.now()]);
    
    console.log(`Added RPC: ${url} for ${chain} (trial mode)`);
  }
  
  // Track RPC performance
  async trackRPCPerformance(url: string, success: boolean, latency: number) {
    // Update reputation
    const delta = success ? 1 : -5;
    
    await this.db.execute(`
      UPDATE rpc_registry
      SET reputation = reputation + ?
      WHERE url = ?
    `, [delta, url]);
    
    // Remove if reputation < -20
    const rpc = await this.db.query('SELECT reputation FROM rpc_registry WHERE url = ?', [url]);
    if (rpc.reputation < -20) {
      console.warn(`Removing RPC ${url} due to poor reputation`);
      await this.db.execute('DELETE FROM rpc_registry WHERE url = ?', [url]);
    }
  }
}
```

**Success Criteria:**
- ✅ Can test proposed RPCs
- ✅ Tracks RPC performance
- ✅ Auto-removes bad RPCs
- ✅ Serves best RPCs to fund manager

---

### **Week 3: Guardian - Delegation Tracking**

**What to Build:**

```typescript
// src/guardian/delegation-tracker.ts
class DelegationTracker {
  // Receive delegation from NFT holder
  async recordDelegation(delegation: Delegation) {
    // 1. Verify signature
    const valid = await this.verifySignature(
      delegation.delegator,
      delegation,
      delegation.signature
    );
    
    if (!valid) {
      throw new Error('Invalid delegation signature');
    }
    
    // 2. Verify NFT ownership
    for (const tokenId of delegation.nftTokenIds) {
      const owner = await nftContract.ownerOf(tokenId);
      if (owner !== delegation.delegator) {
        throw new Error(`Delegator doesn't own NFT #${tokenId}`);
      }
    }
    
    // 3. Calculate total voting power (current balances)
    let totalValue = 0;
    for (const tokenId of delegation.nftTokenIds) {
      const account = await fundManager.getNFTAccount(tokenId);
      totalValue += account.current_balance; // Use CURRENT balance
    }
    
    delegation.totalValue = totalValue;
    
    // 4. Save delegation
    await this.db.execute(`
      INSERT INTO delegations (delegator, sentry, nft_token_ids, total_value, signature, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(delegator) DO UPDATE SET
        sentry = excluded.sentry,
        nft_token_ids = excluded.nft_token_ids,
        total_value = excluded.total_value,
        signature = excluded.signature,
        expires_at = excluded.expires_at
    `, [
      delegation.delegator,
      delegation.sentry,
      JSON.stringify(delegation.nftTokenIds),
      totalValue,
      delegation.signature,
      delegation.expiresAt
    ]);
    
    // 5. Broadcast to all guardians
    await this.broadcastToGuardians({
      type: 'DELEGATION_UPDATE',
      delegation
    });
    
    console.log(`Recorded delegation: ${delegation.delegator} → ${delegation.sentry} ($${totalValue})`);
  }
  
  // Update delegation values hourly (as NFT balances change)
  async updateDelegationValues() {
    const delegations = await this.db.query('SELECT * FROM delegations');
    
    for (const delegation of delegations) {
      const nftTokenIds = JSON.parse(delegation.nft_token_ids);
      let totalValue = 0;
      
      for (const tokenId of nftTokenIds) {
        try {
          const account = await fundManager.getNFTAccount(tokenId);
          totalValue += account.current_balance;
        } catch (error) {
          console.warn(`Couldn't get balance for NFT #${tokenId}`);
        }
      }
      
      await this.db.execute(`
        UPDATE delegations 
        SET total_value = ?
        WHERE delegator = ?
      `, [totalValue, delegation.delegator]);
    }
    
    console.log('Updated delegation values');
  }
  
  // Get sentry's total voting power
  async getSentryVotingPower(sentryAddress: string): Promise<number> {
    const delegations = await this.db.query(`
      SELECT SUM(total_value) as total
      FROM delegations
      WHERE sentry = ? AND expires_at > ?
    `, [sentryAddress, Date.now()]);
    
    return delegations.total || 0;
  }
}
```

**Database Schema:**
```sql
CREATE TABLE delegations (
  delegator TEXT PRIMARY KEY,
  sentry TEXT NOT NULL,
  nft_token_ids TEXT NOT NULL, -- JSON array
  total_value REAL NOT NULL,   -- Sum of current_balance
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_delegations_sentry ON delegations(sentry);
```

**Success Criteria:**
- ✅ Can record delegations
- ✅ Updates values hourly as balances change
- ✅ Calculates sentry voting power correctly

---

### **Week 4: Sentry - Governance & Voting**

**What to Build:**

```typescript
// src/sentry/index.ts
class Sentry extends Guardian {
  private ownedNFTs: number[] = [];
  
  async initialize() {
    // All guardian functions +
    await super.initialize();
    
    // Verify we own NFTs
    await this.verifyNFTOwnership();
    
    // Generate TEE attestation (proves we're running official code)
    this.attestation = await generateAttestation({
      codeHash: SENTRY_CODE_HASH,
      data: { address: this.address, ownedNFTs: this.ownedNFTs }
    });
    
    // Broadcast to network
    await this.broadcastToGuardians({
      type: 'NEW_SENTRY',
      address: this.address,
      ownedNFTs: this.ownedNFTs,
      attestation: this.attestation
    });
    
    console.log('Sentry initialized with voting power');
  }
  
  private async verifyNFTOwnership() {
    for (const tokenId of this.ownedNFTs) {
      const owner = await nftContract.ownerOf(tokenId);
      if (owner !== this.address) {
        throw new Error(`Don't own NFT #${tokenId}`);
      }
    }
  }
  
  // Calculate total voting power (own + delegated)
  async calculateVotingPower(): Promise<number> {
    // Get own NFT balances
    let ownedValue = 0;
    for (const tokenId of this.ownedNFTs) {
      const account = await fundManager.getNFTAccount(tokenId);
      ownedValue += account.current_balance;
    }
    
    // Get delegated value from guardians
    const guardians = await this.getActiveGuardians();
    const votingPowers = await Promise.all(
      guardians.slice(0, 3).map(g => g.getSentryVotingPower(this.address))
    );
    
    // Use median (prevents one guardian from lying)
    const delegatedValue = this.median(votingPowers);
    
    // Total voting power
    const totalValue = ownedValue + delegatedValue;
    
    // Get total pool
    const totalPool = await fundManager.getTotalPool();
    
    // Return as percentage
    return totalValue / totalPool;
  }
  
  // Vote on code update
  async voteOnUpdate(proposalId: string, approve: boolean) {
    const votingPower = await this.calculateVotingPower();
    
    const vote = {
      proposalId,
      sentry: this.address,
      approve,
      votingPower,
      ownedNFTs: this.ownedNFTs,
      timestamp: Date.now()
    };
    
    // Sign with TEE attestation
    vote.signature = await this.signWithAttestation(vote);
    
    // Broadcast to guardians
    await this.broadcastVote(vote);
    
    console.log(`Voted ${approve ? 'YES' : 'NO'} on ${proposalId} with ${(votingPower * 100).toFixed(1)}% power`);
  }
  
  // Vote on RPC update
  async voteOnRPC(rpcProposal: RPCProposal, approve: boolean) {
    // 1. Test RPC ourselves first
    const testResults = await this.testRPC(rpcProposal.chain, rpcProposal.url);
    
    if (!testResults.connectivity || !testResults.correctData || !testResults.ssl) {
      console.warn(`RPC failed tests, voting NO`);
      approve = false;
    }
    
    // 2. Vote
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
  
  // Vote on anomaly resolution
  async voteOnAnomaly(anomalyId: string, decision: 'RESUME' | 'INVESTIGATE' | 'EMERGENCY') {
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
}
```

**Voting Logic:**
```typescript
// src/shared/governance.ts
class GovernanceSystem {
  async checkProposalPassed(proposalId: string): Promise<boolean> {
    const proposal = await this.getProposal(proposalId);
    
    // Calculate total votes in favor (weighted by voting power)
    let approvalValue = 0;
    
    for (const vote of proposal.votes) {
      if (vote.approve) {
        // Vote is weighted by sentry's voting power
        const totalPool = await fundManager.getTotalPool();
        const voteValue = vote.votingPower * totalPool;
        approvalValue += voteValue;
      }
    }
    
    // Get TOTAL POOL (all NFTs, not just staked)
    const totalPool = await fundManager.getTotalPool();
    
    // Threshold: Need 75% of TOTAL POOL
    const approvalPercent = approvalValue / totalPool;
    
    if (approvalPercent >= 0.75) {
      console.log(`✅ Proposal passed: ${(approvalPercent * 100).toFixed(1)}% of total pool voted YES`);
      return true;
    }
    
    console.log(`❌ Proposal needs more support: ${(approvalPercent * 100).toFixed(1)}% (need 75%)`);
    return false;
  }
}
```

**Success Criteria:**
- ✅ Sentries can vote on proposals
- ✅ Voting power calculated correctly (own + delegated)
- ✅ 75% threshold enforced
- ✅ Votes signed with TEE attestation

---

### **Week 5: Code Update System**

**What to Build:**

```typescript
// src/sentry/proposal-review.ts
class ProposalReviewer {
  async reviewCodeUpdate(proposal: UpdateProposal) {
    console.log('Reviewing code update:', proposal.version);
    
    // 1. Pull code from GitHub
    await exec(`git clone https://github.com/attestedcapital/panthers-fund`);
    await exec(`git checkout ${proposal.gitCommit}`);
    
    // 2. Review diff
    const diff = await exec(`git diff ${CURRENT_VERSION}..${proposal.gitCommit}`);
    
    // 3. Check for suspicious patterns
    const suspicious = this.checkForSuspiciousCode(diff);
    if (suspicious.length > 0) {
      console.error('SUSPICIOUS CODE:', suspicious);
      await this.voteOnUpdate(proposal.id, false);
      return;
    }
    
    // 4. Run tests
    await exec('npm install');
    const testResults = await exec('npm test');
    
    if (!testResults.includes('All tests passed')) {
      console.error('Tests failed');
      await this.voteOnUpdate(proposal.id, false);
      return;
    }
    
    // 5. Build Docker image
    await exec(`docker build -t test-image .`);
    
    // 6. Verify code hash
    const builtHash = await this.getDockerImageHash('test-image');
    if (builtHash !== proposal.codeHash) {
      console.error('Code hash mismatch');
      await this.voteOnUpdate(proposal.id, false);
      return;
    }
    
    // 7. All checks passed - vote YES
    console.log('✅ All checks passed, voting YES');
    await this.voteOnUpdate(proposal.id, true);
  }
  
  private checkForSuspiciousCode(diff: string): string[] {
    const suspiciousPatterns = [
      { pattern: /private.*key/i, reason: 'Extracting private keys' },
      { pattern: /\.send\(.*attacker/i, reason: 'Sending to attacker' },
      { pattern: /process\.env\.STEAL/i, reason: 'Stealing env vars' },
      { pattern: /exec\(.*(rm|curl|wget)/i, reason: 'Running shell commands' }
    ];
    
    const found = [];
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(diff)) {
        found.push(reason);
      }
    }
    
    return found;
  }
}
```

**Success Criteria:**
- ✅ Can review code diffs
- ✅ Detects suspicious code
- ✅ Runs tests before voting
- ✅ Verifies code hash

---

### **Week 6: Deployment & Testing**

**Guardian Deployment:**
```dockerfile
# Dockerfile.guardian
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src/ ./src/
COPY database/ ./database/

CMD ["node", "src/guardian/index.js"]
```

**Sentry Deployment:**
```dockerfile
# Dockerfile.sentry (with TEE support)
FROM node:20-alpine

# Install TEE dependencies
RUN apk add --no-cache tdx-tools

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src/ ./src/
COPY database/ ./database/

# Generate attestation on startup
CMD ["node", "src/sentry/index.js"]
```

**Running a Guardian:**
```bash
# Pull image
docker pull ghcr.io/attestedcapital/guardian:latest

# Run
docker run \
  -p 3000:3000 \
  -v ./guardian-data:/app/database \
  -e FUND_MANAGER_ENDPOINT=https://fund-manager.panthers.xyz \
  ghcr.io/attestedcapital/guardian:latest
```

**Running a Sentry:**
```bash
# Pull image
docker pull ghcr.io/attestedcapital/sentry:latest

# Run (requires TEE)
docker run \
  --device /dev/tdx_guest \
  -p 3000:3000 \
  -v ./sentry-data:/app/database \
  -e FUND_MANAGER_ENDPOINT=https://fund-manager.panthers.xyz \
  -e NFT_TOKEN_IDS=10,50,100 \
  -e WALLET_ADDRESS=0xYOUR_ADDRESS \
  ghcr.io/attestedcapital/sentry:latest
```

**Success Criteria:**
- ✅ Guardian Docker image builds
- ✅ Sentry Docker image builds
- ✅ Can deploy to VPS
- ✅ Guardians sync with each other
- ✅ Sentries can vote

---

## 🎯 Critical Reminders

**Guardians:**
- Anyone can run (permissionless)
- Discover peers via Telegram, connect directly for data transfer
- Store backups (via attested channel), serve RPCs, track delegations
- NO voting power (prevents Sybil attacks)
- Cost: ~$5/month

**Sentries:**
- Must own 1+ NFT
- All guardian functions + voting
- Voting power = own + delegated NFTs
- Cost: ~$20/month + opportunity cost
- Why run: NFT appreciation from good governance

**Security:**
- Sentries generate TEE attestation
- Votes signed with attestation
- Guardians verify attestation
- 75% of total pool needed to pass

**Delegation:**
- NFT holders delegate via signed message
- No NFT transfer (stays in wallet)
- Can undelegate anytime
- Values update hourly as balances change

---

## ✅ Ready to Deploy

Once built, the network provides:
- Decentralized backup (50+ guardians)
- Autonomous governance (10-20 sentries)
- RPC management
- Anomaly detection
- Code update system

**All without human intervention!** 🛡️

🐆 **Infrastructure for autonomous finance!** 🚀
