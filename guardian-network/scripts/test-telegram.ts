/**
 * Live test: Guardian Telegram bot with mock data.
 *
 * Seeds an in-memory SQLite DB with RPCs, peers, a delegation, and a proposal,
 * then starts the bot polling against the real "Garbs Test Group".
 *
 * Usage:
 *   npx tsx scripts/test-telegram.ts
 */

import { createDatabase } from '../src/shared/db.js';
import { PeerRegistry } from '../src/guardian/peers.js';
import { RpcRegistry } from '../src/guardian/rpc-registry.js';
import { DelegationTracker } from '../src/guardian/delegations.js';
import { ProposalManager } from '../src/sentry/proposals.js';
import { VotingSystem } from '../src/sentry/voting.js';
import { NFTVerifier } from '../src/sentry/nft-verifier.js';
import { createGuardianBot, sendToGroup } from '../src/guardian/telegram.js';
import { formatGuardianAnnounce } from '../src/shared/telegram-protocol.js';

// ── Config ─────────────────────────────────────────────────────────
const BOT_TOKEN = '8024604787:AAEwh0hZyzZCvExd5r8AjqdwAMsMe34oHls';
const GROUP_CHAT_ID = '-1002697503149';
const GUARDIAN_ADDRESS = 'guardian-test';
const GUARDIAN_ENDPOINT = 'http://localhost:3400';
const IS_SENTRY = true;

// ── Database ───────────────────────────────────────────────────────
console.log('Creating in-memory database...');
const db = createDatabase(':memory:');

// ── Modules ────────────────────────────────────────────────────────
const peers = new PeerRegistry(db);
const rpcRegistry = new RpcRegistry(db);
const delegations = new DelegationTracker(db, 'http://localhost:9999'); // dummy
const proposals = new ProposalManager(db);
const voting = new VotingSystem(db, proposals, delegations);
const nftVerifier = new NFTVerifier('http://localhost:9999'); // dummy

// ── Seed: RPCs ─────────────────────────────────────────────────────
console.log('\nSeeding RPCs...');
const rpcId = rpcRegistry.add({
  chain: 'solana',
  url: 'https://api.mainnet-beta.solana.com',
  addedBy: GUARDIAN_ADDRESS,
});
// Boost reputation from default to 50 (default is likely 0)
const rpcEntry = rpcRegistry.getById(rpcId);
if (rpcEntry && rpcEntry.reputation < 50) {
  rpcRegistry.adjustReputation(rpcId, 50 - rpcEntry.reputation);
}
rpcRegistry.setStatus(rpcId, 'active');
console.log(`  RPC #${rpcId}: solana mainnet (reputation=50, status=active)`);

// ── Seed: Peers ────────────────────────────────────────────────────
console.log('\nSeeding peers...');
peers.upsert({
  address: GUARDIAN_ADDRESS,
  endpoint: GUARDIAN_ENDPOINT,
  isSentry: true,
});
peers.upsert({
  address: 'guardian-2',
  endpoint: 'http://localhost:3401',
  isSentry: false,
});
console.log('  guardian-test (self, sentry)');
console.log('  guardian-2 (non-sentry)');

// ── Seed: Delegation ──────────────────────────────────────────────
console.log('\nSeeding delegation...');
const delegationId = delegations.create({
  delegatorTgId: '0', // placeholder — any DM user can /vote via sentry
  sentryAddress: GUARDIAN_ADDRESS,
  nftTokenIds: [1],
  totalValue: 500_000, // $5,000 in cents
  signature: 'test-sig',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
});
console.log(`  Delegation #${delegationId}: 500000 cents ($5,000) → ${GUARDIAN_ADDRESS}`);

// ── Seed: Proposal ────────────────────────────────────────────────
console.log('\nSeeding proposal...');
const proposalId = proposals.create({
  type: 'rpc_add',
  proposer: 'guardian-2',
  description: 'Add Solana testnet RPC endpoint',
  data: { chain: 'solana', url: 'https://api.testnet.solana.com' },
  thresholdPct: 50,
  deadlineHours: 24,
});
console.log(`  Proposal ${proposalId}: rpc_add (50% threshold, 24h deadline)`);

// ── Summary ────────────────────────────────────────────────────────
console.log('\n─── Seeded Data Summary ───');
console.log(`  RPCs:        ${rpcRegistry.stats().total} (${rpcRegistry.stats().active} active)`);
console.log(`  Peers:       ${peers.stats().total} (${peers.stats().sentries} sentries)`);
console.log(`  Delegations: ${delegations.stats().active} active, $${(delegations.stats().totalValue / 100).toFixed(0)} value`);
console.log(`  Proposals:   ${proposals.listActive().length} active`);
console.log(`  Voting power for ${GUARDIAN_ADDRESS}: ${delegations.getVotingPower(GUARDIAN_ADDRESS).totalPower} cents`);

// ── Create & start bot ─────────────────────────────────────────────
console.log('\nStarting Telegram bot...');
const bot = createGuardianBot(
  {
    botToken: BOT_TOKEN,
    groupChatId: GROUP_CHAT_ID,
    guardianAddress: GUARDIAN_ADDRESS,
    guardianEndpoint: GUARDIAN_ENDPOINT,
    isSentry: IS_SENTRY,
  },
  { peers, proposals, voting, delegations, nftVerifier },
);

// Start polling
bot.start({
  onStart: async () => {
    console.log('Bot is polling! Sending announce to group...\n');

    const announceMsg = formatGuardianAnnounce({
      address: GUARDIAN_ADDRESS,
      endpoint: GUARDIAN_ENDPOINT,
      isSentry: IS_SENTRY,
    });
    await sendToGroup(bot, GROUP_CHAT_ID, announceMsg);
    console.log(`Sent to group: ${announceMsg}`);

    console.log('\n─── Ready for manual testing ───');
    console.log('Group commands:');
    console.log('  Type [DISCOVER:REQUEST] in the group');
    console.log('  Type [ANNOUNCE:AGENT] endpoint=http://test:3000 teeId=test-123 codeHash=abc');
    console.log('\nDM commands (message @Garbonzo_AI_Test_bot directly):');
    console.log('  /status');
    console.log('  /peers');
    console.log('  /proposals');
    console.log(`  /vote ${proposalId} approve`);
    console.log('  /sentries');
    console.log('  /my_delegations');
    console.log('\nPress Ctrl+C to stop.\n');
  },
});

// Graceful shutdown
const shutdown = () => {
  console.log('\nShutting down...');
  bot.stop();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
