import { Hono, type Context } from 'hono'
import { serve } from '@hono/node-server'
import { handle } from 'hono/vercel'
import { isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  createTempoPublicClient,
  ALPHA_USD,
  EXPLORER_URL,
  CHAIN_ID,
} from '../shared/config.js'
import {
  INVOICE_V1_JSON_SCHEMA,
  type InvoiceLineItemV1,
  type InvoiceMetadata,
  type InvoiceV1,
} from '../shared/invoice.js'
import { InMemoryRateLimiter, getClientIp } from '../shared/rateLimit.js'
import { loadJsonState, saveJsonState } from '../shared/stateStore.js'
import { MERCHANT_STANDARD_VERSION, TempoMerchantSdk } from '../sdk/merchant.js'
import 'dotenv/config'

const app = new Hono()

const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS as `0x${string}`
const MERCHANT_PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY as `0x${string}`
const MERCHANT_BASE_URL = process.env.MERCHANT_BASE_URL ?? 'http://localhost:3000'
const MERCHANT_STATE_PATH = process.env.MERCHANT_STATE_PATH ?? './data/merchant-state.json'
const MERCHANT_CONFIRM_TOKEN = process.env.MERCHANT_CONFIRM_TOKEN?.trim()
const ALLOW_DEMO_CONFIRM =
  process.env.ALLOW_DEMO_CONFIRM !== undefined
    ? process.env.ALLOW_DEMO_CONFIRM === 'true'
    : process.env.NODE_ENV !== 'production'
const MAX_DESCRIPTION_LENGTH = 512
const MAX_REFERENCE_LENGTH = 128
const MAX_PURPOSE_LENGTH = 128
const MAX_LINE_ITEMS = 50
const MAX_METADATA_FIELDS = 50
const MAX_METADATA_KEY_LENGTH = 64
const MAX_METADATA_STRING_VALUE_LENGTH = 256
const MAX_DUE_IN_SECONDS = 30 * 24 * 60 * 60
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui')
const CHAT_UI_PATH = path.join(UI_DIR, 'chat.html')
const RECEIPT_UI_PATH = path.join(UI_DIR, 'receipt.html')
const IS_VERCEL_RUNTIME = process.env.VERCEL === '1' || process.env.VERCEL === 'true'

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

const invoiceRateLimiter = new InMemoryRateLimiter({
  maxRequests: parsePositiveIntegerEnv('MERCHANT_INVOICE_RATE_LIMIT_MAX', 60),
  windowMs: parsePositiveIntegerEnv('MERCHANT_INVOICE_RATE_LIMIT_WINDOW_MS', 60_000),
})

const settlementRateLimiter = new InMemoryRateLimiter({
  maxRequests: parsePositiveIntegerEnv('MERCHANT_CONFIRM_RATE_LIMIT_MAX', 30),
  windowMs: parsePositiveIntegerEnv('MERCHANT_CONFIRM_RATE_LIMIT_WINDOW_MS', 60_000),
})

if (!MERCHANT_ADDRESS || !MERCHANT_PRIVATE_KEY) {
  console.error('Missing MERCHANT_ADDRESS or MERCHANT_PRIVATE_KEY in .env. Run setup.ts first.')
  process.exit(1)
}

function setCorsHeaders(c: Context) {
  c.header('Access-Control-Allow-Origin', '*')
  c.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Idempotency-Key, x-merchant-confirm-token, x-demo-mode',
  )
  c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

app.use('*', async (c, next) => {
  setCorsHeaders(c)

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204)
  }

  await next()
  setCorsHeaders(c)
})

const merchantSigner = privateKeyToAccount(MERCHANT_PRIVATE_KEY)
if (merchantSigner.address.toLowerCase() !== MERCHANT_ADDRESS.toLowerCase()) {
  console.error('MERCHANT_PRIVATE_KEY does not match MERCHANT_ADDRESS.')
  process.exit(1)
}

