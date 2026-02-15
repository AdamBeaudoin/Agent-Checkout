import type { VercelRequest, VercelResponse } from '@vercel/node'

// NOTE: Keep this file self-contained for Vercel. Importing local TS modules using `.js`
// specifiers can cause runtime failures in Vercel's Node function environment.
const ALPHA_USD = '0x20c0000000000000000000000000000000000001' as const
const EXPLORER_URL = 'https://explore.moderato.tempo.xyz'
const CHAIN_ID = 42431

type Listing = {
  id: string
  title: string
  priceUSDC: string
  currency: 'EUR'
  weekendPriceEUR: number
  neighborhood: string
  imageUrl: string
  rating: number
  reviews: number
  guestFavorite: boolean
  nights: number
  description: string
}

type InvoiceV1 = {
  version: 'tempo.invoice.v1'
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
  lineItems?: Array<{
    id?: string
    title: string
    category?: string
    quantity?: number
    unitAmount?: string
    totalAmount: string
  }>
  metadata?: Record<string, string | number | boolean>
  merchantSig: `0x${string}`
}

type OrderStatus = 'pending' | 'confirmed'

type Order = {
  status: OrderStatus
  listingId?: string
  invoice: InvoiceV1
  txHash?: `0x${string}`
  confirmedAt?: number
}

const LISTINGS: Listing[] = [
  {
    id: 'cozy-loft',
    title: 'Cozy Loft in Kreuzberg',
    priceUSDC: '285000000',
    currency: 'EUR',
    weekendPriceEUR: 285,
    neighborhood: 'Kreuzberg',
    imageUrl:
      'https://images.unsplash.com/photo-1505692952047-1a78307da8f2?auto=format&fit=crop&w=1400&q=80',
    rating: 4.92,
    reviews: 373,
    guestFavorite: true,
    nights: 3,
    description: 'Sunny loft near Gorlitzer Park with fast check-in',
  },
  {
    id: 'modern-apt',
    title: 'Modern Apartment in Mitte',
    priceUSDC: '420000000',
    currency: 'EUR',
    weekendPriceEUR: 420,
    neighborhood: 'Mitte',
    imageUrl:
      'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?auto=format&fit=crop&w=1400&q=80',
    rating: 4.88,
    reviews: 346,
    guestFavorite: true,
    nights: 2,
    description: 'Central location, rooftop terrace, walk to Museum Island',
  },
  {
    id: 'garden-studio',
    title: 'Garden Studio in Neukolln',
    priceUSDC: '250000000',
    currency: 'EUR',
    weekendPriceEUR: 250,
    neighborhood: 'Neukolln',
    imageUrl:
      'https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=1400&q=80',
    rating: 4.97,
    reviews: 255,
    guestFavorite: true,
    nights: 1,
    description: 'Quiet studio with private garden and late self check-in',
  },
]

function createInvoiceMemo(invoiceId: string): `0x${string}` {
  // Encode invoiceId as UTF-8 hex and pad/truncate to 32 bytes.
  const hex = Buffer.from(invoiceId, 'utf8').toString('hex')
  const padded = (hex + '0'.repeat(64)).slice(0, 64)
  return `0x${padded}` as `0x${string}`
}

function canonicalStringify(value: unknown): string {
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

function createInvoiceMessage(invoice: Omit<InvoiceV1, 'merchantSig'>): string {
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

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Idempotency-Key, x-merchant-confirm-token, x-demo-mode',
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

function json(res: VercelResponse, status: number, body: unknown) {
  setCors(res)
  res.status(status).json(body)
}

function badMethod(res: VercelResponse) {
  return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
}

function originFromReq(req: VercelRequest) {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https'
  const host = (req.headers.host as string | undefined) ?? 'localhost'
  return `${proto}://${host}`
}

function randomId() {
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0')
  return `INV-${Date.now()}-${rand}`
}

function normalizeOptionalAddress(value: unknown): `0x${string}` | undefined {
  if (typeof value !== 'string') return undefined
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) return undefined
  return value as `0x${string}`
}

function requireMerchantEnv() {
  const merchantAddress = (process.env.MERCHANT_ADDRESS ?? '') as `0x${string}`
  const merchantPrivateKey = process.env.MERCHANT_PRIVATE_KEY as `0x${string}` | undefined

  if (!/^0x[a-fA-F0-9]{40}$/.test(merchantAddress)) {
    return { ok: false as const, error: 'Missing/invalid MERCHANT_ADDRESS' }
  }
  if (!merchantPrivateKey || !/^0x[a-fA-F0-9]{64}$/.test(merchantPrivateKey)) {
    return { ok: false as const, error: 'Missing/invalid MERCHANT_PRIVATE_KEY' }
  }

  return { ok: true as const, merchantAddress, merchantPrivateKey }
}

function store() {
  const g = globalThis as unknown as {
    __tempo_orders?: Map<string, Order>
    __tempo_idem?: Map<string, { requestHash: string; invoiceId: string; createdAt: number }>
  }
  if (!g.__tempo_orders) g.__tempo_orders = new Map()
  if (!g.__tempo_idem) g.__tempo_idem = new Map()
  return { orders: g.__tempo_orders, idem: g.__tempo_idem }
}

function hashRequest(payload: unknown): string {
  // Not cryptographic, just stable enough for demo idempotency.
  try {
    return JSON.stringify(payload)
  } catch {
    return String(Date.now())
  }
}

async function readJsonBody(req: VercelRequest) {
  if (!req.body) return undefined
  // Vercel may already parse JSON into an object.
  if (typeof req.body === 'object') return req.body as unknown
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body) as unknown
    } catch {
      return undefined
    }
  }
  return undefined
}

