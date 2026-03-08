# Agent Registration & Backup System - Summary

**Created:** 2 comprehensive technical documents for Claude Code

---

## 📄 Document 1: AGENT_REGISTRATION_SYSTEM.md

**Purpose:** Prevent multiple trading agents from running simultaneously and causing double-trades.

**What it covers:**
- The attack scenario (cloning repo and running duplicate agent)
- On-chain registry system (Secret Network smart contract)
- TEE instance ID (hardware-bound unique identifier)
- Agent registration flow (75% guardian approval)
- Heartbeat system (60s intervals, 5min timeout)
- Guardian verification logic
- Security guarantees and attack defenses

**Key components to implement:**
1. Secret Network `PanthersRegistry` contract
2. Agent registration and heartbeat logic
3. Guardian verification before accepting connections
4. TEE instance ID extraction and attestation

**Solves:** The core problem of preventing duplicate agents from trading simultaneously.

---

## 📄 Document 2: HOT_STANDBY_BACKUP_SYSTEM.md

**Purpose:** Enable high-availability trading with automatic failover using backup agents.

**What it covers:**
- Standby mode (backup agents monitoring but not trading)
- Automatic takeover when primary fails
- Multiple backups racing to register (only one wins)
- Guardian approval voting for backups
- Failover timeline (~6 minute downtime)
- Deployment configurations (single backup, triple redundancy, etc.)
- Safety guarantees (why backups can't double-trade)

**Key components to implement:**
1. Standby monitoring mode (check registry every 30s)
2. Takeover attempt with race condition handling
3. Guardian registration approval voting
4. Random delay to reduce collision

**Solves:** Production-grade high availability with <6min downtime on primary failure.

---

## 🔗 How They Work Together

**AGENT_REGISTRATION_SYSTEM.md:**
- Establishes the foundation (on-chain registry + TEE instance ID)
- Ensures only ONE agent can be active at a time
- Prevents double-trading through contract enforcement

**HOT_STANDBY_BACKUP_SYSTEM.md:**
- Builds on the foundation
- Shows how to run multiple agents safely
- Only standby agents can't trade (no database, not registered)
- When primary dies → Backup registers → Becomes active → Gets database → Starts trading

**Result:** High availability + Zero risk of double-trading

---

## ✅ Implementation Order

**Phase 1: Core Registration (Week 1)**
1. Implement Secret Network `PanthersRegistry` contract
2. Add TEE instance ID extraction
3. Add agent registration logic
4. Add heartbeat system
5. Deploy and test single agent

**Phase 2: Guardian Integration (Week 2)**
1. Add guardian verification of TEE instance ID
2. Add registration approval voting
3. Test: Guardian rejects rogue agents
4. Test: Heartbeat timeout and deactivation

**Phase 3: Backup System (Week 3)**
1. Add standby monitoring mode
2. Add takeover attempt logic
3. Test: Single backup failover
4. Test: Multiple backups racing

**Phase 4: Production (Week 4)**
1. Deploy primary to AWS
2. Deploy backups to GCP and Azure
3. Test failover in production
4. Monitor and tune

---

## 🎯 Expected Outcomes

**After Phase 1-2:**
- ✅ Single agent running securely
- ✅ Rogue agents cannot connect
- ✅ Double-trading impossible
- ✅ Agent can be restarted manually

**After Phase 3-4:**
- ✅ Primary fails → Backup takes over automatically
- ✅ <6 minute downtime
- ✅ 99.99% uptime (triple redundancy)
- ✅ Zero human intervention required

---

## 📋 Key Files to Create

**Smart Contracts:**
- `contracts/PanthersRegistry.secret` - On-chain registry

**Fund Manager:**
- `fund-manager/src/tee.ts` - TEE instance ID and attestation
- `fund-manager/src/initialization.ts` - Registration logic
- `fund-manager/src/standby-mode.ts` - Backup monitoring
- `fund-manager/src/backup-coordination.ts` - Race handling

**Guardian:**
- `guardian/src/agent-verification.ts` - Verify TEE instance ID
- `guardian/src/registration-voting.ts` - Approval voting

**Shared:**
- `shared/src/attestation.ts` - TEE attestation utilities

---

## 🔒 Security Summary

**These documents solve:**
1. ✅ Rogue agents (can't connect - wrong TEE ID)
2. ✅ Double-trading (only one agent has database)
3. ✅ Downtime (backups take over automatically)
4. ✅ Split-brain (contract enforces single active agent)
5. ✅ Manual recovery (backups handle it automatically)

**Attack scenarios defended:**
- Attacker clones code → Blocked (different TEE ID)
- Attacker modifies code → Blocked (code hash mismatch)
- Attacker runs multiple instances → Blocked (contract allows only one)
- Primary crashes → Backup takes over (automatic)
- Network partition → Heartbeat timeout (automatic deactivation)

---

**Both documents are ready for Claude Code to implement!** 🚀
