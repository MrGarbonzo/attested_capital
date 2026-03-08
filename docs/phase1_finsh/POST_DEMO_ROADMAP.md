# Post-Demo Roadmap - Production Features

**Current State:** Working demo with 3 critical fixes deployed
**Next Phase:** Production readiness + advanced features

---

## 📊 Your 10 Items - Organized by Phase

---

## 🚀 **PHASE 1: Critical for Demo** (Week 1-2)

### **#8: Test Multiple Guardians Running** ⚠️ CRITICAL

**Why Critical:** Single guardian = single point of failure

**What to Test:**
```
Deploy 3 guardians:
├─ Guardian-1 (67.43.239.6) - existing
├─ Guardian-2 (new VM) - infrastructure
└─ Guardian-3 (new VM) - sentry (NFT holder)

Verify:
├─ All 3 connect to agent ✓
├─ All 3 receive DB snapshots ✓
├─ Agent heartbeat goes to all ✓
├─ If 1 guardian dies, others continue ✓
└─ Agent can recover from any guardian ✓
```

**Implementation:**

```bash
# Deploy guardian-2
# 1. Provision SecretVM
# 2. Clone guardian-network repo
cd guardian-network
docker build -t guardian .

# 3. Configure .env
GUARDIAN_EXTERNAL_ENDPOINT=http://<guardian2-ip>:3100
SENTRY_MODE=false  # Infrastructure guardian

# 4. Start
docker run -p 3100:3100 guardian

# 5. Update agent's BOOTSTRAP_GUARDIANS
BOOTSTRAP_GUARDIANS=http://67.43.239.6:3100,http://<g2-ip>:3100,http://<g3-ip>:3100

# 6. Update agent's APPROVED_MEASUREMENTS (add guardian-2's MRTD)
APPROVED_MEASUREMENTS=<g1-mrtd>,<g2-mrtd>,<g3-mrtd>
```

**Test Scenarios:**
```
Scenario 1: Normal operation
├─ All 3 guardians online
├─ Agent sends DB sync → all 3 receive ✓
└─ Agent heartbeat → all 3 verify ✓

Scenario 2: One guardian dies
├─ Kill guardian-2
├─ Agent continues with guardian-1 and guardian-3 ✓
└─ DB sync still works (2/3 guardians) ✓

Scenario 3: Agent recovery
├─ Kill agent
├─ New agent starts
├─ Requests DB from guardians
├─ Gets snapshot from guardian-1 ✓
└─ Continues trading ✓
```

**Time:** 1 day (deploy + test)

---

### **#9: Prevent Duplicate Agents** ✅ ALREADY SOLVED!

**Good News:** We already designed this! Check `CORRECTED_AGENT_REGISTRATION.md`

**How it Works:**
```
Agent-1 boots:
├─ Generates session keypair (pubkey_A, privkey_A)
├─ Registers pubkey_A with guardians (75% vote)
├─ Contract stores: active_agent_pubkey = pubkey_A
└─ Starts trading

Attacker tries Agent-2:
├─ Generates different keypair (pubkey_B, privkey_B)
├─ Tries to register pubkey_B
├─ Guardian checks contract: "pubkey_A is active"
├─ Guardian: "You're not pubkey_A" ❌
└─ Rejected!
```

**What You Already Have:**
- ✅ Session keypair generation
- ✅ Guardian registration with vote
- ✅ Heartbeat system (5min timeout)

**What to Add:**
```typescript
// In guardian registration handler
async handleAgentRegistration(request: {
  sessionPublicKey: string;
  attestation: string;
}) {
  // 1. Check if another agent is active
  const currentAgent = await this.db.getActiveAgent();
  
  if (currentAgent && currentAgent.active) {
    const timeSinceHeartbeat = Date.now() - currentAgent.lastHeartbeat;
    
    if (timeSinceHeartbeat < 300000) { // 5 min
      console.log("❌ Another agent is active and healthy");
      return { approved: false, reason: "Active agent exists" };
    }
  }
  
  // 2. Verify attestation
  const verified = await this.verifyAttestation(request.attestation);
  if (!verified) {
    return { approved: false, reason: "Invalid attestation" };
  }
  
  // 3. Store new active agent
  await this.db.setActiveAgent({
    sessionPublicKey: request.sessionPublicKey,
    activatedAt: Date.now(),
    lastHeartbeat: Date.now(),
    active: true
  });
  
  return { approved: true };
}
```

