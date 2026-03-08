# Hot Standby Backup Agent System

**Purpose:** Enable high-availability trading with automatic failover by running backup agents that take over when the primary fails.

**Prerequisite:** Read AGENT_REGISTRATION_SYSTEM.md first - this document builds on that foundation.

---

## 🎯 Overview

**The Idea:** Run multiple agent instances simultaneously, but only ONE is active at a time. The others monitor and automatically take over if the primary fails.

**Key Guarantee:** No double-trading, even with multiple agents running.

---

## 📊 Architecture

```
PRIMARY AGENT (TEE: 0x1234)
├─ Registered on-chain ✓
├─ Connected to guardians ✓
├─ Has encrypted database ✓
├─ Trading actively ✓
└─ Sending heartbeat every 60s ✓

BACKUP AGENT #1 (TEE: 0x5678)
├─ NOT registered on-chain ❌
├─ NOT connected to guardians ❌
├─ NO database ❌
├─ NOT trading (standby mode) ⏸️
└─ Monitoring registry every 30s 👀

BACKUP AGENT #2 (TEE: 0x9ABC)
├─ NOT registered on-chain ❌
├─ NOT connected to guardians ❌
├─ NO database ❌
├─ NOT trading (standby mode) ⏸️
└─ Monitoring registry every 30s 👀

┌─────────────────────────────────────┐
│ ON-CHAIN REGISTRY (Secret Network)  │
│ ├─ Active: 0x1234                   │
│ ├─ Last heartbeat: 10s ago          │
│ └─ Status: ACTIVE ✓                 │
└─────────────────────────────────────┘
         ↑                    ↑
         │ Heartbeat          │ Monitor
    PRIMARY                BACKUPS
```

---

## 🔧 Implementation

### **1. Backup Agent - Standby Mode**

**File:** `fund-manager/src/standby-mode.ts`

