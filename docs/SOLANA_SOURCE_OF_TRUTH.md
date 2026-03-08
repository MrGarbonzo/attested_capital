# Panthers Fund - Solana-Only Architecture (NFT = Source of Truth)

**Key Decisions:**
1. ✅ Solana NFT ownership = fund access (on-chain is source of truth)
2. ✅ Solana-only (drop ETH, Base, Secret)
3. ✅ Magic Eden integration (NFT trading = fund share trading)

**This is BETTER than the hybrid approach!**

---

## 🎯 **CORE PRINCIPLE: NFT Ownership = Fund Access**

```
Traditional Model (rejected):
├─ DB = source of truth
├─ NFT = proof of ownership
└─ Problem: DB and chain can diverge

New Model (adopted):
├─ SOLANA NFT = source of truth ✅
├─ DB = cache for performance
└─ Whoever owns NFT on-chain controls fund value
```

---

## 🏗️ **COMPLETE ARCHITECTURE**

### **1. NFT Structure (On-Chain)**

```typescript
// Solana NFT metadata (source of truth)
{
  name: "Panthers Fund #123",
  symbol: "PNTR",
  description: "Autonomous trading fund share. Check current value at panthers.fund",
  image: "https://panthers.fund/nft/123/image",
  
  // Standard attributes
  attributes: [
    { trait_type: "NFT ID", value: "123" },
    { trait_type: "Minted Date", value: "2026-03-02" },
    { trait_type: "Initial Deposit", value: "100" },
  ],
  
  // Panthers-specific (on-chain)
  properties: {
    category: "investment",
    creators: [
      { address: "AGENT_WALLET", verified: true, share: 100 }
    ]
  },
  
  // Dynamic metadata (fetched from API)
  external_url: "https://panthers.fund/nft/123"
}

// API endpoint (always fresh):
GET https://panthers.fund/nft/123
{
  currentValue: 125.50,
  initialDeposit: 100,
  return: "+25.5%",
  lastUpdated: "2026-03-02T15:30:00Z",
  totalTrades: 450,
  winRate: 78,
  currentStrategy: "EMA Crossover"
}
```

### **2. Fund Value Tracking (DB = Cache)**

```typescript
// Database schema (performance cache, NOT source of truth)
interface NFTCache {
  // Solana data (cached from chain)
  mintAddress: string;          // Primary key (Solana NFT address)
  currentOwner: string;          // Solana wallet address
  ownershipLastChecked: number;  // Timestamp of last verification
  
  // Fund data (agent calculates)
  currentValue: number;          // $125.50
  initialDeposit: number;        // $100 (at mint)
  shareOfPool: number;           // 0.02 (2% of pool)
  
  // Trading history (for this NFT's share)
  allocatedTrades: Trade[];      // Proportional share of all trades
  pnlHistory: PNL[];            // Track performance over time
  
  // Metadata
  mintedAt: number;
  lastValueUpdate: number;
  
  // Telegram mapping (optional, for convenience)
  telegramUserId?: number;       // If user connected via Telegram
}

// Fund state (global)
interface FundState {
  totalPoolValue: number;        // $6,250 (sum of all USDC + positions)
  totalNFTs: number;             // 50 NFTs
  valuePerNFT: number;           // $125 average
  
  // Important: This is calculated from on-chain NFT count!
  activeNFTAddresses: string[];  // Query from Metaplex collection
}
```

### **3. Ownership Verification Flow**

```typescript
class OwnershipVerifier {
  async verifyOwnership(nftMintAddress: string): Promise<{
    owner: string;
    verified: boolean;
  }> {
    // Query Solana for current owner
    const nft = await this.metaplex.nfts().findByMint({
      mintAddress: new PublicKey(nftMintAddress)
    });
    
    const currentOwner = nft.owner.address.toString();
    
    // Update cache
    await this.db.updateNFTCache(nftMintAddress, {
      currentOwner: currentOwner,
      ownershipLastChecked: Date.now()
    });
    
    return {
      owner: currentOwner,
      verified: true // Verified on-chain!
    };
  }
  
  async canUserAccessNFT(userWallet: string, nftMint: string): Promise<boolean> {
    const { owner } = await this.verifyOwnership(nftMint);
    return owner === userWallet;
  }
}
```

---

## 🔄 **COMPLETE USER FLOWS**

### **Flow 1: New User Buys NFT (Direct Mint)**

