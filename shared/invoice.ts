import { isAddress, pad, stringToHex, verifyMessage } from 'viem'
import type { LocalAccount } from 'viem/accounts'

export const INVOICE_VERSION = 'tempo.invoice.v1' as const

export type InvoiceMetadata = Record<string, string | number | boolean>

export type InvoiceLineItemV1 = {
  id?: string
  title: string
  category?: string
  quantity?: number
  unitAmount?: string
  totalAmount: string
}

export type InvoiceV1Unsigned = {
  version: typeof INVOICE_VERSION
  invoiceId: string
  issuedAt: number
  dueAt: number
  chainId: number
  merchant: `0x${string}`
  recipient: `0x${string}`
  payer?: `0x${string}`
  token: `0x${string}`
  amount: string
  memo: `0x${string}`
  description: string
  merchantReference?: string
  purpose?: string
  lineItems?: InvoiceLineItemV1[]
  metadata?: InvoiceMetadata
}

export type InvoiceV1 = InvoiceV1Unsigned & {
  merchantSig: `0x${string}`
}

function parseAmountString(value: string, field: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`Invalid ${field} format`)
  }
  return BigInt(value)
}

export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )
    return `{${entries
      .map(([key, itemValue]) => `${JSON.stringify(key)}:${canonicalStringify(itemValue)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

export function sumLineItemTotals(lineItems: InvoiceLineItemV1[]): bigint {
  return lineItems.reduce((total, item) => {
    return total + parseAmountString(item.totalAmount, 'line item totalAmount')
  }, 0n)
}

export const INVOICE_V1_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://tempo.xyz/schemas/invoice-v1.json',
  title: 'Tempo Agent Invoice V1',
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'invoiceId',
    'issuedAt',
    'dueAt',
    'chainId',
    'merchant',
    'recipient',
    'token',
    'amount',
    'memo',
    'description',
    'merchantSig',
  ],
  properties: {
    version: {
      type: 'string',
      const: INVOICE_VERSION,
    },
    invoiceId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
    },
    issuedAt: {
      type: 'integer',
      minimum: 1,
    },
    dueAt: {
      type: 'integer',
      minimum: 1,
    },
    chainId: {
      type: 'integer',
      minimum: 1,
    },
    merchant: {
      type: 'string',
      pattern: '^0x[a-fA-F0-9]{40}$',
    },
    recipient: {
      type: 'string',
      pattern: '^0x[a-fA-F0-9]{40}$',
    },
    payer: {
      type: 'string',
      pattern: '^0x[a-fA-F0-9]{40}$',
    },
    token: {
      type: 'string',
      pattern: '^0x[a-fA-F0-9]{40}$',
    },
    amount: {
      type: 'string',
      pattern: '^[0-9]+$',
    },
    memo: {
      type: 'string',
      pattern: '^0x[a-fA-F0-9]{64}$',
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 512,
    },
    merchantReference: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
    },
    purpose: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
    },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'totalAmount'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          title: { type: 'string', minLength: 1, maxLength: 256 },
          category: { type: 'string', minLength: 1, maxLength: 128 },
          quantity: { type: 'integer', minimum: 1 },
          unitAmount: { type: 'string', pattern: '^[0-9]+$' },
          totalAmount: { type: 'string', pattern: '^[0-9]+$' },
        },
      },
    },
    metadata: {
      type: 'object',
      additionalProperties: {
        type: ['string', 'number', 'boolean'],
      },
    },
    merchantSig: {
      type: 'string',
      pattern: '^0x[a-fA-F0-9]+$',
    },
  },
} as const

export function createInvoiceMemo(invoiceId: string): `0x${string}` {
  return pad(stringToHex(invoiceId), { size: 32 })
}

export function createInvoiceMessage(invoice: InvoiceV1Unsigned): string {
  return [
    invoice.version,
    invoice.invoiceId,
    String(invoice.issuedAt),
    String(invoice.dueAt),
    String(invoice.chainId),
    invoice.merchant.toLowerCase(),
    invoice.recipient.toLowerCase(),
    (invoice.payer ?? '').toLowerCase(),
    invoice.token.toLowerCase(),
    invoice.amount,
    invoice.memo.toLowerCase(),
    invoice.description,
    invoice.merchantReference ?? '',
    invoice.purpose ?? '',
    canonicalStringify(invoice.lineItems ?? []),
    canonicalStringify(invoice.metadata ?? {}),
  ].join('|')
}