**Test:**
```bash
# 1. Start agent-1
docker compose up panthers-agent

# 2. While agent-1 running, try to start agent-2 (clone)
# On different VM:
docker compose up panthers-agent

# Expected:
# Agent-1: "✅ Registered, trading"
# Agent-2: "❌ Registration rejected: Active agent exists"

# 3. Kill agent-1
docker compose down

# 4. Wait 5 minutes (heartbeat timeout)

# 5. Agent-2 retries registration
# Expected:
# Agent-2: "✅ Registration successful (takeover)"
```

**Time:** Already designed, just test it (2 hours)

---

### **#10: Agent Creates Telegram Bot Automatically** ✅ ALREADY DESIGNED!

**Good News:** We have this in `TELEGRAM_COORDINATION.md`!

**Current Issue:** You need human to:
1. Message @BotFather
2. Create bot
3. Get token
4. Create group
5. Invite guardians

**Solution:** Agent does it programmatically

**Implementation:**

```typescript
// File: fund-manager/src/telegram/auto-setup.ts

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

export class TelegramAutoSetup {
  private client: TelegramClient;
  
  async initialize() {
    console.log("🤖 Setting up Telegram infrastructure...");
    
    // 1. Create user bot client (uses your Telegram account)
    // Note: Requires one-time phone number verification
    this.client = new TelegramClient(
      new StringSession(process.env.TELEGRAM_SESSION || ''),
      parseInt(process.env.TELEGRAM_API_ID!),
      process.env.TELEGRAM_API_HASH!,
      { connectionRetries: 5 }
    );
    
    await this.client.start({
      phoneNumber: async () => process.env.TELEGRAM_PHONE!,
      password: async () => process.env.TELEGRAM_PASSWORD!,
      phoneCode: async () => {
        // For first-time setup, you'll need to provide code
        // After that, session is saved
        return await this.getCodeFromUser();
      },
      onError: (err) => console.error(err),
    });
    
    // 2. Create bot via BotFather
    const botToken = await this.createBot();
    
    // 3. Create private group
    const groupId = await this.createGroup(botToken);
    
    // 4. Invite yourself
    await this.inviteUser(groupId, process.env.YOUR_TELEGRAM_ID!);
    
    console.log("✅ Telegram infrastructure ready");
    console.log(`   Bot: @${this.botUsername}`);
    console.log(`   Group: ${groupId}`);
    
    return { botToken, groupId };
  }
  
  async createBot(): Promise<string> {
    console.log("Creating bot via BotFather...");
    
    // Get BotFather
    const botfather = await this.client.getEntity('@BotFather');
    
    // Start conversation
    await this.client.sendMessage(botfather, { message: '/newbot' });
    await this.sleep(1000);
    
    // Send bot name
    const botName = `Panthers Fund ${Date.now()}`;
    await this.client.sendMessage(botfather, { message: botName });
    await this.sleep(1000);
    
    // Send bot username (must be unique)
    const botUsername = `panthers_${this.generateId()}_bot`;
    await this.client.sendMessage(botfather, { message: botUsername });
    await this.sleep(2000);
    
    // Get token from BotFather's response
    const messages = await this.client.getMessages(botfather, { limit: 1 });
    const response = messages[0].message;
    
    const tokenMatch = response.match(/(\d+):[\w-]+/);
    if (!tokenMatch) {
      throw new Error('Failed to get bot token from BotFather');
    }
    
    const botToken = tokenMatch[0];
    this.botUsername = botUsername;
    
    console.log(`✅ Bot created: @${botUsername}`);
    return botToken;
  }
  
  async createGroup(botToken: string): Promise<number> {
    console.log("Creating private group...");
    
    const { Api } = await import('telegram');
    
    // Create group
    const result = await this.client.invoke(new Api.messages.CreateChat({
      title: 'Panthers Guardian Network',
      users: [] // Start empty
    }));
    
    const groupId = result.chats[0].id;
    
    // Add bot to group
    const bot = await this.client.getEntity(this.botUsername);
    await this.client.invoke(new Api.messages.AddChatUser({
      chatId: groupId,
      userId: bot,
      fwdLimit: 0
    }));
    
    // Make bot admin
    await this.client.invoke(new Api.messages.EditChatAdmin({
      chatId: groupId,
      userId: bot,
      isAdmin: true
    }));
    
    console.log(`✅ Group created: ${groupId}`);
    return groupId;
  }
  
  async inviteUser(groupId: number, userId: string) {
    console.log(`Inviting user ${userId} to group...`);
    
    const { Api } = await import('telegram');
    
    await this.client.invoke(new Api.messages.AddChatUser({
      chatId: groupId,
      userId: parseInt(userId),
      fwdLimit: 0
    }));
    
    console.log(`✅ User invited`);
  }
  
  private generateId(): string {
    return Math.random().toString(36).substring(2, 10);
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  private async getCodeFromUser(): Promise<string> {
    // In production, this could:
    // 1. Display QR code in logs
    // 2. Send notification to your phone
    // 3. Wait for you to enter code via Telegram
    
    // For first-time setup, you'll manually provide code
    console.log("📱 Check Telegram for verification code");
    return process.env.TELEGRAM_VERIFICATION_CODE!;
  }
}
```

