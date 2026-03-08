# NFT STAKING SYSTEM - IMPLEMENTATION PLAN

## OVERVIEW

Build a weighted voting governance system where NFT holders can stake their NFTs with sentries to delegate voting power. Sentries vote on governance proposals with voting weight proportional to the total dollar value of NFTs staked to them.

**Technology Stack:**
- Agent Database: PostgreSQL (or current DB used by agent)
- Language: TypeScript/Node.js (matching existing agent codebase)
- No on-chain contracts needed (all DB-based tracking)

---

## 1. DATABASE SCHEMA

### **1.1 New Tables**

```sql
-- Tracks NFT staking state
CREATE TABLE nft_stakes (
    id SERIAL PRIMARY KEY,
    nft_id VARCHAR(255) NOT NULL UNIQUE,
    owner_wallet VARCHAR(255) NOT NULL,
    nft_value_usd DECIMAL(18, 2) NOT NULL,
    staked_with_sentry VARCHAR(255),  -- NULL if not staked
    staked_at TIMESTAMP,
    last_restake_at TIMESTAMP,
    unstaked_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Tracks sentries (guardians with governance rights)
CREATE TABLE sentries (
    id SERIAL PRIMARY KEY,
    sentry_id VARCHAR(255) NOT NULL UNIQUE,
    telegram_user_id VARCHAR(255) NOT NULL,
    public_key VARCHAR(512) NOT NULL,
    code_hash VARCHAR(128) NOT NULL,  -- From attestation
    attestation_verified BOOLEAN DEFAULT FALSE,
    joined_at TIMESTAMP DEFAULT NOW(),
    last_heartbeat TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- Tracks governance proposals
CREATE TABLE governance_proposals (
    id SERIAL PRIMARY KEY,
    proposal_id VARCHAR(255) NOT NULL UNIQUE,
    proposer_sentry_id VARCHAR(255) NOT NULL REFERENCES sentries(sentry_id),
    proposal_type VARCHAR(50) NOT NULL,  -- 'config_update', 'strategy_change', 'risk_param'
    proposal_data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    voting_starts_at TIMESTAMP NOT NULL,
    voting_ends_at TIMESTAMP NOT NULL,
    status VARCHAR(50) DEFAULT 'active',  -- 'active', 'passed', 'rejected', 'executed'
    total_staked_value DECIMAL(18, 2),  -- Snapshot at proposal time
    executed_at TIMESTAMP
);

-- Tracks individual sentry votes
CREATE TABLE sentry_votes (
    id SERIAL PRIMARY KEY,
    proposal_id VARCHAR(255) NOT NULL REFERENCES governance_proposals(proposal_id),
    sentry_id VARCHAR(255) NOT NULL REFERENCES sentries(sentry_id),
    vote VARCHAR(10) NOT NULL,  -- 'yes', 'no'
    voting_weight DECIMAL(18, 2) NOT NULL,  -- $ value staked to this sentry at vote time
    signature VARCHAR(512) NOT NULL,  -- Cryptographic signature
    voted_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(proposal_id, sentry_id)
);

-- Indexes for performance
CREATE INDEX idx_nft_stakes_owner ON nft_stakes(owner_wallet);
CREATE INDEX idx_nft_stakes_sentry ON nft_stakes(staked_with_sentry);
CREATE INDEX idx_proposals_status ON governance_proposals(status);
CREATE INDEX idx_votes_proposal ON sentry_votes(proposal_id);
```

### **1.2 Modify Existing Tables (if needed)**

```sql
-- If NFT table doesn't track value, add it
ALTER TABLE nfts ADD COLUMN current_value_usd DECIMAL(18, 2);
ALTER TABLE nfts ADD COLUMN last_value_update TIMESTAMP;
```

---

## 2. CORE BUSINESS LOGIC

### **2.1 Staking Manager Module**

**File:** `src/governance/StakingManager.ts`

