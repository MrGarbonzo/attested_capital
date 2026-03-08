export class InvariantViolationError extends Error {
  constructor(
    public readonly invariant: string,
    public readonly details: string,
  ) {
    super(`Invariant violation [${invariant}]: ${details}`);
    this.name = 'InvariantViolationError';
  }
}

export class FundPausedError extends Error {
  constructor(public readonly operation: string) {
    super(`Fund is paused — cannot perform: ${operation}`);
    this.name = 'FundPausedError';
  }
}

export class AccountNotFoundError extends Error {
  constructor(public readonly tokenId: number) {
    super(`NFT account not found: token_id=${tokenId}`);
    this.name = 'AccountNotFoundError';
  }
}