**Setup Process:**

```bash
# First-time only (save session):
TELEGRAM_API_ID=<your-api-id>
TELEGRAM_API_HASH=<your-api-hash>
TELEGRAM_PHONE=+1234567890
TELEGRAM_VERIFICATION_CODE=12345  # You'll get this on first run

# Agent creates bot + group automatically
# Stores bot token and group ID in /data/telegram-config.json

# Future deployments:
# Agent loads saved config, no human intervention needed
```

**Benefits:**
- ✅ Fully automated (after first setup)
- ✅ Agent owns its own identity
- ✅ Reproducible deployments
- ✅ No manual steps

**Time:** 1 day to implement + test

---

## 🎯 **PHASE 2: Core Features** (Week 3-4)

### **#1: Dynamic NFT Sales** 

**Current State:** You have sales tools, need to test pricing logic

**What to Implement:**

```typescript
// Dynamic pricing algorithm
class NFTPricing {
  calculatePrice(nftId: number): number {
    const basePrice = 100; // $100 base
    
    // Factor 1: Demand (how many sold recently)
    const recentSales = this.getRecentSales('24h');
    const demandMultiplier = 1 + (recentSales.length * 0.05); // +5% per sale
    
    // Factor 2: Fund performance
    const fundReturn = this.getFundReturn('7d');
    const performanceMultiplier = 1 + (fundReturn * 0.5); // +50% of fund gains
    
    // Factor 3: Velocity (how fast they're selling)
    const velocity = recentSales.length / 24; // sales per hour
    const velocityMultiplier = velocity > 1 ? 1.1 : 1.0; // +10% if hot
    
    // Final price
    const price = basePrice * 
                  demandMultiplier * 
                  performanceMultiplier * 
                  velocityMultiplier;
    
    return Math.round(price * 100) / 100; // Round to cents
  }
}
```

**Sales Mechanisms to Test:**

**1. Dynamic Pricing:**
```
Time 0:  Base price $100
Sale 1:  $100 (demand low)
Sale 2:  $105 (demand +5%)
Sale 3:  $110 (demand +10%)
Fund +10% return
Sale 4:  $126 ($110 * 1.05 demand * 1.10 performance)
```

