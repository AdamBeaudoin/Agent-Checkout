import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import {
  INVOICE_VERSION,
  assertInvoiceV1,
  canonicalStringify,
  createInvoiceMemo,
  signInvoice,
  type InvoiceV1,
  type InvoiceV1Unsigned,
  verifyInvoiceSignature,
} from '../shared/invoice.js'

function randomPrivateKey(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}` as `0x${string}`
}

const merchantSigner = privateKeyToAccount(randomPrivateKey())

function makeUnsignedInvoice(overrides: Partial<InvoiceV1Unsigned> = {}): InvoiceV1Unsigned {
  return {
    version: INVOICE_VERSION,
    invoiceId: 'INV-TEST-1',
    issuedAt: 1_700_000_000,
    dueAt: 1_700_000_600,
    chainId: 42431,
    merchant: merchantSigner.address,
    recipient: merchantSigner.address,
    payer: merchantSigner.address,
    token: '0x20c0000000000000000000000000000000000001',
    amount: '35000000',
    memo: createInvoiceMemo('INV-TEST-1'),
    description: 'Garden Studio in Neukolln (1 nights)',
    lineItems: [
      {
        id: 'garden-studio',
        title: 'Garden Studio in Neukolln',
        category: 'lodging',
        quantity: 1,
        totalAmount: '35000000',
      },
    ],
    metadata: {
      listingId: 'garden-studio',
      nights: 1,
      checkoutType: 'lodging',
    },
    ...overrides,
  }
}

test('canonicalStringify is deterministic for reordered objects', () => {
  const a = { b: 2, a: { y: 2, x: 1 } }
  const b = { a: { x: 1, y: 2 }, b: 2 }

  assert.equal(canonicalStringify(a), canonicalStringify(b))
})

test('signInvoice + verifyInvoiceSignature succeeds for untampered invoice', async () => {
  const unsigned = makeUnsignedInvoice()
  const signed = await signInvoice(merchantSigner, unsigned)

  const valid = await verifyInvoiceSignature(signed)
  assert.equal(valid, true)
})

test('verifyInvoiceSignature fails after invoice tamper', async () => {
  const unsigned = makeUnsignedInvoice()
  const signed = await signInvoice(merchantSigner, unsigned)

  const tampered: InvoiceV1 = {
    ...signed,
    amount: '35000001',
  }

  const valid = await verifyInvoiceSignature(tampered)
  assert.equal(valid, false)
})

test('assertInvoiceV1 rejects mismatched line item totals', async () => {
  const signed = await signInvoice(
    merchantSigner,
    makeUnsignedInvoice({
      lineItems: [
        {
          title: 'Bad total',
          quantity: 1,
          unitAmount: '35000000',
          totalAmount: '1',
        },
      ],
    }),
  )

  assert.throws(() => assertInvoiceV1(signed), /lineItems\[\]\.totalAmount|sum of lineItems/i)
})
