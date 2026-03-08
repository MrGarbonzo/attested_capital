import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, MessageV0, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { JupiterClient } from '../../src/jupiter/jupiter-client.js';

// ── Helpers ─────────────────────────────────────────────────

const TEST_KEYPAIR = Keypair.generate();
const MOCK_RPC = 'https://mock-rpc.test';

const MOCK_QUOTE = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  inAmount: '1000000000',
  outAmount: '25000000',
  otherAmountThreshold: '24875000',
  swapMode: 'ExactIn',
  slippageBps: 50,
  priceImpactPct: '0.01',
  routePlan: [],
};

/** Build a minimal valid serialized VersionedTransaction for testing. */
function buildMockSwapTxBase64(): string {
  const message = MessageV0.compile({
    payerKey: TEST_KEYPAIR.publicKey,
    instructions: [],
    recentBlockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
  });

  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString('base64');
}

describe('JupiterClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Quote ─────────────────────────────────────────────────

  describe('getQuote', () => {
    it('constructs correct quote URL with params', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_QUOTE), { status: 200 }),
      );

      const client = new JupiterClient({ rpcUrl: MOCK_RPC, keypair: TEST_KEYPAIR });
      await client.getQuote({
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amount: '1000000000',
        slippageBps: 50,
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/quote');
      expect(calledUrl).toContain('inputMint=So11111111111111111111111111111111111111112');
      expect(calledUrl).toContain('outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      expect(calledUrl).toContain('amount=1000000000');
      expect(calledUrl).toContain('slippageBps=50');
    });

    it('parses quote response correctly', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_QUOTE), { status: 200 }),
      );

      const client = new JupiterClient({ rpcUrl: MOCK_RPC, keypair: TEST_KEYPAIR });
      const quote = await client.getQuote({
        inputMint: MOCK_QUOTE.inputMint,
        outputMint: MOCK_QUOTE.outputMint,
        amount: MOCK_QUOTE.inAmount,
      });

      expect(quote.inputMint).toBe(MOCK_QUOTE.inputMint);
      expect(quote.outputMint).toBe(MOCK_QUOTE.outputMint);
      expect(quote.inAmount).toBe('1000000000');
      expect(quote.outAmount).toBe('25000000');
      expect(quote.slippageBps).toBe(50);
    });

    it('throws on API error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Rate limited', { status: 429 }),
      );

      const client = new JupiterClient({ rpcUrl: MOCK_RPC, keypair: TEST_KEYPAIR });
      await expect(
        client.getQuote({
          inputMint: MOCK_QUOTE.inputMint,
          outputMint: MOCK_QUOTE.outputMint,
          amount: '1000000000',
        }),
      ).rejects.toThrow('Jupiter quote failed (429)');
    });
  });

  // ── Swap ──────────────────────────────────────────────────

  describe('swap', () => {
    it('throws on swap API error', async () => {
      // Quote succeeds
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_QUOTE), { status: 200 }),
      );
      // Swap fails
      fetchSpy.mockResolvedValueOnce(
        new Response('Internal error', { status: 500 }),
      );

      const client = new JupiterClient({ rpcUrl: MOCK_RPC, keypair: TEST_KEYPAIR });
      await expect(
        client.swap({
          inputMint: MOCK_QUOTE.inputMint,
          outputMint: MOCK_QUOTE.outputMint,
          amount: '1000000000',
        }),
      ).rejects.toThrow('Jupiter swap failed (500)');
    });

    it('sends POST to /swap with quote and user public key', async () => {
      // Quote succeeds
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_QUOTE), { status: 200 }),
      );

      const mockTxBase64 = buildMockSwapTxBase64();

      // Swap returns a tx
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ swapTransaction: mockTxBase64 }), { status: 200 }),
      );

      const client = new JupiterClient({ rpcUrl: MOCK_RPC, keypair: TEST_KEYPAIR });

      // The swap will fail at sendRawTransaction since we're not mocking the Connection,
      // but we can verify the POST was made correctly
      try {
        await client.swap({
          inputMint: MOCK_QUOTE.inputMint,
          outputMint: MOCK_QUOTE.outputMint,
          amount: '1000000000',
        });
      } catch {
        // Expected — no real RPC
      }

      // Verify the swap POST call
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const swapCall = fetchSpy.mock.calls[1];
      const swapUrl = swapCall[0] as string;
      expect(swapUrl).toContain('/swap');

      const swapBody = JSON.parse((swapCall[1] as RequestInit).body as string);
      expect(swapBody.userPublicKey).toBe(TEST_KEYPAIR.publicKey.toBase58());
      expect(swapBody.quoteResponse).toEqual(MOCK_QUOTE);
    });

    it('uses default slippageBps of 50 when not specified', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_QUOTE), { status: 200 }),
      );

      const client = new JupiterClient({ rpcUrl: MOCK_RPC, keypair: TEST_KEYPAIR });

      // Just check the quote URL
      try {
        await client.getQuote({
          inputMint: MOCK_QUOTE.inputMint,
          outputMint: MOCK_QUOTE.outputMint,
          amount: '1000000000',
          // no slippageBps
        });
      } catch {
        // ok
      }

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('slippageBps=50');
    });
  });
});