**2. Flash Auction:**
```
Agent: "⚡ Flash Auction! Panther #123 - 30 minutes only!"
Starting bid: $80 (20% discount)
User A: $85
User B: $90
User C: $95
Timer expires → User C wins at $95
```

**3. DM Negotiations:**
```
User: "I want to buy an NFT"
Agent: "Current price: $120"
User: "Too expensive, I'll pay $100"
Agent: "Counter-offer: $110 (10% discount, one-time offer)"
User: "Deal!"
Agent: Mints NFT #456 for $110
```

**4. Gumball:**
```
Agent: "🎰 Mystery NFT! $80 flat price, random value!"
User pays $80
Agent: Randomly assigns NFT #789 (current value: $95)
User: Got lucky! (+$15)
```

**Test Plan:**
```bash
# 1. Test dynamic pricing
# Create 10 test users
# Buy NFTs sequentially
# Verify price increases with demand

# 2. Test flash auction
# Start auction via agent tool
# Submit bids from multiple users
# Verify highest bidder wins

# 3. Test negotiations
# DM agent with offer
# Verify counter-offers
# Test acceptance/rejection

# 4. Test gumball
# Buy mystery NFT
# Verify random assignment
# Check value distribution
```

**Time:** 2-3 days

---

### **#4: P2P NFT Escrow**

**Current State:** You have P2P tools, need escrow mechanism

**Implementation:**

```typescript
class P2PEscrow {
  async listNFT(userId: number, nftId: number, price: number) {
    // Verify ownership
    const nft = await this.db.getNFT(nftId);
    if (nft.ownerId !== userId) {
      throw new Error('You don't own this NFT');
    }
    
    // Lock NFT in escrow
    await this.db.updateNFT(nftId, {
      status: 'ESCROWED',
      listPrice: price,
      listedAt: Date.now()
    });
    
    console.log(`NFT #${nftId} locked in escrow at $${price}`);
  }
  
  async buyNFT(buyerId: number, nftId: number) {
    const nft = await this.db.getNFT(nftId);
    
    if (nft.status !== 'ESCROWED') {
      throw new Error('NFT not for sale');
    }
    
    // 1. Buyer pays agent
    await this.recordPayment(buyerId, nft.listPrice);
    
    // 2. Agent transfers NFT ownership
    await this.db.updateNFT(nftId, {
      ownerId: buyerId,
      status: 'ACTIVE',
      listPrice: null,
      listedAt: null
    });
    
    // 3. Agent pays seller
    await this.recordPayout(nft.ownerId, nft.listPrice);
    
    // 4. Update Telegram IDs (buyer gets seller's chat access)
    await this.updateTelegramMapping(nftId, buyerId);
    
    console.log(`Escrow complete: NFT #${nftId} → User ${buyerId}`);
  }
  
  async cancelListing(userId: number, nftId: number) {
    const nft = await this.db.getNFT(nftId);
    
    if (nft.ownerId !== userId) {
      throw new Error('Not your NFT');
    }
    
    // Unlock from escrow
    await this.db.updateNFT(nftId, {
      status: 'ACTIVE',
      listPrice: null,
      listedAt: null
    });
  }
}
```

**Security:**
```
Agent = Trusted Escrow (runs in TEE)