const merchantSdk = new TempoMerchantSdk({
  baseUrl: MERCHANT_BASE_URL,
  chainId: CHAIN_ID,
  defaultRecipient: MERCHANT_ADDRESS,
  defaultToken: ALPHA_USD,
  explorerUrl: EXPLORER_URL,
  merchantAddress: MERCHANT_ADDRESS,
  merchantName: 'Tempo Agent Checkout Demo Merchant',
  signer: merchantSigner,
})

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

type OrderStatus = 'pending' | 'confirmed'

type Order = {
  status: OrderStatus
  listingId?: string
  invoice: InvoiceV1
  txHash?: `0x${string}`
  confirmedAt?: number
}

type IdempotencyRecord = {
  requestHash: string
  invoiceId: string
  createdAt: number
}

type PersistedMerchantState = {
  orders: Array<{
    invoiceId: string
    order: Order
  }>
  idempotency: Array<{
    key: string
    value: IdempotencyRecord
  }>
}

type CreateInvoiceRequest = {
  listingId?: string
  payer?: string
  recipient?: string
  token?: string
  amount?: string
  description?: string
  dueAt?: number
  dueInSeconds?: number
  merchantReference?: string
  purpose?: string
  lineItems?: InvoiceLineItemV1[]
  metadata?: InvoiceMetadata
}

type ResolvedInvoiceInput = {
  listingId?: string
  recipient: `0x${string}`
  token: `0x${string}`
  amount: string
  description: string
  dueAt: number
  merchantReference?: string
  purpose?: string
  lineItems?: InvoiceLineItemV1[]
  metadata?: InvoiceMetadata
}

const initialState = loadJsonState<PersistedMerchantState>(MERCHANT_STATE_PATH, {
  orders: [],
  idempotency: [],
})

const orders = new Map<string, Order>(
  initialState.orders.map((entry) => [entry.invoiceId, entry.order]),
)

const invoicesByIdempotencyKey = new Map<string, IdempotencyRecord>(
  initialState.idempotency.map((entry) => [entry.key, entry.value]),
)

function persistMerchantState() {
  saveJsonState(MERCHANT_STATE_PATH, {
    orders: Array.from(orders.entries()).map(([invoiceId, order]) => ({
      invoiceId,
      order,
    })),
    idempotency: Array.from(invoicesByIdempotencyKey.entries()).map(([key, value]) => ({
      key,
      value,
    })),
  } satisfies PersistedMerchantState)
}

function errorResponse(
  c: Context,
  status: 400 | 401 | 404 | 409 | 413 | 429 | 500,
  code: string,
  message: string,
  details?: Record<string, string | number | boolean>,
) {
  return c.json(
    {
      ok: false,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    },
    status,
  )
}

function rateLimitOrError(c: Context, limiter: InMemoryRateLimiter, bucket: string) {
  const key = `${bucket}:${getClientIp(c.req)}`
  const result = limiter.check(key)
  if (result.allowed) return undefined

  return errorResponse(c, 429, 'RATE_LIMITED', 'Too many requests. Try again shortly.', {
    retryAfterSeconds: result.retryAfterSeconds,
  })
}

function requireSettlementAuthOrError(c: Context) {
  if (!MERCHANT_CONFIRM_TOKEN) return undefined

  const provided = c.req.header('x-merchant-confirm-token')
  if (provided === MERCHANT_CONFIRM_TOKEN) return undefined

  return errorResponse(
    c,
    401,
    'UNAUTHORIZED_SETTLEMENT_CONFIRM',
    'Missing or invalid x-merchant-confirm-token',
  )
}

function isNonEmptyStringWithin(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function normalizeOptionalAddress(value: unknown): `0x${string}` | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !isAddress(value)) return null
  return value.toLowerCase() as `0x${string}`
}

function isAmountString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value)
}

function normalizeMetadata(value: unknown): InvoiceMetadata | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const entries = Object.entries(value)
  if (entries.length > MAX_METADATA_FIELDS) return null

  const normalized: InvoiceMetadata = {}

  for (const [key, rawValue] of entries) {
    if (!isNonEmptyStringWithin(key, MAX_METADATA_KEY_LENGTH)) {
      return null
    }

    if (
      typeof rawValue !== 'string' &&
      typeof rawValue !== 'number' &&
      typeof rawValue !== 'boolean'
    ) {
      return null
    }

    if (typeof rawValue === 'string' && rawValue.length > MAX_METADATA_STRING_VALUE_LENGTH) {
      return null
    }

    if (typeof rawValue === 'number' && !Number.isFinite(rawValue)) {
      return null
    }

    normalized[key] = rawValue
  }

  return normalized
}

