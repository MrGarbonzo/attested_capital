# LLM Resilience - SecretAI Only (No Fallback)

**Your Concern:** "Will OpenAI fallback work with our 45 tools? Want to stick with SecretAI only."

**Better Solution:** Make SecretAI more resilient WITHOUT adding fallback providers.

---

## 🎯 Option A: Aggressive Retry with Circuit Breaker (Recommended)

Instead of falling back to OpenAI, just **retry SecretAI smarter**.

### **Implementation:**

```typescript
export class ResilientSecretAI {
  private failureCount: number = 0;
  private circuitOpen: boolean = false;
  private lastFailure: number = 0;
  
  async chat(messages: any[], tools: any[]) {
    // Check circuit breaker
    if (this.circuitOpen) {
      const timeSinceFailure = Date.now() - this.lastFailure;
      
      if (timeSinceFailure < 60000) {
        // Circuit still open (< 1 min since last failure)
        throw new Error(
          `SecretAI temporarily unavailable. ` +
          `Try again in ${Math.ceil((60000 - timeSinceFailure) / 1000)}s`
        );
      } else {
        // Try to close circuit (test if SecretAI is back)
        console.log("Circuit breaker: Testing if SecretAI recovered...");
        this.circuitOpen = false;
        this.failureCount = 0;
      }
    }
    
    // Retry logic with exponential backoff
    const maxRetries = 3;
    const baseDelay = 2000; // 2 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`SecretAI attempt ${attempt}/${maxRetries}...`);
        
        const response = await Promise.race([
          this.client.chat.completions.create({
            model: process.env.SECRET_AI_MODEL || 'qwen3:8b',
            messages: messages,
            tools: tools,
            tool_choice: 'auto'
          }),
          this.timeout(30000) // 30 second timeout
        ]);
        
        // Success! Reset failure count
        this.failureCount = 0;
        console.log(`✅ SecretAI success (attempt ${attempt})`);
        return response;
        
      } catch (error: any) {
        console.error(`❌ SecretAI attempt ${attempt} failed:`, error.message);
        
        this.failureCount++;
        this.lastFailure = Date.now();
        
        // Last attempt failed - open circuit
        if (attempt === maxRetries) {
          if (this.failureCount >= 5) {
            console.warn("⚠️  Opening circuit breaker (5 consecutive failures)");
            this.circuitOpen = true;
          }
          
          // Re-throw on last attempt
          throw new Error(
            `SecretAI failed after ${maxRetries} attempts. ` +
            `Last error: ${error.message}`
          );
        }
        
        // Wait before retry (exponential backoff)
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`  Retrying in ${delay}ms...`);
        await this.sleep(delay);
      }
    }
  }
  
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), ms);
    });
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  getStatus() {
    return {
      circuitOpen: this.circuitOpen,
      failureCount: this.failureCount,
      lastFailure: this.lastFailure ? new Date(this.lastFailure).toISOString() : null
    };
  }
}
```

### **User Experience:**

```
User: /balance

Attempt 1: Timeout (30s)
  → Retry in 2s...
  
Attempt 2: 500 error
  → Retry in 4s...
  
Attempt 3: 500 error
  → Circuit breaker opens
  
Bot: "⚠️ SecretAI is having issues. Try again in 1 minute."

[After 1 minute]
User: /balance
  → Circuit closed, try again
  → Success! ✓
```

**Benefits:**
- ✅ Keeps using SecretAI (your tools work)
- ✅ Handles temporary outages (retries with backoff)
- ✅ Circuit breaker prevents hammering dead service
- ✅ Clear user feedback
- ✅ No OpenAI dependency

---

## 🎯 Option B: Degraded Mode (Command Parsing)

If SecretAI is completely down, fall back to **simple command parsing** (no LLM).

### **Implementation:**

