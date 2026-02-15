import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { createTempoWalletClient, createTempoPublicClient } from './shared/config.js'
import { ALPHA_USD } from './shared/constants.js'
import fs from 'fs'
import { randomBytes } from 'crypto'

async function setup() {
  const publicClient = createTempoPublicClient()

  // --- 1. Generate root account ---
  const rootPrivateKey = generatePrivateKey()
  const rootAccount = privateKeyToAccount(rootPrivateKey)
  console.log(`Root account: ${rootAccount.address}`)

  // --- 2. Fund from faucet ---
  console.log('Requesting faucet funds...')
  await publicClient.faucet.fund({ account: rootAccount.address })
  console.log('Faucet funded.')

  // Wait for funds to settle
  await new Promise(r => setTimeout(r, 3000))

  // Check balance
  const balance = await publicClient.token.getBalance({
    token: ALPHA_USD,
    account: rootAccount.address,
  })
  console.log(`AlphaUSD balance: ${Number(balance) / 1e6}`)

  // --- 3. Generate agent access key ---
  const agentPrivateKey = generatePrivateKey()
  const agentViem = privateKeyToAccount(agentPrivateKey)

  // Create Tempo Account instances
  const root = Account.fromSecp256k1(rootPrivateKey)
  const agentAccessKey = Account.fromSecp256k1(agentPrivateKey, {
    access: root,
  })

  // --- 4. Authorize the access key on-chain ---
  console.log('Authorizing agent access key...')
  const walletClient = createTempoWalletClient(rootPrivateKey)

  // Root key signs the key authorization for the agent
  const keyAuthorization = await root.signKeyAuthorization(agentAccessKey)

  // The first tx with keyAuthorization registers the access key on-chain.
  // Send a minimal self-transfer to register it.
  const receipt = await walletClient.sendTransactionSync({
    account: agentAccessKey,
    to: rootAccount.address,
    data: '0x',
    feeToken: ALPHA_USD,
    keyAuthorization,
  })
  console.log(`Access key authorized! Tx: ${receipt.transactionHash}`)

  // --- 5. Also generate + fund a merchant account ---
  const merchantPrivateKey = generatePrivateKey()
  const merchantAccount = privateKeyToAccount(merchantPrivateKey)
  console.log(`\nMerchant account: ${merchantAccount.address}`)
  await publicClient.faucet.fund({ account: merchantAccount.address })
  console.log('Merchant faucet funded.')

  // --- 6. Write .env ---
  const delegationAdminToken = randomBytes(24).toString('hex')
  const merchantConfirmToken = randomBytes(24).toString('hex')

  const envContent = [
    '# Root account (owner)',
    `ROOT_PRIVATE_KEY=${rootPrivateKey}`,
    `ROOT_ADDRESS=${rootAccount.address}`,
    '',
    '# Agent access key',
    `AGENT_PRIVATE_KEY=${agentPrivateKey}`,
    `AGENT_ADDRESS=${rootAccount.address}`,
    '',
    '# Merchant',
    `MERCHANT_PRIVATE_KEY=${merchantPrivateKey}`,
    `MERCHANT_ADDRESS=${merchantAccount.address}`,
    '',
    '# Agent policy defaults (used if Guardian has no policy yet)',
    'AGENT_MAX_AMOUNT=200000000',
    `AGENT_ALLOWED_RECIPIENTS=${merchantAccount.address}`,
    `AGENT_ALLOWED_TOKENS=${ALPHA_USD}`,
    '',
    '# Optional shared configuration',
    'MERCHANT_URL=http://localhost:3000',
    'GUARDIAN_URL=http://localhost:3001',
    'MERCHANT_STATE_PATH=./data/merchant-state.json',
    'GUARDIAN_STATE_PATH=./data/guardian-state.json',
    'ALLOW_LOCAL_POLICY_FALLBACK=false',
    `MERCHANT_CONFIRM_TOKEN=${merchantConfirmToken}`,
    '',
    '# Guardian policy admin (required to write delegation policies)',
    `DELEGATION_ADMIN_TOKEN=${delegationAdminToken}`,
  ].join('\n')

  fs.writeFileSync('.env', envContent)
  console.log('\nWritten to .env:')
  console.log(`  Root:     ${rootAccount.address}`)
  console.log(`  Agent key: ${agentViem.address} (signs on behalf of root)`)
  console.log(`  Merchant: ${merchantAccount.address}`)
  console.log(`  Guardian admin token: ${delegationAdminToken}`)
  console.log(`  Merchant confirm token: ${merchantConfirmToken}`)
  console.log('\nSetup complete! Run the merchant and agent next.')
}

setup().catch(console.error)
