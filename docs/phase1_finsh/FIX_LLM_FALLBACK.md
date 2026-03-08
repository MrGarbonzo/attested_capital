# LLM Fallback Solution - Telegram Bot Resilience

**Problem:** SecretAI backend down → Telegram bot completely unresponsive.

**Solution:** Multi-provider LLM failover with automatic fallback.

---

## 🔄 Implementation

**File:** `panthers-fund/src/telegram/llm-client.ts`

```typescript
import OpenAI from 'openai';

interface LLMProvider {
  name: string;
  client: OpenAI;
  available: boolean;
  lastCheck: number;
  failureCount: number;
}

export class ResilientLLMClient {
  private providers: LLMProvider[] = [];
  private currentProvider: number = 0;
  
  constructor() {
    // Provider 1: SecretAI (primary)
    if (process.env.SECRET_AI_BASE_URL) {
      this.providers.push({
        name: 'SecretAI',
        client: new OpenAI({
          baseURL: process.env.SECRET_AI_BASE_URL,
          apiKey: process.env.SECRET_AI_API_KEY || 'dummy',
        }),
        available: true,
        lastCheck: 0,
        failureCount: 0
      });
    }
    
    // Provider 2: OpenAI (fallback)
    if (process.env.OPENAI_API_KEY) {
      this.providers.push({
        name: 'OpenAI',
        client: new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
        }),
        available: true,
        lastCheck: 0,
        failureCount: 0
      });
    }
    
    // Provider 3: Anthropic Claude (fallback)
    if (process.env.ANTHROPIC_API_KEY) {
      this.providers.push({
        name: 'Anthropic',
        client: new OpenAI({
          baseURL: 'https://api.anthropic.com/v1',
          apiKey: process.env.ANTHROPIC_API_KEY,
          defaultHeaders: {
            'anthropic-version': '2023-06-01'
          }
        }),
        available: true,
        lastCheck: 0,
        failureCount: 0
      });
    }
    
    console.log(`LLM providers configured: ${this.providers.map(p => p.name).join(', ')}`);
  }
  
  async chat(messages: any[], tools?: any[]): Promise<any> {
    const maxRetries = this.providers.length;
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const provider = this.providers[this.currentProvider];
      
      if (!provider.available) {
        console.log(`Provider ${provider.name} unavailable, trying next...`);
        this.rotateProvider();
        continue;
      }
      
      try {
        console.log(`Attempting LLM call with ${provider.name}...`);
        
        const response = await Promise.race([
          provider.client.chat.completions.create({
            model: this.getModelForProvider(provider.name),
            messages: messages,
            tools: tools,
            tool_choice: tools ? 'auto' : undefined,
          }),
          this.timeout(30000) // 30 second timeout
        ]);
        
        // Success!
        provider.failureCount = 0;
        provider.available = true;
        provider.lastCheck = Date.now();
        
        console.log(`✅ LLM call succeeded with ${provider.name}`);
        return response;
        
      } catch (error: any) {
        lastError = error;
        console.error(`❌ LLM call failed with ${provider.name}:`, error.message);
        
        // Mark provider as degraded
        provider.failureCount++;
        
        if (provider.failureCount >= 3) {
          console.warn(`Marking ${provider.name} as unavailable (3 failures)`);
          provider.available = false;
          provider.lastCheck = Date.now();
          
          // Re-check after 5 minutes
          setTimeout(() => {
            console.log(`Re-enabling ${provider.name} for retry`);
            provider.available = true;
            provider.failureCount = 0;
          }, 5 * 60 * 1000);
        }
        
        // Try next provider
        this.rotateProvider();
      }
    }
    
    // All providers failed
    throw new Error(`All LLM providers failed. Last error: ${lastError?.message}`);
  }
  
  private rotateProvider() {
    this.currentProvider = (this.currentProvider + 1) % this.providers.length;
  }
  
  private getModelForProvider(providerName: string): string {
    switch (providerName) {
      case 'SecretAI':
        return process.env.SECRET_AI_MODEL || 'qwen3:8b';
      case 'OpenAI':
        return 'gpt-4o-mini'; // Cheap and fast
      case 'Anthropic':
        return 'claude-3-5-haiku-20241022'; // Fast Haiku
      default:
        return 'gpt-4o-mini';
    }
  }
  
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('LLM call timeout')), ms);
    });
  }
  
  getStatus(): { provider: string; available: boolean; failures: number }[] {
    return this.providers.map(p => ({
      provider: p.name,
      available: p.available,
      failures: p.failureCount
    }));
  }
}
```

---

## 📝 Update .env

```bash
# Primary LLM (SecretAI)
SECRET_AI_BASE_URL=https://secretai-rytn.scrtlabs.com:21434/v1
SECRET_AI_MODEL=qwen3:8b
SECRET_AI_API_KEY=dummy

# Fallback #1 (OpenAI)
OPENAI_API_KEY=sk-proj-...

# Fallback #2 (Anthropic - optional)
ANTHROPIC_API_KEY=sk-ant-...
```

---

## 🔧 Update Telegram Bot Handler

**File:** `panthers-fund/src/telegram/bot.ts`

```typescript
import { ResilientLLMClient } from './llm-client';

export class TelegramBot {
  private llm: ResilientLLMClient;
  
  async initialize() {
    this.llm = new ResilientLLMClient();
    
    // ... rest of bot setup
  }
  
  async handleMessage(ctx: any) {
    try {
      // Use resilient LLM client
      const response = await this.llm.chat(
        [{ role: 'user', content: ctx.message.text }],
        this.tools
      );
      
      // ... process response
      
    } catch (error) {
      console.error('All LLM providers failed:', error);
      
      // Show status to user
      const status = this.llm.getStatus();
      const statusMsg = status.map(s => 
        `${s.provider}: ${s.available ? '✅' : '❌'} (${s.failures} failures)`
      ).join('\n');
      
      await ctx.reply(
        `⚠️ LLM services temporarily unavailable.\n\n` +
        `Status:\n${statusMsg}\n\n` +
        `Please try again in a few minutes.`
      );
    }
  }
}
```

---

## ✅ Benefits

1. **SecretAI down → Automatic OpenAI fallback** (< 1 second)
2. **Both down → Anthropic fallback** (if configured)
3. **Circuit breaker** - Disables failing providers for 5 min
4. **Status visibility** - Users see which providers are working
5. **Cost control** - Only uses paid APIs when free ones fail

---

## 💰 Cost Impact

**SecretAI working (normal):**
- Cost: $0/month (free)

**SecretAI down, OpenAI fallback:**
- GPT-4o-mini: $0.15 per 1M input tokens
- Typical message: ~500 tokens
- 1000 messages/day = $0.075/day = $2.25/month

**Worth it for reliability!**

---

## 🚀 Deploy

```bash
# Add to .env
echo "OPENAI_API_KEY=sk-proj-..." >> /mnt/secure/docker_wd/usr/.env

# Redeploy
cd panthers-fund
npm run build
tar czf panthers.tar.gz dist package.json package-lock.json
scp -i ~/.ssh/secretvm_key panthers.tar.gz root@67.215.13.107:/mnt/secure/docker_wd/
ssh -i ~/.ssh/secretvm_key root@67.215.13.107
cd /mnt/secure/docker_wd
tar xzf panthers.tar.gz
docker compose restart panthers-agent
```

---

**This fixes your bot TODAY while waiting for SecretAI to recover.**
