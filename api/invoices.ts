import type { VercelRequest, VercelResponse } from '@vercel/node'

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Idempotency-Key, x-merchant-confirm-token, x-demo-mode',
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

const ALPHA_USD = '0x20c0000000000000000000000000000000000001' as const
const CHAIN_ID = 42431

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

type Order = {
  status: 'pending' | 'confirmed'
  listingId?: string
  invoice: InvoiceV1
  txHash?: `0x${string}`
  confirmedAt?: number
}

const LISTINGS = [
  { id: 'cozy-loft', title: 'Cozy Loft in Kreuzberg', priceUSDC: '285000000' },
  { id: 'modern-apt', title: 'Modern Apartment in Mitte', priceUSDC: '420000000' },
  { id: 'garden-studio', title: 'Garden Studio in Neukolln', priceUSDC: '250000000' },
] as const

function store() {
  const g = globalThis as unknown as {
    __tempo_orders?: Map<string, Order>
    __tempo_idem?: Map<string, { requestHash: string; invoiceId: string; createdAt: number }>
  }
  if (!g.__tempo_orders) g.__tempo_orders = new Map()
  if (!g.__tempo_idem) g.__tempo_idem = new Map()
  return { orders: g.__tempo_orders, idem: g.__tempo_idem }
}

function json(res: VercelResponse, status: number, body: unknown) {
  setCors(res)
  return res.status(status).json(body)
}

function pathFromReq(req: VercelRequest): string {
  try {
    // Vercel provides a path-only url.
    return new URL(req.url ?? '/', 'https://example.com').pathname
  } catch {
    return '/'
  }
}

function randomId() {
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0')
  return `INV-${Date.now()}-${rand}`
}

function createInvoiceMemo(invoiceId: string): `0x${string}` {
  const hex = Buffer.from(invoiceId, 'utf8').toString('hex')
  const padded = (hex + '0'.repeat(64)).slice(0, 64)
  return `0x${padded}` as `0x${string}`
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(',')}]`
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

function isTruthyHeader(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function placeholderSig(): `0x${string}` {
  // 65-byte signature placeholder (r,s,v) => 130 hex chars + 0x.
  return (`0x${'00'.repeat(65)}`) as `0x${string}`
}

function hashRequest(payload: unknown): string {
  try {
    return JSON.stringify(payload)
  } catch {
    return String(Date.now())
  }
}

async function readJsonBody(req: VercelRequest) {
  if (!req.body) return undefined
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

function getInvoiceIdFromReq(req: VercelRequest): string | undefined {
  const fromQuery = req.query?.invoiceId
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim()
  if (Array.isArray(fromQuery) && typeof fromQuery[0] === 'string' && fromQuery[0].trim()) {
    return fromQuery[0].trim()
  }

  const pathname = pathFromReq(req)
  const match = pathname.match(/^\/api\/invoices\/([^/]+)$/)
  if (match?.[1]) return match[1]
  return undefined
}

async function handleGetInvoice(req: VercelRequest, res: VercelResponse) {
  const invoiceId = getInvoiceIdFromReq(req)
  if (!invoiceId) return json(res, 400, { ok: false, code: 'MISSING_INVOICE_ID' })

  const { orders } = store()
  const order = orders.get(invoiceId)
  if (!order) return json(res, 404, { ok: false, code: 'NOT_FOUND' })

  return json(res, 200, {
    ok: true,
    standard: 'tempo.agent-payments.v1',
    status: order.status,
    invoice: order.invoice,
    listingId: order.listingId,
    txHash: order.txHash,
    confirmedAt: order.confirmedAt,
  })
}

async function handleDemoConfirm(req: VercelRequest, res: VercelResponse) {
  const body = await readJsonBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, 400, { ok: false, code: 'BAD_JSON', message: 'Request body must be JSON object' })
  }

  const payload = body as Record<string, unknown>
  const invoiceId = typeof payload.invoiceId === 'string' ? payload.invoiceId : undefined
  const txHash = typeof payload.txHash === 'string' ? (payload.txHash as `0x${string}`) : undefined
  if (!invoiceId) return json(res, 400, { ok: false, code: 'MISSING_INVOICE_ID' })
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return json(res, 400, { ok: false, code: 'INVALID_TX_HASH' })
  }

  const { orders } = store()
  const existing = orders.get(invoiceId)
  if (!existing) return json(res, 404, { ok: false, code: 'NOT_FOUND' })

  const now = Math.floor(Date.now() / 1000)
  const updated: Order = {
    ...existing,
    status: 'confirmed',
    txHash,
    confirmedAt: now,
  }
  orders.set(invoiceId, updated)

  return json(res, 200, { ok: true, status: 'confirmed', txHash, confirmedAt: now })
}

function handleConfirmSettlement(_req: VercelRequest, res: VercelResponse) {
  return json(res, 501, { ok: false, code: 'NOT_IMPLEMENTED', message: 'Use /api/demo/confirm for the hackathon demo.' })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).send('')
  const pathname = pathFromReq(req)

  if (pathname === '/api/demo/confirm') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
    return handleDemoConfirm(req, res)
  }

  if (pathname === '/api/confirm') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
    return handleConfirmSettlement(req, res)
  }

  if (req.method === 'GET') return handleGetInvoice(req, res)
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })

  const { orders, idem } = store()

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
    return json(res, 400, { ok: false, code: 'INVALID_LISTING', message: 'Unknown listingId' })
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
    const demoMode = isTruthyHeader(req.headers['x-demo-mode'])
    if (!demoMode) {
      return json(res, 500, {
        ok: false,
        code: 'MERCHANT_NOT_CONFIGURED',
        message: merchantEnv.error,
      })
    }

    const now = Math.floor(Date.now() / 1000)
    const invoiceId = randomId()
    const merchant = '0x0000000000000000000000000000000000000000' as const
    const unsigned: Omit<InvoiceV1, 'merchantSig'> = {
      version: 'tempo.invoice.v1',
      invoiceId,
      issuedAt: now,
      dueAt: now + 10 * 60,
      chainId: CHAIN_ID,
      merchant,
      recipient: merchant,
      ...(payer ? { payer } : {}),
      token: ALPHA_USD,
      amount: listing.priceUSDC,
      memo: createInvoiceMemo(invoiceId),
      description: `Airbnb booking: ${listing.title} (weekend)`,
      metadata: { listingId: listing.id, listingTitle: listing.title, demoUnsigned: true },
    }

    const invoice: InvoiceV1 = { ...unsigned, merchantSig: placeholderSig() }
    orders.set(invoice.invoiceId, { status: 'pending', listingId: listing.id, invoice })

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
      warning: 'DEMO_UNSIGNED_INVOICE',
    })
  }

  const { privateKeyToAccount } = await import('viem/accounts')
  const signer = privateKeyToAccount(merchantEnv.merchantPrivateKey)

  const now = Math.floor(Date.now() / 1000)
  const invoiceId = randomId()
  const unsigned: Omit<InvoiceV1, 'merchantSig'> = {
    version: 'tempo.invoice.v1',
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
    metadata: { listingId: listing.id, listingTitle: listing.title },
  }

  const merchantSig = await signer.signMessage({ message: createInvoiceMessage(unsigned) })
  const invoice: InvoiceV1 = { ...unsigned, merchantSig }

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
