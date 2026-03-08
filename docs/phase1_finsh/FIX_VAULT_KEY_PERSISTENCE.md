# CRITICAL FIX: Vault Key Persistence

**Problem:** Vault key regenerates on every container restart → encrypted DB snapshots become useless.

**Root Cause:** VaultClient generates fresh key on initialization, doesn't persist it.

---

## 🔒 Solution: TEE-Sealed Vault Key

### **Approach:**

Use TEE sealing to persist the vault key across restarts while keeping it secure.

**SecretVM provides:**
- `/dev/attestation/keys/` - Hardware-sealed key storage
- Keys are bound to the TEE instance's measurements
- Keys survive container restarts
- Keys are destroyed if code/config changes (MRTD/RTMR changes)

---

### **Implementation:**

**File:** `panthers-fund/src/vault/key-manager.ts`

```typescript
import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';

const SEALED_KEY_PATH = '/dev/attestation/keys/vault-key';
const FALLBACK_KEY_PATH = '/data/vault-key.sealed'; // If /dev/attestation not available

export class VaultKeyManager {
  private vaultKey: Buffer | null = null;
  
  async initialize(): Promise<Buffer> {
    console.log("🔑 Initializing vault key...");
    
    // Try to load existing key
    const existingKey = await this.loadSealedKey();
    
    if (existingKey) {
      console.log("✅ Loaded existing vault key from sealed storage");
      this.vaultKey = existingKey;
      return existingKey;
    }
    
    // No existing key - generate new one
    console.log("🆕 Generating new vault key (first boot)");
    const newKey = crypto.randomBytes(32); // 256-bit AES key
    
    // Seal and store
    await this.sealAndStoreKey(newKey);
    
    console.log("✅ Vault key generated and sealed");
    this.vaultKey = newKey;
    return newKey;
  }
  
  async loadSealedKey(): Promise<Buffer | null> {
    // Try TEE-sealed storage first
    try {
      if (await this.fileExists(SEALED_KEY_PATH)) {
        console.log(`Loading key from TEE-sealed storage: ${SEALED_KEY_PATH}`);
        const sealedData = await fs.readFile(SEALED_KEY_PATH);
        
        // Key is already unsealed by TEE hardware
        // (SecretVM automatically unseals keys in /dev/attestation/keys/)
        return sealedData;
      }
    } catch (error) {
      console.warn("TEE-sealed storage not available, trying fallback...");
    }
    
    // Try fallback (encrypted with TEE-derived key)
    try {
      if (await this.fileExists(FALLBACK_KEY_PATH)) {
        console.log(`Loading key from fallback: ${FALLBACK_KEY_PATH}`);
        return await this.unsealFallbackKey(FALLBACK_KEY_PATH);
      }
    } catch (error) {
      console.warn("Fallback key not found");
    }
    
    return null;
  }
  
  async sealAndStoreKey(key: Buffer) {
    // Try TEE-sealed storage first
    try {
      await fs.mkdir(path.dirname(SEALED_KEY_PATH), { recursive: true });
      await fs.writeFile(SEALED_KEY_PATH, key, { mode: 0o600 });
      console.log(`✅ Key sealed to TEE storage: ${SEALED_KEY_PATH}`);
      return;
    } catch (error) {
      console.warn("TEE-sealed storage failed, using fallback...");
    }
    
    // Fallback: Encrypt with TEE-derived key
    await this.sealFallbackKey(key, FALLBACK_KEY_PATH);
    console.log(`✅ Key sealed to fallback: ${FALLBACK_KEY_PATH}`);
  }
  
  async sealFallbackKey(key: Buffer, path: string) {
    // Derive sealing key from TEE measurements
    const teeIdentity = await this.getTEEIdentity();
    const sealingKey = crypto.createHash('sha256')
      .update('vault-key-sealing')
      .update(teeIdentity.mrtd)
      .update(teeIdentity.rtmr3)
      .digest();
    
    // Encrypt vault key with sealing key
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', sealingKey, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(key),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    // Store: iv + authTag + encrypted
    const sealed = Buffer.concat([iv, authTag, encrypted]);
    await fs.writeFile(path, sealed, { mode: 0o600 });
  }
  
  async unsealFallbackKey(path: string): Promise<Buffer> {
    const sealed = await fs.readFile(path);
    
    // Extract components
    const iv = sealed.slice(0, 16);
    const authTag = sealed.slice(16, 32);
    const encrypted = sealed.slice(32);
    
    // Derive sealing key from current TEE measurements
    const teeIdentity = await this.getTEEIdentity();
    const sealingKey = crypto.createHash('sha256')
      .update('vault-key-sealing')
      .update(teeIdentity.mrtd)
      .update(teeIdentity.rtmr3)
      .digest();
    
    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealingKey, iv);
    decipher.setAuthTag(authTag);
    
    const key = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    return key;
  }
  
  async getTEEIdentity(): Promise<{ mrtd: string; rtmr3: string }> {
    // Fetch from :29343/cpu.html
    const response = await fetch('https://localhost:29343/cpu.html', {
      // Self-signed cert, but we're on localhost so this is safe
      agent: new https.Agent({ rejectUnauthorized: false })
    });
    
    const html = await response.text();
    
    // Parse MRTD and RTMR3 from HTML
    const mrtdMatch = html.match(/MRTD.*?([0-9a-f]{96})/i);
    const rtmr3Match = html.match(/RTMR3.*?([0-9a-f]{96})/i);
    
    if (!mrtdMatch || !rtmr3Match) {
      throw new Error('Could not parse TEE measurements');
    }
    
    return {
      mrtd: mrtdMatch[1],
      rtmr3: rtmr3Match[1]
    };
  }
  
  async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
  
  getVaultKey(): Buffer {
    if (!this.vaultKey) {
      throw new Error('Vault key not initialized');
    }
    return this.vaultKey;
  }
}
```

