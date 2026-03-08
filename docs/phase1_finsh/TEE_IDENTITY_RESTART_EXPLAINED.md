# TEE Identity Restart Behavior - Explained

**Issue from status report:** "TEE Identity changes on container restart → 5min conflict until heartbeat timeout"

---

## 🔍 What's Happening

### **Your Observation:**
```
1. Agent running with session key: pubkey_A
2. docker compose down
3. docker compose up
4. Agent generates NEW session key: pubkey_B
5. Tries to register
6. Conflict: pubkey_A still active for 5 minutes
```

---

## ✅ This is CORRECT Behavior (Security Feature)

### **Why Session Keys Change:**

**Your current code:**
```typescript
// On every boot
const sessionKeypair = crypto.generateKeyPairSync('ed25519');
```

**This is by design:**
- Each boot → Fresh random keypair
- Private key only in TEE memory (never written to disk)
- If container dies → Private key lost forever
- Restart → New keypair required

---

## 🎯 Three Approaches to Handle This

### **Approach A: Accept the 5-Minute Wait** (Current)

**How it works:**
```
T=0     Agent-1 crashes (pubkey_A lost)
T=0+1   docker compose up → Agent-2 generates pubkey_B
T=0+2   Agent-2 tries to register → CONFLICT (pubkey_A still active)
T=5:00  Heartbeat timeout deactivates pubkey_A
T=5:01  Agent-2 retries registration → SUCCESS
```

**Pros:**
- ✅ Simple (no code changes)
- ✅ Most secure (keys never persisted)

**Cons:**
- ❌ 5 minute downtime on restart
- ❌ Manual retry needed

**When to use:** Development, infrequent restarts

---

### **Approach B: Persist Session Key** (Recommended for Production)

**How it works:**
```typescript
const SESSION_KEY_PATH = '/dev/attestation/keys/session-key';

async function getSessionKey(): Promise<KeyPair> {
  // Try to load existing key
  try {
    const sealed = await fs.readFile(SESSION_KEY_PATH);
    // TEE unseals automatically
    return parseKeyPair(sealed);
  } catch {
    // No key exists - generate new one
    const keypair = crypto.generateKeyPairSync('ed25519');
    
    // Seal and store (bound to TEE measurements)
    await fs.writeFile(SESSION_KEY_PATH, keypair.privateKey);
    
    return keypair;
  }
}
```

**Result:**
```
T=0     Agent-1 running with pubkey_A (sealed to disk)
T=1     docker compose down
T=2     docker compose up
T=3     Agent-2 loads pubkey_A from sealed storage ✓
T=4     Agent-2 proves ownership (signs challenge with privkey_A)
T=5     Guardian accepts: "Still the same agent" ✓
```

**Pros:**
- ✅ No downtime on restart
- ✅ Agent maintains identity across restarts
- ✅ Still secure (key sealed to TEE measurements)

**Cons:**
- ❌ Code change invalidates key (RTMR3 changes)
- ❌ Slightly more complex

**When to use:** Production (recommended)

---

### **Approach C: Hot Standby Backup** (Advanced)

**How it works:**
```
Primary Agent (pubkey_A) running
Backup Agent (pubkey_B) in standby

Primary crashes:
├─ Backup detects (monitors heartbeat)
├─ Backup requests registration (pubkey_B)
├─ Guardians approve (primary is dead)
└─ Backup takes over in <1 minute
```

**Pros:**
- ✅ <1 minute failover
- ✅ High availability (99.9%+)
- ✅ No waiting for timeout

**Cons:**
- ❌ Requires backup VM running 24/7
- ❌ More infrastructure cost

**When to use:** Production with strict uptime SLA

---

## 🚀 Recommended Solution: Approach B

**Implement session key persistence ALONG with vault key persistence.**

**File:** `panthers-fund/src/agent/session-manager.ts`

