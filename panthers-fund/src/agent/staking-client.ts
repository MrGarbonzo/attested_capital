/**
 * Thin HTTP client for guardian staking API.
 * All outbound staking calls go through this relay.
 */

export interface StakeResult {
  staked: number[];
  failed: Array<{ tokenId: number; error: string }>;
}

export interface NFTStakeRemote {
  token_id: number;
  owner_tg_id: string;
  guardian_address: string;
  current_value: number;
  staked_at: string;
  is_active: number;
}

export interface StakingClient {
  stakeNFTs(endpoint: string, guardianAddress: string, ownerTgId: string, tokenIds: number[]): Promise<StakeResult>;
  unstake(endpoint: string, guardianAddress: string, ownerTgId: string): Promise<{ unstaked: number }>;
  getStakesByOwner(endpoint: string, ownerTgId: string): Promise<NFTStakeRemote[]>;
  getGuardianStakes(endpoint: string, guardianAddress: string): Promise<{ stakes: NFTStakeRemote[]; totalValue: number }>;
}

async function guardianFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    let msg: string;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      msg = parsed.error ?? body;
    } catch {
      msg = body;
    }
    throw new Error(`Guardian API ${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

export function createStakingClient(): StakingClient {
  return {
    async stakeNFTs(endpoint, guardianAddress, ownerTgId, tokenIds) {
      return guardianFetch<StakeResult>(
        `${endpoint.replace(/\/$/, '')}/api/staking/stake`,
        {
          method: 'POST',
          body: JSON.stringify({ guardianAddress, ownerTgId, tokenIds }),
        },
      );
    },

    async unstake(endpoint, guardianAddress, ownerTgId) {
      return guardianFetch<{ unstaked: number }>(
        `${endpoint.replace(/\/$/, '')}/api/staking/unstake`,
        {
          method: 'POST',
          body: JSON.stringify({ guardianAddress, ownerTgId }),
        },
      );
    },

    async getStakesByOwner(endpoint, ownerTgId) {
      const result = await guardianFetch<{ stakes: NFTStakeRemote[] }>(
        `${endpoint.replace(/\/$/, '')}/api/staking/owner/${encodeURIComponent(ownerTgId)}`,
      );
      return result.stakes;
    },

    async getGuardianStakes(endpoint, guardianAddress) {
      return guardianFetch<{ stakes: NFTStakeRemote[]; totalValue: number }>(
        `${endpoint.replace(/\/$/, '')}/api/staking/guardian/${encodeURIComponent(guardianAddress)}`,
      );
    },
  };
}