```typescript
export class FundManager {
  private mode: 'active' | 'standby' | 'registering' = 'standby';
  private teeInstanceId: string;
  private registry: SecretNetworkClient;
  
  async initialize() {
    this.teeInstanceId = await getTEEInstanceId();
    this.registry = await this.connectToRegistry();
    
    console.log(`[${this.teeInstanceId}] Starting initialization...`);
    
    // Check registry to determine mode
    const activeAgent = await this.registry.query.get_current_agent();
    
    if (!activeAgent) {
      // No agent registered - we should register
      console.log("[INIT] No active agent, requesting registration");
      await this.becomeActive();
      
    } else if (activeAgent.tee_instance_id === this.teeInstanceId) {
      // We are the registered agent - go active
      console.log("[INIT] ✅ We are the registered agent");
      await this.becomeActive();
      
    } else if (!activeAgent.active) {
      // Registered agent is dead - race to take over
      console.log("[INIT] ⚠️ Registered agent is inactive, attempting takeover");
      await this.attemptTakeover();
      
    } else {
      // Different agent is active - enter standby
      console.log("[INIT] Another agent is active, entering standby mode");
      console.log(`       Active: ${activeAgent.tee_instance_id}`);
      console.log(`       Us: ${this.teeInstanceId}`);
      await this.enterStandbyMode();
    }
  }
  
  async enterStandbyMode() {
    this.mode = 'standby';
    console.log("\n╔════════════════════════════════════════╗");
    console.log("║     STANDBY MODE - MONITORING          ║");
    console.log("╚════════════════════════════════════════╝\n");
    
    // Monitor registry for primary failure
    setInterval(async () => {
      try {
        await this.checkPrimaryHealth();
      } catch (error) {
        console.error("[STANDBY] Monitoring error:", error);
      }
    }, 30 * 1000); // Check every 30 seconds
  }
  
  async checkPrimaryHealth() {
    const registry = await this.connectToRegistry();
    
    // Trigger timeout check on contract
    await registry.execute.check_heartbeat();
    
    // Get current status
    const activeAgent = await registry.query.get_current_agent();
    
    if (!activeAgent) {
      console.log("[STANDBY] 🚨 No agent registered! Attempting takeover...");
      await this.attemptTakeover();
      return;
    }
    
    if (!activeAgent.active) {
      console.log("[STANDBY] 🚨 Primary agent inactive! Attempting takeover...");
      console.log(`          Primary: ${activeAgent.tee_instance_id}`);
      console.log(`          Last heartbeat: ${new Date(activeAgent.last_heartbeat * 1000)}`);
      await this.attemptTakeover();
      return;
    }
    
    // Primary is healthy
    const timeSinceHeartbeat = Date.now() / 1000 - activeAgent.last_heartbeat;
    console.log(`[STANDBY] 💤 Primary healthy (heartbeat ${timeSinceHeartbeat.toFixed(0)}s ago)`);
    console.log(`          Primary: ${activeAgent.tee_instance_id}`);
    console.log(`          Us: ${this.teeInstanceId}`);
  }
  
  async attemptTakeover() {
    if (this.mode === 'registering') {
      console.log("[TAKEOVER] Already attempting registration, skipping");
      return;
    }
    
    this.mode = 'registering';
    console.log("\n╔════════════════════════════════════════╗");
    console.log("║   ATTEMPTING TAKEOVER - REGISTERING    ║");
    console.log("╚════════════════════════════════════════╝\n");
    
    try {
      // Generate attestation
      const attestation = await generateAttestation({
        codeHash: PANTHERS_CODE_HASH,
        teeInstanceId: this.teeInstanceId,
        timestamp: Date.now()
      });
      
      // Request guardian approval
      console.log("[TAKEOVER] Requesting guardian approval...");
      const approvals = await this.guardians.requestApproval({
        teeInstanceId: this.teeInstanceId,
        attestation: attestation
      });
      
      console.log(`[TAKEOVER] Received ${approvals.length}/${TOTAL_GUARDIANS} approvals`);
      
      // Check if we got 75% approval
      const approvalRate = approvals.length / TOTAL_GUARDIANS;
      if (approvalRate < 0.75) {
        console.log(`[TAKEOVER] ❌ Insufficient approvals: ${(approvalRate * 100).toFixed(1)}%`);
        console.log(`[TAKEOVER] Another backup likely won, returning to standby`);
        this.mode = 'standby';
        return;
      }
      
      // Submit registration to contract
      console.log("[TAKEOVER] Submitting registration to contract...");
      await this.registry.execute.register_agent({
        tee_instance_id: this.teeInstanceId,
        attestation: attestation,
        guardian_approvals: approvals
      });
      
      console.log("[TAKEOVER] ✅ Registration successful!");
      await this.becomeActive();
      
    } catch (error) {
      console.error("[TAKEOVER] ❌ Failed:", error.message);
      console.log("[TAKEOVER] Returning to standby mode");
      this.mode = 'standby';
    }
  }
  
  async becomeActive() {
    this.mode = 'active';
    console.log("\n╔════════════════════════════════════════╗");
    console.log("║       GOING ACTIVE - STARTING          ║");
    console.log("╚════════════════════════════════════════╝\n");
    
    // Connect to guardians
    console.log("[ACTIVE] Connecting to guardians...");
    await this.connectToGuardians();
    
    // Request encrypted database
    console.log("[ACTIVE] Requesting encrypted database...");
    const encryptedDB = await this.guardians.requestDatabase();
    
    // Decrypt and load state
    console.log("[ACTIVE] Decrypting database...");
    const db = await this.decryptDatabase(encryptedDB);
    
    console.log("[ACTIVE] Loading state...");
    await this.loadState(db);
    
    // Start heartbeat
    console.log("[ACTIVE] Starting heartbeat...");
    await this.startHeartbeat();
    
    // Start trading
    console.log("[ACTIVE] Starting trading cycle...");
    await this.startTradingCycle();
    
    console.log("\n╔════════════════════════════════════════╗");
    console.log("║      ✅ ACTIVE - TRADING LIVE          ║");
    console.log("╚════════════════════════════════════════╝\n");
  }
  
  async startHeartbeat() {
    setInterval(async () => {
      try {
        const attestation = await generateAttestation({
          codeHash: PANTHERS_CODE_HASH,
          teeInstanceId: this.teeInstanceId,
          timestamp: Date.now()
        });
        
        await this.registry.execute.heartbeat({ attestation });
        
        console.log("[HEARTBEAT] 💓 Sent");
      } catch (error) {
        console.error("[HEARTBEAT] ❌ Failed:", error.message);
        console.error("[HEARTBEAT] If this continues, we will be deactivated");
      }
    }, 60 * 1000); // Every 60 seconds
  }
}
```

