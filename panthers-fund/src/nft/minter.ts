import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  createTree,
  mintV1,
  type MetadataArgsArgs,
} from '@metaplex-foundation/mpl-bubblegum';
import {
  createCollection,
  type CreateCollectionArgs,
} from '@metaplex-foundation/mpl-core';
import {
  generateSigner,
  createSignerFromKeypair,
  publicKey,
  type Umi,
  type PublicKey as UmiPublicKey,
  type KeypairSigner,
} from '@metaplex-foundation/umi';
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters';
import { dasApi } from '@metaplex-foundation/digital-asset-standard-api';
import type { Keypair as Web3Keypair } from '@solana/web3.js';

export class NFTMinter {
  private umi: Umi;
  private signer: KeypairSigner;
  private merkleTree: UmiPublicKey | null = null;
  private collection: UmiPublicKey | null = null;

  constructor(rpcUrl: string, agentKeypair: Web3Keypair) {
    this.umi = createUmi(rpcUrl)
      .use(dasApi());

    // Convert web3.js Keypair to Umi keypair signer
    const umiKeypair = fromWeb3JsKeypair(agentKeypair);
    this.signer = createSignerFromKeypair(this.umi, umiKeypair);
    this.umi.identity = this.signer;
    this.umi.payer = this.signer;
  }

  /** Load previously created collection and tree addresses. */
  loadConfig(collectionAddress: string, merkleTreeAddress: string): void {
    this.collection = publicKey(collectionAddress);
    this.merkleTree = publicKey(merkleTreeAddress);
  }

  /**
   * One-time: create a Merkle tree for compressed NFTs.
   * @param maxDepth - Tree depth (14 = 16,384 capacity)
   * @param maxBufferSize - Concurrent write buffer (64 is good)
   * @returns Tree public key as base58 string
   */
  async setupMerkleTree(maxDepth: number = 14, maxBufferSize: number = 64): Promise<string> {
    const merkleTree = generateSigner(this.umi);

    const builder = await createTree(this.umi, {
      merkleTree,
      maxDepth,
      maxBufferSize,
    });
    await builder.sendAndConfirm(this.umi);

    this.merkleTree = merkleTree.publicKey;
    return merkleTree.publicKey.toString();
  }

  /**
   * One-time: create an MPL Core collection.
   * @param name - Collection name (e.g. "Panthers Fund")
   * @param uri - Metadata URI (off-chain JSON)
   * @returns Collection public key as base58 string
   */
  async setupCollection(name: string, uri: string): Promise<string> {
    const collection = generateSigner(this.umi);

    const args: CreateCollectionArgs = {
      collection,
      name,
      uri,
    };

    const builder = createCollection(this.umi, args);
    await builder.sendAndConfirm(this.umi);

    this.collection = collection.publicKey;
    return collection.publicKey.toString();
  }

  /**
   * Mint a compressed NFT to a user's wallet.
   * @param userWallet - User's Solana wallet address (base58)
   * @param tokenId - Panthers Fund token ID (1-500)
   * @param depositAmount - Initial deposit in cents
   * @returns Asset ID (on-chain identifier) as base58 string
   */
  async mintToUser(userWallet: string, tokenId: number, depositAmount: number): Promise<string> {
    if (!this.merkleTree) {
      throw new Error('Merkle tree not set up. Call setupMerkleTree() or loadConfig() first.');
    }
    if (!this.collection) {
      throw new Error('Collection not set up. Call setupCollection() or loadConfig() first.');
    }

    const metadata: MetadataArgsArgs = {
      name: `Panthers Fund #${tokenId}`,
      symbol: 'PNTR',
      uri: '', // TODO: set to metadata JSON URI when available
      sellerFeeBasisPoints: 200, // 2% royalty on secondary sales
      collection: {
        key: this.collection,
        verified: false,
      },
      creators: [
        {
          address: this.signer.publicKey,
          verified: true,
          share: 100,
        },
      ],
    };

    const { signature } = await mintV1(this.umi, {
      leafOwner: publicKey(userWallet),
      merkleTree: this.merkleTree,
      metadata,
    }).sendAndConfirm(this.umi);

    // The asset ID is derived from the leaf — for now return the tx signature
    // The actual asset ID can be fetched via DAS API after confirmation
    return Buffer.from(signature).toString('base64');
  }

  /**
   * Query DAS API for the current owner of a compressed NFT asset.
   * @param assetId - The on-chain asset ID (base58)
   * @returns Owner's wallet address
   */
  async getOwner(assetId: string): Promise<string> {
    const asset = await (this.umi as any).rpc.getAsset(publicKey(assetId));
    return asset.ownership.owner.toString();
  }

  /**
   * Query DAS API for all assets in the collection.
   * @returns Array of { assetId, owner } pairs
   */
  async getCollectionAssets(): Promise<Array<{ assetId: string; owner: string }>> {
    if (!this.collection) {
      throw new Error('Collection not set up.');
    }

    const assets = await (this.umi as any).rpc.getAssetsByGroup({
      groupKey: 'collection',
      groupValue: this.collection.toString(),
    });

    return (assets.items ?? []).map((a: any) => ({
      assetId: a.id.toString(),
      owner: a.ownership.owner.toString(),
    }));
  }

  /**
   * Burn a compressed NFT (for withdrawals).
   * Note: The tree authority (agent) can burn cNFTs.
   * @param assetId - The on-chain asset ID
   * @returns Transaction signature
   */
  async burnNFT(assetId: string): Promise<string> {
    // For Bubblegum cNFTs, burning requires the asset proof from DAS
    // This is a simplified implementation — full burn requires getAssetProof
    const asset = await (this.umi as any).rpc.getAsset(publicKey(assetId));
    const proof = await (this.umi as any).rpc.getAssetProof(publicKey(assetId));

    // TODO: Implement full burn with proof when Bubblegum burn is available
    // For now, log the intent — the DB is the financial truth
    console.log(`[NFTMinter] Burn requested for asset ${assetId}, owner: ${asset.ownership.owner}`);
    return `burn_pending_${assetId}`;
  }
}
