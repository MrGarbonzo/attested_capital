# Autonomous Launch Problems

## The Goal

The Panthers Fund is an autonomous trading agent that manages a Solana-based investment fund from inside a Trusted Execution Environment (TEE). Participants hold compressed NFTs (cNFTs) representing their share of the fund. The agent trades on their behalf, and guardians — independent TEE nodes — monitor the agent's behavior, store encrypted database backups, and participate in governance.

The core promise is: **no human controls this fund.** The agent operates autonomously, the guardians watch it independently, and all trust is rooted in hardware attestation (Intel TDX/SGX) verified via Intel's PCCS infrastructure. Anyone can verify the code running inside the TEE matches the approved open-source code.

But to fulfill this promise, the system must be able to **bootstrap itself without human intervention** after the initial deployment. Specifically:

- The agent must be able to create its own communication channels
- Guardians must be able to discover the agent without a human pointing them to it
- No human should hold credentials that could be used to impersonate the agent
- Configuration changes (API keys, RPC endpoints) must flow through governance, not human SSH sessions

This document explores the problems we've encountered in achieving this goal and the solutions we're considering.

---

## Problem 1: Telegram Identity

### The Issue

The agent uses Telegram as its primary interface for:
- **Buyer-facing sales**: NFT negotiations happen in Telegram DMs
- **Agent-guardian discovery**: Protocol messages in a shared Telegram group
- **Guardian governance**: Guardians use DM commands (`/vote`, `/status`, `/peers`)

The agent's Telegram bot token is currently created manually via @BotFather and passed to the TEE as an environment variable. This means **the fund operator knows the bot token** and could:

1. **Impersonate the agent** — send messages as the bot from outside the TEE
2. **Prompt injection** — inject crafted messages into conversations with the LLM to manipulate trading decisions
3. **Intercept buyer DMs** — read private negotiations and financial information
4. **Manipulate governance** — send fake protocol messages to guardians

This breaks the "no human controls this fund" guarantee. The bot token is effectively a root credential for the agent's entire communication channel.

### Why This Is Hard

Telegram requires human interaction to create any identity:

- **Bot accounts** must be created via @BotFather, which is a chat-based flow. There is no API to programmatically create bots.
- **User accounts** require a phone number and SMS verification code. There is no way around this.
- **"Sealed secret" approach fails** — if a human creates the token and passes it to the TEE, the human still has the original token. There is no way to "forget" a secret you once knew. The TEE can prove *it* won't leak the token, but it can't prove *the human* deleted their copy.

### Proposed Solution: Boot Agent

A **boot agent** is a separate, short-lived process that runs inside a TEE and handles the one-time Telegram setup:

#### Architecture

```
┌─────────────────────────────────────────────┐
│  TEE (SecretVM)                              │
│                                              │
│  ┌──────────────┐    ┌───────────────────┐   │
│  │  Boot Agent   │───>│  Fund Agent       │   │
│  │  (GramJS)     │    │  (Grammy)         │   │
│  │               │    │                   │   │
│  │  1. Register  │    │  Receives:        │   │
│  │     phone via │    │  - Bot token      │   │
│  │     Twilio    │    │  - Group chat ID  │   │
│  │  2. Login to  │    │                   │   │
│  │     Telegram  │    │  Never leaves TEE │   │
│  │  3. Chat with │    │                   │   │
│  │     BotFather │    └───────────────────┘   │
│  │  4. Create    │                            │
│  │     group     │                            │
│  │  5. Pass creds│                            │
│  │  6. Shut down │                            │
│  └──────────────┘                             │
└─────────────────────────────────────────────┘
```

#### Flow

1. Boot agent starts inside the TEE
2. Calls an SMS API (e.g., Twilio) to provision a phone number and receive a verification code — all inside the TEE
3. Uses **GramJS** (MTProto client library) to register a Telegram user account with that phone number
4. As that user account, chats with @BotFather: `/newbot` → names it → receives a bot token
5. Creates a Telegram group
6. Adds the new bot to the group, promotes it to admin
7. Invites the fund owner and makes them admin
8. Passes the bot token + group chat ID to the fund agent process (via shared sealed storage)
9. Shuts down — the phone number session can be destroyed

**Result**: The bot token was created inside the TEE and never left it. No human ever saw it.

#### Key Libraries

- **GramJS** (`telegram` npm package): Full Telegram client API (MTProto). Can do everything a human Telegram user can do — create accounts, chat with BotFather, create groups, manage members.
- **Grammy** (`grammy` npm package): Telegram Bot API wrapper. Simpler, used for daily operations (receiving messages, replying, etc.) but cannot create bots or groups.

#### Open Questions

- **Twilio API key**: The boot agent needs a Twilio API key to provision a phone number. This key must come from somewhere — it's the one remaining trusted input. However, Twilio cannot use this key to control Telegram, so the blast radius is limited.
- **Telegram phone bans**: Telegram may ban accounts that appear automated. The boot agent needs to behave naturally during the brief registration window.
- **Session persistence**: If the TEE restarts and the bot token is lost (stored only in memory), the boot agent would need to run again. The token should be sealed to the TEE's enclave key for persistence.