Seller lists NFT:
├─ NFT locked (can't withdraw while listed)
├─ Price recorded
└─ Visible to buyers

Buyer purchases:
├─ Payment to agent ✓
├─ Agent holds both (NFT + payment) ✓
├─ Atomic swap ✓
│  ├─ Transfer NFT ownership to buyer
│  └─ Transfer payment to seller
└─ 0% fee (as designed)

If buyer doesn't pay:
└─ NFT remains with seller (no transfer)

If seller cancels:
└─ NFT unlocked, back to active
```

**Test:**
```
Alice lists Panther #5 for $150
Bob buys it for $150
Agent transfers:
  ├─ Ownership: Alice → Bob ✓
  ├─ Payment: Bob → Alice ✓
  └─ Telegram access: Bob can now use /balance ✓
```

**Time:** 1-2 days

---

### **#6: Portfolio Allocation Guidelines**

**Question:** "What % should be traded? What % in each asset?"

**Implementation:**

```typescript
interface PortfolioGuidelines {
  maxTradingAllocation: number;    // e.g., 80% (keep 20% in stables)
  minCashReserve: number;           // e.g., 20% (for withdrawals)
  maxAssetAllocation: {
    SOL: number;   // e.g., 40%
    ETH: number;   // e.g., 30%
    BTC: number;   // e.g., 20%
    USDC: number;  // e.g., 10%
  };
  rebalanceThreshold: number;       // e.g., 5% deviation triggers rebalance
}

class PortfolioManager {
  private guidelines: PortfolioGuidelines = {
    maxTradingAllocation: 0.80,    // Trade max 80% of pool
    minCashReserve: 0.20,           // Keep 20% in USDC (for exits)
    maxAssetAllocation: {
      SOL: 0.40,
      ETH: 0.30,
      BTC: 0.20,
      USDC: 0.10
    },
    rebalanceThreshold: 0.05
  };
  
  async checkAllocationLimits(proposedTrade: Trade): Promise<boolean> {
    const portfolio = await this.getCurrentPortfolio();
    
    // Check 1: Do we have enough cash reserve?
    const afterTrade = this.simulateTrade(portfolio, proposedTrade);
    const cashPercent = afterTrade.USDC / afterTrade.total;
    
    if (cashPercent < this.guidelines.minCashReserve) {
      console.log(`❌ Trade blocked: Cash reserve would drop to ${cashPercent * 100}% (min: 20%)`);
      return false;
    }
    
    // Check 2: Would this exceed max asset allocation?
    const assetPercent = afterTrade[proposedTrade.asset] / afterTrade.total;
    const maxAllowed = this.guidelines.maxAssetAllocation[proposedTrade.asset];
    
    if (assetPercent > maxAllowed) {
      console.log(`❌ Trade blocked: ${proposedTrade.asset} would be ${assetPercent * 100}% (max: ${maxAllowed * 100}%)`);
      return false;
    }
    
    // Check 3: Are we trading too much of the pool?
    const tradingPercent = proposedTrade.amount / portfolio.total;
    if (tradingPercent > this.guidelines.maxTradingAllocation) {
      console.log(`❌ Trade blocked: Would trade ${tradingPercent * 100}% of pool (max: 80%)`);
      return false;
    }
    
    console.log(`✅ Trade approved: Within allocation limits`);
    return true;
  }
  
  async shouldRebalance(): Promise<boolean> {
    const portfolio = await this.getCurrentPortfolio();
    const target = this.guidelines.maxAssetAllocation;
    
    for (const [asset, current] of Object.entries(portfolio.allocation)) {
      const targetPercent = target[asset];
      const deviation = Math.abs(current - targetPercent);
      
      if (deviation > this.guidelines.rebalanceThreshold) {
        console.log(`⚠️  Rebalance needed: ${asset} is ${current * 100}% (target: ${targetPercent * 100}%)`);
        return true;
      }
    }
    
    return false;
  }
}
```

**Example:**

```
Pool: $10,000
Guidelines:
├─ Max 80% trading ($8,000)
├─ Min 20% cash ($2,000)
└─ Max per asset:
   ├─ SOL: 40% ($4,000)
   ├─ ETH: 30% ($3,000)
   ├─ BTC: 20% ($2,000)
   └─ USDC: 10% ($1,000)

Proposed Trade: Buy $5,000 SOL
Check 1: Cash reserve after = $5,000 (50%) ✓
Check 2: SOL after = $5,000 (50%) ❌ Exceeds 40% max
Result: BLOCKED

Adjusted: Buy $3,000 SOL
Check 1: Cash reserve = $7,000 (70%) ✓
Check 2: SOL after = $3,000 (30%) ✓ Within 40% max
Result: APPROVED
```

**Time:** 1-2 days

---

## 🌐 **PHASE 3: Multi-Chain** (Week 5-6)

### **#5: Another Chain + Bridge**

**Current:** You have 4 wallets (SOL, ETH, Base, Secret)

**Add:** Arbitrum or Polygon + bridging

**Implementation:**

```typescript
// 1. Add Arbitrum wallet generation
async generateWallets(mnemonic: string) {
  const wallets = {
    solana: deriveSolanaWallet(mnemonic, 0),
    ethereum: deriveEthWallet(mnemonic, 0),
    base: deriveEthWallet(mnemonic, 1),     // Base uses EVM
    arbitrum: deriveEthWallet(mnemonic, 2), // ← NEW
    secret: deriveSecretWallet(mnemonic, 0)
  };
  
  return wallets;
}

// 2. Bridge manager
class CrossChainBridge {
  async bridgeUSDC(fromChain: string, toChain: string, amount: number) {
    console.log(`Bridging $${amount} USDC: ${fromChain} → ${toChain}`);
    
    // Use Circle's CCTP (native USDC bridge)
    if (this.isCCTPSupported(fromChain, toChain)) {
      return await this.bridgeViaCCTP(fromChain, toChain, amount);
    }
    
    // Fall back to Wormhole
    return await this.bridgeViaWormhole(fromChain, toChain, amount);
  }
  
  async bridgeViaCCTP(from: string, to: string, amount: number) {
    // Circle's Cross-Chain Transfer Protocol
    // Burn USDC on source chain
    const burnTx = await this.burnUSDC(from, amount);
    
    // Wait for attestation
    const attestation = await this.waitForAttestation(burnTx);
    
    // Mint USDC on destination chain
    const mintTx = await this.mintUSDC(to, amount, attestation);
    
    console.log(`✅ Bridged via CCTP: ${mintTx}`);
    return mintTx;
  }
}
```

**Supported Bridges:**
```
USDC (Circle CCTP):
├─ Ethereum ↔ Arbitrum
├─ Ethereum ↔ Base
├─ Arbitrum ↔ Base
└─ Solana ↔ Ethereum (via Wormhole + CCTP)

ETH/SOL (Wormhole):
├─ Solana ↔ Ethereum
└─ Any EVM ↔ Any EVM
```

**Use Case:**
```
Scenario: Arbitrage Opportunity

1. Detect: ETH cheaper on Arbitrum than Ethereum
2. Bridge: $1000 USDC from Ethereum → Arbitrum
3. Buy: ETH on Arbitrum at $2900
4. Bridge: ETH from Arbitrum → Ethereum
5. Sell: ETH on Ethereum at $3000
6. Profit: $100 (minus bridge fees ~$20) = $80 net
```

**Time:** 3-4 days

---

## 🔧 **PHASE 4: Advanced Features** (Month 2)

### **#2: Agent-Owned X (Twitter) Account**

**Goal:** Agent markets itself on X

**Implementation:**

```typescript
import { TwitterApi } from 'twitter-api-v2';

class XMarketing {
  private client: TwitterApi;
  
  async initialize() {
    // Use Twitter API v2
    this.client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY!,
      appSecret: process.env.TWITTER_API_SECRET!,
      accessToken: process.env.TWITTER_ACCESS_TOKEN!,
      accessSecret: process.env.TWITTER_ACCESS_SECRET!,
    });
  }
  
  async postDailyUpdate() {
    const stats = await this.getFundStats();
    
    const tweet = `
🐆 Panthers Fund - Daily Update

Pool: $${stats.poolBalance.toLocaleString()}
NFTs: ${stats.nftCount}
24h Return: ${stats.return24h > 0 ? '+' : ''}${stats.return24h.toFixed(2)}%
Total Trades: ${stats.totalTrades}

Strategy: ${stats.currentStrategy}
Next trade: ${this.getTimeUntilNextTrade()}

Join: t.me/${this.botUsername}
    `.trim();
    
    await this.client.v2.tweet(tweet);
    console.log("✅ Posted daily update to X");
  }
  
  async postTradeAnnouncement(trade: Trade) {
    const tweet = `
⚡ Trade Executed

${trade.side === 'BUY' ? '📈' : '📉'} ${trade.side} ${trade.asset}
Amount: $${trade.amount.toLocaleString()}
Price: $${trade.price.toFixed(2)}
P&L: ${trade.pnl > 0 ? '+' : ''}$${trade.pnl.toFixed(2)}

Strategy: ${trade.strategy}
Attestation: ${trade.attestationHash.substring(0, 16)}...

#DeFi #AutonomousTrading #TEE
    `.trim();
    
    await this.client.v2.tweet(tweet);
  }
  
  async respondToMentions() {
    // Monitor @panthers_fund mentions
    const mentions = await this.client.v2.userMentionTimeline(this.userId, {
      max_results: 10
    });
    
    for (const mention of mentions.data) {
      if (mention.text.includes('stats')) {
        await this.replyWithStats(mention.id);
      } else if (mention.text.includes('how to join')) {
        await this.replyWithInstructions(mention.id);
      }
      // Could use LLM here too!
    }
  }
}
```

**Automated Posts:**
```
Daily 9am: Fund stats
After each trade: Trade announcement
Weekly: Performance summary
Monthly: Top holder leaderboard
On mentions: Auto-reply (LLM-powered)
```

**Time:** 2-3 days

---

### **#3: NFT Viewing System**

**Goal:** Users can see their NFTs visually

**Options:**

**Option A: Telegram Mini App**
```typescript
// Embedded web view in Telegram
bot.command('view', async (ctx) => {
  const userId = ctx.from.id;
  
  // Generate temporary view URL
  const token = await this.generateViewToken(userId);
  const url = `https://panthers.fund/nft/${token}`;
  
  await ctx.reply(
    'View your NFT:',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🖼️ View NFT', web_app: { url } }
        ]]
      }
    }
  );
});
```

**Option B: Generate Image On-Demand**
```typescript
import { createCanvas } from 'canvas';

