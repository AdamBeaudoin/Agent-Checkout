import type { VercelRequest, VercelResponse } from '@vercel/node'

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Idempotency-Key, x-merchant-confirm-token, x-demo-mode',
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).send('')
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' })

  return res.status(200).json({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
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
      version: { type: 'string', const: 'tempo.invoice.v1' },
      invoiceId: { type: 'string', minLength: 1, maxLength: 128 },
      issuedAt: { type: 'integer', minimum: 1 },
      dueAt: { type: 'integer', minimum: 1 },
      chainId: { type: 'integer', minimum: 1 },
      merchant: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      recipient: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      payer: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      token: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      amount: { type: 'string', pattern: '^[0-9]+$' },
      memo: { type: 'string', pattern: '^0x[a-fA-F0-9]{64}$' },
      description: { type: 'string', minLength: 1, maxLength: 512 },
      merchantReference: { type: 'string', minLength: 1, maxLength: 128 },
      purpose: { type: 'string', minLength: 1, maxLength: 128 },
      lineItems: { type: 'array' },
      metadata: { type: 'object' },
      merchantSig: { type: 'string', pattern: '^0x[a-fA-F0-9]+$' },
    },
  })
}

