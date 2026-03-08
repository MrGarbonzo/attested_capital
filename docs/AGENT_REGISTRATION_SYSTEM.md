# Agent Registration & Anti-Double-Trading System

**Purpose:** Prevent multiple instances of the trading agent from running simultaneously and causing double-trades or balance inconsistencies.

---

## 🚨 The Problem

**Attack Scenario:**
```
1. Attacker clones Panthers repository (same code)
2. Deploys to their own TEE
3. Code hash matches original (same code) ✓
4. Requests encrypted database from guardians
5. Guardians verify code hash matches ✓
6. Guardian sends encrypted database
7. Attacker's TEE decrypts it (same code = same decryption) ✓
8. Now TWO agents with SAME mnemonic running simultaneously

Result:
- Both agents can make trades
- Both agents control same wallets
- Balances get out of sync
- Double-trading causes chaos
- Guardians can't tell which is legitimate
```

**Core Issue:** Guardians can't distinguish between identical TEE instances running the same code with the same mnemonic.

---

## ✅ The Solution: On-Chain Agent Registry + TEE Instance ID

### **Architecture Overview:**

```
┌─────────────────────────────────────────────────┐
│ SECRET NETWORK SMART CONTRACT                   │
│ ├─ Stores: Active agent's TEE instance ID      │
│ ├─ Stores: Last heartbeat timestamp            │
│ ├─ Requires: 75% guardian vote to change       │
│ └─ Auto-deactivates: If no heartbeat for 5min  │
└─────────────────────────────────────────────────┘
                    ↕
┌─────────────────────────────────────────────────┐
│ TRADING AGENT (TEE: 0x1234)                     │
│ ├─ Unique hardware TEE instance ID              │
│ ├─ Sends heartbeat every 60 seconds            │
│ ├─ Only registered agent can trade             │
│ └─ Guardians only accept registered agent      │
└─────────────────────────────────────────────────┘
```

---

## 📋 Implementation Details

### **1. Secret Network Smart Contract**

