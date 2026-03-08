import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import type {
  JupiterQuote,
  JupiterQuoteParams,
  JupiterSwapParams,
  JupiterSwapResult,
} from './types.js';

const JUPITER_API = 'https://api.jup.ag/swap/v1';

export interface JupiterClientConfig {
  rpcUrl: string;
  keypair: Keypair;
  apiBase?: string; // override for testing
  apiKey?: string;  // Jupiter API key (x-api-key header)
}

export class JupiterClient {
  private readonly connection: Connection;
  private readonly keypair: Keypair;
  private readonly apiBase: string;
  private readonly apiKey?: string;

  constructor(config: JupiterClientConfig) {
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    this.keypair = config.keypair;
    this.apiBase = config.apiBase ?? JUPITER_API;
    this.apiKey = config.apiKey;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  // ── Quote ─────────────────────────────────────────────────

  async getQuote(params: JupiterQuoteParams): Promise<JupiterQuote> {
    const slippage = params.slippageBps ?? 50;
    const url = new URL(`${this.apiBase}/quote`);
    url.searchParams.set('inputMint', params.inputMint);
    url.searchParams.set('outputMint', params.outputMint);
    url.searchParams.set('amount', params.amount);
    url.searchParams.set('slippageBps', String(slippage));

    const res = await fetch(url.toString(), { headers: this.headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jupiter quote failed (${res.status}): ${body}`);
    }
    return (await res.json()) as JupiterQuote;
  }

  // ── Swap (quote → tx → sign → send → confirm finalized) ──

  async swap(params: JupiterSwapParams): Promise<JupiterSwapResult> {
    // 1. Get quote
    const quote = await this.getQuote(params);

    // 2. Request swap transaction
    const swapRes = await fetch(`${this.apiBase}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.keypair.publicKey.toBase58(),
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });

    if (!swapRes.ok) {
      const body = await swapRes.text();
      throw new Error(`Jupiter swap failed (${swapRes.status}): ${body}`);
    }

    const swapData = (await swapRes.json()) as { swapTransaction: string };

    // 3. Deserialize and sign the VersionedTransaction
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([this.keypair]);

    // 4. Send raw transaction
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });

    // 5. Confirm with finalized commitment
    const latestBlockhash = await this.connection.getLatestBlockhash('finalized');
    const confirmation = await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'finalized',
    );

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    return {
      signature,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
    };
  }
}