```
User: /buy

Bot: "Buy Panthers NFT for $105?
Connect your Phantom wallet to receive NFT."

User: Clicks "Connect Wallet" button
      → Phantom opens
      → User approves connection
      → Bot gets wallet address: 9xQs...8kL

Agent:
├─ 1. Receive payment ($105 USDC via Solana Pay)
├─ 2. Mint compressed NFT
├─ 3. Transfer to USER'S wallet (9xQs...8kL) ✅
│     (NOT to agent wallet - user has custody immediately!)
├─ 4. Record in DB cache:
│     {
│       mintAddress: "DRi...p9f",
│       currentOwner: "9xQs...8kL",
│       currentValue: 105,
│       initialDeposit: 105,
│       shareOfPool: 105 / totalPool,
│       telegramUserId: user_id
│     }
└─ 5. Notify: "✅ Panther #123 minted to your wallet!"

User now:
├─ Owns NFT in Phantom ✅
├─ Can trade on Magic Eden ✅
├─ Can check value: /balance
└─ Participates in fund trading
```

**Key Difference:** NFT goes to USER'S wallet immediately, not agent's!

---

### **Flow 2: Alice Sells NFT to Bob on Magic Eden**

```
STEP 1: Alice Lists on Magic Eden
──────────────────────────────────────────────
Alice: Opens Phantom
Alice: Goes to Magic Eden
Alice: Lists Panther #123 for 1.5 SOL (~$150)

On-chain state:
├─ NFT still owned by Alice
├─ Listed in Magic Eden escrow
└─ Fund value: $125 (continues tracking)

STEP 2: Bob Buys on Magic Eden
──────────────────────────────────────────────
Bob: Sees listing on Magic Eden
Bob: Buys for 1.5 SOL
Magic Eden: Executes swap
  ├─ Alice receives 1.5 SOL (minus 2% fee)
  ├─ Bob receives NFT
  └─ Ownership transfer on-chain ✅

On-chain state:
├─ NFT now owned by Bob (9zT...3xK)
├─ Fund value: Still $125
└─ Agent doesn't know yet (needs to sync)

STEP 3: Bob Discovers He Owns Fund Share
──────────────────────────────────────────────
Bob: Opens Telegram bot
Bot: "Connect your Phantom wallet"
Bob: Connects wallet (9zT...3xK)

Agent:
├─ 1. Scan Bob's wallet for Panthers NFTs
├─ 2. Find Panther #123 (owned by Bob!)
├─ 3. Verify on-chain ownership ✓
├─ 4. Update DB cache:
│     {
│       mintAddress: "DRi...p9f",
│       currentOwner: "9zT...3xK", // ← Changed!
│       currentValue: 125,
│       telegramUserId: bob_telegram_id
│     }
└─ 5. Notify Bob: "✅ You own Panther #123 (value: $125)"

Bob now:
├─ Has full access to fund value
├─ Can check balance: /balance → $125
├─ Can withdraw: /withdraw → Gets $122.50 (2% fee)
├─ Participates in future trades
└─ Alice has zero access (she sold the NFT)

STEP 4: Next Trading Cycle
──────────────────────────────────────────────
Agent executes trade:
├─ Pool: $6,250 → $6,500 (+4%)
├─ All NFT values increase 4%
├─ Panther #123: $125 → $130

Bob's NFT value: $130 (automatically!)
Alice's access: None (she sold the NFT)
```

**This is PERFECT trustless ownership transfer!**

---

### **Flow 3: User Checks Balance (Wallet Verification)**

```
Bob: /balance

Bot: "Connect your Phantom wallet"
Bob: Connects wallet (9zT...3xK)

Agent:
├─ 1. Scan wallet for Panthers NFTs
├─ 2. Query Metaplex collection:
│     findAllByOwner(9zT...3xK, PANTHERS_COLLECTION)
├─ 3. Find: Panther #123 owned by Bob ✓
├─ 4. Look up current value in DB cache: $130
├─ 5. Return balance

Bot: "💰 Your Panthers NFTs

Panther #123
├─ Current Value: $130.00
├─ Initial Deposit: $105.00
├─ Return: +23.8% (+$25.00)
├─ Share of Pool: 2.08%
└─ View on Magic Eden: [link]

Total: $130.00"
```

---

### **Flow 4: User Withdraws (Burns NFT)**