```typescript
export class StakingManager {
  
  // Stake NFT with a sentry
  async stakeNFT(params: {
    nftId: string;
    ownerWallet: string;
    sentryId: string;
  }): Promise<StakeResult>;
  
  // Move stake from one sentry to another
  async restakeNFT(params: {
    nftId: string;
    ownerWallet: string;
    newSentryId: string;
  }): Promise<StakeResult>;
  
  // Unstake NFT (remove from sentry, start withdraw cooldown)
  async unstakeNFT(params: {
    nftId: string;
    ownerWallet: string;
  }): Promise<UnstakeResult>;
  
  // Check if can perform action
  async canStake(nftId: string): Promise<ValidationResult>;
  async canRestake(nftId: string): Promise<ValidationResult>;
  async canUnstake(nftId: string): Promise<ValidationResult>;
  async canWithdraw(nftId: string): Promise<ValidationResult>;
  
  // Get staking info
  async getStakeInfo(nftId: string): Promise<StakeInfo>;
  async getSentryVotingWeight(sentryId: string): Promise<number>;
  async getTotalStakedValue(): Promise<number>;
}
```

### **2.2 Validation Rules**

**File:** `src/governance/StakingValidator.ts`

```typescript
export class StakingValidator {
  
  // RULE 1: Vote Lock (24 hours)
  async isVoteActive(): Promise<boolean> {
    const activeProposal = await db.query(`
      SELECT * FROM governance_proposals
      WHERE status = 'active'
      AND NOW() BETWEEN voting_starts_at AND voting_ends_at
      LIMIT 1
    `);
    return activeProposal.rows.length > 0;
  }
  
  // RULE 2: Withdraw Cooldown (48 hours)
  async canWithdrawFunds(nftId: string): Promise<boolean> {
    const stake = await this.getStake(nftId);
    
    if (!stake.unstaked_at) return false; // Still staked
    
    const fortyEightHours = 48 * 60 * 60 * 1000;
    const elapsed = Date.now() - new Date(stake.unstaked_at).getTime();
    
    return elapsed >= fortyEightHours;
  }
  
  // RULE 3: Restake Limit (7 days)
  async canMoveStake(nftId: string): Promise<boolean> {
    // Check vote lock
    if (await this.isVoteActive()) {
      return false; // Can't move during vote
    }
    
    const stake = await this.getStake(nftId);
    
    if (!stake.last_restake_at) return true; // First time, allowed
    
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const elapsed = Date.now() - new Date(stake.last_restake_at).getTime();
    
    return elapsed >= sevenDays;
  }
  
  async validateStakeAction(
    action: 'stake' | 'restake' | 'unstake',
    nftId: string,
    ownerWallet: string
  ): Promise<ValidationResult> {
    // Verify NFT ownership on-chain
    const actualOwner = await this.verifyNFTOwnership(nftId);
    if (actualOwner !== ownerWallet) {
      return { valid: false, reason: 'NFT_NOT_OWNED' };
    }
    
    // Check vote lock
    if (await this.isVoteActive()) {
      return { valid: false, reason: 'VOTE_ACTIVE' };
    }
    
    // Action-specific validation
    if (action === 'restake') {
      if (!(await this.canMoveStake(nftId))) {
        return { valid: false, reason: 'RESTAKE_COOLDOWN' };
      }
    }
    
    return { valid: true };
  }
}
```

### **2.3 Governance Manager Module**

**File:** `src/governance/GovernanceManager.ts`

```typescript
export class GovernanceManager {
  
  // Create new proposal
  async createProposal(params: {
    proposerSentryId: string;
    proposalType: string;
    proposalData: any;
  }): Promise<Proposal>;
  
  // Sentry votes on proposal
  async castVote(params: {
    proposalId: string;
    sentryId: string;
    vote: 'yes' | 'no';
    signature: string;
  }): Promise<VoteResult>;
  
  // Calculate voting results
  async tallyVotes(proposalId: string): Promise<TallyResult>;
  
  // Execute proposal if passed
  async executeProposal(proposalId: string): Promise<ExecutionResult>;
  
  // Check if proposal passed (75% threshold)
  async hasProposalPassed(proposalId: string): Promise<boolean>;
}
```

---

## 3. API ENDPOINTS

### **3.1 Staking Endpoints**

**File:** `src/api/routes/staking.ts`