function capabilitiesJson(baseUrl: string) {
  const merchantAddress = (process.env.MERCHANT_ADDRESS ??
    '0x0000000000000000000000000000000000000000') as `0x${string}`

  return {
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
  }
}

async function handleInvoices(req: VercelRequest, res: VercelResponse, baseUrl: string) {
  const { orders, idem } = store()

  if (req.method !== 'POST') return badMethod(res)

  const body = await readJsonBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, 400, { ok: false, code: 'BAD_JSON', message: 'Request body must be JSON object' })
  }

  const request = body as Record<string, unknown>
  const payer = normalizeOptionalAddress(request.payer)
  const listingId = typeof request.listingId === 'string' ? request.listingId : undefined

  const listing =
    (listingId ? LISTINGS.find((item) => item.id === listingId) : undefined) ?? LISTINGS[0]
  if (!listing) {
    return json(res, 400, {
      ok: false,
      code: 'INVALID_LISTING',
      message: 'Unknown listingId',
    })
  }

  const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim()
  if (idempotencyKey) {
    if (idempotencyKey.length > 128 || !/^[A-Za-z0-9:._-]+$/.test(idempotencyKey)) {
      return json(res, 400, {
        ok: false,
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must be <= 128 chars and use [A-Za-z0-9:._-]',
      })
    }
    const requestHash = hashRequest({ listingId: listing.id, payer })
    const existing = idem.get(idempotencyKey)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return json(res, 409, {
          ok: false,
          code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
          message: 'Idempotency-Key already used with different request payload.',
        })
      }
      const existingOrder = orders.get(existing.invoiceId)
      if (!existingOrder) {
        return json(res, 500, { ok: false, code: 'INVOICE_LOOKUP_FAILED', message: 'Invoice missing' })
      }
      return json(res, 200, {
        ok: true,
        standard: 'tempo.agent-payments.v1',
        invoice: existingOrder.invoice,
        idempotentReplay: true,
      })
    }
  }

  const merchantEnv = requireMerchantEnv()
  if (!merchantEnv.ok) {
    return json(res, 500, { ok: false, code: 'MERCHANT_NOT_CONFIGURED', message: merchantEnv.error })
  }

  const now = Math.floor(Date.now() / 1000)
  const invoiceId = randomId()

  // Lazy-load viem only on invoice creation.
  const { privateKeyToAccount } = await import('viem/accounts')
  const signer = privateKeyToAccount(merchantEnv.merchantPrivateKey)

  const unsigned = {
    version: 'tempo.invoice.v1' as const,
    invoiceId,
    issuedAt: now,
    dueAt: now + 10 * 60,
    chainId: CHAIN_ID,
    merchant: merchantEnv.merchantAddress,
    recipient: merchantEnv.merchantAddress,
    ...(payer ? { payer } : {}),
    token: ALPHA_USD,
    amount: listing.priceUSDC,
    memo: createInvoiceMemo(invoiceId),
    description: `Airbnb booking: ${listing.title} (weekend)`,
    metadata: {
      listingId: listing.id,
      listingTitle: listing.title,
      currency: listing.currency,
      weekendPriceEUR: listing.weekendPriceEUR,
      origin: baseUrl,
    },
  }

  const merchantSig = await signer.signMessage({ message: createInvoiceMessage(unsigned as any) })
  const invoice = { ...(unsigned as any), merchantSig } as InvoiceV1

  orders.set(invoice.invoiceId, {
    status: 'pending',
    listingId: listing.id,
    invoice,
  })

  if (idempotencyKey) {
    idem.set(idempotencyKey, {
      requestHash: hashRequest({ listingId: listing.id, payer }),
      invoiceId: invoice.invoiceId,
      createdAt: now,
    })
  }

  return json(res, 200, {
    ok: true,
    standard: 'tempo.agent-payments.v1',
    invoice,
    idempotentReplay: false,
  })
}

