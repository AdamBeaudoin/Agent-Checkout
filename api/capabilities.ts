import type { VercelRequest, VercelResponse } from '@vercel/node'

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Idempotency-Key, x-merchant-confirm-token, x-demo-mode',
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

function originFromReq(req: VercelRequest) {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https'
  const host = (req.headers.host as string | undefined) ?? 'localhost'
  return `${proto}://${host}`
}

const ALPHA_USD = '0x20c0000000000000000000000000000000000001' as const
const EXPLORER_URL = 'https://explore.moderato.tempo.xyz'
const CHAIN_ID = 42431

export default function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).send('')
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' })

  const baseUrl = originFromReq(req)
  const merchantAddress = (process.env.MERCHANT_ADDRESS ??
    '0x0000000000000000000000000000000000000000') as `0x${string}`

  return res.status(200).json({
    standard: 'tempo.agent-payments.v1',
    merchant: {
      address: merchantAddress,
      name: process.env.MERCHANT_NAME ?? 'Tempo Agent Checkout Demo Merchant',
    },
    invoice: {
      version: 'tempo.invoice.v1',
      mode: 'generic',
      schema: `${baseUrl}/api/schemas/invoice-v1`,
      signature: 'eip191.personal_sign',
      requiredFields: [
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
      createRequest: {
        required: ['amount', 'description'],
        optional: [
          'recipient',
          'token',
          'payer',
          'dueAt',
          'dueInSeconds',
          'merchantReference',
          'purpose',
          'lineItems',
          'metadata',
          'listingId',
        ],
      },
    },
    network: {
      chainId: CHAIN_ID,
      settlementToken: ALPHA_USD,
    },
    settlement: {
      event: 'TransferWithMemo',
      requiredMatches: ['token', 'to', 'amount', 'memo', 'payer?'],
      explorer: EXPLORER_URL,
    },
    endpoints: {
      createInvoice: `${baseUrl}/api/invoices`,
      getInvoice: `${baseUrl}/api/invoices/{invoiceId}`,
      confirmSettlement: `${baseUrl}/api/confirm`,
      listOfferings: `${baseUrl}/api/listings`,
    },
    idempotency: {
      createInvoiceHeader: 'Idempotency-Key',
    },
  })
}

