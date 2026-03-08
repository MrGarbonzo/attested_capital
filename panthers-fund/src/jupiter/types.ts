export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: string;       // lamports as string
  slippageBps?: number; // default 50 (0.5%)
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
}

export interface JupiterSwapParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}

export interface JupiterSwapResult {
  signature: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
}