function normalizeLineItems(value: unknown): InvoiceLineItemV1[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  if (value.length > MAX_LINE_ITEMS) return null

  const items: InvoiceLineItemV1[] = []

  for (const rawItem of value) {
    if (typeof rawItem !== 'object' || rawItem === null) return null
    const item = rawItem as Partial<InvoiceLineItemV1>

    if (!isNonEmptyStringWithin(item.title, 256)) return null
    if (!item.totalAmount || !isAmountString(item.totalAmount)) return null

    if (item.id !== undefined && !isNonEmptyStringWithin(item.id, 128)) return null
    if (item.category !== undefined && !isNonEmptyStringWithin(item.category, 128)) return null
    if (item.unitAmount !== undefined && !isAmountString(item.unitAmount)) return null
    if (
      item.quantity !== undefined &&
      (!Number.isInteger(item.quantity) || item.quantity <= 0)
    ) {
      return null
    }

    if (item.unitAmount && item.quantity) {
      const expectedTotal = BigInt(item.unitAmount) * BigInt(item.quantity)
      if (expectedTotal !== BigInt(item.totalAmount)) {
        return null
      }
    }

    items.push({
      ...(item.id ? { id: item.id } : {}),
      title: item.title,
      ...(item.category ? { category: item.category } : {}),
      ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
      ...(item.unitAmount ? { unitAmount: item.unitAmount } : {}),
      totalAmount: item.totalAmount,
    })
  }

  return items
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )
    return `{${entries
      .map(([key, itemValue]) => `${JSON.stringify(key)}:${stableStringify(itemValue)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

function hashInvoiceRequest(input: CreateInvoiceRequest, payer?: `0x${string}`) {
  return stableStringify({ ...input, payer: payer ?? '' })
}

function resolveInvoiceInput(
  input: CreateInvoiceRequest,
  payer?: `0x${string}`,
): { value?: ResolvedInvoiceInput; error?: { status: 400 | 404; code: string; message: string } } {
  const now = Math.floor(Date.now() / 1000)

  if (
    input.merchantReference !== undefined &&
    !isNonEmptyStringWithin(input.merchantReference, MAX_REFERENCE_LENGTH)
  ) {
    return {
      error: {
        status: 400,
        code: 'INVALID_MERCHANT_REFERENCE',
        message: `merchantReference must be 1-${MAX_REFERENCE_LENGTH} characters`,
      },
    }
  }

  if (input.purpose !== undefined && !isNonEmptyStringWithin(input.purpose, MAX_PURPOSE_LENGTH)) {
    return {
      error: {
        status: 400,
        code: 'INVALID_PURPOSE',
        message: `purpose must be 1-${MAX_PURPOSE_LENGTH} characters`,
      },
    }
  }

  const recipient = normalizeOptionalAddress(input.recipient)
  if (recipient === null) {
    return {
      error: {
        status: 400,
        code: 'INVALID_RECIPIENT_ADDRESS',
        message: 'Invalid recipient address',
      },
    }
  }

  const token = normalizeOptionalAddress(input.token)
  if (token === null) {
    return {
      error: {
        status: 400,
        code: 'INVALID_TOKEN_ADDRESS',
        message: 'Invalid token address',
      },
    }
  }

  const metadata = normalizeMetadata(input.metadata)
  if (metadata === null) {
    return {
      error: {
        status: 400,
        code: 'INVALID_METADATA',
        message: 'metadata must be an object with primitive values',
      },
    }
  }

  const lineItems = normalizeLineItems(input.lineItems)
  if (lineItems === null) {
    return {
      error: {
        status: 400,
        code: 'INVALID_LINE_ITEMS',
        message: 'lineItems must be a valid array of invoice line items',
      },
    }
  }

  if (input.dueAt !== undefined && (!Number.isInteger(input.dueAt) || input.dueAt <= now)) {
    return {
      error: {
        status: 400,
        code: 'INVALID_DUE_AT',
        message: 'dueAt must be a future unix timestamp (seconds)',
      },
    }
  }

  if (
    input.dueInSeconds !== undefined &&
    (!Number.isInteger(input.dueInSeconds) ||
      input.dueInSeconds <= 0 ||
      input.dueInSeconds > MAX_DUE_IN_SECONDS)
  ) {
    return {
      error: {
        status: 400,
        code: 'INVALID_DUE_IN_SECONDS',
        message: `dueInSeconds must be a positive integer <= ${MAX_DUE_IN_SECONDS}`,
      },
    }
  }

  const dueAt = input.dueAt ?? now + (input.dueInSeconds ?? 10 * 60)

  if (input.listingId) {
    const listing = LISTINGS.find((item) => item.id === input.listingId)
    if (!listing) {
      return {
        error: {
          status: 404,
          code: 'LISTING_NOT_FOUND',
          message: 'Listing not found',
        },
      }
    }

    return {
      value: {
        listingId: listing.id,
        recipient: recipient ?? MERCHANT_ADDRESS,
        token: token ?? ALPHA_USD,
        amount: listing.priceUSDC,
        description: `${listing.title} (${listing.nights} nights)`,
        dueAt,
        purpose: input.purpose ?? 'lodging_booking',
        merchantReference: input.merchantReference,
        lineItems: lineItems ?? [
          {
            id: listing.id,
            title: listing.title,
            category: 'lodging',
            quantity: listing.nights,
            totalAmount: listing.priceUSDC,
          },
        ],
        metadata: {
          listingId: listing.id,
          nights: listing.nights,
          title: listing.title,
          checkoutType: 'lodging',
          ...(metadata ?? {}),
        },
      },
    }
  }

  if (!isAmountString(input.amount)) {
    return {
      error: {
        status: 400,
        code: 'MISSING_OR_INVALID_AMOUNT',
        message: 'amount is required and must be a numeric string',
      },
    }
  }

  if (
    !input.description ||
    typeof input.description !== 'string' ||
    input.description.trim().length === 0
  ) {
    return {
      error: {
        status: 400,
        code: 'MISSING_DESCRIPTION',
        message: 'description is required for generic invoices',
      },
    }
  }

  if (input.description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      error: {
        status: 400,
        code: 'DESCRIPTION_TOO_LONG',
        message: `description must be <= ${MAX_DESCRIPTION_LENGTH} characters`,
      },
    }
  }

  return {
    value: {
      recipient: recipient ?? MERCHANT_ADDRESS,
      token: token ?? ALPHA_USD,
      amount: input.amount,
      description: input.description,
      dueAt,
      purpose: input.purpose,
      merchantReference: input.merchantReference,
      lineItems,
      metadata,
    },
  }
}