```
Bob: /withdraw

Bot: "Withdraw $130 from Panther #123?
⚠️ NFT will be burned (destroyed)
⚠️ 2% fee = $2.60 (goes to remaining holders)
⚠️ You receive: $127.40

Confirm? /withdraw_confirm"

Bob: /withdraw_confirm

Agent:
├─ 1. Verify Bob owns NFT on-chain ✓
├─ 2. Burn NFT:
│     await metaplex.nfts().delete({
│       nftOrSft: { address: nftMint }
│     })
├─ 3. Send $127.40 USDC to Bob's wallet
├─ 4. Distribute $2.60 fee to remaining 49 NFT holders:
│     Each gets: $2.60 / 49 = $0.053
├─ 5. Update pool:
│     totalPool: $6,500 - $130 = $6,370
│     totalNFTs: 50 - 1 = 49
├─ 6. Update DB cache (mark as burned)
└─ 7. Notify: "✅ Withdrawal complete! $127.40 sent"

Result:
├─ Bob's wallet: +$127.40 USDC ✅
├─ NFT: Burned (doesn't exist anymore)
├─ Other 49 NFTs: Each worth $0.053 more
└─ Pool: $6,370 across 49 NFTs
```

---

## 💻 **IMPLEMENTATION: Key Components**

### **1. Wallet Connection (Telegram)**

```typescript
// File: fund-manager/src/telegram/wallet-connect.ts

import { Keypair } from '@solana/web3.js';

class TelegramWalletConnect {
  async initiateConnection(ctx: any) {
    // Generate one-time connection token
    const token = crypto.randomBytes(32).toString('hex');
    
    // Store pending connection
    this.pendingConnections.set(token, {
      telegramUserId: ctx.from.id,
      expiresAt: Date.now() + 300000 // 5 min
    });
    
    // Generate deep link (opens Phantom)
    const connectUrl = `https://phantom.app/ul/v1/connect?` +
      `app_url=${encodeURIComponent('https://panthers.fund/connect')}` +
      `&dapp_encryption_public_key=${this.encryptionKey}` +
      `&redirect_link=${encodeURIComponent(`https://t.me/${this.botUsername}?start=${token}`)}` +
      `&cluster=mainnet-beta`;
    
    await ctx.reply(
      "Connect your Phantom wallet:",
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "🦊 Connect Phantom", url: connectUrl }
          ]]
        }
      }
    );
  }
  
  async handleConnection(token: string, walletAddress: string, signature: string) {
    const pending = this.pendingConnections.get(token);
    
    if (!pending) {
      throw new Error('Invalid or expired connection token');
    }
    
    // Verify signature (Phantom signs a message proving ownership)
    const verified = await this.verifySignature(walletAddress, signature);
    
    if (!verified) {
      throw new Error('Invalid signature');
    }
    
    // Store wallet connection
    await this.db.setWalletConnection({
      telegramUserId: pending.telegramUserId,
      walletAddress: walletAddress,
      connectedAt: Date.now(),
      verified: true
    });
    
    // Scan for NFTs
    const nfts = await this.scanWalletForNFTs(walletAddress);
    
    // Update cache
    for (const nft of nfts) {
      await this.db.updateNFTCache(nft.mintAddress, {
        currentOwner: walletAddress,
        telegramUserId: pending.telegramUserId,
        ownershipLastChecked: Date.now()
      });
    }
    
    // Notify user
    await this.bot.sendMessage(
      pending.telegramUserId,
      `✅ Wallet connected!\n\n` +
      `Address: ${walletAddress.substring(0, 8)}...\n` +
      `Panthers NFTs found: ${nfts.length}\n\n` +
      `Use /balance to see your holdings.`
    );
    
    this.pendingConnections.delete(token);
  }
  
  async scanWalletForNFTs(walletAddress: string): Promise<NFT[]> {
    // Query Metaplex for all NFTs in Panthers collection owned by this wallet
    const nfts = await this.metaplex.nfts().findAllByOwner({
      owner: new PublicKey(walletAddress)
    });
    
    // Filter for Panthers collection
    const panthersNFTs = nfts.filter(nft => 
      nft.collection?.address.toString() === PANTHERS_COLLECTION
    );
    
    return panthersNFTs;
  }
}
```

---

### **2. On-Chain Ownership Sync (Cron Job)**

```typescript
// File: fund-manager/src/cron/ownership-sync.ts