```typescript
// Stake NFT with a sentry
POST /api/staking/stake
Body: {
  nftId: string;
  sentryId: string;
}
Headers: {
  Authorization: Bearer <user_jwt>
}

// Move stake to different sentry
POST /api/staking/restake
Body: {
  nftId: string;
  newSentryId: string;
}

// Unstake NFT (start withdraw cooldown)
POST /api/staking/unstake
Body: {
  nftId: string;
}

// Get staking info for NFT
GET /api/staking/:nftId

// Get all stakes for user wallet
GET /api/staking/user/:walletAddress

// Get voting weight for sentry
GET /api/staking/sentry/:sentryId/weight
```

### **3.2 Governance Endpoints**

**File:** `src/api/routes/governance.ts`

```typescript
// Create governance proposal (sentry only)
POST /api/governance/propose
Body: {
  proposalType: string;
  proposalData: object;
}
Headers: {
  X-Sentry-Signature: <signed_message>
}

// Vote on proposal (sentry only)
POST /api/governance/vote
Body: {
  proposalId: string;
  vote: 'yes' | 'no';
}
Headers: {
  X-Sentry-Signature: <signed_message>
}

// Get active proposals
GET /api/governance/proposals/active

// Get proposal details
GET /api/governance/proposals/:proposalId

// Get voting results
GET /api/governance/proposals/:proposalId/results
```

### **3.3 Sentry Management Endpoints**

**File:** `src/api/routes/sentries.ts`

```typescript
// Register new sentry (permissionless)
POST /api/sentries/register
Body: {
  telegramUserId: string;
  publicKey: string;
  attestation: {
    codeHash: string;
    quote: string;
  }
}

// Get all active sentries
GET /api/sentries

// Get sentry details
GET /api/sentries/:sentryId

// Heartbeat (sentry pings every 60 seconds)
POST /api/sentries/:sentryId/heartbeat
Headers: {
  X-Sentry-Signature: <signed_message>
}
```

---

## 4. IMPLEMENTATION STEPS

### **Phase 1: Database Setup (Week 1)**

**Tasks:**
1. Create migration files for new tables
2. Add indexes for performance
3. Write seed data for testing
4. Test migrations on dev database

**Deliverables:**
- `migrations/001_create_staking_tables.sql`
- `migrations/002_create_governance_tables.sql`
- `seeds/test_sentries.sql`

---

### **Phase 2: Core Validation Logic (Week 1-2)**

**Tasks:**
1. Implement `StakingValidator.ts`
   - Vote lock check
   - Withdraw cooldown check
   - Restake limit check
   - NFT ownership verification
2. Write unit tests for all validation rules
3. Test edge cases (vote during unstake, etc.)

**Deliverables:**
- `src/governance/StakingValidator.ts`
- `tests/unit/StakingValidator.test.ts`

**Test Cases:**
```typescript
describe('StakingValidator', () => {
  test('prevents unstaking during active vote', async () => {
    // Setup: Create active vote
    // Action: Try to unstake
    // Assert: Returns validation error
  });
  
  test('allows restaking after 7 days', async () => {
    // Setup: Stake on Day 1
    // Action: Try to restake on Day 8
    // Assert: Validation passes
  });
  
  test('prevents withdrawal before 48hr cooldown', async () => {
    // Setup: Unstake NFT
    // Action: Try to withdraw after 24hrs
    // Assert: Returns validation error
  });
  
  test('allows withdrawal after 48hr cooldown', async () => {
    // Setup: Unstake NFT, wait 48hrs
    // Action: Try to withdraw
    // Assert: Validation passes
  });
});
```

---

### **Phase 3: Staking Manager (Week 2)**

**Tasks:**
1. Implement `StakingManager.ts`
   - `stakeNFT()` - Initial staking
   - `restakeNFT()` - Move to different sentry
   - `unstakeNFT()` - Remove stake
   - `getSentryVotingWeight()` - Calculate voting power
2. Integrate with validator
3. Add transaction support (atomic updates)
4. Write integration tests

**Deliverables:**
- `src/governance/StakingManager.ts`
- `tests/integration/StakingManager.test.ts`

**Key Functions:**