async function issueInvoice(input: ResolvedInvoiceInput, payer?: `0x${string}`) {
  const invoice = await merchantSdk.createInvoice({
    amount: input.amount,
    description: input.description,
    dueAt: input.dueAt,
    lineItems: input.lineItems,
    merchantReference: input.merchantReference,
    metadata: input.metadata,
    payer,
    purpose: input.purpose,
    recipient: input.recipient,
    token: input.token,
  })

  orders.set(invoice.invoiceId, {
    status: 'pending',
    listingId: input.listingId,
    invoice,
  })

  return invoice
}

function buildCapabilities() {
  return merchantSdk.buildCapabilities({
    confirmSettlementPath: '/api/confirm',
    createInvoicePath: '/api/invoices',
    getInvoicePath: '/api/invoices/{invoiceId}',
    listOfferingsPath: '/api/listings',
    schemaPath: '/api/schemas/invoice-v1',
  })
}

function serveUiTemplate(c: Context, templatePath: string) {
  try {
    const template = fs.readFileSync(templatePath, 'utf8')
    const guardianBaseUrl =
      process.env.GUARDIAN_URL ?? (IS_VERCEL_RUNTIME ? MERCHANT_BASE_URL : 'http://localhost:3001')
    const html = template
      .replaceAll('__MERCHANT_BASE_URL__', MERCHANT_BASE_URL)
      .replaceAll('__GUARDIAN_BASE_URL__', guardianBaseUrl)
    return c.html(html)
  } catch (error) {
    return c.text(
      `UI unavailable. Expected demo file at ${templatePath}. Error: ${
        error instanceof Error ? error.message : 'unknown'
      }`,
      500,
    )
  }
}

