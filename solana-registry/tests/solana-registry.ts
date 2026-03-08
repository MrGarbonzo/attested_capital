import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaRegistry } from "../target/types/solana_registry";
import { expect } from "chai";

describe("solana-registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaRegistry as Program<SolanaRegistry>;
  const owner = provider.wallet;

  function getEntryPDA(): [anchor.web3.PublicKey, number] {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("entry"), owner.publicKey.toBuffer()],
      program.programId,
    );
  }

  it("registers an agent entry", async () => {
    const [entryPDA] = getEntryPDA();

    const teeInstanceId = Buffer.alloc(16);
    teeInstanceId.write("test-agent-0001");

    const codeHash = Buffer.alloc(32);
    codeHash.write("code-hash-placeholder");

    const attestationHash = Buffer.alloc(32);
    const ed25519Pubkey = Buffer.alloc(32);

    await program.methods
      .register(
        0, // Agent
        "https://agent.example.com:8080",
        Array.from(teeInstanceId) as any,
        Array.from(codeHash) as any,
        Array.from(attestationHash) as any,
        Array.from(ed25519Pubkey) as any,
      )
      .accounts({
        entry: entryPDA,
        owner: owner.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const entry = await program.account.registryEntry.fetch(entryPDA);
    expect(entry.entityType).to.equal(0);
    expect(entry.endpoint).to.equal("https://agent.example.com:8080");
    expect(entry.isActive).to.be.true;
  });

  it("sends heartbeat", async () => {
    const [entryPDA] = getEntryPDA();

    const before = await program.account.registryEntry.fetch(entryPDA);

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 1100));

    await program.methods
      .heartbeat()
      .accounts({
        entry: entryPDA,
        owner: owner.publicKey,
      })
      .rpc();

    const after = await program.account.registryEntry.fetch(entryPDA);
    expect(after.lastHeartbeat.toNumber()).to.be.greaterThanOrEqual(
      before.lastHeartbeat.toNumber(),
    );
  });

  it("updates endpoint", async () => {
    const [entryPDA] = getEntryPDA();

    await program.methods
      .updateEndpoint("https://new-agent.example.com:9090")
      .accounts({
        entry: entryPDA,
        owner: owner.publicKey,
      })
      .rpc();

    const entry = await program.account.registryEntry.fetch(entryPDA);
    expect(entry.endpoint).to.equal("https://new-agent.example.com:9090");
  });

  it("updates attestation hash", async () => {
    const [entryPDA] = getEntryPDA();

    const newHash = Buffer.alloc(32, 0xab);

    await program.methods
      .updateAttestation(Array.from(newHash) as any)
      .accounts({
        entry: entryPDA,
        owner: owner.publicKey,
      })
      .rpc();

    const entry = await program.account.registryEntry.fetch(entryPDA);
    expect(Buffer.from(entry.attestationHash)).to.deep.equal(newHash);
  });

  it("deactivates entry", async () => {
    const [entryPDA] = getEntryPDA();

    await program.methods
      .deactivate()
      .accounts({
        entry: entryPDA,
        owner: owner.publicKey,
      })
      .rpc();

    const entry = await program.account.registryEntry.fetch(entryPDA);
    expect(entry.isActive).to.be.false;
  });

  it("rejects heartbeat on inactive entry", async () => {
    const [entryPDA] = getEntryPDA();

    try {
      await program.methods
        .heartbeat()
        .accounts({
          entry: entryPDA,
          owner: owner.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("EntryInactive");
    }
  });

  it("re-registers after deactivation", async () => {
    const [entryPDA] = getEntryPDA();

    const teeInstanceId = Buffer.alloc(16);
    teeInstanceId.write("test-agent-0002");

    const codeHash = Buffer.alloc(32);
    const attestationHash = Buffer.alloc(32);
    const ed25519Pubkey = Buffer.alloc(32);

    await program.methods
      .register(
        0,
        "https://agent-v2.example.com:8080",
        Array.from(teeInstanceId) as any,
        Array.from(codeHash) as any,
        Array.from(attestationHash) as any,
        Array.from(ed25519Pubkey) as any,
      )
      .accounts({
        entry: entryPDA,
        owner: owner.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const entry = await program.account.registryEntry.fetch(entryPDA);
    expect(entry.isActive).to.be.true;
    expect(entry.endpoint).to.equal("https://agent-v2.example.com:8080");
  });
});