export async function signInvoice(
  signer: LocalAccount,
  invoice: InvoiceV1Unsigned,
): Promise<InvoiceV1> {
  const merchantSig = await signer.signMessage({
    message: createInvoiceMessage(invoice),
  })

  return {
    ...invoice,
    merchantSig,
  }
}

export async function verifyInvoiceSignature(invoice: InvoiceV1): Promise<boolean> {
  const { merchantSig, ...unsignedInvoice } = invoice
  return verifyMessage({
    address: invoice.merchant,
    message: createInvoiceMessage(unsignedInvoice),
    signature: merchantSig,
  })
}

function isPrimitiveMetadata(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

export function assertInvoiceV1(value: unknown): asserts value is InvoiceV1 {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invoice is not an object')
  }

  const invoice = value as Partial<InvoiceV1>
  const requiredStringFields: (keyof InvoiceV1)[] = [
    'version',
    'invoiceId',
    'merchant',
    'recipient',
    'token',
    'amount',
    'memo',
    'description',
    'merchantSig',
  ]

  for (const field of requiredStringFields) {
    if (typeof invoice[field] !== 'string' || invoice[field]!.length === 0) {
      throw new Error(`Missing or invalid invoice field: ${field}`)
    }
  }

  if (invoice.version !== INVOICE_VERSION) {
    throw new Error(`Unsupported invoice version: ${invoice.version}`)
  }

  if (
    typeof invoice.issuedAt !== 'number' ||
    typeof invoice.dueAt !== 'number' ||
    typeof invoice.chainId !== 'number'
  ) {
    throw new Error('Invalid invoice timestamps or chainId')
  }

  if (invoice.dueAt <= invoice.issuedAt) {
    throw new Error('Invoice dueAt must be greater than issuedAt')
  }

  const merchant = invoice.merchant
  const recipient = invoice.recipient
  const payer = invoice.payer
  const token = invoice.token
  const amount = invoice.amount
  const memo = invoice.memo

  if (!merchant || !isAddress(merchant)) {
    throw new Error('Invalid invoice merchant address')
  }

  if (!recipient || !isAddress(recipient)) {
    throw new Error('Invalid invoice recipient address')
  }

  if (payer && !isAddress(payer)) {
    throw new Error('Invalid invoice payer address')
  }

  if (!token || !isAddress(token)) {
    throw new Error('Invalid invoice token address')
  }

  if (!amount) throw new Error('Invalid invoice amount format')
  const amountValue = parseAmountString(amount, 'invoice amount')

  if (!memo || !/^0x[a-fA-F0-9]{64}$/.test(memo)) {
    throw new Error('Invalid invoice memo format')
  }

  if (invoice.merchantReference && typeof invoice.merchantReference !== 'string') {
    throw new Error('Invalid invoice merchantReference')
  }

  if (invoice.purpose && typeof invoice.purpose !== 'string') {
    throw new Error('Invalid invoice purpose')
  }

  if (invoice.lineItems !== undefined) {
    if (!Array.isArray(invoice.lineItems)) {
      throw new Error('Invalid invoice lineItems')
    }

    for (const lineItem of invoice.lineItems) {
      if (typeof lineItem !== 'object' || lineItem === null) {
        throw new Error('Invalid line item shape')
      }

      const item = lineItem as Partial<InvoiceLineItemV1>
      if (!item.title || typeof item.title !== 'string') {
        throw new Error('Invalid line item title')
      }

      if (!item.totalAmount || !/^[0-9]+$/.test(item.totalAmount)) {
        throw new Error('Invalid line item totalAmount')
      }

      if (item.unitAmount && !/^[0-9]+$/.test(item.unitAmount)) {
        throw new Error('Invalid line item unitAmount')
      }

      if (item.quantity !== undefined && (!Number.isInteger(item.quantity) || item.quantity <= 0)) {
        throw new Error('Invalid line item quantity')
      }
    }

    if (invoice.lineItems.length > 0) {
      const lineItemTotal = sumLineItemTotals(invoice.lineItems)
      if (lineItemTotal !== amountValue) {
        throw new Error('Invoice amount must equal sum of lineItems[].totalAmount')
      }
    }
  }

  if (invoice.metadata !== undefined) {
    if (typeof invoice.metadata !== 'object' || invoice.metadata === null) {
      throw new Error('Invalid invoice metadata')
    }

    for (const metadataValue of Object.values(invoice.metadata)) {
      if (!isPrimitiveMetadata(metadataValue)) {
        throw new Error('Invoice metadata values must be string | number | boolean')
      }
    }
  }
}