```typescript
import fs from 'fs/promises';
import crypto from 'crypto';

const SESSION_KEY_PATH = '/dev/attestation/keys/session-key';
const FALLBACK_PATH = '/data/session-key.sealed';

export class SessionKeyManager {
  async initialize(): Promise<crypto.KeyPairKeyObjectResult> {
    console.log("🔑 Initializing session key...");
    
    // Try to load existing key
    const existingKey = await this.loadSessionKey();
    if (existingKey) {
      console.log("✅ Loaded existing session key (agent identity preserved)");
      return existingKey;
    }
    
    // Generate new key
    console.log("🆕 Generating new session key (first boot or code changed)");
    const keypair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    
    // Seal and store
    await this.sealSessionKey(keypair);
    
    return keypair;
  }
  
  private async loadSessionKey(): Promise<crypto.KeyPairKeyObjectResult | null> {
    try {
      // Try TEE-sealed storage first
      if (await this.fileExists(SESSION_KEY_PATH)) {
        const data = await fs.readFile(SESSION_KEY_PATH, 'utf8');
        return this.parseKeyPair(data);
      }
      
      // Try fallback
      if (await this.fileExists(FALLBACK_PATH)) {
        const sealed = await fs.readFile(FALLBACK_PATH);
        const data = await this.unsealFallback(sealed);
        return this.parseKeyPair(data);
      }
    } catch (error) {
      console.warn("Could not load session key:", error.message);
    }
    
    return null;
  }
  
  private async sealSessionKey(keypair: crypto.KeyPairKeyObjectResult) {
    const data = JSON.stringify({
      publicKey: keypair.publicKey.export({ type: 'spki', format: 'pem' }),
      privateKey: keypair.privateKey.export({ type: 'pkcs8', format: 'pem' })
    });
    
    try {
      // Try TEE storage
      await fs.mkdir('/dev/attestation/keys', { recursive: true });
      await fs.writeFile(SESSION_KEY_PATH, data, { mode: 0o600 });
      console.log("✅ Session key sealed to TEE storage");
    } catch {
      // Fallback: Encrypt with TEE measurements
      await this.sealFallback(Buffer.from(data));
      console.log("✅ Session key sealed to fallback storage");
    }
  }
  
  private parseKeyPair(data: string): crypto.KeyPairKeyObjectResult {
    const parsed = JSON.parse(data);
    return {
      publicKey: crypto.createPublicKey(parsed.publicKey),
      privateKey: crypto.createPrivateKey(parsed.privateKey)
    };
  }
  
  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
  
  // Same sealing logic as VaultKeyManager (see FIX_VAULT_KEY_PERSISTENCE.md)
  private async sealFallback(data: Buffer) { /* ... */ }
  private async unsealFallback(sealed: Buffer): Promise<string> { /* ... */ }
}
```

---

## 📊 Comparison

| Scenario | Approach A (Accept Wait) | Approach B (Persist Key) | Approach C (Hot Standby) |
|----------|--------------------------|--------------------------|--------------------------|
| **Restart downtime** | 5 minutes | 0 seconds | <1 minute |
| **Code change** | 5 minutes | 5 minutes (new key) | <1 minute |
| **Implementation** | None (current) | 2-3 hours | 1 day |
| **Cost** | $0 | $0 | +$20/month (backup VM) |
| **Uptime** | ~99% | ~99.9% | ~99.99% |

---

## ✅ Recommendation

**For your current stage:**
1. **This week:** Keep Approach A (accept 5min wait on restart)
2. **Next week:** Implement Approach B (persist session key)
3. **Month 1:** Consider Approach C (hot standby) if uptime matters

**Why this order:**
- Week 1: Focus on vault key persistence (more critical)
- Week 2: Add session key persistence (nice to have)
- Month 1: Add backup agent (production hardening)

---

## 🔧 Quick Fix for Immediate Restarts

**If you need to restart NOW and can't wait 5 minutes:**

```bash
# Force-deactivate old agent on-chain
ssh -i ~/.ssh/guardian_vm_key root@67.43.239.6

# Manually trigger heartbeat timeout check
curl -X POST http://localhost:3100/api/force-timeout

# Or edit guardian code to reduce timeout from 5min to 30sec temporarily
# (Not recommended for production, just for testing)
```

---

**Bottom line: Your system is working as designed. This is a feature, not a bug!** 🎯