class OwnershipSync {
  async syncAllNFTs() {
    console.log("🔄 Syncing NFT ownership from Solana...");
    
    // 1. Get all NFTs in Panthers collection
    const allNFTs = await this.metaplex.nfts().findAllByCollection({
      collection: new PublicKey(PANTHERS_COLLECTION)
    });
    
    console.log(`Found ${allNFTs.length} Panthers NFTs on-chain`);
    
    // 2. For each NFT, verify owner
    for (const nft of allNFTs) {
      const mintAddress = nft.address.toString();
      const currentOwner = nft.owner.address.toString();
      
      // 3. Check if owner changed
      const cached = await this.db.getNFTCache(mintAddress);
      
      if (cached && cached.currentOwner !== currentOwner) {
        console.log(`⚠️  Ownership change detected!`);
        console.log(`   NFT: ${mintAddress}`);
        console.log(`   Old owner: ${cached.currentOwner}`);
        console.log(`   New owner: ${currentOwner}`);
        
        // Ownership transferred (probably via Magic Eden)
        await this.handleOwnershipChange(mintAddress, currentOwner);
      }
      
      // 4. Update cache
      await this.db.updateNFTCache(mintAddress, {
        currentOwner: currentOwner,
        ownershipLastChecked: Date.now()
      });
    }
    
    // 5. Update total NFT count (source of truth!)
    await this.db.setFundState({
      totalNFTs: allNFTs.length,
      totalPoolValue: await this.calculatePoolValue(),
      lastSync: Date.now()
    });
    
    console.log("✅ Ownership sync complete");
  }
  
  async handleOwnershipChange(mintAddress: string, newOwner: string) {
    // Log the transfer
    await this.db.logOwnershipTransfer({
      mintAddress,
      newOwner,
      timestamp: Date.now(),
      source: 'ON_CHAIN_SYNC' // Detected via sync, not internal transfer
    });
    
    // Check if new owner has Telegram connection
    const connection = await this.db.getWalletConnection(newOwner);
    
    if (connection) {
      // Notify new owner
      await this.bot.sendMessage(
        connection.telegramUserId,
        `🎉 You now own a Panthers NFT!\n\n` +
        `NFT: ${mintAddress.substring(0, 8)}...\n` +
        `Current Value: $${await this.getNFTValue(mintAddress)}\n\n` +
        `Use /balance to see details.`
      );
    }
  }
}

// Run every 5 minutes
cron.schedule('*/5 * * * *', () => ownershipSync.syncAllNFTs());
```

---

### **3. Value Calculation (Based on On-Chain NFT Count)**

```typescript
// File: fund-manager/src/fund/value-calculator.ts

class ValueCalculator {
  async calculateNFTValue(mintAddress: string): Promise<number> {
    // 1. Get total pool value (USDC + open positions)
    const poolValue = await this.getPoolValue();
    
    // 2. Get total NFT count (from Solana, not DB!)
    const totalNFTs = await this.getTotalNFTCount();
    
    // 3. Get NFT's initial deposit (proportional share)
    const nftCache = await this.db.getNFTCache(mintAddress);
    const initialDeposit = nftCache.initialDeposit;
    
    // 4. Calculate proportional share
    const shareOfPool = initialDeposit / this.getTotalInitialDeposits();
    
    // 5. Calculate current value
    const currentValue = poolValue * shareOfPool;
    
    return currentValue;
  }
  
  async getTotalNFTCount(): Promise<number> {
    // Query Metaplex collection (SOURCE OF TRUTH!)
    const nfts = await this.metaplex.nfts().findAllByCollection({
      collection: new PublicKey(PANTHERS_COLLECTION)
    });
    
    return nfts.length;
  }
  
  async getPoolValue(): Promise<number> {
    // USDC balance
    const usdcBalance = await this.getUSDCBalance();
    
    // Open positions (SOL, BTC, ETH prices)
    const positions = await this.getOpenPositions();
    const positionValue = positions.reduce((sum, p) => sum + p.value, 0);
    
    return usdcBalance + positionValue;
  }
}
```

---

### **4. Minting (Direct to User Wallet)**

```typescript
// File: fund-manager/src/nft/minter.ts

