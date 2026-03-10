use anchor_lang::prelude::*;

declare_id!("2MyEEALvHLeLLZih36BJWj9HgvTr9itvNJQogDRixTUV");

/// Maximum endpoint URL length in bytes.
const MAX_ENDPOINT_LEN: usize = 256;

#[program]
pub mod solana_registry {
    use super::*;

    /// Register a new entry or re-activate an existing one.
    pub fn register(
        ctx: Context<Register>,
        entity_type: u8,
        endpoint: String,
        tee_instance_id: [u8; 16],
        code_hash: [u8; 32],
        attestation_hash: [u8; 32],
        ed25519_pubkey: [u8; 32],
    ) -> Result<()> {
        require!(endpoint.len() <= MAX_ENDPOINT_LEN, RegistryError::EndpointTooLong);
        require!(entity_type <= 1, RegistryError::InvalidEntityType);

        let entry = &mut ctx.accounts.entry;
        let clock = Clock::get()?;

        entry.entity_type = entity_type;
        entry.endpoint = endpoint;
        entry.tee_instance_id = tee_instance_id;
        entry.code_hash = code_hash;
        entry.attestation_hash = attestation_hash;
        entry.ed25519_pubkey = ed25519_pubkey;
        entry.registered_at = clock.unix_timestamp;
        entry.last_heartbeat = clock.unix_timestamp;
        entry.is_active = true;
        entry.bump = ctx.bumps.entry;

        msg!("Registered entry for {}", ctx.accounts.owner.key());
        Ok(())
    }

    /// Update the last_heartbeat timestamp to prove liveness.
    pub fn heartbeat(ctx: Context<Modify>) -> Result<()> {
        let entry = &mut ctx.accounts.entry;
        require!(entry.is_active, RegistryError::EntryInactive);

        let clock = Clock::get()?;
        entry.last_heartbeat = clock.unix_timestamp;
        Ok(())
    }

    /// Change the endpoint URL.
    pub fn update_endpoint(ctx: Context<Modify>, new_endpoint: String) -> Result<()> {
        require!(new_endpoint.len() <= MAX_ENDPOINT_LEN, RegistryError::EndpointTooLong);

        let entry = &mut ctx.accounts.entry;
        require!(entry.is_active, RegistryError::EntryInactive);

        entry.endpoint = new_endpoint;
        Ok(())
    }

    /// Refresh the attestation hash (e.g. after re-attestation).
    pub fn update_attestation(ctx: Context<Modify>, attestation_hash: [u8; 32]) -> Result<()> {
        let entry = &mut ctx.accounts.entry;
        require!(entry.is_active, RegistryError::EntryInactive);

        entry.attestation_hash = attestation_hash;
        Ok(())
    }

    /// Deactivate the entry (soft-delete, can re-register later).
    pub fn deactivate(ctx: Context<Modify>) -> Result<()> {
        let entry = &mut ctx.accounts.entry;
        entry.is_active = false;
        msg!("Deactivated entry for {}", ctx.accounts.owner.key());
        Ok(())
    }
}

// ── Accounts ──────────────────────────────────────────────────────

/// PDA account storing one registry entry per Solana wallet.
/// Seeds: ["entry", owner_pubkey]
#[account]
pub struct RegistryEntry {
    /// 0 = Agent, 1 = Guardian.
    pub entity_type: u8,
    /// HTTPS endpoint URL (max 256 chars, may be encrypted blob).
    pub endpoint: String,
    /// TEE hardware identity (16 bytes).
    pub tee_instance_id: [u8; 16],
    /// RTMR3 / code measurement hash.
    pub code_hash: [u8; 32],
    /// SHA-256 of latest attestation document.
    pub attestation_hash: [u8; 32],
    /// ed25519 public key for signed envelope verification.
    pub ed25519_pubkey: [u8; 32],
    /// Unix timestamp of initial registration.
    pub registered_at: i64,
    /// Unix timestamp of last heartbeat (or registration).
    pub last_heartbeat: i64,
    /// Whether this entry is currently active.
    pub is_active: bool,
    /// PDA bump seed.
    pub bump: u8,
}

impl RegistryEntry {
    /// 8 (discriminator) + 1 + (4 + 256) + 16 + 32 + 32 + 32 + 8 + 8 + 1 + 1 = 399
    pub const SIZE: usize = 8 + 1 + (4 + MAX_ENDPOINT_LEN) + 16 + 32 + 32 + 32 + 8 + 8 + 1 + 1;
}

// ── Instruction contexts ─────────────────────────────────────────

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(
        init_if_needed,
        payer = owner,
        space = RegistryEntry::SIZE,
        seeds = [b"entry", owner.key().as_ref()],
        bump,
    )]
    pub entry: Account<'info, RegistryEntry>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Modify<'info> {
    #[account(
        mut,
        seeds = [b"entry", owner.key().as_ref()],
        bump = entry.bump,
    )]
    pub entry: Account<'info, RegistryEntry>,
    pub owner: Signer<'info>,
}

// ── Errors ───────────────────────────────────────────────────────

#[error_code]
pub enum RegistryError {
    #[msg("Endpoint URL exceeds 256 characters")]
    EndpointTooLong,
    #[msg("Entity type must be 0 (Agent) or 1 (Guardian)")]
    InvalidEntityType,
    #[msg("Entry is inactive")]
    EntryInactive,
}
