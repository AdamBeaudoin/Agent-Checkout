import test from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryRateLimiter, getClientIp } from '../shared/rateLimit.js'

test('InMemoryRateLimiter enforces quota then resets after window', () => {
  const limiter = new InMemoryRateLimiter({
    maxRequests: 2,
    windowMs: 1000,
  })

  assert.equal(limiter.check('k', 0).allowed, true)
  assert.equal(limiter.check('k', 10).allowed, true)

  const blocked = limiter.check('k', 20)
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.retryAfterSeconds, 1)

  assert.equal(limiter.check('k', 1001).allowed, true)
})

test('getClientIp prioritizes x-forwarded-for first hop', () => {
  const req = {
    header(name: string) {
      if (name === 'x-forwarded-for') return '203.0.113.9, 10.0.0.1'
      return undefined
    },
  }

  assert.equal(getClientIp(req), '203.0.113.9')
})