```typescript
async stakeNFT(params: StakeParams): Promise<StakeResult> {
  // 1. Validate can stake
  const validation = await validator.validateStakeAction('stake', params.nftId, params.ownerWallet);
  if (!validation.valid) throw new Error(validation.reason);
  
  // 2. Get NFT value from Solana
  const nftValue = await this.getNFTValue(params.nftId);
  
  // 3. Begin transaction
  const client = await db.getClient();
  await client.query('BEGIN');
  
  try {
    // 4. Insert or update stake record
    await client.query(`
      INSERT INTO nft_stakes (nft_id, owner_wallet, nft_value_usd, staked_with_sentry, staked_at, last_restake_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (nft_id) UPDATE SET
        staked_with_sentry = $4,
        staked_at = NOW(),
        last_restake_at = NOW(),
        unstaked_at = NULL,
        updated_at = NOW()
    `, [params.nftId, params.ownerWallet, nftValue, params.sentryId]);
    
    // 5. Update sentry's total voting weight (cached for performance)
    await this.updateSentryVotingWeight(params.sentryId);
    
    await client.query('COMMIT');
    
    return { success: true, nftId: params.nftId, sentryId: params.sentryId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

---

### **Phase 4: Governance Manager (Week 3)**

**Tasks:**
1. Implement `GovernanceManager.ts`
   - `createProposal()` - Create new vote
   - `castVote()` - Sentry votes
   - `tallyVotes()` - Count results
   - `executeProposal()` - Apply config if passed
2. Add vote locking mechanism
3. Implement signature verification
4. Write integration tests

**Deliverables:**
- `src/governance/GovernanceManager.ts`
- `tests/integration/GovernanceManager.test.ts`

**Key Functions:**

```typescript
async createProposal(params: CreateProposalParams): Promise<Proposal> {
  // 1. Verify proposer is active sentry
  const sentry = await this.getSentry(params.proposerSentryId);
  if (!sentry || !sentry.is_active) {
    throw new Error('NOT_ACTIVE_SENTRY');
  }
  
  // 2. Snapshot total staked value at proposal time
  const totalStakedValue = await stakingManager.getTotalStakedValue();
  
  // 3. Create proposal with 24hr voting window
  const votingStartsAt = new Date();
  const votingEndsAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // +24 hours
  
  const result = await db.query(`
    INSERT INTO governance_proposals (
      proposal_id, proposer_sentry_id, proposal_type, proposal_data,
      voting_starts_at, voting_ends_at, total_staked_value
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [
    generateId(),
    params.proposerSentryId,
    params.proposalType,
    params.proposalData,
    votingStartsAt,
    votingEndsAt,
    totalStakedValue
  ]);
  
  return result.rows[0];
}

async castVote(params: CastVoteParams): Promise<VoteResult> {
  // 1. Verify proposal is active
  const proposal = await this.getProposal(params.proposalId);
  if (proposal.status !== 'active') {
    throw new Error('PROPOSAL_NOT_ACTIVE');
  }
  
  const now = new Date();
  if (now < proposal.voting_starts_at || now > proposal.voting_ends_at) {
    throw new Error('VOTING_CLOSED');
  }
  
  // 2. Verify signature
  const isValidSignature = await this.verifySignature(
    params.sentryId,
    params.signature,
    { proposalId: params.proposalId, vote: params.vote }
  );
  if (!isValidSignature) {
    throw new Error('INVALID_SIGNATURE');
  }
  
  // 3. Get sentry's current voting weight
  const votingWeight = await stakingManager.getSentryVotingWeight(params.sentryId);
  
  // 4. Record vote
  await db.query(`
    INSERT INTO sentry_votes (proposal_id, sentry_id, vote, voting_weight, signature)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (proposal_id, sentry_id) UPDATE SET
      vote = $3,
      voting_weight = $4,
      voted_at = NOW()
  `, [params.proposalId, params.sentryId, params.vote, votingWeight, params.signature]);
  
  return { success: true, votingWeight };
}

async hasProposalPassed(proposalId: string): Promise<boolean> {
  const proposal = await this.getProposal(proposalId);
  
  // Get all votes
  const votes = await db.query(`
    SELECT vote, SUM(voting_weight) as total_weight
    FROM sentry_votes
    WHERE proposal_id = $1
    GROUP BY vote
  `, [proposalId]);
  
  const yesVotes = votes.rows.find(v => v.vote === 'yes')?.total_weight || 0;
  const totalStaked = proposal.total_staked_value;
  
  // Need 75% of total staked value
  const threshold = totalStaked * 0.75;
  
  return yesVotes >= threshold;
}
```

---

### **Phase 5: API Layer (Week 3-4)**

**Tasks:**
1. Implement REST API endpoints
2. Add authentication middleware
3. Add signature verification for sentry endpoints
4. Write API integration tests
5. Add rate limiting

**Deliverables:**
- `src/api/routes/staking.ts`
- `src/api/routes/governance.ts`
- `src/api/routes/sentries.ts`
- `src/api/middleware/auth.ts`
- `tests/api/staking.api.test.ts`

**Example Endpoint:**

```typescript
// POST /api/staking/stake
router.post('/stake', authMiddleware, async (req, res) => {
  try {
    const { nftId, sentryId } = req.body;
    const ownerWallet = req.user.wallet; // From JWT
    
    // Validate inputs
    if (!nftId || !sentryId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Execute stake
    const result = await stakingManager.stakeNFT({
      nftId,
      ownerWallet,
      sentryId
    });
    
    res.json(result);
  } catch (error) {
    if (error.message === 'VOTE_ACTIVE') {
      return res.status(409).json({ error: 'Cannot stake during active vote' });
    }
    if (error.message === 'NFT_NOT_OWNED') {
      return res.status(403).json({ error: 'NFT not owned by user' });
    }
    
    console.error('Stake error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

### **Phase 6: Telegram Integration (Week 4)**

**Tasks:**
1. Add Telegram commands for staking
2. Add interactive buttons for selecting sentries
3. Display staking status
4. Add vote notifications to users

**Deliverables:**
- `src/telegram/commands/stake.ts`
- `src/telegram/commands/unstake.ts`
- `src/telegram/commands/mystakes.ts`

**Example Commands:**

```typescript
// /stake command
bot.command('stake', async (ctx) => {
  const userWallet = await getUserWallet(ctx.from.id);
  const nfts = await getNFTsForUser(userWallet);
  
  if (nfts.length === 0) {
    return ctx.reply('You don\'t own any fund NFTs.');
  }
  
  // Show NFTs with inline buttons
  const keyboard = nfts.map(nft => ([
    { text: `NFT #${nft.id} ($${nft.value})`, callback_data: `stake_nft_${nft.id}` }
  ]));
  
  ctx.reply('Select NFT to stake:', {
    reply_markup: { inline_keyboard: keyboard }
  });
});

// Handle NFT selection
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  
  if (data.startsWith('stake_nft_')) {
    const nftId = data.replace('stake_nft_', '');
    
    // Show available sentries
    const sentries = await getActiveSentries();
    const keyboard = sentries.map(s => ([
      { 
        text: `${s.name} ($${s.totalStaked} staked, ${s.votingWeight}% power)`,
        callback_data: `stake_confirm_${nftId}_${s.id}`
      }
    ]));
    
    ctx.editMessageText('Select sentry to stake with:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  }
  
  if (data.startsWith('stake_confirm_')) {
    const [_, nftId, sentryId] = data.split('_');
    
    try {
      await stakingManager.stakeNFT({
        nftId,
        ownerWallet: await getUserWallet(ctx.from.id),
        sentryId
      });
      
      ctx.editMessageText(`✅ Successfully staked NFT #${nftId} with sentry ${sentryId}!`);
    } catch (error) {
      ctx.editMessageText(`❌ Error: ${error.message}`);
    }
  }
});

// /mystakes command
bot.command('mystakes', async (ctx) => {
  const userWallet = await getUserWallet(ctx.from.id);
  const stakes = await stakingManager.getUserStakes(userWallet);
  
  if (stakes.length === 0) {
    return ctx.reply('You have no staked NFTs.');
  }
  
  let message = '📊 Your Staked NFTs:\n\n';
  for (const stake of stakes) {
    const canUnstake = await stakingManager.canUnstake(stake.nft_id);
    const canRestake = await stakingManager.canRestake(stake.nft_id);
    
    message += `NFT #${stake.nft_id}\n`;
    message += `  Staked with: ${stake.sentry_name}\n`;
    message += `  Value: $${stake.value}\n`;
    message += `  Since: ${new Date(stake.staked_at).toLocaleDateString()}\n`;
    message += `  Can unstake: ${canUnstake ? '✅' : '❌'}\n`;
    message += `  Can restake: ${canRestake ? '✅' : '❌'}\n\n`;
  }
  
  ctx.reply(message);
});
```

---

### **Phase 7: Monitoring & Background Jobs (Week 4-5)**

**Tasks:**
1. Add cron job to check proposal deadlines
2. Auto-tally votes after 24 hours
3. Auto-execute passed proposals
4. Send notifications to Telegram
5. Update NFT values periodically

**Deliverables:**
- `src/jobs/ProposalMonitor.ts`
- `src/jobs/NFTValueUpdater.ts`

**Example Jobs:**

```typescript
// Run every minute to check proposal deadlines
cron.schedule('* * * * *', async () => {
  const expiredProposals = await db.query(`
    SELECT * FROM governance_proposals
    WHERE status = 'active'
    AND voting_ends_at < NOW()
  `);
  
  for (const proposal of expiredProposals.rows) {
    // Tally votes
    const passed = await governanceManager.hasProposalPassed(proposal.proposal_id);
    
    if (passed) {
      // Update status
      await db.query(`
        UPDATE governance_proposals
        SET status = 'passed'
        WHERE proposal_id = $1
      `, [proposal.proposal_id]);
      
      // Execute proposal
      await governanceManager.executeProposal(proposal.proposal_id);
      
      // Notify sentries via Telegram
      await notifySentries(proposal, 'PASSED');
    } else {
      await db.query(`
        UPDATE governance_proposals
        SET status = 'rejected'
        WHERE proposal_id = $1
      `, [proposal.proposal_id]);
      
      await notifySentries(proposal, 'REJECTED');
    }
  }
});

// Run every hour to update NFT values
cron.schedule('0 * * * *', async () => {
  const stakes = await db.query('SELECT nft_id FROM nft_stakes WHERE staked_with_sentry IS NOT NULL');
  
  for (const stake of stakes.rows) {
    const currentValue = await solana.getNFTValue(stake.nft_id);
    
    await db.query(`
      UPDATE nft_stakes
      SET nft_value_usd = $1, updated_at = NOW()
      WHERE nft_id = $2
    `, [currentValue, stake.nft_id]);
  }
});
```

---

## 5. TESTING STRATEGY

### **5.1 Unit Tests**

```typescript
// Test validation rules independently
describe('StakingValidator', () => {
  // Vote lock tests
  test('blocks all actions during vote');
  test('allows actions after vote ends');
  
  // Withdraw cooldown tests
  test('blocks withdrawal within 48 hours');
  test('allows withdrawal after 48 hours');
  
  // Restake limit tests
  test('blocks restake within 7 days');
  test('allows restake after 7 days');
  test('allows initial stake without waiting');
});

// Test governance calculations
describe('GovernanceManager', () => {
  test('correctly calculates 75% threshold');
  test('proposal passes with exactly 75%');
  test('proposal fails with 74.9%');
  test('handles multiple sentries voting');
});
```

### **5.2 Integration Tests**

```typescript
// Test full staking workflow
describe('Staking Workflow', () => {
  test('user stakes → NFT locked → can query stake', async () => {
    const result = await stakeNFT('NFT_1', 'Alice', 'Sentry_A');
    expect(result.success).toBe(true);
    
    const info = await getStakeInfo('NFT_1');
    expect(info.staked_with).toBe('Sentry_A');
  });
  
  test('user stakes → unstakes → waits 48hrs → withdraws', async () => {
    await stakeNFT('NFT_1', 'Alice', 'Sentry_A');
    await unstakeNFT('NFT_1', 'Alice');
    
    // Try immediate withdrawal (should fail)
    await expect(withdrawNFT('NFT_1')).rejects.toThrow('WITHDRAW_COOLDOWN');
    
    // Fast-forward 48 hours
    await advanceTime(48 * 60 * 60 * 1000);
    
    // Now should succeed
    const result = await withdrawNFT('NFT_1');
    expect(result.success).toBe(true);
  });
});

// Test governance workflow
describe('Governance Workflow', () => {
  test('create proposal → sentries vote → auto-execute', async () => {
    // Setup: 3 sentries with different voting weights
    await setupSentries([
      { id: 'A', stakedValue: 50000 },  // 50%
      { id: 'B', stakedValue: 30000 },  // 30%
      { id: 'C', stakedValue: 20000 }   // 20%
    ]);
    
    // Create proposal
    const proposal = await createProposal({
      type: 'config_update',
      data: { maxPositionSize: 1000 }
    });
    
    // Sentries vote
    await castVote('A', proposal.id, 'yes');  // 50%
    await castVote('B', proposal.id, 'yes');  // 30%
    // C doesn't vote
    
    // Fast-forward 24 hours
    await advanceTime(24 * 60 * 60 * 1000);
    
    // Check result (80% yes, should pass)
    const passed = await hasProposalPassed(proposal.id);
    expect(passed).toBe(true);
  });
});
```

### **5.3 Load Tests**

```typescript
// Test system under load
describe('Performance', () => {
  test('handles 1000 concurrent stakes', async () => {
    const promises = [];
    for (let i = 0; i < 1000; i++) {
      promises.push(stakeNFT(`NFT_${i}`, `User_${i}`, 'Sentry_A'));
    }
    
    const results = await Promise.all(promises);
    expect(results.every(r => r.success)).toBe(true);
  });
  
  test('voting weight calculation is fast', async () => {
    // Setup 1000 stakes
    for (let i = 0; i < 1000; i++) {
      await stakeNFT(`NFT_${i}`, `User_${i}`, 'Sentry_A');
    }
    
    const start = Date.now();
    const weight = await getSentryVotingWeight('Sentry_A');
    const duration = Date.now() - start;
    
    expect(duration).toBeLessThan(100); // Should be < 100ms
  });
});
```

---

## 6. ERROR HANDLING

### **6.1 Error Types**

```typescript
export enum StakingError {
  VOTE_ACTIVE = 'Cannot perform action during active vote',
  RESTAKE_COOLDOWN = 'Must wait 7 days between sentry changes',
  WITHDRAW_COOLDOWN = 'Must wait 48 hours after unstaking to withdraw',
  NFT_NOT_OWNED = 'NFT not owned by user',
  NFT_NOT_STAKED = 'NFT is not currently staked',
  SENTRY_NOT_FOUND = 'Sentry does not exist',
  SENTRY_INACTIVE = 'Sentry is not active',
  INVALID_SIGNATURE = 'Cryptographic signature is invalid',
  PROPOSAL_NOT_ACTIVE = 'Proposal voting window has closed',
  ALREADY_VOTED = 'Sentry has already voted on this proposal'
}
```

### **6.2 Error Response Format**

```typescript
interface ErrorResponse {
  error: string;
  code: StakingError;
  details?: any;
  canRetryAt?: string; // ISO timestamp when action becomes available
}

// Example
{
  "error": "Cannot restake yet",
  "code": "RESTAKE_COOLDOWN",
  "details": {
    "lastRestakeAt": "2026-03-01T10:00:00Z",
    "nextAvailableAt": "2026-03-08T10:00:00Z"
  },
  "canRetryAt": "2026-03-08T10:00:00Z"
}
```

---

## 7. SECURITY CONSIDERATIONS

### **7.1 NFT Ownership Verification**

```typescript
// Always verify on-chain ownership before stake actions
async function verifyNFTOwnership(nftId: string, claimedOwner: string): Promise<boolean> {
  const connection = new Connection(SOLANA_RPC_URL);
  const nftMint = new PublicKey(nftId);
  
  // Get token account
  const tokenAccounts = await connection.getTokenAccountsByOwner(
    new PublicKey(claimedOwner),
    { mint: nftMint }
  );
  
  if (tokenAccounts.value.length === 0) return false;
  
  // Verify balance = 1 (NFTs have supply of 1)
  const balance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
  return balance.value.uiAmount === 1;
}
```

### **7.2 Signature Verification**

```typescript
// Verify sentry signatures for governance actions
async function verifySentrySignature(
  sentryId: string,
  signature: string,
  message: any
): Promise<boolean> {
  const sentry = await getSentry(sentryId);
  if (!sentry) return false;
  
  const messageHash = hashMessage(JSON.stringify(message));
  const publicKey = new PublicKey(sentry.public_key);
  
  return nacl.sign.detached.verify(
    Buffer.from(messageHash, 'hex'),
    Buffer.from(signature, 'hex'),
    publicKey.toBuffer()
  );
}
```

### **7.3 SQL Injection Prevention**

```typescript
// Always use parameterized queries
// BAD:
await db.query(`SELECT * FROM nft_stakes WHERE nft_id = '${nftId}'`);

// GOOD:
await db.query('SELECT * FROM nft_stakes WHERE nft_id = $1', [nftId]);
```

### **7.4 Rate Limiting**

```typescript
// Prevent spam/abuse
import rateLimit from 'express-rate-limit';

const stakingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: 'Too many staking requests, please try again later'
});

router.post('/stake', stakingLimiter, async (req, res) => {
  // ...
});
```

---

## 8. DEPLOYMENT CHECKLIST

### **8.1 Pre-Deployment**

- [ ] All unit tests passing
- [ ] All integration tests passing
- [ ] Load tests completed
- [ ] Security audit completed
- [ ] Database migrations tested on staging
- [ ] Backup strategy in place
- [ ] Rollback plan documented

### **8.2 Database Migration**

```bash
# Run migrations
npm run migrate:up

# If issues, rollback
npm run migrate:down
```

### **8.3 Monitoring Setup**

```typescript
// Add monitoring for key metrics
metrics.gauge('staking.total_staked_value', await getTotalStakedValue());
metrics.gauge('staking.active_sentries', await getActiveSentryCount());
metrics.gauge('governance.active_proposals', await getActiveProposalCount());

// Alert on anomalies
if (await getActiveSentryCount() < 3) {
  alertTeam('Low sentry count - governance at risk');
}
```

---

## 9. TIMELINE ESTIMATE

**Total: 4-5 weeks**

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Database Setup | 3 days | None |
| Validation Logic | 4 days | Database |
| Staking Manager | 5 days | Validation |
| Governance Manager | 5 days | Staking Manager |
| API Layer | 4 days | Governance |
| Telegram Integration | 3 days | API |
| Background Jobs | 3 days | Governance |
| Testing & Fixes | 5 days | All |

---

## 10. SUCCESS CRITERIA

- [ ] Users can stake NFTs with sentries via Telegram
- [ ] Users can move stakes between sentries (7-day limit enforced)
- [ ] Users can unstake (48-hour withdraw cooldown enforced)
- [ ] Sentries can create proposals
- [ ] Sentries can vote on proposals (weighted by staked value)
- [ ] Proposals auto-execute if 75% threshold met
- [ ] All stakes frozen during 24-hour voting windows
- [ ] All three staking rules enforced correctly
- [ ] System handles 1000+ concurrent users
- [ ] API response time < 200ms for read operations
- [ ] Zero downtime during deployment

---

## APPENDIX A: API REFERENCE

Full API documentation: See `docs/API.md` (to be created)

## APPENDIX B: Database Schema Diagram

```
┌─────────────┐      ┌─────────────────┐      ┌──────────────┐
│  nft_stakes │─────>│ sentries        │<─────│ sentry_votes │
└─────────────┘      └─────────────────┘      └──────────────┘
      │                                               │
      │                                               │
      └──────────────────┬────────────────────────────┘
                         │
                         ▼
              ┌────────────────────────┐
              │ governance_proposals   │
              └────────────────────────┘
```

## APPENDIX C: State Transition Diagram

```
[Unstaked] ──stake──> [Staked with Sentry A]
                           │
                           ├──restake (7d)──> [Staked with Sentry B]
                           │
                           └──unstake──> [Unstaked + 48hr cooldown]
                                              │
                                              └──withdraw (48hr)──> [Withdrawn]
```