---

## Problem 2: Bot-to-Bot Communication

### The Issue

The current architecture uses a shared Telegram group for agent-guardian protocol messages (discovery, attestation announcements, proposal results). But **Telegram blocks bot-to-bot communication entirely**:

- Bots cannot see messages from other bots in group chats
- This is a platform-level restriction, not a privacy setting
- Making bots admin does not help
- Bots cannot DM each other
- Bots cannot initiate conversations with other bots via `/start`

This means the entire agent-guardian protocol layer built on Telegram group messages is fundamentally broken for bot-to-bot use. It only works today because of a `BOOTSTRAP_GUARDIANS` fallback that hardcodes guardian HTTP endpoints — which defeats the purpose of discovery.

### Impact

Without bot-to-bot communication:
- Agent cannot discover guardians via Telegram
- Guardians cannot discover the agent via Telegram
- Attestation announcements are invisible between bots
- Proposal announcements between bots are invisible
- The shared group is only useful for human-to-bot interaction

### Conclusion

**Telegram cannot be the agent-guardian protocol layer.** It is only suitable for human-facing communication (buyer DMs, guardian operator commands).

---

## Problem 3: Trustless Discovery

### The Issue

If Telegram can't be used for agent-guardian discovery, how do they find each other with zero human intervention?

**Rejected approaches:**

| Approach | Problem |
|----------|---------|
| Hardcoded seed endpoints | Someone must set them → human intervention |
| DNS-based discovery | Who controls DNS? Trust root outside TEE |
| DHT/IPFS | Untrusted nodes, poisoning attacks |
| Telegram group | Bot-to-bot blocked (Problem 2) |

### Proposed Solution: Solana On-Chain Registry

A Solana program (smart contract) serves as the trustless discovery layer:

```
┌──────────────────────────────────────────────┐
│  Solana Program: Panthers Discovery Registry  │
│                                               │
│  Agent Account:                               │
│  ┌──────────────────────────────────────────┐ │
│  │ endpoint: "https://67.215.13.107:8080"   │ │
│  │ tee_instance_id: "4565dc38..."           │ │
│  │ code_hash: "2070bf81..."                 │ │
│  │ attestation_hash: "ba87a347..."          │ │
│  │ pubkey: <ed25519 public key>             │ │
│  │ registered_at: <slot number>             │ │
│  └──────────────────────────────────────────┘ │
│                                               │
│  Guardian Accounts:                           │
│  ┌──────────────────────────────────────────┐ │
│  │ address: "guardian-1"                    │ │
│  │ endpoint: "https://67.43.239.6:3100"     │ │
│  │ is_sentry: true                          │ │
│  │ attestation_hash: "ba87a347..."          │ │
│  │ pubkey: <ed25519 public key>             │ │
│  │ registered_at: <slot number>             │ │
│  └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

#### Flow

1. **Agent boots** → writes its endpoint + TEE attestation to a Solana account (PDA derived from the program)
2. **Guardian boots** → reads the Solana registry → finds the agent's endpoint
3. **Guardian calls agent's HTTPS endpoint** → attestation exchange happens over HTTP
4. **Agent verifies guardian's attestation** → calls guardian's HTTPS endpoint back
5. **Both sides verified** → heartbeat, DB sync, config governance all happen over HTTP

#### Why This Works

- **Fully trustless**: No human intermediary. The contract is deployed once and is immutable.
- **Publicly verifiable**: Anyone can read the registry and verify the attestation hashes.
- **Already in the stack**: The agent already has a Solana wallet and RPC connection.
- **Censorship resistant**: No single entity can prevent an agent or guardian from registering.
- **No bot-to-bot limitation**: This bypasses Telegram entirely for discovery.

#### Security Considerations

- The program should verify that only TEE-attested entities can register (on-chain attestation verification, or signed registration with TEE-bound keys).
- Guardian entries should have a TTL — stale entries get pruned.
- The agent's Solana wallet signs the registration transaction, binding the on-chain identity to the wallet that controls the fund.

---

## Problem 4: Communication Security

### The Issue

Once discovery happens on-chain and the protocol moves to HTTP, is the communication secure?

### Analysis

The current system uses **signed envelopes** for all agent-guardian messages:

```json
{
  "version": 1,
  "sender": "guardian-1",
  "timestamp": 1234567890,
  "nonce": "abcd1234...",
  "action": "db.snapshot",
  "payloadHash": "<sha256>",
  "payload": "{...}",
  "signature": "<ed25519 signature>"
}
```

This provides:
- **Authentication**: Signature verified against TEE-bound ed25519 public key
- **Integrity**: Payload hash prevents tampering
- **Replay protection**: Nonce tracking prevents replay attacks
- **Freshness**: Timestamp checked within 5-minute window

What it does NOT provide:
- **Confidentiality**: Messages can be read by network observers (DB snapshots contain fund data)

### Recommendation

Use **HTTPS** where possible for confidentiality. The SecretVM instances can use self-signed certificates — both sides verify identity via TEE attestation, not TLS certificate authorities. The signed envelope layer provides defense-in-depth even if TLS is somehow compromised.

For the Solana registry, endpoints should be registered as `https://` URLs.