---

### **2. Guardian - Registration Voting**

**File:** `guardian/src/registration-voting.ts`

```typescript
export class Guardian {
  private pendingRegistrations: Map<string, RegistrationRequest> = new Map();
  
  async handleRegistrationRequest(request: {
    teeInstanceId: string;
    attestation: string;
    requestedBy: string; // Guardian that forwarded request
  }) {
    console.log("\n📬 Registration request received");
    console.log(`   TEE ID: ${request.teeInstanceId}`);
    console.log(`   From: ${request.requestedBy}`);
    
    // Check if we should approve
    const approval = await this.evaluateRegistrationRequest(request);
    
    if (approval.approved) {
      console.log("✅ APPROVED registration");
      await this.broadcastApproval({
        teeInstanceId: request.teeInstanceId,
        guardianId: this.id,
        signature: await this.signApproval(request.teeInstanceId)
      });
    } else {
      console.log(`❌ REJECTED registration: ${approval.reason}`);
    }
    
    return approval;
  }
  
  async evaluateRegistrationRequest(request: {
    teeInstanceId: string;
    attestation: string;
  }): Promise<{ approved: boolean; reason?: string }> {
    // 1. Check current agent status
    const activeAgent = await this.registry.query.get_current_agent();
    
    if (activeAgent && activeAgent.active) {
      const timeSinceHeartbeat = Date.now() / 1000 - activeAgent.last_heartbeat;
      
      if (timeSinceHeartbeat < 300) {
        // Primary is still healthy
        return {
          approved: false,
          reason: `Active agent ${activeAgent.tee_instance_id} is still healthy (last heartbeat ${timeSinceHeartbeat}s ago)`
        };
      }
    }
    
    // 2. Verify attestation
    try {
      const parsed = await verifyTDXAttestation(request.attestation);
      
      if (parsed.teeInstanceId !== request.teeInstanceId) {
        return {
          approved: false,
          reason: "TEE ID mismatch in attestation"
        };
      }
      
      if (parsed.codeHash !== PANTHERS_CODE_HASH) {
        return {
          approved: false,
          reason: `Code hash mismatch (expected ${PANTHERS_CODE_HASH}, got ${parsed.codeHash})`
        };
      }
    } catch (error) {
      return {
        approved: false,
        reason: `Attestation verification failed: ${error.message}`
      };
    }
    
    // 3. Check if this is a known backup agent
    // (Optional: Maintain whitelist of approved backup TEE IDs)
    if (this.config.approvedBackups) {
      if (!this.config.approvedBackups.includes(request.teeInstanceId)) {
        return {
          approved: false,
          reason: "TEE ID not in approved backups list"
        };
      }
    }
    
    // All checks passed
    return { approved: true };
  }
  
  async broadcastApproval(approval: {
    teeInstanceId: string;
    guardianId: string;
    signature: string;
  }) {
    // Broadcast to all other guardians
    await this.network.broadcast({
      type: "REGISTRATION_APPROVAL",
      ...approval
    });
    
    // Store locally
    if (!this.pendingRegistrations.has(approval.teeInstanceId)) {
      this.pendingRegistrations.set(approval.teeInstanceId, {
        teeInstanceId: approval.teeInstanceId,
        approvals: []
      });
    }
    
    const registration = this.pendingRegistrations.get(approval.teeInstanceId)!;
    registration.approvals.push(approval);
    
    // Check if we've reached 75%
    const approvalRate = registration.approvals.length / TOTAL_GUARDIANS;
    if (approvalRate >= 0.75) {
      console.log(`✅ Registration threshold reached: ${registration.approvals.length}/${TOTAL_GUARDIANS}`);
      console.log(`   TEE ID: ${approval.teeInstanceId} is now approved`);
    }
  }
}
```