class NFTMinter {
  async mintToUser(userWallet: string, depositAmount: number): Promise<string> {
    console.log(`Minting NFT for ${userWallet} (deposit: $${depositAmount})`);
    
    // 1. Generate NFT ID
    const nftId = await this.getNextNFTId();
    
    // 2. Upload metadata
    const metadata = {
      name: `Panthers Fund #${nftId}`,
      symbol: "PNTR",
      description: "Autonomous AI trading fund share",
      image: `https://panthers.fund/nft/${nftId}/image`,
      external_url: `https://panthers.fund/nft/${nftId}`,
      attributes: [
        { trait_type: "NFT ID", value: nftId.toString() },
        { trait_type: "Initial Deposit", value: depositAmount.toString() },
        { trait_type: "Minted Date", value: new Date().toISOString() },
      ],
      properties: {
        category: "investment",
        creators: [
          { address: AGENT_WALLET, verified: true, share: 100 }
        ]
      }
    };
    
    const { uri } = await this.metaplex.nfts().uploadMetadata(metadata);
    
    // 3. Mint compressed NFT DIRECTLY to user's wallet
    const { nft } = await this.metaplex.nfts().create({
      uri,
      name: metadata.name,
      symbol: metadata.symbol,
      sellerFeeBasisPoints: 200, // 2% royalty on secondary sales → fund
      collection: new PublicKey(PANTHERS_COLLECTION),
      // Mint to USER wallet (they own it immediately!)
      tokenOwner: new PublicKey(userWallet),
    });
    
    console.log(`✅ NFT minted: ${nft.address.toString()}`);
    
    // 4. Update DB cache
    await this.db.createNFTCache({
      mintAddress: nft.address.toString(),
      currentOwner: userWallet,
      initialDeposit: depositAmount,
      currentValue: depositAmount,
      mintedAt: Date.now(),
      ownershipLastChecked: Date.now()
    });
    
    // 5. Update fund state
    await this.updateFundState({
      totalNFTs: await this.getTotalNFTCount(),
      totalDeposits: await this.getTotalDeposits() + depositAmount,
    });
    
    return nft.address.toString();
  }
}
```

---

## 🎯 **KEY ADVANTAGES OF THIS APPROACH**

### **1. True Decentralization**
```
✅ Solana blockchain = source of truth
✅ No custodial wallet (users own NFTs)
✅ Can trade anywhere (Magic Eden, Tensor, etc.)
✅ Agent can't steal (NFTs in user wallets)
✅ Verifiable (check collection on Solscan)
```

### **2. Simplified Architecture**
```
✅ One chain (Solana only)
✅ No multi-chain complexity
✅ No bridging needed
✅ DB is just cache (can rebuild from chain)
```

### **3. Better UX**
```
✅ Buy NFT → Immediately tradeable
✅ Sell on Magic Eden → Instant fund access transfer
✅ No P2P marketplace needed (use existing DEXs)
✅ Standard NFT experience (familiar to users)
```

### **4. Trustless Transfers**
```
Alice sells NFT to Bob on Magic Eden:
├─ Magic Eden escrow (secure)
├─ On-chain atomic swap
├─ Bob automatically gets fund access
├─ Alice automatically loses access
└─ No agent involvement needed!
```

---

## 📊 **COMPARISON: Old vs New**

| Feature | Hybrid (Old) | Solana-Only (New) |
|---------|--------------|-------------------|
| **Source of truth** | DB | Solana ✅ |
| **User custody** | Agent (custodial) | User ✅ |
| **Trading venue** | Internal P2P | Magic Eden ✅ |
| **Chains** | SOL, ETH, Base, Secret | Solana only ✅ |
| **Trustless** | ⚠️ Trust agent | ✅ On-chain |
| **Complexity** | High | Low ✅ |

---

## 🚀 **IMPLEMENTATION PRIORITY**

### **Week 1: Core NFT System**
```typescript
✅ Compressed NFT minting
✅ Mint to user wallet (not agent)
✅ Metadata with dynamic values
✅ Collection creation
✅ DB cache structure
```

### **Week 2: Ownership Verification**
```typescript
✅ Wallet connection via Phantom
✅ NFT ownership scanning
✅ On-chain sync (cron job)
✅ /balance command
✅ Ownership change detection
```

### **Week 3: Trading Integration**
```typescript
✅ Fund value calculation (based on NFT count)
✅ P&L distribution
✅ Withdrawal (burn NFT)
✅ Magic Eden metadata
```

---

## ✅ **WHAT THIS SOLVES**

**Your Concerns:**
1. ✅ Secret Network wallet = bad UX
   → Solana wallet = standard (Phantom)

2. ✅ NFTs should be on-chain
   → Yes! Solana compressed NFTs

3. ✅ Source of truth
   → Solana blockchain (not DB)

4. ✅ Simplicity
   → Solana-only (no multi-chain)

---

**This is the cleanest, most decentralized architecture possible!** 🎯
