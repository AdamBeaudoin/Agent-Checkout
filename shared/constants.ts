// Lightweight constants used by both server and client code.
// Keep this file free of heavy chain/client imports to reduce serverless cold-start time.

// Token we'll use for payments
export const ALPHA_USD = '0x20c0000000000000000000000000000000000001' as const

// Testnet RPC
export const RPC_URL = 'https://rpc.moderato.tempo.xyz'

// Explorer
export const EXPLORER_URL = 'https://explore.moderato.tempo.xyz'

// Tempo Moderato chain id
export const CHAIN_ID = 42431