async function generateNFTImage(nft: NFT): Promise<Buffer> {
  const canvas = createCanvas(800, 600);
  const ctx = canvas.getContext('2d');
  
  // Background
  const gradient = ctx.createLinearGradient(0, 0, 800, 600);
  gradient.addColorStop(0, '#028090');
  gradient.addColorStop(1, '#02C39A');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 800, 600);
  
  // Panther image
  const panther = await loadImage('./assets/panther.png');
  ctx.drawImage(panther, 50, 50, 300, 300);
  
  // NFT Details
  ctx.fillStyle = 'white';
  ctx.font = 'bold 48px Arial';
  ctx.fillText(`Panther #${nft.id}`, 400, 100);
  
  ctx.font = '32px Arial';
  ctx.fillText(`Value: $${nft.value.toFixed(2)}`, 400, 160);
  ctx.fillText(`Return: ${((nft.value / nft.initialDeposit - 1) * 100).toFixed(2)}%`, 400, 200);
  
  // Traits
  ctx.font = '24px Arial';
  ctx.fillText(`🎯 Strategy: ${nft.preferredStrategy || 'Auto'}`, 400, 280);
  ctx.fillText(`📅 Minted: ${new Date(nft.mintedAt).toLocaleDateString()}`, 400, 320);
  ctx.fillText(`💎 Rarity: ${nft.rarity}`, 400, 360);
  
  return canvas.toBuffer('image/png');
}

