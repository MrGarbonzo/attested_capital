import { Bot, type Api } from 'grammy';
import type { Tool } from './tools.js';
import { selectTools } from './tool-router.js';
import { parseProtocolMessage } from './telegram-protocol.js';
import type { DiscoveredGuardian } from './context.js';
import type { ResilientLLM } from './resilient-llm.js';
import type { HistoryMessage } from './llm.js';

// ── Per-chat conversation history (for DM negotiation memory) ────
const MAX_HISTORY_TURNS = 10; // keep last 10 exchanges per chat
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface ChatHistory {
  messages: HistoryMessage[];
  lastActivity: number;
}

const chatHistories = new Map<number, ChatHistory>();

function getChatHistory(chatId: number): HistoryMessage[] {
  const entry = chatHistories.get(chatId);
  if (!entry) return [];
  // Expire stale history
  if (Date.now() - entry.lastActivity > HISTORY_TTL_MS) {
    chatHistories.delete(chatId);
    return [];
  }
  return entry.messages;
}

function appendChatHistory(chatId: number, role: 'user' | 'assistant', content: string): void {
  let entry = chatHistories.get(chatId);
  if (!entry || Date.now() - entry.lastActivity > HISTORY_TTL_MS) {
    entry = { messages: [], lastActivity: Date.now() };
    chatHistories.set(chatId, entry);
  }
  entry.messages.push({ role, content });
  entry.lastActivity = Date.now();
  // Trim to max turns (each turn = 1 message, so 2*MAX = user+assistant pairs)
  while (entry.messages.length > MAX_HISTORY_TURNS * 2) {
    entry.messages.shift();
  }
}

