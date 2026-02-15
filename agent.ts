import { createTempoPublicClient } from './shared/config.js'
import { ALPHA_USD, EXPLORER_URL, CHAIN_ID } from './shared/constants.js'
import { createWalletClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Account, tempoActions } from 'viem/tempo'
import {
  assertInvoiceV1,
  verifyInvoiceSignature,
  type InvoiceV1,
} from './shared/invoice.js'
import 'dotenv/config'

const MERCHANT_URL = process.env.MERCHANT_URL ?? 'http://localhost:3000'
const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3001'
const ALLOW_LOCAL_POLICY_FALLBACK = process.env.ALLOW_LOCAL_POLICY_FALLBACK === 'true'
const MERCHANT_CONFIRM_TOKEN = process.env.MERCHANT_CONFIRM_TOKEN?.trim()

type DelegationPolicy = {
  owner: `0x${string}`
  maxAmount: string
  allowedRecipients: `0x${string}`[]
  allowedTokens: `0x${string}`[]
  expiresAt: number
}

function parseAddressList(value: string | undefined): `0x${string}`[] {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0) as `0x${string}`[]
}

async function getPolicy(accountAddress: `0x${string}`): Promise<DelegationPolicy> {
  let failureReason = 'Unknown guardian error'

  try {
    const response = await fetch(`${GUARDIAN_URL}/api/delegations/${accountAddress}`)
    if (response.ok) {
      return (await response.json()) as DelegationPolicy
    }

    if (response.status === 404) {
      failureReason = `No delegation policy found for ${accountAddress}`
    } else {
      failureReason = `Guardian returned HTTP ${response.status}`
    }
  } catch {
    failureReason = 'Guardian request failed'
  }

  if (!ALLOW_LOCAL_POLICY_FALLBACK) {
    throw new Error(
      `Delegation policy unavailable: ${failureReason}. Set ALLOW_LOCAL_POLICY_FALLBACK=true to allow local fallback.`,
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const fallbackRecipients = parseAddressList(process.env.AGENT_ALLOWED_RECIPIENTS)
  const fallbackTokens = parseAddressList(process.env.AGENT_ALLOWED_TOKENS)

  console.warn(
    'Using local fallback delegation policy because ALLOW_LOCAL_POLICY_FALLBACK=true.',
  )

  return {
    owner: accountAddress,
    maxAmount: process.env.AGENT_MAX_AMOUNT ?? '200000000',
    allowedRecipients: fallbackRecipients,
    allowedTokens: fallbackTokens.length > 0 ? fallbackTokens : [ALPHA_USD],
    expiresAt: now + 24 * 60 * 60,
  }
}

function validateInvoiceAgainstPolicy(
  invoice: InvoiceV1,
  policy: DelegationPolicy,
  payer: `0x${string}`,
) {
  const now = Math.floor(Date.now() / 1000)

  if (invoice.chainId !== CHAIN_ID) {
    throw new Error(`Wrong chain: expected ${CHAIN_ID}, got ${invoice.chainId}`)
  }

  if (invoice.dueAt < now) {
    throw new Error('Invoice expired')
  }

  if (policy.expiresAt < now) {
    throw new Error('Delegation policy expired')
  }

  if (invoice.payer && invoice.payer.toLowerCase() !== payer.toLowerCase()) {
    throw new Error('Invoice payer does not match delegated account')
  }

  const amount = BigInt(invoice.amount)
  const maxAmount = BigInt(policy.maxAmount)

  if (amount > maxAmount) {
    throw new Error(`Over policy budget (${amount} > ${maxAmount})`)
  }

  if (policy.allowedRecipients.length > 0) {
    const recipientAllowed = policy.allowedRecipients.some(
      (recipient) => recipient.toLowerCase() === invoice.recipient.toLowerCase(),
    )
    if (!recipientAllowed) {
      throw new Error('Recipient not allowed by delegation policy')
    }
  }

  if (policy.allowedTokens.length > 0) {
    const tokenAllowed = policy.allowedTokens.some(
      (token) => token.toLowerCase() === invoice.token.toLowerCase(),
    )
    if (!tokenAllowed) {
      throw new Error('Token not allowed by delegation policy')
    }
  }
}

async function main() {
  const agentPrivateKey = process.env.AGENT_PRIVATE_KEY as `0x${string}`
  const rootPrivateKey = process.env.ROOT_PRIVATE_KEY as `0x${string}`
  const accountAddress = process.env.AGENT_ADDRESS as `0x${string}`

  if (!agentPrivateKey || !rootPrivateKey || !accountAddress) {
    console.error('Missing AGENT_PRIVATE_KEY, ROOT_PRIVATE_KEY, or AGENT_ADDRESS. Run setup.ts first.')
    process.exit(1)
  }

  const root = Account.fromSecp256k1(rootPrivateKey)
  const agentAccount = Account.fromSecp256k1(agentPrivateKey, { access: root })

  const client = createWalletClient({
    account: agentAccount,
    chain: tempoModerato,
    transport: http('https://rpc.moderato.tempo.xyz'),
  }).extend(tempoActions())

  const publicClient = createTempoPublicClient()

  const balance = await publicClient.token.getBalance({
    token: ALPHA_USD,
    account: accountAddress,
  })
  console.log(`Account balance: ${Number(balance) / 1e6} AlphaUSD`)

  console.log('\nBrowsing listings...')
  const listings = (await fetch(`${MERCHANT_URL}/api/listings`).then((response) =>
    response.json(),
  )) as Array<{ id: string; title: string; priceUSDC: string; nights: number }>

  for (const [index, listing] of listings.entries()) {
    console.log(
      `  ${index + 1}. ${listing.title} -- $${Number(listing.priceUSDC) / 1e6}/night x${listing.nights} nights`,
    )
  }

  const pick = listings.sort((a, b) => Number(a.priceUSDC) - Number(b.priceUSDC))[0]
  if (!pick) {
    console.log('No listings available.')
    process.exit(1)
  }

  console.log(`\nSelected: ${pick.title} -- $${Number(pick.priceUSDC) / 1e6}`)

  console.log('Requesting standardized invoice...')
  const invoiceResponse = (await fetch(`${MERCHANT_URL}/api/invoices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      listingId: pick.id,
      payer: accountAddress,
    }),
  }).then((response) => response.json())) as { invoice?: unknown }

  assertInvoiceV1(invoiceResponse.invoice)
  const invoice = invoiceResponse.invoice

  const validSignature = await verifyInvoiceSignature(invoice)
  if (!validSignature) {
    throw new Error('Invoice signature check failed')
  }

  const policy = await getPolicy(accountAddress)
  validateInvoiceAgainstPolicy(invoice, policy, accountAddress)

  const amount = BigInt(invoice.amount)
  console.log(`Paying ${Number(amount) / 1e6} AlphaUSD...`)
  const startTime = Date.now()

  const result = await client.token.transferSync({
    amount,
    to: invoice.recipient,
    token: invoice.token,
    memo: invoice.memo,
    feeToken: ALPHA_USD,
  })

  const elapsed = Date.now() - startTime
  console.log(`Tx confirmed: ${result.receipt.transactionHash}`)
  console.log(`  ${EXPLORER_URL}/tx/${result.receipt.transactionHash}`)

  const confirmation = await fetch(`${MERCHANT_URL}/api/confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(MERCHANT_CONFIRM_TOKEN
        ? { 'x-merchant-confirm-token': MERCHANT_CONFIRM_TOKEN }
        : {}),
    },
    body: JSON.stringify({
      invoiceId: invoice.invoiceId,
      txHash: result.receipt.transactionHash,
    }),
  }).then((response) => response.json())

  if (confirmation.status !== 'confirmed') {
    throw new Error(`Merchant confirmation failed: ${JSON.stringify(confirmation)}`)
  }

  console.log(`\nInvoice settled! Invoice: ${invoice.invoiceId}`)
  console.log(`Total time: ${(elapsed / 1000).toFixed(1)}s`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
