/**
 * SolanaRegistryClient — on-chain discovery registry implementing RegistryClient.
 *
 * Replaces LocalRegistryClient for production use. Reads/writes to a Solana
 * program that stores endpoint + TEE identity for each registered node.
 * Agents and guardians find each other by querying this registry.
 */
import { createHash } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type {
  RegistryClient,
  AgentRecord,
  RegistrationRequest,
  HeartbeatPayload,
  HeartbeatCheckResult,
} from './registry-types.js';


// ── Types ─────────────────────────────────────────────────────────

/** Decoded registry entry with string-encoded fields. */
export interface RegistryEntry {
  entityType: 'agent' | 'guardian';
  endpoint: string;
  teeInstanceId: string;
  codeHash: string;
  attestationHash: string;
  ed25519Pubkey: string;
  registeredAt: number;
  lastHeartbeat: number;
  isActive: boolean;
  owner: string;
}

/** Input for registerSelf. */
export interface RegisterSelfInput {
  entityType: 'agent' | 'guardian';
  endpoint: string;
  teeInstanceId: string;
  codeHash: string;
  attestationHash: string;
  ed25519Pubkey: string;
  isActive: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────

function anchorDiscriminator(name: string): Buffer {
  return Buffer.from(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
}

function getEntryPDA(programId: PublicKey, owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('entry'), owner.toBuffer()],
    programId,
  );
}

function hexFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function base64FromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function bytesFromHex(hex: string, len: number): number[] {
  const buf = Buffer.alloc(len);
  if (hex) Buffer.from(hex, 'hex').copy(buf);
  return Array.from(buf);
}

function bytesFromBase64(b64: string, len: number): number[] {
  const buf = Buffer.alloc(len);
  if (b64) Buffer.from(b64, 'base64').copy(buf);
  return Array.from(buf);
}

const ENTITY_TYPE_OFFSET = 8;
const HEARTBEAT_TIMEOUT_SECONDS = 300;

function decodeEntry(data: Buffer, owner: string): RegistryEntry | null {
  try {
    let offset = 8; // skip discriminator

    const entityType = data.readUint8(offset);
    offset += 1;

    const endpointLen = data.readUint32LE(offset);
    offset += 4;
    const endpoint = data.subarray(offset, offset + endpointLen).toString('utf8');
    offset += endpointLen;

    const teeInstanceId = hexFromBytes(data.subarray(offset, offset + 16));
    offset += 16;

    const codeHash = hexFromBytes(data.subarray(offset, offset + 32));
    offset += 32;

    const attestationHash = hexFromBytes(data.subarray(offset, offset + 32));
    offset += 32;

    const ed25519Pubkey = base64FromBytes(data.subarray(offset, offset + 32));
    offset += 32;

    const registeredAt = Number(data.readBigInt64LE(offset));
    offset += 8;

    const lastHeartbeat = Number(data.readBigInt64LE(offset));
    offset += 8;

    const isActive = data.readUint8(offset) !== 0;

    return {
      entityType: entityType === 0 ? 'agent' : 'guardian',
      endpoint, teeInstanceId, codeHash, attestationHash,
      ed25519Pubkey, registeredAt, lastHeartbeat, isActive, owner,
    };
  } catch {
    return null;
  }
}

const DISC = {
  register: anchorDiscriminator('register'),
  heartbeat: anchorDiscriminator('heartbeat'),
  update_endpoint: anchorDiscriminator('update_endpoint'),
  deactivate: anchorDiscriminator('deactivate'),
};

// ── Client ────────────────────────────────────────────────────────

export class SolanaRegistryClient implements RegistryClient {
  constructor(
    private connection: Connection,
    private keypair: Keypair,
    private programId: PublicKey,
  ) {}

  // ── RegistryClient interface ──────────────────────────────────

  async getCurrentAgent(): Promise<AgentRecord | null> {
    const agents = await this.getAgents();
    const active = agents.find(a => a.isActive);
    if (!active) return null;

    return {
      teeInstanceId: active.teeInstanceId,
      codeHash: active.codeHash,
      isActive: active.isActive,
      lastHeartbeat: new Date(active.lastHeartbeat * 1000).toISOString(),
      registeredAt: new Date(active.registeredAt * 1000).toISOString(),
      registeredBy: active.owner,
    };
  }