---

## Problem 5: Configuration Governance

### The Issue

The agent needs runtime configuration that changes over time:
- RPC endpoints go down and need to be replaced
- API keys expire and need rotation
- AI model endpoints change
- Trading parameters need tuning

Currently, changing any of these requires SSH access to the TEE and manually editing environment variables. This means a human has direct access to the agent's runtime — breaking the autonomy guarantee.

### Proposed Solution: Guardian-Controlled Config DB

Inspired by Cosmos SDK governance, guardians collectively control a **configuration database** that is separate from the financial database:

```
┌─────────────────────┐     ┌─────────────────────┐
│  Finance DB          │     │  Config DB           │
│  (Agent-controlled)  │     │  (Guardian-governed)  │
│                      │     │                       │
│  - Fund state        │     │  - RPC endpoints      │
│  - NFT accounts      │     │  - API keys           │
│  - Trade history     │     │  - AI model config    │
│  - Balances          │     │  - Trading parameters │
│  - Marketplace       │     │  - Risk limits        │
│                      │     │                       │
│  Agent writes.       │     │  Guardians propose +  │
│  Guardians backup.   │     │  vote. Agent reads.   │
└─────────────────────┘     └─────────────────────┘
```

#### Governance Flow

1. A guardian proposes a config change (e.g., "change Solana RPC to https://new-rpc.com")
2. The proposal is broadcast to all guardians
3. Guardians vote — voting power is based on delegated NFT holdings (existing system)
4. If the proposal reaches the required threshold (e.g., 50% for RPC changes, 75% for API keys), it passes
5. The updated config is signed by the approving guardians and sent to the agent
6. The agent verifies the signatures, checks quorum, and applies the new config
7. The agent acknowledges the update

#### What Guardians Control vs. What Agent Controls

| Domain | Controller | Rationale |
|--------|-----------|-----------|
| Trade execution | Agent | Real-time decisions require autonomy |
| Fund accounting | Agent | Ledger integrity is the agent's core responsibility |
| NFT minting/sales | Agent | Buyer interaction requires agent autonomy |
| RPC/LCD endpoints | Guardians | Infrastructure config, no financial impact |
| API keys (Jupiter, AI) | Guardians | Credential rotation, no direct fund access |
| AI model selection | Guardians | Controls agent behavior, should be governed |
| Trading strategy | Guardians (via existing governance) | Already implemented as `strategy_change` proposals |
| Risk limits | Guardians | Safety bounds on agent behavior |
| Code updates | Guardians (via existing governance) | Already implemented as `code_update` proposals |

---

## Summary: Proposed Architecture

```
                    ┌─────────────────────┐
                    │  Solana Blockchain   │
                    │                      │
                    │  Discovery Registry  │
                    │  (Program/PDA)       │
                    └──────┬──────┬───────┘
                     reads │      │ writes
                           │      │
              ┌────────────┘      └────────────┐
              │                                │
   ┌──────────▼──────────┐          ┌──────────▼──────────┐
   │  Guardian (TEE)      │   HTTPS  │  Fund Agent (TEE)   │
   │                      │◄────────►│                      │
   │  - Attestation       │          │  - Trading           │
   │  - DB backups        │          │  - Fund accounting   │
   │  - Config governance │          │  - NFT sales         │
   │  - Health monitoring │          │  - /status endpoint  │
   │                      │          │                      │
   │  TG bot: governance  │          │  TG bot: buyer DMs   │
   │  commands for humans │          │  (created by boot    │
   │  (/vote, /status)    │          │   agent in TEE)      │
   └──────────────────────┘          └──────────────────────┘

   Discovery: On-chain (Solana program)
   Protocol:  HTTPS with signed envelopes
   Telegram:  Human-facing only (sales + governance commands)
   Config:    Guardian-governed DB, agent reads
   Finance:   Agent-controlled DB, guardians backup
```

### Remaining Decisions

1. **Config governance scope**: Exactly which parameters should guardians control? (RPCs only? Everything?)
2. **Boot agent implementation**: Priority and timeline for the GramJS-based autonomous Telegram identity creation
3. **Solana program design**: Account structure, PDA derivation, registration validation logic
4. **HTTPS certificates**: Self-signed with attestation-based trust, or Let's Encrypt with DNS validation?
5. **Config change thresholds**: What percentage of guardian approval is needed for different config categories?

---

*Document created: March 2026*
*Status: Active discussion — architecture not yet finalized*
