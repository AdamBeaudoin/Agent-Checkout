import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { tempoActions } from 'viem/tempo'

// Token we'll use for payments
export const ALPHA_USD = '0x20c0000000000000000000000000000000000001' as const

// Testnet RPC
export const RPC_URL = 'https://rpc.moderato.tempo.xyz'

// Explorer
export const EXPLORER_URL = 'https://explore.moderato.tempo.xyz'
export const CHAIN_ID = tempoModerato.id

// Create a public client (read-only, for balance checks etc.)
export function createTempoPublicClient() {
  return createPublicClient({
    chain: tempoModerato,
    transport: http(RPC_URL),
  }).extend(tempoActions())
}

// Create a wallet client (for signing transactions)
export function createTempoWalletClient(privateKey: `0x${string}`) {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: tempoModerato,
    transport: http(RPC_URL),
  }).extend(tempoActions())
}
