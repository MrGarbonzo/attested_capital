/**
 * Hand-written IDL for the solana-registry program.
 * After `anchor build`, replace with the auto-generated IDL from target/idl/.
 */

export const IDL = {
  version: '0.1.0',
  name: 'solana_registry',
  instructions: [
    {
      name: 'register',
      accounts: [
        { name: 'entry', isMut: true, isSigner: false },
        { name: 'owner', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'entityType', type: 'u8' },
        { name: 'endpoint', type: 'string' },
        { name: 'teeInstanceId', type: { array: ['u8', 16] } },
        { name: 'codeHash', type: { array: ['u8', 32] } },
        { name: 'attestationHash', type: { array: ['u8', 32] } },
        { name: 'ed25519Pubkey', type: { array: ['u8', 32] } },
      ],
    },
    {
      name: 'heartbeat',
      accounts: [
        { name: 'entry', isMut: true, isSigner: false },
        { name: 'owner', isMut: false, isSigner: true },
      ],
      args: [],
    },
    {
      name: 'updateEndpoint',
      accounts: [
        { name: 'entry', isMut: true, isSigner: false },
        { name: 'owner', isMut: false, isSigner: true },
      ],
      args: [{ name: 'newEndpoint', type: 'string' }],
    },
    {
      name: 'updateAttestation',
      accounts: [
        { name: 'entry', isMut: true, isSigner: false },
        { name: 'owner', isMut: false, isSigner: true },
      ],
      args: [{ name: 'attestationHash', type: { array: ['u8', 32] } }],
    },
    {
      name: 'deactivate',
      accounts: [
        { name: 'entry', isMut: true, isSigner: false },
        { name: 'owner', isMut: false, isSigner: true },
      ],
      args: [],
    },
  ],
  accounts: [
    {
      name: 'RegistryEntry',
      type: {
        kind: 'struct',
        fields: [
          { name: 'entityType', type: 'u8' },
          { name: 'endpoint', type: 'string' },
          { name: 'teeInstanceId', type: { array: ['u8', 16] } },
          { name: 'codeHash', type: { array: ['u8', 32] } },
          { name: 'attestationHash', type: { array: ['u8', 32] } },
          { name: 'ed25519Pubkey', type: { array: ['u8', 32] } },
          { name: 'registeredAt', type: 'i64' },
          { name: 'lastHeartbeat', type: 'i64' },
          { name: 'isActive', type: 'bool' },
          { name: 'bump', type: 'u8' },
        ],
      },
    },
  ],
  errors: [
    { code: 6000, name: 'EndpointTooLong', msg: 'Endpoint URL exceeds 256 characters' },
    { code: 6001, name: 'InvalidEntityType', msg: 'Entity type must be 0 (Agent) or 1 (Guardian)' },
    { code: 6002, name: 'EntryInactive', msg: 'Entry is inactive' },
  ],
} as const;

/** TypeScript type for on-chain RegistryEntry data. */
export interface OnChainRegistryEntry {
  entityType: number;
  endpoint: string;
  teeInstanceId: number[];
  codeHash: number[];
  attestationHash: number[];
  ed25519Pubkey: number[];
  registeredAt: { toNumber(): number };
  lastHeartbeat: { toNumber(): number };
  isActive: boolean;
  bump: number;
}