app.get('/', (c) => {
  return serveUiTemplate(c, CHAT_UI_PATH)
})

app.get('/demo', (c) => c.redirect('/'))
app.get('/receipt', (c) => serveUiTemplate(c, RECEIPT_UI_PATH))

app.get('/.well-known/tempo-agent-payments.json', (c) => {
  return c.json(buildCapabilities())
})

app.get('/api/capabilities', (c) => {
  return c.json(buildCapabilities())
})

app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    policyCount: 1,
    mode: 'embedded',
  })
})

app.get('/api/schemas/invoice-v1', (c) => {
  return c.json(INVOICE_V1_JSON_SCHEMA)
})

app.get('/api/listings', (c) => c.json(LISTINGS))

app.post('/api/invoices', async (c) => {
  const rateLimitError = rateLimitOrError(c, invoiceRateLimiter, 'create-invoice')
  if (rateLimitError) return rateLimitError

  const contentLength = c.req.header('content-length')
  if (contentLength && Number(contentLength) > 100_000) {
    return errorResponse(c, 413, 'REQUEST_TOO_LARGE', 'Request body exceeds 100KB')
  }

  let body: unknown

  try {
    body = await c.req.json()
  } catch {
    return errorResponse(c, 400, 'BAD_JSON', 'Request body must be valid JSON')
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return errorResponse(c, 400, 'INVALID_BODY', 'Request body must be an object')
  }

  const request = body as CreateInvoiceRequest

  const payer = normalizeOptionalAddress(request.payer)
  if (payer === null) {
    return errorResponse(c, 400, 'INVALID_PAYER_ADDRESS', 'Invalid payer address')
  }

  const resolveResult = resolveInvoiceInput(request, payer)
  if (resolveResult.error) {
    return errorResponse(
      c,
      resolveResult.error.status,
      resolveResult.error.code,
      resolveResult.error.message,
    )
  }

  const resolved = resolveResult.value as ResolvedInvoiceInput

  const idempotencyKey = c.req.header('idempotency-key')?.trim()
  if (
    idempotencyKey &&
    (idempotencyKey.length > 128 || !/^[A-Za-z0-9:._-]+$/.test(idempotencyKey))
  ) {
    return errorResponse(
      c,
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be <= 128 chars and use [A-Za-z0-9:._-]',
    )
  }
  const requestHash = hashInvoiceRequest(request, payer)

  if (idempotencyKey) {
    const existingRecord = invoicesByIdempotencyKey.get(idempotencyKey)
    if (existingRecord) {
      if (existingRecord.requestHash !== requestHash) {
        return errorResponse(
          c,
          409,
          'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
          'Idempotency-Key already used with different request payload.',
        )
      }

      const existingOrder = orders.get(existingRecord.invoiceId)
      if (!existingOrder) {
        return errorResponse(c, 500, 'INVOICE_LOOKUP_FAILED', 'Stored invoice could not be loaded')
      }

      return c.json({
        ok: true,
        standard: MERCHANT_STANDARD_VERSION,
        invoice: existingOrder.invoice,
        idempotentReplay: true,
      })
    }
  }

  let invoice: InvoiceV1
  try {
    invoice = await issueInvoice(resolved, payer)
  } catch (error) {
    return errorResponse(
      c,
      400,
      'INVALID_INVOICE_INPUT',
      error instanceof Error ? error.message : 'Could not create invoice',
    )
  }

  if (idempotencyKey) {
    invoicesByIdempotencyKey.set(idempotencyKey, {
      requestHash,
      invoiceId: invoice.invoiceId,
      createdAt: Math.floor(Date.now() / 1000),
    })
  }

  persistMerchantState()

  return c.json({
    ok: true,
    standard: MERCHANT_STANDARD_VERSION,
    invoice,
    idempotentReplay: false,
  })
})