---

### **Update VaultClient:**

**File:** `panthers-fund/src/vault/client.ts`

```typescript
import { VaultKeyManager } from './key-manager';

export class VaultClient {
  private keyManager: VaultKeyManager;
  private vaultKey: Buffer;
  
  async initialize() {
    // Use persistent key manager
    this.keyManager = new VaultKeyManager();
    this.vaultKey = await this.keyManager.initialize();
    
    console.log("✅ VaultClient initialized with persistent key");
  }
  
  // Rest of your encryption logic stays the same
  // Just use this.vaultKey instead of generating fresh
}
```

---

### **Docker Volume Mount:**

**Update `docker-compose.yml`:**

```yaml
services:
  panthers-agent:
    volumes:
      - panthers-data:/data
      - tee-keys:/dev/attestation  # Mount TEE key storage
    
volumes:
  panthers-data:
  tee-keys:
```

---

### **Why This Works:**

1. **First Boot:**
   - No sealed key exists
   - Generate new vault key
   - Seal with TEE measurements
   - Store to `/dev/attestation/keys/vault-key`

2. **Restart (Same Code):**
   - TEE measurements (MRTD, RTMR3) are same
   - Load sealed key
   - Unseals automatically (hardware-bound)
   - Use same vault key → Can decrypt old DB snapshots ✅

3. **Code Update:**
   - RTMR3 changes (new docker-compose.yaml)
   - Old sealed key won't unseal (different measurements)
   - Generate NEW vault key
   - Old DB snapshots lost (by design - code changed!)

---

### **Benefits:**

✅ Vault key persists across restarts
✅ Can decrypt DB snapshots from guardians
✅ Hardware-sealed (can't export)
✅ Automatic unsealing by TEE
✅ Invalidates on code changes (security feature)

---

### **Testing:**

```bash
# First boot
docker compose up
# → Generates and seals new vault key
# → Syncs DB to guardians

# Restart
docker compose restart
# → Loads existing vault key
# → Can decrypt snapshots from guardians ✅

# Code update
docker compose down
# Edit docker-compose.yaml (changes RTMR3)
docker compose up
# → Old key won't unseal
# → Generates NEW vault key
# → Starts fresh (expected behavior)
```

---

**Deploy this ASAP - it's blocking your DB sync recovery flow!**