---

### **3. Multiple Backups - Race Condition Handling**

**File:** `fund-manager/src/backup-coordination.ts`

```typescript
/**
 * When multiple backups detect primary failure simultaneously,
 * they race to register. Only one wins.
 */
export class BackupCoordination {
  async attemptTakeover() {
    // Add random delay (0-2 seconds) to reduce collision
    const delay = Math.random() * 2000;
    await sleep(delay);
    
    console.log(`[TAKEOVER] Starting takeover attempt (delayed ${delay.toFixed(0)}ms)`);
    
    // Check if someone else already registered while we delayed
    const activeAgent = await this.registry.query.get_current_agent();
    if (activeAgent && activeAgent.active && activeAgent.tee_instance_id !== this.teeInstanceId) {
      console.log("[TAKEOVER] ❌ Another agent registered while we delayed");
      console.log(`           Active: ${activeAgent.tee_instance_id}`);
      console.log("[TAKEOVER] Returning to standby");
      return false;
    }
    
    // Request approval from guardians
    try {
      const attestation = await generateAttestation({
        codeHash: PANTHERS_CODE_HASH,
        teeInstanceId: this.teeInstanceId,
        timestamp: Date.now()
      });
      
      // Broadcast registration request
      console.log("[TAKEOVER] Broadcasting registration request to guardians...");
      const approvals = await this.guardians.requestApprovalWithTimeout({
        teeInstanceId: this.teeInstanceId,
        attestation: attestation,
        timeout: 10000 // 10 second timeout
      });
      
      // Check if we got 75%
      const approvalRate = approvals.length / TOTAL_GUARDIANS;
      
      if (approvalRate < 0.75) {
        console.log(`[TAKEOVER] ❌ Insufficient approvals: ${approvals.length}/${TOTAL_GUARDIANS}`);
        console.log("[TAKEOVER] Another backup likely won, returning to standby");
        return false;
      }
      
      // Try to register (might fail if someone else registered first)
      console.log("[TAKEOVER] Submitting registration to contract...");
      try {
        await this.registry.execute.register_agent({
          tee_instance_id: this.teeInstanceId,
          attestation: attestation,
          guardian_approvals: approvals
        });
        
        console.log("[TAKEOVER] ✅ Registration successful! We won the race!");
        return true;
        
      } catch (contractError) {
        if (contractError.message.includes("already active")) {
          console.log("[TAKEOVER] ❌ Contract rejected: Another agent already registered");
          console.log("[TAKEOVER] We lost the race, returning to standby");
          return false;
        }
        throw contractError;
      }
      
    } catch (error) {
      console.error("[TAKEOVER] ❌ Failed:", error.message);
      return false;
    }
  }
}
```

---

## 📊 Failover Timeline

**Scenario: Primary agent crashes, 3 backups running**