// Backward-compatible alias for older agent clients.
app.post('/api/checkout', async (c) => {
  const rateLimitError = rateLimitOrError(c, invoiceRateLimiter, 'checkout')
  if (rateLimitError) return rateLimitError

  let body: { listingId?: string; payer?: string }
  try {
    body = (await c.req.json()) as { listingId?: string; payer?: string }
  } catch {
    return c.json({ error: 'Request body must be valid JSON' }, 400)
  }

  if (!body.listingId) return c.json({ error: 'Missing listingId' }, 400)

  const payer = normalizeOptionalAddress(body.payer)
  if (payer === null) return c.json({ error: 'Invalid payer address' }, 400)

  const resolveResult = resolveInvoiceInput({ listingId: body.listingId }, payer)
  if (resolveResult.error || !resolveResult.value) {
    return c.json({ error: resolveResult.error?.message ?? 'Invalid request' }, 400)
  }

  let invoice: InvoiceV1
  try {
    invoice = await issueInvoice(resolveResult.value, payer)
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Could not create invoice' },
      400,
    )
  }

  persistMerchantState()

  return c.json({
    invoice,
    amount: invoice.amount,
    token: invoice.token,
    recipient: invoice.recipient,
    memo: invoice.memo,
    orderId: invoice.invoiceId,
    description: invoice.description,
    expiry: invoice.dueAt,
  })
})

app.get('/api/invoices/:invoiceId', (c) => {
  const order = orders.get(c.req.param('invoiceId'))
  if (!order) return errorResponse(c, 404, 'INVOICE_NOT_FOUND', 'Invoice not found')

  return c.json({
    ok: true,
    invoice: order.invoice,
    status: order.status,
    txHash: order.txHash,
    confirmedAt: order.confirmedAt,
  })
})

async function confirmSettlement(
  c: Context,
  body: {
    invoiceId?: string
    orderId?: string
    txHash?: `0x${string}`
  },
) {
  const invoiceId = body.invoiceId ?? body.orderId
  if (!invoiceId || !body.txHash) {
    return errorResponse(
      c,
      400,
      'MISSING_CONFIRMATION_FIELDS',
      'Missing invoiceId/orderId or txHash',
    )
  }

  const order = orders.get(invoiceId)
  if (!order) return errorResponse(c, 404, 'INVOICE_NOT_FOUND', 'Invoice not found')

  if (order.status === 'confirmed') {
    if (order.txHash === body.txHash) {
      return c.json({
        ok: true,
        status: 'confirmed',
        invoiceId,
        txHash: body.txHash,
        idempotentReplay: true,
      })
    }

    return errorResponse(
      c,
      409,
      'INVOICE_ALREADY_CONFIRMED',
      'Invoice is already confirmed with a different transaction hash.',
      { existingTxHash: order.txHash ?? 'unknown' },
    )
  }

  const publicClient = createTempoPublicClient()

  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: body.txHash })

    if (receipt.status !== 'success') {
      return errorResponse(c, 400, 'TRANSACTION_FAILED', 'Transaction failed')
    }

    const match = merchantSdk.matchSettlement(order.invoice, receipt.logs)
    if (!match) {
      return errorResponse(
        c,
        400,
        'SETTLEMENT_MISMATCH',
        'No matching TransferWithMemo event found for this invoice.',
      )
    }

    order.status = 'confirmed'
    order.txHash = body.txHash
    order.confirmedAt = Math.floor(Date.now() / 1000)
    persistMerchantState()

    console.log(`\n  Invoice ${order.invoice.invoiceId} confirmed -- ${order.invoice.description}`)
    console.log(`  Received ${Number(order.invoice.amount) / 1e6} AlphaUSD`)
    console.log(`  Tx: ${EXPLORER_URL}/tx/${body.txHash}`)

    return c.json({
      ok: true,
      status: 'confirmed',
      invoiceId: order.invoice.invoiceId,
      txHash: body.txHash,
      idempotentReplay: false,
    })
  } catch {
    return errorResponse(
      c,
      400,
      'TRANSACTION_NOT_FOUND_OR_INVALID',
      'Transaction not found or invalid for this invoice',
    )
  }
}

