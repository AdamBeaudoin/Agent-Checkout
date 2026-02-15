import { Hono, type Context } from 'hono'
import { serve } from '@hono/node-server'
import { isAddress } from 'viem'
import { InMemoryRateLimiter, getClientIp } from '../shared/rateLimit.js'
import { loadJsonState, saveJsonState } from '../shared/stateStore.js'
import 'dotenv/config'

type DelegationPolicy = {
  owner: `0x${string}`
  maxAmount: string
  allowedRecipients: `0x${string}`[]
  allowedTokens: `0x${string}`[]
  expiresAt: number
  updatedAt: number
}

const app = new Hono()
const adminToken = process.env.DELEGATION_ADMIN_TOKEN
const GUARDIAN_STATE_PATH = process.env.GUARDIAN_STATE_PATH ?? './data/guardian-state.json'
const MAX_POLICY_LIST_ENTRIES = 50
const MAX_POLICY_DURATION_SECONDS = 365 * 24 * 60 * 60

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

function parsePositiveBigIntEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name]
  if (!raw || !/^[0-9]+$/.test(raw)) return fallback
  const parsed = BigInt(raw)
  if (parsed <= 0n) return fallback
  return parsed
}

const MAX_POLICY_AMOUNT = parsePositiveBigIntEnv('GUARDIAN_MAX_POLICY_AMOUNT', 1_000_000_000_000n)
const writeRateLimiter = new InMemoryRateLimiter({
  maxRequests: parsePositiveIntegerEnv('GUARDIAN_WRITE_RATE_LIMIT_MAX', 30),
  windowMs: parsePositiveIntegerEnv('GUARDIAN_WRITE_RATE_LIMIT_WINDOW_MS', 60_000),
})

function setCorsHeaders(c: Context) {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token')
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

type PersistedGuardianState = {
  policies: Array<{
    owner: string
    policy: DelegationPolicy
  }>
}

const initialState = loadJsonState<PersistedGuardianState>(GUARDIAN_STATE_PATH, {
  policies: [],
})

const policies = new Map<string, DelegationPolicy>(
  initialState.policies.map((entry) => [entry.owner, entry.policy]),
)

function persistGuardianState() {
  saveJsonState(GUARDIAN_STATE_PATH, {
    policies: Array.from(policies.entries()).map(([owner, policy]) => ({
      owner,
      policy,
    })),
  } satisfies PersistedGuardianState)
}

function normalizeAddress(value: string): `0x${string}` | null {
  if (!isAddress(value)) return null
  return value.toLowerCase() as `0x${string}`
}

function rateLimitOrError(req: { header: (name: string) => string | undefined }) {
  const key = `write-policy:${getClientIp(req)}`
  const result = writeRateLimiter.check(key)
  if (result.allowed) return undefined
  return {
    error: 'Too many policy write requests',
    retryAfterSeconds: result.retryAfterSeconds,
  }
}

function requireAdmin(c: { req: { header: (name: string) => string | undefined } }) {
  if (!adminToken) {
    throw new Error('Missing DELEGATION_ADMIN_TOKEN')
  }

  const provided = c.req.header('x-admin-token')
  if (provided !== adminToken) {
    throw new Error('Unauthorized')
  }
}

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    policyCount: policies.size,
  })
)

app.get('/', (c) =>
  c.json({
    ok: true,
    service: 'tempo-guardian',
    health: '/api/health',
    readDelegation: '/api/delegations/:owner',
    writeDelegation: '/api/delegations',
  })
)

app.get('/api/delegations/:owner', (c) => {
  const owner = normalizeAddress(c.req.param('owner'))
  if (!owner) return c.json({ error: 'Invalid owner address' }, 400)
  const policy = policies.get(owner)
  if (!policy) return c.json({ error: 'Policy not found' }, 404)
  return c.json(policy)
})

app.post('/api/delegations', async (c) => {
  const rateLimitError = rateLimitOrError(c.req)
  if (rateLimitError) return c.json(rateLimitError, 429)

  try {
    requireAdmin(c)
  } catch (error) {
    if (error instanceof Error && error.message === 'Missing DELEGATION_ADMIN_TOKEN') {
      return c.json({ error: 'Guardian misconfigured: missing DELEGATION_ADMIN_TOKEN' }, 500)
    }
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be valid JSON' }, 400)
  }

  const owner = normalizeAddress(String(body.owner))
  const maxAmount = String(body.maxAmount)

  if (!/^[0-9]+$/.test(maxAmount) || BigInt(maxAmount) <= 0n) {
    return c.json({ error: 'maxAmount must be a positive numeric string' }, 400)
  }

  if (BigInt(maxAmount) > MAX_POLICY_AMOUNT) {
    return c.json({ error: `maxAmount exceeds guardian limit (${MAX_POLICY_AMOUNT.toString()})` }, 400)
  }

  const parseAddressArray = (value: unknown, field: string) => {
    if (value === undefined) return [] as `0x${string}`[]
    if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
    if (value.length > MAX_POLICY_LIST_ENTRIES) {
      throw new Error(`${field} allows at most ${MAX_POLICY_LIST_ENTRIES} entries`)
    }

    const deduped = new Set<string>()

    for (const entry of value) {
      const normalized = normalizeAddress(String(entry))
      if (!normalized) throw new Error(`${field} contains invalid address`)
      deduped.add(normalized)
    }

    return Array.from(deduped) as `0x${string}`[]
  }

  let allowedRecipients: `0x${string}`[]
  let allowedTokens: `0x${string}`[]
  try {
    allowedRecipients = parseAddressArray(body.allowedRecipients, 'allowedRecipients')
    allowedTokens = parseAddressArray(body.allowedTokens, 'allowedTokens')
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid address list' }, 400)
  }

  const expiresAt = Number(body.expiresAt)
  const now = Math.floor(Date.now() / 1000)

  if (!owner || !Number.isInteger(expiresAt) || expiresAt <= now) {
    return c.json({ error: 'Missing required fields' }, 400)
  }

  if (expiresAt > now + MAX_POLICY_DURATION_SECONDS) {
    return c.json(
      { error: `expiresAt must be within ${MAX_POLICY_DURATION_SECONDS} seconds from now` },
      400,
    )
  }

  const policy: DelegationPolicy = {
    owner,
    maxAmount,
    allowedRecipients,
    allowedTokens,
    expiresAt,
    updatedAt: Math.floor(Date.now() / 1000),
  }

  policies.set(owner, policy)
  persistGuardianState()
  return c.json(policy)
})

const port = Number(process.env.GUARDIAN_PORT ?? 3001)
console.log(`Guardian listening on http://localhost:${port}`)
serve({ fetch: app.fetch, port })
