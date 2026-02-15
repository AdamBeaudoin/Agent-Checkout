import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { tempoActions } from 'viem/tempo'

import { RPC_URL } from './constants.js'

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