  async registerAgent(request: RegistrationRequest): Promise<{ success: boolean; error?: string }> {
    try {
      await this.registerSelf({
        entityType: 'agent',
        endpoint: request.endpoint,
        teeInstanceId: request.teeInstanceId,
        codeHash: request.codeHash,
        attestationHash: '',
        ed25519Pubkey: request.ed25519PubkeyBase64 ?? '',
        isActive: true,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async heartbeat(_payload: HeartbeatPayload): Promise<{ success: boolean; error?: string }> {
    try {
      await this.sendHeartbeat();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async checkHeartbeat(): Promise<HeartbeatCheckResult | null> {
    const entry = await this.getOwnEntry();
    if (!entry) return null;

    const secondsSince = Math.floor(Date.now() / 1000) - entry.lastHeartbeat;
    return {
      isActive: entry.isActive,
      secondsSinceHeartbeat: secondsSince,
      shouldDeactivate: secondsSince > HEARTBEAT_TIMEOUT_SECONDS,
    };
  }

  async deactivateAgent(_teeInstanceId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const data = Buffer.alloc(8);
      DISC.deactivate.copy(data);
      const [entryPDA] = getEntryPDA(this.programId, this.keypair.publicKey);

      await this.sendTx([{
        keys: [
          { pubkey: entryPDA, isSigner: false, isWritable: true },
          { pubkey: this.keypair.publicKey, isSigner: true, isWritable: false },
        ],
        programId: this.programId,
        data,
      }]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async isRegistered(teeInstanceId: string): Promise<boolean> {
    const entry = await this.getOwnEntry();
    return entry !== null && entry.teeInstanceId === teeInstanceId && entry.isActive;
  }

  // ── Discovery methods ─────────────────────────────────────────

  async getAgents(): Promise<RegistryEntry[]> {
    return this.getEntriesByType(0);
  }

  async getGuardians(): Promise<RegistryEntry[]> {
    return this.getEntriesByType(1);
  }

  async registerSelf(input: RegisterSelfInput): Promise<string> {
    const [entryPDA] = getEntryPDA(this.programId, this.keypair.publicKey);

    const entityType = input.entityType === 'agent' ? 0 : 1;
    const codeHash = bytesFromHex(input.codeHash, 32);
    const attestationHash = bytesFromHex(input.attestationHash, 32);
    const ed25519Pubkey = bytesFromBase64(input.ed25519Pubkey, 32);

    const teeInstanceId = bytesFromHex(input.teeInstanceId, 16);

    const ix = this.buildRegisterIx(
      entryPDA, entityType, input.endpoint,
      teeInstanceId, codeHash, attestationHash, ed25519Pubkey,
    );
    return this.sendTx([ix]);
  }

  async sendHeartbeat(): Promise<string> {
    const [entryPDA] = getEntryPDA(this.programId, this.keypair.publicKey);
    const data = Buffer.alloc(8);
    DISC.heartbeat.copy(data);

    return this.sendTx([{
      keys: [
        { pubkey: entryPDA, isSigner: false, isWritable: true },
        { pubkey: this.keypair.publicKey, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data,
    }]);
  }

  async updateEndpoint(newEndpoint: string): Promise<string> {
    const [entryPDA] = getEntryPDA(this.programId, this.keypair.publicKey);

    const endpointBuf = Buffer.from(newEndpoint, 'utf8');
    const data = Buffer.alloc(8 + 4 + endpointBuf.length);
    let offset = 0;
    DISC.update_endpoint.copy(data, offset); offset += 8;
    data.writeUint32LE(endpointBuf.length, offset); offset += 4;
    endpointBuf.copy(data, offset);

    return this.sendTx([{
      keys: [
        { pubkey: entryPDA, isSigner: false, isWritable: true },
        { pubkey: this.keypair.publicKey, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data,
    }]);
  }

  async getOwnEntry(): Promise<RegistryEntry | null> {
    const [entryPDA] = getEntryPDA(this.programId, this.keypair.publicKey);
    try {
      const accountInfo = await this.connection.getAccountInfo(entryPDA);
      if (!accountInfo) return null;
      return decodeEntry(Buffer.from(accountInfo.data), this.keypair.publicKey.toBase58());
    } catch {
      return null;
    }
  }

  // ── Private ───────────────────────────────────────────────────

  private async getEntriesByType(entityType: number): Promise<RegistryEntry[]> {
    try {
      const entityTypeB58 = entityType === 0 ? '1' : '2';
      const accounts = await this.connection.getProgramAccounts(this.programId, {
        filters: [{
          memcmp: {
            offset: ENTITY_TYPE_OFFSET,
            bytes: entityTypeB58,
          },
        }],
      });

      const entries: RegistryEntry[] = [];
      for (const { pubkey, account } of accounts) {
        const entry = decodeEntry(Buffer.from(account.data), pubkey.toBase58());
        if (entry) entries.push(entry);
      }
      return entries;
    } catch (err) {
      console.error(`[SolanaRegistry] Failed to fetch entries (type=${entityType}):`, err);
      return [];
    }
  }

  private buildRegisterIx(
    entryPDA: PublicKey,
    entityType: number,
    endpoint: string,
    teeInstanceId: number[],
    codeHash: number[],
    attestationHash: number[],
    ed25519Pubkey: number[],
  ) {
    const endpointBuf = Buffer.from(endpoint, 'utf8');
    const dataLen = 8 + 1 + 4 + endpointBuf.length + 16 + 32 + 32 + 32;
    const data = Buffer.alloc(dataLen);
    let offset = 0;

    DISC.register.copy(data, offset); offset += 8;
    data.writeUint8(entityType, offset); offset += 1;
    data.writeUint32LE(endpointBuf.length, offset); offset += 4;
    endpointBuf.copy(data, offset); offset += endpointBuf.length;
    Buffer.from(teeInstanceId).copy(data, offset); offset += 16;
    Buffer.from(codeHash).copy(data, offset); offset += 32;
    Buffer.from(attestationHash).copy(data, offset); offset += 32;
    Buffer.from(ed25519Pubkey).copy(data, offset);

    return {
      keys: [
        { pubkey: entryPDA, isSigner: false, isWritable: true },
        { pubkey: this.keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data,
    };
  }

  private async sendTx(instructions: { keys: any[]; programId: PublicKey; data: Buffer }[]): Promise<string> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');

    const message = new TransactionMessage({
      payerKey: this.keypair.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([this.keypair]);

    const signature = await this.connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );

    return signature;
  }
}