/** Promote a user to admin in the group chat. */
async function promoteToAdmin(api: Api, chatId: number, userId: number): Promise<void> {
  try {
    await api.promoteChatMember(chatId, userId, {
      can_manage_chat: true,
      can_delete_messages: true,
      can_invite_users: true,
      can_pin_messages: true,
    });
    console.log(`[protocol] Promoted guardian bot ${userId} to admin`);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[protocol] Failed to promote ${userId} to admin: ${errMsg}`);
  }
}

interface TelegramConfig {
  botToken: string;
  /** Optional: restrict bot to these Telegram user IDs. Empty = allow all. */
  allowedUsers?: string[];
  /** Group chat ID for guardian protocol messages. */
  groupChatId?: number;
  /** Shared map of discovered guardians (from ServiceContext). */
  discoveredGuardians?: Map<string, DiscoveredGuardian>;
  /** Resilient LLM client (with retry + circuit breaker). */
  llm: ResilientLLM;
  /** Tools that can be invoked by degraded-mode commands. */
  degradedTools?: Map<string, Tool>;
}

export function createBot(tools: Tool[], config: TelegramConfig): Bot {
  const bot = new Bot(config.botToken);

  // Authorization middleware
  if (config.allowedUsers && config.allowedUsers.length > 0) {
    const allowed = new Set(config.allowedUsers);
    bot.use(async (ctx, next) => {
      const userId = ctx.from?.id?.toString();
      if (userId && allowed.has(userId)) {
        await next();
      } else {
        await ctx.reply('Unauthorized. Contact the fund admin.');
      }
    });
  }

  // Protocol middleware — intercept structured messages from group chat
  if (config.groupChatId && config.discoveredGuardians) {
    const guardians = config.discoveredGuardians;
    const groupId = config.groupChatId;

    bot.on('message:text', async (ctx, next) => {
      if (ctx.chat.id !== groupId) return next();

      const msg = parseProtocolMessage(ctx.message.text);
      if (!msg) return next();

      const now = Date.now();

      switch (msg.kind) {
        case 'guardian_announce':
        case 'discover_response': {
          const data = msg.data;
          const existing = guardians.get(data.address);
          guardians.set(data.address, {
            address: data.address,
            endpoint: data.endpoint,
            isSentry: data.isSentry,
            discoveredAt: existing?.discoveredAt ?? now,
            lastSeen: now,
            verified: existing?.verified ?? false,
            telegramUserId: ctx.from?.id ?? existing?.telegramUserId,
          });
          console.log(`[protocol] Discovered guardian: ${data.address} at ${data.endpoint} (tgId: ${ctx.from?.id})`);
          break;
        }
        case 'proposal_new':
          console.log(`[protocol] New proposal: ${msg.data.id} (${msg.data.type})`);
          break;
        case 'proposal_result':
          console.log(`[protocol] Proposal ${msg.data.id}: ${msg.data.status} (${msg.data.approvalPct}%)`);
          break;

        case 'attestation_verified': {
          console.log(`[protocol] Attestation verified: ${msg.data.peerId} (sentry: ${msg.data.isSentry})`);
          // Promote the guardian bot that sent this message to admin
          const senderTgId = ctx.from?.id;
          if (senderTgId && groupId) {
            promoteToAdmin(ctx.api, groupId, senderTgId).catch(() => {});
          }
          break;
        }
        case 'attestation_request':
          console.log(`[protocol] Attestation request: ${msg.data.peerId} (pubkey: ${msg.data.pubkey})`);
          break;
        case 'attestation_rejected':
          console.log(`[protocol] Attestation rejected: ${msg.data.peerId} — ${msg.data.reason}`);
          break;
        case 'vault_key_sent':
          console.log(`[protocol] Vault key sent to ${msg.data.toPeerId}`);
          break;
        case 'vault_key_received':
          console.log(`[protocol] Vault key received from ${msg.data.fromPeerId}`);
          break;
        case 'db_sync_sent':
          console.log(`[protocol] DB sync sent: seq=${msg.data.seq} peers=${msg.data.peers} size=${msg.data.sizeKB}KB`);
          break;
        case 'db_sync_received':
          console.log(`[protocol] DB sync received from ${msg.data.fromPeerId} seq=${msg.data.seq}`);
          break;
        case 'db_sync_rejected':
          console.log(`[protocol] DB sync rejected from ${msg.data.fromPeerId}: ${msg.data.reason}`);
          break;
        case 'recovery_request':
          console.log(`[protocol] Recovery request from ${msg.data.fromPeerId}`);
          break;
        case 'recovery_served':
          console.log(`[protocol] Recovery served to ${msg.data.toPeerId} seq=${msg.data.seq}`);
          break;
        case 'trust_peer_added':
          console.log(`[protocol] Trust peer added: ${msg.data.peerId} (sentry: ${msg.data.isSentry})`);
          break;
        case 'trust_peer_removed':
          console.log(`[protocol] Trust peer removed: ${msg.data.peerId}`);
          break;
        default:
          break;
      }
      // Protocol messages are consumed — don't pass to LLM
    });
  }

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    const message = ctx.message.text;
    const chatId = ctx.chat.id;

    console.log(`[telegram] Message from ${ctx.from?.id}: ${message.slice(0, 80)}`);

    try {
      // Select relevant tools based on message content
      const selectedTools = selectTools(message, tools, ctx.chat.type);
      console.log(`[telegram] Selected ${selectedTools.length} tools: ${selectedTools.map(t => t.name).join(', ')}`);

      // Prepend user context so the LLM knows who it's talking to and where
      const userName = ctx.from?.first_name ?? ctx.from?.username ?? 'Unknown';
      const chatType = ctx.chat.type === 'private' ? 'private DM' : 'group chat';
      const userCtx = `[From: ${userName}, Telegram ID: ${ctx.from?.id}, Chat: ${chatType}]\n`;

      // Get conversation history for this chat (enables multi-turn negotiation)
      const history = getChatHistory(chatId);

      // Run LLM tool loop via resilient wrapper
      const t0 = Date.now();
      const enrichedMessage = userCtx + message;
      const response = await config.llm.run(enrichedMessage, selectedTools, history);
      console.log(`[telegram] LLM responded in ${((Date.now() - t0) / 1000).toFixed(1)}s (${response.length} chars)`);

      // Record this exchange in conversation history
      appendChatHistory(chatId, 'user', enrichedMessage);
      appendChatHistory(chatId, 'assistant', response);

      // Split long messages (Telegram limit is 4096 chars)
      if (response.length <= 4096) {
        await ctx.reply(response, { parse_mode: undefined });
      } else {
        const chunks = splitMessage(response, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: undefined });
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] LLM failed for chat ${chatId}: ${errMsg}`);

      // Try degraded mode — handle simple commands without LLM
      const degradedResponse = await handleDegradedMode(message, config.degradedTools);
      if (degradedResponse) {
        await ctx.reply(degradedResponse, { parse_mode: undefined });
      } else {
        await ctx.reply(
          'AI is temporarily unavailable. Basic commands still work:\n' +
          '/balance — Check fund balance\n' +
          '/stats — Fund statistics\n' +
          '/help — Available commands',
        );
      }
    }
  });

  // Handle /balance command (works even without LLM)
  bot.command('balance', async (ctx) => {
    const result = await handleDegradedMode('/balance', config.degradedTools);
    await ctx.reply(result ?? 'Balance unavailable.', { parse_mode: undefined });
  });

  // Handle /stats command (works even without LLM)
  bot.command('stats', async (ctx) => {
    const result = await handleDegradedMode('/stats', config.degradedTools);
    await ctx.reply(result ?? 'Stats unavailable.', { parse_mode: undefined });
  });

  // Handle /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Panthers Fund Manager ready.\n\n' +
      'Ask me about:\n' +
      '- Fund status and strategy\n' +
      '- Trading strategies (10 available)\n' +
      '- Jupiter swap quotes\n' +
      '- Wallet addresses\n' +
      '- Portfolio balances\n' +
      '- Trade history and P&L\n' +
      '- NFT accounts\n' +
      '- Buy an NFT (dynamic pricing)\n' +
      '- P2P marketplace (list/buy NFTs)\n' +
      '- Withdraw (exit the fund)'
    );
  });

  // Handle /health command
  bot.command('health', async (ctx) => {
    await ctx.reply('Bot is running.');
  });

  return bot;
}

/** Send a message to a chat (used by cron for alerts). */
export async function sendAlert(bot: Bot, chatId: string | number, message: string): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, message);
  } catch (err: unknown) {
    console.error(`[telegram] Failed to send alert to ${chatId}:`, err);
  }
}

/**
 * Handle simple commands without LLM (degraded mode).
 * Returns a response string, or null if the command isn't recognized.
 */
async function handleDegradedMode(
  message: string,
  degradedTools?: Map<string, Tool>,
): Promise<string | null> {
  if (!degradedTools) return null;

  const lower = message.trim().toLowerCase();

  if (lower === '/balance' || lower === 'balance' || lower.includes('balance')) {
    const tool = degradedTools.get('get_fund_state');
    if (tool) {
      try {
        return await tool.execute({});
      } catch { return null; }
    }
  }

  if (lower === '/stats' || lower === 'stats' || lower.includes('statistics')) {
    const tool = degradedTools.get('get_trade_history');
    if (tool) {
      try {
        return await tool.execute({});
      } catch { return null; }
    }
  }

  if (lower === '/help' || lower === 'help') {
    return (
      'Available commands (degraded mode — AI temporarily offline):\n' +
      '/balance — Current fund balance and state\n' +
      '/stats — Recent trade history\n' +
      '/help — This message\n\n' +
      'Full AI mode will resume automatically when the backend recovers.'
    );
  }

  return null;
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