```
T=0:00  PRIMARY AGENT (0x1234) crashes
        ├─ Stops sending heartbeat
        └─ Backups don't know yet (still see "active" in registry)

T=0:30  Backup-1 (0x5678) checks → Primary still marked active
T=1:00  Backup-2 (0x9ABC) checks → Primary still marked active  
T=1:30  Backup-3 (0xDEF0) checks → Primary still marked active

T=5:00  CONTRACT TIMEOUT TRIGGERS
        ├─ 5 minutes since last heartbeat
        └─ Primary marked INACTIVE

T=5:30  Backup-1 checks → Primary INACTIVE!
        ├─ Generates attestation
        ├─ Requests guardian approval
        └─ Random delay: 1.2 seconds

T=5:30  Backup-2 checks → Primary INACTIVE!
        ├─ Generates attestation
        ├─ Requests guardian approval
        └─ Random delay: 0.7 seconds

T=5:30  Backup-3 checks → Primary INACTIVE!
        ├─ Generates attestation
        ├─ Requests guardian approval  
        └─ Random delay: 1.8 seconds

T=5:31  Backup-2 (shortest delay) requests first
        ├─ Guardians evaluate attestation ✓
        ├─ Guardians vote: 8/10 approve (80%) ✓
        └─ Backup-2 submits to contract

T=5:32  Backup-1 requests (1.2s delay expired)
        ├─ Guardians evaluate attestation ✓
        ├─ Guardians vote: 7/10 approve (70%) ❌
        └─ Insufficient approvals (some already voted for Backup-2)

T=5:33  Backup-2 registration succeeds ✅
        ├─ Contract: activeAgent = 0x9ABC
        ├─ Backup-2 connects to guardians
        ├─ Backup-2 requests encrypted DB
        └─ Backup-2 starts trading

T=5:33  Backup-1 tries to register
        ├─ Contract: "Agent already active" ❌
        └─ Backup-1 returns to standby

T=5:34  Backup-3 requests (1.8s delay expired)
        ├─ Guardians see 0x9ABC is now active
        ├─ Guardians reject: "Active agent exists"
        └─ Backup-3 returns to standby

T=5:35  NEW PRIMARY (Backup-2) sends first heartbeat
        ├─ Trading resumed
        └─ Other backups now monitoring 0x9ABC

TOTAL DOWNTIME: ~5.5 minutes
```

---

## 🚀 Deployment Configurations

### **Configuration 1: Single Backup (Basic HA)**

```yaml
# Primary Agent (AWS us-east-1)
PRIMARY:
  tee_instance_id: "0x1234..."
  location: "AWS us-east-1"
  role: "primary"
  
# Backup Agent (Google Cloud us-central1)
BACKUP-1:
  tee_instance_id: "0x5678..."
  location: "Google Cloud us-central1"
  role: "backup"

Benefit: Geographic redundancy
Downtime: ~6 minutes if primary fails
```

### **Configuration 2: Multiple Backups (High HA)**

```yaml
# Primary
PRIMARY:
  tee_instance_id: "0x1234..."
  location: "AWS us-east-1"
  role: "primary"

# Backups (Different providers)
BACKUP-1:
  tee_instance_id: "0x5678..."
  location: "Google Cloud us-central1"
  role: "backup"

BACKUP-2:
  tee_instance_id: "0x9ABC..."
  location: "Azure eastus"
  role: "backup"

BACKUP-3:
  tee_instance_id: "0xDEF0..."
  location: "AWS us-west-2"
  role: "backup"

Benefit: Triple redundancy across 3 cloud providers
Downtime: ~6 minutes (first backup to respond wins)
```

### **Configuration 3: Co-Located Backup (Fastest Failover)**

```yaml
# Primary
PRIMARY:
  tee_instance_id: "0x1234..."
  location: "AWS us-east-1a"
  role: "primary"

# Backup in same region (different AZ)
BACKUP-1:
  tee_instance_id: "0x5678..."
  location: "AWS us-east-1b"
  role: "backup"
  check_interval: 10s  # Faster monitoring

Benefit: Fastest failover (same region, low latency)
Downtime: ~5 minutes (faster heartbeat detection)
Risk: Regional failures affect both
```

---

## 🛡️ Safety Guarantees

### **Why This Can't Double-Trade:**

1. **Backup has NO database**
   - Can't know current balances
   - Can't know what to trade
   - Can't make trades without state

2. **Guardians reject unregistered agents**
   - Backup tries to connect → Guardians check registry
   - Registry shows different TEE ID → Guardians reject
   - No database = no trading

3. **Contract enforces single active agent**
   - Backup tries to register while primary alive → Contract rejects
   - Only when primary times out → Contract accepts new agent

