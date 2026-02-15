import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'

type RunningService = {
  name: string
  baseUrl: string
  command: string
  args: string[]
  env: Record<string, string>
  proc: ChildProcessWithoutNullStreams
  logs: string[]
}

const PROJECT_ROOT = path.resolve(path.join(import.meta.dirname, '..'))
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const ownerAddress = '0x8B7Dc5ade18F0B16A6214a395896e4Ee2e20739d'

function randomPrivateKey(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}` as `0x${string}`
}

const merchantPrivateKey = randomPrivateKey()
const merchantAddress = privateKeyToAccount(merchantPrivateKey).address

function createFakeTxHash(fill: string) {
  return `0x${fill.repeat(64)}`
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate port'))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

function spawnService(
  name: string,
  script: 'merchant' | 'guardian',
  baseUrl: string,
  env: Record<string, string>,
): RunningService {
  const logs: string[] = []
  const args = ['run', script]
  const proc = spawn(npmCommand, args, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'pipe',
  })

  const capture = (prefix: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const line = `[${name}:${prefix}] ${String(chunk).trim()}`
    logs.push(line)
    if (logs.length > 200) logs.shift()
  }

  proc.stdout.on('data', capture('stdout'))
  proc.stderr.on('data', capture('stderr'))

  return {
    name,
    baseUrl,
    command: npmCommand,
    args,
    env,
    proc,
    logs,
  }
}

async function waitForHttp(service: RunningService, pathname: string, timeoutMs = 15_000) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (service.proc.exitCode !== null) {
      throw new Error(
        `${service.name} exited early with code ${service.proc.exitCode}.\n${service.logs.join('\n')}`,
      )
    }

    try {
      const response = await fetch(`${service.baseUrl}${pathname}`)
      if (response.ok) return
    } catch {
      // retry
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Timed out waiting for ${service.name} at ${service.baseUrl}${pathname}`)
}

async function stopService(service: RunningService | undefined) {
  if (!service) return

  if (service.proc.exitCode !== null) return

  service.proc.kill('SIGTERM')
  const timed = new Promise((resolve) => setTimeout(resolve, 1500))
  await Promise.race([once(service.proc, 'exit'), timed])

  if (service.proc.exitCode === null) {
    service.proc.kill('SIGKILL')
    await once(service.proc, 'exit')
  }
}

