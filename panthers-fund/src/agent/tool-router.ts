import type { Tool } from './tools.js';

interface CategoryRule {
  categories: string[];
  keywords: RegExp;
}

const RULES: CategoryRule[] = [
  {
    categories: ['jupiter', 'wallet', 'balances'],
    keywords: /\b(jupiter|quote|swap|exchange|convert|trade sol|trade usdc|lamport)\b/i,
  },
  {
    categories: ['trades', 'fund'],
    keywords: /\b(trade history|record trade|trade allocat|p&l|pnl|profit|loss|daily stats|trading cycle|open position)\b/i,
  },
  {
    categories: ['fund', 'strategies'],
    keywords: /\b(fund state|fund status|strategy|strategies|invariant|paused?|unpause|health|trading config)\b/i,
  },
  {
    categories: ['accounts'],
    keywords: /\b(nft|account|token.?id|deposit|create account|add funds|participant)\b/i,
  },
  {
    categories: ['balances'],
    keywords: /\b(balance|portfolio|snapshot|solana bal)\b/i,
  },
  {
    categories: ['wallet'],
    keywords: /\b(wallet|address|addresses|public key)\b/i,
  },
  {
    categories: ['sales', 'accounts'],
    keywords: /\b(buy|purchase|price|pricing|mint|auction|flash|offer|negotiate|sales? stats?|how much|cost|deal|discount|cheap|afford|grab one|get one|for \$|willing to pay|bargain|haggle)\b|\$\d/i,
  },
  {
    categories: ['marketplace'],
    keywords: /\b(marketplace|listing|list for sale|p2p|sell nft|listings?|market)\b/i,
  },
  {
    categories: ['withdrawal'],
    keywords: /\b(withdraw|withdrawal|exit|cash out|burn|leave fund|redeem)\b/i,
  },
  {
    categories: ['guardian'],
    keywords: /\b(guardian|guardians|discover|sentry|sentries|peer|peers|announce|broadcast|register.*guardian)\b/i,
  },
];

/**
 * Select relevant tools for a user message using keyword matching.
 * Returns a filtered subset of tools (typically 3-6), or all tools
 * if no keywords match (fallback for ambiguous queries).
 *
 * @param chatType - 'private' for DMs, 'group'/'supergroup' for group chats
 */
export function selectTools(message: string, allTools: Tool[], chatType?: string): Tool[] {
  const matched = new Set<string>();

  for (const rule of RULES) {
    if (rule.keywords.test(message)) {
      for (const cat of rule.categories) matched.add(cat);
    }
  }

  // In private DMs, always include sales tools — DMs are primarily for negotiation
  if (chatType === 'private') {
    matched.add('sales');
    matched.add('accounts');
  }

  // No keywords matched — return a general-purpose subset
  if (matched.size === 0) {
    matched.add('fund');
    matched.add('wallet');
    matched.add('balances');
  }

  const selected = allTools.filter(t => matched.has(t.category));

  // Always include get_fund_state for context if not already present
  if (!selected.some(t => t.name === 'get_fund_state')) {
    const fundState = allTools.find(t => t.name === 'get_fund_state');
    if (fundState) selected.push(fundState);
  }

  return selected;
}