app.post('/api/demo/confirm', async (c) => {
  if (!ALLOW_DEMO_CONFIRM) {
    return errorResponse(
      c,
      401,
      'DEMO_CONFIRM_DISABLED',
      'Demo confirmation is disabled. Set ALLOW_DEMO_CONFIRM=true to enable.',
    )
  }

  let body: {
    invoiceId?: string
    txHash?: `0x${string}`
  }

  try {
    body = (await c.req.json()) as {
      invoiceId?: string
      txHash?: `0x${string}`
    }
  } catch {
    return errorResponse(c, 400, 'BAD_JSON', 'Request body must be valid JSON')
  }

  if (!body.invoiceId) {
    return errorResponse(c, 400, 'MISSING_INVOICE_ID', 'invoiceId is required')
  }

  const order = orders.get(body.invoiceId)
  if (!order) return errorResponse(c, 404, 'INVOICE_NOT_FOUND', 'Invoice not found')

  const txHash =
    body.txHash && /^0x[a-fA-F0-9]{64}$/.test(body.txHash)
      ? body.txHash
      : (`0x${'d'.repeat(64)}` as `0x${string}`)

  if (order.status === 'confirmed') {
    return c.json({
      ok: true,
      mode: 'demo',
      status: 'confirmed',
      invoiceId: order.invoice.invoiceId,
      txHash: order.txHash,
      idempotentReplay: true,
    })
  }

  order.status = 'confirmed'
  order.txHash = txHash
  order.confirmedAt = Math.floor(Date.now() / 1000)
  persistMerchantState()

  return c.json({
    ok: true,
    mode: 'demo',
    status: 'confirmed',
    invoiceId: order.invoice.invoiceId,
    txHash,
    idempotentReplay: false,
  })
})

app.post('/api/confirm', async (c) => {
  const rateLimitError = rateLimitOrError(c, settlementRateLimiter, 'confirm-settlement')
  if (rateLimitError) return rateLimitError

  const authError = requireSettlementAuthOrError(c)
  if (authError) return authError

  let body: {
    invoiceId?: string
    orderId?: string
    txHash?: `0x${string}`
  }

  try {
    body = (await c.req.json()) as {
      invoiceId?: string
      orderId?: string
      txHash?: `0x${string}`
    }
  } catch {
    return errorResponse(c, 400, 'BAD_JSON', 'Request body must be valid JSON')
  }

  return confirmSettlement(c, body)
})

app.post('/api/settlements/confirm', async (c) => {
  const rateLimitError = rateLimitOrError(c, settlementRateLimiter, 'settlements-confirm')
  if (rateLimitError) return rateLimitError

  const authError = requireSettlementAuthOrError(c)
  if (authError) return authError

  let body: {
    invoiceId?: string
    orderId?: string
    txHash?: `0x${string}`
  }

  try {
    body = (await c.req.json()) as {
      invoiceId?: string
      orderId?: string
      txHash?: `0x${string}`
    }
  } catch {
    return errorResponse(c, 400, 'BAD_JSON', 'Request body must be valid JSON')
  }

  return confirmSettlement(c, body)
})

app.get('/api/order/:orderId', (c) => {
  const order = orders.get(c.req.param('orderId'))
  if (!order) return c.json({ error: 'Order not found' }, 404)
  return c.json(order)
})

const port = Number(process.env.MERCHANT_PORT ?? 3000)

if (!IS_VERCEL_RUNTIME) {
  console.log(`Merchant listening on http://localhost:${port}`)
  console.log(`Payments go to ${MERCHANT_ADDRESS}`)
  if (MERCHANT_CONFIRM_TOKEN) {
    console.log('Settlement confirmation auth enabled (x-merchant-confirm-token required).')
  } else {
    console.warn('Settlement confirmation auth disabled (set MERCHANT_CONFIRM_TOKEN to enable).')
  }
  serve({ fetch: app.fetch, port })
}

export default handle(app)