// Usage
bot.command('nft', async (ctx) => {
  const nft = await db.getNFT(ctx.from.id);
  const image = await generateNFTImage(nft);
  
  await ctx.replyWithPhoto({ source: image }, {
    caption: `Your Panther #${nft.id} 🐆`
  });
});
```

**Option C: On-Chain Metadata (Solana NFT)**
```typescript
// Mint actual Solana NFT with metadata
import { Metaplex } from '@metaplex-foundation/js';

async function mintSolanaNFT(nft: NFT) {
  const metaplex = new Metaplex(connection);
  
  const { nft: mintedNFT } = await metaplex.nfts().create({
    uri: `https://panthers.fund/metadata/${nft.id}`,
    name: `Panther #${nft.id}`,
    sellerFeeBasisPoints: 200, // 2% royalty
    symbol: 'PNTR',
    creators: [
      {
        address: agentWallet.publicKey,
        share: 100
      }
    ],
    collection: panthersCollection,
  });
  
  return mintedNFT;
}
```

**Time:** 2-3 days (depends on approach)

---

### **#7: Test API Updates from Guardian → Agent**

**Scenario:** Jupiter API changes, guardian notifies agent

**Implementation:**

```typescript
// Guardian monitors API changes
class APIMonitor {
  async checkJupiterAPI() {
    try {
      const response = await fetch('https://quote-api.jup.ag/v6/quote?...');
      const schema = this.extractSchema(response);
      
      if (!this.matchesExpectedSchema(schema)) {
        console.warn("⚠️  Jupiter API schema changed!");
        await this.notifyAgent({
          type: 'API_CHANGE',
          api: 'Jupiter',
          changes: this.detectChanges(schema),
          severity: 'HIGH'
        });
      }
    } catch (error) {
      console.error("Jupiter API unreachable");
      await this.notifyAgent({
        type: 'API_DOWN',
        api: 'Jupiter',
        error: error.message,
        severity: 'CRITICAL'
      });
    }
  }
  