**File:** `contracts/PanthersRegistry.secret`

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ActiveAgent {
    pub tee_instance_id: String,      // Unique TEE hardware ID (e.g., "0x1234abcd...")
    pub activated_at: u64,             // Timestamp when registered
    pub last_heartbeat: u64,           // Last heartbeat timestamp
    pub active: bool,                  // Is this agent currently active?
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PanthersRegistry {
    pub current_agent: Option<ActiveAgent>,
    pub code_hash: String,             // Approved code hash (for verification)
    pub guardian_votes: HashMap<String, bool>, // Track guardian votes
}

impl PanthersRegistry {
    /// Register a new agent (requires 75% guardian consensus)
    pub fn register_agent(
        &mut self,
        tee_instance_id: String,
        attestation: String,
        guardian_approvals: Vec<String>
    ) -> Result<()> {
        // Verify no agent is currently active
        if let Some(agent) = &self.current_agent {
            if agent.active {
                return Err("Agent already active".into());
            }
        }
        
        // Verify 75% guardian approval
        let approval_rate = guardian_approvals.len() as f64 / TOTAL_GUARDIANS as f64;
        if approval_rate < 0.75 {
            return Err("Need 75% guardian approval".into());
        }
        
        // Verify attestation
        self.verify_attestation(&attestation, &tee_instance_id, &self.code_hash)?;
        
        // Register new agent
        self.current_agent = Some(ActiveAgent {
            tee_instance_id,
            activated_at: current_timestamp(),
            last_heartbeat: current_timestamp(),
            active: true,
        });
        
        Ok(())
    }
    
    /// Agent sends heartbeat to prove liveness
    pub fn heartbeat(&mut self, attestation: String) -> Result<()> {
        let agent = self.current_agent.as_ref()
            .ok_or("No agent registered")?;
        
        // Verify attestation matches registered agent
        self.verify_attestation(&attestation, &agent.tee_instance_id, &self.code_hash)?;
        
        // Update heartbeat timestamp
        if let Some(agent) = &mut self.current_agent {
            agent.last_heartbeat = current_timestamp();
        }
        
        Ok(())
    }
    
    /// Check if agent has missed heartbeat (call from anyone)
    pub fn check_heartbeat(&mut self) {
        if let Some(agent) = &mut self.current_agent {
            let time_since_heartbeat = current_timestamp() - agent.last_heartbeat;
            
            // Deactivate if no heartbeat for 5 minutes (300 seconds)
            if time_since_heartbeat > 300 && agent.active {
                agent.active = false;
                // Emit event for guardians to detect
                emit_event("AgentDeactivated", json!({
                    "tee_instance_id": agent.tee_instance_id,
                    "last_heartbeat": agent.last_heartbeat,
                    "reason": "Heartbeat timeout"
                }));
            }
        }
    }
    
    /// Query current agent status (public read)
    pub fn get_current_agent(&self) -> Option<ActiveAgent> {
        self.current_agent.clone()
    }
    
    /// Verify TEE attestation
    fn verify_attestation(
        &self,
        attestation: &str,
        expected_tee_id: &str,
        expected_code_hash: &str
    ) -> Result<()> {
        // Parse attestation (Intel TDX format)
        let parsed = parse_tdx_attestation(attestation)?;
        
        // Verify code hash matches approved code
        if parsed.code_hash != expected_code_hash {
            return Err("Code hash mismatch".into());
        }
        
        // Verify TEE instance ID matches
        if parsed.tee_instance_id != expected_tee_id {
            return Err("TEE instance ID mismatch".into());
        }
        
        // Verify attestation signature is valid (Intel signed)
        verify_intel_signature(&parsed)?;
        
        Ok(())
    }
}
```

---

### **2. Fund Manager - Registration Logic**

**File:** `fund-manager/src/initialization.ts`

```typescript
import { getTEEInstanceId, generateAttestation } from './tee';
import { SecretNetworkClient } from 'secretjs';

export class FundManager {
  private teeInstanceId: string;
  private registry: SecretNetworkClient;
  
  async initialize() {
    // Get THIS TEE's unique hardware instance ID
    this.teeInstanceId = await getTEEInstanceId();
    console.log(`TEE Instance ID: ${this.teeInstanceId}`);
    
    // Connect to Secret Network registry contract
    this.registry = await this.connectToRegistry();
    
    // Check current agent status
    const activeAgent = await this.registry.query.get_current_agent();
    
    if (!activeAgent) {
      // No agent registered - first deployment
      console.log("No agent registered. Requesting initial registration...");
      await this.requestRegistration();
      
    } else if (activeAgent.tee_instance_id === this.teeInstanceId) {
      // We are the registered agent
      console.log("✅ We are the registered active agent");
      await this.goLive();
      
    } else if (!activeAgent.active) {
      // Registered agent is dead - request to take over
      console.log("⚠️  Registered agent is inactive. Requesting takeover...");
      await this.requestRegistration();
      
    } else {
      // Different agent is active and healthy
      console.log("❌ Another agent is active:");
      console.log(`   Active: ${activeAgent.tee_instance_id}`);
      console.log(`   Us: ${this.teeInstanceId}`);
      console.log(`   Last heartbeat: ${activeAgent.last_heartbeat}`);
      console.log("\nShutting down to prevent conflicts.");
      process.exit(1);
    }
  }
  
  async requestRegistration() {
    // Generate attestation proving we're running approved code in this TEE
    const attestation = await generateAttestation({
      codeHash: PANTHERS_CODE_HASH,
      teeInstanceId: this.teeInstanceId,
      timestamp: Date.now()
    });
    
    // Request guardian approval (broadcast to all guardians)
    console.log("Requesting guardian approval for registration...");
    const approvals = await this.guardians.requestApproval({
      teeInstanceId: this.teeInstanceId,
      attestation: attestation
    });
    
    // Wait for 75% approval
    const approvalRate = approvals.length / TOTAL_GUARDIANS;
    if (approvalRate < 0.75) {
      throw new Error(`Insufficient approvals: ${approvalRate * 100}% (need 75%)`);
    }
    
    // Submit to registry contract
    await this.registry.execute.register_agent({
      tee_instance_id: this.teeInstanceId,
      attestation: attestation,
      guardian_approvals: approvals
    });
    
    console.log("✅ Registration successful!");
    await this.goLive();
  }
  
  async goLive() {
    console.log("🚀 Going live...");
    
    // Connect to all guardians
    await this.connectToGuardians();
    
    // Request encrypted database
    const encryptedDB = await this.guardians.requestDatabase();
    
    // Decrypt and load state
    const db = await this.decryptDatabase(encryptedDB);
    await this.loadState(db);
    
    // Start heartbeat (every 60 seconds)
    await this.startHeartbeat();
    
    // Start trading cycle (every 4 hours)
    await this.startTradingCycle();
    
    console.log("✅ Live and trading");
  }
  
  async startHeartbeat() {
    setInterval(async () => {
      try {
        const attestation = await generateAttestation({
          codeHash: PANTHERS_CODE_HASH,
          teeInstanceId: this.teeInstanceId,
          timestamp: Date.now()
        });
        
        await this.registry.execute.heartbeat({
          attestation: attestation
        });
        
        console.log("💓 Heartbeat sent");
      } catch (error) {
        console.error("❌ Heartbeat failed:", error);
        // If heartbeat fails repeatedly, we'll be deactivated
      }
    }, 60 * 1000); // Every 60 seconds
  }
}
```

---

### **3. Guardian - Agent Verification**

**File:** `guardian/src/agent-verification.ts`

```typescript
import { SecretNetworkClient } from 'secretjs';
import { verifyTDXAttestation } from './attestation';

export class Guardian {
  private registry: SecretNetworkClient;
  private connectedAgent: FundManagerConnection | null = null;
  
  async handleAgentConnection(agent: FundManagerConnection) {
    console.log("New agent attempting connection...");
    
    // 1. Get agent's attestation
    const attestation = await agent.getAttestation();
    const parsed = await verifyTDXAttestation(attestation);
    
    console.log(`Agent TEE ID: ${parsed.teeInstanceId}`);
    console.log(`Code hash: ${parsed.codeHash}`);
    
    // 2. Query on-chain registry for active agent
    const activeAgent = await this.registry.query.get_current_agent();
    
    if (!activeAgent) {
      console.log("❌ REJECTED: No agent registered in contract");
      throw new Error("No registered agent");
    }
    
    // 3. Verify this agent matches registered agent
    if (activeAgent.tee_instance_id !== parsed.teeInstanceId) {
      console.log("❌ REJECTED: TEE instance ID mismatch");
      console.log(`   Registered: ${activeAgent.tee_instance_id}`);
      console.log(`   Attempting: ${parsed.teeInstanceId}`);
      throw new Error("Unauthorized agent - TEE ID mismatch");
    }
    
    // 4. Verify registered agent is still active
    if (!activeAgent.active) {
      console.log("❌ REJECTED: Registered agent is marked inactive");
      console.log(`   Last heartbeat: ${activeAgent.last_heartbeat}`);
      throw new Error("Agent inactive - awaiting new registration");
    }
    
    // 5. Verify heartbeat is recent (within 2 minutes)
    const timeSinceHeartbeat = Date.now() / 1000 - activeAgent.last_heartbeat;
    if (timeSinceHeartbeat > 120) {
      console.log("⚠️  WARNING: Heartbeat is stale");
      console.log(`   Time since last heartbeat: ${timeSinceHeartbeat}s`);
      // Don't reject yet, but monitor closely
    }
    
    // 6. Verify code hash matches approved code
    if (parsed.codeHash !== PANTHERS_CODE_HASH) {
      console.log("❌ REJECTED: Code hash mismatch");
      console.log(`   Expected: ${PANTHERS_CODE_HASH}`);
      console.log(`   Got: ${parsed.codeHash}`);
      throw new Error("Unauthorized code");
    }
    
    // 7. Accept connection
    console.log("✅ ACCEPTED: Agent verified");
    this.connectedAgent = agent;
    
    // Start monitoring agent health
    this.monitorAgentHealth();
  }
  
  async monitorAgentHealth() {
    // Check heartbeat every 30 seconds
    setInterval(async () => {
      const activeAgent = await this.registry.query.get_current_agent();
      
      if (!activeAgent || !activeAgent.active) {
        console.log("🚨 Agent is no longer active!");
        console.log("   Disconnecting and awaiting new agent...");
        this.connectedAgent = null;
        return;
      }
      
      const timeSinceHeartbeat = Date.now() / 1000 - activeAgent.last_heartbeat;
      
      if (timeSinceHeartbeat > 300) {
        // No heartbeat for 5 minutes - trigger deactivation
        console.log("🚨 Agent heartbeat timeout (5min)");
        console.log("   Calling contract to deactivate...");
        
        await this.registry.execute.check_heartbeat();
        
        // Broadcast to other guardians
        await this.broadcastToGuardians({
          type: "AGENT_DEAD",
          teeInstanceId: activeAgent.tee_instance_id,
          lastHeartbeat: activeAgent.last_heartbeat
        });
        
        this.connectedAgent = null;
      }
    }, 30 * 1000); // Check every 30 seconds
  }
  
  async handleRegistrationRequest(request: {
    teeInstanceId: string;
    attestation: string;
  }) {
    console.log("📬 Registration request received");
    console.log(`   TEE ID: ${request.teeInstanceId}`);
    
    // Verify current agent is truly dead
    const activeAgent = await this.registry.query.get_current_agent();
    
    if (activeAgent && activeAgent.active) {
      console.log("❌ REJECTED: Current agent is still active");
      return { approved: false, reason: "Active agent exists" };
    }
    
    // Verify attestation
    try {
      const parsed = await verifyTDXAttestation(request.attestation);
      
      if (parsed.teeInstanceId !== request.teeInstanceId) {
        throw new Error("TEE ID mismatch in attestation");
      }
      
      if (parsed.codeHash !== PANTHERS_CODE_HASH) {
        throw new Error("Code hash doesn't match approved code");
      }
      
      console.log("✅ APPROVED: Attestation valid");
      return { approved: true };
      
    } catch (error) {
      console.log("❌ REJECTED: Attestation verification failed");
      console.log(`   Error: ${error.message}`);
      return { approved: false, reason: error.message };
    }
  }
}
```

---

### **4. TEE Instance ID Extraction**

**File:** `shared/src/tee.ts`

```typescript
/**
 * Get unique TEE instance ID (hardware-bound identifier)
 * This ID is embedded in the TEE hardware and cannot be copied
 */
export async function getTEEInstanceId(): Promise<string> {
  // For Intel TDX:
  // The instance ID is derived from the TDX measurement registers (MRTD/RTMR)
  // which include hardware-specific values
  
  const tdxReport = await getTDXReport();
  
  // Extract unique instance identifier from report
  // This combines:
  // - Hardware-specific measurements
  // - Platform configuration
  // - Boot-time entropy
  const instanceId = tdxReport.mrConfigId + tdxReport.mrOwner;
  
  return `0x${instanceId}`;
}

/**
 * Generate TEE attestation proving:
 * 1. We're running specific code (code hash)
 * 2. We're running in specific TEE instance (instance ID)
 * 3. Attestation is signed by Intel hardware
 */
export async function generateAttestation(params: {
  codeHash: string;
  teeInstanceId: string;
  timestamp: number;
}): Promise<string> {
  // Generate TDX quote
  const quote = await generateTDXQuote({
    reportData: Buffer.from(JSON.stringify({
      codeHash: params.codeHash,
      teeInstanceId: params.teeInstanceId,
      timestamp: params.timestamp
    }))
  });
  
  // Quote includes:
  // - Code measurements (MRTD)
  // - Instance-specific data (RTMR)
  // - Intel signature (proves genuine TEE)
  
  return quote.toString('base64');
}

/**
 * Verify TEE attestation
 */
export async function verifyTDXAttestation(attestation: string): Promise<{
  codeHash: string;
  teeInstanceId: string;
  timestamp: number;
}> {
  const quote = Buffer.from(attestation, 'base64');
  
  // Verify Intel signature (proves genuine TDX)
  await verifyIntelSignature(quote);
  
  // Extract report data
  const reportData = extractReportData(quote);
  const data = JSON.parse(reportData.toString());
  
  return {
    codeHash: data.codeHash,
    teeInstanceId: data.teeInstanceId,
    timestamp: data.timestamp
  };
}
```

---

## 🔒 Security Guarantees

### **What This Prevents:**

1. **Duplicate Agents**
   - Only ONE agent can be registered at a time
   - Guardians reject unregistered agents
   - No way to connect without registration

2. **Rogue Agents**
   - Code hash must match approved code
   - TEE instance ID must match registry
   - Attestation must be Intel-signed

3. **Double Trading**
   - Unregistered agents can't get database
   - Unregistered agents can't connect to guardians
   - Only registered agent can make trades

4. **Zombie Agents**
   - 5-minute heartbeat timeout
   - Auto-deactivation if heartbeat stops
   - Guardians detect and handle failover

### **Attack Scenarios & Defenses:**

**Attack:** "I'll clone the code and deploy to my TEE"
**Defense:** ✅ Your TEE has different instance ID, guardians reject you

**Attack:** "I'll fake the TEE instance ID in my attestation"
**Defense:** ✅ Intel signature verification fails (can't fake hardware)

**Attack:** "I'll register my agent before the real one starts"
**Defense:** ✅ Initial registration requires guardian approval (they know which TEE to approve)

**Attack:** "I'll keep primary agent alive while starting backup"
**Defense:** ✅ Registry only allows ONE active agent, backup can't register while primary is active

**Attack:** "I'll modify the heartbeat to never timeout"
**Defense:** ✅ Timeout is enforced by smart contract, not agent code

---

## 📊 Complete Flow Diagram

```
INITIAL DEPLOYMENT:
──────────────────────────────────────────────
1. Deploy agent to TEE (instance: 0x1234)
2. Agent generates attestation
3. Agent requests guardian approval
4. Guardians verify attestation
5. 75% guardians approve
6. Contract registers: activeAgent = 0x1234
7. Agent starts heartbeat (every 60s)
8. Agent starts trading

NORMAL OPERATION:
──────────────────────────────────────────────
Every 60s:
  Agent → Contract: heartbeat()
  Contract: Updates last_heartbeat timestamp

Every 4h:
  Agent: Execute trade
  Guardians: Verify trade came from 0x1234

ROGUE AGENT ATTEMPT:
──────────────────────────────────────────────
1. Attacker deploys clone (instance: 0xABCD)
2. Attacker contacts guardians
3. Guardian checks registry → active = 0x1234
4. Guardian: "Your ID is 0xABCD, not 0x1234"
5. Guardian: REJECTS connection
6. Attacker: ❌ BLOCKED

AGENT FAILURE + RECOVERY:
──────────────────────────────────────────────
1. Agent 0x1234 crashes (heartbeat stops)
2. After 5 min: Contract marks inactive
3. Guardians detect: "No heartbeat"
4. New agent 0x5678 requests registration
5. Guardians verify attestation
6. 75% approve new agent
7. Contract: activeAgent = 0x5678
8. New agent gets DB from guardians
9. New agent resumes trading
```

---

## ✅ Implementation Checklist

**Secret Network Contract:**
- [ ] Create PanthersRegistry contract
- [ ] Implement register_agent() with 75% threshold
- [ ] Implement heartbeat() with timeout check
- [ ] Implement check_heartbeat() public function
- [ ] Deploy to Secret Network testnet
- [ ] Deploy to Secret Network mainnet

**Fund Manager:**
- [ ] Implement getTEEInstanceId()
- [ ] Implement generateAttestation()
- [ ] Add initialization logic (check registry)
- [ ] Add registration request flow
- [ ] Add heartbeat loop (60s interval)
- [ ] Add graceful shutdown if not registered

**Guardian:**
- [ ] Add agent verification logic
- [ ] Check registry before accepting connections
- [ ] Implement health monitoring (30s checks)
- [ ] Implement registration approval voting
- [ ] Add deactivation detection
- [ ] Add failover coordination

**Testing:**
- [ ] Test: Single agent registration
- [ ] Test: Rogue agent rejection
- [ ] Test: Heartbeat timeout (5min)
- [ ] Test: Failover to new agent
- [ ] Test: Multiple agents racing for registration
- [ ] Test: Network partition scenarios

---

**This system guarantees only ONE agent can be active at any time, preventing all double-trading scenarios.** 🔒
