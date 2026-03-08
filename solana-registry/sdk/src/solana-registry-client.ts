/**
 * SolanaRegistryClient — TypeScript SDK for the on-chain discovery registry.
 *
 * Implements the RegistryClient interface (from guardian-network/shared/registry-types)
 * plus additional discovery methods for finding agents and guardians.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { IDL, type OnChainRegistryEntry } from './idl.js';


/** Compute Anchor instruction discriminator: SHA-256("global:<name>")[0..8] */
function anchorDiscriminator(name: string): Buffer {
  return Buffer.from(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
}

// ── Types ─────────────────────────────────────────────────────────

/** Mirrors RegistryClient from guardian-network/src/shared/registry-types.ts */
export interface AgentRecord {
  teeInstanceId: string;
  codeHash: string;
  isActive: boolean;
  lastHeartbeat: string;
  registeredAt: string;
  registeredBy: string;
}

export interface RegistrationRequest {
  teeInstanceId: string;
  codeHash: string;
  attestation: string;
  endpoint: string;
  ed25519PubkeyBase64?: string;
  x25519PubkeyBase64?: string;
  x25519Signature?: string;
}

export interface HeartbeatPayload {
  teeInstanceId: string;
  attestation: string;
  timestamp: number;
}

export interface HeartbeatCheckResult {
  isActive: boolean;
  secondsSinceHeartbeat: number;
  shouldDeactivate: boolean;
}

export interface RegistryClient {
  getCurrentAgent(): Promise<AgentRecord | null>;
  registerAgent(request: RegistrationRequest): Promise<{ success: boolean; error?: string }>;
  heartbeat(payload: HeartbeatPayload): Promise<{ success: boolean; error?: string }>;
  checkHeartbeat(): Promise<HeartbeatCheckResult | null>;
  deactivateAgent(teeInstanceId: string): Promise<{ success: boolean; error?: string }>;
  isRegistered(teeInstanceId: string): Promise<boolean>;
}

/** Decoded registry entry with string-encoded fields for easy consumption. */
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
  /** Solana pubkey that registered this entry. */
  owner: string;
}

/** Input for registerSelf — omits fields set automatically. */
export interface RegisterSelfInput {
  entityType: 'agent' | 'guardian';
  endpoint: string;
  teeInstanceId: string;
  codeHash: string;
  attestationHash: string;
  ed25519Pubkey: string;
  isActive: boolean;
}

// ── Constants ─────────────────────────────────────────────────────

const HEARTBEAT_TIMEOUT_SECONDS = 300;

/**
 * Anchor discriminator for RegistryEntry account.
 * SHA-256("account:RegistryEntry")[0..8]
 */
const REGISTRY_ENTRY_DISCRIMINATOR = Buffer.from([
  // Will be computed at runtime on first use
]);

// entity_type field starts at byte offset 8 (after 8-byte discriminator)
const ENTITY_TYPE_OFFSET = 8;

// ── Helpers ───────────────────────────────────────────────────────

function getEntryPDA(programId: PublicKey, owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('entry'), owner.toBuffer()],
    programId,
  );
}

function hexFromBytes(bytes: number[]): string {
  return Buffer.from(bytes).toString('hex');
}