async function handleInvoiceLookup(req: VercelRequest, res: VercelResponse, invoiceId: string) {
  const { orders } = store()
  if (req.method !== 'GET') return badMethod(res)

  const order = orders.get(invoiceId)
  if (!order) return json(res, 404, { ok: false, code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' })

  return json(res, 200, {
    ok: true,
    invoice: order.invoice,
    status: order.status,
    txHash: order.txHash,
    confirmedAt: order.confirmedAt,
  })
}

async function handleDemoConfirm(req: VercelRequest, res: VercelResponse) {
  const allowDemo =
    process.env.ALLOW_DEMO_CONFIRM !== undefined
      ? process.env.ALLOW_DEMO_CONFIRM === 'true'
      : process.env.NODE_ENV !== 'production'
  if (!allowDemo) {
    return json(res, 401, {
      ok: false,
      code: 'DEMO_CONFIRM_DISABLED',
      message: 'Demo confirmation disabled',
    })
  }

  if (req.method !== 'POST') return badMethod(res)
  const body = await readJsonBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, 400, { ok: false, code: 'BAD_JSON', message: 'Request body must be JSON object' })
  }

  const { orders } = store()
  const invoiceId = typeof (body as any).invoiceId === 'string' ? (body as any).invoiceId : undefined
  const txHash = typeof (body as any).txHash === 'string' ? (body as any).txHash : undefined
  if (!invoiceId) return json(res, 400, { ok: false, code: 'MISSING_INVOICE_ID', message: 'invoiceId required' })
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return json(res, 400, { ok: false, code: 'INVALID_TX_HASH', message: 'txHash must be 0x…64 hex' })
  }

  const order = orders.get(invoiceId)
  if (!order) return json(res, 404, { ok: false, code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' })

  if (order.status === 'confirmed') {
    return json(res, 200, {
      ok: true,
      mode: 'demo',
      status: 'confirmed',
      invoiceId: order.invoice.invoiceId,
      txHash: order.txHash,
      idempotentReplay: true,
    })
  }

  order.status = 'confirmed'
  order.txHash = txHash as `0x${string}`
  order.confirmedAt = Math.floor(Date.now() / 1000)

  return json(res, 200, {
    ok: true,
    mode: 'demo',
    status: 'confirmed',
    invoiceId: order.invoice.invoiceId,
    txHash,
    idempotentReplay: false,
  })
}

async function handleSchema(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return badMethod(res)
  // Minimal schema for agents to validate shape quickly (MVP).
  return json(res, 200, {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).send('')

  const baseUrl = originFromReq(req)
  const url = new URL(req.url ?? '/', baseUrl)
  const pathname = url.pathname

  // Health used by the demo UI (merchant + guardian dots).
  if (pathname === '/api/health') {
    if (req.method !== 'GET') return badMethod(res)
    return json(res, 200, { ok: true, policyCount: 1, mode: 'vercel-functions' })
  }

  if (pathname === '/api/capabilities') {
    if (req.method !== 'GET') return badMethod(res)
    return json(res, 200, capabilitiesJson(baseUrl))
  }

  if (pathname === '/.well-known/tempo-agent-payments.json') {
    if (req.method !== 'GET') return badMethod(res)
    return json(res, 200, capabilitiesJson(baseUrl))
  }

  if (pathname === '/api/listings') {
    if (req.method !== 'GET') return badMethod(res)
    return json(res, 200, LISTINGS)
  }

  if (pathname === '/api/schemas/invoice-v1') {
    return handleSchema(req, res)
  }

  if (pathname === '/api/invoices') {
    return handleInvoices(req, res, baseUrl)
  }

  const invoiceMatch = pathname.match(/^\\/api\\/invoices\\/([^/]+)$/)
  if (invoiceMatch) {
    return handleInvoiceLookup(req, res, invoiceMatch[1]!)
  }

  if (pathname === '/api/demo/confirm') {
    return handleDemoConfirm(req, res)
  }

  // Keep the standard endpoint present even for demo-only deployments.
  if (pathname === '/api/confirm' || pathname === '/api/settlements/confirm') {
    return json(res, 501, {
      ok: false,
      code: 'CONFIRM_NOT_IMPLEMENTED_ON_VERCEL',
      message: 'Use /api/demo/confirm for the hackathon demo deployment.',
    })
  }

  return json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Unknown endpoint' })
}