test('merchant + guardian HTTP integration', { timeout: 90_000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-integration-'))
  const merchantStatePath = path.join(tempDir, 'merchant-state.json')
  const guardianStatePath = path.join(tempDir, 'guardian-state.json')

  const merchantPort = await getFreePort()
  const guardianPort = await getFreePort()
  const merchantBaseUrl = `http://127.0.0.1:${merchantPort}`
  const guardianBaseUrl = `http://127.0.0.1:${guardianPort}`

  const confirmToken = 'integration-confirm-token'
  const adminToken = 'integration-admin-token'

  let merchant: RunningService | undefined
  let guardian: RunningService | undefined

  try {
    merchant = spawnService('merchant', 'merchant', merchantBaseUrl, {
      MERCHANT_PORT: String(merchantPort),
      MERCHANT_BASE_URL: merchantBaseUrl,
      MERCHANT_STATE_PATH: merchantStatePath,
      MERCHANT_CONFIRM_TOKEN: confirmToken,
      MERCHANT_PRIVATE_KEY: merchantPrivateKey,
      MERCHANT_ADDRESS: merchantAddress,
    })

    guardian = spawnService('guardian', 'guardian', guardianBaseUrl, {
      GUARDIAN_PORT: String(guardianPort),
      GUARDIAN_STATE_PATH: guardianStatePath,
      DELEGATION_ADMIN_TOKEN: adminToken,
    })

    await waitForHttp(merchant, '/api/listings')
    await waitForHttp(guardian, '/api/health')

    const capabilities = await fetch(`${merchantBaseUrl}/api/capabilities`).then((r) => r.json())
    assert.equal(capabilities.standard, 'tempo.agent-payments.v1')

    const idempotencyKey = 'integration-idempotency-1'
    const createBody = {
      amount: '1230000',
      description: 'Integration invoice',
      payer: ownerAddress,
      lineItems: [{ title: 'Integration item', quantity: 1, totalAmount: '1230000' }],
      metadata: { flow: 'integration' },
    }

    const created = await fetch(`${merchantBaseUrl}/api/invoices`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(createBody),
    }).then((r) => r.json())

    assert.equal(created.ok, true)
    assert.equal(created.idempotentReplay, false)
    const invoiceId = created.invoice.invoiceId as string
    assert.equal(typeof invoiceId, 'string')

    const replay = await fetch(`${merchantBaseUrl}/api/invoices`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(createBody),
    }).then((r) => r.json())

    assert.equal(replay.ok, true)
    assert.equal(replay.idempotentReplay, true)
    assert.equal(replay.invoice.invoiceId, invoiceId)

    const invoiceLookup = await fetch(`${merchantBaseUrl}/api/invoices/${invoiceId}`).then((r) => r.json())
    assert.equal(invoiceLookup.ok, true)
    assert.equal(invoiceLookup.status, 'pending')

    const noTokenConfirm = await fetch(`${merchantBaseUrl}/api/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invoiceId,
        txHash: createFakeTxHash('1'),
      }),
    })
    assert.equal(noTokenConfirm.status, 401)

    const authedConfirm = await fetch(`${merchantBaseUrl}/api/confirm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-merchant-confirm-token': confirmToken,
      },
      body: JSON.stringify({
        invoiceId: 'INV-does-not-exist',
        txHash: createFakeTxHash('2'),
      }),
    })
    assert.equal(authedConfirm.status, 404)

    const unauthorizedPolicyWrite = await fetch(`${guardianBaseUrl}/api/delegations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: ownerAddress,
        maxAmount: '200000000',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    })
    assert.equal(unauthorizedPolicyWrite.status, 401)

    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const policyWrite = await fetch(`${guardianBaseUrl}/api/delegations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': adminToken,
      },
      body: JSON.stringify({
        owner: ownerAddress,
        maxAmount: '200000000',
        allowedRecipients: [merchantAddress, merchantAddress],
        allowedTokens: ['0x20c0000000000000000000000000000000000001'],
        expiresAt,
      }),
    }).then((r) => r.json())

    assert.equal(policyWrite.owner, ownerAddress.toLowerCase())
    assert.equal(policyWrite.allowedRecipients.length, 1)

    const policyLookup = await fetch(`${guardianBaseUrl}/api/delegations/${ownerAddress}`).then((r) =>
      r.json(),
    )
    assert.equal(policyLookup.owner, ownerAddress.toLowerCase())
    assert.equal(policyLookup.maxAmount, '200000000')

    const persistedState = JSON.parse(fs.readFileSync(merchantStatePath, 'utf8')) as {
      orders: Array<{ invoiceId: string }>
    }
    assert.equal(persistedState.orders.some((entry) => entry.invoiceId === invoiceId), true)

    await stopService(merchant)

    merchant = spawnService('merchant-restart', 'merchant', merchantBaseUrl, {
      MERCHANT_PORT: String(merchantPort),
      MERCHANT_BASE_URL: merchantBaseUrl,
      MERCHANT_STATE_PATH: merchantStatePath,
      MERCHANT_CONFIRM_TOKEN: confirmToken,
      MERCHANT_PRIVATE_KEY: merchantPrivateKey,
      MERCHANT_ADDRESS: merchantAddress,
    })

    await waitForHttp(merchant, '/api/listings')

    const afterRestart = await fetch(`${merchantBaseUrl}/api/invoices/${invoiceId}`).then((r) => r.json())
    assert.equal(afterRestart.ok, true)
    assert.equal(afterRestart.invoice.invoiceId, invoiceId)
  } finally {
    await stopService(merchant)
    await stopService(guardian)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