function base64FromBytes(bytes: number[]): string {
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

function decodeEntry(data: Buffer, owner: string): RegistryEntry | null {
  try {
    // Skip 8-byte discriminator
    let offset = 8;

    // entity_type: u8
    const entityType = data.readUint8(offset);
    offset += 1;

    // endpoint: String (4-byte len prefix + utf8)
    const endpointLen = data.readUint32LE(offset);
    offset += 4;
    const endpoint = data.subarray(offset, offset + endpointLen).toString('utf8');
    offset += endpointLen;

    // tee_instance_id: [u8; 16]
    const teeInstanceId = hexFromBytes(Array.from(data.subarray(offset, offset + 16)));
    offset += 16;

    // code_hash: [u8; 32]
    const codeHash = hexFromBytes(Array.from(data.subarray(offset, offset + 32)));
    offset += 32;

    // attestation_hash: [u8; 32]
    const attestationHash = hexFromBytes(Array.from(data.subarray(offset, offset + 32)));
    offset += 32;

    // ed25519_pubkey: [u8; 32]
    const ed25519Pubkey = base64FromBytes(Array.from(data.subarray(offset, offset + 32)));
    offset += 32;

    // registered_at: i64
    const registeredAt = Number(data.readBigInt64LE(offset));
    offset += 8;

    // last_heartbeat: i64
    const lastHeartbeat = Number(data.readBigInt64LE(offset));
    offset += 8;

    // is_active: bool
    const isActive = data.readUint8(offset) !== 0;
    offset += 1;

    return {
      entityType: entityType === 0 ? 'agent' : 'guardian',
      endpoint,
      teeInstanceId,
      codeHash,
      attestationHash,
      ed25519Pubkey,
      registeredAt,
      lastHeartbeat,
      isActive,
      owner,
    };
  } catch {
    return null;
  }
}

// ── Client ────────────────────────────────────────────────────────

export class SolanaRegistryClient implements RegistryClient {
  private connection: Connection;
  private keypair: Keypair;
  private programId: PublicKey;

  constructor(connection: Connection, keypair: Keypair, programId: PublicKey) {
    this.connection = connection;
    this.keypair = keypair;
    this.programId = programId;
  }

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
      await this.sendDeactivate();
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

  /** Get all active agent entries from the registry. */
  async getAgents(): Promise<RegistryEntry[]> {
    return this.getEntriesByType(0);
  }

  /** Get all active guardian entries from the registry. */
  async getGuardians(): Promise<RegistryEntry[]> {
    return this.getEntriesByType(1);
  }

  /** Get all entries from the registry (both agents and guardians). */
  async getAllEntries(): Promise<RegistryEntry[]> {
    try {
      const accounts = await this.connection.getProgramAccounts(this.programId);
      const entries: RegistryEntry[] = [];
      for (const { pubkey, account } of accounts) {
        const entry = decodeEntry(Buffer.from(account.data), pubkey.toBase58());
        if (entry) entries.push(entry);
      }
      return entries;
    } catch (err) {
      console.error('[SolanaRegistry] Failed to fetch all entries:', err);
      return [];
    }
  }

  /** Register this node in the on-chain registry. Returns tx signature. */
  async registerSelf(input: RegisterSelfInput): Promise<string> {
    const [entryPDA] = getEntryPDA(this.programId, this.keypair.publicKey);

    const entityType = input.entityType === 'agent' ? 0 : 1;
    const codeHash = bytesFromHex(input.codeHash, 32);
    const attestationHash = bytesFromHex(input.attestationHash, 32);
    const ed25519Pubkey = bytesFromBase64(input.ed25519Pubkey, 32);

    const teeInstanceId = bytesFromHex(input.teeInstanceId, 16);

    const ix = this.buildRegisterInstruction(
      entryPDA,
      entityType,
      input.endpoint,
      teeInstanceId,
      codeHash,
      attestationHash,
      ed25519Pubkey,
    );

    return this.sendTransaction([ix]);
  }

  /** Update this node's on-chain endpoint. Returns tx signature. */
  async updateEndpoint(newEndpoint: string): Promise<string> {
    const [entryPDA] = getEntryPDA(this.programId, this.keypair.publicKey);

    const endpointBuf = Buffer.from(newEndpoint, 'utf8');
    const dataLen = 8 + 4 + endpointBuf.length;
    const data = Buffer.alloc(dataLen);
    let offset = 0;
    SolanaRegistryClient.DISCRIMINATORS.update_endpoint.copy(data, offset); offset += 8;
    data.writeUint32LE(endpointBuf.length, offset); offset += 4;
    endpointBuf.copy(data, offset);

    return this.sendTransaction([{
      keys: [
        { pubkey: entryPDA, isSigner: false, isWritable: true },
        { pubkey: this.keypair.publicKey, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data,
    }]);
  }

  /** Get this node's own entry from the registry. */
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

  // ── Private helpers ───────────────────────────────────────────

  private async getEntriesByType(entityType: number): Promise<RegistryEntry[]> {
    try {
      // Filter by entity_type at offset 8 (after discriminator)
      const accounts = await this.connection.getProgramAccounts(this.programId, {
        filters: [
          {
            memcmp: {
              offset: ENTITY_TYPE_OFFSET,
              // Base58 encoding of single bytes: 0x00 = "1", 0x01 = "2"
              bytes: entityType === 0 ? '1' : '2',
            },
          },
        ],
      });

      const entries: RegistryEntry[] = [];
      for (const { pubkey, account } of accounts) {
        // Derive the owner from the PDA — we need to find who the owner is.
        // Since we can't reverse a PDA, store the owner pubkey as the key.
        const entry = decodeEntry(Buffer.from(account.data), pubkey.toBase58());
        if (entry) entries.push(entry);
      }
      return entries;
    } catch (err) {
      console.error(`[SolanaRegistry] Failed to fetch entries (type=${entityType}):`, err);
      return [];
    }
  }

  private async sendHeartbeat(): Promise<string> {
    const [entryPDA] = getEntryPDA(this.programId, this.keypair.publicKey);
    const ix = this.buildHeartbeatInstruction(entryPDA);
    return this.sendTransaction([ix]);
  }

  private async sendDeactivate(): Promise<string> {
    const [entryPDA] = getEntryPDA(this.programId, this.keypair.publicKey);
    const ix = this.buildDeactivateInstruction(entryPDA);
    return this.sendTransaction([ix]);
  }

  /**
   * Build and send a versioned transaction.
   * Uses v0 transaction format with lookup tables for efficiency.
   */
  private async sendTransaction(
    instructions: ReturnType<typeof this.buildRegisterInstruction>[],
  ): Promise<string> {
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

  // ── Instruction builders (manual Anchor encoding) ─────────────
  // These encode instructions matching the Anchor IDL without requiring
  // the full @coral-xyz/anchor dependency at runtime.

  private static DISCRIMINATORS = {
    register: anchorDiscriminator('register'),
    heartbeat: anchorDiscriminator('heartbeat'),
    update_endpoint: anchorDiscriminator('update_endpoint'),
    update_attestation: anchorDiscriminator('update_attestation'),
    deactivate: anchorDiscriminator('deactivate'),
  };

  private buildRegisterInstruction(
    entryPDA: PublicKey,
    entityType: number,
    endpoint: string,
    teeInstanceId: number[],
    codeHash: number[],
    attestationHash: number[],
    ed25519Pubkey: number[],
  ) {
    // Encode: discriminator(8) + entity_type(1) + endpoint(4+len) + arrays
    const endpointBuf = Buffer.from(endpoint, 'utf8');
    const dataLen = 8 + 1 + 4 + endpointBuf.length + 16 + 32 + 32 + 32;
    const data = Buffer.alloc(dataLen);
    let offset = 0;

    // Discriminator
    SolanaRegistryClient.DISCRIMINATORS.register.copy(data, offset);
    offset += 8;

    // entity_type: u8
    data.writeUint8(entityType, offset);
    offset += 1;

    // endpoint: String (Borsh = u32 LE len + bytes)
    data.writeUint32LE(endpointBuf.length, offset);
    offset += 4;
    endpointBuf.copy(data, offset);
    offset += endpointBuf.length;

    // tee_instance_id: [u8; 16]
    Buffer.from(teeInstanceId).copy(data, offset);
    offset += 16;

    // code_hash: [u8; 32]
    Buffer.from(codeHash).copy(data, offset);
    offset += 32;

    // attestation_hash: [u8; 32]
    Buffer.from(attestationHash).copy(data, offset);
    offset += 32;

    // ed25519_pubkey: [u8; 32]
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

  private buildHeartbeatInstruction(entryPDA: PublicKey) {
    const data = Buffer.alloc(8);
    SolanaRegistryClient.DISCRIMINATORS.heartbeat.copy(data);

    return {
      keys: [
        { pubkey: entryPDA, isSigner: false, isWritable: true },
        { pubkey: this.keypair.publicKey, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data,
    };
  }

  private buildDeactivateInstruction(entryPDA: PublicKey) {
    const data = Buffer.alloc(8);
    SolanaRegistryClient.DISCRIMINATORS.deactivate.copy(data);

    return {
      keys: [
        { pubkey: entryPDA, isSigner: false, isWritable: true },
        { pubkey: this.keypair.publicKey, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data,
    };
  }
}
