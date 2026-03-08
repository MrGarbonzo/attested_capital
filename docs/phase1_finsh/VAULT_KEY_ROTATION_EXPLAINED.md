# Vault Key Rotation with Persistence

**Your Question:** "We built or plan to build vault key rotation. Does persistence conflict with that?"

**Answer:** No! Persistence and rotation work together perfectly.

---

## 🔄 How Rotation Works with Persistence

### **Concept:**

```
Old Key (key_v1) → Encrypts DB snapshots 1-100
Rotation happens
New Key (key_v2) → Encrypts DB snapshots 101-200

Guardian stores:
├─ Snapshots 1-100 (encrypted with key_v1)
├─ Snapshots 101-200 (encrypted with key_v2)
└─ Can decrypt both (has both keys)
```

**Key insight:** You keep OLD keys around to decrypt OLD snapshots, but use NEW key for NEW snapshots.

---

## 🔧 Implementation

### **Key Storage Structure:**

```typescript
// /dev/attestation/keys/ structure:
/dev/attestation/keys/
├── vault-key-current     // Active key (for new encryptions)
├── vault-key-v1          // Rotated key #1 (for old decryptions)
├── vault-key-v2          // Rotated key #2
└── vault-key-v3          // etc.
```

### **VaultKeyManager with Rotation:**

```typescript
export class VaultKeyManager {
  private currentKey: Buffer;
  private keyHistory: Map<number, Buffer> = new Map(); // version → key
  private currentVersion: number;
  
  async initialize() {
    // Load current key
    const current = await this.loadKey('vault-key-current');
    
    if (current) {
      this.currentKey = current.key;
      this.currentVersion = current.version;
      console.log(`✅ Loaded vault key v${this.currentVersion}`);
    } else {
      // First boot - generate initial key
      this.currentKey = crypto.randomBytes(32);
      this.currentVersion = 1;
      await this.saveKey('vault-key-current', this.currentKey, 1);
      console.log("✅ Generated vault key v1");
    }
    
    // Load historical keys (for decrypting old snapshots)
    await this.loadKeyHistory();
  }
  
  async loadKeyHistory() {
    // Try to load v1, v2, v3, etc.
    for (let v = 1; v < this.currentVersion; v++) {
      try {
        const key = await fs.readFile(`/dev/attestation/keys/vault-key-v${v}`);
        this.keyHistory.set(v, key);
        console.log(`  Loaded historical key v${v}`);
      } catch {
        // Key doesn't exist (probably before rotation started)
      }
    }
    
    // Also store current key in history
    this.keyHistory.set(this.currentVersion, this.currentKey);
  }
  
  async rotateKey(reason: string) {
    console.log(`🔄 Rotating vault key (reason: ${reason})`);
    
    // Save current key to history
    const oldVersion = this.currentVersion;
    await this.saveKey(`vault-key-v${oldVersion}`, this.currentKey, oldVersion);
    console.log(`  Archived old key as v${oldVersion}`);
    
    // Generate new key
    const newKey = crypto.randomBytes(32);
    const newVersion = oldVersion + 1;
    
    // Save new key as current
    await this.saveKey('vault-key-current', newKey, newVersion);
    console.log(`  Generated new key v${newVersion}`);
    
    // Update in-memory state
    this.keyHistory.set(oldVersion, this.currentKey); // Keep old key
    this.currentKey = newKey;
    this.currentVersion = newVersion;
    
    // Broadcast new key to guardians (encrypted for each guardian)
    await this.broadcastKeyToGuardians(newKey, newVersion);
    
    console.log(`✅ Rotation complete: v${oldVersion} → v${newVersion}`);
  }
  
  getCurrentKey(): Buffer {
    return this.currentKey;
  }
  
  getCurrentVersion(): number {
    return this.currentVersion;
  }
  
  getKeyByVersion(version: number): Buffer | null {
    return this.keyHistory.get(version) || null;
  }
  
  async broadcastKeyToGuardians(key: Buffer, version: number) {
    const guardians = await this.getGuardians();
    
    for (const guardian of guardians) {
      // Encrypt new key with guardian's public key
      const encrypted = await this.encryptForGuardian(key, guardian.publicKey);
      
      await guardian.sendMessage({
        type: 'KEY_ROTATION',
        version: version,
        encrypted_key: encrypted.toString('base64'),
        timestamp: Date.now()
      });
    }
  }
}
```

---

## 📦 Encrypted Snapshot Format

**Include key version in snapshot:**