  async notifyAgent(alert: APIAlert) {
    // Send via Telegram
    await this.bot.sendMessage(this.agentChatId, {
      type: 'ALERT',
      ...alert,
      timestamp: Date.now()
    });
  }
}

// Agent receives and handles
class FundManager {
  async handleGuardianAlert(alert: APIAlert) {
    if (alert.type === 'API_DOWN') {
      // Pause trading until fixed
      await this.pauseTrading(`API down: ${alert.api}`);
      
      // Notify users
      await this.broadcastToUsers(
        `⚠️ Trading paused: ${alert.api} is unavailable. ` +
        `Will resume automatically when recovered.`
      );
    }
    
    if (alert.type === 'API_CHANGE') {
      // Log for investigation
      console.error(`API schema changed: ${alert.api}`);
      console.error(JSON.stringify(alert.changes, null, 2));
      
      // Could auto-update adapter here
      // Or wait for human review
    }
  }
}
```

**Test:**
```bash
# 1. Guardian detects Jupiter API down
# 2. Guardian sends alert to agent
# 3. Agent pauses trading ✓
# 4. Agent notifies users ✓
# 5. Jupiter recovers
# 6. Guardian sends recovery alert
# 7. Agent resumes trading ✓
```

**Time:** 1 day

---

## 📅 **Recommended Timeline**

```
WEEK 1-2 (Critical Demo Features):
├─ Fix #1: Vault key persistence
├─ Fix #2: LLM resilience (SecretAI-only)
├─ Fix #3: APPROVED_MEASUREMENTS
├─ Item #8: Deploy 3 guardians
├─ Item #9: Test duplicate agent prevention
└─ Item #10: Telegram auto-setup

WEEK 3-4 (Core Features):
├─ Item #1: Dynamic NFT sales (all 4 mechanisms)
├─ Item #4: P2P escrow testing
└─ Item #6: Portfolio allocation rules

WEEK 5-6 (Multi-Chain):
└─ Item #5: Add Arbitrum + bridging

MONTH 2 (Advanced):
├─ Item #2: X (Twitter) marketing
├─ Item #3: NFT viewing system
└─ Item #7: API update monitoring
```

---

## ✅ **Already Solved:**

- ✅ **#9: Duplicate agents** → Check CORRECTED_AGENT_REGISTRATION.md
- ✅ **#10: Telegram auto-setup** → Check TELEGRAM_COORDINATION.md

---

**You have a clear 2-month roadmap to full production!** 🚀
