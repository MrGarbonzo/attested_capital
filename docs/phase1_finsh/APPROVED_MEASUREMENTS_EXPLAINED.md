# APPROVED_MEASUREMENTS - Security Setting Explained

**Your Question:** "Explain this better. Is it fixed with option a?"

**Simple Answer:** Yes! Just add the guardian's MRTD hash to your agent's .env file.

---

## 🔒 What APPROVED_MEASUREMENTS Does

### **The Problem:**

Your agent currently has:
```bash
APPROVED_MEASUREMENTS=   # Empty!
```

**This means:**
```
ANY TEE attestation gets approved
├─ Attacker's TEE: MRTD = 0xABCD... → ✅ ACCEPTED
├─ Your guardian: MRTD = 0x1234... → ✅ ACCEPTED
└─ Random TEE: MRTD = 0x9999... → ✅ ACCEPTED

Result: Anyone with a TEE can register as guardian!
```

---

### **What MRTD Is:**

**MRTD (Measurement Register for Trust Domain)** = Hash of the code running in the TEE

Think of it like a **fingerprint of your guardian software**.

**How it's calculated:**
```
MRTD = SHA384(
  firmware +
  kernel +
  initramfs +
  rootfs +
  docker-compose.yaml +
  container image
)
```

**Key properties:**
- ✅ Same code → Same MRTD (deterministic)
- ✅ Different code → Different MRTD
- ✅ Can't fake (measured by TEE hardware)

---

## ✅ The Fix (Super Simple)

### **Step 1: Get Your Guardian's MRTD**

```bash
# SSH to your guardian
ssh -i ~/.ssh/guardian_vm_key root@67.43.239.6

# Fetch attestation report
curl -k https://localhost:29343/cpu.html > report.html

# Extract MRTD (it's a 96-character hex string)
grep -A1 "MRTD" report.html

# Example output:
# <td>MRTD</td>
# <td>9a7b3c4d5e6f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d</td>

# Copy that hash: 9a7b3c4d5e6f...
```

### **Step 2: Add to Agent .env**

```bash
# SSH to your agent
ssh -i ~/.ssh/secretvm_key root@67.215.13.107

# Edit .env
nano /mnt/secure/docker_wd/usr/.env

# Add this line (paste your guardian's MRTD):
APPROVED_MEASUREMENTS=9a7b3c4d5e6f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d

# Save and exit (Ctrl+X, Y, Enter)
```

### **Step 3: Restart Agent**

```bash
cd /mnt/secure/docker_wd
docker compose restart panthers-agent

# Check logs
docker compose logs -f panthers-agent

# You should see:
# ✅ APPROVED_MEASUREMENTS configured: 9a7b3c4d...
```

---

## 🔒 What This Achieves

**Before (insecure):**
```
Rogue Guardian (MRTD: 0xBAD) tries to register
Agent: "Empty APPROVED_MEASUREMENTS, accepting anyone" ✅
Rogue Guardian: Connected! 😈
```

**After (secure):**
```
Rogue Guardian (MRTD: 0xBAD) tries to register
Agent: "MRTD 0xBAD doesn't match approved 0x1234..." ❌
Rogue Guardian: REJECTED! 🚫

Your Guardian (MRTD: 0x1234) tries to register
Agent: "MRTD 0x1234 matches approved!" ✅
Your Guardian: Connected! 🛡️
```

---

## 🔍 How Verification Works

**In your agent code:**

```typescript
async verifyGuardianAttestation(attestation: Buffer): Promise<boolean> {
  // 1. Extract MRTD from attestation
  const mrtd = extractMRTD(attestation);
  console.log(`Guardian MRTD: ${mrtd}`);
  
  // 2. Get approved list from env
  const approved = process.env.APPROVED_MEASUREMENTS?.split(',') || [];
  
  // 3. Check if this MRTD is approved
  if (approved.length === 0) {
    console.warn("⚠️  No APPROVED_MEASUREMENTS set - accepting all!");
    return true; // Dangerous!
  }
  
  if (!approved.includes(mrtd)) {
    console.error(`❌ MRTD ${mrtd} not in approved list`);
    return false;
  }
  
  console.log(`✅ MRTD approved`);
  return true;
}
```

---

## 📋 Multiple Guardians

**If you have multiple guardians with DIFFERENT code:**

```bash
# Comma-separated list
APPROVED_MEASUREMENTS=9a7b3c4d...,1e2f3a4b...,5c6d7e8f...
                      ^^^^^^^^^  ^^^^^^^^^  ^^^^^^^^^
                      Guardian1  Guardian2  Guardian3
```

**But typically:**
- All guardians run SAME code → SAME MRTD → One entry
- Only need multiple if you have different guardian versions

---

## 🔄 When MRTD Changes

**MRTD changes when:**
- ❌ Container restart (same code) → MRTD stays same
- ✅ Code update (new guardian version) → MRTD changes
- ✅ Docker image update → MRTD changes
- ✅ Kernel update → MRTD changes

**What to do when you update guardian code:**

```bash
# 1. Deploy updated guardian
docker compose up --build

# 2. Get new MRTD
curl -k https://localhost:29343/cpu.html | grep MRTD
# New MRTD: 5c6d7e8f...

# 3. Update agent .env (keep old one temporarily)
APPROVED_MEASUREMENTS=9a7b3c4d...,5c6d7e8f...
                      ^^^^^^^^^^^  ^^^^^^^^^^^
                      Old guardian New guardian

# 4. Restart agent
docker compose restart

# 5. After confirming new guardian works, remove old MRTD
APPROVED_MEASUREMENTS=5c6d7e8f...
```

---

## ✅ Summary

**Question:** "Is it fixed with option a?"

**Answer:** YES! "Option A" = Just set APPROVED_MEASUREMENTS in .env

**Steps:**
1. Get guardian MRTD: `curl -k https://localhost:29343/cpu.html | grep MRTD`
2. Add to agent .env: `APPROVED_MEASUREMENTS=<hash>`
3. Restart agent: `docker compose restart`

**Time:** 5 minutes

**Result:** Only YOUR guardian can register. Rogue guardians get rejected.

---

## 🎯 Complete Fix Commands

**Copy-paste this:**

```bash
# On guardian VM (67.43.239.6)
ssh -i ~/.ssh/guardian_vm_key root@67.43.239.6
MRTD=$(curl -k https://localhost:29343/cpu.html 2>/dev/null | grep -oP '(?<=<td>MRTD</td>\s*<td>)[a-f0-9]{96}')
echo "Guardian MRTD: $MRTD"
echo "$MRTD" > /tmp/guardian-mrtd.txt
exit

# On agent VM (67.215.13.107)
ssh -i ~/.ssh/secretvm_key root@67.215.13.107
echo "APPROVED_MEASUREMENTS=$(ssh -i ~/.ssh/guardian_vm_key root@67.43.239.6 'cat /tmp/guardian-mrtd.txt')" >> /mnt/secure/docker_wd/usr/.env
docker compose restart panthers-agent

# Verify
docker compose logs panthers-agent | grep APPROVED_MEASUREMENTS
# Should show: ✅ APPROVED_MEASUREMENTS configured: 9a7b3c...
```

**Done! Security hole closed.** 🔒