```typescript
interface EncryptedSnapshot {
  version: number;           // DB snapshot version (1, 2, 3...)
  keyVersion: number;        // Which vault key was used (1, 2, 3...)
  timestamp: number;
  encrypted: string;         // Base64-encoded ciphertext
  iv: string;
  authTag: string;
}
```

**When encrypting:**
```typescript
async encryptSnapshot(data: Buffer): Promise<EncryptedSnapshot> {
  const key = this.keyManager.getCurrentKey();
  const keyVersion = this.keyManager.getCurrentVersion();
  
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  return {
    version: this.snapshotCounter++,
    keyVersion: keyVersion,  // Record which key was used!
    timestamp: Date.now(),
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };
}
```

**When decrypting:**
```typescript
async decryptSnapshot(snapshot: EncryptedSnapshot): Promise<Buffer> {
  // Get the specific key version that was used
  const key = this.keyManager.getKeyByVersion(snapshot.keyVersion);
  
  if (!key) {
    throw new Error(`Cannot decrypt: vault key v${snapshot.keyVersion} not available`);
  }
  
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(snapshot.iv, 'base64')
  );
  
  decipher.setAuthTag(Buffer.from(snapshot.authTag, 'base64'));
  
  return Buffer.concat([
    decipher.update(Buffer.from(snapshot.encrypted, 'base64')),
    decipher.final()
  ]);
}
```

---

## ⏰ When to Rotate

**Recommended rotation triggers:**

1. **Time-based:** Every 30 days
   ```typescript
   setInterval(() => {
     await keyManager.rotateKey('scheduled_monthly');
   }, 30 * 24 * 60 * 60 * 1000);
   ```

2. **After security event:**
   ```typescript
   if (suspectedCompromise) {
     await keyManager.rotateKey('security_incident');
   }
   ```

3. **After guardian changes:**
   ```typescript
   async onGuardianRemoved(guardianId: string) {
     // Rotate so removed guardian can't decrypt new snapshots
     await keyManager.rotateKey(`guardian_removed_${guardianId}`);
   }
   ```

4. **After code update:**
   ```typescript
   if (rtmr3Changed) {
     // Old key sealed to old RTMR3 → won't unseal
     // Auto-generate new key (handled by initialize())
     console.log("Code changed, starting fresh with new key");
   }
   ```

---

## 🔒 Security Benefits

**Why rotation is good:**

1. **Limits blast radius**
   - Old snapshots encrypted with old keys
   - If current key leaks → only affects recent snapshots
   - Old snapshots still safe (encrypted with rotated keys)

2. **Guardian removal**
   - Remove guardian from network
   - Rotate key immediately
   - Removed guardian can read OLD snapshots but not NEW ones

3. **Compliance**
   - Many regulations require key rotation (PCI-DSS, etc.)
   - 30-day rotation is industry standard

---

## 🔄 Recovery Flow with Rotation

**Agent crashes, needs to recover from guardian:**

```
Agent: "I need latest DB snapshot"
Guardian: "Latest is snapshot #150, encrypted with key v3"
Agent: "Do I have key v3?"
  └─ Check /dev/attestation/keys/vault-key-current
  └─ Yes! I have v3 ✓
Agent: Decrypt snapshot #150 with key v3 ✓
Agent: Resume trading
```

**Agent behind, needs to catch up:**

```
Agent: "I have snapshot #50, what's latest?"
Guardian: "Latest is #150, here are #51-150"

Agent processes snapshots:
├─ #51-100: encrypted with key v1
│  └─ Decrypt with /dev/attestation/keys/vault-key-v1 ✓
├─ #101-140: encrypted with key v2
│  └─ Decrypt with /dev/attestation/keys/vault-key-v2 ✓
└─ #141-150: encrypted with key v3
   └─ Decrypt with /dev/attestation/keys/vault-key-current ✓
   
Agent: All caught up!
```

---

## ✅ Summary

**Your rotation plan + persistence = Perfect combination!**

**What you get:**
- ✅ Keys persist across restarts (solve your immediate problem)
- ✅ Keys rotate on schedule (security best practice)
- ✅ Old keys kept for decrypting old snapshots
- ✅ Removed guardians can't read new data
- ✅ Compliance-friendly (30-day rotation)

**What to implement:**
1. **This week:** Add persistence (fix restart issue)
2. **Next week:** Add rotation (30-day schedule)
3. **Month 1:** Test guardian removal + rotation

**No conflict at all - they complement each other!** 🔒
