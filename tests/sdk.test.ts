import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { TempoMerchantSdk } from '../sdk/merchant.js'

function randomPrivateKey(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}` as `0x${string}`
}

const signer = privateKeyToAccount(randomPrivateKey())

const sdk = new TempoMerchantSdk({
  baseUrl: 'http://localhost:3000',
  chainId: 42431,
  defaultRecipient: signer.address,
  defaultToken: '0x20c0000000000000000000000000000000000001',
  explorerUrl: 'https://explore.moderato.tempo.xyz',
  merchantAddress: signer.address,
  merchantName: 'Test Merchant',
  signer,
})

test('createInvoice issues a signed valid invoice', async () => {
  const invoice = await sdk.createInvoice({
    amount: '150000000',
    description: 'Airbnb rental for 3 nights in Mexico City',
    lineItems: [
      {
        title: 'Mexico City stay',
        quantity: 3,
        unitAmount: '50000000',
        totalAmount: '150000000',
      },
    ],
  })

  assert.equal(invoice.version, 'tempo.invoice.v1')
  assert.equal(invoice.amount, '150000000')
  assert.equal(typeof invoice.merchantSig, 'string')
  assert.equal(invoice.merchantSig.startsWith('0x'), true)
})

test('createInvoice rejects invalid timeline', async () => {
  await assert.rejects(
    sdk.createInvoice({
      amount: '1000',
      description: 'bad timeline',
      issuedAt: 1000,
      dueAt: 1000,
    }),
    /dueAt must be a future unix timestamp after issuedAt/i,
  )
})

test('createInvoice rejects lineItem totals that do not match invoice amount', async () => {
  await assert.rejects(
    sdk.createInvoice({
      amount: '1500',
      description: 'bad totals',
      lineItems: [{ title: 'x', totalAmount: '1400' }],
    }),
    /Invoice amount must equal sum of lineItems\[\]\.totalAmount/i,
  )
})