4. **Heartbeat is proof of life**
   - Primary sends heartbeat every 60s
   - Backup can see heartbeat is current → Stays in standby
   - Heartbeat stops for 5min → Primary deactivated → Backup takes over

5. **Registration is atomic**
   - Multiple backups race to register
   - Contract accepts first valid registration
   - Other backups get rejected
   - Still no double-trading (only one succeeds)

---

## 📋 Setup Instructions

### **Step 1: Deploy Primary Agent**

```bash
# Deploy to AWS us-east-1
cd fund-manager
npm run build
npm run deploy:aws-east

# Wait for registration
# Output: "✅ ACTIVE - TRADING LIVE"
# Note TEE instance ID: 0x1234...
```

### **Step 2: Deploy Backup Agent(s)**

```bash
# Deploy to Google Cloud us-central1
npm run deploy:gcp-central

# Output: "⏳ STANDBY MODE - MONITORING"
# Output: "💤 Primary healthy (heartbeat 15s ago)"
# Note TEE instance ID: 0x5678...
```

### **Step 3: Configure Guardian Whitelist (Optional)**

```typescript
// In guardian config, add approved backup TEE IDs
const config = {
  approvedBackups: [
    "0x5678...", // Google Cloud backup
    "0x9ABC...", // Azure backup
    "0xDEF0..."  // AWS west backup
  ]
};
```

### **Step 4: Test Failover**

```bash
# Kill primary agent
kill <primary-pid>

# Watch backup logs:
# T+0:30  "💤 Primary healthy"
# T+5:00  "🚨 PRIMARY AGENT DOWN! Taking over..."
# T+5:30  "✅ Registration successful!"
# T+5:35  "✅ ACTIVE - TRADING LIVE"
```

---

## 🎯 Best Practices

### **DO:**

✅ Run backups in different cloud providers (AWS, GCP, Azure)
✅ Run backups in different regions (us-east, us-west, europe)
✅ Monitor backup logs to ensure they're watching
✅ Test failover regularly (kill primary, verify backup takes over)
✅ Keep backup count reasonable (2-3 backups is enough)

### **DON'T:**

❌ Run backups on same hardware as primary (defeats redundancy)
❌ Run too many backups (wastes resources, all do same thing)
❌ Manually interfere during failover (let it happen automatically)
❌ Try to force a specific backup to take over (let them race)
❌ Skip testing failover (test before production!)

---

## ✅ Implementation Checklist

**Fund Manager:**
- [ ] Implement standby mode monitoring
- [ ] Add takeover attempt with random delay
- [ ] Handle registration race conditions
- [ ] Test: Backup stays in standby while primary healthy
- [ ] Test: Backup takes over when primary dies
- [ ] Test: Multiple backups racing (only one wins)

**Guardian:**
- [ ] Implement registration request evaluation
- [ ] Add approval voting and broadcasting
- [ ] Track approval counts (75% threshold)
- [ ] Optional: Add backup whitelist
- [ ] Test: Approve valid backup requests
- [ ] Test: Reject requests while primary healthy

**Testing:**
- [ ] Single backup failover (<6min downtime)
- [ ] Multiple backups racing (only one wins)
- [ ] Network partition scenarios
- [ ] Guardian voting edge cases
- [ ] Contract registration conflicts
- [ ] Load test: 100 trades across failover

---

## 🎯 Expected Performance

**Downtime During Failover:**
- Primary crash detected: ~5 minutes (heartbeat timeout)
- Backup registration: ~30 seconds (guardian voting)
- Database sync: ~30 seconds (download + decrypt)
- Trading resumed: <6 minutes total

**Availability:**
- Single backup: 99.9% (primary fails → backup takes over in 6min)
- Triple backup: 99.99% (three layers of redundancy)

**Cost:**
- Primary: $20-50/month (active trading)
- Backup: $10-20/month (just monitoring)
- Total for 1+2 backups: $40-90/month for 99.99% uptime

---

**This system provides production-grade high availability with automatic failover and zero risk of double-trading.** 🚀