```typescript
export class TelegramBot {
  async handleMessage(ctx: any) {
    const text = ctx.message.text;
    
    try {
      // Try full LLM flow
      const response = await this.llm.chat(
        [{ role: 'user', content: text }],
        this.tools
      );
      
      await this.processLLMResponse(response, ctx);
      
    } catch (error) {
      console.error("LLM failed, trying degraded mode...");
      
      // Fall back to simple command parsing
      const handled = await this.handleDegradedMode(text, ctx);
      
      if (!handled) {
        await ctx.reply(
          "⚠️ AI services temporarily unavailable.\n\n" +
          "Available commands:\n" +
          "/balance - Check your NFT value\n" +
          "/stats - Fund statistics\n" +
          "/help - List all commands\n\n" +
          "Or try again in a few minutes."
        );
      }
    }
  }
  
  async handleDegradedMode(text: string, ctx: any): Promise<boolean> {
    const lower = text.toLowerCase().trim();
    
    // Balance check
    if (lower.includes('/balance') || lower.includes('how much')) {
      const userId = ctx.from.id;
      const nft = await this.db.getNFTByTelegramId(userId);
      
      if (nft) {
        await ctx.reply(
          `💰 Your Balance\n\n` +
          `Panther #${nft.id}: $${nft.value.toFixed(2)}\n` +
          `Initial: $${nft.initialDeposit.toFixed(2)}\n` +
          `P&L: ${nft.value > nft.initialDeposit ? '+' : ''}$${(nft.value - nft.initialDeposit).toFixed(2)} ` +
          `(${((nft.value / nft.initialDeposit - 1) * 100).toFixed(2)}%)`
        );
      } else {
        await ctx.reply("You don't own any Panthers NFTs yet. Use /buy to get started!");
      }
      return true;
    }
    
    // Stats
    if (lower.includes('/stats') || lower.includes('statistics')) {
      const state = await this.db.getFundState();
      const trades = await this.db.getRecentTrades(10);
      
      await ctx.reply(
        `📊 Fund Statistics\n\n` +
        `Pool Balance: $${state.poolBalance.toFixed(2)}\n` +
        `Active NFTs: ${state.activeNFTCount}\n` +
        `Total Trades: ${state.totalTrades}\n` +
        `Current Strategy: ${state.currentStrategy}\n` +
        `Last Trade: ${trades[0] ? new Date(trades[0].timestamp).toLocaleString() : 'None'}`
      );
      return true;
    }
    
    // Help
    if (lower.includes('/help') || lower.includes('help')) {
      await ctx.reply(
        `🐆 Panthers Fund Commands\n\n` +
        `/balance - Check your NFT value\n` +
        `/stats - Fund statistics\n` +
        `/buy - Purchase an NFT\n` +
        `/sell - List your NFT for sale\n` +
        `/withdraw - Exit the fund (2% fee)\n` +
        `/vote <strategy> - Vote on trading strategy\n\n` +
        `⚠️ AI mode unavailable - using simple commands`
      );
      return true;
    }
    
    // Not recognized
    return false;
  }
}
```

**User Experience:**

```
SecretAI working (normal):
User: "hey what's my balance looking like?"
Bot: "Your Panther #5 is worth $103.50, up 3.5% from your initial $100 deposit! 🐆"

SecretAI down (degraded):
User: "hey what's my balance looking like?"
Bot: "💰 Your Balance
     Panther #5: $103.50
     Initial: $100.00
     P&L: +$3.50 (3.5%)"
```

**Benefits:**
- ✅ Core functionality still works (balance, stats)
- ✅ Users can still interact with fund
- ✅ No LLM dependency for critical commands
- ✅ Graceful degradation

---

## 🎯 Option C: Hybrid (Recommended)

**Combine both approaches:**

```typescript
export class TelegramBot {
  async handleMessage(ctx: any) {
    const text = ctx.message.text;
    
    try {
      // Try full LLM with retries + circuit breaker
      const response = await this.resilientLLM.chat(
        [{ role: 'user', content: text }],
        this.tools
      );
      
      await this.processLLMResponse(response, ctx);
      
    } catch (error) {
      // LLM completely unavailable
      console.error("LLM unavailable, degraded mode...");
      
      const handled = await this.handleDegradedMode(text, ctx);
      
      if (!handled) {
        const status = this.resilientLLM.getStatus();
        
        await ctx.reply(
          `⚠️ AI services temporarily down.\n\n` +
          `Status: ${status.circuitOpen ? '🔴 Circuit breaker active' : '🟡 Recovering'}\n` +
          `Failures: ${status.failureCount}\n\n` +
          `Basic commands still work:\n` +
          `/balance /stats /help\n\n` +
          `Full AI will return shortly.`
        );
      }
    }
  }
}
```

---

## 📊 Comparison

| Approach | Pros | Cons |
|----------|------|------|
| **A: Retry + Circuit Breaker** | No new dependencies, handles temporary outages | Users wait during retries |
| **B: Degraded Mode** | Always responsive | Limited functionality |
| **C: Hybrid** | Best of both worlds | More code complexity |
| **OpenAI Fallback** | Full functionality always | Expensive, tool compatibility risk |

---

## ✅ My Recommendation: Option C (Hybrid)

**Why:**
1. Retries handle **temporary** SecretAI issues (network blips, restarts)
2. Circuit breaker prevents hammering **dead** service
3. Degraded mode keeps **critical** functions working
4. Users get **clear** status about what's happening

**Implementation Time:** 2-3 hours (same as OpenAI fallback, but better!)

---

## 🚀 Quick Start

```bash
# No new dependencies needed!
# Just implement ResilientSecretAI + degraded mode

cd panthers-fund/src/telegram
# Create resilient-secretai.ts (code above)
# Update bot.ts to use it

npm run build && npm run deploy
```

**This keeps you on SecretAI-only while being much more resilient!** 🎯
